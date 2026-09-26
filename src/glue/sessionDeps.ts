import type { ChipInfo, FlashPart, Progress, SessionDeps } from '../core/session'
import type { Logger } from '../core/log'
import {
  detectChip,
  eraseFlash,
  hardReset,
  openSession,
  releaseSession,
  requestPort,
  writeFlash,
  type PortSession,
} from './esptool'

/** 把 glue 函数组装成 FlashSession 可注入的 SessionDeps；内部持有活动端口会话 */
export function createSessionDeps(log: Logger, baudrate = 115200) {
  let active: PortSession | null = null

  const requireSession = (): PortSession => {
    if (!active) throw new Error('serial session not opened')
    return active
  }

  const deps: SessionDeps = {
    async requestPort(): Promise<void> {
      const port = await requestPort()
      active = openSession(port, log, baudrate)
      log.add({ level: 'info', source: 'app', text: '已选择串口，建立 Transport' })
    },

    async detect(): Promise<ChipInfo> {
      const info = await detectChip(requireSession())
      log.add({ level: 'info', source: 'app', text: `芯片识别成功：${info.name}` })
      return info
    },

    async flash(parts: FlashPart[], onProgress: (p: Progress) => void): Promise<void> {
      const total = parts.reduce((n, p) => n + p.data.byteLength, 0)
      log.add({
        level: 'info',
        source: 'app',
        text: `开始烧录 ${parts.length} 段，共 ${total} 字节`,
      })
      await writeFlash(requireSession(), parts, onProgress)
      log.add({ level: 'info', source: 'app', text: '烧录写入完成' })
    },

    async erase(): Promise<void> {
      log.add({ level: 'warn', source: 'app', text: '开始全片擦除…' })
      await eraseFlash(requireSession())
      log.add({ level: 'info', source: 'app', text: '擦除完成' })
    },

    async hardReset(): Promise<void> {
      log.add({ level: 'info', source: 'app', text: '发送硬复位，设备重启' })
      await hardReset(requireSession())
    },

    async release(): Promise<void> {
      if (active) {
        await releaseSession(active)
        active = null
        log.add({ level: 'info', source: 'app', text: '串口已断开释放' })
      }
    },
  }

  return deps
}
