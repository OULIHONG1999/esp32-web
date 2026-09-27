import fs from 'node:fs'
import path from 'node:path'
import { LIMITS } from './config.js'
import { handlePublish } from './publish.js'
import { readRegistry, registryPath } from './registry.js'

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
export function createApp({ dataDir, token, distDir }) {
  return async function app(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const p = url.pathname
    try {
      if (req.method === 'GET' && p === '/api/registry') {
        return serveRegistry(dataDir, res)
      }
      if (req.method === 'POST' && p === '/api/publish') {
        const body = await collectBody(req, LIMITS.maxBodyBytes)
        const { status, json } = await handlePublish({
          dataDir,
          token,
          body,
          headers: req.headers,
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
  }
}
