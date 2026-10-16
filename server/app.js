import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { LIMITS } from './config.js'
import {
  COREDUMP_ID_RE,
  MAX_COREDUMP_BYTES,
  MAX_COREDUMPS_PER_DEVICE,
  SHA256_RE,
  coredumpById,
  coredumpDir,
  coredumpFile,
  coredumpSummary,
  listCoredumpViews,
  listCoredumpsForDevice,
  newCoredumpId,
  readCoredumpStore,
  receiveCoredump,
  writeCoredumpStoreAtomic,
} from './coredumps.js'
import {
  COMMAND_ID_RE,
  DEVICE_ID_RE,
  ONLINE_TIMEOUT_MS,
  PROGRESS_PHASES,
  applyProgress,
  applyResult,
  buildFetchCommand,
  cancelCommand,
  commandForDevice,
  commandSummary,
  enqueueCommand,
  isDeviceOnline,
  listDeviceViews,
  newCommandId,
  nextCommandForDevice,
  pickAppPart,
  readDeviceStore,
  recordCancelled,
  resolveRelease,
  upsertReport,
  writeDeviceStoreAtomic,
} from './devices.js'
import {
  DRIVE_FILE_ID_RE,
  MAX_DRIVE_FILE_BYTES,
  MAX_DRIVE_TOTAL_BYTES,
  addDriveFile,
  driveFileById,
  driveFilePath,
  driveFileView,
  listDriveViews,
  newFileId,
  readDriveStore,
  removeDriveFile,
  sanitizeName,
  totalDriveBytes,
  writeDriveStoreAtomic,
} from './drive.js'
import { parseMultipart } from './multipart.js'
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
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
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

/** 独立页路径归一：/OTA、/OTA/… → /ota（Linux 大小写敏感，显式归一保证 /OTA 可访问） */
function normalizePagePath(urlPath) {
  if (/^\/ota(\/|$)/i.test(urlPath)) return '/ota' + urlPath.slice(4)
  if (/^\/drive(\/|$)/i.test(urlPath)) return '/drive' + urlPath.slice(6)
  return urlPath
}

/** 客户端 IP：优先 nginx 转发的 X-Forwarded-For，退化到 socket（去掉 IPv6 映射前缀） */
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
  const raw = fwd || req.socket?.remoteAddress || ''
  return raw.replace(/^::ffff:/, '').slice(0, 64)
}

/** 请求可达的自身基地址（绝对 URL 用；设备拿到即可直接下载固件） */
function baseUrlOf(req) {
  const host = req.headers.host
  if (!host) return ''
  const proto =
    String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() ||
    (req.socket?.encrypted ? 'https' : 'http')
  return `${proto}://${host}`
}

/** 解析 JSON body；空体视为 {}；非法结构抛 400（外层 catch 统一回 400） */
async function readJsonBody(req, maxBytes) {
  const body = await collectBody(req, maxBytes)
  const text = body.toString('utf8').trim()
  if (!text) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw Object.assign(new Error('bad json body'), { status: 400 })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('body must be a json object'), { status: 400 })
  }
  return parsed
}

/** 读可选 header 文本：取首个、截断、非空否则 null；X-Panic-Reason 传 urlencoded（含 backtrace 可能是长串） */
function headerText(req, name, maxLen) {
  const raw = req.headers[name]
  const v = Array.isArray(raw) ? raw[0] : raw
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim().slice(0, maxLen)
  return s || null
}

function serveStatic(distDir, urlPath, res) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(normalizePagePath(urlPath).slice(1))
  const root = path.resolve(distDir)
  let abs = path.resolve(root, rel)
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    return send(res, 400, { error: 'bad path' })
  }
  // 目录 → 目录内 index.html（如 /ota/ → ota/index.html）；未命中再走 SPA 兜底
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const idx = path.join(abs, 'index.html')
    if (fs.existsSync(idx)) abs = idx
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

/** GET /files/<path>：fetch 命令的 URL 源（docs/fetch-channel/02-server.md §5）。只读，路径即磁盘路径，防穿越。 */
function serveHostedFile(dataDir, relPath, res) {
  let rel
  try {
    rel = decodeURIComponent(relPath)
  } catch {
    return send(res, 400, { error: 'bad path' })
  }
  const root = path.resolve(dataDir, 'files')
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return send(res, 400, { error: 'bad path' })
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    return send(res, 404, { error: 'file not found' })
  }
  const ext = path.extname(abs).toLowerCase()
  const data = fs.readFileSync(abs)
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-cache',
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
        // ---- OTA 设备与命令（docs/ota.md §4；设备上报/回执免鉴权，下发命令需 token）----
        if (req.method === 'GET' && p === '/api/devices') {
          return send(res, 200, {
            _meta: {
              service: 'firmware-server',
              docs: '/docs/DEVICE-OTA.md',
              onlineTimeoutMs: ONLINE_TIMEOUT_MS,
            },
            devices: listDeviceViews(readDeviceStore(dataDir), new Date().toISOString()),
          })
        }

        // 设备上报（兼心跳 + 取命令）；免鉴权：deviceId 即身份
        const devReportM = /^\/api\/devices\/([^/]+)\/report$/.exec(p)
        if (req.method === 'POST' && devReportM) {
          const deviceId = devReportM[1]
          if (!DEVICE_ID_RE.test(deviceId)) {
            return send(res, 400, { error: 'deviceId must be 12 lowercase hex chars (base MAC)' })
          }
          const patch = await readJsonBody(req, 8 * 1024)
          if (!patch.ip) patch.ip = clientIp(req)
          const now = new Date().toISOString()
          let store = upsertReport(readDeviceStore(dataDir), deviceId, patch, now)
          const taken = nextCommandForDevice(store, deviceId, now)
          store = taken.store
          writeDeviceStoreAtomic(dataDir, store)
          return send(res, 200, {
            now,
            command: commandForDevice(taken.command, baseUrlOf(req)),
            ...(taken.redelivered ? { redelivered: true } : {}),
          })
        }

        // 下发 OTA 命令（写操作 → Bearer 鉴权）
        const devCmdM = /^\/api\/devices\/([^/]+)\/commands$/.exec(p)
        if (req.method === 'POST' && devCmdM) {
          if (!authOk(req)) return send(res, 401, { error: 'unauthorized' })
          const deviceId = devCmdM[1]
          if (!DEVICE_ID_RE.test(deviceId)) {
            return send(res, 400, { error: 'deviceId must be 12 lowercase hex chars (base MAC)' })
          }
          const wanted = await readJsonBody(req, 8 * 1024)
          const type = wanted.type ?? 'ota'
          const now = new Date().toISOString()
          let command
          if (type === 'ota') {
            const releaseId = wanted.releaseId
            if (typeof releaseId !== 'string' || !LIMITS.safeName.test(releaseId)) {
              return send(res, 400, { error: 'bad releaseId' })
            }
            const found = resolveRelease(readRegistry(dataDir), releaseId)
            if (!found) return send(res, 404, { error: 'release not found', releaseId })
            const part = pickAppPart(found.release)
            if (!part) return send(res, 400, { error: 'release has no app part to OTA', releaseId })
            command = {
              id: newCommandId(),
              type: 'ota',
              releaseId,
              projectId: found.projectId,
              variant: found.variant,
              file: part.file,
              url: `/api/registry/projects/${found.projectId}/variants/${found.variant}/releases/${releaseId}/parts/${part.file}`,
              sha256: part.sha256 ?? null,
              size: part.size ?? null,
              state: 'pending',
              deliveryCount: 0,
              createdAt: now,
            }
          } else if (type === 'fetch') {
            // fetch 命令：url/dest/maxBytes 由 buildFetchCommand 校验并钳位（服务端与设备端同规则）
            const built = buildFetchCommand(wanted, now)
            if (built.error) return send(res, 400, { error: built.error })
            command = built.command
          } else {
            return send(res, 400, { error: 'unsupported command type' })
          }
          const storeBefore = readDeviceStore(dataDir)
          const target = storeBefore.devices[deviceId] ?? null
          // 离线（含"从未上报过"）→ 不下发、不排队、不等上线，只留一条 cancelled 记录（docs/PUSH-TO-DEVICE.md §3.1）
          // 判定放在服务端而非调用方：调用方先查再下发之间存在 TOCTOU，只有入队这一刻的判定才是权威的。
          if (!isDeviceOnline(target, now)) {
            const recorded = recordCancelled(storeBefore, deviceId, command, 'device_offline', now)
            writeDeviceStoreAtomic(dataDir, recorded.store)
            return send(res, 412, {
              error: 'device offline',
              deviceId,
              lastSeen: target?.lastSeen ?? null,
              onlineTimeoutMs: ONLINE_TIMEOUT_MS,
              cancelled: commandSummary(recorded.command),
            })
          }
          const queued = enqueueCommand(storeBefore, deviceId, command, {
            force: wanted.force === true,
          })
          if (queued.conflict) {
            return send(res, 409, {
              error: 'device has an unresolved command (pass {"force":true} to supersede)',
              command: commandSummary(queued.conflict),
            })
          }
          writeDeviceStoreAtomic(dataDir, queued.store)
          return send(res, 200, { command: { deviceId, ...commandSummary(queued.command) } })
        }

        // 设备回执（免鉴权，同 report）
        const devResultM = /^\/api\/devices\/([^/]+)\/commands\/([^/]+)\/result$/.exec(p)
        if (req.method === 'POST' && devResultM) {
          const deviceId = devResultM[1]
          const commandId = devResultM[2]
          if (!DEVICE_ID_RE.test(deviceId)) {
            return send(res, 400, { error: 'deviceId must be 12 lowercase hex chars (base MAC)' })
          }
          if (!COMMAND_ID_RE.test(commandId)) return send(res, 400, { error: 'bad commandId' })
          const payload = await readJsonBody(req, 4 * 1024)
          if (payload.state !== 'success' && payload.state !== 'failed') {
            return send(res, 400, { error: 'state must be success|failed' })
          }
          const outcome = applyResult(
            readDeviceStore(dataDir),
            deviceId,
            commandId,
            payload.state,
            payload.detail,
            new Date().toISOString(),
          )
          if (!outcome.command) return send(res, 404, { error: 'command not found', commandId })
          writeDeviceStoreAtomic(dataDir, outcome.store)
          return send(res, 200, { ok: true, command: commandSummary(outcome.command) })
        }

        // 设备进度上报（免鉴权，同 report/result）——让页面能看见「OTA 进行到哪一步」
        const devProgressM = /^\/api\/devices\/([^/]+)\/commands\/([^/]+)\/progress$/.exec(p)
        if (req.method === 'POST' && devProgressM) {
          const deviceId = devProgressM[1]
          const commandId = devProgressM[2]
          if (!DEVICE_ID_RE.test(deviceId)) {
            return send(res, 400, { error: 'deviceId must be 12 lowercase hex chars (base MAC)' })
          }
          if (!COMMAND_ID_RE.test(commandId)) return send(res, 400, { error: 'bad commandId' })
          const payload = await readJsonBody(req, 4 * 1024)
          const phase = typeof payload.phase === 'string' ? payload.phase.trim() : ''
          if (!phase || phase.length > 32) {
            return send(res, 400, {
              error: 'phase required (<=32 chars), e.g. ' + PROGRESS_PHASES.join('|'),
            })
          }
          if (payload.percent !== undefined && (typeof payload.percent !== 'number' || !Number.isFinite(payload.percent))) {
            return send(res, 400, { error: 'percent must be a finite number 0-100' })
          }
          const reported = applyProgress(
            readDeviceStore(dataDir),
            deviceId,
            commandId,
            payload,
            new Date().toISOString(),
          )
          if (!reported.command) return send(res, 404, { error: 'command not found', commandId })
          writeDeviceStoreAtomic(dataDir, reported.store)
          return send(res, 200, { ok: true, command: commandSummary(reported.command) })
        }

        // 按 id 读单条命令（公开只读，与 /api/devices 同级）：
        // 等待期间按 id 精确轮询，避免"命令被更新的记录顶出列表"就再也看不到它的结局（PUSH-TO-DEVICE §4）。
        const devCmdGetM = /^\/api\/devices\/([^/]+)\/commands\/([^/]+)$/.exec(p)
        if (req.method === 'GET' && devCmdGetM) {
          const deviceId = devCmdGetM[1]
          const commandId = devCmdGetM[2]
          if (!DEVICE_ID_RE.test(deviceId)) {
            return send(res, 400, { error: 'deviceId must be 12 lowercase hex chars (base MAC)' })
          }
          if (!COMMAND_ID_RE.test(commandId)) return send(res, 400, { error: 'bad commandId' })
          const dev = readDeviceStore(dataDir).devices?.[deviceId]
          const cmd = (dev?.commands ?? []).find((c) => c.id === commandId)
          if (!cmd) return send(res, 404, { error: 'command not found', commandId })
          return send(res, 200, { command: commandSummary(cmd) })
        }

        // 运维撤销未决命令（写操作 → Bearer）：推错了能握停；delivered 也允许撤（可停掉重复投递）
        const devCancelM = /^\/api\/devices\/([^/]+)\/commands\/([^/]+)\/cancel$/.exec(p)
        if (req.method === 'POST' && devCancelM) {
          if (!authOk(req)) return send(res, 401, { error: 'unauthorized' })
          const deviceId = devCancelM[1]
          const commandId = devCancelM[2]
          if (!DEVICE_ID_RE.test(deviceId)) {
            return send(res, 400, { error: 'deviceId must be 12 lowercase hex chars (base MAC)' })
          }
          if (!COMMAND_ID_RE.test(commandId)) return send(res, 400, { error: 'bad commandId' })
          const payload = await readJsonBody(req, 2 * 1024)
          const reason =
            typeof payload.reason === 'string' && payload.reason.trim()
              ? payload.reason.trim().slice(0, 128)
              : 'cancelled_by_operator'
          const outcome = cancelCommand(
            readDeviceStore(dataDir),
            deviceId,
            commandId,
            reason,
            new Date().toISOString(),
          )
          if (!outcome.command) return send(res, 404, { error: 'command not found', commandId })
          if (outcome.notCancellable) {
            return send(res, 409, {
              error: 'command already finished',
              command: commandSummary(outcome.command),
            })
          }
          writeDeviceStoreAtomic(dataDir, outcome.store)
          return send(res, 200, {
            ok: true,
            wasDelivered: outcome.wasDelivered,
            command: commandSummary(outcome.command),
          })
        }

        // ---- coredump 上报与查看（docs/coredump.md §5–§6；上报免鉴权，deviceId 即身份）----
        // 上报：二进制 body（application/octet-stream），元数据走 query + header，见契约 §5.1。
        const cdReportM = /^\/api\/devices\/([^/]+)\/coredump$/.exec(p)
        if (req.method === 'POST' && cdReportM) {
          const deviceId = cdReportM[1]
          if (!DEVICE_ID_RE.test(deviceId)) {
            return send(res, 400, { error: 'deviceId must be 12 lowercase hex chars (base MAC)' })
          }
          const sha256 = (url.searchParams.get('sha256') ?? '').toLowerCase()
          if (!SHA256_RE.test(sha256)) {
            return send(res, 400, { error: 'sha256 query param must be 64 hex chars (of the raw body)' })
          }
          const body = await collectBody(req, MAX_COREDUMP_BYTES)
          if (body.length === 0) return send(res, 400, { error: 'empty coredump body' })
          // 完整性/防伪造：body 的 sha256 必须等于 query 的 sha256（两端对同一数据源计算）
          const actual = crypto.createHash('sha256').update(body).digest('hex')
          if (actual !== sha256) {
            return send(res, 400, { error: 'sha256 mismatch: body does not match the declared sha256' })
          }
          const sizeRaw = url.searchParams.get('size')
          if (sizeRaw !== null && Number(sizeRaw) !== body.length) {
            return send(res, 400, { error: 'size does not match body length' })
          }
          // 落盘：按 sha256 命名 → 同 key 覆盖写同一路径，天然幂等
          fs.mkdirSync(coredumpDir(dataDir), { recursive: true })
          const file = coredumpFile(dataDir, sha256)
          if (!fs.existsSync(file)) {
            const tmp = file + '.tmp'
            fs.writeFileSync(tmp, body)
            fs.renameSync(tmp, file)
          }
          let panicReason = headerText(req, 'x-panic-reason', 2048)
          if (panicReason) {
            try {
              panicReason = decodeURIComponent(panicReason)
            } catch {
              /* 设备端非 urlencode 时保留原样 */
            }
          }
          const record = {
            id: newCoredumpId(),
            deviceId,
            sha256,
            size: body.length,
            firmwareVersion: url.searchParams.get('fw')?.slice(0, 128) || null,
            panicReason: panicReason?.slice(0, 2048) || null,
            excTask: headerText(req, 'x-exc-task', 128),
            excPc: headerText(req, 'x-exc-pc', 32),
            appElfSha256: headerText(req, 'x-app-elf-sha256', 64)?.toLowerCase() || null,
            chip: headerText(req, 'x-chip', 32),
            sdkVersion: headerText(req, 'x-sdk-version', 64),
            receivedAt: new Date().toISOString(),
          }
          const result = receiveCoredump(readCoredumpStore(dataDir), record)
          if (!result.duplicate) {
            // retention 淘汰的旧记录：删掉它的 dump 文件（元数据随 store 一起原子写）
            for (const d of result.removed) {
              try {
                fs.rmSync(coredumpFile(dataDir, d.sha256), { force: true })
              } catch {
                /* 文件本就不存在则忽略 */
              }
            }
            writeCoredumpStoreAtomic(dataDir, result.store)
          }
          return send(res, 200, { ok: true, id: result.record.id, duplicate: result.duplicate })
        }

        // 全局 coredump 列表（公开只读，页面首页数据源）
        if (req.method === 'GET' && p === '/api/coredumps') {
          return send(res, 200, {
            _meta: {
              service: 'firmware-server',
              docs: '/docs/coredump.md',
              maxPerDevice: MAX_COREDUMPS_PER_DEVICE,
            },
            coredumps: listCoredumpViews(readCoredumpStore(dataDir), baseUrlOf(req)),
          })
        }

        // 单设备 coredump 列表（公开只读）
        const devCdsM = /^\/api\/devices\/([^/]+)\/coredumps$/.exec(p)
        if (req.method === 'GET' && devCdsM) {
          const deviceId = devCdsM[1]
          if (!DEVICE_ID_RE.test(deviceId)) {
            return send(res, 400, { error: 'deviceId must be 12 lowercase hex chars (base MAC)' })
          }
          return send(res, 200, {
            deviceId,
            coredumps: listCoredumpsForDevice(readCoredumpStore(dataDir), deviceId, baseUrlOf(req)),
          })
        }

        // 单条详情 / 下载原始 dump（公开只读）
        const cdOneM = /^\/api\/coredumps\/([^/]+)(\/download)?$/.exec(p)
        if (req.method === 'GET' && cdOneM) {
          const id = cdOneM[1]
          const download = cdOneM[2] === '/download'
          if (!COREDUMP_ID_RE.test(id)) return send(res, 400, { error: 'bad coredump id' })
          const rec = coredumpById(readCoredumpStore(dataDir), id)
          if (!rec) return send(res, 404, { error: 'coredump not found', id })
          if (!download) return send(res, 200, { coredump: coredumpSummary(rec, baseUrlOf(req)) })
          const file = coredumpFile(dataDir, rec.sha256)
          if (!fs.existsSync(file)) return send(res, 404, { error: 'dump file missing on server', id })
          const data = fs.readFileSync(file)
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(data.length),
            'Content-Disposition': `attachment; filename="${rec.id}.bin"`,
            'Cache-Control': 'no-cache',
          })
          return res.end(data)
        }

        // ---- 云盘（docs/cloud-drive.md §4–§5；写需 Bearer，读公开）----
        // 上传：multipart（file + 可选 note）或 raw body + X-Filename 头
        if (req.method === 'POST' && p === '/api/drive/files') {
          if (!authOk(req)) return send(res, 401, { error: 'unauthorized' })
          const body = await collectBody(req, MAX_DRIVE_FILE_BYTES + 1024 * 1024)
          const ctype = String(req.headers['content-type'] ?? '')
          let name
          let note = null
          let data
          if (ctype.includes('multipart/form-data')) {
            const parsed = parseMultipart(body, ctype)
            const file = parsed.files.find((f) => f.field === 'file') ?? parsed.files[0]
            if (!file) return send(res, 400, { error: 'file field required' })
            data = file.data
            name = file.filename || parsed.fields.get('name') || ''
            note = parsed.fields.get('note') || null
          } else {
            name = headerText(req, 'x-filename', 200)
            if (!name) {
              return send(res, 400, { error: 'X-Filename header required (or send multipart with a file field)' })
            }
            note = headerText(req, 'x-note', 500)
            data = body
          }
          if (!data || data.length === 0) return send(res, 400, { error: 'empty file body' })
          if (data.length > MAX_DRIVE_FILE_BYTES) {
            return send(res, 413, { error: `file exceeds ${MAX_DRIVE_FILE_BYTES} bytes` })
          }
          const store = readDriveStore(dataDir)
          if (totalDriveBytes(store) + data.length > MAX_DRIVE_TOTAL_BYTES) {
            return send(res, 413, { error: 'drive quota exceeded' })
          }
          const fileId = newFileId()
          const filePath = driveFilePath(dataDir, fileId)
          fs.mkdirSync(path.dirname(filePath), { recursive: true })
          const tmp = filePath + '.tmp'
          fs.writeFileSync(tmp, data)
          fs.renameSync(tmp, filePath)
          const record = {
            fileId,
            name: sanitizeName(name),
            size: data.length,
            note: note ? note.slice(0, 500) : null,
            createdAt: new Date().toISOString(),
          }
          writeDriveStoreAtomic(dataDir, addDriveFile(store, record))
          return send(res, 200, { file: driveFileView(record, baseUrlOf(req)) })
        }

        // 列表（公开只读）
        if (req.method === 'GET' && p === '/api/drive/files') {
          const store = readDriveStore(dataDir)
          return send(res, 200, {
            _meta: {
              service: 'firmware-server',
              docs: '/docs/cloud-drive.md',
              maxFileBytes: MAX_DRIVE_FILE_BYTES,
              maxTotalBytes: MAX_DRIVE_TOTAL_BYTES,
              totalBytes: totalDriveBytes(store),
            },
            files: listDriveViews(store, baseUrlOf(req)),
          })
        }

        // 单文件：?meta=1 返回元数据，否则下载原始字节
        const driveOneM = /^\/api\/drive\/files\/([^/]+)$/.exec(p)
        if (req.method === 'GET' && driveOneM) {
          const fileId = driveOneM[1]
          if (!DRIVE_FILE_ID_RE.test(fileId)) return send(res, 400, { error: 'bad fileId' })
          const rec = driveFileById(readDriveStore(dataDir), fileId)
          if (!rec) return send(res, 404, { error: 'file not found', fileId })
          if (url.searchParams.get('meta') === '1') {
            return send(res, 200, { file: driveFileView(rec, baseUrlOf(req)) })
          }
          const filePath = driveFilePath(dataDir, fileId)
          if (!fs.existsSync(filePath)) return send(res, 404, { error: 'file missing on server', fileId })
          const data = fs.readFileSync(filePath)
          const ext = path.extname(rec.name).toLowerCase()
          res.writeHead(200, {
            'Content-Type': MIME[ext] ?? 'application/octet-stream',
            'Content-Length': String(data.length),
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(rec.name)}`,
            'Cache-Control': 'no-cache',
          })
          return res.end(data)
        }

        // 删除（Bearer；幂等——重复删除也 200，removed 区分是否真删了东西）
        if (req.method === 'DELETE' && driveOneM) {
          if (!authOk(req)) return send(res, 401, { error: 'unauthorized' })
          const fileId = driveOneM[1]
          if (!DRIVE_FILE_ID_RE.test(fileId)) return send(res, 400, { error: 'bad fileId' })
          const removed = removeDriveFile(readDriveStore(dataDir), fileId)
          if (!removed.removed) return send(res, 200, { ok: true, removed: false })
          writeDriveStoreAtomic(dataDir, removed.store)
          fs.rmSync(driveFilePath(dataDir, fileId), { force: true })
          return send(res, 200, { ok: true, removed: true })
        }

        if (req.method === 'GET' && p.startsWith('/api/registry/projects/')) {
          return servePart(dataDir, p, res)
        }
        if (req.method === 'GET' && p.startsWith('/api/')) {
          return send(res, 404, { error: 'unknown api' })
        }
        // 静态文件托管（fetch 命令的 URL 源）：GET /files/<path> ← data/files/（只读，防穿越）
        const hostedFileM = /^\/files(\/(.*))?$/.exec(p)
        if (req.method === 'GET' && hostedFileM) {
          return serveHostedFile(dataDir, hostedFileM[2] ?? '', res)
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
