import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * coredump 存储（docs/coredump.md §4）。
 *
 * 与 devices.js 同风格：纯函数改结构 + 单文件原子写（tmp + rename）。
 * - dump 二进制落盘 `dataDir/coredumps/<sha256>.bin`（按 sha256 命名 → 天然幂等）
 * - 元数据存 `coredumps.json`（`coredumps: []`，新→旧）
 * - 幂等键 `(deviceId, sha256)`；retention 每设备保留最近 MAX_COREDUMPS_PER_DEVICE 条
 */

/** 每设备保留 coredump 条数上限（防磁盘无界增长） */
export const MAX_COREDUMPS_PER_DEVICE = 20

/** flash coredump 分区 64K；接收 body 上限（含 size 校验用） */
export const MAX_COREDUMP_BYTES = 64 * 1024

/** sha256 白名单：64 位小写 hex（两端对 dump 数据本身计算的签名，兼作排重键） */
export const SHA256_RE = /^[0-9a-f]{64}$/

/** coredump id 白名单（用于详情/下载路径段校验） */
export const COREDUMP_ID_RE = /^cdump_[0-9a-f]{4,16}$/

export function coredumpsPath(dataDir) {
  return path.join(dataDir, 'coredumps.json')
}

export function coredumpDir(dataDir) {
  return path.join(dataDir, 'coredumps')
}

export function coredumpFile(dataDir, sha256) {
  return path.join(coredumpDir(dataDir), sha256 + '.bin')
}

export function emptyCoredumpStore() {
  return { coredumps: [] }
}

export function readCoredumpStore(dataDir) {
  const p = coredumpsPath(dataDir)
  if (!fs.existsSync(p)) return emptyCoredumpStore()
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'))
    return v && typeof v === 'object' && Array.isArray(v.coredumps) ? v : emptyCoredumpStore()
  } catch {
    return emptyCoredumpStore()
  }
}

/** 原子写：tmp + rename（同 registry/devices） */
export function writeCoredumpStoreAtomic(dataDir, store) {
  fs.mkdirSync(dataDir, { recursive: true })
  const target = coredumpsPath(dataDir)
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

export function newCoredumpId() {
  return 'cdump_' + crypto.randomBytes(4).toString('hex')
}

/**
 * 纯函数：接收一条 coredump 记录（幂等 + retention 决策），不碰文件系统。
 *
 * - `(deviceId, sha256)` 命中已存在记录 → `duplicate:true`，`record` 是旧记录（返回旧 id，不入库）；
 * - 否则 unshift 入库，并做每设备 retention：超出上限的最旧记录放入 `removed`
 *   （调用方据此删对应 dump 文件）。retention 只在真正新增时触发，重复上传不触发。
 */
export function receiveCoredump(store, record) {
  const next = structuredClone(store)
  if (!Array.isArray(next.coredumps)) next.coredumps = []
  const dup = next.coredumps.find(
    (c) => c.deviceId === record.deviceId && c.sha256 === record.sha256,
  )
  if (dup) return { store: next, record: dup, duplicate: true, removed: [] }

  next.coredumps.unshift(record)
  const mine = next.coredumps.filter((c) => c.deviceId === record.deviceId)
  const removed = []
  if (mine.length > MAX_COREDUMPS_PER_DEVICE) {
    const doomed = mine.slice(MAX_COREDUMPS_PER_DEVICE) // 新→旧，slice 取到的是最旧的
    const doomedIds = new Set(doomed.map((c) => c.id))
    next.coredumps = next.coredumps.filter((c) => !doomedIds.has(c.id))
    removed.push(...doomed)
  }
  return { store: next, record, duplicate: false, removed }
}

/** 按 id 找一条（详情/下载用） */
export function coredumpById(store, id) {
  return (store.coredumps ?? []).find((c) => c.id === id) ?? null
}

/** 摘要（列表/详情响应用，不含二进制；给 baseUrl 时附 downloadUrl） */
export function coredumpSummary(c, baseUrl) {
  if (!c) return null
  const sum = {
    id: c.id,
    deviceId: c.deviceId,
    sha256: c.sha256,
    size: c.size,
    firmwareVersion: c.firmwareVersion ?? null,
    panicReason: c.panicReason ?? null,
    excTask: c.excTask ?? null,
    excPc: c.excPc ?? null,
    appElfSha256: c.appElfSha256 ?? null,
    chip: c.chip ?? null,
    sdkVersion: c.sdkVersion ?? null,
    receivedAt: c.receivedAt ?? null,
  }
  if (baseUrl) sum.downloadUrl = baseUrl + '/api/coredumps/' + c.id + '/download'
  return sum
}

/** 全部 coredump 视图，新→旧（receivedAt 稳定排序） */
export function listCoredumpViews(store, baseUrl) {
  return (store.coredumps ?? [])
    .slice()
    .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
    .map((c) => coredumpSummary(c, baseUrl))
}

/** 某设备的 coredump 列表 */
export function listCoredumpsForDevice(store, deviceId, baseUrl) {
  return listCoredumpViews(store, baseUrl).filter((c) => c.deviceId === deviceId)
}
