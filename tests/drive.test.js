import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_DRIVE_FILE_BYTES,
  MAX_DRIVE_TOTAL_BYTES,
  addDriveFile,
  driveFileById,
  emptyDriveStore,
  listDriveViews,
  readDriveStore,
  removeDriveFile,
  sanitizeName,
  totalDriveBytes,
  writeDriveStoreAtomic,
} from '../server/drive.js'
import { createApp } from '../server/app.js'

const TOKEN = 'test-token'

let dataDir
let server
let base

async function uploadRaw(content, filename, opts = {}) {
  const headers = { 'Content-Type': 'application/octet-stream', 'X-Filename': filename }
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? TOKEN}`
  const res = await fetch(`${base}/api/drive/files`, { method: 'POST', headers, body: content })
  return { status: res.status, json: await res.json() }
}

async function uploadMultipart(name, content, note, opts = {}) {
  const fd = new FormData()
  fd.append('file', new Blob([content], { type: 'application/octet-stream' }), name)
  if (note) fd.append('note', note)
  const headers = {}
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? TOKEN}`
  const res = await fetch(`${base}/api/drive/files`, { method: 'POST', headers, body: fd })
  return { status: res.status, json: await res.json() }
}

async function del(fileId, opts = {}) {
  const headers = {}
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? TOKEN}`
  const res = await fetch(`${base}/api/drive/files/${fileId}`, { method: 'DELETE', headers })
  return { status: res.status, json: await res.json() }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-drive-test-'))
  server = http.createServer(createApp({ dataDir, token: TOKEN, distDir: path.join(dataDir, 'no-dist') }))
  await new Promise((r) => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => {
  server.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// ---------- 存储层纯函数 ----------

describe('drive：名称净化与配额', () => {
  it('sanitizeName：中文/空格保留，路径分隔符与 .. 替换，控制字符去除，空名兜底', () => {
    expect(sanitizeName('动画数据.json')).toBe('动画数据.json')
    expect(sanitizeName('a b.json')).toBe('a b.json')
    expect(sanitizeName('../etc/passwd')).toBe('__etc_passwd')
    expect(sanitizeName('a..b')).toBe('a_b')
    expect(sanitizeName('x\u0000y\u001fz')).toBe('xyz')
    expect(sanitizeName('   ')).toBe('unnamed')
    expect(sanitizeName('')).toBe('unnamed')
    expect(sanitizeName(undefined)).toBe('unnamed')
  })

  it('totalDriveBytes：求和；add/remove 后随动', () => {
    const s = emptyDriveStore()
    expect(totalDriveBytes(s)).toBe(0)
    const a = addDriveFile(s, { fileId: 'f_a', name: 'a', size: 10, createdAt: 't1' })
    const b = addDriveFile(a, { fileId: 'f_b', name: 'b', size: 20, createdAt: 't2' })
    expect(totalDriveBytes(b)).toBe(30)
    expect(totalDriveBytes(removeDriveFile(b, 'f_a').store)).toBe(20)
  })
})

describe('drive：记录增删与视图', () => {
  it('addDriveFile 新→旧；driveFileById 命中；removeDriveFile 返回 removed', () => {
    let s = emptyDriveStore()
    s = addDriveFile(s, { fileId: 'f_1', name: 'a', size: 1, createdAt: '2026-10-16T08:00:00Z' })
    s = addDriveFile(s, { fileId: 'f_2', name: 'b', size: 2, createdAt: '2026-10-16T09:00:00Z' })
    expect(s.files.map((f) => f.fileId)).toEqual(['f_2', 'f_1'])
    expect(driveFileById(s, 'f_1').name).toBe('a')
    expect(driveFileById(s, 'f_nope')).toBeNull()

    const r = removeDriveFile(s, 'f_2')
    expect(r.removed.fileId).toBe('f_2')
    expect(r.store.files.map((f) => f.fileId)).toEqual(['f_1'])
    expect(removeDriveFile(s, 'f_nope').removed).toBeNull()
  })

  it('listDriveViews 附 url；原子写读 roundtrip', () => {
    const s = addDriveFile(emptyDriveStore(), { fileId: 'f_1', name: 'a.json', size: 3, note: 'n', createdAt: '2026-10-16T08:00:00Z' })
    writeDriveStoreAtomic(dataDir, s)
    const back = readDriveStore(dataDir)
    expect(back.files).toHaveLength(1)
    const views = listDriveViews(back, 'http://h:80')
    expect(views[0]).toEqual({
      fileId: 'f_1',
      name: 'a.json',
      size: 3,
      note: 'n',
      createdAt: '2026-10-16T08:00:00Z',
      url: 'http://h:80/api/drive/files/f_1',
    })
  })
})

// ---------- HTTP 端点 ----------

describe('POST /api/drive/files（上传）', () => {
  it('无 token → 401；错 token → 401', async () => {
    expect((await uploadRaw('x', 'a.txt', { token: null })).status).toBe(401)
    expect((await uploadRaw('x', 'a.txt', { token: 'wrong' })).status).toBe(401)
  })

  it('multipart 上传 → 200，返回 fileId/name/size/url', async () => {
    const r = await uploadMultipart('robot.json', '{"frames":1}', 'vanim 动画')
    expect(r.status).toBe(200)
    expect(r.json.file.fileId).toMatch(/^f_[0-9a-f]{8}$/)
    expect(r.json.file.name).toBe('robot.json')
    expect(r.json.file.size).toBe('{"frames":1}'.length)
    expect(r.json.file.note).toBe('vanim 动画')
    expect(r.json.file.url).toBe(`${base}/api/drive/files/${r.json.file.fileId}`)
  })

  it('raw body + X-Filename → 200（智能体直传路径）', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const r = await uploadRaw(bytes, 'blob.bin')
    expect(r.status).toBe(200)
    expect(r.json.file.size).toBe(4)
    expect(r.json.file.name).toBe('blob.bin')
  })

  it('缺文件字段 / 缺 X-Filename → 400', async () => {
    // multipart 无 file 字段
    const fd = new FormData()
    fd.append('note', 'no file')
    const res = await fetch(`${base}/api/drive/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd,
    })
    expect(res.status).toBe(400)
    // raw body 无 X-Filename
    expect((await uploadRaw('x', '')).status).toBe(400)
  })

  it('展示名净化：含 ../ 与中文的文件名上传成功且存储名安全', async () => {
    const r = await uploadMultipart('../../动画 数据.json', '{}')
    expect(r.status).toBe(200)
    expect(r.json.file.name).toBe('____动画 数据.json') // ../ → _、/ → _，中文保留
    expect(r.json.file.name).not.toContain('..')
    expect(r.json.file.name).not.toContain('/')
  })

  it('单文件超限 → 413', async () => {
    const big = new Uint8Array(MAX_DRIVE_FILE_BYTES + 1)
    const r = await uploadRaw(big, 'big.bin')
    expect(r.status).toBe(413)
  })
})

describe('GET /api/drive/files（列表）', () => {
  it('返回 _meta 与 files（新→旧），含配额信息', async () => {
    await uploadMultipart('a.json', '{}')
    await uploadMultipart('b.json', '[]')
    const res = await fetch(`${base}/api/drive/files`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json._meta.docs).toBe('/docs/cloud-drive.md')
    expect(json._meta.maxFileBytes).toBe(MAX_DRIVE_FILE_BYTES)
    expect(json._meta.maxTotalBytes).toBe(MAX_DRIVE_TOTAL_BYTES)
    expect(json._meta.totalBytes).toBe(json.files.reduce((n, f) => n + f.size, 0)) // 与列表字节一致
    expect(json.files.length).toBeGreaterThanOrEqual(2)
    expect(json.files[0].name).toBe('b.json') // 新→旧
  })
})

describe('GET /api/drive/files/{fileId}（下载 / 元数据）', () => {
  it('下载字节一致 + Content-Type 按扩展名 + attachment', async () => {
    const up = await uploadMultipart('robot.json', '{"frames":1}')
    const fileId = up.json.file.fileId
    const res = await fetch(`${base}/api/drive/files/${fileId}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(await res.text()).toBe('{"frames":1}')
  })

  it('?meta=1 返回元数据 JSON', async () => {
    const up = await uploadMultipart('x.txt', 'hello')
    const fileId = up.json.file.fileId
    const res = await fetch(`${base}/api/drive/files/${fileId}?meta=1`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.file.fileId).toBe(fileId)
    expect(json.file.name).toBe('x.txt')
  })

  it('非法 fileId → 400；不存在 → 404', async () => {
    expect((await fetch(`${base}/api/drive/files/not-an-id`)).status).toBe(400)
    expect((await fetch(`${base}/api/drive/files/f_deadbeef`)).status).toBe(404)
  })
})

describe('DELETE /api/drive/files/{fileId}（删除）', () => {
  it('无 token → 401；删除 → removed:true；重复删幂等 → removed:false；随后下载 404', async () => {
    const up = await uploadMultipart('gone.txt', 'bye')
    const fileId = up.json.file.fileId
    expect((await del(fileId, { token: null })).status).toBe(401)

    const r1 = await del(fileId)
    expect(r1.status).toBe(200)
    expect(r1.json.removed).toBe(true)

    const r2 = await del(fileId)
    expect(r2.status).toBe(200)
    expect(r2.json.removed).toBe(false)

    expect((await fetch(`${base}/api/drive/files/${fileId}`)).status).toBe(404)
    // 磁盘文件也确实删了
    expect(fs.existsSync(path.join(dataDir, 'drive', fileId))).toBe(false)
  })

  it('非法 fileId → 400', async () => {
    expect((await del('nonsense')).status).toBe(400)
  })
})
