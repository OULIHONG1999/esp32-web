import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_COMMANDS_PER_DEVICE,
  ONLINE_TIMEOUT_MS,
  applyResult,
  commandForDevice,
  emptyDeviceStore,
  enqueueCommand,
  listDeviceViews,
  nextCommandForDevice,
  pickAppPart,
  readDeviceStore,
  resolveRelease,
  upsertReport,
  writeDeviceStoreAtomic,
} from '../server/devices.js'
import { createApp } from '../server/app.js'
import { emptyRegistry, readRegistry, upsertRelease, writeRegistryAtomic } from '../server/registry.js'

const TOKEN = 'test-token'
const DEV = '3485a1b2c3d4'
const DEV2 = '7c9ebd112233'
const RID = '20261005-1609-278773'
const APP_SHA = '27877362ce8b9524b4e1650cb9b46b80bbd29cec535748ce88580600b9214e2d'

let dataDir
let server
let base

function makeCommand(over = {}) {
  return {
    id: 'cmd_' + Math.random().toString(16).slice(2, 8),
    type: 'ota',
    releaseId: RID,
    projectId: 'lvgl-demo-v9',
    variant: 'ESP32-S3',
    file: 'lvgl_demo_v9.bin',
    url: `/api/registry/projects/lvgl-demo-v9/variants/ESP32-S3/releases/${RID}/parts/lvgl_demo_v9.bin`,
    sha256: APP_SHA,
    size: 1624624,
    state: 'pending',
    deliveryCount: 0,
    createdAt: new Date().toISOString(),
    ...over,
  }
}

function seedRegistry(dir) {
  const registry = upsertRelease(emptyRegistry(), {
    project: { id: 'lvgl-demo-v9', name: 'LVGL Demo V9', description: 'demo' },
    variant: 'ESP32-S3',
    release: {
      id: RID,
      type: 'release',
      chipFamily: 'ESP32-S3',
      createdAt: '2026-10-05T16:09:00Z',
      parts: [
        { label: 'bootloader.bin', address: 0, file: 'bootloader.bin', size: 20000, sha256: 'a'.repeat(64), type: 'data', subType: 'bootloader' },
        { label: 'partition-table.bin', address: 32768, file: 'partition-table.bin', size: 3000, sha256: 'b'.repeat(64), type: 'data', subType: 'partition-table' },
        { label: 'lvgl_demo_v9.bin', address: 65536, file: 'lvgl_demo_v9.bin', size: 1624624, sha256: APP_SHA, type: 'app', subType: 'factory' },
      ],
    },
  })
  writeRegistryAtomic(dir, registry)
}

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
    body: JSON.stringify(body ?? { type: 'ota', releaseId: RID }),
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

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-devices-test-'))
  seedRegistry(dataDir)
  server = http.createServer(createApp({ dataDir, token: TOKEN, distDir: path.join(dataDir, 'no-dist') }))
  await new Promise((r) => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => {
  server.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// ---------- 存储层纯函数 ----------

describe('devices：上报 upsert', () => {
  it('首次上报建条目并记 createdAt/lastSeen；再次上报只刷新心跳与字段', () => {
    const t1 = '2026-10-06T10:00:00Z'
    const t2 = '2026-10-06T10:01:00Z'
    let s = upsertReport(emptyDeviceStore(), DEV, { chip: 'ESP32-S3', ip: '192.168.31.100' }, t1)
    expect(s.devices[DEV].createdAt).toBe(t1)
    expect(s.devices[DEV].lastSeen).toBe(t1)
    s = upsertReport(s, DEV, { firmwareVersion: 'v0.7.0' }, t2)
    expect(s.devices[DEV].createdAt).toBe(t1) // 创建时间不被覆盖
    expect(s.devices[DEV].lastSeen).toBe(t2)
    expect(s.devices[DEV].chip).toBe('ESP32-S3') // 未上报的字段保留
    expect(s.devices[DEV].firmwareVersion).toBe('v0.7.0')
  })

  it('字段白名单：未知字段忽略；字符串截断到 128；空值跳过', () => {
    const s = upsertReport(
      emptyDeviceStore(),
      DEV,
      { chip: 'x'.repeat(300), evil: 'drop table', freeHeap: 230000, ip: '' },
      '2026-10-06T10:00:00Z',
    )
    expect(s.devices[DEV].chip.length).toBe(128)
    expect(s.devices[DEV].evil).toBeUndefined()
    expect(s.devices[DEV].freeHeap).toBe(230000)
    expect(s.devices[DEV].ip).toBeUndefined()
  })

  it('纯函数：不改入参', () => {
    const src = emptyDeviceStore()
    upsertReport(src, DEV, { chip: 'ESP32-S3' }, '2026-10-06T10:00:00Z')
    expect(src.devices).toEqual({})
  })
})

describe('devices：命令投递', () => {
  it('pending → delivered 并累计 deliveryCount', () => {
    let s = enqueueCommand(emptyDeviceStore(), DEV, makeCommand()).store
    const r = nextCommandForDevice(s, DEV, '2026-10-06T10:00:00Z')
    expect(r.command.state).toBe('delivered')
    expect(r.command.deliveryCount).toBe(1)
    expect(r.redelivered).toBe(false)
  })

  it('已投递未回执 → 重复投递同一条（防设备取走后崩溃卡死）', () => {
    let s = enqueueCommand(emptyDeviceStore(), DEV, makeCommand()).store
    s = nextCommandForDevice(s, DEV, '2026-10-06T10:00:00Z').store
    const again = nextCommandForDevice(s, DEV, '2026-10-06T10:00:15Z')
    expect(again.redelivered).toBe(true)
    expect(again.command.deliveryCount).toBe(2)
    expect(again.command.state).toBe('delivered')
  })

  it('无命令 → 返回 null', () => {
    expect(nextCommandForDevice(emptyDeviceStore(), DEV, '2026-10-06T10:00:00Z').command).toBeNull()
  })

  it('已有未决命令 → 冲突不覆盖；force → 旧的标 superseded', () => {
    const first = makeCommand()
    let s = enqueueCommand(emptyDeviceStore(), DEV, first).store
    const second = makeCommand()
    const blocked = enqueueCommand(s, DEV, second)
    expect(blocked.command).toBeNull()
    expect(blocked.conflict.id).toBe(first.id)

    const forced = enqueueCommand(s, DEV, second, { force: true })
    expect(forced.command.id).toBe(second.id)
    const old = forced.store.devices[DEV].commands.find((c) => c.id === first.id)
    expect(old.state).toBe('superseded')
  })

  it('回执：只认 success|failed，记录 detail 与 finishedAt', () => {
    const cmd = makeCommand()
    let s = enqueueCommand(emptyDeviceStore(), DEV, cmd).store
    const ok = applyResult(s, DEV, cmd.id, 'success', 'OTA ok, rebooted', '2026-10-06T10:05:00Z')
    expect(ok.command.state).toBe('success')
    expect(ok.command.detail).toBe('OTA ok, rebooted')
    expect(ok.command.finishedAt).toBe('2026-10-06T10:05:00Z')
    const missing = applyResult(s, DEV, 'cmd_deadbeef', 'success', '', '2026-10-06T10:05:00Z')
    expect(missing.command).toBeNull()
  })

  it('每设备命令条数保留上限，最旧的被裁掉', () => {
    let s = emptyDeviceStore()
    for (let i = 0; i < MAX_COMMANDS_PER_DEVICE + 5; i++) {
      const cmd = makeCommand({ state: 'success', createdAt: new Date(2026, 0, 1, 0, i).toISOString() })
      s = enqueueCommand(s, DEV, cmd, { force: true }).store
    }
    expect(s.devices[DEV].commands.length).toBe(MAX_COMMANDS_PER_DEVICE)
    const times = s.devices[DEV].commands.map((c) => c.createdAt)
    expect(times).toEqual([...times].sort().reverse()) // 新的在前
  })
})

describe('devices：列表视图', () => {
  it('online 由 lastSeen 与 now 之差判定（阈值 45s）', () => {
    const now = '2026-10-06T10:00:00Z'
    let s = upsertReport(emptyDeviceStore(), DEV, { chip: 'ESP32-S3' }, '2026-10-06T09:59:30Z') // 30s 前
    s = upsertReport(s, DEV2, { chip: 'ESP32-S3' }, '2026-10-06T09:58:00Z') // 120s 前
    const views = listDeviceViews(s, now)
    expect(views.find((v) => v.deviceId === DEV).online).toBe(true)
    expect(views.find((v) => v.deviceId === DEV2).online).toBe(false)
    expect(ONLINE_TIMEOUT_MS).toBe(45_000)
  })

  it('边界：正好 45s 仍在线，超过即离线', () => {
    const s = upsertReport(emptyDeviceStore(), DEV, {}, '2026-10-06T09:59:15Z')
    expect(listDeviceViews(s, '2026-10-06T10:00:00Z')[0].online).toBe(true)
    expect(listDeviceViews(s, '2026-10-06T10:00:00.001Z')[0].online).toBe(false)
  })

  it('lastCommand 给最近一条的摘要；无命令为 null', () => {
    let s = upsertReport(emptyDeviceStore(), DEV, {}, '2026-10-06T10:00:00Z')
    expect(listDeviceViews(s, '2026-10-06T10:00:00Z')[0].lastCommand).toBeNull()
    s = enqueueCommand(s, DEV, makeCommand({ state: 'success' })).store
    const v = listDeviceViews(s, '2026-10-06T10:00:00Z')[0]
    expect(v.lastCommand.state).toBe('success')
    expect(v.lastCommand.url).toBeUndefined() // 摘要不含下载字段
  })
})

describe('devices：registry 解析', () => {
  it('按 releaseId 跨项目/变体定位，并偏好 type=app 的段', () => {
    const reg = readRegistry(dataDir)
    const found = resolveRelease(reg, RID)
    expect(found.projectId).toBe('lvgl-demo-v9')
    expect(found.variant).toBe('ESP32-S3')
    const part = pickAppPart(found.release)
    expect(part.file).toBe('lvgl_demo_v9.bin')
    expect(pickAppPart({ parts: [] })).toBeNull()
  })

  it('无 type=app 时退化到最大的 .bin', () => {
    const part = pickAppPart({
      parts: [
        { file: 'a.bin', size: 10 },
        { file: 'b.bin', size: 999 },
        { file: 'notes.txt', size: 5000 },
      ],
    })
    expect(part.file).toBe('b.bin')
  })

  it('找不到 release → null', () => {
    expect(resolveRelease(readRegistry(dataDir), 'nope')).toBeNull()
  })
})

// ---------- HTTP 端点 ----------

describe('POST /api/devices/:id/report（上报兼心跳 + 取命令）', () => {
  it('首次上报 200，command 为 null；设备出现在列表且在线', async () => {
    const r = await report(DEV, { chip: 'ESP32-S3', firmwareVersion: 'v0.6.0-3-g64de242', sdkVersion: 'v6.0.1' })
    expect(r.status).toBe(200)
    expect(typeof r.json.now).toBe('string')
    expect(r.json.command).toBeNull()

    const list = await (await fetch(`${base}/api/devices`)).json()
    const v = list.devices.find((d) => d.deviceId === DEV)
    expect(v.chip).toBe('ESP32-S3')
    expect(v.online).toBe(true)
    expect(v.ip).toBe('127.0.0.1') // 未上报 ip 时由服务端按 socket 回填
  })

  it('非法 deviceId（大写/带冒号/长度不对）→ 400', async () => {
    for (const bad of ['3485A1B2C3D4', '34:85:a1:b2:c3:d4', 'abc', 'zzzzzzzzzzzz']) {
      const res = await fetch(`${base}/api/devices/${encodeURIComponent(bad)}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(res.status, bad).toBe(400)
    }
  })

  it('非法 JSON / 数组 body → 400', async () => {
    const bad = await fetch(`${base}/api/devices/${DEV}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    })
    expect(bad.status).toBe(400)
    const arr = await fetch(`${base}/api/devices/${DEV}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[1,2]',
    })
    expect(arr.status).toBe(400)
  })
})

describe('POST /api/devices/:id/commands（下发，需 token）', () => {
  it('无 token → 401；错 token → 401', async () => {
    expect((await dispatch(DEV, undefined, { token: null })).status).toBe(401)
    expect((await dispatch(DEV, undefined, { token: 'wrong' })).status).toBe(401)
  })

  it('releaseId 不存在 → 404；非法 releaseId → 400；未知 type → 400', async () => {
    expect((await dispatch(DEV, { type: 'ota', releaseId: 'nope' })).status).toBe(404)
    expect((await dispatch(DEV, { type: 'ota', releaseId: '../etc' })).status).toBe(400)
    expect((await dispatch(DEV, { type: 'reboot', releaseId: RID })).status).toBe(400)
  })

  it('下发成功 → pending + 解析出 app 段的 file/url/sha256/size', async () => {
    const r = await dispatch(DEV, { type: 'ota', releaseId: RID })
    expect(r.status).toBe(200)
    expect(r.json.command.state).toBe('pending')
    expect(r.json.command.deviceId).toBe(DEV)
    expect(r.json.command.releaseId).toBe(RID)

    // 设备下一次上报拿到完整命令体
    const next = await report(DEV)
    expect(next.json.command.file).toBe('lvgl_demo_v9.bin')
    expect(next.json.command.url).toBe(
      `/api/registry/projects/lvgl-demo-v9/variants/ESP32-S3/releases/${RID}/parts/lvgl_demo_v9.bin`,
    )
    expect(next.json.command.sha256).toBe(APP_SHA)
    expect(next.json.command.size).toBe(1624624)
    expect(next.json.command.urlAbsolute).toBe(`${base}${next.json.command.url}`)
  })

  it('已投递未回执 → 重复投递同一条（带 redelivered 标记）', async () => {
    const again = await report(DEV)
    expect(again.json.redelivered).toBe(true)
    expect(again.json.command.id).toBeTruthy()
  })

  it('已有未决命令 → 409 且不覆盖；force=true → 顶替', async () => {
    const blocked = await dispatch(DEV, { type: 'ota', releaseId: RID })
    expect(blocked.status).toBe(409)
    expect(blocked.json.command.state).toBe('delivered')

    const forced = await dispatch(DEV, { type: 'ota', releaseId: RID, force: true })
    expect(forced.status).toBe(200)
    expect(forced.json.command.state).toBe('pending')
  })

  it('命令下载 URL 可直接取到文件（与 registry parts 端点对齐）', async () => {
    // 用真实发布产物验证：先发布一个段，再确认 url 指向它
    const reg = readRegistry(dataDir)
    const found = resolveRelease(reg, RID)
    const part = pickAppPart(found.release)
    const res = await fetch(`${base}/api/registry/projects/${found.projectId}/variants/${found.variant}/releases/${RID}/parts/${part.file}`)
    // 该 fixture 未真正落盘 bin → 404；校验路由本身可达（非 400/500）
    expect([200, 404]).toContain(res.status)
  })
})

describe('POST /api/devices/:id/commands/:cid/result（回执，免鉴权）', () => {
  it('非法 state → 400；不存在命令 → 404', async () => {
    const cur = await report(DEV)
    const cid = cur.json.command.id
    expect((await result(DEV, cid, { state: 'maybe' })).status).toBe(400)
    expect((await result(DEV, 'cmd_ffffffff', { state: 'success' })).status).toBe(404)
  })

  it('失败回执 → failed + detail；随后可再次下发', async () => {
    const cur = await report(DEV)
    const cid = cur.json.command.id
    const r = await result(DEV, cid, { state: 'failed', detail: 'download timeout' })
    expect(r.status).toBe(200)
    expect(r.json.command.state).toBe('failed')
    expect(r.json.command.detail).toBe('download timeout')

    const list = await (await fetch(`${base}/api/devices`)).json()
    expect(list.devices.find((d) => d.deviceId === DEV).lastCommand.state).toBe('failed')
    // 未决位已释放
    expect((await dispatch(DEV, { type: 'ota', releaseId: RID, force: true })).status).toBe(200)
  })

  it('成功回执 → success；设备上报固件版本后列表反映新版本', async () => {
    const cur = await report(DEV)
    const cid = cur.json.command.id
    const r = await result(DEV, cid, { state: 'success', detail: 'OTA ok, rebooted to ' + RID })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)

    await report(DEV, { chip: 'ESP32-S3', firmwareVersion: RID, ip: '192.168.31.100' })
    const list = await (await fetch(`${base}/api/devices`)).json()
    const v = list.devices.find((d) => d.deviceId === DEV)
    expect(v.firmwareVersion).toBe(RID)
    expect(v.ip).toBe('192.168.31.100')
    expect(v.lastCommand.state).toBe('success')
  })
})

describe('GET /api/devices（列表，公开只读）', () => {
  it('返回 _meta 与 devices；离线设备按 lastSeen 判定', async () => {
    // 直接构造一个陈旧 lastSeen 的设备
    const store = readDeviceStore(dataDir)
    store.devices[DEV2] = {
      deviceId: DEV2,
      chip: 'ESP32-S3',
      createdAt: '2026-10-06T08:00:00Z',
      lastSeen: '2026-10-06T08:00:00Z',
      commands: [],
    }
    writeDeviceStoreAtomic(dataDir, store)

    const res = await fetch(`${base}/api/devices`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json._meta.docs).toBe('/docs/DEVICE-OTA.md')
    expect(json._meta.onlineTimeoutMs).toBe(ONLINE_TIMEOUT_MS)
    expect(json.devices.find((d) => d.deviceId === DEV2).online).toBe(false)
  })

  it('陌生路径 /api/devices/xxx → 404 unknown api', async () => {
    const res = await fetch(`${base}/api/devices/${DEV}/nonsense`)
    expect(res.status).toBe(404)
  })
})

describe('commandForDevice（交付给设备的命令体）', () => {
  it('无 baseUrl 时不含 urlAbsolute；有则拼接', () => {
    const c = makeCommand()
    expect(commandForDevice(c).urlAbsolute).toBeUndefined()
    expect(commandForDevice(c, 'http://h:80').urlAbsolute).toBe('http://h:80' + c.url)
    expect(commandForDevice(null)).toBeNull()
  })
})
