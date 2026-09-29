import fs from 'node:fs'
import path from 'node:path'
import { readRegistry, writeRegistryAtomic } from './registry.js'

function httpError(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}

function releaseDir(dataDir, pid, vid, rid) {
  return path.join(dataDir, 'projects', pid, vid, rid)
}

function requireRelease(reg, pid, vid, rid) {
  const proj = reg.projects?.[pid]
  if (!proj) throw httpError(404, 'project not found')
  const vars = proj.variants?.[vid]
  if (!vars) throw httpError(404, 'variant not found')
  const rel = vars.releases.find((r) => r.id === rid)
  if (!rel) throw httpError(404, 'release not found')
  return { proj, vars, rel }
}

/**
 * F-24 / N10：snapshot 晋升为发布版（note 必填，manual）。
 * 幂等边界：已是 release → 409。
 */
export function promoteRelease(dataDir, pid, vid, rid, note) {
  if (typeof note !== 'string' || !note.trim()) throw httpError(400, 'note required for release')
  const reg = readRegistry(dataDir)
  const { rel } = requireRelease(reg, pid, vid, rid)
  if (rel.type === 'release') throw httpError(409, 'already a release')
  rel.type = 'release'
  rel.note = note.trim()
  rel.noteSource = 'manual'
  writeRegistryAtomic(dataDir, reg)
  return rel
}

/**
 * F-20 回滚：把 variant.latest 指向任意已有版本（不迁移文件，纯指针）。
 */
export function setLatest(dataDir, pid, vid, rid) {
  const reg = readRegistry(dataDir)
  const { vars } = requireRelease(reg, pid, vid, rid)
  vars.latest = rid
  writeRegistryAtomic(dataDir, reg)
  return vars.latest
}

/** retention 取值：正整数或 'all'；undefined=未设置（默认 snapshots 30） */
export function normalizeSnapshots(v) {
  if (v === 'all') return 'all'
  const n = typeof v === 'string' ? Number(v) : v
  if (!Number.isInteger(n) || n < 0) throw httpError(400, 'snapshots must be integer >= 0 or "all"')
  return n
}

/** 设置项目保留策略（只写未来策略，不立即删——执行在下次 publish，FIRMWARE-REGISTRY §4.3） */
export function setRetention(dataDir, pid, snapshotsRaw) {
  const snapshots = normalizeSnapshots(snapshotsRaw)
  const reg = readRegistry(dataDir)
  const proj = reg.projects?.[pid]
  if (!proj) throw httpError(404, 'project not found')
  proj.retention = { ...(proj.retention ?? {}), snapshots }
  writeRegistryAtomic(dataDir, reg)
  return proj.retention
}

/** 预览：按当前（或传入）策略，列出下次 publish 将被删除的 snapshot（确认弹层用） */
export function previewRetention(dataDir, pid, snapshotsRaw) {
  const reg = readRegistry(dataDir)
  const proj = reg.projects?.[pid]
  if (!proj) throw httpError(404, 'project not found')
  const snapshots =
    snapshotsRaw === undefined
      ? (proj.retention?.snapshots ?? 30)
      : normalizeSnapshots(snapshotsRaw)
  const doomed = []
  if (snapshots === 'all') return { snapshots, doomed }
  for (const vid of Object.keys(proj.variants ?? {})) {
    const vars = proj.variants[vid]
    const snaps = vars.releases
      .filter((r) => r.type === 'snapshot')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) // 新→旧
    for (const r of snaps.slice(snapshots)) {
      doomed.push({ variant: vid, release: r.id, createdAt: r.createdAt })
    }
  }
  return { snapshots, doomed }
}

/**
 * 下次 publish 时执行清理（FIRMWARE-REGISTRY §4.3 执行时机）：
 * - 只删 type=snapshot 且超出 snapshots 保留数的最旧版本（releases 永不自动删）
 * - snapshots='all'/未设置超 30 默认；'all' 不删
 * @returns {{removed: {variant:string, release:string}[]}}
 */
export function applyRetention(dataDir, pid) {
  const reg = readRegistry(dataDir)
  const proj = reg.projects?.[pid]
  if (!proj) return { removed: [] }
  const limit = proj.retention?.snapshots ?? 30
  if (limit === 'all') return { removed: [] }

  const removed = []
  for (const vid of Object.keys(proj.variants ?? {})) {
    const vars = proj.variants[vid]
    const snaps = vars.releases
      .filter((r) => r.type === 'snapshot')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) // 新→旧
    const doomed = snaps.slice(limit)
    for (const r of doomed) {
      if (r.id === vars.latest) continue // 不删 latest 指针（防御）
      fs.rmSync(releaseDir(dataDir, pid, vid, r.id), { recursive: true, force: true })
      vars.releases = vars.releases.filter((x) => x.id !== r.id)
      removed.push({ variant: vid, release: r.id })
    }
  }
  if (removed.length > 0) writeRegistryAtomic(dataDir, reg)
  return { removed }
}
