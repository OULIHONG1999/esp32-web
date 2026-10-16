import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 云盘存储（docs/cloud-drive.md §4）。
 *
 * 与 registry/devices/coredumps 同风格：纯函数改结构 + 单文件原子写（tmp + rename）。
 * - 文件字节落盘 `dataDir/drive/<fileId>`（平坦、按 fileId 命名，与用户文件名解耦）
 * - 元数据存 `dataDir/drive/index.json`（`files: []`，新→旧）
 * - 展示名净化（去路径分隔符/控制字符/`..`）后只作展示，存储只用 fileId
 */

/** 单文件上传上限：8 MB（03 §5；设备经 fetch 下载受 4 MB 顶，更大文件面向智能体/人） */
export const MAX_DRIVE_FILE_BYTES = 8 * 1024 * 1024

/** 云盘总配额：1 GB（03 §5；超额上传 413） */
export const MAX_DRIVE_TOTAL_BYTES = 1024 * 1024 * 1024

/** fileId 白名单：`f_` + 4~16 位小写 hex */
export const DRIVE_FILE_ID_RE = /^f_[0-9a-f]{4,16}$/

export function driveDir(dataDir) {
  return path.join(dataDir, 'drive')
}

export function driveIndexPath(dataDir) {
  return path.join(driveDir(dataDir), 'index.json')
}

export function driveFilePath(dataDir, fileId) {
  return path.join(driveDir(dataDir), fileId)
}

export function emptyDriveStore() {
  return { files: [] }
}

export function readDriveStore(dataDir) {
  const p = driveIndexPath(dataDir)
  if (!fs.existsSync(p)) return emptyDriveStore()
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'))
    return v && typeof v === 'object' && Array.isArray(v.files) ? v : emptyDriveStore()
  } catch {
    return emptyDriveStore()
  }
}

/** 原子写：tmp + rename（同 registry/devices/coredumps） */
export function writeDriveStoreAtomic(dataDir, store) {
  fs.mkdirSync(driveDir(dataDir), { recursive: true })
  const target = driveIndexPath(dataDir)
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

export function newFileId() {
  return 'f_' + crypto.randomBytes(4).toString('hex')
}

/**
 * 展示名净化（03 §8：中文/空格/`..` 都要能上传，存储名安全）。
 * 去控制字符、路径分隔符、`..`，trim + 截断；空名兜底 `unnamed`。
 * 这只影响展示与下载文件名，存储只用 fileId，故净化不是拒绝。
 */
export function sanitizeName(name) {
  const s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/\.\./g, '_')
    .trim()
    .slice(0, 200)
  return s || 'unnamed'
}

/** 云盘已用字节（配额检查用） */
export function totalDriveBytes(store) {
  return (store.files ?? []).reduce((n, f) => n + (Number(f.size) || 0), 0)
}

/** 纯函数：新增一条文件记录（新→旧，按 createdAt 稳定排序） */
export function addDriveFile(store, record) {
  const next = structuredClone(store)
  if (!Array.isArray(next.files)) next.files = []
  next.files.unshift(record)
  next.files.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return next
}

/** 纯函数：按 fileId 移除记录；返回 removed（找不到为 null，调用方据此决定要不要删文件） */
export function removeDriveFile(store, fileId) {
  const next = structuredClone(store)
  const idx = (next.files ?? []).findIndex((f) => f.fileId === fileId)
  if (idx < 0) return { store: next, removed: null }
  const [removed] = next.files.splice(idx, 1)
  return { store: next, removed }
}

/** 按 fileId 找一条（下载/详情用） */
export function driveFileById(store, fileId) {
  return (store.files ?? []).find((f) => f.fileId === fileId) ?? null
}

/** 列表视图（新→旧；给 baseUrl 时附绝对下载 url） */
export function driveFileView(f, baseUrl) {
  if (!f) return null
  const view = {
    fileId: f.fileId,
    name: f.name ?? 'unnamed',
    size: f.size ?? 0,
    note: f.note ?? null,
    createdAt: f.createdAt ?? null,
  }
  if (baseUrl) view.url = baseUrl + '/api/drive/files/' + f.fileId
  return view
}

export function listDriveViews(store, baseUrl) {
  return (store.files ?? [])
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((f) => driveFileView(f, baseUrl))
}
