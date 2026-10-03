import fs from 'node:fs'
import path from 'node:path'
import { LIMITS } from './config.js'
import { handlePublish } from './publish.js'
import { applyRetention, previewRetention, promoteRelease, setLatest, setRetention } from './releases.js'
import { readRegistry, registryPath, upsertSubscribed, writeRegistryAtomic } from './registry.js'
import { createSseHub } from './stream.js'
import { createToken, isMasterToken, isValidToken, listTokens, revokeToken } from './tokens.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2',
}

function send(res, status, json) {
  const body = JSON.stringify(json)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function collectBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function dirSize(dir) {
  let total = 0
  const walk = (d) => {
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        try {
          total += fs.statSync(p).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(dir)
  return total
}

/** GET /api/status 快照：项目/版本统计 + 数据目录占用 + 服务运行时长 */
function statusSnapshot(dataDir) {
  const reg = readRegistry(dataDir)
  let projects = 0
  let releases = 0
  let latestAt = ''
  for (const p of Object.values(reg.projects ?? {})) {
    projects += 1
    for (const v of Object.values(p.variants ?? {})) {
      releases += (v.releases ?? []).length
      for (const r of v.releases ?? []) {
        if (r.createdAt && r.createdAt > latestAt) latestAt = r.createdAt
      }
    }
  }
  return {
    service: 'firmware-server',
    version: '0.1.0',
    docs: '/llms.txt',
    projects,
    releases,
    latestPublishAt: latestAt || null,
    dataDirBytes: dirSize(path.join(dataDir, 'projects')),
    uptimeSeconds: Math.round(process.uptime()),
    now: new Date().toISOString(),
  }
}

/** GET /api/registry —— 附 etag（mtime），供轮询降级用；_meta 为 AI/客户端自描述 */
function serveRegistry(dataDir, res) {
  const p = registryPath(dataDir)
  const registry = fs.existsSync(p) ? readRegistry(dataDir) : { projects: {} }
  const etag = `"${fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0}"`
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ETag: etag,
  })
  res.end(
    JSON.stringify({
      _meta: { service: 'firmware-server', version: '0.1.0', docs: '/llms.txt' },
      ...registry,
    }),
  )
}

/**
 * GET /api/registry/projects/:pid/variants/:vid/releases/:rid/parts/:file
 * 路径段全部白名单校验 + resolve 前缀检查（双保险防穿越）
 */
function servePart(dataDir, urlPath, res) {
  const m = /^\/api\/registry\/projects\/([^/]+)\/variants\/([^/]+)\/releases\/([^/]+)\/parts\/([^/]+)$/.exec(
    urlPath,
  )
  if (!m) return send(res, 404, { error: 'not found' })
  const [, pid, vid, rid, file] = m
  for (const [seg, what] of [[pid, 'project'], [vid, 'variant'], [rid, 'release'], [file, 'file']]) {
    if (!LIMITS.safeName.test(seg)) return send(res, 400, { error: `unsafe ${what}` })
  }
  const root = path.resolve(dataDir, 'projects')
  const abs = path.resolve(root, pid, vid, rid, file)
  if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) {
    return send(res, 404, { error: 'part not found' })
  }
  const data = fs.readFileSync(abs)
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-cache',
  })
  res.end(data)
}

function serveStatic(distDir, urlPath, res) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1))
  const root = path.resolve(distDir)
  let abs = path.resolve(root, rel)
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    return send(res, 400, { error: 'bad path' })
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    abs = path.join(root, 'index.html') // SPA fallback
    if (!fs.existsSync(abs)) return send(res, 404, { error: 'not built' })
  }
  const ext = path.extname(abs).toLowerCase()
  const data = fs.readFileSync(abs)
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': String(data.length),
  })
  res.end(data)
}

/** 创建 http 请求处理器（deps 注入便于单测） */
export function createApp({ dataDir, token, distDir, sseHeartbeatMs }) {
  const hub = createSseHub({ heartbeatMs: sseHeartbeatMs })
  /** 写操作鉴权：主 token 或任一动态工作 token（FIRMWARE-REGISTRY §8 扩展） */
  const authOk = (req) =>
    isValidToken(dataDir, (req.headers.authorization ?? '').replace(/^Bearer /, ''), token)
  /** 仅主 token：生成/撤销工作 token */
  const masterOk = (req) =>
    isMasterToken((req.headers.authorization ?? '').replace(/^Bearer /, ''), token)
  return Object.assign(
    async function app(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const p = url.pathname
      // 访问日志（P4 可观测性）：每个请求一行；SSE 在连接关闭时记一行
      const started = Date.now()
      let logged = false
      const logHttp = () => {
        if (logged) return
        logged = true
        const line = `[http] ${req.method} ${p} ${res.statusCode} ${Date.now() - started}ms`
        if (res.statusCode >= 500) console.error(line)
        else if (res.statusCode >= 400) console.warn(line)
        else console.log(line)
      }
      res.on('finish', logHttp)
      res.on('close', logHttp)
      try {
        if (req.method === 'GET' && p === '/api/registry') {
          return serveRegistry(dataDir, res)
        }
        // 服务状态摘要卡（公开只读；AI 亦可读）
        if (req.method === 'GET' && p === '/api/status') {
          return send(res, 200, statusSnapshot(dataDir))
        }
        if (req.method === 'GET' && p === '/api/registry/stream') {
          return hub.handler(req, res)
        }
        // F-21 ★订阅状态（读公开写公开，单用户；多用户命名空间为预留扩展点）
        const subM = /^\/api\/registry\/projects\/([^/]+)\/subscribe$/.exec(p)
        if (req.method === 'POST' && subM) {
          if (!LIMITS.safeName.test(subM[1])) return send(res, 400, { error: 'unsafe project id' })
          const body = await collectBody(req, 4 * 1024)
          let subscribed
          try {
            subscribed = JSON.parse(body.toString('utf8')).subscribed
          } catch {
            return send(res, 400, { error: 'bad json' })
          }
          if (typeof subscribed !== 'boolean') return send(res, 400, { error: 'subscribed must be boolean' })
          const reg = readRegistry(dataDir)
          if (!reg.projects?.[subM[1]]) return send(res, 404, { error: 'project not found' })
          writeRegistryAtomic(dataDir, upsertSubscribed(reg, subM[1], subscribed))
          return send(res, 200, { ok: true, projectId: subM[1], subscribed })
        }

        // ---- Token 管理（生成/列表/撤销；仅主 token）----
        if (p === '/api/token') {
          if (req.method === 'GET') {
            if (!masterOk(req)) return send(res, 401, { error: 'master token required' })
            return send(res, 200, { tokens: listTokens(dataDir) })
          }
          if (req.method === 'POST') {
            if (!masterOk(req)) return send(res, 401, { error: 'master token required' })
            const body = await collectBody(req, 4 * 1024)
            let note
            try {
              note = JSON.parse(body.toString('utf8')).note
            } catch {
              note = undefined
            }
            const entry = createToken(dataDir, note)
            return send(res, 200, { ok: true, token: entry })
          }
          if (req.method === 'DELETE') {
            if (!masterOk(req)) return send(res, 401, { error: 'master token required' })
            const body = await collectBody(req, 4 * 1024)
            let revoke
            try {
              revoke = JSON.parse(body.toString('utf8')).token
            } catch {
              revoke = null
            }
            if (typeof revoke !== 'string') return send(res, 400, { error: 'token required' })
            const removed = revokeToken(dataDir, revoke)
            return send(res, removed ? 200 : 404, { ok: removed })
          }
          return send(res, 405, { error: 'method not allowed' })
        }

        // ---- S4 版本管理（F-20 回滚 / F-24 晋升与 retention）----
        const relM =
          /^\/api\/registry\/projects\/([^/]+)\/variants\/([^/]+)\/releases\/([^/]+)\/promote$/.exec(p)
        if (req.method === 'POST' && relM) {
          if (!authOk(req)) return send(res, 401, { error: 'unauthorized' })
          const body = await collectBody(req, 64 * 1024)
          let note
          try {
            note = JSON.parse(body.toString('utf8')).note
          } catch {
            return send(res, 400, { error: 'bad json' })
          }
          const rel = promoteRelease(dataDir, relM[1], relM[2], relM[3], note)
          hub.broadcast('promote', { project: relM[1], variant: relM[2], release: { id: rel.id, type: rel.type } })
          return send(res, 200, { ok: true, release: rel })
        }
        const latestM =
          /^\/api\/registry\/projects\/([^/]+)\/variants\/([^/]+)\/latest$/.exec(p)
        if (req.method === 'POST' && latestM) {
          if (!authOk(req)) return send(res, 401, { error: 'unauthorized' })
          const body = await collectBody(req, 16 * 1024)
          let releaseId
          try {
            releaseId = JSON.parse(body.toString('utf8')).releaseId
          } catch {
            return send(res, 400, { error: 'bad json' })
          }
          if (typeof releaseId !== 'string' || !LIMITS.safeName.test(releaseId)) {
            return send(res, 400, { error: 'bad releaseId' })
          }
          setLatest(dataDir, latestM[1], latestM[2], releaseId)
          hub.broadcast('latest', { project: latestM[1], variant: latestM[2], release: { id: releaseId } })
          return send(res, 200, { ok: true, latest: releaseId })
        }
        const retM = /^\/api\/registry\/projects\/([^/]+)\/retention(\/preview)?$/.exec(p)
        if (retM && req.method === 'GET' && retM[2]) {
          const n = url.searchParams.get('snapshots')
          return send(res, 200, previewRetention(dataDir, retM[1], n ?? undefined))
        }
        if (retM && req.method === 'POST' && !retM[2]) {
          if (!authOk(req)) return send(res, 401, { error: 'unauthorized' })
          const body = await collectBody(req, 4 * 1024)
          let snapshots
          try {
            snapshots = JSON.parse(body.toString('utf8')).snapshots
          } catch {
            return send(res, 400, { error: 'bad json' })
          }
          return send(res, 200, { ok: true, retention: setRetention(dataDir, retM[1], snapshots) })
        }
        if (req.method === 'POST' && p === '/api/publish') {
          const body = await collectBody(req, LIMITS.maxBodyBytes)
          const { status, json } = await handlePublish({
            dataDir,
            token,
            body,
            headers: req.headers,
            onPublished: (payload) => hub.broadcast('publish', payload),
          })
          return send(res, status, json)
        }
        if (req.method === 'GET' && p.startsWith('/api/registry/projects/')) {
          return servePart(dataDir, p, res)
        }
        if (req.method === 'GET' && p.startsWith('/api/')) {
          return send(res, 404, { error: 'unknown api' })
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          return serveStatic(distDir, p, res)
        }
        send(res, 405, { error: 'method not allowed' })
      } catch (err) {
        const status = err?.status ?? 500
        if (status >= 500) console.error('[server]', req.method, p, err)
        else console.warn('[server]', req.method, p, err?.message ?? err)
        send(res, status, { error: err?.message ?? 'internal error' })
      }
    },
    { hub },
  )
}
