import type { ChipInfo, DeviceDeps, FlashPart, Progress, StreamHandlers } from '../core/device'
import type { Logger } from '../core/log'
import type { FlashOptions } from 'esptool-js'
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
import { SerialMonitor } from './monitor'

export type FlashParamOverrides = Partial<
  Pick<FlashOptions, 'flashMode' | 'flashFreq' | 'flashSize'>
>

/** 降速下限（DESIGN §4.4 自动降速策略） */
const MIN_BAUD = 115200

export interface DeviceOps extends DeviceDeps {
  setFlashParams(p: FlashParamOverrides): void
}

/**
 * DeviceDeps 的 glue 实现（方向1）：
 * - 端口授权长期保留（lastPort）
 * - 日志流（SerialMonitor）与 esptool 会话互斥：谁工作谁持锁，端口独占
 * - esptool 操作前须由上层先 stopStream；操作后 closeEsptool 归还
 */
export function createDeviceOps(log: Logger, baudrate = 115200): DeviceOps {
  let lastPort: SerialPort | null = null
  let esptool: PortSession | null = null
  let monitor: SerialMonitor | null = null
  let flashParams: FlashParamOverrides = {}

  const ensureEsptool = (): PortSession => {
    if (!lastPort) throw new Error('serial port not selected')
    if (!esptool) {
      esptool = openSession(lastPort, log, baudrate)
      log.add({ level: 'debug', source: 'app', text: 'esptool 会话已建立' })
    }
    return esptool
  }

  return {
    setFlashParams(p: FlashParamOverrides): void {
      flashParams = { ...flashParams, ...p }
      log.add({
        level: 'debug',
        source: 'app',
        text: `烧录参数：mode=${flashParams.flashMode ?? 'dio'} freq=${flashParams.flashFreq ?? '40m'} size=${flashParams.flashSize ?? '4MB'}`,
      })
    },

    async pickPort(): Promise<void> {
      lastPort = await requestPort()
      log.add({ level: 'info', source: 'app', text: `已选择端口（授权已记录，后续连接免弹窗）` })
    },

    async openExistingPort(): Promise<boolean> {
      return lastPort !== null
    },

    async closeEsptool(): Promise<void> {
      if (esptool) {
        await releaseSession(esptool)
        esptool = null
        log.add({ level: 'debug', source: 'app', text: 'esptool 会话已关闭' })
      }
    },

    async detect(): Promise<ChipInfo> {
      const info = await detectChip(ensureEsptool())
      log.add({ level: 'info', source: 'app', text: `芯片识别成功：${info.name}` })
      return info
    },

    async startStream(handlers: StreamHandlers): Promise<void> {
      if (!lastPort) throw new Error('serial port not selected')
      if (monitor) return
      monitor = new SerialMonitor({
        onLine: handlers.onLine,
        onStopped: (reason, message) => {
          monitor = null
          handlers.onStopped(reason, message)
        },
      })
      await monitor.start(lastPort, 115200)
      log.add({ level: 'info', source: 'app', text: '实时日志已自动开启（115200）' })
    },

    async stopStream(): Promise<void> {
      if (monitor) {
        const m = monitor
        monitor = null
        await m.stop()
        log.add({ level: 'debug', source: 'app', text: '实时日志已挂起（进入操作临界区）' })
      }
    },

    async flash(parts: FlashPart[], onProgress: (p: Progress) => void): Promise<void> {
      const total = parts.reduce((n, p) => n + p.data.byteLength, 0)
      log.add({
        level: 'info',
        source: 'app',
        text: `开始烧录 ${parts.length} 段，共 ${total} 字节`,
      })
      await writeFlash(ensureEsptool(), parts, onProgress, flashParams)
      log.add({ level: 'info', source: 'app', text: '烧录写入完成' })
    },

    async erase(): Promise<void> {
      log.add({ level: 'warn', source: 'app', text: '开始全片擦除…' })
      await eraseFlash(ensureEsptool())
      log.add({ level: 'info', source: 'app', text: '擦除完成' })
    },

    async hardReset(): Promise<void> {
      log.add({ level: 'info', source: 'app', text: '发送硬复位，设备重启' })
      await hardReset(ensureEsptool())
    },

    /** D1：烧录失败后降速重建会话（波特率/2，下限 115200）并重新同步，供上层重试一次 */
    async reopenForRetry(): Promise<void> {
      const next = Math.max(Math.floor(baudrate / 2), MIN_BAUD)
      if (esptool) {
        try {
          await releaseSession(esptool)
        } catch {
          /* 释放失败也继续重建 */
        }
        esptool = null
      }
      const downgraded = next < baudrate
      baudrate = next
      log.add({
        level: 'warn',
        source: 'app',
        text: downgraded
          ? `烧录失败，降速至 ${baudrate} 波特率，重建会话后重试（仅一次）`
          : `已达波特率下限 ${MIN_BAUD}，按原速率重建会话重试（仅一次）`,
      })
      // 重新同步（芯片仍在下载模式）；失败会向上抛，由调用方归位报错
      const info = await detectChip(ensureEsptool())
      log.add({ level: 'info', source: 'app', text: `重试会话已同步：${info.name}` })
    },
  }
}
