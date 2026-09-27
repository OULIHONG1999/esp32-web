import { classifyError, type ClassifiedError, type SessionPhase } from './errors'

export interface ChipInfo {
  name: string
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
 * 设备常驻连接模型（DESIGN §4.1，2026-09-26 方向1 重构）：
 * 端口授权与连接是长生命周期，烧录/擦除/复位是短暂的"临界区"，
 * 实时日志流在 connected(ready) 态默认开启，临界区期间自动挂起、结束自动恢复。
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
  flash(parts: FlashPart[], onProgress: (p: Progress) => void): Promise<void>
  erase(): Promise<void>
  hardReset(): Promise<void>
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

export class DeviceManager {
  state: DeviceState = 'disconnected'
  chip: ChipInfo | null = null
  lastError: ClassifiedError | null = null
  progress: Progress | null = null

  private listeners = new Set<() => void>()
  private lineHandler: (line: string) => void = () => {}
  private noticeHandler: (message: string) => void = () => {}
  private streamOn = false

  constructor(private deps: DeviceDeps) {}

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
          this.noticeHandler(message ?? '设备连接中断')
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
      this.chip = await this.deps.detect()
      // 互斥编排：识别用的 esptool 会话必须先归还端口，日志流才能 open
      await this.deps.closeEsptool()
      await this.openStream()
      this.transition('ready')
    } catch (err) {
      const cls = classifyError(err, 'connect')
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
      await this.openStream()
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
      await this.deps.flash(parts, (p) => {
        this.progress = p
        this.emit()
      })
      // F-07：写入完成后自动硬复位，让设备立即运行新固件
      await this.deps.hardReset()
    })
  }

  async erase(): Promise<void> {
    await this.runCritical('erase', () => this.deps.erase())
  }

  async hardReset(): Promise<void> {
    await this.runCritical('hardReset', () => this.deps.hardReset())
  }
}
