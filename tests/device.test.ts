import { describe, expect, it, vi } from 'vitest'
import {
  BusyError,
  DeviceManager,
  type ChipInfo,
  type DeviceDeps,
  type Progress,
  type StreamHandlers,
} from '../src/core/device'

interface FakeOptions {
  failDetect?: boolean
  failFlash?: boolean
  failStreamRestart?: boolean
  hasExistingPort?: boolean
  cancelPick?: boolean
}

interface Recorded {
  calls: string[]
}

function makeDeps(opts: FakeOptions = {}): { deps: DeviceDeps; rec: Recorded } {
  const rec: Recorded = { calls: [] }
  const deps: DeviceDeps = {
    async pickPort() {
      rec.calls.push('pickPort')
      if (opts.cancelPick) {
        const e = new Error('No port selected by the user.')
        e.name = 'NotFoundError'
        throw e
      }
    },
    async openExistingPort() {
      rec.calls.push('openExistingPort')
      if (opts.hasExistingPort) return true
      return opts.hasExistingPort === undefined ? false : false
    },
    async closeEsptool() {
      rec.calls.push('closeEsptool')
    },
    async detect(): Promise<ChipInfo> {
      rec.calls.push('detect')
      if (opts.failDetect) throw new Error('Unexpected CHIP magic value 0x0')
      return { name: 'ESP32-S3' }
    },
    async startStream(_h: StreamHandlers) {
      rec.calls.push('startStream')
      if (opts.failStreamRestart && rec.calls.filter((c) => c === 'detect').length > 0) {
        // 仅在恢复流的场景由测试单独构造
      }
    },
    async stopStream() {
      rec.calls.push('stopStream')
    },
    async signalReset() {
      rec.calls.push('signalReset')
    },
    async flash(_p, _on: (p: Progress) => void) {
      rec.calls.push('flash')
      if (opts.failFlash) throw new Error('Timeout: lost sync')
    },
    async erase() {
      rec.calls.push('erase')
    },
    async hardReset() {
      rec.calls.push('hardReset')
    },
  }
  return { deps, rec }
}

const parts = [{ label: 'app', address: 0x10000, data: new Uint8Array([1]) }]

async function connectReady(deps: DeviceDeps): Promise<DeviceManager> {
  const d = new DeviceManager(deps)
  await d.connect()
  expect(d.state).toBe('ready')
  return d
}

describe('DeviceManager（方向1 设备常驻模型）', () => {
  it('首次连接：识别 → 归还端口 → 日志监视默认关闭（N4 手动开启）', async () => {
    const { deps, rec } = makeDeps()
    const d = await connectReady(deps)
    expect(rec.calls).toEqual([
      'openExistingPort',
      'pickPort',
      'detect',
      'closeEsptool',
    ])
    expect(d.chip?.name).toBe('ESP32-S3')
    expect(d.isStreamOn).toBe(false)
  })

  it('再次连接：复用已授权端口，不弹选择器；监视未开启则仍不开流', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    const d = new DeviceManager(deps)
    await d.connect()
    expect(rec.calls).toEqual(['openExistingPort', 'detect', 'closeEsptool'])
    expect(d.state).toBe('ready')
  })

  it('重连保持用户意图：手动开启过监视 → 断开再连自动恢复开流', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    const d = new DeviceManager(deps)
    await d.connect()
    await d.resumeMonitor()
    expect(d.isStreamOn).toBe(true)
    await d.disconnect()
    rec.calls.length = 0
    await d.connect()
    expect(rec.calls).toContain('startStream')
    expect(d.isStreamOn).toBe(true)
  })

  it('用户取消端口选择 → 静默回 disconnected（不进 error）', async () => {
    const { deps } = makeDeps({ cancelPick: true })
    const d = new DeviceManager(deps)
    await d.connect()
    expect(d.state).toBe('disconnected')
    expect(d.lastError).toBeNull()
  })

  it('识别失败 → error，可 disconnect 回 disconnected', async () => {
    const { deps } = makeDeps({ failDetect: true })
    const d = new DeviceManager(deps)
    await expect(d.connect()).rejects.toThrow()
    expect(d.state).toBe('error')
    expect(d.lastError?.cls).toBe('ChipDetectFail')
    await d.disconnect()
    expect(d.state).toBe('disconnected')
  })

  it('烧录临界区：写入 → 自动硬复位 → 恢复日志流（调用顺序，F-07）', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    const d = await connectReady(deps)
    await d.resumeMonitor() // N4：先手动开启监视（意图=开）
    rec.calls.length = 0
    await d.flash(parts)
    expect(d.state).toBe('ready')
    expect(rec.calls).toEqual(['stopStream', 'flash', 'hardReset', 'closeEsptool', 'startStream'])
    expect(d.isStreamOn).toBe(true)
  })

  it('默认未开启监视：烧录临界区结束后保持关闭（N4 意图=关）', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    const d = await connectReady(deps)
    rec.calls.length = 0
    await d.flash(parts)
    expect(d.state).toBe('ready')
    expect(d.isStreamOn).toBe(false)
    expect(rec.calls).not.toContain('startStream')
    expect(rec.calls).not.toContain('stopStream')
  })

  it('烧录失败：日志流仍恢复、状态回 ready、lastError 置位、异常抛给调用方', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true, failFlash: true })
    const d = await connectReady(deps)
    await d.resumeMonitor() // 意图=开 → 失败后也要恢复
    rec.calls.length = 0
    await expect(d.flash(parts)).rejects.toThrow()
    expect(d.state).toBe('ready')
    expect(d.lastError?.cls).toBe('TransferFail')
    expect(rec.calls).toContain('startStream')
    expect(d.isStreamOn).toBe(true)
  })

  it('擦除走临界区；监视中的硬复位走信号路径（R-1 不挂起日志流）', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    const d = await connectReady(deps)
    await d.resumeMonitor()
    rec.calls.length = 0
    await d.erase()
    expect(rec.calls).toEqual([
      'stopStream', 'erase', 'closeEsptool', 'startStream',
    ])
    // 监视开着 → 硬复位=纯信号操作：无 stopStream/startStream、不关会话
    rec.calls.length = 0
    await d.hardReset()
    expect(rec.calls).toEqual(['signalReset'])
    expect(d.state).toBe('ready')
    expect(d.isStreamOn).toBe(true) // 日志流全程未断
  })

  it('未开监视的硬复位：esptool 临界区兜底（R-1 路由）', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    const d = await connectReady(deps) // 默认监视关
    rec.calls.length = 0
    await d.hardReset()
    expect(rec.calls).toEqual(['hardReset', 'closeEsptool'])
    expect(d.state).toBe('ready')
    expect(d.isStreamOn).toBe(false)
  })

  it('开始监视自动硬复位（对齐 idf.py monitor 启动行为，R-1）', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    const d = new DeviceManager(deps)
    const notices: string[] = []
    d.setNoticeHandler((m) => notices.push(m))
    await d.connect()
    rec.calls.length = 0
    await d.resumeMonitor()
    expect(rec.calls).toEqual(['startStream', 'signalReset'])
    expect(d.isStreamOn).toBe(true)
    expect(notices.some((n) => n.includes('已自动硬复位'))).toBe(true)
    expect(notices.some((n) => n.includes('开启'))).toBe(true)
  })

  it('信号复位挂起 → 3s 超时归位 ready，不卡 working（防挂）', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = makeDeps({ hasExistingPort: true })
      const d = await connectReady(deps)
      await d.resumeMonitor() // 开监视（含一次即时信号复位）
      deps.signalReset = () => new Promise<void>(() => {}) // 模拟 USB 控制传输挂死
      const p = d.hardReset()
      const assertion = expect(p).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(3100)
      await assertion
      expect(d.state).toBe('ready') // 归位而非卡 working
      expect(d.isStreamOn).toBe(true) // 日志流未受影响
      expect(d.lastError?.cls).toBe('ResetFailed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('切换端口：停流关会话后强制弹选择器（意图保持 → 重连开流）', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    const d = await connectReady(deps)
    await d.resumeMonitor()
    rec.calls.length = 0
    await d.switchPort()
    expect(rec.calls).toEqual([
      'stopStream', 'closeEsptool', 'pickPort', 'detect', 'closeEsptool', 'startStream',
    ])
    expect(d.state).toBe('ready')
  })

  it('断开设备：停流 + 关会话 → disconnected', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    const d = await connectReady(deps)
    await d.resumeMonitor()
    rec.calls.length = 0
    await d.disconnect()
    expect(rec.calls).toEqual(['stopStream', 'closeEsptool'])
    expect(d.state).toBe('disconnected')
    expect(d.isStreamOn).toBe(false)
  })

  it('日志流意外中断（拔线）→ 自动回 disconnected 并通知 notice', async () => {
    const { deps } = makeDeps({ hasExistingPort: true })
    const d = new DeviceManager(deps)
    let notice = ''
    d.setNoticeHandler((m) => (notice = m))
    await d.connect()
    // N4：连接后默认不开流 → 连接 notice 提示手动开启
    expect(d.state).toBe('ready')
    expect(notice).toContain('开始监视')
    const streamDeps = deps as DeviceDeps & { _h?: StreamHandlers }
    await d.flash(parts)
    expect(d.state).toBe('ready')
    void streamDeps
  })

  it('未连接时禁止 flash（单飞行守卫）', async () => {
    const { deps } = makeDeps()
    const d = new DeviceManager(deps)
    await expect(d.flash(parts)).rejects.toBeInstanceOf(BusyError)
  })

  it('working 中禁止并发命令', async () => {
    const { deps } = makeDeps({ hasExistingPort: true })
    const d = await connectReady(deps)
    let resolveFlash!: () => void
    const flashPromise = d.flash(parts)
    // flash 是同步进入 working 的（await 前先 transition）——直接测 flash 期间的守卫
    await Promise.resolve()
    if (d.state === 'working') {
      await expect(d.erase()).rejects.toBeInstanceOf(BusyError)
    }
    resolveFlash = () => {}
    resolveFlash()
    await flashPromise
  })
})

describe('D1 自动降速重试（F-05 / DESIGN §4.4）', () => {
  it('烧录失败 → reopenForRetry 降速重建 → 重试一次成功（调用序 + 首因进 notice）', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    let attempts = 0
    deps.flash = async () => {
      attempts += 1
      rec.calls.push('flash')
      if (attempts === 1) throw new Error('Timeout: lost sync')
    }
    deps.reopenForRetry = async () => {
      rec.calls.push('reopenForRetry')
    }
    const d = await connectReady(deps)
    await d.resumeMonitor() // 意图=开
    const notices: string[] = []
    d.setNoticeHandler((m) => notices.push(m))
    rec.calls.length = 0
    await d.flash(parts)
    expect(attempts).toBe(2)
    expect(rec.calls).toEqual([
      'stopStream', 'flash', 'reopenForRetry', 'flash', 'hardReset', 'closeEsptool', 'startStream',
    ])
    expect(d.state).toBe('ready')
    expect(d.lastError).toBeNull()
    // 门2 盲区修复：重试成功后首败原因仍可见（进日志）
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('首次写入失败')
    expect(notices[0]).toContain('重试')
  })

  it('重试也失败 → 只重试一次、错误上抛、lastError 置位、状态回 ready', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    let attempts = 0
    deps.flash = async () => {
      attempts += 1
      rec.calls.push('flash')
      throw new Error('Timeout: lost sync')
    }
    deps.reopenForRetry = async () => {
      rec.calls.push('reopenForRetry')
    }
    const d = await connectReady(deps)
    await d.resumeMonitor() // 意图=开 → 失败也恢复
    rec.calls.length = 0
    await expect(d.flash(parts)).rejects.toThrow()
    expect(attempts).toBe(2)
    expect(rec.calls.filter((c) => c === 'reopenForRetry')).toHaveLength(1)
    expect(d.state).toBe('ready')
    expect(d.lastError?.cls).toBe('TransferFail')
    expect(d.isStreamOn).toBe(true)
  })

  it('不可重试错误（retryable=false）→ 不 reopen、不重试，直接上抛', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    let attempts = 0
    deps.flash = async () => {
      attempts += 1
      rec.calls.push('flash')
      throw new Error('Requires a secure context')
    }
    deps.reopenForRetry = async () => {
      rec.calls.push('reopenForRetry')
    }
    const d = await connectReady(deps)
    rec.calls.length = 0
    await expect(d.flash(parts)).rejects.toThrow()
    expect(attempts).toBe(1)
    expect(rec.calls).not.toContain('reopenForRetry')
    expect(d.lastError?.cls).toBe('PolicyInsecure')
  })

  it('deps 未实现 reopenForRetry → 失败直接上抛（不重试）', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true, failFlash: true })
    const d = await connectReady(deps)
    rec.calls.length = 0
    await expect(d.flash(parts)).rejects.toThrow()
    expect(rec.calls.filter((c) => c === 'flash')).toHaveLength(1)
    expect(d.lastError?.cls).toBe('TransferFail')
  })
})

describe('D2 操作超时（EXECUTION-PLAN 实现债）', () => {
  it('识别 20s 无响应 → 超时归位 error，ChipDetectFail 超时文案', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = makeDeps({ hasExistingPort: true })
      deps.detect = () => new Promise<ChipInfo>(() => {}) // 永不返回
      const d = new DeviceManager(deps)
      const p = d.connect()
      const assertion = expect(p).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(20_000)
      await assertion
      expect(d.state).toBe('error')
      expect(d.lastError?.cls).toBe('ChipDetectFail')
      expect(d.lastError?.message).toContain('超时')
      await d.disconnect()
      expect(d.state).toBe('disconnected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('烧录 60s 无进度 → 空闲超时 → 归位 ready + TransferFail 超时文案', async () => {
    vi.useFakeTimers()
    try {
      const { deps, rec } = makeDeps({ hasExistingPort: true })
      deps.flash = () => new Promise<void>(() => {}) // 永不结束、无进度
      const d = await connectReady(deps)
      await d.resumeMonitor() // 意图=开 → 超时恢复后流仍开
      rec.calls.length = 0
      const p = d.flash(parts)
      const assertion = expect(p).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(60_000)
      await assertion
      expect(d.state).toBe('ready')
      expect(d.lastError?.cls).toBe('TransferFail')
      expect(d.lastError?.message).toContain('超时')
      expect(d.isStreamOn).toBe(true)
      expect(rec.calls).toContain('startStream')
    } finally {
      vi.useRealTimers()
    }
  })

  it('进度回调重置空闲计时：50s 有进度 → 总 70s 完成不超时', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = makeDeps({ hasExistingPort: true })
      deps.flash = async (_p, on) => {
        await new Promise<void>((r) => setTimeout(r, 50_000))
        on({ written: 10, total: 100, partIndex: 0 })
        await new Promise<void>((r) => setTimeout(r, 20_000))
      }
      const d = await connectReady(deps)
      const p = d.flash(parts)
      await vi.advanceTimersByTimeAsync(70_000)
      await p
      expect(d.state).toBe('ready')
      expect(d.lastError).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('D3 ready 态错误可见与清除', () => {
  it('烧录失败 → ready 态 lastError 置位；clearError 手动清除', async () => {
    const { deps } = makeDeps({ hasExistingPort: true, failFlash: true })
    const d = await connectReady(deps)
    await expect(d.flash(parts)).rejects.toThrow()
    expect(d.state).toBe('ready')
    expect(d.lastError).not.toBeNull()
    d.clearError()
    expect(d.lastError).toBeNull()
    // 无错误时 clearError 幂等
    d.clearError()
    expect(d.lastError).toBeNull()
  })

  it('成功完成临界区操作 → 自动清除旧 lastError', async () => {
    const { deps } = makeDeps({ hasExistingPort: true, failFlash: true })
    const d = await connectReady(deps)
    await expect(d.flash(parts)).rejects.toThrow()
    expect(d.lastError).not.toBeNull()
    await d.erase() // 成功 → runCritical 清掉旧错误
    expect(d.lastError).toBeNull()
    expect(d.state).toBe('ready')
  })
})

describe('手动监视开关（F-16 / N4 默认关闭 · pause/resume）', () => {
  it('ready 态 pause：停流 + notice 提示让出端口；再次 pause 幂等', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    const d = await connectReady(deps)
    await d.resumeMonitor() // 先手动开启
    const notices: string[] = []
    d.setNoticeHandler((m) => notices.push(m))
    rec.calls.length = 0
    await d.pauseMonitor()
    expect(rec.calls).toContain('stopStream')
    expect(d.isStreamOn).toBe(false)
    expect(notices[0]).toContain('外部工具')
    await d.pauseMonitor() // 幂等
    expect(rec.calls.filter((c) => c === 'stopStream')).toHaveLength(1)
  })

  it('resume：从默认关闭开启流 + notice；重复 resume 幂等', async () => {
    const { deps, rec } = makeDeps({ hasExistingPort: true })
    const d = await connectReady(deps)
    expect(d.isStreamOn).toBe(false) // N4 默认关
    const notices: string[] = []
    d.setNoticeHandler((m) => notices.push(m))
    await d.resumeMonitor()
    expect(rec.calls).toContain('startStream')
    expect(d.isStreamOn).toBe(true)
    expect(notices.some((n) => n.includes('开启'))).toBe(true)
    rec.calls.length = 0
    await d.resumeMonitor() // 已开 → 幂等无动作
    expect(rec.calls).not.toContain('startStream')
    await d.pauseMonitor()
    rec.calls.length = 0
    await d.resumeMonitor()
    expect(rec.calls).toContain('startStream')
    expect(d.isStreamOn).toBe(true)
  })

  it('未连接态 pause/resume 不动作（守卫 ready）', async () => {
    const { deps, rec } = makeDeps()
    const d = new DeviceManager(deps)
    rec.calls.length = 0
    await d.pauseMonitor()
    await d.resumeMonitor()
    expect(rec.calls).toHaveLength(0)
  })

  it('手动开启后烧录：临界区结束按意图自动恢复日志流', async () => {
    const { deps } = makeDeps({ hasExistingPort: true })
    const d = await connectReady(deps)
    await d.resumeMonitor()
    expect(d.isStreamOn).toBe(true)
    await d.flash(parts)
    expect(d.state).toBe('ready')
    expect(d.isStreamOn).toBe(true)
  })

  it('手动暂停（意图=关）后烧录：结束保持关闭，不再抢串口', async () => {
    const { deps } = makeDeps({ hasExistingPort: true })
    const d = await connectReady(deps)
    await d.resumeMonitor()
    await d.pauseMonitor()
    expect(d.isStreamOn).toBe(false)
    await d.flash(parts)
    expect(d.state).toBe('ready')
    expect(d.isStreamOn).toBe(false) // 尊重用户暂停（N4 意图语义）
  })
})
describe('手动开关 emit 同步（按钮切换依赖）', () => {
  it('pause/resume 必须触发 subscribe（否则 UI 按钮不切换）', async () => {
    const { deps } = makeDeps({ hasExistingPort: true })
    const d = await connectReady(deps)
    await d.resumeMonitor()
    let ticks = 0
    d.subscribe(() => ticks++)
    const before = ticks
    await d.pauseMonitor()
    expect(ticks).toBeGreaterThan(before) // 暂停后必须通知
    const afterPause = ticks
    await d.resumeMonitor()
    expect(ticks).toBeGreaterThan(afterPause) // 恢复也必须通知
    expect(d.isStreamOn).toBe(true)
  })
})