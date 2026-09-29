import fs from 'node:fs'
import path from 'node:path'
import { LIMITS } from './config.js'
import { handlePublish } from './publish.js'
import { applyRetention, previewRetention, promoteRelease, setLatest, setRetention } from './releases.js'
import { readRegistry, registryPath, upsertSubscribed, writeRegistryAtomic } from './registry.js'
import { createSseHub } from './stream.js'

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

/** GET /api/registry —— 附 etag（mtime），供轮询降级用 */
function serveRegistry(dataDir, res) {
  const p = registryPath(dataDir)
  const registry = fs.existsSync(p) ? readRegistry(dataDir) : { projects: {} }
  const etag = `"${fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0}"`
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ETag: etag,
  })
  res.end(JSON.stringify(registry))
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
  /** 写操作鉴权（FIRMWARE-REGISTRY §8：发布/晋升/回滚/retention 属写） */
  const authOk = (req) => req.headers.authorization === `Bearer ${token}`
  return Object.assign(
    async function app(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const p = url.pathname
      try {
        if (req.method === 'GET' && p === '/api/registry') {
          return serveRegistry(dataDir, res)
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
        if (status >= 500) console.error('[server]', err)
        send(res, status, { error: err?.message ?? 'internal error' })
      }
    },
    { hub },
  )
}
