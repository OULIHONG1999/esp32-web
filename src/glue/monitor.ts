import { createLineSplitter } from '../core/lines'

export type MonitorHandlers = {
  onLine: (line: string) => void
  onStopped: (reason: 'user' | 'error', message?: string) => void
}

/**
 * Web Serial 实时日志监视器：打开已授权端口持续读取，按行回调。
 * 与烧录会话互斥——必须在 FlashSession 回到 idle（端口已释放）后使用。
 */
export class SerialMonitor {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private port: SerialPort | null = null
  private running = false
  private stopReason: 'user' | 'error' = 'user'

  constructor(private handlers: MonitorHandlers) {}

  get isActive(): boolean {
    return this.running
  }

  async start(port: SerialPort, baudRate = 115200): Promise<void> {
    if (this.running) return
    this.stopReason = 'user'
    await port.open({ baudRate })
    this.port = port
    this.running = true
    void this.readLoop(port)
  }

  private async readLoop(port: SerialPort): Promise<void> {
    const decoder = new TextDecoder()
    const splitter = createLineSplitter()
    while (this.running && port.readable) {
      this.reader = port.readable.getReader()
      try {
        while (this.running) {
          const { value, done } = await this.reader.read()
          if (done) break
          if (value) {
            for (const line of splitter.push(decoder.decode(value, { stream: true }))) {
              this.handlers.onLine(line)
            }
          }
        }
      } catch (err) {
        if (this.running) {
          // ★拔线/读取失败：立即自终止（否则 while 继续 → 循环风暴重复报错）
          this.running = false
          this.stopReason = 'error'
          this.handlers.onStopped(
            'error',
            err instanceof Error ? err.message : String(err),
          )
        }
      } finally {
        try {
          this.reader.releaseLock()
        } catch {
          /* 已释放 */
        }
        this.reader = null
      }
    }
    // ★错误退出：必须关闭端口释放 Web Serial 句柄——否则残留导致
    //   下次连接失败"必须刷新页面"（2026-09-29 用户实测）
    if (this.stopReason === 'error') {
      try {
        await port.close()
      } catch {
        /* 设备已物理移除时 close 可能失败——本地状态仍需复位 */
      }
      this.port = null
    } else if (this.stopReason === 'user') {
      for (const line of splitter.flush()) this.handlers.onLine(line)
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    try {
      await this.reader?.cancel()
    } catch {
      /* ignore */
    }
    try {
      await this.port?.close()
    } catch {
      /* ignore */
    }
    this.port = null
    this.handlers.onStopped('user')
  }
}
