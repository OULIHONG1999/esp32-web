import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LIMITS } from './config.js'
import { parseMultipart } from './multipart.js'
import { readRegistry, upsertRelease, writeRegistryAtomic } from './registry.js'

/** 进程内发布互斥锁（单进程服务；并发发布 409） */
let publishing = false

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function releaseDir(dataDir, pid, vid, rid) {
  return path.join(dataDir, 'projects', pid, vid, rid)
}

/** id/文件名安全校验（防穿越：只允许白名单字符，禁止分隔符与点点） */
export function assertSafeName(value, what) {
  if (typeof value !== 'string' || !LIMITS.safeName.test(value)) {
    const e = new Error(`unsafe ${what}: ${String(value)}`)
    e.status = 400
    throw e
  }
}

function parseMeta(raw) {
  let meta
  try {
    meta = JSON.parse(raw)
  } catch {
    const e = new Error('meta is not valid JSON')
    e.status = 400
    throw e
  }
  const { project, release } = meta
  if (!project?.id || !release?.id || !release?.chipFamily || !Array.isArray(release.parts)) {
    const e = new Error('meta missing required fields (project.id / release.id / chipFamily / parts)')
    e.status = 400
    throw e
  }
  assertSafeName(project.id, 'project id')
  assertSafeName(release.id, 'release id')
  const variant = meta.variant || release.chipFamily
  assertSafeName(variant, 'variant')
  for (const p of release.parts) {
    assertSafeName(p.file, 'part file name')
    if (typeof p.address !== 'number' || p.address < 0) {
      const e = new Error(`part address invalid: ${p.file}`)
      e.status = 400
      throw e
    }
    if (typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.sha256)) {
      const e = new Error(`part sha256 invalid: ${p.file}`)
      e.status = 400
      throw e
    }
  }
  if (release.parts.length === 0) {
    const e = new Error('release.parts empty')
    e.status = 400
    throw e
  }
  const total = release.parts.reduce((n, p) => n + (p.size ?? 0), 0)
  if (total > LIMITS.maxBodyBytes) {
    const e = new Error('release too large')
    e.status = 413
    throw e
  }
  return { meta, variant }
}

/**
 * POST /api/publish 处理器。
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {string} opts.token
 * @param {Buffer} opts.body        已读全量正文
 * @param {import('node:http').IncomingHttpHeaders} opts.headers
 * @returns {Promise<{status:number, json:object}>}
 */
export async function handlePublish({ dataDir, token, body, headers }) {
  if (publishing) {
    return { status: 409, json: { error: 'another publish in progress' } }
  }
  publishing = true
  try {
    // ---- 鉴权（写操作 Bearer token；读取公开）----
    const auth = headers.authorization ?? ''
    if (auth !== `Bearer ${token}`) {
      return { status: 401, json: { error: 'unauthorized' } }
    }
    if (body.length > LIMITS.maxBodyBytes) {
      return { status: 413, json: { error: 'body too large' } }
    }

    const ct = headers['content-type'] ?? ''
    if (!ct.includes('multipart/form-data')) {
      return { status: 400, json: { error: 'expected multipart/form-data' } }
    }

    const { fields, files } = parseMultipart(body, ct)
    const metaRaw = fields.get('meta')
    if (!metaRaw) return { status: 400, json: { error: 'missing meta field' } }
    const { meta, variant } = parseMeta(metaRaw)

    // ---- 逐文件 SHA256 校验（不匹配即拒，不落盘）----
    const byFile = new Map()
    for (const f of files) {
      assertSafeName(path.basename(f.filename), 'upload filename')
      if (f.data.length > LIMITS.maxFileBytes) {
        return { status: 413, json: { error: `file too large: ${f.filename}` } }
      }
      const digest = sha256(f.data)
      const declared = meta.release.parts.find((p) => p.file === path.basename(f.filename))
      if (!declared) {
        return { status: 400, json: { error: `file not declared in meta: ${f.filename}` } }
      }
      if (digest !== declared.sha256) {
        return { status: 400, json: { error: `sha256 mismatch: ${declared.file}` } }
      }
      byFile.set(declared.file, f.data)
    }

    const pid = meta.project.id
    const rid = meta.release.id
    const target = releaseDir(dataDir, pid, variant, rid)
    const prevParts = prevReleaseParts(dataDir, pid, variant, rid)

    // ---- 齐全性：每个 part 要么本次上传、要么服务器已有（幂等补传）----
    const staged = []
    for (const p of meta.release.parts) {
      let data = byFile.get(p.file)
      if (!data) {
        // ① 同 release 已有（幂等补传）
        const prev = prevParts.get(p.file)
        if (prev && prev.sha256 === p.sha256) {
          const prevFile = path.join(releaseDir(dataDir, pid, variant, rid), p.file)
          if (fs.existsSync(prevFile)) data = fs.readFileSync(prevFile)
        }
        // ② 跨 release 按 sha256 复用（增量：新 release 只传变化文件，S2）
        if (!data) {
          const src = findPartBySha(dataDir, pid, variant, p.sha256)
          if (src) data = fs.readFileSync(src)
        }
      }
      if (!data) {
        return { status: 400, json: { error: `missing file for part: ${p.file}` } }
      }
      if (sha256(data) !== p.sha256) {
        return { status: 400, json: { error: `sha256 mismatch (server copy): ${p.file}` } }
      }
      staged.push({ part: p, data })
    }

    // ---- 原子落位：全量写 tmp → 替换 release 目录 → 原子更新 registry ----
    const tmpDir = target + '.tmp-' + crypto.randomBytes(4).toString('hex')
    fs.mkdirSync(tmpDir, { recursive: true })
    try {
      for (const { part, data } of staged) {
        fs.writeFileSync(path.join(tmpDir, part.file), data)
      }
      fs.rmSync(target, { recursive: true, force: true })
      fs.renameSync(tmpDir, target)
      // 落 Release 元数据副本：registry 丢失时 rebuild.js 可自愈
      fs.writeFileSync(
        path.join(target, '.meta.json'),
        JSON.stringify({ ...meta.release, createdAt: meta.release.createdAt ?? new Date().toISOString() }, null, 2),
        'utf8',
      )
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      throw err
    }

    const registry = upsertRelease(readRegistry(dataDir), {
      project: meta.project,
      variant,
      release: { ...meta.release, createdAt: meta.release.createdAt ?? new Date().toISOString() },
    })
    writeRegistryAtomic(dataDir, registry)

    return {
      status: 200,
      json: {
        ok: true,
        project: pid,
        variant,
        release: rid,
        files: meta.release.parts.map((p) => p.file),
      },
    }
  } finally {
    publishing = false
  }
}

function prevReleaseParts(dataDir, pid, variant, rid) {
  const reg = readRegistry(dataDir)
  const rel = reg.projects?.[pid]?.variants?.[variant]?.releases?.find((r) => r.id === rid)
  return new Map((rel?.parts ?? []).map((p) => [p.file, p]))
}

/** 跨 release 按 sha256 找盘上已有文件（S2 增量复用）；找不到返回 null */
function findPartBySha(dataDir, pid, variant, sha256Hex) {
  const reg = readRegistry(dataDir)
  const rels = reg.projects?.[pid]?.variants?.[variant]?.releases ?? []
  for (const rel of rels) {
    const p = (rel.parts ?? []).find((x) => x.sha256 === sha256Hex)
    if (!p) continue
    const abs = path.join(releaseDir(dataDir, pid, variant, rel.id), p.file)
    if (fs.existsSync(abs)) return abs
  }
  return null
}
