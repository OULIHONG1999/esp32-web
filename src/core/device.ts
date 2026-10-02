import { classifyError, type ClassifiedError, type SessionPhase } from './errors'

export interface ChipInfo {
  name: string
  /** F-12 芯片详情（检测阶段读取，任一字段可缺省——旧数据/读取失败兼容） */
  mac?: string
  revision?: string
  flashSize?: string
}

export interface FlashPart {
  label: string
  address: number
  data: Uint8Array
}

export interface Progress {
  written: number
  total: number
  partIndex: number
}

/**
 * 设备常驻连接模型（DESIGN §4.1，2026-09-26 方向1 重构；2026-10-02 N4/R-1 修订）：
 * 端口授权与连接是长生命周期，烧录/擦除是短暂的"临界区"；
 * **实时日志监视默认关闭**（streamWanted 意图位，手动 ▶ 开启，跨重连保持），
 * 开启时**自动硬复位一次**（对齐 idf.py monitor 启动行为，抓全启动日志），
 * 监视中复位走信号路径（端口不关、日志不断）。
 */
export type DeviceState =
  | 'disconnected'
  | 'requesting'
  | 'detecting'
  | 'ready'
  | 'working'
  | 'error'

export interface StreamHandlers {
  onLine: (line: string) => void
  onStopped: (reason: 'user' | 'error', message?: string) => void
}

/** 硬件操作由 glue/deviceOps 注入；模型本身零浏览器依赖，可单测 */
export interface DeviceDeps {
  /** 弹系统端口选择器；用户取消以异常抛出（UserCancel） */
  pickPort(): Promise<void>
  /** 复用已授权端口；无可用端口返回 false（此时应回退 pickPort） */
  openExistingPort(): Promise<boolean>
  /** 关闭 esptool 会话（端口归还；授权保留） */
  closeEsptool(): Promise<void>
  detect(): Promise<ChipInfo>
  startStream(handlers: StreamHandlers): Promise<void>
  stopStream(): Promise<void>
  /**
   * R-1 信号复位：对【监视已打开】的端口拨硬复位信号（idf.py monitor 同源）——
   * 端口不关、日志流不断、COM 不掉。监视未开启时 glue 抛错。
   */
  signalReset(): Promise<void>
  flash(parts: FlashPart[], onProgress: (p: Progress) => void): Promise<void>
  erase(): Promise<void>
  hardReset(): Promise<void>
  /**
   * D1 自动降速：烧录失败后释放会话、以原波特率/2（下限 115200）重建并重新同步芯片。
   * 返回后由 DeviceManager 重试写入一次。可选——未实现时烧录失败直接上抛（不做重试）。
   */
  reopenForRetry?(): Promise<void>
}

type Command = 'connect' | 'switchPort' | 'flash' | 'erase' | 'hardReset' | 'disconnect'

const TRANSITIONS: Record<DeviceState, DeviceState[]> = {
  disconnected: ['requesting'],
  requesting: ['detecting', 'disconnected', 'error'],
  detecting: ['ready', 'error'],
  ready: ['working', 'requesting', 'disconnected'],
  working: ['ready', 'error'],
  error: ['disconnected', 'requesting'],
}

const ALLOWED: Record<Command, DeviceState[]> = {
  connect: ['disconnected', 'error'],
  switchPort: ['ready'],
  flash: ['ready'],
  erase: ['ready'],
  hardReset: ['ready'],
  disconnect: ['requesting', 'detecting', 'ready', 'error'],
}

const PHASE_OF: Record<Command, SessionPhase> = {
  connect: 'connect',
  switchPort: 'connect',
  flash: 'flash',
  erase: 'erase',
  hardReset: 'reset',
  disconnect: 'connect',
}

export class BusyError extends Error {
  constructor(cmd: Command, state: DeviceState) {
    super(`command "${cmd}" not allowed in state "${state}"`)
    this.name = 'BusyError'
  }
}

export interface ConnectOptions {
  /** true = 强制弹选择器（切换端口） */
  forcePick?: boolean
}

/** D2 操作超时（EXECUTION-PLAN 实现债）；测试可注入更小值 */
export interface DeviceTimeouts {
  /** detect 无响应超时，默认 20s */
  detectMs?: number
  /** flash 无进度（空闲）超时，默认 60s；进度回调会重置计时 */
  flashIdleMs?: number
}

const DEFAULT_TIMEOUTS: Required<DeviceTimeouts> = {
  detectMs: 20_000,
  flashIdleMs: 60_000,
}

/** 限时等待；超时以 name=TimeoutError 抛出，原 promise 的迟到结果被忽略且不会成为未处理拒绝 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const e = new Error(`${what} timed out after ${ms}ms`)
      e.name = 'TimeoutError'
      reject(e)
    }, ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export class DeviceManager {
  state: DeviceState = 'disconnected'
  chip: ChipInfo | null = null
  lastError: ClassifiedError | null = null
  progress: Progress | null = null

  private listeners = new Set<() => void>()
  private lineHandler: (line: string) => void = () => {}
  private noticeHandler: (message: string) => void = () => {}
  private streamOn = false
  /** 用户对日志监视的意图（N4：默认关闭、手动开启；跨重连保持，页面加载为 false） */
  private streamWanted = false
  private readonly detectMs: number
  private readonly flashIdleMs: number

  constructor(
    private deps: DeviceDeps,
    timeouts: DeviceTimeouts = {},
  ) {
    this.detectMs = timeouts.detectMs ?? DEFAULT_TIMEOUTS.detectMs
    this.flashIdleMs = timeouts.flashIdleMs ?? DEFAULT_TIMEOUTS.flashIdleMs
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setLineHandler(fn: (line: string) => void): void {
    this.lineHandler = fn
  }

  /** 设备意外断开等提示（非逐行日志） */
  setNoticeHandler(fn: (message: string) => void): void {
    this.noticeHandler = fn
  }

  get isStreamOn(): boolean {
    return this.streamOn
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  private assert(cmd: Command): void {
    if (!ALLOWED[cmd].includes(this.state)) throw new BusyError(cmd, this.state)
  }

  private transition(to: DeviceState): void {
    if (!TRANSITIONS[this.state].includes(to)) {
      throw new Error(`invalid transition ${this.state} -> ${to}`)
    }
    this.state = to
    this.emit()
  }

  private streamHandlers(): StreamHandlers {
    return {
      onLine: (line) => this.lineHandler(line),
      onStopped: (reason, message) => {
        this.streamOn = false
        if (reason === 'error' && this.state === 'ready') {
          // 拔线/读取异常：设备视为断开
          try {
            this.transition('disconnected')
          } catch {
            this.state = 'disconnected'
            this.emit()
          }
          this.noticeHandler(message ?? '设备连接中断——请重新连接')
        }
      },
    }
  }

  private async openStream(): Promise<void> {
    await this.deps.startStream(this.streamHandlers())
    this.streamOn = true
  }

  private async closeStream(): Promise<void> {
    if (this.streamOn) {
      await this.deps.stopStream()
      this.streamOn = false
    }
  }

  async connect(opts: ConnectOptions = {}): Promise<void> {
    this.assert('connect')
    this.lastError = null
    this.transition('requesting')
    try {
      let got = false
      if (!opts.forcePick) {
        got = await this.deps.openExistingPort()
      }
      if (!got) {
        await this.deps.pickPort()
      }
      this.transition('detecting')
      // D2：识别挂死（驱动/线缆异常）20s 超时 → 归位 error，不锁死 UI
      this.chip = await withTimeout(this.deps.detect(), this.detectMs, 'chip detect')
      // 互斥编排：识别用的 esptool 会话必须先归还端口，日志流才能 open
      await this.deps.closeEsptool()
      // 日志监视默认关闭（2026-10-02 N4）：仅当用户此前手动开启过（streamWanted）才自动恢复
      if (this.streamWanted) {
        await this.openStream()
      }
      this.transition('ready')
      if (!this.streamOn) {
        this.noticeHandler('已连接——实时日志监视默认关闭，点面板「▶ 开始监视」查看设备输出')
      }
    } catch (err) {
      // detect 超时以 phase='detect' 分类（→ ChipDetectFail 超时文案）
      const isTimeout = err instanceof Error && err.name === 'TimeoutError'
      const cls = classifyError(err, isTimeout ? 'detect' : 'connect')
      await this.teardownQuietly()
      if (cls.cls === 'UserCancel') {
        this.state = 'disconnected'
        this.emit()
        return
      }
      this.lastError = cls
      if (TRANSITIONS[this.state].includes('error')) {
        this.transition('error')
      } else {
        this.state = 'error'
        this.emit()
      }
      throw err
    }
  }

  /** 切换端口：先停流关会话，再强制弹选择器 */
  async switchPort(): Promise<void> {
    this.assert('switchPort')
    await this.closeStream()
    await this.deps.closeEsptool()
    this.state = 'disconnected'
    this.emit()
    await this.connect({ forcePick: true })
  }

  async disconnect(): Promise<void> {
    this.assert('disconnect')
    this.lastError = null
    await this.teardownQuietly()
    this.state = 'disconnected'
    this.emit()
  }

  private async teardownQuietly(): Promise<void> {
    try {
      await this.closeStream()
    } catch {
      /* ignore */
    }
    try {
      await this.deps.closeEsptool()
    } catch {
      /* ignore */
    }
    this.streamOn = false
  }

  /** 临界区：挂起日志流 → 执行 → 恢复日志流 */
  private async runCritical(
    cmd: 'flash' | 'erase' | 'hardReset',
    fn: () => Promise<void>,
  ): Promise<void> {
    this.assert(cmd)
    this.transition('working')
    await this.closeStream()
    const phase = PHASE_OF[cmd]
    try {
      await fn()
    } catch (err) {
      const cls = classifyError(err, phase)
      this.lastError = cls
      await this.recoverStream()
      throw err
    }
    // 成功：清掉旧错误（D3 错误条随下一次成功操作自动消失）
    this.lastError = null
    // 成功：recoverStream 内部会先 closeEsptool 再恢复日志流
    await this.recoverStream()
  }

  private async recoverStream(): Promise<void> {
    try {
      await this.deps.closeEsptool()
    } catch {
      /* ignore */
    }
    try {
      // 只恢复用户开启过监视的会话（N4：从未开启 / 已手动暂停 → 保持关闭）
      if (this.streamWanted) {
        await this.openStream()
      }
      this.transition('ready')
    } catch (err) {
      this.lastError = classifyError(err, 'connect')
      this.transition('error')
    }
  }

  async flash(parts: FlashPart[]): Promise<void> {
    if (parts.length === 0) throw new Error('no firmware parts selected')
    this.progress = { written: 0, total: 0, partIndex: 0 }
    await this.runCritical('flash', async () => {
      try {
        await this.flashAttempt(parts)
      } catch (err) {
        // D1：可重试错误 → 降速重建会话后重试一次（仅一次，避免死循环）
        const reopen = this.deps.reopenForRetry?.bind(this.deps)
        const cls = classifyError(err, 'flash')
        if (!cls.retryable || !reopen) throw err
        // 首因进日志（重试成功后 lastError 会被清掉，否则首败不可见——门2 盲区）
        this.noticeHandler(`首次写入失败（${cls.message}），自动重建会话重试…`)
        await reopen()
        this.progress = { written: 0, total: 0, partIndex: 0 }
        this.emit()
        await this.flashAttempt(parts)
      }
      // F-07：写入完成后自动硬复位，让设备立即运行新固件
      await this.deps.hardReset()
    })
  }

  /**
   * 单次烧录写入，带 D2 空闲超时：flashIdleMs 内无进度回调 → 以 TimeoutError 拒绝。
   * 底层写入若在超时后仍在进行，其结果被忽略且不会泄漏为未处理拒绝。
   */
  private flashAttempt(parts: FlashPart[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      const settle = (fn: () => void): void => {
        settled = true
        if (timer) clearTimeout(timer)
        fn()
      }
      const arm = (): void => {
        if (settled) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          const e = new Error(`flash idle for ${this.flashIdleMs}ms without progress`)
          e.name = 'TimeoutError'
          settle(() => reject(e))
        }, this.flashIdleMs)
      }
      arm()
      this.deps.flash(parts, (p) => {
        this.progress = p
        this.emit()
        arm()
      }).then(
        () => settle(() => resolve()),
        (err) => settle(() => reject(err)),
      )
    })
  }

  /** D3：用户手动关闭 ready 态错误条 */
  clearError(): void {
    if (!this.lastError) return
    this.lastError = null
    this.emit()
  }

  async erase(): Promise<void> {
    await this.runCritical('erase', () => this.deps.erase())
  }

  async hardReset(): Promise<void> {
    this.assert('hardReset')
    // R-1 智能路由：监视开着 → 信号复位（端口由监视持有，不挂起日志流）；
    // 监视未开 → 原 esptool 临界区路径（端口空闲，会话可用）兜底。
    if (this.streamOn) {
      this.transition('working')
      try {
        await this.deps.signalReset()
        this.lastError = null
        this.noticeHandler('已硬复位（端口保持、日志不断流）')
        this.transition('ready')
      } catch (err) {
        this.lastError = classifyError(err, PHASE_OF.hardReset)
        // 流未被挂起，直接归位 ready（端口仍在）
        this.transition('ready')
        throw err
      }
      return
    }
    await this.runCritical('hardReset', () => this.deps.hardReset())
  }

  /**
   * 手动暂停实时日志（F-16 · N4 后为「关闭监视」语义）：
   * 释放串口 → 本机 idf.py monitor 等外部工具可占用；意图置为关闭，烧录后不再自动恢复。
   * ready 态有效，幂等。
   */
  async pauseMonitor(): Promise<void> {
    if (this.state !== 'ready' || !this.streamOn) return
    this.streamWanted = false
    await this.closeStream()
    this.noticeHandler('已停止实时日志监视——串口已释放，可使用外部工具（如 idf.py monitor）')
    this.emit() // 通知订阅方刷新 streamOn/按钮（缺此行则按钮不切换）
  }

  /**
   * 手动开启实时日志（N4：连接后默认关闭，由此入口打开）；
   * 意图置为开启——之后烧录临界区结束与重连都会自动恢复。ready 态幂等。
   * R-1：开启后**自动硬复位一次**（esp_idf_monitor `open_serial(reset=True)` 同款，
   * 官方 idf.py monitor 启动默认行为）→ 从 ROM 第一行开始抓启动日志。
   */
  async resumeMonitor(): Promise<void> {
    if (this.state !== 'ready' || this.streamOn) return
    this.streamWanted = true
    await this.openStream()
    await this.deps.signalReset()
    this.noticeHandler('实时日志监视已开启——已自动硬复位（同 idf.py monitor：从启动日志开头显示）')
    this.emit() // 同上：开启后按钮须切回"停止监视"
  }
}
