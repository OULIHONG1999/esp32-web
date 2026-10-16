import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * OTA 设备与命令存储（docs/ota.md §4）。
 *
 * 与 registry.js 同风格：纯函数改结构 + 单文件原子写（tmp + rename）。
 * - 设备 id = base MAC 去冒号小写十六进制（12 位）
 * - 命令队列每设备保留最近 MAX_COMMANDS_PER_DEVICE 条
 * - 在线判定在服务端完成（now - lastSeen > ONLINE_TIMEOUT_MS → 离线）
 */

/** 离线判定阈值；ota.md §3 默认 45s（设备上报间隔 15s，容 3 个周期） */
export const ONLINE_TIMEOUT_MS = 45_000

/** 每设备保留命令条数上限（含已结束，防无限增长） */
export const MAX_COMMANDS_PER_DEVICE = 20

/** deviceId 白名单：base MAC 去冒号小写十六进制 */
export const DEVICE_ID_RE = /^[0-9a-f]{12}$/

/** 命令 ID 白名单（用于回执路径段校验） */
export const COMMAND_ID_RE = /^cmd_[0-9a-f]{4,16}$/

/** fetch 命令：maxBytes 缺省与上限（docs/fetch-channel/README.md §3.1） */
export const FETCH_DEFAULT_MAX_BYTES = 262144
export const FETCH_MAX_BYTES = 4194304

/** 允许设备上报的字段（白名单，未列出的忽略） */
const PATCH_FIELDS = [
  'chip',
  'firmwareVersion',
  'appSha256',
  'sdkVersion',
  'ip',
  'uptimeMs',
  'freeHeap',
  'psramFree',
]

/**
 * 命令状态机取值：pending → delivered → success|failed；
 * 另 superseded（被新命令顶替）/ cancelled（被运维撤销或离线未下发）。
 */
export const COMMAND_STATES = ['pending', 'delivered', 'success', 'failed', 'superseded', 'cancelled']

/** 已终结、不可能再执行的状态（迟到回执要落在这里，不能覆盖历史） */
export const TERMINAL_STATES = ['success', 'failed', 'superseded', 'cancelled']

/** 不可再撤销的状态（已经结束） */
export const UNRESOLVED_STATES = ['pending', 'delivered']

/**
 * 进度阶段的建议取值（页面有中文标签）。
 * 设备端可上报别的短标识——服务器原样存，页面翻译不了就原样显示，
 * 这样设备侧新增阶段不需要改服务器。
 */
export const PROGRESS_PHASES = ['downloading', 'verifying', 'writing', 'rebooting', 'applying']

/** 每命令保留的过程事件上限（只记阶段变化，不记每次百分比） */
export const MAX_TRAIL = 20

export function devicesPath(dataDir) {
  return path.join(dataDir, 'devices.json')
}

export function emptyDeviceStore() {
  return { devices: {} }
}

export function readDeviceStore(dataDir) {
  const p = devicesPath(dataDir)
  if (!fs.existsSync(p)) return emptyDeviceStore()
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'))
    return v && typeof v === 'object' && v.devices && typeof v.devices === 'object'
      ? v
      : emptyDeviceStore()
  } catch {
    return emptyDeviceStore()
  }
}

/** 原子写：tmp + rename（同 registry） */
export function writeDeviceStoreAtomic(dataDir, store) {
  fs.mkdirSync(dataDir, { recursive: true })
  const target = devicesPath(dataDir)
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

export function newCommandId() {
  return 'cmd_' + crypto.randomBytes(3).toString('hex')
}

/**
 * 校验并构建 fetch 命令（docs/fetch-channel/README.md §3.1）。
 * 服务端与设备端同规则做纵深防御：dest 白名单只有 /fs/ 与 /sdcard/ 两棵子树，
 * url 仅明文 http://，maxBytes 越界取边界而非报错。
 * 返回 { command } 或 { error }。
 */
export function buildFetchCommand(wanted, now) {
  const url = wanted.url
  if (typeof url !== 'string' || !/^http:\/\//.test(url) || url.length > 256) {
    return { error: 'bad url' }
  }
  const dest = wanted.dest
  if (typeof dest !== 'string' || !/^\/(fs|sdcard)\//.test(dest)) {
    return { error: 'bad dest: must start with /fs/ or /sdcard/' }
  }
  if (dest.length > 127 || !/^[\x20-\x7E]+$/.test(dest) || dest.includes('..')) {
    return { error: 'bad dest: illegal path' }
  }
  let maxBytes = FETCH_DEFAULT_MAX_BYTES
  if (wanted.maxBytes !== undefined && wanted.maxBytes !== null) {
    if (typeof wanted.maxBytes !== 'number' || !Number.isFinite(wanted.maxBytes)) {
      return { error: 'bad maxBytes' }
    }
    maxBytes = Math.max(1, Math.min(FETCH_MAX_BYTES, Math.round(wanted.maxBytes)))
  }
  return {
    command: {
      id: newCommandId(),
      type: 'fetch',
      url,
      dest,
      maxBytes,
      state: 'pending',
      deliveryCount: 0,
      createdAt: now,
    },
  }
}

/** 纯函数：设备上报 upsert（字段白名单 + 心跳刷新；首次上报建条目） */
export function upsertReport(store, deviceId, patch, now) {
  const next = structuredClone(store)
  const d = (next.devices[deviceId] ??= {
    deviceId,
    createdAt: now,
    lastSeen: now,
    commands: [],
  })
  if (!Array.isArray(d.commands)) d.commands = []
  for (const k of PATCH_FIELDS) {
    const v = patch?.[k]
    if (v === undefined || v === null || v === '') continue
    d[k] = typeof v === 'string' ? v.slice(0, 128) : v
  }
  d.lastSeen = now
  return next
}

/** 未决命令 = pending | delivered（每设备至多一条，见 ota.md §7） */
export function unresolvedCommand(device) {
  const list = device?.commands ?? []
  return list.find((c) => c.state === 'pending' || c.state === 'delivered') ?? null
}

/**
 * 在线判定（服务端唯一口径）：`now - lastSeen <= timeout`。
 * 下发准入、页面展示都走这里，避免两处算法漂移。
 */
export function isDeviceOnline(device, now, timeoutMs = ONLINE_TIMEOUT_MS) {
  const seen = device?.lastSeen ? Date.parse(device.lastSeen) : NaN
  const nowMs = Date.parse(now)
  if (!Number.isFinite(seen) || !Number.isFinite(nowMs)) return false
  return nowMs - seen <= timeoutMs
}

/**
 * 纯函数：取本次要交给设备的命令。
 *
 * 优先投递 pending；若没有 pending 但存在未回执的 delivered，则**重复投递同一条**
 * （并累计 deliveryCount）——设备取走命令后崩溃/丢响应时不会永久卡死，也避免旧命令
 * 一直占着"未决"位而挡住新下发。设备端应做幂等：已是同一 releaseId 就直接回执。
 */
export function nextCommandForDevice(store, deviceId, now) {
  const next = structuredClone(store)
  const d = next.devices[deviceId]
  const list = d?.commands ?? []
  const pending = list.find((c) => c.state === 'pending')
  if (pending) {
    pending.state = 'delivered'
    pending.deliveredAt = now
    pending.lastDeliveredAt = now
    pending.deliveryCount = (pending.deliveryCount ?? 0) + 1
    return { store: next, command: pending, redelivered: false }
  }
  const delivered = list.find((c) => c.state === 'delivered')
  if (delivered) {
    // 重复投递：deliveredAt 保留「第一次被取走」的时刻（过程视图要看首取时间），
    // 最近一次取走记在 lastDeliveredAt，两者配合 deliveryCount 就能看出重投了几次。
    delivered.deliveredAt ??= now
    delivered.lastDeliveredAt = now
    delivered.deliveryCount = (delivered.deliveryCount ?? 0) + 1
    return { store: next, command: delivered, redelivered: true }
  }
  return { store: next, command: null, redelivered: false }
}

/**
 * 纯函数：下发命令入队。
 * 已有未决命令时默认冲突（不静默覆盖，返回 conflict）；force=true 则把旧命令标 superseded。
 * 返回 { store, command, conflict } 三者互斥：成功给 command，冲突给 conflict。
 */
export function enqueueCommand(store, deviceId, command, { force = false } = {}) {
  const next = structuredClone(store)
  const d = (next.devices[deviceId] ??= {
    deviceId,
    createdAt: command.createdAt,
    lastSeen: null,
    commands: [],
  })
  if (!Array.isArray(d.commands)) d.commands = []
  const old = unresolvedCommand(d)
  if (old) {
    if (!force) return { store: next, command: null, conflict: old }
    for (const c of d.commands) {
      if (c.state === 'pending' || c.state === 'delivered') {
        c.state = 'superseded'
        c.finishedAt = command.createdAt
        c.detail = 'superseded by ' + command.id
      }
    }
  }
  d.commands.unshift(command)
  d.commands.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  d.commands = d.commands.slice(0, MAX_COMMANDS_PER_DEVICE)
  return { store: next, command }
}

/**
 * 纯函数：设备进度上报（`POST …/commands/{cid}/progress`，免鉴权，同 report/result）。
 *
 * 解决「下发后看不见过程」：设备在下载/校验/写入/重启各阶段打一个点，页面据此画过程链。
 * 规则：
 * - `progress` 只保留最新值（阶段 + 百分比 + 文案 + 字节）；`trail` 只追加**阶段变化**，
 *   有界 MAX_TRAIL（要的是"何时到了哪一步"，不是每次百分比采样）。
 * - **刷新 lastSeen**：OTA 期间设备主循环常被下载/写入阻塞、不再按时 report，
 *   进度上报是同样的存活信号，否则页面会把正在升级的设备显示成「离线」。
 * - 设备端不上报也完全可用（向后兼容）：页面退化显示服务器可见的时间点。
 */
export function applyProgress(store, deviceId, commandId, report, now) {
  const next = structuredClone(store)
  const d = next.devices[deviceId]
  const cmd = (d?.commands ?? []).find((c) => c.id === commandId)
  if (!cmd) return { store: next, command: null }

  const phase = String(report.phase).trim().slice(0, 32)
  const progress = { phase, updatedAt: now }
  if (typeof report.percent === 'number' && Number.isFinite(report.percent)) {
    progress.percent = Math.max(0, Math.min(100, Math.round(report.percent)))
  }
  for (const k of ['bytes', 'totalBytes']) {
    if (typeof report[k] === 'number' && Number.isFinite(report[k]) && report[k] >= 0) {
      progress[k] = report[k]
    }
  }
  if (typeof report.message === 'string' && report.message.trim()) {
    progress.message = report.message.trim().slice(0, 128)
  }
  cmd.progress = progress

  const trail = (cmd.trail ??= [])
  const last = trail[trail.length - 1]
  if (!last || last.phase !== phase) {
    const entry = { phase, at: now }
    if (progress.percent !== undefined) entry.percent = progress.percent
    trail.push(entry)
    if (trail.length > MAX_TRAIL) cmd.trail = trail.slice(-MAX_TRAIL)
  } else if (progress.percent !== undefined) {
    // 同阶段继续推进：把该阶段的比例抬到最新值（`at` 仍是阶段**起点**）——
    // 时间线上于是读得出"下载自 X 开始、最终到 100%"，而不是永远停在首个采样。
    last.percent = Math.max(last.percent ?? 0, progress.percent)
  }

  if (d) d.lastSeen = now
  return { store: next, command: cmd }
}

/**
 * 纯函数：往设备上记一条**已取消**的命令（离线未下发 / 运维撤销）。
 *
 * 用户规则：「离线设备不排队、不等上线，固件下发直接取消，只保留记录和提醒」。
 * 所以离线时不进 pending（`nextCommandForDevice` 只取 pending/delivered，永远不会投递它），
 * 但**留一条记录**：页面能显示"什么时候想推什么、为什么被取消"。
 * 不占"未决位"（`unresolvedCommand` 只看 pending/delivered）——设备上线后重推不会被 409 挡。
 */
export function recordCancelled(store, deviceId, command, reason, now) {
  const next = structuredClone(store)
  const d = (next.devices[deviceId] ??= {
    deviceId,
    createdAt: now,
    lastSeen: null,
    commands: [],
  })
  if (!Array.isArray(d.commands)) d.commands = []
  const record = {
    ...command,
    state: 'cancelled',
    deliveryCount: 0,
    createdAt: now,
    finishedAt: now,
    cancelledAt: now,
    cancelReason: reason,
  }
  d.commands.unshift(record)
  d.commands.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  d.commands = d.commands.slice(0, MAX_COMMANDS_PER_DEVICE)
  return { store: next, command: record }
}

/**
 * 纯函数：运维撤销一条未决命令（`POST …/commands/{cid}/cancel`，Bearer）。
 *
 * 两种情形能力不同，必须如实区分（返回 `wasDelivered`）：
 * - 撤销 `pending`：**真拦住了**——设备下次上报不会再拿到它；
 * - 撤销 `delivered`：**拦不住正在写的设备**，但能**停掉重复投递**（取走未回执时服务器本来会一直再投同一条）。
 *
 * 已终结的命令不可撤（返回 `notCancellable`）；撤销后设备若仍发来回执，由 applyResult 记进 `lateResult`。
 */
export function cancelCommand(store, deviceId, commandId, reason, now) {
  const next = structuredClone(store)
  const d = next.devices[deviceId]
  const cmd = (d?.commands ?? []).find((c) => c.id === commandId)
  if (!cmd) return { store: next, command: null, wasDelivered: false, notCancellable: false }
  if (!UNRESOLVED_STATES.includes(cmd.state)) {
    return { store: next, command: cmd, wasDelivered: false, notCancellable: true }
  }
  const wasDelivered = cmd.state === 'delivered'
  cmd.state = 'cancelled'
  cmd.cancelledAt = now
  cmd.finishedAt = now
  cmd.cancelReason = reason
  cmd.wasDelivered = wasDelivered
  return { store: next, command: cmd, wasDelivered, notCancellable: false }
}

/**
 * 纯函数：设备回执（只认 success|failed）。
 *
 * ⚠️ 迟到回执：命令若已被撤销（cancelled）或被顶替（superseded），**不覆盖终态**——
 * 设备可能在运维撤销前就已经取走并写完了。真回执记进 `lateResult`，页面据此标注"设备已完成（撤销来晚了）"。
 */
export function applyResult(store, deviceId, commandId, state, detail, now) {
  const next = structuredClone(store)
  const d = next.devices[deviceId]
  const cmd = (d?.commands ?? []).find((c) => c.id === commandId)
  if (!cmd) return { store: next, command: null }
  if (cmd.state === 'cancelled' || cmd.state === 'superseded') {
    cmd.lateResult = { state, at: now }
    if (typeof detail === 'string' && detail) cmd.lateResult.detail = detail.slice(0, 256)
    return { store: next, command: cmd }
  }
  cmd.state = state
  cmd.finishedAt = now
  if (typeof detail === 'string' && detail) cmd.detail = detail.slice(0, 256)
  return { store: next, command: cmd }
}

/** 命令摘要（列表/回执响应用，不含下载字段）；fetch 命令不带 releaseId，改带 url/dest/maxBytes */
export function commandSummary(c) {
  if (!c) return null
  const base = {
    id: c.id,
    type: c.type,
    state: c.state,
    deliveryCount: c.deliveryCount ?? 0,
    createdAt: c.createdAt,
    deliveredAt: c.deliveredAt ?? null,
    lastDeliveredAt: c.lastDeliveredAt ?? null,
    progress: c.progress ?? null,
    trail: Array.isArray(c.trail) ? c.trail : [],
    finishedAt: c.finishedAt ?? null,
    detail: c.detail ?? null,
    cancelledAt: c.cancelledAt ?? null,
    cancelReason: c.cancelReason ?? null,
    wasDelivered: c.wasDelivered ?? null,
    lateResult: c.lateResult ?? null,
  }
  if (c.type === 'fetch') {
    return { ...base, url: c.url ?? null, dest: c.dest ?? null, maxBytes: c.maxBytes ?? null }
  }
  return { ...base, releaseId: c.releaseId ?? null }
}

/** 交付给设备的完整命令体（ota.md §4.1；baseUrl 可选，给出绝对地址方便设备直取） */
export function commandForDevice(c, baseUrl) {
  if (!c) return null
  // fetch 信封只有六个字段（fetch-channel/README.md §3.2），不带 urlAbsolute 与下载字段
  if (c.type === 'fetch') {
    return {
      id: c.id,
      type: 'fetch',
      url: c.url,
      dest: c.dest,
      maxBytes: c.maxBytes ?? FETCH_DEFAULT_MAX_BYTES,
      createdAt: c.createdAt,
    }
  }
  const body = {
    id: c.id,
    type: c.type,
    releaseId: c.releaseId,
    file: c.file,
    url: c.url,
    sha256: c.sha256,
    size: c.size,
    createdAt: c.createdAt,
  }
  if (baseUrl) body.urlAbsolute = baseUrl + c.url
  return body
}

/** 设备列表视图（ota.md §4.2；online 由服务端算，页面不自算） */
export function listDeviceViews(store, now) {
  const nowMs = Date.parse(now)
  return Object.values(store.devices ?? {})
    .map((d) => {
      const seenMs = d.lastSeen ? Date.parse(d.lastSeen) : 0
      const commands = d.commands ?? []
      return {
        deviceId: d.deviceId,
        chip: d.chip ?? null,
        firmwareVersion: d.firmwareVersion ?? null,
        appSha256: d.appSha256 ?? null,
        sdkVersion: d.sdkVersion ?? null,
        ip: d.ip ?? null,
        online: seenMs > 0 && nowMs - seenMs <= ONLINE_TIMEOUT_MS,
        lastSeen: d.lastSeen ?? null,
        createdAt: d.createdAt ?? null,
        lastCommand: commandSummary(commands[0] ?? null),
        // 未决命令单独给出：它可能**不是** commands[0]——例如设备离线时又下发了一次，
        // 会新增一条更新的 cancelled 记录把还在队列里的 pending 顶下去（PUSH-TO-DEVICE §3.4）。
        // 撤销按钮 / CLI --cancel 必须看这个字段，否则会撤错对象或找不到可撤的命令。
        unresolved: commandSummary(unresolvedCommand(d)),
      }
    })
    .sort((a, b) => ((a.lastSeen ?? '') < (b.lastSeen ?? '') ? 1 : -1))
}

/** 在 registry 里按 releaseId 跨项目/变体定位 release */
export function resolveRelease(registry, releaseId) {
  for (const [projectId, proj] of Object.entries(registry.projects ?? {})) {
    for (const [variant, v] of Object.entries(proj.variants ?? {})) {
      const rel = (v.releases ?? []).find((r) => r.id === releaseId)
      if (rel) return { projectId, variant, release: rel }
    }
  }
  return null
}

/** 选可 OTA 的 app 段：优先 type==='app'，退化到最大的 .bin */
export function pickAppPart(release) {
  const parts = (release?.parts ?? []).filter((p) => p && p.file)
  const byType = parts.find((p) => p.type === 'app')
  if (byType) return byType
  const bins = parts.filter((p) => /\.bin$/i.test(p.file)).sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
  return bins[0] ?? null
}
