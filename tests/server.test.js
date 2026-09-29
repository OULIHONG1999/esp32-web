import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.js'
import { parseMultipart } from '../server/multipart.js'
import { upsertRelease, readRegistry, writeRegistryAtomic, emptyRegistry } from '../server/registry.js'

// ---------- helpers ----------

const TOKEN = 'test-token'
let dataDir
let server
let base

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function makeMeta(parts, opts = {}) {
  return {
    project: { id: 'hello-world', name: 'Hello World', description: 'demo' },
    variant: 'ESP32-S3',
    release: {
      id: '20260927-1200-abcd',
      type: 'snapshot',
      chipFamily: 'ESP32-S3',
      flashParams: { mode: 'dio', freq: '40m', size: '16MB' },
      note: '',
      createdAt: '2026-09-27T12:00:00.000Z',
      parts: parts.map((p) => ({
        label: p.file,
        address: p.address,
        file: p.file,
        size: p.data.length,
        sha256: opts.failHash ? 'f'.repeat(64) : sha(p.data),
      })),
    },
  }
}

async function buildBody(meta, uploads) {
  const fd = new FormData()
  fd.set('meta', JSON.stringify(meta))
  for (const u of uploads) {
    fd.append('file', new Blob([u.data]), u.file) // 同名多文件必须 append（set 会覆盖）
  }
  // Node 的 FormData 无 arrayBuffer()；借 Response 序列化为 multipart 字节
  const asResponse = new Response(fd)
  const body = Buffer.from(await asResponse.arrayBuffer())
  return { body, contentType: asResponse.headers.get('content-type') ?? '' }
}

async function publish(meta, uploads, opts = {}) {
  const { body, contentType } = await buildBody(meta, uploads)
  const headers = { 'Content-Type': contentType }
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? TOKEN}`
  const res = await fetch(`${base}/api/publish`, { method: 'POST', headers, body })
  return { status: res.status, json: await res.json() }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-server-test-'))
  server = http.createServer(
    createApp({ dataDir, token: TOKEN, distDir: path.join(dataDir, 'no-dist') }),
  )
  await new Promise((r) => server.listen(0, r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(() => {
  server.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// ---------- registry 纯函数 ----------

describe('registry（原子读写 + upsert 纯函数）', () => {
  it('空目录读出空结构；写入后读回一致', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-reg-'))
    expect(readRegistry(dir)).toEqual(emptyRegistry())
    const reg = upsertRelease(emptyRegistry(), {
      project: { id: 'p1', name: 'P1' },
      variant: 'ESP32-S3',
      release: { id: 'r1', createdAt: '2026-01-01T00:00:00Z', parts: [] },
    })
    writeRegistryAtomic(dir, reg)
    expect(readRegistry(dir).projects.p1.name).toBe('P1')
    expect(readRegistry(dir).projects.p1.variants['ESP32-S3'].latest).toBe('r1')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('同 id 重复发布替换而非追加；latest 指向新 release', () => {
    let reg = upsertRelease(emptyRegistry(), {
      project: { id: 'p' },
      variant: 'V',
      release: { id: 'r1', createdAt: '2026-01-01T00:00:00Z', parts: [{ file: 'a.bin' }] },
    })
    reg = upsertRelease(reg, {
      project: { id: 'p' },
      variant: 'V',
      release: { id: 'r2', createdAt: '2026-01-02T00:00:00Z', parts: [] },
    })
    reg = upsertRelease(reg, {
      project: { id: 'p' },
      variant: 'V',
      release: { id: 'r1', createdAt: '2026-01-01T00:00:00Z', parts: [{ file: 'a2.bin' }] },
    })
    const v = reg.projects.p.variants.V
    expect(v.releases).toHaveLength(2)
    expect(v.releases.find((r) => r.id === 'r1').parts[0].file).toBe('a2.bin')
    expect(v.latest).toBe('r1')
  })
})

// ---------- multipart ----------

describe('multipart 解析', () => {
  it('meta 字段 + 文件字段完整还原', async () => {
    const { body, contentType } = await buildBody(
      { hello: 'world' },
      [{ file: 'app.bin', data: Uint8Array.from([1, 2, 3, 4]) }],
    )
    const { fields, files } = parseMultipart(body, contentType)
    expect(JSON.parse(fields.get('meta'))).toEqual({ hello: 'world' })
    expect(files).toHaveLength(1)
    expect(files[0].filename).toBe('app.bin')
    expect([...files[0].data]).toEqual([1, 2, 3, 4])
  })

  it('缺 boundary → 抛错', () => {
    expect(() => parseMultipart(Buffer.from('x'), 'text/plain')).toThrow(/boundary/)
  })
})

// ---------- POST /api/publish ----------

describe('POST /api/publish（安全与完整性）', () => {
  const part = { file: 'app.bin', data: Uint8Array.from([9, 9, 9]), address: 0x10000 }

  it('401 无/错误 token', async () => {
    const meta = makeMeta([part])
    expect((await publish(meta, [part], { token: null })).status).toBe(401)
    expect((await publish(meta, [part], { token: 'wrong' })).status).toBe(401)
  })

  it('400 文件名穿越（..、分隔符）被拒', async () => {
    const evil = { file: '..', data: Uint8Array.from([1]), address: 0 }
    const meta = makeMeta([part])
    // meta 中声明非法文件名
    meta.release.parts.push({ label: '..', address: 0, file: '../evil.bin', size: 1, sha256: sha(Uint8Array.from([1])) })
    const r = await publish(meta, [part])
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toMatch(/unsafe/)
    void evil
  })

  it('400 SHA256 不匹配 → 拒收且不落盘', async () => {
    const meta = makeMeta([part], { failHash: true })
    const r = await publish(meta, [part])
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toMatch(/sha256 mismatch/)
    expect(
      fs.existsSync(path.join(dataDir, 'projects', 'hello-world', 'ESP32-S3', '20260927-1200-abcd', 'app.bin')),
    ).toBe(false)
  })

  it('400 未在 meta 声明的文件 → 拒收', async () => {
    const meta = makeMeta([part])
    const r = await publish(meta, [part, { file: 'extra.bin', data: Uint8Array.from([7]) }])
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toMatch(/not declared/)
  })

  it('400 缺文件且服务器也没有 → missing file', async () => {
    const meta = makeMeta([part])
    const r = await publish(meta, []) // 一个文件都不传
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toMatch(/missing file/)
  })

  it('413 parts 声明总量超 256MB → 拒收（不读大文件）', async () => {
    const meta = makeMeta([part])
    meta.release.parts[0].size = 300 * 1024 * 1024
    const r = await publish(meta, [part])
    expect(r.status).toBe(413)
  })
})

// ---------- POST /api/publish（成功链路） ----------

describe('POST /api/publish（成功与幂等补传）', () => {
  const boot = { file: 'bootloader.bin', data: Uint8Array.from([1, 2, 3]), address: 0x0 }
  const appPart = { file: 'app.bin', data: Uint8Array.from([4, 5, 6, 7]), address: 0x10000 }
  const rid = '20260927-1300-beef'

  it('三段式全量发布 → 200，文件落盘、registry 更新、.meta.json 就位', async () => {
    const meta = makeMeta([boot, appPart])
    meta.release.id = rid
    const r = await publish(meta, [boot, appPart])
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    const dir = path.join(dataDir, 'projects', 'hello-world', 'ESP32-S3', rid)
    expect(fs.readFileSync(path.join(dir, 'app.bin'))).toEqual(Buffer.from([4, 5, 6, 7]))
    expect(fs.existsSync(path.join(dir, '.meta.json'))).toBe(true)
    const reg = readRegistry(dataDir)
    const v = reg.projects['hello-world'].variants['ESP32-S3']
    expect(v.latest).toBe(rid)
    expect(v.releases.find((x) => x.id === rid).flashParams.mode).toBe('dio')
  })

  it('幂等补传：重复发布同 release 只传变化文件（服务器已有文件不重传）', async () => {
    // 只上传 app（变了），bootloader 复用服务器已有
    const appChanged = { file: 'app.bin', data: Uint8Array.from([8, 8, 8]), address: 0x10000 }
    const meta = makeMeta([boot, appChanged])
    meta.release.id = rid
    const r = await publish(meta, [appChanged])
    expect(r.status).toBe(200)
    const dir = path.join(dataDir, 'projects', 'hello-world', 'ESP32-S3', rid)
    expect(fs.readFileSync(path.join(dir, 'app.bin'))).toEqual(Buffer.from([8, 8, 8]))
    expect(fs.readFileSync(path.join(dir, 'bootloader.bin'))).toEqual(Buffer.from([1, 2, 3]))
    // registry 中该 release 被替换为新 parts
    const reg = readRegistry(dataDir)
    const rel = reg.projects['hello-world'].variants['ESP32-S3'].releases.find(
      (x) => x.id === rid,
    )
    expect(rel.parts.find((p) => p.file === 'app.bin').sha256).toBe(
      sha(Uint8Array.from([8, 8, 8])),
    )
  })

  it('连续两次发布都成功（锁不残留死锁）', async () => {
    const meta = makeMeta([boot, appPart])
    meta.release.id = '20260927-1400-cafe'
    expect((await publish(meta, [boot, appPart])).status).toBe(200)
    expect((await publish(meta, [boot, appPart])).status).toBe(200)
  })

  it('跨 release 增量（S2）：新 release 只传变化文件，未传的按 sha 从旧 release 复用', async () => {
    const rid2 = '20260927-1600-d00d'
    const appChanged = { file: 'app.bin', data: Uint8Array.from([9, 9, 9, 9]), address: 0x10000 }
    const meta = makeMeta([boot, appChanged]) // boot sha 与 1300-beef 相同
    meta.release.id = rid2
    // 只上传 app；bootloader 不传——服务器应跨 release 按 sha 复用
    const r = await publish(meta, [appChanged])
    expect(r.status).toBe(200)
    const dir = path.join(dataDir, 'projects', 'hello-world', 'ESP32-S3', rid2)
    expect(fs.readFileSync(path.join(dir, 'bootloader.bin'))).toEqual(Buffer.from([1, 2, 3]))
    expect(fs.readFileSync(path.join(dir, 'app.bin'))).toEqual(Buffer.from([9, 9, 9, 9]))
    // registry 两个 release 并存且 latest 指向新的
    const reg = readRegistry(dataDir)
    const v = reg.projects['hello-world'].variants['ESP32-S3']
    expect(v.latest).toBe(rid2)
    expect(v.releases.length).toBeGreaterThanOrEqual(3)
  })
})

// ---------- GET API 与静态托管 ----------

describe('GET /api/registry 与 parts 下载', () => {
  it('registry 200 + ETag + 结构完整', async () => {
    const res = await fetch(`${base}/api/registry`)
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBeTruthy()
    const reg = await res.json()
    expect(Object.keys(reg.projects)).toContain('hello-world')
  })

  it('parts 下载 200 + 字节一致', async () => {
    const res = await fetch(
      `${base}/api/registry/projects/hello-world/variants/ESP32-S3/releases/20260927-1300-beef/parts/bootloader.bin`,
    )
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]))
  })

  it('穿越路径段（..）被 400/404 挡下', async () => {
    const res = await fetch(
      `${base}/api/registry/projects/..%2F..%2F..%2Fetc/variants/x/releases/y/parts/z`,
    )
    expect([400, 404]).toContain(res.status)
  })

  it('未知 /api/* → 404；静态 dist 缺失 → 404 not built', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404)
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/not built/)
  })

  it('GET /api/status：统计与运行时长（公开只读）', async () => {
    const res = await fetch(`${base}/api/status`)
    expect(res.status).toBe(200)
    const s = await res.json()
    expect(s.service).toBe('firmware-server')
    expect(typeof s.projects).toBe('number')
    expect(typeof s.releases).toBe('number')
    expect(typeof s.dataDirBytes).toBe('number')
    expect(s.uptimeSeconds).toBeGreaterThanOrEqual(0)
  })
})

// ---------- S3：SSE 订阅与 ★订阅状态（F-21） ----------

describe('SSE /api/registry/stream 与 publish 广播', () => {
  const part = { file: 'sse.bin', data: Uint8Array.from([3, 3, 3]), address: 0x20000 }

  function withTimeout(p, ms, what) {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms)),
    ])
  }

  it('publish 成功 → 订阅连接收到 event: publish（含 project/variant/release）', async () => {
    const ac = new AbortController()
    try {
      const stream = await fetch(`${base}/api/registry/stream`, { signal: ac.signal })
      expect(stream.status).toBe(200)
      expect(stream.headers.get('content-type')).toContain('text/event-stream')
      const reader = stream.body.getReader()
      const dec = new TextDecoder()
      const hello = dec.decode((await withTimeout(reader.read(), 2000, 'hello')).value)
      expect(hello).toContain('retry')

      const meta = makeMeta([part])
      meta.release.id = '20260927-1800-sse1'
      const r = await publish(meta, [part])
      expect(r.status).toBe(200)

      const chunk = await withTimeout(reader.read(), 3000, 'publish event')
      const text = dec.decode(chunk.value)
      expect(text).toContain('event: publish')
      expect(text).toContain('hello-world')
      expect(text).toContain('ESP32-S3')
      expect(text).toContain('20260927-1800-sse1')
    } finally {
      ac.abort()
    }
  }, 8000)

  it('心跳注释行（测试注入 60ms）防反代空闲断链', async () => {
    const ac = new AbortController()
    try {
      // 独立 hub 实例走不了已建 server——经 app 不便注入；改为对 hub 单元直测
      const { createSseHub } = await import('../server/stream.js')
      const hub = createSseHub({ heartbeatMs: 50 })
      const { PassThrough } = await import('node:stream')
      const res = new PassThrough()
      const req = new PassThrough()
      res.write = res.write.bind(res)
      const chunks = []
      const origWrite = res.write.bind(res)
      res.write = (c) => {
        chunks.push(String(c))
        return origWrite(c)
      }
      // headers：handler 用 writeHead——PassThrough 无此方法，打桩
      res.writeHead = () => res
      hub.handler(req, res)
      await new Promise((r) => setTimeout(r, 140))
      expect(chunks.join('')).toContain(': hb')
      hub.closeAll()
    } finally {
      ac.abort()
    }
  }, 5000)
})

describe('POST /api/registry/projects/:id/subscribe（★订阅状态）', () => {
  it('更新 subscribed 并持久化到 registry', async () => {
    const res = await fetch(`${base}/api/registry/projects/hello-world/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscribed: false }),
    })
    expect(res.status).toBe(200)
    const reg = await (await fetch(`${base}/api/registry`)).json()
    expect(reg.projects['hello-world'].subscribed).toBe(false)

    const up = await fetch(`${base}/api/registry/projects/hello-world/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscribed: true }),
    })
    expect(up.status).toBe(200)
    const reg2 = await (await fetch(`${base}/api/registry`)).json()
    expect(reg2.projects['hello-world'].subscribed).toBe(true)
  })

  it('未知项目 404；非法 body 400', async () => {
    const nf = await fetch(`${base}/api/registry/projects/no-such/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscribed: true }),
    })
    expect(nf.status).toBe(404)
    const bad = await fetch(`${base}/api/registry/projects/hello-world/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscribed: 'yes' }),
    })
    expect(bad.status).toBe(400)
  })
})

// ---------- S4 版本管理（F-20 回滚 / F-24 晋升与 retention） ----------

describe('S4 promote / setLatest / retention', () => {
  // 惰性拼接：describe 收集阶段 base 尚未赋值（beforeAll 未跑）
  const relUrl = (suffix) =>
    `${base}/api/registry/projects/hello-world/variants/ESP32-S3/${suffix}`
  // S4 写操作带 Bearer（FIRMWARE-REGISTRY §8）
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }

  it('promote：snapshot → release（note 必填）；重复晋升 409；无 note 400；不存在 404；无 token 401', async () => {
    const noAuth = await fetch(relUrl('releases/20260927-1800-sse1/promote'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'x' }),
    })
    expect(noAuth.status).toBe(401)

    const ok = await fetch(relUrl('releases/20260927-1800-sse1/promote'), {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ note: '首个正式版（门5 晋升演示）' }),
    })
    expect(ok.status).toBe(200)
    const rel = (await ok.json()).release
    expect(rel.type).toBe('release')
    expect(rel.noteSource).toBe('manual')

    const again = await fetch(relUrl('releases/20260927-1800-sse1/promote'), {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ note: '再来一次' }),
    })
    expect(again.status).toBe(409)

    const noNote = await fetch(relUrl('releases/20260927-1800-sse1/promote'), {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ note: '   ' }),
    })
    expect(noNote.status).toBe(400)

    const missing = await fetch(relUrl('releases/no-such/promote'), {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ note: 'x' }),
    })
    expect(missing.status).toBe(404)
  })

  it('回滚：setLatest 把 latest 指向旧版本（纯指针）', async () => {
    const r = await fetch(relUrl('latest'), {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ releaseId: '20260927-1300-beef' }),
    })
    expect(r.status).toBe(200)
    const reg = await (await fetch(`${base}/api/registry`)).json()
    expect(reg.projects['hello-world'].variants['ESP32-S3'].latest).toBe('20260927-1300-beef')

    const bad = await fetch(relUrl('latest'), {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ releaseId: '../evil' }),
    })
    expect(bad.status).toBe(400)
  })

  it('retention：设置 1 → preview 列将删 → 新发布自动清理最旧 snapshot，release 不删', async () => {
    // 设置策略（不立即删）
    const set = await fetch(`${base}/api/registry/projects/hello-world/retention`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ snapshots: 1 }),
    })
    expect(set.status).toBe(200)

    // 预览将删清单
    const prev = await (await fetch(`${base}/api/registry/projects/hello-world/retention/preview?snapshots=1`)).json()
    expect(prev.snapshots).toBe(1)
    expect(prev.doomed.length).toBeGreaterThanOrEqual(1)

    // 新发布 → 服务端按策略清理
    const part = { file: 'ret.bin', data: Uint8Array.from([7, 7]), address: 0x30000 }
    const meta = makeMeta([part])
    meta.release.id = '20260927-1900-ret1'
    meta.release.createdAt = new Date().toISOString() // 用真实时间，避免与固定时间戳并列导致排序歧义
    const pub = await publish(meta, [part])
    expect(pub.status).toBe(200)
    expect(pub.json.retentionRemoved.length).toBeGreaterThanOrEqual(1)

    const reg = await (await fetch(`${base}/api/registry`)).json()
    const vars = reg.projects['hello-world'].variants['ESP32-S3']
    const snaps = vars.releases.filter((x) => x.type === 'snapshot')
    expect(snaps.length).toBeLessThanOrEqual(1)
    // 发布版（promote 的 sse1）必须还在
    expect(vars.releases.find((x) => x.id === '20260927-1800-sse1').type).toBe('release')
    // 被删 snapshot 的磁盘目录应不存在
    const firstDoomed = prev.doomed.find((d) => d.variant === 'ESP32-S3')
    if (firstDoomed) {
      const exists = await fetch(
        `${base}/api/registry/projects/hello-world/variants/ESP32-S3/releases/${firstDoomed.release}/parts/whatever.bin`,
      )
      expect([404, 400]).toContain(exists.status)
    }

    // 恢复 all（避免影响后续手工验收）
    const restore = await fetch(`${base}/api/registry/projects/hello-world/retention`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ snapshots: 'all' }),
    })
    expect(restore.status).toBe(200)
  })

  it('非法 retention 值 400', async () => {
    const bad = await fetch(`${base}/api/registry/projects/hello-world/retention`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ snapshots: -5 }),
    })
    expect(bad.status).toBe(400)
  })
})

// ---------- 动态工作 token（页面手动生成 → 交给发布端/AI） ----------

describe('POST/GET/DELETE /api/token（仅主 token 可管理）', () => {
  const masterH = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }

  it('非主 token / 无 token → 401', async () => {
    expect((await fetch(`${base}/api/token`)).status).toBe(401)
    const wrong = await fetch(`${base}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wk_wrong' },
      body: '{}',
    })
    expect(wrong.status).toBe(401)
  })

  it('主 token 生成 → wk_ 前缀 → 可用于写接口（promote）→ 列表可见 → 撤销后失效', async () => {
    const created = await fetch(`${base}/api/token`, {
      method: 'POST',
      headers: masterH,
      body: JSON.stringify({ note: '门5 工作token' }),
    })
    expect(created.status).toBe(200)
    const entry = (await created.json()).token
    expect(entry.token).toMatch(/^wk_[0-9a-f]{48}$/)
    expect(entry.note).toBe('门5 工作token')

    // 工作 token 应能通过写接口鉴权（先撤销一个已晋升目标：用未晋升的 ret1）
    const useWk = await fetch(
      `${base}/api/registry/projects/hello-world/variants/ESP32-S3/releases/20260927-1900-ret1/promote`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.token}` },
        body: JSON.stringify({ note: '工作 token 晋升演示' }),
      },
    )
    expect(useWk.status).toBe(200)

    const list = await (await fetch(`${base}/api/token`, { headers: masterH })).json()
    expect(list.tokens.some((t) => t.token === entry.token)).toBe(true)

    const del = await fetch(`${base}/api/token`, {
      method: 'DELETE',
      headers: masterH,
      body: JSON.stringify({ token: entry.token }),
    })
    expect(del.status).toBe(200)

    const afterRevoke = await fetch(
      `${base}/api/registry/projects/hello-world/variants/ESP32-S3/latest`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.token}` },
        body: JSON.stringify({ releaseId: '20260927-1900-ret1' }),
      },
    )
    expect(afterRevoke.status).toBe(401)
  })
})
