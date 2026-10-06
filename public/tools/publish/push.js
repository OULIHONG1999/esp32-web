/**
 * push 子命令的**编排层**（唯一有 IO 的部分：文件系统 + HTTP）
 *
 * 纯规则（闸门判定、过程渲染、退出码）在 pushlib.js；这里只负责：
 *   解析参数 → 过闸门（先于任何副作用）→ （可选）发布 → 下发 → 轮询 → 打印过程与结论
 *
 * 契约：docs/PUSH-TO-DEVICE.md（§2 操作面 / §3 闸门与退出码 / §3.1 离线即取消 / §3.4 撤销）
 */
import path from 'node:path'
import { buildParts, parseConfig, releaseId as makeReleaseId } from './lib.js'
import { runOnce } from './once.js'
import {
  EXIT,
  UsageError,
  cancelReasonText,
  chainLine,
  chipGate,
  deviceLine,
  exitForCommand,
  findRelease,
  fmtAgo,
  fmtDur,
  formatMac,
  isSameVersion,
  latestHits,
  parsePushArgs,
  pickDevice,
  processRows,
  pushUsage,
  sourceNote,
  stopPoint,
  stuckNote,
  verdictLine,
} from './pushlib.js'

const TAG = '[push]    '
const TERMINAL = ['success', 'failed', 'superseded', 'cancelled']

class PushError extends Error {
  /** @param {boolean} [silent] 该路径已经自己打印过过程证据，不要再补一行 ✗ */
  constructor(message, exitCode, hint = null, silent = false) {
    super(message)
    this.name = 'PushError'
    this.exitCode = exitCode
    this.hint = hint
    this.silent = silent
  }
}

/** 退出码 → 机器可读错误码（--json 的 error.code；见 §2.4） */
const ERROR_CODE = {
  [EXIT.USAGE]: 'usage_error',
  [EXIT.AUTH]: 'auth_failed',
  [EXIT.NOT_FOUND]: 'target_unknown',
  [EXIT.TIMEOUT]: 'timeout',
  [EXIT.NETWORK]: 'network_error',
  [EXIT.CHIP_MISMATCH]: 'chip_mismatch',
  [EXIT.SKIPPED]: 'skipped',
  [EXIT.OFFLINE]: 'device_offline',
  [EXIT.CONFLICT]: 'unresolved_command_conflict',
  [EXIT.CANCELLED_LATE]: 'cancelled_late',
  [EXIT.NOTHING_TO_CANCEL]: 'nothing_to_cancel',
  [EXIT.DEVICE_FAILED]: 'device_failed',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** HTTP 助手：状态码与 JSON 一起带回，由调用方按码分流（业务上的非 2xx 不走异常） */
async function req(url, { method = 'GET', token = null, body = null } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body) headers['Content-Type'] = 'application/json'
  let res
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  } catch (err) {
    const cause = err?.cause
    const why = cause && typeof cause === 'object' ? (cause.code ?? cause.message) : err.message
    throw new PushError(`连不上服务器 ${url}（${why}）`, EXIT.NETWORK)
  }
  const text = await res.text().catch(() => '')
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON 响应（网关页等）：留给调用方按状态码报 */
  }
  return { status: res.status, json, ok: res.ok }
}

function assertReadOk(r, what) {
  if (r.status === 401 || r.status === 403) throw new PushError(`${what} 鉴权失败（${r.status}）`, EXIT.AUTH)
  if (r.status >= 500) throw new PushError(`${what} 服务器错误（${r.status}）`, EXIT.NETWORK)
  if (r.status >= 400) throw new PushError(`${what} 被拒（${r.status}）${r.json?.error ?? ''}`, EXIT.USAGE)
}

// ══ 入口 ═══════════════════════════════════════════════════
export async function runPush(rawArgs) {
  let args = null
  let code = EXIT.OK
  // --json 要在解析前就认出来：参数解析失败时也要"stdout 只有 JSON"（否则报错行会混进 stdout）
  let jsonWanted = rawArgs.includes('--json')
  const started = Date.now()
  const result = {
    ok: false,
    skipped: false,
    published: null,
    device: null,
    command: null,
    elapsedMs: 0,
    exitCode: EXIT.OK,
    error: null,
  }
  /** 人话输出：--json 时走 stderr，保住 stdout 只有那一个 JSON 对象 */
  const emit = (line = '') => {
    if (jsonWanted) console.error(line)
    else console.log(line)
  }

  try {
    args = parsePushArgs(rawArgs)
    jsonWanted = args.json
    if (args.help) {
      console.log(pushUsage())
      return EXIT.OK
    }

    const { cfg, dir } = loadConfig(args)
    const server = (args.server ?? cfg.server).replace(/\/+$/, '')
    const ctx = { args, cfg, dir, server, emit, result, to: args.to }

    if (!args.list && !args.status && !cfg.token) {
      throw new PushError(
        '缺少发布 token：config 的 token 或环境变量 FIRMWARE_PUBLISH_TOKEN',
        EXIT.USAGE,
        '建议用可撤销的工作 token（主站 🔑 生成 wk_…）',
      )
    }

    // --dry-run 承诺"不发任何请求"：连设备清单都不拉（闸门因此未校验，doDryRun 会如实说明）
    const needDevices = !args.dryRun
    const devices = needDevices ? await getDevices(server) : []
    if (!needDevices) {
      code = await doDryRun(ctx)
      return code
    }

    if (args.list) {
      code = doList(ctx, devices)
      result.devices = devices
      return code
    }

    const device = pickDevice(devices, args.to)
    result.device = device

    if (args.status) {
      code = doStatus(ctx, device)
      return code
    }
    if (args.cancel) {
      code = await doCancel(ctx, device)
      return code
    }
    code = await doPush(ctx, device)
    return code
  } catch (err) {
    code = err instanceof UsageError ? EXIT.USAGE : (err.exitCode ?? EXIT.NETWORK)
    // silent 只压掉"✗ 那句话"（该路径已经自己打过过程证据），**hint 一定要打**——
    // 例如"已有未决命令"必须顺带告诉人 --force 这条路
    if (!(err instanceof PushError && err.silent)) emit(`${TAG}✗ ${err.message}`)
    if (err.hint) emit(`${TAG}  ${err.hint}`)
    if (err instanceof UsageError) emit(`${TAG}  用法见：node tools/publish/index.js push --help`)
    result.error = { code: ERROR_CODE[code] ?? 'error', message: err.message, hint: err.hint ?? null }
    return code
  } finally {
    result.exitCode = code
    result.elapsedMs = Date.now() - started
    if (jsonWanted) console.log(JSON.stringify(result, null, 2))
  }
}

function loadConfig(args) {
  try {
    return parseConfig(args.config)
  } catch (err) {
    throw new PushError(
      `读配置失败（${args.config}）：${err.message}`,
      EXIT.USAGE,
      '--config 指向 publish.config.json；token 可用 ${FIRMWARE_PUBLISH_TOKEN} 引用环境变量',
    )
  }
}

async function getDevices(server) {
  const r = await req(`${server}/api/devices`)
  assertReadOk(r, 'GET /api/devices')
  return Array.isArray(r.json?.devices) ? r.json.devices : []
}

async function getRegistry(server) {
  const r = await req(`${server}/api/registry`)
  assertReadOk(r, 'GET /api/registry')
  return r.json ?? {}
}

// ══ 打印 ═══════════════════════════════════════════════════
function printDevice(emit, device, nowMs = Date.now()) {
  emit(
    `${TAG}→ ${formatMac(device.deviceId)} · ${device.chip ?? '?'} · 固件 ${device.firmwareVersion ?? '?'} · ` +
      `${device.online ? 'online' : `不在线（最后心跳 ${fmtAgo(device.lastSeen, nowMs)}）`}`,
  )
}

/** 相对下发的耗时（`+0.7s`） */
function rel(cmd, at) {
  const ms = Date.parse(at) - Date.parse(cmd.createdAt)
  return Number.isFinite(ms) ? `+${fmtDur(Math.max(0, ms))}` : '—'
}

function printCommand(emit, cmd) {
  emit(`${TAG}命令 ${cmd.id} · ${cmd.state} · release ${cmd.releaseId ?? '?'}`)
  for (const row of processRows(cmd)) {
    emit(`${TAG}  ${row.label} ${rel(cmd, row.at)}${row.extra ? ` · ${row.extra}` : ''}`)
  }
}

/** 只打印"还没打过的"过程行（过程行是增量的，不重复刷屏） */
function emitNewRows(emit, cmd, seen) {
  for (const row of processRows(cmd)) {
    const key = `${row.at}|${row.label}`
    if (seen.has(key)) continue
    seen.add(key)
    emit(`${TAG}  ${row.label} ${rel(cmd, row.at)}${row.extra ? ` · ${row.extra}` : ''}`)
  }
}

// ══ --list ═════════════════════════════════════════════════
function doList({ args, emit, result }, devices) {
  if (args.to) {
    const only = pickDevice(devices, args.to)
    if (!only) {
      emit(`${TAG}✗ 设备清单里没有 ${formatMac(args.to)}（从未上报过）`)
      result.exitCode = EXIT.NOT_FOUND
      result.error = { code: 'target_unknown', message: '设备从未上报过', hint: '确认 MAC；设备在跑上报循环吗' }
      return EXIT.NOT_FOUND
    }
    emit(`${TAG}设备 ${formatMac(args.to)}`)
    emit(`${TAG}  ${deviceLine(only)}`)
    return EXIT.OK
  }
  emit(`${TAG}设备清单（${devices.length} 台）`)
  if (!devices.length) emit(`${TAG}  （空）设备端第一次 report 后就会出现在这里`)
  for (const d of devices) emit(`${TAG}  ${deviceLine(d)}`)
  emit(`${TAG}  字段：id · 芯片 · 固件 · 在线 · 最近命令；在线口径 = now - lastSeen ≤ 45s`)
  return EXIT.OK
}

// ══ --status（只读复查，零副作用） ═════════════════════════
function doStatus({ emit, result, to }, device) {
  if (!device) {
    emit(`${TAG}✗ 设备清单里没有 ${formatMac(to)}（从未上报过）`)
    result.error = { code: 'target_unknown', message: '设备从未上报过', hint: '用 push --list 对照' }
    return EXIT.NOT_FOUND
  }
  printDevice(emit, device)
  const cmd = device.unresolved ?? device.lastCommand
  if (!cmd) {
    emit(`${TAG}✗ 这台设备还没有命令记录`)
    result.error = { code: 'target_unknown', message: '没有命令记录', hint: null }
    return EXIT.NOT_FOUND
  }
  result.command = cmd
  printCommand(emit, cmd)
  result.ok = cmd.state === 'success'
  const code = exitForCommand(cmd)
  emit(`${TAG}${verdictLine(cmd)}`)
  emit(`${TAG}复查结论退出码 ${code}（与 --wait 的结论一致，只是立即返回）`)
  if (code !== EXIT.OK) {
    result.error = { code: ERROR_CODE[code] ?? 'error', message: verdictLine(cmd), hint: null }
  }
  return code
}

// ══ --dry-run（只打印将会发生什么，零请求） ═════════════════
async function doDryRun({ args, cfg, dir, emit, result, to }) {
  let buildPlan = null
  let releaseId = args.release ?? null
  if (args.build) {
    const buildDir = path.resolve(args.build.dir ?? cfg.buildDir ?? path.join(dir, 'build'))
    let built
    try {
      built = buildParts({ cfg, dir, buildDir })
    } catch (err) {
      throw new PushError(
        `读构建产物失败：${err.message}`,
        EXIT.USAGE,
        `--build 应指向 ESP-IDF 构建目录（含 flash_args），当前：${buildDir}`,
      )
    }
    releaseId = makeReleaseId(dir)
    buildPlan = { buildDir, variant: built.variant, parts: built.parts.length }
  }
  emit(`${TAG}--dry-run：未发任何请求（设备清单与 registry 都没读）。将会做：`)
  emit(
    `${TAG}  1. ` +
      (buildPlan
        ? `发布 ${cfg.project.id}/${buildPlan.variant}/${releaseId}（${buildPlan.parts} 段，来自 ${buildPlan.buildDir}）`
        : args.latest
          ? `从 registry 解析 ${'该设备芯片'} 的 latest 版本`
          : `使用已有版本 ${releaseId}`),
  )
  emit(`${TAG}  2. 下发到 ${formatMac(to)}（服务器判在线：离线 → 412，不下发、不排队、留 cancelled 记录）`)
  emit(
    `${TAG}  3. ` +
      (args.wait ? `等回执，最多 ${args.waitTimeoutS}s（每 ${args.pollS}s 轮询，按命令 id 精确复查）` : '--no-wait：下发即返回'),
  )
  emit(`${TAG}  闸门（目标在清单 / 芯片族一致 / 非同版本）本次未校验——零请求`)
  result.ok = true
  return EXIT.OK
}

// ══ --cancel ═══════════════════════════════════════════════
async function doCancel({ args, server, cfg, emit, result, to }, device) {
  if (!device) {
    emit(`${TAG}✗ 设备清单里没有 ${formatMac(to)}（从未上报过）`)
    result.error = { code: 'target_unknown', message: '设备从未上报过', hint: null }
    return EXIT.NOT_FOUND
  }
  // 用服务器给的 unresolved：它可能不是"最近记录"（更新的 cancelled 记录会盖在它上面）
  const pend = device.unresolved ?? null
  if (!pend) {
    emit(`${TAG}✗ 没有可撤销的未决命令（每设备至多一条未回执命令）`)
    const last = device.lastCommand
    if (last) emit(`${TAG}  最近一条：${last.state} ${last.id}（已结束，不可撤销）`)
    result.error = { code: 'nothing_to_cancel', message: '没有可撤销的未决命令', hint: '用 --status 看最终状态' }
    return EXIT.NOTHING_TO_CANCEL
  }

  const r = await req(`${server}/api/devices/${device.deviceId}/commands/${pend.id}/cancel`, {
    method: 'POST',
    token: cfg.token,
    body: { reason: args.reason ?? 'cancelled_by_operator' },
  })
  if (r.status === 401 || r.status === 403) throw new PushError(`撤销鉴权失败（${r.status}）`, EXIT.AUTH)
  if (r.status === 404) throw new PushError(`服务器上没有命令 ${pend.id}`, EXIT.NOT_FOUND)
  if (r.status === 409) {
    emit(`${TAG}✗ 撤销失败（409）：命令 ${pend.id} 已经结束（${r.json?.command?.state ?? '?'}），不可撤销`)
    result.error = { code: 'nothing_to_cancel', message: '命令已结束，不可撤销', hint: null }
    return EXIT.NOTHING_TO_CANCEL
  }
  if (!r.ok) throw new PushError(`撤销失败（${r.status}）${r.json?.error ?? ''}`, EXIT.NETWORK)

  result.command = r.json?.command ?? pend
  const wasDelivered = r.json?.wasDelivered === true
  if (wasDelivered) {
    emit(`${TAG}⚠ 已撤销 ${pend.id}——但设备已经取走了它：无法中断正在进行的写入，只能保证不再重复投递。`)
    emit(`${TAG}  设备若仍发来回执，会记为「迟到回执」，不覆盖取消状态（页面标注"撤销来晚了"）。`)
    return EXIT.CANCELLED_LATE
  }
  emit(`${TAG}✓ 已撤销 ${pend.id}：设备下次上报不会再拿到它。${args.reason ? `原因：${args.reason}` : ''}`)
  return EXIT.OK
}

// ══ 下发 + 等待（主力路径） ════════════════════════════════
async function doPush({ args, cfg, dir, server, emit, result, to }, device) {
  const nowMs = Date.now()

  // 1) 目标闸门（先于任何副作用：闸门不过就不发布，不留下无用的快照）
  if (!device && !args.allowUnknown) {
    emit(`${TAG}✗ 目标设备不在清单里：${formatMac(to)}（多半 MAC 打错，或设备从未上报过）`)
    emit(`${TAG}  · 用 push --list 对照现有设备`)
    emit(`${TAG}  · 确要交给服务器判定加 --allow-unknown（从未上报 ⇒ 它必然不在线，多半 exit 9）`)
    result.error = {
      code: 'target_unknown',
      message: '目标设备不在清单里',
      hint: 'MAC 打错？用 --list 对照；确要预排加 --allow-unknown',
    }
    return EXIT.NOT_FOUND
  }
  if (device) printDevice(emit, device, nowMs)
  else emit(`${TAG}⚠ 设备无记录：--allow-unknown 放行（芯片族无法核对，交由服务器判定）`)

  // 2) 固件来源 + 芯片族来源
  let releaseId = args.release ?? null
  let chipFamily = null
  let buildPlan = null
  if (args.build) {
    const buildDir = path.resolve(args.build.dir ?? cfg.buildDir ?? path.join(dir, 'build'))
    let built
    try {
      built = buildParts({ cfg, dir, buildDir })
    } catch (err) {
      throw new PushError(
        `读构建产物失败：${err.message}`,
        EXIT.USAGE,
        `--build 应指向 ESP-IDF 构建目录（含 flash_args），当前：${buildDir}`,
      )
    }
    chipFamily = built.variant
    // release id 提前生成（与 once 同规则）：这样同版本闸门能在发布前判定，--dry-run 也能预告
    releaseId = makeReleaseId(dir)
    buildPlan = { buildDir, variant: built.variant, parts: built.parts.length }
    result.published = { project: cfg.project.id, variant: built.variant, release: releaseId }
    emit(`${TAG}将发布：${cfg.project.id}/${built.variant}/${releaseId}（${built.parts.length} 段，来自 ${buildDir}）`)
  } else if (args.latest) {
    if (!device) {
      throw new PushError(
        '--latest 需要设备上报的芯片型号来解析版本，但目标设备不在清单里',
        EXIT.NOT_FOUND,
        '改用 --release <id> 显式指定版本',
      )
    }
    const registry = await getRegistry(server)
    const hits = latestHits(registry, { projectId: args.project, variant: device.chip })
    if (hits.length === 0) {
      throw new PushError(
        `registry 里没有 ${device.chip} 的 latest 版本${args.project ? `（项目 ${args.project}）` : ''}`,
        EXIT.NOT_FOUND,
        '先在设备工程里发布一次，或用 --release <id> 指定版本',
      )
    }
    if (hits.length > 1) {
      throw new PushError(
        `--latest 有歧义：${device.chip} 命中多个项目 ${hits.map((h) => h.projectId).join(' / ')}`,
        EXIT.USAGE,
        '用 --project <id> 限定其中一个',
      )
    }
    releaseId = hits[0].releaseId
    chipFamily = hits[0].variant
    result.published = { project: hits[0].projectId, variant: hits[0].variant, release: releaseId }
    emit(`${TAG}目标版本：${hits[0].projectId}/${hits[0].variant}/${releaseId}（latest，未发布任何东西）`)
  } else {
    const registry = await getRegistry(server)
    const found = findRelease(registry, args.release)
    if (!found) {
      throw new PushError(
        `registry 里没有 release ${args.release}`,
        EXIT.NOT_FOUND,
        '用 --list / GET /api/registry 核对版本 id',
      )
    }
    chipFamily = found.release.chipFamily
    result.published = { project: found.projectId, variant: found.variant, release: releaseId }
    emit(`${TAG}目标版本：${found.projectId}/${found.variant}/${releaseId}（${found.release.type}，未发布任何东西）`)
  }

  // 3) 芯片族闸门（变砖级故障；"核不了"也算不过）
  if (device) {
    const gate = chipGate(device, chipFamily)
    if (!gate.ok) {
      if (!args.forceChip) {
        emit(`${TAG}✗ ${gate.reason}`)
        throw new PushError(gate.reason, EXIT.CHIP_MISMATCH, '核对 variant；确要强推加 --force-chip（芯片推错会变砖）', true)
      }
      emit(`${TAG}⚠ 芯片族核对未通过，但 --force-chip 放行：${gate.reason}`)
    } else {
      emit(`${TAG}芯片族一致：${gate.want}`)
    }
  }

  // 4) 同版本闸门（省一次下载与擦写；设备端幂等是第二道保险）
  if (args.skipIfSame && isSameVersion(device, releaseId)) {
    emit(`${TAG}= 设备已在目标版本 ${releaseId}：跳过，未下发（要重刷加 --no-skip-if-same）`)
    result.ok = true
    result.skipped = true
    return EXIT.SKIPPED
  }

  // 5) 发布（--build）：发布这一步给 1 次重试，网络抖动不至于白等一次重编译
  if (args.build) {
    const real = console.log
    if (args.json) console.log = (...a) => console.error(...a) // runOnce 的进度别污染 stdout
    try {
      const published = await runOnce(
        { config: args.config, buildDir: buildPlan.buildDir, server, releaseId },
        { retries: 1 },
      )
      result.published = {
        project: published.project ?? cfg.project.id,
        variant: published.variant ?? buildPlan.variant,
        release: published.release ?? releaseId,
        uploaded: published.uploaded ?? null,
      }
    } finally {
      console.log = real
    }
    if (args.promote) await promote({ server, cfg, releaseId, variant: buildPlan.variant, emit })
  }

  // 7) 下发（离线 → 412 + cancelled 记录；同版本未决 → 409 = 重入，接着等）
  let dispatched = await req(`${server}/api/devices/${to}/commands`, {
    method: 'POST',
    token: cfg.token,
    body: { type: 'ota', releaseId, ...(args.force ? { force: true } : {}) },
  })

  if (dispatched.status === 409) {
    const cur = dispatched.json?.command ?? null
    if (cur && cur.releaseId === releaseId && !args.force) {
      emit(`${TAG}设备上已有同一版本的未决命令 ${cur.id}（${cur.state}）：判定为重入，接着等它（不重复下发）`)
      dispatched = { status: 200, ok: true, json: { command: cur } }
    } else {
      emit(
        `${TAG}✗ 设备已有未决命令：` +
          (cur ? `${cur.state} ${cur.id} · release ${cur.releaseId}` : '（未回执）'),
      )
      if (cur) emit(`${TAG}  这条命令的进展：push --status --to ${formatMac(to)}`)
      throw new PushError(
        '设备已有其他版本的未决命令',
        EXIT.CONFLICT,
        '等它回执，或用 --force 顶替（旧命令会被标 superseded）',
        true,
      )
    }
  }

  if (dispatched.status === 412) {
    const j = dispatched.json ?? {}
    emit(`${TAG}→ ${formatMac(to)} · ${j.lastSeen ? `最后心跳 ${fmtAgo(j.lastSeen)}` : '从未上报过'} → 不在线`)
    emit(`${TAG}✗ 已取消：未下发、未排队。设备上线后请重跑本命令（记录已留，页面可见）`)
    if (j.cancelled?.id) {
      emit(`${TAG}  留档：${j.cancelled.id} · ${j.cancelled.state} · 原因 ${cancelReasonText(j.cancelled.cancelReason)}`)
    }
    result.command = j.cancelled ?? null
    result.error = {
      code: 'device_offline',
      message: '设备不在线，已取消（未下发、不排队）',
      hint: '设备上线后重跑本命令；页面 /OTA 可见这次取消的记录',
    }
    return EXIT.OFFLINE
  }
  if (dispatched.status === 401 || dispatched.status === 403) {
    throw new PushError(
      `下发鉴权失败（${dispatched.status}）`,
      EXIT.AUTH,
      'token 缺失/失效：设 FIRMWARE_PUBLISH_TOKEN 或 config 的 token',
    )
  }
  if (dispatched.status === 404) {
    throw new PushError(`服务器上没有 release ${releaseId}`, EXIT.NOT_FOUND, '可能已被回滚/清理')
  }
  if (!dispatched.ok) {
    throw new PushError(
      `下发被拒（${dispatched.status}）${dispatched.json?.error ?? ''}`,
      dispatched.status >= 500 ? EXIT.NETWORK : EXIT.USAGE,
    )
  }

  let cmd = dispatched.json?.command ?? null
  if (!cmd?.id) throw new PushError('服务器没有返回命令 id（响应异常）', EXIT.NETWORK)
  result.command = cmd

  if (!args.wait) {
    emit(`${TAG}已下发 ${cmd.id}（--no-wait：不等待回执）`)
    emit(`${TAG}  复查：node tools/publish/index.js push --status --to ${formatMac(to)}`)
    result.ok = true
    return EXIT.OK
  }

  emit(`${TAG}已下发 ${cmd.id} → 等设备取走…`)
  // 8) 等待回执：按 id 精确轮询（不被"更新的记录"遮住）
  const waited = await waitForCommand({ args, server, cmd, emit, to })
  result.command = waited.command ?? cmd
  result.ok = waited.command?.state === 'success'
  if (waited.exitCode !== EXIT.OK) {
    result.error = {
      code: ERROR_CODE[waited.exitCode] ?? 'error',
      message: verdictLine(waited.command ?? cmd),
      hint: waited.exitCode === EXIT.TIMEOUT ? `push --status --to ${formatMac(to)} 复查` : null,
    }
  }
  return waited.exitCode
}

async function promote({ server, cfg, releaseId, variant, emit }) {
  const r = await req(
    `${server}/api/registry/projects/${cfg.project.id}/variants/${variant}/releases/${releaseId}/promote`,
    { method: 'POST', token: cfg.token, body: { note: 'push --promote' } },
  )
  if (!r.ok) {
    throw new PushError(
      `晋升正式版失败（${r.status}）${r.json?.error ?? ''}`,
      r.status >= 500 ? EXIT.NETWORK : EXIT.USAGE,
    )
  }
  emit(`${TAG}✓ 已晋升为正式版：${cfg.project.id}/${variant}/${releaseId}`)
}

/**
 * 轮询直到终态 / 超时。这里是"稳定推送"的关键：
 * 服务器短暂不可达**不立即判失败**（连续 3 次或累计 30s 才认网络错误），命令在服务器上不受影响。
 */
async function waitForCommand({ args, server, cmd: initial, emit, to }) {
  const cmdId = initial.id
  const hardDeadline = Date.now() + args.waitTimeoutS * 1000
  const pollMs = Math.round(args.pollS * 1000)
  const seen = new Set()
  let cmd = initial
  let failures = 0
  let firstFailureAt = 0
  let stuckFor = null

  const onSigint = () => {
    emit('')
    emit(`${TAG}⚠ 已中断：命令 ${cmdId} 仍在服务器上执行（设备会照做）。`)
    emit(`${TAG}  复查：node tools/publish/index.js push --status --to ${formatMac(to)}`)
    process.exit(EXIT.INTERRUPTED)
  }
  process.on('SIGINT', onSigint)
  try {
    emitNewRows(emit, cmd, seen)

    for (;;) {
      await sleep(pollMs)

      if (Date.now() >= hardDeadline) {
        emit(`${TAG}✗ 超时（${args.waitTimeoutS}s）未见回执`)
        printFullEvidence(emit, cmd, seen)
        emit(`${TAG}  命令仍在服务器上：push --status --to ${formatMac(to)} 复查；页面 /OTA 有同款过程视图`)
        return { exitCode: EXIT.TIMEOUT, command: cmd }
      }

      let r
      try {
        r = await req(`${server}/api/devices/${to}/commands/${cmdId}`)
      } catch {
        r = { status: 0, json: null, ok: false }
      }
      if (r.status === 0 || r.status >= 500) {
        failures++
        if (!firstFailureAt) firstFailureAt = Date.now()
        const unreachable = Date.now() - firstFailureAt
        if (failures >= 3 || unreachable >= 30_000) {
          emit(`${TAG}✗ 轮询失败：连续 ${failures} 次 / 累计 ${fmtDur(unreachable)} 连不上服务器`)
          emit(`${TAG}  命令不受影响（状态在服务器上）：恢复后 push --status --to ${formatMac(to)} 复查`)
          return { exitCode: EXIT.NETWORK, command: cmd }
        }
        continue
      }
      if (r.status === 404) {
        emit(`${TAG}✗ 服务器上找不到命令 ${cmdId}`)
        return { exitCode: EXIT.NOT_FOUND, command: cmd }
      }
      failures = 0
      firstFailureAt = 0

      const next = r.json?.command
      if (!next) continue
      cmd = next
      emitNewRows(emit, cmd, seen)

      if (TERMINAL.includes(cmd.state)) {
        emit(`${TAG}${verdictLine(cmd)}`)
        const note = sourceNote(cmd)
        if (note) emit(`${TAG}  ${note}`)
        return { exitCode: exitForCommand(cmd), command: cmd }
      }
      const stick = stuckNote(cmd)
      if (stick && stuckFor !== cmd.state) {
        stuckFor = cmd.state
        emit(`${TAG}  ⚠ ${stick}`)
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

/** 失败/超时时把"已有的过程"打全（§3.3 的最低要求） */
function printFullEvidence(emit, cmd, seen) {
  emitNewRows(emit, cmd, seen)
  const trace = chainLine(cmd)
  if (trace) emit(`${TAG}  过程链：${trace}`)
  const where = stopPoint(cmd)
  if (where) emit(`${TAG}  ${where}`)
  const note = sourceNote(cmd)
  if (note) emit(`${TAG}  ${note}`)
  const stick = stuckNote(cmd)
  if (stick) emit(`${TAG}  ⚠ ${stick}`)
}
