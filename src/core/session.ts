import { classifyError, type ClassifiedError, type SessionPhase } from './errors'

export type SessionState =
  | 'idle'
  | 'requesting'
  | 'detecting'
  | 'ready'
  | 'flashing'
  | 'erasing'
  | 'resetting'
  | 'done'
  | 'error'

export interface FlashPart {
  label: string
  address: number
  data: Uint8Array
}

export interface ChipInfo {
  name: string
}

export interface Progress {
  written: number
  total: number
  partIndex: number
}

/** 实际硬件操作由粘合层注入；状态机本身可脱离浏览器单测（DESIGN §4.1） */
export interface SessionDeps {
  requestPort(): Promise<void>
  detect(): Promise<ChipInfo>
  flash(parts: FlashPart[], onProgress: (p: Progress) => void): Promise<void>
  erase(): Promise<void>
  hardReset(): Promise<void>
  release(): Promise<void>
}

type Command = 'connect' | 'flash' | 'erase' | 'hardReset' | 'release'

const TRANSITIONS: Record<SessionState, SessionState[]> = {
  idle: ['requesting'],
  requesting: ['detecting', 'idle', 'error'],
  detecting: ['ready', 'error'],
  ready: ['flashing', 'erasing', 'resetting', 'error'],
  flashing: ['resetting', 'error'],
  erasing: ['ready', 'error'],
  resetting: ['done', 'ready', 'error'],
  done: ['ready', 'flashing', 'erasing', 'resetting', 'error'],
  error: ['idle'],
}

const ALLOWED: Record<Command, SessionState[]> = {
  connect: ['idle'],
  flash: ['ready', 'done'],
  erase: ['ready', 'done'],
  hardReset: ['ready', 'done'],
  release: ['idle', 'ready', 'done', 'error'],
}

const PHASE_OF: Record<Command, SessionPhase> = {
  connect: 'connect',
  flash: 'flash',
  erase: 'erase',
  hardReset: 'reset',
  release: 'connect',
}

export class BusyError extends Error {
  constructor(cmd: Command, state: SessionState) {
    super(`command "${cmd}" not allowed in state "${state}"`)
    this.name = 'BusyError'
  }
}

export class FlashSession {
  state: SessionState = 'idle'
  chip: ChipInfo | null = null
  lastError: ClassifiedError | null = null
  progress: Progress | null = null

  private listeners = new Set<() => void>()

  constructor(private deps: SessionDeps) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  private assert(cmd: Command): void {
    if (!ALLOWED[cmd].includes(this.state)) throw new BusyError(cmd, this.state)
  }

  private transition(to: SessionState): void {
    if (!TRANSITIONS[this.state].includes(to)) {
      throw new Error(`invalid transition ${this.state} -> ${to}`)
    }
    this.state = to
    this.emit()
  }

  private fail(cmd: Command, err: unknown): never {
    const cls = classifyError(err, PHASE_OF[cmd])
    if (cls.cls === 'UserCancel' && (cmd === 'connect' || this.state === 'requesting')) {
      // 用户取消不是错误：回到 idle
      this.state = cmd === 'connect' && this.state !== 'requesting' ? this.state : 'idle'
      this.emit()
      throw err
    }
    this.lastError = cls
    // error 是万能落点，但 requesting→error 需经允许表；直接置位以保证任何失败都可回收
    if (TRANSITIONS[this.state].includes('error')) {
      this.transition('error')
    } else {
      this.state = 'error'
      this.emit()
    }
    throw err
  }

  async connect(): Promise<void> {
    this.assert('connect')
    this.lastError = null
    this.chip = null
    this.transition('requesting')
    try {
      await this.deps.requestPort()
    } catch (err) {
      return this.fail('connect', err)
    }
    this.transition('detecting')
    try {
      this.chip = await this.deps.detect()
    } catch (err) {
      return this.fail('connect', err)
    }
    this.transition('ready')
  }

  async flash(parts: FlashPart[]): Promise<void> {
    this.assert('flash')
    if (parts.length === 0) throw new Error('no firmware parts selected')
    this.progress = { written: 0, total: 0, partIndex: 0 }
    this.transition('flashing')
    try {
      await this.deps.flash(parts, (p) => {
        this.progress = p
        this.emit()
      })
    } catch (err) {
      return this.fail('flash', err)
    }
    this.transition('resetting')
    try {
      await this.deps.hardReset()
    } catch (err) {
      return this.fail('hardReset', err)
    }
    this.transition('done')
  }

  async erase(): Promise<void> {
    this.assert('erase')
    this.transition('erasing')
    try {
      await this.deps.erase()
    } catch (err) {
      return this.fail('erase', err)
    }
    this.transition('ready')
  }

  async hardReset(): Promise<void> {
    this.assert('hardReset')
    this.transition('resetting')
    try {
      await this.deps.hardReset()
    } catch (err) {
      return this.fail('hardReset', err)
    }
    this.transition('ready')
  }

  /** 回收：断开串口并回到 idle（DESIGN 释放纪律） */
  async release(): Promise<void> {
    this.assert('release')
    try {
      await this.deps.release()
    } catch {
      // 释放失败也要回到 idle，避免卡死
    }
    this.state = 'idle'
    this.chip = null
    this.lastError = null
    this.progress = null
    this.emit()
  }
}
