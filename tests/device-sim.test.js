import { describe, expect, it } from 'vitest'
import {
  buildDevices,
  buildReportBody,
  decideAck,
  deviceIdFromSeed,
  formatMac,
  parseArgs,
} from '../tools/device-sim/lib.js'

describe('device-sim：deviceId 派生与展示', () => {
  it('同一 seed 稳定派生，12 位小写十六进制', () => {
    const a = deviceIdFromSeed('device-sim-1')
    expect(a).toBe(deviceIdFromSeed('device-sim-1'))
    expect(a).toMatch(/^[0-9a-f]{12}$/)
  })

  it('不同 seed 派生不同 id', () => {
    expect(deviceIdFromSeed('device-sim-1')).not.toBe(deviceIdFromSeed('device-sim-2'))
  })

  it('formatMac 只在合法 12 位 hex 时加冒号', () => {
    expect(formatMac('3485a1b2c3d4')).toBe('34:85:a1:b2:c3:d4')
    expect(formatMac('not-a-mac')).toBe('not-a-mac')
  })
})

describe('device-sim：report 请求体', () => {
  it('给缺省值；uptimeMs 取整非负', () => {
    const b = buildReportBody({ uptimeMs: 1234.7 })
    expect(b.chip).toBe('ESP32-S3')
    expect(b.sdkVersion).toBe('v6.0.1')
    expect(b.uptimeMs).toBe(1235)
  })

  it('传入 ip 才带 ip 字段（否则由服务端按 socket 回填）', () => {
    expect(buildReportBody({}).ip).toBeUndefined()
    expect(buildReportBody({ ip: '192.168.31.9' }).ip).toBe('192.168.31.9')
  })

  it('uptimeMs 负数/NaN 归一为 0', () => {
    expect(buildReportBody({ uptimeMs: -5 }).uptimeMs).toBe(0)
    expect(buildReportBody({ uptimeMs: 'abc' }).uptimeMs).toBe(0)
  })
})

describe('device-sim：回执判定', () => {
  it('sha256 不匹配 → 必失败（优先于 failRate）', () => {
    expect(decideAck({ shaMatch: false, failRate: 1, random: () => 0 }).state).toBe('failed')
    expect(decideAck({ shaMatch: false }).reason).toBe('sha256 mismatch')
  })

  it('校验通过且 failRate=0 → 成功', () => {
    expect(decideAck({ shaMatch: true, failRate: 0 }).state).toBe('success')
  })

  it('failRate=1 → 必失败；failRate=0.5 时按随机数分界', () => {
    expect(decideAck({ shaMatch: true, failRate: 1, random: () => 0.99 }).state).toBe('failed')
    expect(decideAck({ shaMatch: true, failRate: 0.5, random: () => 0.49 }).state).toBe('failed')
    expect(decideAck({ shaMatch: true, failRate: 0.5, random: () => 0.51 }).state).toBe('success')
  })

  it('cmd.sha256 缺失（null）不算不匹配，走正常分支', () => {
    expect(decideAck({ shaMatch: true }).state).toBe('success')
  })
})

describe('device-sim：参数解析', () => {
  it('默认值：本地 8787、1 台、15s、不 dry-run', () => {
    const o = parseArgs([])
    expect(o.server).toBe('http://127.0.0.1:8787')
    expect(o.devices).toBe(1)
    expect(o.interval).toBe(15)
    expect(o.dryRun).toBe(false)
    expect(o.once).toBe(false)
  })

  it('server 尾部斜杠被裁掉（避免拼出 //api）', () => {
    expect(parseArgs(['--server', 'http://h:80///']).server).toBe('http://h:80')
  })

  it('--id 优先于 --devices，并按 id 数量确定设备数', () => {
    const o = parseArgs(['--devices', '5', '--id', '3485a1b2c3d4', '--id', '7c9ebd112233'])
    expect(o.devices).toBe(2)
    expect(buildDevices(o).map((d) => d.id)).toEqual(['3485a1b2c3d4', '7c9ebd112233'])
  })

  it('数值越界或非法 → 抛错（不静默取默认值）', () => {
    expect(() => parseArgs(['--interval', '0'])).toThrow()
    expect(() => parseArgs(['--fail-rate', '2'])).toThrow()
    expect(() => parseArgs(['--devices', 'abc'])).toThrow()
    expect(() => parseArgs(['--devices'])).toThrow()
    expect(() => parseArgs(['--nope'])).toThrow()
  })

  it('--help 可识别', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
  })
})

describe('device-sim：设备清单', () => {
  it('按序派生稳定 id，且互不相同', () => {
    const list = buildDevices({ devices: 3, ids: [] })
    expect(list).toHaveLength(3)
    expect(new Set(list.map((d) => d.id)).size).toBe(3)
    expect(list[0].id).toBe(deviceIdFromSeed('device-sim-1'))
  })
})
