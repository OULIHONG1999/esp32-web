import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  MAX_COREDUMPS_PER_DEVICE,
  coredumpById,
  emptyCoredumpStore,
  listCoredumpViews,
  listCoredumpsForDevice,
  readCoredumpStore,
  receiveCoredump,
} from '../server/coredumps.js'
import { createApp } from '../server/app.js'

const TOKEN = 'test-token'
const DEV = '3485a1b2c3d4'
const DEV2 = '7c9ebd112233'

let dataDir
let server
let base

function dumpBytes(n = 256, seed = 0) {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i + seed) % 256
  return b
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function makeRecord(over = {}) {
  const body = dumpBytes()
  return {
    id: 'cdump_' + Math.random().toString(16).slice(2, 10),
    deviceId: DEV,
    sha256: sha256(body),
    size: body.length,
    firmwareVersion: 'v0.11.1',
    panicReason: 'Guru Meditation Error: LoadProhibited',
    excTask: 'main',
    excPc: '0x42001234',
    appElfSha256: 'e'.repeat(64),
    chip: 'ESP32-S3',
    sdkVersion: 'v6.0.1',
    receivedAt: new Date().toISOString(),
    ...over,
  }
}

async function upload(deviceId, body, query, headers) {
  const res = await fetch(`${base}/api/devices/${deviceId}/coredump${query ?? ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...(headers ?? {}) },
    body,
  })
  return { status: res.status, json: await res.json() }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-coredump-test-'))
  server = http.createServer(createApp({ dataDir, token: TOKEN, distDir: path.join(dataDir, 'no-dist') }))
  await new Promise((r) => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => {
  server.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// ---------- 存储层纯函数 ----------

describe('coredumps：接收（幂等 + retention）', () => {
  it('首次接收入库；同 (deviceId, sha256) 再次接收 → duplicate，返回旧 id 不入库', () => {
    const rec = makeRecord()
    let r = receiveCoredump(emptyCoredumpStore(), rec)
    expect(r.duplicate).toBe(false)
    expect(r.store.coredumps).toHaveLength(1)

    const again = receiveCoredump(r.store, { ...makeRecord(), deviceId: rec.deviceId, sha256: rec.sha256 })
    expect(again.duplicate).toBe(true)
    expect(again.record.id).toBe(rec.id) // 返回的是旧记录
    expect(again.store.coredumps).toHaveLength(1) // 不重复入库
  })

  it('不同 sha256 即使同设备也照常入库（排重键含 sha256）', () => {
    let s = emptyCoredumpStore()
    s = receiveCoredump(s, makeRecord({ sha256: 'a'.repeat(64) })).store
    s = receiveCoredump(s, makeRecord({ sha256: 'b'.repeat(64) })).store
    expect(s.coredumps).toHaveLength(2)
  })

  it('retention：每设备超上限淘汰最旧，removed 返回待删记录', () => {
    let s = emptyCoredumpStore()
    let removedTotal = 0
    for (let i = 0; i < MAX_COREDUMPS_PER_DEVICE + 5; i++) {
      const r = receiveCoredump(s, makeRecord({ sha256: i.toString(16).padStart(64, '0'), receivedAt: new Date(2026, 0, 1, 0, 0, i).toISOString() }))
      s = r.store
      removedTotal += r.removed.length
    }
    const mine = s.coredumps.filter((c) => c.deviceId === DEV)
    expect(mine).toHaveLength(MAX_COREDUMPS_PER_DEVICE)
    expect(removedTotal).toBe(5)
    // 淘汰的是最旧的（receivedAt 最小的 5 条）
    expect(s.coredumps.some((c) => c.sha256 === '0'.repeat(64))).toBe(false)
    expect(s.coredumps.some((c) => c.sha256 === (MAX_COREDUMPS_PER_DEVICE + 4).toString(16).padStart(64, '0'))).toBe(true)
  })

  it('retention 只对同设备生效，不误删别设备', () => {
    let s = emptyCoredumpStore()
    for (let i = 0; i < MAX_COREDUMPS_PER_DEVICE + 1; i++) {
      s = receiveCoredump(s, makeRecord({ sha256: i.toString(16).padStart(64, '0') })).store
    }
    const other = receiveCoredump(s, makeRecord({ deviceId: DEV2, sha256: 'f'.repeat(64) }))
    expect(other.removed).toHaveLength(0) // 别设备不受影响
    expect(other.store.coredumps.filter((c) => c.deviceId === DEV2)).toHaveLength(1)
  })

  it('纯函数：不改入参', () => {
    const src = emptyCoredumpStore()
    receiveCoredump(src, makeRecord())
    expect(src.coredumps).toEqual([])
  })
})

describe('coredumps：列表/查询', () => {
  it('listCoredumpViews 新→旧排序，summary 不含二进制字段', () => {
    let s = emptyCoredumpStore()
    s = receiveCoredump(s, makeRecord({ sha256: '1'.repeat(64), receivedAt: '2026-10-06T10:00:00Z' })).store
    s = receiveCoredump(s, makeRecord({ sha256: '2'.repeat(64), receivedAt: '2026-10-06T11:00:00Z' })).store
    const views = listCoredumpViews(s, 'http://h')
    expect(views[0].sha256).toBe('2'.repeat(64))
    expect(views[0].downloadUrl).toBe('http://h/api/coredumps/' + views[0].id + '/download')
    expect(views[0]).not.toHaveProperty('data')
  })

  it('listCoredumpsForDevice 只取指定设备；coredumpById 命中/未命中', () => {
    let s = emptyCoredumpStore()
    const rec = makeRecord({ deviceId: DEV2, sha256: 'a'.repeat(64) })
    s = receiveCoredump(s, rec).store
    expect(listCoredumpsForDevice(s, DEV2)).toHaveLength(1)
    expect(listCoredumpsForDevice(s, DEV)).toHaveLength(0)
    expect(coredumpById(s, rec.id).id).toBe(rec.id)
    expect(coredumpById(s, 'cdump_deadbeef')).toBeNull()
  })
})

// ---------- HTTP 端点 ----------

describe('POST /api/devices/:id/coredump（上报，免鉴权）', () => {
  it('上传成功 → 200 ok，出现在全局列表，dump 落盘', async () => {
    const body = dumpBytes()
    const q = `?sha256=${sha256(body)}&size=${body.length}&fw=v0.11.1`
    const r = await upload(DEV, body, q, { 'X-Exc-Task': 'main', 'X-Chip': 'ESP32-S3' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.duplicate).toBe(false)
    expect(r.json.id).toMatch(/^cdump_/)

    const list = await (await fetch(`${base}/api/coredumps`)).json()
    expect(list.coredumps).toHaveLength(1)
    expect(list.coredumps[0].deviceId).toBe(DEV)
    expect(list.coredumps[0].sha256).toBe(sha256(body))
    expect(list.coredumps[0].firmwareVersion).toBe('v0.11.1')
    expect(list.coredumps[0].excTask).toBe('main')

    const file = path.join(dataDir, 'coredumps', sha256(body) + '.bin')
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file).equals(body)).toBe(true)
  })

  it('sha256 不匹配 → 400；空 body → 400；size 不符 → 400', async () => {
    const body = dumpBytes()
    expect((await upload(DEV, body, `?sha256=${'0'.repeat(64)}`)).status).toBe(400)
    expect((await upload(DEV, Buffer.alloc(0), `?sha256=${sha256(Buffer.alloc(0))}`)).status).toBe(400)
    expect((await upload(DEV, body, `?sha256=${sha256(body)}&size=999`)).status).toBe(400)
  })

  it('非法 deviceId → 400；缺 sha256 → 400', async () => {
    const body = dumpBytes()
    expect((await upload('BADMAC123456', body, `?sha256=${sha256(body)}`)).status).toBe(400)
    expect((await upload(DEV, body, '')).status).toBe(400)
  })

  it('重复上传同 sha256 → duplicate:true，列表不增加', async () => {
    const body = dumpBytes(256, 2)
    const q = `?sha256=${sha256(body)}`
    await upload(DEV, body, q)
    const again = await upload(DEV, body, q)
    expect(again.status).toBe(200)
    expect(again.json.duplicate).toBe(true)
    const list = await (await fetch(`${base}/api/coredumps`)).json()
    expect(list.coredumps.filter((c) => c.sha256 === sha256(body))).toHaveLength(1)
  })

  it('panicReason 走 header（urlencoded），服务器解码入库', async () => {
    const body = dumpBytes(256, 1)
    const reason = encodeURIComponent('Guru Meditation Error: LoadProhibited at 0x4200')
    const r = await upload(DEV, body, `?sha256=${sha256(body)}`, { 'X-Panic-Reason': reason })
    expect(r.status).toBe(200)
    const list = await (await fetch(`${base}/api/coredumps`)).json()
    const rec = list.coredumps.find((c) => c.sha256 === sha256(body))
    expect(rec.panicReason).toBe('Guru Meditation Error: LoadProhibited at 0x4200')
  })
})

describe('GET /api/coredumps 与单设备/详情/下载（公开只读）', () => {
  it('单设备列表过滤正确', async () => {
    const body = dumpBytes(64)
    await upload(DEV, body, `?sha256=${sha256(body)}`)
    const other = dumpBytes(64, 7)
    await upload(DEV2, other, `?sha256=${sha256(other)}`)
    const list = await (await fetch(`${base}/api/devices/${DEV}/coredumps`)).json()
    expect(list.deviceId).toBe(DEV)
    expect(list.coredumps.every((c) => c.deviceId === DEV)).toBe(true)
  })

  it('详情接口返回单条摘要；下载接口返回原始字节', async () => {
    const body = dumpBytes(128)
    await upload(DEV, body, `?sha256=${sha256(body)}`)
    const list = await (await fetch(`${base}/api/coredumps`)).json()
    const rec = list.coredumps.find((c) => c.sha256 === sha256(body))

    const detail = await (await fetch(`${base}/api/coredumps/${rec.id}`)).json()
    expect(detail.coredump.id).toBe(rec.id)
    expect(detail.coredump.sha256).toBe(sha256(body))

    const dl = await fetch(`${base}/api/coredumps/${rec.id}/download`)
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-type')).toBe('application/octet-stream')
    const got = Buffer.from(await dl.arrayBuffer())
    expect(got.equals(body)).toBe(true)
  })

  it('未知 id → 404；坏 id → 400', async () => {
    expect((await fetch(`${base}/api/coredumps/cdump_ffffffff`)).status).toBe(404)
    expect((await fetch(`${base}/api/coredumps/not-an-id`)).status).toBe(400)
  })
})
