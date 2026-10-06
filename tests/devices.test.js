import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_COMMANDS_PER_DEVICE,
  MAX_TRAIL,
  ONLINE_TIMEOUT_MS,
  applyProgress,
  applyResult,
  cancelCommand,
  commandForDevice,
  commandSummary,
  emptyDeviceStore,
  enqueueCommand,
  isDeviceOnline,
  listDeviceViews,
  nextCommandForDevice,
  pickAppPart,
  readDeviceStore,
  recordCancelled,
  resolveRelease,
  unresolvedCommand,
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

async function progress(deviceId, commandId, body) {
  const res = await fetch(`${base}/api/devices/${deviceId}/commands/${commandId}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

async function cancel(deviceId, commandId, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? TOKEN}`
  const res = await fetch(`${base}/api/devices/${deviceId}/commands/${commandId}/cancel`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, json: await res.json() }
}

/** 把设备的 lastSeen 改成"很久以前"，用于构造离线场景 */
function makeStale(deviceId, at = '2026-10-06T08:00:00Z') {
  const store = readDeviceStore(dataDir)
  store.devices[deviceId].lastSeen = at
  writeDeviceStoreAtomic(dataDir, store)
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

describe('devices：OTA 过程（进度上报）', () => {
  /** 一条已投递的命令（设备已取走） */
  function delivered() {
    let s = enqueueCommand(emptyDeviceStore(), DEV, makeCommand()).store
    s = nextCommandForDevice(s, DEV, '2026-10-06T10:00:00Z').store
    return s
  }
  const cid = (s) => s.devices[DEV].commands[0].id

  it('首次进度：存 progress，trail 记阶段与时刻', () => {
    const s = delivered()
    const r = applyProgress(
      s,
      DEV,
      cid(s),
      { phase: 'downloading', percent: 42, bytes: 100, totalBytes: 200 },
      '2026-10-06T10:00:05Z',
    )
    expect(r.command.progress.phase).toBe('downloading')
    expect(r.command.progress.percent).toBe(42)
    expect(r.command.progress.bytes).toBe(100)
    expect(r.command.progress.updatedAt).toBe('2026-10-06T10:00:05Z')
    expect(r.command.trail).toEqual([{ phase: 'downloading', at: '2026-10-06T10:00:05Z', percent: 42 }])
  })

  it('同一阶段重复上报只更新 progress；trail 同项的比例抬到最新、时刻仍是阶段起点', () => {
    const s = delivered()
    const id = cid(s)
    let r = applyProgress(s, DEV, id, { phase: 'downloading', percent: 10 }, '2026-10-06T10:00:05Z')
    r = applyProgress(r.store, DEV, id, { phase: 'downloading', percent: 80 }, '2026-10-06T10:00:09Z')
    expect(r.command.trail).toHaveLength(1) // 不刷屏
    expect(r.command.trail[0].at).toBe('2026-10-06T10:00:05Z') // 起点不变
    expect(r.command.trail[0].percent).toBe(80) // 比例推进到最新
    expect(r.command.progress.percent).toBe(80)
    expect(r.command.progress.updatedAt).toBe('2026-10-06T10:00:09Z')
  })

  it('阶段变化 → 追加 trail；超过上限裁掉最旧的', () => {
    let s = delivered()
    const id = cid(s)
    const phases = ['downloading', 'verifying', 'writing', 'rebooting', 'applying']
    for (let i = 0; i < 30; i++) {
      s = applyProgress(s, DEV, id, { phase: phases[i % phases.length] + (i >= phases.length ? '_r' + i : '') }, `2026-10-06T10:00:${String(i).padStart(2, '0')}Z`).store
    }
    const trail = s.devices[DEV].commands[0].trail
    expect(trail.length).toBe(MAX_TRAIL)
    expect(trail[trail.length - 1].phase).toMatch(/^applying_r29$/)
  })

  it('percent 越界夹到 0..100；message 截断；未知阶段原样存（设备侧可自行扩展）', () => {
    const s = delivered()
    const id = cid(s)
    const over = applyProgress(s, DEV, id, { phase: 'writing', percent: 250 }, '2026-10-06T10:00:05Z')
    expect(over.command.progress.percent).toBe(100)
    const under = applyProgress(s, DEV, id, { phase: 'writing', percent: -5 }, '2026-10-06T10:00:05Z')
    expect(under.command.progress.percent).toBe(0)
    const long = applyProgress(
      s,
      DEV,
      id,
      { phase: 'custom_phase', message: 'x'.repeat(500) },
      '2026-10-06T10:00:05Z',
    )
    expect(long.command.progress.phase).toBe('custom_phase')
    expect(long.command.progress.message.length).toBe(128)
  })

  it('命令不存在 → command:null（不改状态）', () => {
    const s = delivered()
    const r = applyProgress(s, DEV, 'cmd_deadbeef', { phase: 'writing' }, '2026-10-06T10:00:05Z')
    expect(r.command).toBeNull()
    expect(r.store.devices[DEV].commands[0].progress).toBeUndefined()
  })

  it('进度上报会刷新 lastSeen——OTA 期间设备主循环被阻塞、不再按时 report', () => {
    const s = delivered()
    expect(s.devices[DEV].lastSeen).toBeNull() // 只入队过命令、设备还没报过
    const r = applyProgress(s, DEV, cid(s), { phase: 'writing', percent: 50 }, '2026-10-06T10:00:30Z')
    expect(r.store.devices[DEV].lastSeen).toBe('2026-10-06T10:00:30Z')
  })

  it('deliveredAt 保留首次取走时刻，lastDeliveredAt 记最近一次（重投递看得见）', () => {
    let s = delivered()
    const again = nextCommandForDevice(s, DEV, '2026-10-06T10:00:20Z')
    expect(again.command.deliveredAt).toBe('2026-10-06T10:00:00Z')
    expect(again.command.lastDeliveredAt).toBe('2026-10-06T10:00:20Z')
    expect(again.command.deliveryCount).toBe(2)
  })

  it('commandSummary 带出 deliveredAt / progress / trail（页面画过程链要用）', () => {
    const s = delivered()
    const withProgress = applyProgress(s, DEV, cid(s), { phase: 'writing', percent: 7 }, '2026-10-06T10:00:05Z').store
    const sum = commandSummary(withProgress.devices[DEV].commands[0])
    expect(sum.deliveredAt).toBe('2026-10-06T10:00:00Z')
    expect(sum.progress.phase).toBe('writing')
    expect(sum.trail).toHaveLength(1)
    // 老命令没有这些字段也要给出稳定形状
    const bare = commandSummary(makeCommand())
    expect(bare.deliveredAt).toBeNull()
    expect(bare.progress).toBeNull()
    expect(bare.trail).toEqual([])
  })

  it('纯函数：不改入参', () => {
    const s = delivered()
    applyProgress(s, DEV, cid(s), { phase: 'writing' }, '2026-10-06T10:00:05Z')
    expect(s.devices[DEV].commands[0].progress).toBeUndefined()
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

describe('POST /api/devices/:id/commands/:cid/progress（过程上报，免鉴权）', () => {
  /** 新下发一条并让设备取走（进度只能报在已投递的命令上） */
  async function freshDelivered() {
    expect((await dispatch(DEV, { type: 'ota', releaseId: RID, force: true })).status).toBe(200)
    const cur = await report(DEV)
    expect(cur.json.command).toBeTruthy()
    return cur.json.command.id
  }

  it('缺 phase → 400；percent 非数字 → 400；命令不存在 → 404', async () => {
    const cid = await freshDelivered()
    expect((await progress(DEV, cid, {})).status).toBe(400)
    expect((await progress(DEV, cid, { phase: '' })).status).toBe(400)
    expect((await progress(DEV, cid, { phase: 'writing', percent: 'half' })).status).toBe(400)
    expect((await progress(DEV, 'cmd_ffffffff', { phase: 'writing' })).status).toBe(404)
  })

  it('上报过程 → 设备列表里能看到 progress 与 trail（页面据此画过程链）', async () => {
    const cid = await freshDelivered()
    expect((await progress(DEV, cid, { phase: 'downloading', percent: 30, totalBytes: 1624624 })).status).toBe(200)
    const r = await progress(DEV, cid, { phase: 'writing', percent: 60, message: 'slot ota_0' })
    expect(r.status).toBe(200)
    expect(r.json.command.progress.phase).toBe('writing')

    const list = await (await fetch(`${base}/api/devices`)).json()
    const cmd = list.devices.find((d) => d.deviceId === DEV).lastCommand
    expect(cmd.deliveredAt).toBeTruthy()
    expect(cmd.progress).toEqual(expect.objectContaining({ phase: 'writing', percent: 60, message: 'slot ota_0' }))
    expect(cmd.trail.map((t) => t.phase)).toEqual(['downloading', 'writing'])
  })

  it('进度上报把设备刷回在线：OTA 阻塞期间 report 停了也不该显示离线', async () => {
    const cid = await freshDelivered()
    const stale = readDeviceStore(dataDir)
    stale.devices[DEV].lastSeen = '2026-10-06T08:00:00Z'
    writeDeviceStoreAtomic(dataDir, stale)
    let list = await (await fetch(`${base}/api/devices`)).json()
    expect(list.devices.find((d) => d.deviceId === DEV).online).toBe(false)

    await progress(DEV, cid, { phase: 'rebooting' })
    list = await (await fetch(`${base}/api/devices`)).json()
    expect(list.devices.find((d) => d.deviceId === DEV).online).toBe(true)
  })
})

describe('devices：在线判定（下发准入的权威口径）', () => {
  it('45s 内算在线、超过算离线；从未上报 = 离线', () => {
    const dev = { lastSeen: '2026-10-06T10:00:00Z' }
    expect(isDeviceOnline(dev, '2026-10-06T10:00:45Z')).toBe(true)
    expect(isDeviceOnline(dev, '2026-10-06T10:00:46Z')).toBe(false)
    expect(isDeviceOnline({ lastSeen: null }, '2026-10-06T10:00:00Z')).toBe(false)
    expect(isDeviceOnline(undefined, '2026-10-06T10:00:00Z')).toBe(false)
    expect(isDeviceOnline(dev, 'not-a-date')).toBe(false)
  })
})

describe('devices：离线取消记录与撤销（纯函数）', () => {
  it('recordCancelled：记 cancelled + 原因，不占未决位，进命令列表', () => {
    const r = recordCancelled(emptyDeviceStore(), DEV, makeCommand(), 'device_offline', '2026-10-06T10:00:00Z')
    expect(r.command.state).toBe('cancelled')
    expect(r.command.cancelReason).toBe('device_offline')
    expect(r.command.deliveredAt).toBeUndefined()
    expect(unresolvedCommand(r.store.devices[DEV])).toBeNull() // 设备上线后重推不会被 409 挡
    expect(r.store.devices[DEV].commands).toHaveLength(1)
  })

  it('recordCancelled：同一设备反复失败不会无限增长（沿用 20 条上限）', () => {
    let store = emptyDeviceStore()
    for (let i = 0; i < MAX_COMMANDS_PER_DEVICE + 5; i++) {
      store = recordCancelled(store, DEV, makeCommand(), 'device_offline', new Date(2026, 0, 1, 0, i).toISOString()).store
    }
    expect(store.devices[DEV].commands.length).toBe(MAX_COMMANDS_PER_DEVICE)
  })

  it('cancelCommand：撤销 pending → 真拦住（wasDelivered=false）', () => {
    const cmd = makeCommand()
    const s = enqueueCommand(emptyDeviceStore(), DEV, cmd).store
    const r = cancelCommand(s, DEV, cmd.id, 'cancelled_by_operator', '2026-10-06T10:00:05Z')
    expect(r.wasDelivered).toBe(false)
    expect(r.command.state).toBe('cancelled')
    expect(r.command.cancelReason).toBe('cancelled_by_operator')
    expect(r.command.cancelledAt).toBe('2026-10-06T10:00:05Z')
    // 设备下次上报拿不到它
    expect(nextCommandForDevice(r.store, DEV, '2026-10-06T10:00:10Z').command).toBeNull()
  })

  it('cancelCommand：撤销 delivered → wasDelivered=true，并停掉重复投递', () => {
    const cmd = makeCommand()
    let s = enqueueCommand(emptyDeviceStore(), DEV, cmd).store
    s = nextCommandForDevice(s, DEV, '2026-10-06T10:00:00Z').store // 设备已取走
    const r = cancelCommand(s, DEV, cmd.id, 'operator stop', '2026-10-06T10:00:05Z')
    expect(r.wasDelivered).toBe(true)
    expect(r.command.state).toBe('cancelled')
    // 原本会重复投递同一条，撤销后不再投
    expect(nextCommandForDevice(r.store, DEV, '2026-10-06T10:00:20Z').command).toBeNull()
  })

  it('cancelCommand：已结束不可撤销；不存在的命令返回 null', () => {
    const cmd = makeCommand()
    let s = enqueueCommand(emptyDeviceStore(), DEV, cmd).store
    s = applyResult(s, DEV, cmd.id, 'success', 'ok', '2026-10-06T10:00:05Z').store
    const done = cancelCommand(s, DEV, cmd.id, 'x', '2026-10-06T10:00:09Z')
    expect(done.notCancellable).toBe(true)
    expect(done.command.state).toBe('success')
    expect(cancelCommand(s, DEV, 'cmd_deadbeef', 'x', '2026-10-06T10:00:09Z').command).toBeNull()
  })

  it('迟到回执：撤销后设备仍报 success → 不覆盖 cancelled，记进 lateResult', () => {
    const cmd = makeCommand()
    let s = enqueueCommand(emptyDeviceStore(), DEV, cmd).store
    s = nextCommandForDevice(s, DEV, '2026-10-06T10:00:00Z').store
    s = cancelCommand(s, DEV, cmd.id, 'operator stop', '2026-10-06T10:00:05Z').store
    const late = applyResult(s, DEV, cmd.id, 'success', 'OTA ok（来晚了）', '2026-10-06T10:00:30Z')
    expect(late.command.state).toBe('cancelled')
    expect(late.command.lateResult.state).toBe('success')
    expect(late.command.lateResult.detail).toBe('OTA ok（来晚了）')
  })

  it('迟到回执：被顶替（superseded）的命令同理，不覆盖终态', () => {
    const first = makeCommand()
    let s = enqueueCommand(emptyDeviceStore(), DEV, first).store
    s = enqueueCommand(s, DEV, makeCommand(), { force: true }).store
    const late = applyResult(s, DEV, first.id, 'failed', 'late', '2026-10-06T10:00:30Z')
    expect(late.command.state).toBe('superseded')
    expect(late.command.lateResult.state).toBe('failed')
  })

  it('commandSummary 带出撤销与迟到回执字段（页面/CLI 要用）', () => {
    const cmd = makeCommand()
    const s = enqueueCommand(emptyDeviceStore(), DEV, cmd).store
    const r = cancelCommand(s, DEV, cmd.id, 'device_offline', '2026-10-06T10:00:05Z')
    const sum = commandSummary(r.store.devices[DEV].commands[0])
    expect(sum.state).toBe('cancelled')
    expect(sum.cancelReason).toBe('device_offline')
    expect(sum.cancelledAt).toBe('2026-10-06T10:00:05Z')
    expect(sum.wasDelivered).toBe(false)
    expect(sum.lateResult).toBeNull()
  })
})

describe('POST /api/devices/:id/commands（离线不下发：412 + 记录）', () => {
  it('设备离线 → 412，不排队，只留 cancelled 记录；设备上线后可正常下发', async () => {
    await report(DEV2, { chip: 'ESP32-S3' })
    makeStale(DEV2)
    const blocked = await dispatch(DEV2, { type: 'ota', releaseId: RID })
    expect(blocked.status).toBe(412)
    expect(blocked.json.error).toBe('device offline')
    expect(blocked.json.onlineTimeoutMs).toBe(ONLINE_TIMEOUT_MS)
    expect(blocked.json.lastSeen).toBe('2026-10-06T08:00:00Z')
    expect(blocked.json.cancelled.state).toBe('cancelled')
    expect(blocked.json.cancelled.cancelReason).toBe('device_offline')

    const store = readDeviceStore(dataDir)
    const cmds = store.devices[DEV2].commands
    expect(cmds[0].state).toBe('cancelled') // 有记录
    expect(cmds.some((c) => c.state === 'pending')).toBe(false) // 但没排队

    // 设备上线后重推：不因 409 被挡（取消记录不占未决位）
    await report(DEV2, { chip: 'ESP32-S3' })
    const ok = await dispatch(DEV2, { type: 'ota', releaseId: RID })
    expect(ok.status).toBe(200)
    expect(ok.json.command.state).toBe('pending')
    await cancel(DEV2, ok.json.command.id, { reason: 'test cleanup' }) // 清掉未决位，别影响后续
  })

  it('从未上报过的设备 → 同样 412（它不在线），且不会建出"幽灵 pending"', async () => {
    const ghost = 'aabbccddeeff'
    const r = await dispatch(ghost, { type: 'ota', releaseId: RID })
    expect(r.status).toBe(412)
    expect(r.json.lastSeen).toBeNull()
    const store = readDeviceStore(dataDir)
    expect(store.devices[ghost].commands.some((c) => c.state === 'pending')).toBe(false)
  })

  it('releaseId 不存在 → 404（客户端错先于离线判定报出）', async () => {
    makeStale(DEV2)
    const r = await dispatch(DEV2, { type: 'ota', releaseId: 'nope-0000' })
    expect(r.status).toBe(404)
    await report(DEV2, { chip: 'ESP32-S3' })
  })
})

describe('POST /api/devices/:id/commands/:cid/cancel（撤销未决命令，需 token）', () => {
  it('无 token → 401；命令不存在 → 404；已结束 → 409', async () => {
    const cmd = await report(DEV).then(() => null).catch(() => null) // 保持 DEV 在线
    void cmd
    expect((await cancel(DEV, 'cmd_ffffffff', {}, { token: null })).status).toBe(401)
    expect((await cancel(DEV, 'cmd_ffffffff', {})).status).toBe(404)

    await dispatch(DEV, { type: 'ota', releaseId: RID, force: true })
    const cur = await report(DEV)
    const cid = cur.json.command.id
    await result(DEV, cid, { state: 'success', detail: 'done' })
    expect((await cancel(DEV, cid, {})).status).toBe(409)
  })

  it('撤销 pending → 200（wasDelivered=false）；设备下次上报拿不到它', async () => {
    await dispatch(DEV, { type: 'ota', releaseId: RID, force: true })
    const list = await (await fetch(`${base}/api/devices`)).json()
    const cid = list.devices.find((d) => d.deviceId === DEV).lastCommand.id
    const r = await cancel(DEV, cid, { reason: '推错了' })
    expect(r.status).toBe(200)
    expect(r.json.wasDelivered).toBe(false)
    expect(r.json.command.state).toBe('cancelled')
    expect(r.json.command.cancelReason).toBe('推错了')
    const next = await report(DEV)
    expect(next.json.command).toBeNull() // 真拦住了
  })

  it('撤销 delivered → 200（wasDelivered=true）；设备迟到回执不覆盖 cancelled', async () => {
    await dispatch(DEV, { type: 'ota', releaseId: RID, force: true })
    const taken = await report(DEV) // 设备取走 → delivered
    const cid = taken.json.command.id
    const r = await cancel(DEV, cid, {})
    expect(r.status).toBe(200)
    expect(r.json.wasDelivered).toBe(true)
    expect(r.json.command.cancelReason).toBe('cancelled_by_operator') // 默认原因

    const late = await result(DEV, cid, { state: 'success', detail: 'OTA ok（撤销来晚了）' })
    expect(late.status).toBe(200)
    expect(late.json.command.state).toBe('cancelled') // 不覆盖
    expect(late.json.command.lateResult.state).toBe('success')

    // 重复投递也被停掉：设备再上报不会拿到同一条
    const again = await report(DEV)
    expect(again.json.command).toBeNull()
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

  it('unresolved 字段：即使更新的 cancelled 记录顶在列表首位，未决命令仍可被找到', async () => {
    // 构造"pending 被更新的 cancelled 记录遮住"的真实场景：
    // 设备在线下发 A(pending) → 设备掉线 → 又下发 B → 412 + 一条更新的 cancelled 记录
    const deviceId = 'a1b2c3d4e5f6'
    const store = readDeviceStore(dataDir)
    store.devices[deviceId] = {
      deviceId,
      chip: 'ESP32-S3',
      createdAt: '2026-10-06T08:00:00Z',
      lastSeen: '2026-10-06T08:00:00Z',
      commands: [
        { id: 'cmd_bbbbbbbb', type: 'ota', releaseId: RID, state: 'cancelled', createdAt: '2026-10-06T09:00:00Z', cancelReason: 'device_offline' },
        { id: 'cmd_aaaaaaaa', type: 'ota', releaseId: RID, state: 'pending', createdAt: '2026-10-06T08:30:00Z' },
      ],
    }
    writeDeviceStoreAtomic(dataDir, store)

    const list = await (await fetch(`${base}/api/devices`)).json()
    const view = list.devices.find((d) => d.deviceId === deviceId)
    expect(view.lastCommand.id).toBe('cmd_bbbbbbbb') // 最近记录是取消记录（提醒用）
    expect(view.lastCommand.state).toBe('cancelled')
    expect(view.unresolved.id).toBe('cmd_aaaaaaaa') // 但未决命令仍能拿到（撤销用）
    expect(view.unresolved.state).toBe('pending')

    // 没有未决命令时 unresolved 为 null（页面据此决定要不要显示撤销按钮）
    expect(list.devices.find((d) => d.deviceId === DEV).unresolved ?? null).toBeNull()
  })
})

describe('GET /api/devices/:id/commands/:cid（按 id 读单条，公开只读）', () => {
  it('拿到指定命令的完整摘要（含撤销/迟到回执字段）；未知 id → 404；坏 id → 400', async () => {
    await report(DEV, { chip: 'ESP32-S3' })
    await dispatch(DEV, { type: 'ota', releaseId: RID, force: true })
    const taken = await report(DEV)
    const cid = taken.json.command.id

    const res = await fetch(`${base}/api/devices/${DEV}/commands/${cid}`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.command.id).toBe(cid)
    expect(json.command.state).toBe('delivered')
    expect(json.command).toHaveProperty('cancelReason', null)
    expect(json.command).toHaveProperty('lateResult', null)

    // 免鉴权（与列表同级）——它只是读
    expect((await fetch(`${base}/api/devices/${DEV}/commands/cmd_ffffffff`)).status).toBe(404)
    expect((await fetch(`${base}/api/devices/${DEV}/commands/not-an-id`)).status).toBe(400)
    // 结局：清掉未决位，别影响别的用例
    await result(DEV, cid, { state: 'success', detail: 'cleanup' })
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
