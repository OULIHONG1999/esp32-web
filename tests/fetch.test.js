import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  FETCH_DEFAULT_MAX_BYTES,
  FETCH_MAX_BYTES,
  buildFetchCommand,
  commandForDevice,
  commandSummary,
  readDeviceStore,
  writeDeviceStoreAtomic,
} from '../server/devices.js'
import { createApp } from '../server/app.js'

const TOKEN = 'test-token'
const DEV = '3485a1b2c3d4'
const DEV2 = '7c9ebd112233'
const URL_OK = 'http://175.178.156.231/files/vanim/robot.json'

let dataDir
let server
let base

async function report(deviceId, body) {
  const res = await fetch(`${base}/api/devices/${deviceId}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? { chip: 'ESP32-S3', firmwareVersion: 'v0.6.0' }),
  })
  return { status: res.status, json: await res.json() }
}

async function dispatch(deviceId, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? TOKEN}`
  const res = await fetch(`${base}/api/devices/${deviceId}/commands`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? { type: 'fetch', url: URL_OK, dest: '/fs/robot.json' }),
  })
  return { status: res.status, json: await res.json() }
}

async function result(deviceId, commandId, body) {
  const res = await fetch(`${base}/api/devices/${deviceId}/commands/${commandId}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

function makeStale(deviceId, at = '2020-01-01T00:00:00Z') {
  const store = readDeviceStore(dataDir)
  store.devices[deviceId].lastSeen = at
  writeDeviceStoreAtomic(dataDir, store)
}

function putHostedFile(rel, content) {
  const abs = path.join(dataDir, 'files', rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

/** 原始 GET（绕过 fetch 的 URL 归一化）：穿越防护要挡的是"原始 socket 发来的 %2e%2e" */
function rawGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path: pathname, method: 'GET' },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-fetch-test-'))
  server = http.createServer(createApp({ dataDir, token: TOKEN, distDir: path.join(dataDir, 'no-dist') }))
  await new Promise((r) => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => {
  server.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// ---------- 存储层纯函数 ----------

describe('buildFetchCommand（fetch 命令校验与构建）', () => {
  it('合法载荷 → 六字段命令，maxBytes 缺省 262144', () => {
    const r = buildFetchCommand({ url: URL_OK, dest: '/fs/vanim/robot.json' }, '2026-10-16T08:00:00Z')
    expect(r.error).toBeUndefined()
    expect(r.command.type).toBe('fetch')
    expect(r.command.url).toBe(URL_OK)
    expect(r.command.dest).toBe('/fs/vanim/robot.json')
    expect(r.command.maxBytes).toBe(FETCH_DEFAULT_MAX_BYTES)
    expect(r.command.state).toBe('pending')
    expect(r.command.createdAt).toBe('2026-10-16T08:00:00Z')
    expect(r.command.id).toMatch(/^cmd_[0-9a-f]{4,16}$/)
  })

  it('url：非 string / 非 http:// / 超长 → bad url', () => {
    expect(buildFetchCommand({ url: 123, dest: '/fs/a.json' }).error).toBe('bad url')
    expect(buildFetchCommand({ url: 'https://h/a.json', dest: '/fs/a.json' }).error).toBe('bad url')
    expect(buildFetchCommand({ url: 'http://' + 'h'.repeat(300) + '/a', dest: '/fs/a.json' }).error).toBe('bad url')
    expect(buildFetchCommand({ dest: '/fs/a.json' }).error).toBe('bad url')
  })

  it('dest：非白名单前缀 → 前缀错误；含 .. / 非 ASCII / 超长 → 路径错误', () => {
    expect(buildFetchCommand({ url: URL_OK, dest: '/nvs/x' }).error).toBe(
      'bad dest: must start with /fs/ or /sdcard/',
    )
    expect(buildFetchCommand({ url: URL_OK, dest: 'fs/x' }).error).toBe(
      'bad dest: must start with /fs/ or /sdcard/',
    )
    expect(buildFetchCommand({ url: URL_OK, dest: '/etc/passwd' }).error).toBe(
      'bad dest: must start with /fs/ or /sdcard/',
    )
    expect(buildFetchCommand({ url: URL_OK, dest: '/fs/../etc' }).error).toBe('bad dest: illegal path')
    expect(buildFetchCommand({ url: URL_OK, dest: '/fs/中文.json' }).error).toBe('bad dest: illegal path')
    expect(buildFetchCommand({ url: URL_OK, dest: '/fs/' + 'a'.repeat(200) }).error).toBe('bad dest: illegal path')
  })

  it('maxBytes：越界钳位到边界而非报错；非数字 → bad maxBytes', () => {
    expect(buildFetchCommand({ url: URL_OK, dest: '/fs/a', maxBytes: 0 }).command.maxBytes).toBe(1)
    expect(buildFetchCommand({ url: URL_OK, dest: '/fs/a', maxBytes: -5 }).command.maxBytes).toBe(1)
    expect(buildFetchCommand({ url: URL_OK, dest: '/fs/a', maxBytes: 99999999 }).command.maxBytes).toBe(FETCH_MAX_BYTES)
    expect(buildFetchCommand({ url: URL_OK, dest: '/fs/a', maxBytes: 'x' }).error).toBe('bad maxBytes')
    expect(buildFetchCommand({ url: URL_OK, dest: '/fs/a', maxBytes: Number.NaN }).error).toBe('bad maxBytes')
  })

  it('/sdcard/ 前缀同样合法', () => {
    const r = buildFetchCommand({ url: URL_OK, dest: '/sdcard/robot.json' })
    expect(r.error).toBeUndefined()
    expect(r.command.dest).toBe('/sdcard/robot.json')
  })
})

describe('commandForDevice / commandSummary（fetch 信封与摘要）', () => {
  it('fetch 信封只六个字段，无 urlAbsolute / releaseId', () => {
    const c = {
      id: 'cmd_abcd1234',
      type: 'fetch',
      url: URL_OK,
      dest: '/fs/vanim/robot.json',
      maxBytes: 262144,
      createdAt: '2026-10-16T08:00:00Z',
    }
    const body = commandForDevice(c, 'http://h:80')
    expect(body).toEqual({
      id: 'cmd_abcd1234',
      type: 'fetch',
      url: URL_OK,
      dest: '/fs/vanim/robot.json',
      maxBytes: 262144,
      createdAt: '2026-10-16T08:00:00Z',
    })
    expect(body.urlAbsolute).toBeUndefined()
    expect(body.releaseId).toBeUndefined()
  })

  it('ota 信封保持原样（含 urlAbsolute）', () => {
    const ota = { id: 'cmd_x', type: 'ota', releaseId: 'r', file: 'a.bin', url: '/x', sha256: 's', size: 1, createdAt: 't' }
    const body = commandForDevice(ota, 'http://h:80')
    expect(body.releaseId).toBe('r')
    expect(body.urlAbsolute).toBe('http://h:80/x')
  })

  it('fetch 摘要含 url/dest/maxBytes、不含 releaseId；ota 摘要含 releaseId', () => {
    const f = commandSummary({
      id: 'cmd_1',
      type: 'fetch',
      url: URL_OK,
      dest: '/fs/a.json',
      maxBytes: 100,
      state: 'pending',
      createdAt: 't',
    })
    expect(f.url).toBe(URL_OK)
    expect(f.dest).toBe('/fs/a.json')
    expect(f.maxBytes).toBe(100)
    expect(f.releaseId).toBeUndefined()
    const o = commandSummary({ id: 'cmd_2', type: 'ota', releaseId: 'r', state: 'pending', createdAt: 't' })
    expect(o.releaseId).toBe('r')
    expect(o.url).toBeUndefined()
  })
})

// ---------- HTTP 端点 ----------

describe('POST /api/devices/:id/commands（fetch 下发）', () => {
  it('无 token → 401', async () => {
    expect((await dispatch(DEV, undefined, { token: null })).status).toBe(401)
  })

  it('合法 fetch → pending；设备上报拿到六字段信封；回执 success', async () => {
    await report(DEV, { chip: 'ESP32-S3' })
    const r = await dispatch(DEV, { type: 'fetch', url: URL_OK, dest: '/fs/vanim/robot.json' })
    expect(r.status).toBe(200)
    expect(r.json.command.state).toBe('pending')
    expect(r.json.command.type).toBe('fetch')
    expect(r.json.command.dest).toBe('/fs/vanim/robot.json')
    expect(r.json.command.maxBytes).toBe(FETCH_DEFAULT_MAX_BYTES)

    const next = await report(DEV)
    expect(next.json.command).toEqual(
      expect.objectContaining({
        type: 'fetch',
        url: URL_OK,
        dest: '/fs/vanim/robot.json',
        maxBytes: FETCH_DEFAULT_MAX_BYTES,
      }),
    )
    expect(next.json.command.urlAbsolute).toBeUndefined()
    expect(next.json.command.releaseId).toBeUndefined()

    const res = await result(DEV, next.json.command.id, { state: 'success', detail: 'wrote 11234 bytes to /fs/vanim/robot.json' })
    expect(res.status).toBe(200)
    expect(res.json.command.state).toBe('success')
    expect(res.json.command.detail).toBe('wrote 11234 bytes to /fs/vanim/robot.json')
  })

  it('服务端校验：dest 越界 / url https / 未知 type → 400', async () => {
    expect((await dispatch(DEV, { type: 'fetch', url: URL_OK, dest: '/nvs/x' })).status).toBe(400)
    expect((await dispatch(DEV, { type: 'fetch', url: 'https://h/a', dest: '/fs/a' })).status).toBe(400)
    expect((await dispatch(DEV, { type: 'reboot' })).status).toBe(400)
  })

  it('maxBytes 越界在存储时钳位到上限', async () => {
    await report(DEV, { chip: 'ESP32-S3' })
    const r = await dispatch(DEV, { type: 'fetch', url: URL_OK, dest: '/fs/a', maxBytes: 99999999, force: true })
    expect(r.status).toBe(200)
    expect(r.json.command.maxBytes).toBe(FETCH_MAX_BYTES)
    // 清理未决位，避免影响别的用例
    const cur = await report(DEV)
    await result(DEV, cur.json.command.id, { state: 'success', detail: 'cleanup' })
  })

  it('已有未决命令 → 409（fetch 与 ota 共用未决位）', async () => {
    await report(DEV, { chip: 'ESP32-S3' })
    await dispatch(DEV, { type: 'fetch', url: URL_OK, dest: '/fs/a.json' })
    const blocked = await dispatch(DEV, { type: 'fetch', url: URL_OK, dest: '/fs/b.json' })
    expect(blocked.status).toBe(409)
    expect(blocked.json.command.state).toBe('pending')
    // 清理
    const cur = await report(DEV)
    await result(DEV, cur.json.command.id, { state: 'failed', detail: 'cleanup' })
  })

  it('设备离线 → 412，不排队，只留 cancelled 记录', async () => {
    await report(DEV2, { chip: 'ESP32-S3' })
    makeStale(DEV2)
    const r = await dispatch(DEV2, { type: 'fetch', url: URL_OK, dest: '/fs/a.json' })
    expect(r.status).toBe(412)
    expect(r.json.error).toBe('device offline')
    expect(r.json.cancelled.state).toBe('cancelled')
    expect(r.json.cancelled.type).toBe('fetch')
    const store = readDeviceStore(dataDir)
    expect(store.devices[DEV2].commands.some((c) => c.state === 'pending')).toBe(false)
  })
})

describe('GET /files/（静态托管：fetch 命令的 URL 源）', () => {
  it('读文件 + Content-Type 按扩展名', async () => {
    putHostedFile('vanim/robot.json', '{"frames":1}')
    const res = await fetch(`${base}/files/vanim/robot.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.text()).toBe('{"frames":1}')
  })

  it('未知扩展名 → octet-stream；不存在的文件 → 404', async () => {
    putHostedFile('blob.dat', 'xx')
    const res = await fetch(`${base}/files/blob.dat`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect((await fetch(`${base}/files/nope.json`)).status).toBe(404)
  })

  it('目录 / 空路径 → 404（只服务文件，不列目录）', async () => {
    expect((await fetch(`${base}/files/vanim`)).status).toBe(404)
    expect((await fetch(`${base}/files/`)).status).toBe(404)
  })

  it('路径穿越：%2f 编码斜杠（..%2f → ../）被应用层挡住 → 400', async () => {
    const res = await rawGet('/files/..%2fregistry.json')
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error).toBe('bad path')
  })

  it('%2e%2e 与字面 ../ 在 URL 层就被归一化掉，进不了 /files/ 路由', async () => {
    // new URL 按 WHATWG 把 %2e%2e 也当 dot-segment 处理 → pathname 变成 /registry.json
    expect((await rawGet('/files/%2e%2e/registry.json')).status).toBe(404)
    expect((await rawGet('/files/../registry.json')).status).toBe(404)
  })
})
