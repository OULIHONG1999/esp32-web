export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'transfer' | 'device'
export type LogSource = 'loader' | 'serial' | 'app' | 'device'

export interface LogEntry {
  ts: number
  level: LogLevel
  source: LogSource
  text: string
  bytes?: number
}

type Listener = (entry: LogEntry) => void

/** 环形缓冲日志服务（DESIGN §4.2）：内存有界、可订阅、可导出 */
export class Logger {
  private entries: LogEntry[] = []
  private listeners = new Set<Listener>()

  constructor(private capacity = 2000) {}

  add(entry: Omit<LogEntry, 'ts'> & { ts?: number }): LogEntry {
    const full: LogEntry = { ts: entry.ts ?? Date.now(), ...entry }
    this.entries.push(full)
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity)
    }
    for (const l of this.listeners) l(full)
    return full
  }

  /** esptool 原始输出入口：保留原文，按行分级 */
  addLoaderLine(line: string): LogEntry | null {
    const text = line.replace(/\s+$/, '')
    if (!text) return null
    const c = classifyLoaderLine(text)
    return this.add({ level: c.level, source: c.source, text })
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): readonly LogEntry[] {
    return this.entries
  }

  clear(): void {
    this.entries = []
  }

  exportText(): string {
    return this.entries
      .map((e) => {
        const t = new Date(e.ts).toISOString()
        return `[${t}] [${e.level}] [${e.source}] ${e.text}`
      })
      .join('\n')
  }
}

const DEVICE_PATTERNS: RegExp[] = [
  /^(connecting|detecting chip|chip is|features:|crystal|mac:|uploading stub|running stub|stub running|changing baudrate|changed |configuring flash|flash id|detected flash|writing at|hash of data|verified |hard resetting|starting rom|boot rom|warning:|unexpected|ordinal|python version)/i,
  /^\s*ets\b/i,
  /ESP-ROM:/,
]

/** 解析 esptool/stub 输出行 → 级别与来源（保留原文，解析只做分级） */
export function classifyLoaderLine(line: string): Pick<LogEntry, 'level' | 'source'> {
  if (/\d{1,3}\s*%|compressed \d+ bytes/i.test(line)) {
    return { level: 'transfer', source: 'device' }
  }
  if (/\b(error|failed|failure|exception|traceback|fatal)\b/i.test(line)) {
    return { level: 'error', source: 'loader' }
  }
  if (/\bwarn(ing)?\b/i.test(line)) {
    return { level: 'warn', source: 'loader' }
  }
  for (const p of DEVICE_PATTERNS) {
    if (p.test(line)) return { level: 'device', source: 'device' }
  }
  return { level: 'info', source: 'loader' }
}
