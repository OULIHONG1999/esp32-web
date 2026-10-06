/**
 * push 子命令的**纯逻辑**（零 IO、零网络 —— 所以能单测）
 *
 * 契约：docs/PUSH-TO-DEVICE.md（§2 操作面 / §3 闸门与退出码）。有 IO 的编排在 push.js。
 *
 * 为什么把闸门与渲染放在这里：它们是"稳定推送 + 看得见过程"的全部规则，
 * 也是最容易因手改而漂移的部分——放在纯函数里就能被 tests/push-cli.test.js 钉住。
 */

/** 退出码（PUSH-TO-DEVICE §2.3；脚本与 AI 靠它分流，不许随意改语义） */
export const EXIT = {
  OK: 0,
  DEVICE_FAILED: 1,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  TIMEOUT: 5,
  NETWORK: 6,
  CHIP_MISMATCH: 7,
  SKIPPED: 8,
  OFFLINE: 9,
  CONFLICT: 10,
  CANCELLED_LATE: 11,
  NOTHING_TO_CANCEL: 12,
  INTERRUPTED: 130,
}

export const DEFAULT_WAIT_TIMEOUT_S = 300
export const DEFAULT_POLL_S = 2

/** 参数/用法错 → 统一由 push.js 映射成 exit 2 */
export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
    this.exitCode = EXIT.USAGE
  }
}

/** MAC / deviceId → 12 位小写 hex；不合法返回 null（绝不猜、不"尽量解析"） */
export function normalizeMac(input) {
  if (typeof input !== 'string') return null
  const hex = input.trim().toLowerCase().replace(/[\s:.-]/g, '')
  return /^[0-9a-f]{12}$/.test(hex) ? hex : null
}

export function formatMac(id) {
  const mac = normalizeMac(id)
  return mac ? mac.match(/.{2}/g).join(':') : String(id ?? '')
}

function numArg(v, flag) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} 需要一个正数，得到：${v}`)
  return n
}

/**
 * 解析 `push` 之后的参数。互斥关系在这里一次判完——把错误留在本地（exit 2），
 * 不要等发了请求才被服务器拒绝。
 */
export function parsePushArgs(argv) {
  const out = {
    to: null,
    build: null, // { dir: string|null }（null = 用 config 的 buildDir）
    release: null,
    latest: false,
    project: null,
    wait: true,
    waitTimeoutS: DEFAULT_WAIT_TIMEOUT_S,
    pollS: DEFAULT_POLL_S,
    force: false,
    forceChip: false,
    allowUnknown: false,
    skipIfSame: true,
    status: false,
    cancel: false,
    reason: null,
    promote: false,
    list: false,
    json: false,
    dryRun: false,
    config: 'publish.config.json',
    server: null,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = () => {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} 后面缺少取值`)
      i++
      return v
    }
    switch (a) {
      case '--to': out.to = take(); break
      // --build 的值可省：省了就用 config 的 buildDir（`--build` 是最常用的写法）
      case '--build':
        out.build = { dir: argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : null }
        break
      case '--release': out.release = take(); break
      case '--latest': out.latest = true; break
      case '--project': out.project = take(); break
      case '--wait': out.wait = true; break
      case '--no-wait': out.wait = false; break
      case '--wait-timeout': out.waitTimeoutS = numArg(take(), a); break
      case '--poll': out.pollS = numArg(take(), a); break
      case '--force': out.force = true; break
      case '--force-chip': out.forceChip = true; break
      case '--allow-unknown': out.allowUnknown = true; break
      case '--skip-if-same': out.skipIfSame = true; break
      case '--no-skip-if-same': out.skipIfSame = false; break
      case '--status': out.status = true; break
      case '--cancel': out.cancel = true; break
      case '--reason': out.reason = take(); break
      case '--promote': out.promote = true; break
      case '--list': out.list = true; break
      case '--json': out.json = true; break
      case '--dry-run': out.dryRun = true; break
      case '--config': out.config = take(); break
      case '--server': out.server = take(); break
      case '--help': case '-h': out.help = true; return out // 短路：--help 之后不再校验任何参数
      default: throw new UsageError(`未知参数：${a}`)
    }
  }

  if (out.help) return out
  if (out.reason && !out.cancel) throw new UsageError('--reason 只与 --cancel 一起用')
  if (out.promote && !out.build) throw new UsageError('--promote 只与 --build 一起用（它晋升的是本次构建的产物）')

  const actions = [out.list && '--list', out.status && '--status', out.cancel && '--cancel'].filter(Boolean)
  if (actions.length > 1) throw new UsageError(`只能选一个动作：${actions.join(' / ')}`)
  const sources = [out.build && '--build', out.release && '--release', out.latest && '--latest'].filter(Boolean)

  if (out.list) {
    if (sources.length) throw new UsageError('--list 只列设备，不与 --build/--release/--latest 一起用')
    if (out.force || out.forceChip || out.promote) {
      throw new UsageError('--list 不接受 --force/--force-chip/--promote')
    }
    return out
  }

  if (!out.to) throw new UsageError('缺少 --to <mac|deviceId>')
  const mac = normalizeMac(out.to)
  if (!mac) {
    throw new UsageError(`--to 不是合法 MAC/deviceId：${out.to}（例 34:85:a1:b2:c3:d4 或 3485a1b2c3d4）`)
  }
  out.to = mac

  if (out.status) {
    if (sources.length) throw new UsageError('--status 是只读复查：不与 --build/--release/--latest 一起用')
    if (out.force || out.forceChip || out.promote) {
      throw new UsageError('--status 不接受 --force/--force-chip/--promote')
    }
    if (out.dryRun) throw new UsageError('--status 本身就是零副作用的，不需要 --dry-run')
    return out
  }

  if (out.cancel) {
    if (sources.length) {
      throw new UsageError('--cancel 只撤销设备上已有的未决命令，不与 --build/--release/--latest 一起用')
    }
    if (out.force || out.forceChip || out.promote) {
      throw new UsageError('--cancel 不接受 --force/--force-chip/--promote')
    }
    if (out.dryRun) throw new UsageError('--cancel 不用 --dry-run（要看会撤哪条用 --status）')
    return out
  }

  if (sources.length === 0) {
    throw new UsageError('缺少固件来源：--build <dir> | --release <id> | --latest（三选一）')
  }
  if (sources.length > 1) throw new UsageError(`固件来源只能给一个：${sources.join(' / ')}`)
  return out
}

export function pushUsage() {
  return [
    '用法（推送固件到指定设备）:',
    '  node tools/publish/index.js push --to <mac> --build [dir]        # 发布 + 推送（主力用法）',
    '  node tools/publish/index.js push --to <mac> --release <id>       # 推已有版本，不重新发布',
    '  node tools/publish/index.js push --to <mac> --latest             # 推该芯片的最新版本',
    '  node tools/publish/index.js push --list                          # 列设备（id/芯片/固件/在线/最近命令）',
    '  node tools/publish/index.js push --status --to <mac>             # 只读复查：状态 + 完整过程链',
    '  node tools/publish/index.js push --cancel --to <mac> [--reason "<说明>"]   # 撤销未决命令',
    '',
    '常用开关:',
    '  --project <id>        --latest 解析有歧义时限定项目',
    '  --no-wait             只下发即返回（不等待回执）',
    '  --wait-timeout <s>    等待上限，默认 300；超时 exit 5',
    '  --poll <s>            轮询间隔，默认 2',
    '  --force               顶替设备上"其他版本"的未决命令',
    '  --force-chip          跨芯片族推（默认拒绝）',
    '  --allow-unknown       目标不在设备清单里也交给服务器判（默认拒绝，exit 4）',
    '  --no-skip-if-same     设备已是目标版本时也照推（默认跳过，exit 8）',
    '  --promote             --build 产出的快照顺手晋升为正式版（默认不晋升）',
    '  --dry-run             只打印将会发生什么，不发任何请求',
    '  --json                机器可读输出（契约见 /docs/PUSH-TO-DEVICE.md §2.4）',
    '  --config / --server   同 once：复用 publish.config.json 与其中的 token',
    '',
    '退出码: 0 成功 · 1 设备回执失败 · 2 用法错 · 3 鉴权失败 · 4 目标不存在 ·',
    '        5 超时未回执 · 6 网络/服务器错误 · 7 芯片族不匹配 · 8 已同版本跳过 ·',
    '        9 命令被取消（未下发/未完成，常态是设备离线） · 10 他版本未决命令（--force 顶替）',
    '        撤销专用: 11 已取走时撤销（拦不住设备，但停了重复投递） · 12 没有可撤的未决命令',
    '',
    '规则: 设备不在线时**不下发、不排队、直接取消**（服务器判，412）；设备上线后重跑本条命令。',
    '文档: /docs/PUSH-TO-DEVICE.md',
  ].join('\n')
}

/** 在 GET /api/devices 的结果里按 deviceId 找设备（找不到 = 从未上报过） */
export function pickDevice(devices, deviceId) {
  return (devices ?? []).find((d) => d.deviceId === deviceId) ?? null
}

/** 芯片族归一（大小写/空白不敏感；null 原样返回，让闸门如实说"未声明/未上报"） */
export function normChip(s) {
  return typeof s === 'string' && s.trim() ? s.trim().toUpperCase() : null
}

/**
 * 闸门 2：芯片族一致（变砖级故障，不能只靠设备端自己挡）。
 * 任一侧拿不到型号时按**不通过**处理——"核不了"不等于"没问题"。
 */
export function chipGate(device, chipFamily) {
  const want = normChip(chipFamily)
  const got = normChip(device?.chip)
  if (!want) return { ok: false, want: null, got, reason: 'release 未声明芯片族（chipFamily 为空）' }
  if (!got) {
    return { ok: false, want, got: null, reason: '设备未上报芯片型号，无法核对（要强推加 --force-chip）' }
  }
  if (want !== got) return { ok: false, want, got, reason: `芯片族不匹配：固件 ${want} ≠ 设备 ${got}` }
  return { ok: true, want, got }
}

/** 闸门 3：设备已在该版本（省一次下载与擦写；设备端幂等是第二道保险） */
export function isSameVersion(device, releaseId) {
  const cur = device?.firmwareVersion
  return typeof cur === 'string' && cur.length > 0 && cur === releaseId
}

/** 在 registry 里按 releaseId 跨项目/变体定位（与 server/devices.js resolveRelease 同口径） */
export function findRelease(registry, releaseId) {
  for (const [projectId, proj] of Object.entries(registry?.projects ?? {})) {
    for (const [variant, v] of Object.entries(proj.variants ?? {})) {
      const release = (v.releases ?? []).find((r) => r.id === releaseId)
      if (release) return { projectId, variant, release }
    }
  }
  return null
}

/** `--latest`：该芯片族下所有 latest 命中（>1 时要 --project 限定，避免推错项目） */
export function latestHits(registry, { projectId = null, variant }) {
  const want = normChip(variant)
  const hits = []
  for (const [pid, proj] of Object.entries(registry?.projects ?? {})) {
    if (projectId && pid !== projectId) continue
    for (const [vid, v] of Object.entries(proj.variants ?? {})) {
      if (normChip(vid) !== want || !v.latest) continue
      hits.push({ projectId: pid, variant: vid, releaseId: v.latest })
    }
  }
  return hits
}

// ── 过程渲染（与页面「OTA 过程」面板同一份数据：command.trail / progress / 时间点） ──

export const PHASE_LABEL = {
  downloading: '下载固件',
  verifying: '校验 sha256',
  writing: '写入 OTA 槽',
  rebooting: '重启',
  applying: '启动确认',
}

export function phaseLabel(p) {
  return PHASE_LABEL[p] ?? String(p ?? '?')
}

export function cancelReasonText(reason) {
  if (reason === 'device_offline') return '设备不在线'
  if (reason === 'cancelled_by_operator') return '运维撤销'
  return reason || '未给出原因'
}

export function fmtDur(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
  // 10s 以内保留一位小数：OTA 的关键耗时多在 1~3s，整数会把"+1.3s"抹成"+1s"
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ''}`
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`
}

/** 距命令下发时刻的相对耗时（`+0.7s`）；拿不到就返回 '—' */
export function relFrom(createdAt, at) {
  if (!createdAt || !at) return '—'
  const ms = Date.parse(at) - Date.parse(createdAt)
  return Number.isFinite(ms) ? `+${fmtDur(Math.max(0, ms))}` : '—'
}

export function fmtAgo(iso, nowMs = Date.now()) {
  if (!iso) return '—'
  const ms = nowMs - Date.parse(iso)
  return Number.isFinite(ms) ? `${fmtDur(Math.max(0, ms))} 前` : '—'
}

function staleSince(cmd, nowMs) {
  return nowMs - Date.parse(cmd?.createdAt ?? '')
}

/**
 * 完整过程链（行）：服务器时间点 + 设备过程点 + 取消/迟到回执，按时间顺序。
 * 「失败与超时时必须打印过程证据」的载体——所以它是纯数据，不靠调用方记忆。
 */
export function processRows(cmd) {
  if (!cmd) return []
  const rows = [{ at: cmd.createdAt, label: '已下发', extra: `release ${cmd.releaseId ?? '?'}` }]
  if (cmd.deliveredAt) {
    rows.push({
      at: cmd.deliveredAt,
      label: '设备取走',
      extra: cmd.deliveryCount > 1 ? `重复投递 ${cmd.deliveryCount} 次（最近 ${cmd.lastDeliveredAt ?? '?'}）` : '',
    })
  }
  for (const t of cmd.trail ?? []) {
    rows.push({
      at: t.at,
      label: `过程：${phaseLabel(t.phase)}`,
      extra: t.percent !== undefined && t.percent !== null ? `${t.percent}%` : '',
    })
  }
  const lastTrailAt = cmd.trail?.length ? cmd.trail[cmd.trail.length - 1].at : null
  if (cmd.progress?.updatedAt && cmd.progress.updatedAt !== lastTrailAt) {
    rows.push({
      at: cmd.progress.updatedAt,
      label: `当前：${phaseLabel(cmd.progress.phase)}`,
      extra: [
        cmd.progress.percent !== undefined && cmd.progress.percent !== null ? `${cmd.progress.percent}%` : '',
        cmd.progress.message ?? '',
      ]
        .filter(Boolean)
        .join(' '),
    })
  }
  if (cmd.state === 'cancelled' && cmd.cancelledAt) {
    rows.push({
      at: cmd.cancelledAt,
      label: `取消：${cancelReasonText(cmd.cancelReason)}`,
      extra: cmd.wasDelivered ? '撤销时设备已取走（重复投递已停）' : '未下发',
    })
  }
  if (cmd.finishedAt && cmd.state !== 'cancelled') {
    rows.push({
      at: cmd.finishedAt,
      label: `回执：${cmd.state}`,
      extra: cmd.detail ?? '',
    })
  }
  if (cmd.lateResult?.at) {
    rows.push({
      at: cmd.lateResult.at,
      label: `迟到回执：${cmd.lateResult.state}（撤销来晚了）`,
      extra: cmd.lateResult.detail ?? '',
    })
  }
  return rows
}

/** 一行的紧凑过程链（成功路径用；`取走 +0.1s · 下载 100% +0.7s · …`） */
export function chainLine(cmd) {
  if (!cmd) return ''
  const parts = []
  if (cmd.deliveredAt) parts.push(`取走 ${relFrom(cmd.createdAt, cmd.deliveredAt)}`)
  for (const t of cmd.trail ?? []) {
    parts.push(
      `${phaseLabel(t.phase)}${t.percent !== undefined && t.percent !== null ? ` ${t.percent}%` : ''} ${relFrom(cmd.createdAt, t.at)}`,
    )
  }
  const lastTrailAt = cmd.trail?.length ? cmd.trail[cmd.trail.length - 1].at : null
  if (cmd.progress?.updatedAt && cmd.progress.updatedAt !== lastTrailAt) {
    parts.push(
      `当前 ${phaseLabel(cmd.progress.phase)}` +
        `${cmd.progress.percent !== undefined && cmd.progress.percent !== null ? ` ${cmd.progress.percent}%` : ''} ` +
        relFrom(cmd.createdAt, cmd.progress.updatedAt),
    )
  }
  return parts.join(' · ')
}

/**
 * 停滞判断（与页面同源阈值）：卡住时要说"卡了多久、可能为什么"，
 * 而不是让人对着一个不动的时间戳猜。
 */
export function stuckNote(cmd, nowMs = Date.now()) {
  if (!cmd) return null
  const waited = staleSince(cmd, nowMs)
  if (cmd.state === 'pending') {
    if (waited > 30_000) {
      return `已等待 ${fmtDur(waited)} 仍未被取走——设备离线、或没在跑上报循环。`
    }
    return null
  }
  if (cmd.state === 'delivered') {
    if (cmd.progress?.updatedAt) {
      const stale = nowMs - Date.parse(cmd.progress.updatedAt)
      if (stale > 60_000) return `过程已 ${fmtDur(stale)} 没有更新——可能卡住（写入大固件会慢，超过几分钟多半是断了）。`
      return null
    }
    const silent = nowMs - Date.parse(cmd.deliveredAt ?? cmd.createdAt)
    if (silent > 120_000) {
      return `设备取走后 ${fmtDur(silent)} 没有任何过程上报——设备端可能没实现过程上报（那就在写入中，看不到细节）、或已断电。`
    }
  }
  return null
}

/**
 * 失败/超时时先说清"停在哪一步"——比"超时"两个字有用得多。
 * （停滞**时长**判断见 stuckNote；这里只回答"卡在哪个环节"。）
 */
export function stopPoint(cmd) {
  if (!cmd) return null
  if (cmd.state === 'pending') return '命令停在 pending：设备还没取走（设备每次上报才会取命令；离线或没在跑上报循环都会这样）'
  if (cmd.state === 'delivered') {
    return `命令停在 delivered：设备已在 ${fmtAgo(cmd.deliveredAt)}取走，但服务器没收到回执`
  }
  return null
}

/** 有没有"设备端过程点"？没有就要明说，绝不假装有进度 */export function hasDeviceProgress(cmd) {
  return Boolean((cmd?.trail?.length ?? 0) > 0 || cmd?.progress)
}

export function sourceNote(cmd) {
  return hasDeviceProgress(cmd) ? null : '设备端未上报过程点（旧固件/未实现）——以上仅为服务器可见的时间点。'
}

/** 结论行（成功/失败/取消/顶替各一句人话） */
export function verdictLine(cmd, nowMs = Date.now()) {
  if (!cmd) return '没有命令记录。'
  const total = fmtDur(nowMs - Date.parse(cmd.createdAt))
  switch (cmd.state) {
    case 'success':
      return `✓ success 总耗时 ${fmtDur(Date.parse(cmd.finishedAt) - Date.parse(cmd.createdAt))}` +
        (cmd.detail ? ` · ${cmd.detail}` : '')
    case 'failed':
      return `✗ failed 耗时 ${fmtDur(Date.parse(cmd.finishedAt) - Date.parse(cmd.createdAt))}` +
        ` · ${cmd.detail || '（设备没给 detail）'}`
    case 'cancelled': {
      let s = `✗ 已取消（${cancelReasonText(cmd.cancelReason)}）`
      s += cmd.cancelReason === 'device_offline'
        ? '：未下发、未排队'
        : cmd.wasDelivered
          ? '：撤销时设备已取走——拦不住正在写入的设备，但已停掉重复投递'
          : '：设备还没取走，已经拦住'
      if (cmd.lateResult) {
        s += ` · 迟到回执 ${cmd.lateResult.state}（撤销来晚了，设备本地照旧写完了）`
        if (cmd.lateResult.detail) s += ` · ${cmd.lateResult.detail}`
      }
      return s
    }
    case 'superseded':
      return `✗ 被新命令顶替（superseded）：设备上已有更新的命令，本次没有执行。`
    default:
      return `… ${cmd.state} 仍未回执（已等待 ${total}）`
  }
}

/** 命令终态 → 退出码（等待结束后用；下发/网络错误在 push.js 里单独映射） */
export function exitForCommand(cmd) {
  if (!cmd) return EXIT.NOT_FOUND
  switch (cmd.state) {
    case 'success': return EXIT.OK
    case 'failed': return EXIT.DEVICE_FAILED
    case 'cancelled': return EXIT.OFFLINE
    case 'superseded': return EXIT.CONFLICT
    default: return EXIT.TIMEOUT
  }
}

/** 设备清单一行（--list / 目标确认都用它，保证两处口径一致） */
export function deviceLine(d, nowMs = Date.now()) {
  const last = d.lastCommand
  return [
    formatMac(d.deviceId),
    d.chip ?? '?',
    d.firmwareVersion ?? '?',
    d.online ? 'online' : `offline(${fmtAgo(d.lastSeen, nowMs)})`,
    last ? `${last.state} ${last.id}` : '无命令',
  ].join(' · ')
}
