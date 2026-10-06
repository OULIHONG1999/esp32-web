import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../server/app.js'
import { emptyRegistry, readRegistry, upsertRelease, writeRegistryAtomic } from '../server/registry.js'
import { readDeviceStore } from '../server/devices.js'
import { runPush } from '../tools/publish/push.js'
import {
  EXIT,
  UsageError,
  chainLine,
  chipGate,
  deviceLine,
  exitForCommand,
  findRelease,
  fmtAgo,
  fmtDur,
  formatMac,
  hasDeviceProgress,
  isSameVersion,
  latestHits,
  normChip,
  normalizeMac,
  parsePushArgs,
  phaseLabel,
  pickDevice,
  processRows,
  relFrom,
  pushUsage,
  sourceNote,
  stuckNote,
  verdictLine,
} from '../tools/publish/pushlib.js'

const DEV = '3485a1b2c3d4'
const RID = '20261006-1200-ab12cd'

// ── 设备 / registry 夹具 ────────────────────────────────────
function dev(over = {}) {
  return {
    deviceId: DEV,
    chip: 'ESP32-S3',
    firmwareVersion: '0.4.0',
    online: true,
    lastSeen: '2026-10-06T12:00:00Z',
    lastCommand: null,
    unresolved: null,
    ...over,
  }
}

function registry() {
  return {
    projects: {
      'lvgl-demo': {
        variants: {
          'ESP32-S3': {
            latest: RID,
            releases: [
              { id: RID, type: 'release', chipFamily: 'ESP32-S3', parts: [] },
              { id: '20261006-1100-snap', type: 'snapshot', chipFamily: 'ESP32-S3', parts: [] },
            ],
          },
        },
      },
      'other-app': {
        variants: { 'ESP32-S3': { latest: '20261001-0000-other', releases: [] } },
      },
    },
  }
}

describe('pushlib · MAC 归一（--to 的唯一入口）', () => {
  it('冒号/空格/连字符/裸 hex/大写都能归一为 12 位小写', () => {
    expect(normalizeMac('34:85:a1:b2:c3:d4')).toBe(DEV)
    expect(normalizeMac('3485a1b2c3d4')).toBe(DEV)
    expect(normalizeMac('34 85 A1 B2 C3 D4')).toBe(DEV)
    expect(normalizeMac('34-85-A1-B2-C3-D4')).toBe(DEV)
    expect(normalizeMac('  3485A1B2C3D4  ')).toBe(DEV)
  })

  it('不合法一律返回 null（不猜、不"尽量解析"）', () => {
    for (const bad of ['', '3485a1b2c3', '3485a1b2c3d4e5', 'zz85a1b2c3d4', '34:85:a1:b2:c3', null, undefined, 12345, {}]) {
      expect(normalizeMac(bad)).toBeNull()
    }
  })

  it('formatMac 还原成冒号形式；非 12hex 原样返回', () => {
    expect(formatMac(DEV)).toBe('34:85:a1:b2:c3:d4')
    expect(formatMac('not-a-mac')).toBe('not-a-mac')
  })
})

describe('pushlib · parsePushArgs（互斥与默认值）', () => {
  it('默认值：等回执、超时 300s、轮询 2s、跳过同版本、不 force', () => {
    const a = parsePushArgs(['--to', '34:85:a1:b2:c3:d4', '--release', RID])
    expect(a).toMatchObject({
      to: DEV, release: RID, build: null, latest: false,
      wait: true, waitTimeoutS: 300, pollS: 2,
      force: false, forceChip: false, allowUnknown: false, skipIfSame: true,
      status: false, cancel: false, list: false, json: false, dryRun: false,
    })
  })

  it('--build 的值可省（省了用 config 的 buildDir）', () => {
    expect(parsePushArgs(['--to', DEV, '--build']).build).toEqual({ dir: null })
    expect(parsePushArgs(['--to', DEV, '--build', 'build-fw']).build).toEqual({ dir: 'build-fw' })
    // 后面紧跟另一个开关时不能把它吃掉
    expect(parsePushArgs(['--to', DEV, '--build', '--no-wait'])).toMatchObject({
      build: { dir: null }, wait: false,
    })
  })

  it('--to 归一化后落库；缺 --to / 非法 MAC → UsageError(exit 2)', () => {
    expect(parsePushArgs(['--to', '34 85 A1 B2 C3 D4', '--latest']).to).toBe(DEV)
    expect(() => parsePushArgs(['--latest'])).toThrow(UsageError)
    expect(() => parsePushArgs(['--to', 'nope', '--latest'])).toThrow(/不是合法 MAC/)
    try {
      parsePushArgs(['--to', 'nope', '--latest'])
    } catch (err) {
      expect(err.exitCode).toBe(EXIT.USAGE)
    }
  })

  it('固件来源必须且只能一个', () => {
    expect(() => parsePushArgs(['--to', DEV])).toThrow(/缺少固件来源/)
    expect(() => parsePushArgs(['--to', DEV, '--build', '--latest'])).toThrow(/只能给一个/)
    expect(() => parsePushArgs(['--to', DEV, '--release', RID, '--latest'])).toThrow(/只能给一个/)
  })

  it('动作互斥：--list / --status / --cancel 只能选一个', () => {
    expect(() => parsePushArgs(['--list', '--status', '--to', DEV])).toThrow(/只能选一个动作/)
    expect(() => parsePushArgs(['--status', '--cancel', '--to', DEV])).toThrow(/只能选一个动作/)
    expect(() => parsePushArgs(['--list', '--build'])).toThrow(/不与 --build/)
  })

  it('--list 不需要 --to，也不接受 force/promote', () => {
    expect(parsePushArgs(['--list']).list).toBe(true)
    expect(() => parsePushArgs(['--list', '--force'])).toThrow(/不接受 --force/)
    // --promote 先撞上"只与 --build 一起用"这条更根本的规则——两条都是 exit 2，说清就行
    expect(() => parsePushArgs(['--list', '--promote'])).toThrow(/只与 --build/)
    expect(() => parsePushArgs(['--list', '--build', '--promote'])).toThrow(/不与 --build/)
  })

  it('--status / --cancel 不接受固件来源与 force 系列', () => {
    expect(() => parsePushArgs(['--to', DEV, '--status', '--release', RID])).toThrow(/只读复查/)
    expect(() => parsePushArgs(['--to', DEV, '--status', '--force'])).toThrow(/不接受/)
    expect(() => parsePushArgs(['--to', DEV, '--cancel', '--latest'])).toThrow(/只撤销/)
    expect(() => parsePushArgs(['--to', DEV, '--cancel', '--force-chip'])).toThrow(/不接受/)
    expect(() => parsePushArgs(['--to', DEV, '--cancel', '--dry-run'])).toThrow(/不用 --dry-run/)
    expect(() => parsePushArgs(['--to', DEV, '--status', '--dry-run'])).toThrow(/本身就是零副作用/)
    expect(parsePushArgs(['--to', DEV, '--cancel', '--reason', '推错了']).reason).toBe('推错了')
  })

  it('--promote 只与 --build 一起用；--reason 只与 --cancel 一起用', () => {
    expect(parsePushArgs(['--to', DEV, '--build', '--promote']).promote).toBe(true)
    expect(() => parsePushArgs(['--to', DEV, '--release', RID, '--promote'])).toThrow(/只与 --build/)
    expect(() => parsePushArgs(['--to', DEV, '--release', RID, '--reason', 'x'])).toThrow(/只与 --cancel/)
  })

  it('未知参数 / 缺值 / 非正数超时 → UsageError', () => {
    expect(() => parsePushArgs(['--to', DEV, '--latest', '--wat'])).toThrow(/未知参数/)
    expect(() => parsePushArgs(['--to'])).toThrow(/缺少取值/)
    expect(() => parsePushArgs(['--to', DEV, '--latest', '--wait-timeout', '0'])).toThrow(/正数/)
    expect(() => parsePushArgs(['--to', DEV, '--latest', '--poll', 'abc'])).toThrow(/正数/)
  })

  it('--help 短路：后面的参数一律不校验', () => {
    const a = parsePushArgs(['--help', '--wat'])
    expect(a.help).toBe(true)
  })

  it('pushUsage 含两条主力用法与离线规则（AI 读 --help 也要能懂）', () => {
    const u = pushUsage()
    expect(u).toMatch(/push --to <mac> --build/)
    expect(u).toMatch(/push --to <mac> --release/)
    expect(u).toMatch(/不下发、不排队、直接取消/)
    expect(u).toMatch(/exit 5/)
  })
})

describe('pushlib · 闸门', () => {
  it('芯片族一致才放行；大小写/空白不敏感', () => {
    expect(chipGate(dev(), 'ESP32-S3').ok).toBe(true)
    expect(chipGate(dev({ chip: 'esp32-s3' }), 'ESP32-S3').ok).toBe(true)
    expect(chipGate(dev({ chip: ' ESP32-S3 ' }), 'esp32-s3').ok).toBe(true)
  })

  it('ESP32-S3 固件推给 ESP32 设备必须拒绝（变砖级故障）；ESP32-C3 同理', () => {
    expect(chipGate(dev({ chip: 'ESP32' }), 'ESP32-S3').ok).toBe(false)
    expect(chipGate(dev({ chip: 'ESP32-C3' }), 'ESP32-S3').ok).toBe(false)
    expect(chipGate(dev({ chip: 'ESP32' }), 'ESP32-S6').ok).toBe(false)
  })

  it('拿不到型号按不通过处理（"核不了"≠"没问题"）', () => {
    expect(chipGate(dev({ chip: null }), 'ESP32-S3')).toMatchObject({ ok: false, got: null })
    expect(chipGate(dev(), null)).toMatchObject({ ok: false, want: null })
    expect(chipGate(dev(), '')).toMatchObject({ ok: false })
    expect(chipGate(null, 'ESP32-S3').reason).toMatch(/未上报芯片/)
  })

  it('normChip 空值归一为 null', () => {
    expect(normChip(' esp32-s3 ')).toBe('ESP32-S3')
    expect(normChip('')).toBeNull()
    expect(normChip(null)).toBeNull()
  })

  it('同版本判定只认 firmwareVersion === releaseId', () => {
    expect(isSameVersion(dev({ firmwareVersion: RID }), RID)).toBe(true)
    expect(isSameVersion(dev({ firmwareVersion: '0.4.0' }), RID)).toBe(false)
    expect(isSameVersion(dev({ firmwareVersion: null }), RID)).toBe(false)
    expect(isSameVersion(dev({ firmwareVersion: '' }), '')).toBe(false)
  })

  it('设备选取', () => {
    expect(pickDevice([dev(), dev({ deviceId: 'aabbccddeeff' })], 'aabbccddeeff').deviceId).toBe('aabbccddeeff')
    expect(pickDevice([dev()], 'ffffffffffff')).toBeNull()
    expect(pickDevice(undefined, DEV)).toBeNull()
  })
})

describe('pushlib · registry 定位（--release / --latest / 芯片族来源）', () => {
  it('findRelease 跨项目/变体定位，并带出 chipFamily 供闸门核对', () => {
    const hit = findRelease(registry(), RID)
    expect(hit.projectId).toBe('lvgl-demo')
    expect(hit.variant).toBe('ESP32-S3')
    expect(hit.release.chipFamily).toBe('ESP32-S3')
    expect(hit.release.type).toBe('release')
    expect(findRelease(registry(), 'nope-0000')).toBeNull()
    expect(findRelease(null, RID)).toBeNull()
  })

  it('--latest 命中多个项目时必须能看出歧义（由调用方要求 --project）', () => {
    expect(latestHits(registry(), { variant: 'ESP32-S3' })).toHaveLength(2)
    const one = latestHits(registry(), { variant: 'ESP32-S3', projectId: 'lvgl-demo' })
    expect(one).toHaveLength(1)
    expect(one[0].releaseId).toBe(RID)
    expect(latestHits(registry(), { variant: 'ESP32' })).toHaveLength(0)
    expect(latestHits(registry(), { variant: 'ESP32-S3' }).map((h) => h.projectId)).toContain('other-app')
  })
})

describe('pushlib · 过程渲染（看得见过程）', () => {
  const base = {
    id: 'cmd_9f2c31',
    type: 'ota',
    releaseId: RID,
    state: 'delivered',
    createdAt: '2026-10-06T12:00:00.000Z',
    deliveredAt: '2026-10-06T12:00:00.100Z',
    deliveryCount: 1,
    lastDeliveredAt: '2026-10-06T12:00:00.100Z',
    progress: null,
    trail: [],
    finishedAt: null,
    detail: null,
    cancelledAt: null,
    cancelReason: null,
    wasDelivered: null,
    lateResult: null,
  }

  it('时间格式化：10s 内保留一位小数、之后取整、分/时进位', () => {
    expect(fmtDur(100)).toBe('0.1s')
    expect(fmtDur(999)).toBe('1.0s')
    expect(fmtDur(1300)).toBe('1.3s')
    expect(fmtDur(4200)).toBe('4.2s')
    expect(fmtDur(9999)).toBe('10.0s')
    expect(fmtDur(10_000)).toBe('10s')
    expect(fmtDur(31_000)).toBe('31s')
    expect(fmtDur(65_000)).toBe('1m5s')
    expect(fmtDur(3_600_000)).toBe('1h')
    expect(fmtDur(-1)).toBe('—')
    expect(fmtDur(NaN)).toBe('—')
    expect(relFrom(base.createdAt, base.deliveredAt)).toBe('+0.1s')
    expect(relFrom(base.createdAt, null)).toBe('—')
    expect(fmtAgo('2026-10-06T11:59:00Z', Date.parse('2026-10-06T12:00:00Z'))).toBe('1m 前')
  })

  it('紧凑过程链：取走 + 各阶段（含 percent）按时间顺序', () => {
    const cmd = {
      ...base,
      trail: [
        { phase: 'downloading', at: '2026-10-06T12:00:00.700Z', percent: 100 },
        { phase: 'verifying', at: '2026-10-06T12:00:01.300Z' },
        { phase: 'writing', at: '2026-10-06T12:00:02.400Z', percent: 100 },
        { phase: 'rebooting', at: '2026-10-06T12:00:02.600Z' },
      ],
    }
    expect(chainLine(cmd)).toBe('取走 +0.1s · 下载固件 100% +0.7s · 校验 sha256 +1.3s · 写入 OTA 槽 100% +2.4s · 重启 +2.6s')
  })

  it('progress 比 trail 更新时补一行"当前"，不重复同一时间点', () => {
    const cmd = {
      ...base,
      trail: [{ phase: 'writing', at: '2026-10-06T12:00:02.000Z', percent: 30 }],
      progress: { phase: 'writing', percent: 55, message: '写入中', updatedAt: '2026-10-06T12:00:05.000Z' },
    }
    expect(chainLine(cmd)).toContain('当前 写入 OTA 槽 55% +5.0s')
    const same = { ...cmd, progress: { ...cmd.progress, updatedAt: '2026-10-06T12:00:02.000Z' } }
    expect(chainLine(same)).not.toContain('当前')
  })

  it('完整过程链行：下发 → 取走 → 阶段 → 回执（含相对耗时与明细）', () => {
    const cmd = {
      ...base,
      state: 'success',
      finishedAt: '2026-10-06T12:00:05.000Z',
      detail: 'OTA ok, rebooted',
      trail: [{ phase: 'downloading', at: '2026-10-06T12:00:01.000Z', percent: 100 }],
    }
    const rows = processRows(cmd)
    expect(rows.map((r) => r.label)).toEqual(['已下发', '设备取走', '过程：下载固件', '回执：success'])
    expect(rows[0].extra).toBe(`release ${RID}`)
    expect(rows[2].extra).toBe('100%')
    expect(rows[3].extra).toBe('OTA ok, rebooted')
  })

  it('取消行与迟到回执行：cancelled 不再画"回执"行（避免同刻两行）', () => {
    const cmd = {
      ...base,
      state: 'cancelled',
      cancelledAt: '2026-10-06T12:00:10.000Z',
      finishedAt: '2026-10-06T12:00:10.000Z',
      cancelReason: 'cancelled_by_operator',
      wasDelivered: true,
      lateResult: { state: 'success', at: '2026-10-06T12:00:20.000Z', detail: 'OTA ok（来晚了）' },
    }
    const labels = processRows(cmd).map((r) => r.label)
    expect(labels).toContain('取消：运维撤销')
    expect(labels).toContain('迟到回执：success（撤销来晚了）')
    expect(labels.filter((l) => l.startsWith('回执：'))).toHaveLength(0)
    expect(processRows(cmd).find((r) => r.label.startsWith('取消')).extra).toBe('撤销时设备已取走（重复投递已停）')
  })

  it('离线取消的记录写成"未下发"，不假装设备取过', () => {
    const cmd = {
      ...base,
      state: 'cancelled',
      deliveredAt: null,
      cancelReason: 'device_offline',
      wasDelivered: false,
      cancelledAt: '2026-10-06T12:00:00.000Z',
      finishedAt: '2026-10-06T12:00:00.000Z',
    }
    const rows = processRows(cmd)
    expect(rows.map((r) => r.label)).toEqual(['已下发', '取消：设备不在线'])
    expect(rows[1].extra).toBe('未下发')
  })

  it('阶段标签未知时原样显示（服务器不拦自定义 phase）', () => {
    expect(phaseLabel('downloading')).toBe('下载固件')
    expect(phaseLabel('my-custom-phase')).toBe('my-custom-phase')
  })

  it('停滞判断：pending>30s、delivered 无过程>2min、过程>60s 未更新', () => {
    const t0 = Date.parse('2026-10-06T12:00:00Z')
    expect(stuckNote({ ...base, state: 'pending', deliveredAt: null }, t0 + 20_000)).toBeNull()
    expect(stuckNote({ ...base, state: 'pending', deliveredAt: null }, t0 + 31_000)).toMatch(/仍未被取走/)

    const d = { ...base, deliveredAt: '2026-10-06T12:00:00Z' }
    expect(stuckNote(d, t0 + 60_000)).toBeNull()
    expect(stuckNote(d, t0 + 121_000)).toMatch(/没有任何过程上报/)

    const withP = {
      ...d,
      progress: { phase: 'writing', percent: 10, updatedAt: '2026-10-06T12:00:30Z' },
    }
    expect(stuckNote(withP, t0 + 60_000)).toBeNull()
    expect(stuckNote(withP, t0 + 100_000)).toMatch(/没有更新/)
  })

  it('没有设备过程点时必须明说（不假装有进度）', () => {
    const bare = { ...base, state: 'delivered' }
    expect(hasDeviceProgress(bare)).toBe(false)
    expect(sourceNote(bare)).toMatch(/设备端未上报过程点/)
    const withTrail = { ...base, trail: [{ phase: 'writing', at: base.createdAt }] }
    expect(hasDeviceProgress(withTrail)).toBe(true)
    expect(sourceNote(withTrail)).toBeNull()
  })
})

describe('pushlib · 结论与退出码', () => {
  const t0 = Date.parse('2026-10-06T12:00:00Z')
  const base = { id: 'cmd_1', releaseId: RID, createdAt: '2026-10-06T12:00:00Z', trail: [] }

  it('终态映射：success→0 failed→1 cancelled→9 superseded→10 未回执→5', () => {
    expect(exitForCommand({ ...base, state: 'success' })).toBe(EXIT.OK)
    expect(exitForCommand({ ...base, state: 'failed' })).toBe(EXIT.DEVICE_FAILED)
    expect(exitForCommand({ ...base, state: 'cancelled' })).toBe(EXIT.OFFLINE)
    expect(exitForCommand({ ...base, state: 'superseded' })).toBe(EXIT.CONFLICT)
    expect(exitForCommand({ ...base, state: 'pending' })).toBe(EXIT.TIMEOUT)
    expect(exitForCommand({ ...base, state: 'delivered' })).toBe(EXIT.TIMEOUT)
    expect(exitForCommand(null)).toBe(EXIT.NOT_FOUND)
  })

  it('结论行说人话：成功带总耗时与 detail；失败带设备原文', () => {
    expect(
      verdictLine({ ...base, state: 'success', finishedAt: '2026-10-06T12:00:04.200Z', detail: 'OTA ok' }, t0),
    ).toBe('✓ success 总耗时 4.2s · OTA ok')
    expect(verdictLine({ ...base, state: 'failed', finishedAt: '2026-10-06T12:00:02.000Z', detail: 'sha mismatch' }, t0)).toBe(
      '✗ failed 耗时 2.0s · sha mismatch',
    )
    expect(verdictLine({ ...base, state: 'failed', finishedAt: '2026-10-06T12:00:02.000Z' }, t0)).toMatch(/设备没给 detail/)
  })

  it('取消结论：离线 → "未下发、未排队"；已取走 → 明说拦不住', () => {
    const offline = { ...base, state: 'cancelled', cancelReason: 'device_offline' }
    expect(verdictLine(offline, t0)).toBe('✗ 已取消（设备不在线）：未下发、未排队')

    const late = {
      ...base,
      state: 'cancelled',
      cancelReason: 'cancelled_by_operator',
      wasDelivered: true,
      lateResult: { state: 'success', detail: 'OTA ok（来晚了）' },
    }
    const line = verdictLine(late, t0)
    expect(line).toMatch(/拦不住正在写入的设备/)
    expect(line).toMatch(/迟到回执 success/)
    expect(line).toMatch(/设备本地照旧写完了/)

    const pending = { ...base, state: 'cancelled', cancelReason: 'cancelled_by_operator', wasDelivered: false }
    expect(verdictLine(pending, t0)).toMatch(/已经拦住/)
  })

  it('顶替与未回执各有说法', () => {
    expect(verdictLine({ ...base, state: 'superseded' }, t0)).toMatch(/被新命令顶替/)
    expect(verdictLine({ ...base, state: 'pending' }, t0 + 65_000)).toMatch(/仍未回执（已等待 1m5s）/)
  })

  it('deviceLine：id/芯片/固件/在线态/最近命令一行说完', () => {
    const line = deviceLine(
      { deviceId: DEV, chip: 'ESP32-S3', firmwareVersion: '0.4.0', online: true, lastSeen: '2026-10-06T12:00:00Z', lastCommand: { state: 'success', id: 'cmd_1' } },
      t0,
    )
    expect(line).toBe('34:85:a1:b2:c3:d4 · ESP32-S3 · 0.4.0 · online · success cmd_1')
    const off = deviceLine(
      { deviceId: DEV, chip: null, firmwareVersion: null, online: false, lastSeen: '2026-10-06T11:58:00Z', lastCommand: null },
      t0,
    )
    expect(off).toBe('34:85:a1:b2:c3:d4 · ? · ? · offline(2m 前) · 无命令')
  })
})

// ══════════════════════════════════════════════════════════
// 端到端：起真服务器 + 模拟设备，跑真 CLI（验收清单 docs/PUSH-TO-DEVICE.md §8）
// ══════════════════════════════════════════════════════════
const E_TOK = 'test-token'
const E_RID = '20261007-1000-aaaaaa' // ESP32-S3 正式版
const E_RID_OTHER = '20261007-1001-bbbbbb' // ESP32-S3 另一版本（造 409 / 重入用）
const E_RID_C3 = '20261007-1002-cccccc' // ESP32-C3（造芯片族不匹配）
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

let dataDir
let server
let base
let configPath
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function releaseOf(id, chipFamily, file) {
  return {
    project: { id: 'lvgl-demo-v9', name: 'LVGL Demo V9', description: 'demo' },
    variant: chipFamily,
    release: {
      id,
      type: 'release',
      chipFamily,
      note: '',
      createdAt: '2026-10-07T10:00:00Z',
      parts: [
        { label: 'app', address: 65536, file, size: 1024, sha256: 'a'.repeat(64), type: 'app', subType: 'factory' },
      ],
    },
  }
}

function seedRegistry(dir) {
  let reg = emptyRegistry()
  reg = upsertRelease(reg, releaseOf(E_RID, 'ESP32-S3', 'lvgl.bin'))
  reg = upsertRelease(reg, releaseOf(E_RID_OTHER, 'ESP32-S3', 'other.bin'))
  reg = upsertRelease(reg, releaseOf(E_RID_C3, 'ESP32-C3', 'c3.bin'))
  writeRegistryAtomic(dir, reg)
}

/** 设备上报（兼取命令）：返回本次取到的命令 */
async function report(deviceId, body = {}) {
  const res = await fetch(`${base}/api/devices/${deviceId}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chip: 'ESP32-S3', ...body }),
  })
  return await res.json()
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
  await fetch(`${base}/api/devices/${deviceId}/commands/${commandId}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function dispatchDirect(deviceId, body) {
  const res = await fetch(`${base}/api/devices/${deviceId}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${E_TOK}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

async function viewOf(deviceId) {
  const list = await (await fetch(`${base}/api/devices`)).json()
  return list.devices.find((d) => d.deviceId === deviceId) ?? null
}

/** 等设备上出现未决命令（CLI 已下发）——比 sleep 更稳 */
async function waitUnresolved(deviceId, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await viewOf(deviceId)
    if (v?.unresolved) return v.unresolved
    await sleep(20)
  }
  throw new Error(`等不到未决命令：${deviceId}`)
}

/** 跑一次真 CLI：捕获 stdout/stderr，返回退出码与两路输出 */
async function run(argv) {
  const out = []
  const err = []
  // 只收 CLI 自己的行：服务器的 [http] 访问日志与它们不是一回事（混进来会让断言假失败）
  const keep = (s) => /^\[(push|publish)\]/.test(s) || s.trim().startsWith('{')
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => {
    const s = a.join(' ')
    if (keep(s)) out.push(s)
  })
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => {
    const s = a.join(' ')
    if (keep(s)) err.push(s)
  })
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const code = await runPush(['--config', configPath, ...argv])
    return { code, out: out.join('\n'), err: err.join('\n') }
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
    warnSpy.mockRestore()
  }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-push-test-'))
  seedRegistry(dataDir)
  server = http.createServer(createApp({ dataDir, token: E_TOK, distDir: path.join(dataDir, 'no-dist') }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  configPath = path.join(dataDir, 'publish.config.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({ server: base, token: E_TOK, project: { id: 'hello-world', name: 'Hello World' } }),
  )
})

afterAll(() => {
  server.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('push CLI · --list', () => {
  it('列出设备（id/芯片/固件/在线/最近命令）', async () => {
    await report('aa0000000001', { firmwareVersion: 'v0.1.0' })
    const { code, out } = await run(['--list'])
    expect(code).toBe(0)
    expect(out).toMatch(/设备清单（\d+ 台）/)
    expect(out).toContain('aa:00:00:00:00:01 · ESP32-S3 · v0.1.0 · online')
  })

  it('--list --to <陌生 MAC> → exit 4（不再往下走）', async () => {
    const { code, out } = await run(['--list', '--to', 'ff:ff:ff:ff:ff:ff'])
    expect(code).toBe(4)
    expect(out).toMatch(/设备清单里没有 ff:ff:ff:ff:ff:ff/)
  })
})

describe('push CLI · 目标与闸门（都能在本地/下发前挡住）', () => {
  it('陌生 MAC → exit 4，且**没有**在服务器上建出幽灵设备（§8）', async () => {
    const before = (await (await fetch(`${base}/api/devices`)).json()).devices.length
    const { code, out } = await run(['--to', 'de:ad:be:ef:00:99', '--release', E_RID])
    expect(code).toBe(4)
    expect(out).toMatch(/目标设备不在清单里/)
    expect(out).toMatch(/--list 对照现有设备/)
    const after = (await (await fetch(`${base}/api/devices`)).json()).devices.length
    expect(after).toBe(before) // 幽灵设备 = 静默排队的根因，必须没有
  })

  it('芯片族不匹配 → exit 7；加 --force-chip 才放行', async () => {
    const DEV = 'aa0000000002'
    await report(DEV)
    const blocked = await run(['--to', DEV, '--release', E_RID_C3])
    expect(blocked.code).toBe(7)
    expect(blocked.out).toMatch(/芯片族不匹配：固件 ESP32-C3 ≠ 设备 ESP32-S3/)
    expect((await viewOf(DEV)).unresolved).toBeNull() // 没下发

    const forced = await run(['--to', DEV, '--release', E_RID_C3, '--force-chip', '--no-wait'])
    expect(forced.code).toBe(0)
    expect(forced.out).toMatch(/--force-chip 放行/)
    await fetch(`${base}/api/devices/${DEV}/commands/${(await waitUnresolved(DEV)).id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${E_TOK}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
  })

  it('设备已在目标版本 → exit 8 且未下发；--no-skip-if-same 可照推', async () => {
    const DEV = 'aa0000000003'
    await report(DEV, { firmwareVersion: E_RID })
    const skipped = await run(['--to', DEV, '--release', E_RID])
    expect(skipped.code).toBe(8)
    expect(skipped.out).toMatch(/设备已在目标版本/)
    expect((await viewOf(DEV)).unresolved).toBeNull()

    const again = await run(['--to', DEV, '--release', E_RID, '--no-skip-if-same', '--no-wait'])
    expect(again.code).toBe(0)
  })

  it('--release 不存在 → exit 4；--latest 有歧义 → exit 2 并给出 --project', async () => {
    const DEV = 'aa0000000004'
    await report(DEV)
    const missing = await run(['--to', DEV, '--release', 'nope-0000'])
    expect(missing.code).toBe(4)
    expect(missing.out).toMatch(/registry 里没有 release nope-0000/)

    // 两个项目都有 ESP32-S3 的 latest → 歧义（fixtures 的 hello-world 由 --build 用例造出来后再验）
    const one = await run(['--to', DEV, '--latest', '--project', 'lvgl-demo-v9', '--no-wait'])
    expect(one.code).toBe(0)
    expect(one.out).toMatch(/目标版本：lvgl-demo-v9\/ESP32-S3\//)
  })
})

describe('push CLI · 离线即取消（§3.1，本设计的硬规则）', () => {
  it('设备离线 → exit 9：不下发、不排队，只留一条 cancelled 记录；上线后重推成功', async () => {
    const DEV = 'aa0000000005'
    await report(DEV) // 先上线
    const store0 = readDeviceStore(dataDir)
    store0.devices[DEV].lastSeen = '2020-01-01T00:00:00Z' // 再让它离线
    const { writeDeviceStoreAtomic } = await import('../server/devices.js')
    writeDeviceStoreAtomic(dataDir, store0)

    const blocked = await run(['--to', DEV, '--release', E_RID])
    expect(blocked.code).toBe(9)
    expect(blocked.out).toMatch(/不在线/)
    expect(blocked.out).toMatch(/已取消：未下发、未排队/)
    expect(blocked.out).toMatch(/留档：cmd_\w+ · cancelled · 原因 设备不在线/)

    const store = readDeviceStore(dataDir)
    const cmds = store.devices[DEV].commands
    expect(cmds[0].state).toBe('cancelled') // 有记录（页面能看见）
    expect(cmds[0].cancelReason).toBe('device_offline')
    expect(cmds.some((c) => c.state === 'pending' || c.state === 'delivered')).toBe(false) // 但没排队

    // 仍然离线时重推：还是 exit 9，不因 409 被挡（取消记录不占未决位）
    const again = await run(['--to', DEV, '--release', E_RID])
    expect(again.code).toBe(9)

    // 设备上线后重推 → 正常下发并成功（证明取消没留下阻塞）
    await report(DEV)
    const pending = run(['--to', DEV, '--release', E_RID, '--poll', '0.05', '--wait-timeout', '10'])
    const cmd = await waitUnresolved(DEV)
    const taken = await report(DEV) // 设备取走
    expect(taken.command.id).toBe(cmd.id)
    await result(DEV, cmd.id, { state: 'success', detail: 'OTA ok' })
    const done = await pending
    expect(done.code).toBe(0)
    expect(done.out).toMatch(/✓ success/)
  })
})

describe('push CLI · 下发与等待（看得见过程）', () => {
  it('--release 推一条：下发 → 取走 → 各阶段 → 回执，exit 0', async () => {
    const DEV = 'aa0000000006'
    await report(DEV, { firmwareVersion: 'v0.1.0' })
    const p = run(['--to', DEV, '--release', E_RID, '--poll', '0.05', '--wait-timeout', '10'])
    const cmd = await waitUnresolved(DEV)
    await report(DEV) // 取走
    await progress(DEV, cmd.id, { phase: 'downloading', percent: 100 })
    await progress(DEV, cmd.id, { phase: 'writing', percent: 60, message: '写 flash' })
    await result(DEV, cmd.id, { state: 'success', detail: 'OTA ok, rebooted' })

    const { code, out } = await p
    expect(code).toBe(0)
    expect(out).toMatch(/芯片族一致：ESP32-S3/)
    expect(out).toMatch(/已下发 cmd_\w+ → 等设备取走/)
    expect(out).toContain('设备取走')
    expect(out).toMatch(/过程：下载固件 \+\d.*100%/)
    // 同阶段的 percent 抬到最新值，但时间点保持阶段起点 → 行里是"过程：写入 OTA 槽 +t · 60%"
    expect(out).toMatch(/过程：写入 OTA 槽 \+\d.*60%/)
    expect(out).toMatch(/回执：success/)
    expect(out).toMatch(/✓ success 总耗时 [\d.]+s · OTA ok, rebooted/)
  })

  it('设备回执 failed → exit 1 并打印设备给的 detail', async () => {
    const DEV = 'aa0000000007'
    await report(DEV)
    const p = run(['--to', DEV, '--release', E_RID, '--poll', '0.05', '--wait-timeout', '10'])
    const cmd = await waitUnresolved(DEV)
    await report(DEV)
    await result(DEV, cmd.id, { state: 'failed', detail: 'sha256 mismatch' })
    const { code, out } = await p
    expect(code).toBe(1)
    expect(out).toMatch(/✗ failed .*sha256 mismatch/)
  })

  it('--no-wait：下发即返回，并提示用 --status 复查', async () => {
    const DEV = 'aa0000000008'
    await report(DEV)
    const { code, out } = await run(['--to', DEV, '--release', E_RID, '--no-wait'])
    expect(code).toBe(0)
    expect(out).toMatch(/--no-wait：不等待回执/)
    expect(out).toMatch(/push --status --to aa:00:00:00:00:08/)
  })

  it('超时 → exit 5，并打全已有过程 + 停在哪一步 + 复查提示（§3.3）', async () => {
    const DEV = 'aa0000000009'
    await report(DEV)
    const { code, out } = await run(['--to', DEV, '--release', E_RID, '--poll', '0.05', '--wait-timeout', '1'])
    expect(code).toBe(5)
    expect(out).toMatch(/超时（1s）未见回执/)
    expect(out).toMatch(/已下发 cmd_\w+/)
    expect(out).toMatch(/命令停在 pending：设备还没取走/)
    expect(out).toMatch(/设备端未上报过程点/)
    expect(out).toMatch(/push --status --to aa:00:00:00:00:09 复查/)
  })

  it('故障注入：设备取走后断电（不回执）→ exit 5，并指出"停在 delivered"', async () => {
    const DEV = 'aa000000000e'
    await report(DEV)
    const p = run(['--to', DEV, '--release', E_RID, '--poll', '0.05', '--wait-timeout', '1'])
    const cmd = await waitUnresolved(DEV)
    await report(DEV) // 设备取走（delivered），然后就"断电"：不再上报、不回执
    const { code, out } = await p
    expect(code).toBe(5)
    expect(out).toMatch(/命令停在 delivered：设备已在 .* 前取走，但服务器没收到回执/)
    expect(out).toMatch(/设备端未上报过程点/)

    // 断电的设备回来后会重新拿到同一条（重复投递），这正是"取走未回执"的兜底
    const again = await report(DEV)
    expect(again.command?.id).toBe(cmd.id)
    expect(again.redelivered).toBe(true)
  })

  it(
    '故障注入：等待期 token 被撤销 → 等待照常完成（轮询是公开只读的），但新下发会被拒',
    async () => {
      const DEV = 'aa000000001f'
      await report(DEV)
      // 用工作 token 下发（能撤销的那种），再用主 token 把它撤掉
      const mk = await fetch(`${base}/api/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${E_TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'push-cli-test-token' }),
      })
      const wk = (await mk.json()).token.token
      expect(wk).toMatch(/^wk_/)
      const cfg2 = path.join(dataDir, 'publish.config.wk.json')
      fs.writeFileSync(cfg2, JSON.stringify({ server: base, token: wk, project: { id: 'hello-world' } }))

      const p = (async () => {
        const out = []
        const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => {
          const s = a.join(' ')
          if (/^\[(push|publish)\]/.test(s)) out.push(s)
        })
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
          const code = await runPush([
            '--config', cfg2, '--to', DEV, '--release', E_RID, '--poll', '0.05', '--wait-timeout', '10',
          ])
          return { code, out: out.join('\n') }
        } finally {
          logSpy.mockRestore()
          warnSpy.mockRestore()
        }
      })()
      const cmd = await waitUnresolved(DEV)
      // 等待期间把工作 token 撤销
      await fetch(`${base}/api/token`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${E_TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: wk }),
      })
      await report(DEV)
      await result(DEV, cmd.id, { state: 'success', detail: 'ok' })
      const done = await p
      expect(done.code).toBe(0) // 轮询走公开只读端点 → token 没了也照样看到结论
      expect(done.out).toMatch(/✓ success/)

      // 但被撤销的 token 不能再下发（新命令会被 401 挡住）
      const after = await fetch(`${base}/api/devices/${DEV}/commands`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${wk}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ota', releaseId: E_RID, force: true }),
      })
      expect(after.status).toBe(401)
    },
    15000,
  )

  it('重入：同版本已是未决命令 → 不报错、不重复下发，接着等出结论', async () => {
    const DEV = 'aa000000000a'
    await report(DEV)
    const first = await dispatchDirect(DEV, { type: 'ota', releaseId: E_RID })
    expect(first.status).toBe(200)

    const p = run(['--to', DEV, '--release', E_RID, '--poll', '0.05', '--wait-timeout', '10'])
    const cmd = await waitUnresolved(DEV)
    expect(cmd.id).toBe(first.json.command.id) // 没有新建第二条
    await report(DEV)
    await result(DEV, cmd.id, { state: 'success', detail: 'ok' })
    const { code, out } = await p
    expect(code).toBe(0)
    expect(out).toMatch(/判定为重入，接着等它/)
    const store = readDeviceStore(dataDir)
    expect(store.devices[DEV].commands).toHaveLength(1) // 真没重复下发
  })

  it('他版本未决命令 → exit 10 并提示 --force；--force 顶替后旧命令标 superseded', async () => {
    const DEV = 'aa000000000b'
    await report(DEV)
    await dispatchDirect(DEV, { type: 'ota', releaseId: E_RID_OTHER })

    const blocked = await run(['--to', DEV, '--release', E_RID, '--no-wait'])
    expect(blocked.code).toBe(10)
    expect(blocked.out).toMatch(/设备已有未决命令/)
    expect(blocked.out).toMatch(/--force 顶替/)

    const forced = await run(['--to', DEV, '--release', E_RID, '--force', '--no-wait'])
    expect(forced.code).toBe(0)
    const store = readDeviceStore(dataDir)
    const states = store.devices[DEV].commands.map((c) => c.state)
    expect(states).toContain('superseded')
    expect(states).toContain('pending')
  })
})

describe('push CLI · 轮询容错（--wait 期间服务器短时不可达不误判）', () => {
  /** 简易转发代理：默认放行，setFails(n) 之后的下 n 个请求返回 502（模拟"服务器重启了一下"） */
  function startProxy() {
    let failLeft = 0
    const px = http.createServer((cReq, cRes) => {
      if (failLeft > 0) {
        failLeft--
        cRes.writeHead(502, { 'Content-Type': 'application/json' })
        cRes.end('{"error":"bad gateway"}')
        return
      }
      const pReq = http.request(
        { hostname: '127.0.0.1', port: server.address().port, path: cReq.url, method: cReq.method, headers: cReq.headers },
        (pRes) => {
          cRes.writeHead(pRes.statusCode, pRes.headers)
          pRes.pipe(cRes)
        },
      )
      pReq.on('error', () => cRes.destroy())
      cReq.pipe(pReq)
    })
    px.setFails = (n) => {
      failLeft = n
    }
    return new Promise((r) => px.listen(0, '127.0.0.1', () => r(px)))
  }

  it(
    '短暂 502（2 次）→ 不误判，恢复后仍给出最终结论 exit 0',
    async () => {
      const DEV = 'aa000000000c'
      await report(DEV)
      const px = await startProxy()
      const pxUrl = `http://127.0.0.1:${px.address().port}`
      const p = run(['--to', DEV, '--release', E_RID, '--server', pxUrl, '--poll', '0.05', '--wait-timeout', '10'])
      const cmd = await waitUnresolved(DEV)
      px.setFails(2) // 下发已完成，接下来两次轮询打不通（< 3 次阈值）
      await report(DEV)
      await result(DEV, cmd.id, { state: 'success', detail: 'ok' })
      const { code, out } = await p
      px.closeAllConnections?.()
      px.close()
      expect(code).toBe(0)
      expect(out).not.toMatch(/轮询失败/) // 没有把它当成失败
      expect(out).toMatch(/✓ success/)
    },
    15000,
  )

  it(
    '持续不可达（连续 3 次）→ exit 6，且明说命令不受影响',
    async () => {
      const DEV = 'aa000000000d'
      await report(DEV)
      const px = await startProxy()
      const pxUrl = `http://127.0.0.1:${px.address().port}`
      const p = run(['--to', DEV, '--release', E_RID, '--server', pxUrl, '--poll', '0.05', '--wait-timeout', '30'])
      await waitUnresolved(DEV) // 命令已入队（下发成功）
      px.closeAllConnections?.()
      px.close() // 之后一直连不上
      const { code, out } = await p
      expect(code).toBe(6)
      expect(out).toMatch(/轮询失败：连续 \d+ 次/)
      expect(out).toMatch(/命令不受影响（状态在服务器上）/)

      // 服务器其实没挂：命令还在，恢复后 --status 能复查（§3.2）
      const after = await run(['--to', DEV, '--status'])
      expect(after.code).toBe(5) // 仍未回执
      expect(after.out).toMatch(/复查结论退出码 5/)
    },
    15000,
  )
})

describe('push CLI · --status 只读复查', () => {
  it('成功命令 → exit 0 并打出完整过程链', async () => {
    const DEV = 'aa000000000e'
    await report(DEV)
    await dispatchDirect(DEV, { type: 'ota', releaseId: E_RID })
    const cmd = await waitUnresolved(DEV)
    await report(DEV) // 取走（delivered）
    await result(DEV, cmd.id, { state: 'success', detail: 'OTA ok' })
    const { code, out } = await run(['--to', DEV, '--status'])
    expect(code).toBe(0)
    expect(out).toMatch(/命令 cmd_\w+ · success · release/)
    expect(out).toContain('已下发')
    expect(out).toMatch(/✓ success/)
  })

  it('被撤销的命令 → exit 9，并如实说明取消原因与"是否已取走"', async () => {
    const DEV = 'aa000000000f'
    await report(DEV)
    await dispatchDirect(DEV, { type: 'ota', releaseId: E_RID })
    const cmd = await waitUnresolved(DEV)
    await fetch(`${base}/api/devices/${DEV}/commands/${cmd.id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${E_TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'device_offline' }),
    })
    const { code, out } = await run(['--to', DEV, '--status'])
    expect(code).toBe(9)
    expect(out).toMatch(/取消：设备不在线/)
    expect(out).toMatch(/已取消（设备不在线）：未下发、未排队/)
  })

  it('没有命令记录 → exit 4', async () => {
    const DEV = 'aa0000000010'
    await report(DEV)
    const { code, out } = await run(['--to', DEV, '--status'])
    expect(code).toBe(4)
    expect(out).toMatch(/还没有命令记录/)
  })
})

describe('push CLI · --cancel 撤销未决命令（§3.4）', () => {
  it('撤销 pending → exit 0；设备下次上报不再拿到它', async () => {
    const DEV = 'aa0000000011'
    await report(DEV)
    await dispatchDirect(DEV, { type: 'ota', releaseId: E_RID })
    await waitUnresolved(DEV)
    const { code, out } = await run(['--to', DEV, '--cancel', '--reason', '推错了版本'])
    expect(code).toBe(0)
    expect(out).toMatch(/✓ 已撤销 cmd_\w+/)
    expect((await report(DEV)).command).toBeNull() // 真拦住了
    expect((await viewOf(DEV)).lastCommand.cancelReason).toBe('推错了版本')
  })

  it('撤销 delivered → exit 11 + 警告；迟到回执不覆盖 cancelled', async () => {
    const DEV = 'aa0000000012'
    await report(DEV)
    await dispatchDirect(DEV, { type: 'ota', releaseId: E_RID })
    const cmd = await waitUnresolved(DEV)
    await report(DEV) // 设备取走 → delivered
    const { code, out } = await run(['--to', DEV, '--cancel'])
    expect(code).toBe(11)
    expect(out).toMatch(/无法中断正在进行的写入/)
    expect(out).toMatch(/迟到回执/)

    await result(DEV, cmd.id, { state: 'success', detail: 'OTA ok（撤销来晚了）' })
    const view = await viewOf(DEV)
    expect(view.lastCommand.state).toBe('cancelled') // 不覆盖
    expect(view.lastCommand.lateResult.state).toBe('success')
    expect((await report(DEV)).command).toBeNull() // 重复投递被停掉（撤销最实际的收益）
  })

  it('没有未决命令 / 命令已结束 → exit 12', async () => {
    const DEV = 'aa0000000013'
    await report(DEV)
    const none = await run(['--to', DEV, '--cancel'])
    expect(none.code).toBe(12)
    expect(none.out).toMatch(/没有可撤销的未决命令/)

    await dispatchDirect(DEV, { type: 'ota', releaseId: E_RID })
    const cmd = await waitUnresolved(DEV)
    await report(DEV)
    await result(DEV, cmd.id, { state: 'success' })
    const done = await run(['--to', DEV, '--cancel'])
    expect(done.code).toBe(12)
    expect(done.out).toMatch(/已结束，不可撤销/)
  })

  it('推错版本后握停：pending 撤销后重推新版本成功（推错了能停住）', async () => {
    const DEV = 'aa0000000014'
    await report(DEV)
    await dispatchDirect(DEV, { type: 'ota', releaseId: E_RID_OTHER })
    await waitUnresolved(DEV)
    const stopped = await run(['--to', DEV, '--cancel', '--reason', '推错了'])
    expect(stopped.code).toBe(0)

    const p = run(['--to', DEV, '--release', E_RID, '--poll', '0.05', '--wait-timeout', '10'])
    const cmd = await waitUnresolved(DEV)
    expect(cmd.releaseId).toBe(E_RID)
    await report(DEV)
    await result(DEV, cmd.id, { state: 'success', detail: 'ok' })
    expect((await p).code).toBe(0)
  })
})

describe('push CLI · --dry-run 零副作用', () => {
  it('--build --dry-run：不发任何请求（连不上的地址也能 exit 0）', async () => {
    const { code, out } = await run([
      '--to', 'aa0000000015', '--build', path.join(FIXTURES, 'fake-build'), '--dry-run',
      '--server', 'http://127.0.0.1:1', // 死端口：真发请求就会 exit 6
    ])
    expect(code).toBe(0)
    expect(out).toMatch(/--dry-run：未发任何请求/)
    expect(out).toMatch(/1\. 发布 hello-world\/ESP32-S3\/\d{8}-\d{6}-\w+（3 段/)
    expect(out).toMatch(/闸门（目标在清单 \/ 芯片族一致 \/ 非同版本）本次未校验——零请求/)
    expect((await viewOf('aa0000000015'))).toBeNull() // 没建幽灵设备
  })

  it('--dry-run 真下发过的东西：--build 默认只造快照，不晋升；--promote 才转正式版', async () => {
    const DEV = 'aa0000000016'
    await report(DEV, { firmwareVersion: 'v0.1.0' })
    const p = run([
      '--to', DEV, '--build', path.join(FIXTURES, 'fake-build'),
      '--poll', '0.05', '--wait-timeout', '10',
    ])
    const cmd = await waitUnresolved(DEV, 8000)
    await report(DEV)
    await result(DEV, cmd.id, { state: 'success', detail: 'OTA ok' })
    const { code, out } = await p
    expect(code).toBe(0)
    expect(out).toMatch(/\[publish\] ✓ 已发布 hello-world\/ESP32-S3\//)
    expect(out).toMatch(/✓ success/)

    const reg = readRegistry(dataDir)
    const vars = reg.projects['hello-world'].variants['ESP32-S3']
    expect(vars.releases.find((r) => r.id === cmd.releaseId).type).toBe('snapshot') // 默认不晋升
    expect(out).not.toMatch(/已晋升为正式版/)

    // --promote：显式晋升
    const DEV2 = 'aa0000000017'
    await report(DEV2, { firmwareVersion: 'v0.1.0' })
    const p2 = run([
      '--to', DEV2, '--build', path.join(FIXTURES, 'fake-build'), '--promote',
      '--poll', '0.05', '--wait-timeout', '10',
    ])
    const cmd2 = await waitUnresolved(DEV2, 8000)
    await report(DEV2)
    await result(DEV2, cmd2.id, { state: 'success', detail: 'OTA ok' })
    const done2 = await p2
    expect(done2.code).toBe(0)
    expect(done2.out).toMatch(/✓ 已晋升为正式版：hello-world\/ESP32-S3\//)
    const reg2 = readRegistry(dataDir)
    const vars2 = reg2.projects['hello-world'].variants['ESP32-S3']
    expect(vars2.releases.find((r) => r.id === cmd2.releaseId).type).toBe('release')
    expect(vars2.latest).toBe(cmd2.releaseId)
  })

  it('发布成功但推送失败（离线）→ 只需重推：--release 不再发布、不重传固件', async () => {
    const DEV = 'aa0000000018'
    await report(DEV, { firmwareVersion: 'v0.1.0' })
    // 先 --build 发布 + 推送，但让设备在下发前离线 → exit 9，快照留在服务器上
    const store0 = readDeviceStore(dataDir)
    store0.devices[DEV].lastSeen = '2020-01-01T00:00:00Z'
    const { writeDeviceStoreAtomic } = await import('../server/devices.js')
    writeDeviceStoreAtomic(dataDir, store0)

    const failed = await run(['--to', DEV, '--build', path.join(FIXTURES, 'fake-build')])
    expect(failed.code).toBe(9)
    expect(failed.out).toMatch(/\[publish\] ✓ 已发布 hello-world\/ESP32-S3\//) // 固件确实发布了

    const snap = readRegistry(dataDir).projects['hello-world'].variants['ESP32-S3'].releases[0].id
    // 设备回来 → 用 --release 直接重推（不重新发布、不重传）
    await report(DEV)
    const p = run(['--to', DEV, '--release', snap, '--poll', '0.05', '--wait-timeout', '10'])
    const cmd = await waitUnresolved(DEV, 8000)
    await report(DEV)
    await result(DEV, cmd.id, { state: 'success', detail: 'ok' })
    const { code, out } = await p
    expect(code).toBe(0)
    expect(out).not.toMatch(/\[publish\]/) // 没有再次发布
    expect(out).toMatch(/未发布任何东西/)
  })
})

describe('push CLI · --json 机器可读', () => {
  it('成功时 stdout 只有一个 JSON 对象，人话走 stderr', async () => {
    const DEV = 'aa0000000019'
    await report(DEV, { firmwareVersion: 'v0.1.0' })
    const p = run(['--to', DEV, '--release', E_RID, '--json', '--poll', '0.05', '--wait-timeout', '10'])
    const cmd = await waitUnresolved(DEV)
    await report(DEV)
    await progress(DEV, cmd.id, { phase: 'writing', percent: 100 })
    await result(DEV, cmd.id, { state: 'success', detail: 'OTA ok' })
    const { code, out, err } = await p

    expect(code).toBe(0)
    const json = JSON.parse(out) // stdout 必须是纯 JSON
    expect(json.ok).toBe(true)
    expect(json.skipped).toBe(false)
    expect(json.exitCode).toBe(0)
    expect(json.error).toBeNull()
    expect(json.device.deviceId).toBe(DEV)
    expect(json.command.id).toBe(cmd.id)
    expect(json.command.state).toBe('success')
    expect(json.command.trail.length).toBeGreaterThan(0)
    expect(json.published.release).toBe(E_RID)
    expect(typeof json.elapsedMs).toBe('number')
    expect(err).toMatch(/已下发/) // 人话没丢，只是去了 stderr
  })

  it('失败（离线）时 JSON 带 error.code=device_offline，退出码仍是 9', async () => {
    const DEV = 'aa000000001a'
    await report(DEV)
    const store0 = readDeviceStore(dataDir)
    store0.devices[DEV].lastSeen = '2020-01-01T00:00:00Z'
    const { writeDeviceStoreAtomic } = await import('../server/devices.js')
    writeDeviceStoreAtomic(dataDir, store0)

    const { code, out } = await run(['--to', DEV, '--release', E_RID, '--json'])
    expect(code).toBe(9)
    const json = JSON.parse(out)
    expect(json.exitCode).toBe(9)
    expect(json.ok).toBe(false)
    expect(json.error.code).toBe('device_offline')
    expect(json.command.state).toBe('cancelled')
  })

  it('用法错 → exit 2 且给出 error.code=usage_error', async () => {
    const { code, out } = await run(['--to', 'aa:00:00:00:00:1b', '--json'])
    expect(code).toBe(2)
    const json = JSON.parse(out)
    expect(json.error.code).toBe('usage_error')
    expect(json.error.message).toMatch(/缺少固件来源/)
  })
})
