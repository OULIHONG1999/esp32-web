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
  /** 当前 esptool 会话是否已 main() 同步（新会话必须先 sync 才能收命令） */
  let syncedName: string | null = null

  const ensureEsptool = (): PortSession => {
    if (!lastPort) throw new Error('serial port not selected')
    if (!esptool) {
      esptool = openSession(lastPort, log, baudrate)
      log.add({ level: 'debug', source: 'app', text: 'esptool 会话已建立' })
    }
    return esptool
  }

  /**
   * 连接/会话建立前强制归零端口句柄——上次会话异常残留（close 吞失败/拔线）
   * 时兜底关闭，否则再次 open 报 already-open，用户被迫刷新页面（问题 23）。
   */
  const preparePort = async (): Promise<void> => {
    if (lastPort && (lastPort.readable || lastPort.writable)) {
      try {
        await lastPort.close()
        log.add({
          level: 'debug',
          source: 'app',
          text: '清理残留端口句柄（上次会话未正常释放）',
        })
      } catch {
        /* 已关/设备移除 */
      }
    }
  }

  /**
   * 会话首次使用前自动同步（main：复位+识别+加载 stub）。
   * 方向1 教训：connect 后 closeEsptool 归还端口，flash/erase/hardReset 新建的裸会话
   * 若直接发命令必超时失败——所有操作入口统一走这里（门2 实测暴露，2026-09-27）。
   */
  const ensureSynced = async (): Promise<PortSession> => {
    await preparePort()
    const session = ensureEsptool()
    if (syncedName === null) {
      const info = await detectChip(session)
      syncedName = info.name
      log.add({ level: 'info', source: 'app', text: `会话已同步：${info.name}` })
    }
    return session
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
        syncedName = null
        log.add({ level: 'debug', source: 'app', text: 'esptool 会话已关闭' })
      }
    },

    async detect(): Promise<ChipInfo> {
      await preparePort()
      const session = ensureEsptool()
      if (syncedName === null) {
        const info = await detectChip(session)
        syncedName = info.name
        log.add({ level: 'info', source: 'app', text: `芯片识别成功：${info.name}` })
        return info
      }
      return { name: syncedName }
    },

    async startStream(handlers: StreamHandlers): Promise<void> {
      if (!lastPort) throw new Error('serial port not selected')
      if (monitor) return
      await preparePort() // esptool 侧若残留句柄，先归零
      monitor = new SerialMonitor({
        onLine: handlers.onLine,
        onStopped: (reason, message) => {
          monitor = null
          handlers.onStopped(reason, message)
        },
      })
      await monitor.start(lastPort, 115200)
      log.add({ level: 'info', source: 'app', text: '实时日志已开启（115200）' })
    },

    async stopStream(): Promise<void> {
      if (monitor) {
        const m = monitor
        monitor = null
        await m.stop()
        log.add({ level: 'debug', source: 'app', text: '实时日志已挂起（进入操作临界区）' })
      }
    },

    /** R-1：对监视中持有的端口发信号硬复位（idf.py monitor 同源，端口不关、日志不断） */
    async signalReset(): Promise<void> {
      if (!monitor) {
        throw new Error('signal reset requires active log monitor (port not open)')
      }
      log.add({ level: 'info', source: 'app', text: '发送硬复位信号（EN 脉冲，端口保持）…' })
      await monitor.resetTarget((msg) => log.add({ level: 'info', source: 'app', text: `[复位] ${msg}` }))
      log.add({ level: 'info', source: 'app', text: '已发送硬复位信号（端口保持、日志不断流）' })
    },

    async flash(parts: FlashPart[], onProgress: (p: Progress) => void): Promise<void> {
      const total = parts.reduce((n, p) => n + p.data.byteLength, 0)
      log.add({
        level: 'info',
        source: 'app',
        text: `开始烧录 ${parts.length} 段，共 ${total} 字节`,
      })
      const session = await ensureSynced()
      let lastPart = -1
      let written = 0
      const startedAt = Date.now()
      let lastAt = startedAt
      let lastPct = -1
      let warned = false

      // 卡死可观测（2026-10-06）：烧录中途没有任何输出是「不知道为什么卡住」的主因——
      // 每 5s 检查一次：进度有 5% 以上推进就打一行心跳；超过 STALL_WARN_MS 没有进度就告警
      // （core 的 flash 空闲超时随后会判超时并归位，这里只负责让原因可见）。
      const STALL_WARN_MS = 15_000
      const mb = (n: number): string => `${(n / 1048576).toFixed(2)} MB`
      // 尚未收到任何段进度时 lastPart=-1：那段时间是写入前的区域擦除，属正常等待
      const partLabel = (): string =>
        lastPart < 0 ? '尚未开始写入（写入前擦除目标区域）' : `卡在第 ${lastPart + 1}/${parts.length} 段`
      const timer: ReturnType<typeof setInterval> = setInterval(() => {
        const idle = Date.now() - lastAt
        if (idle >= STALL_WARN_MS) {
          if (!warned) {
            warned = true
            log.add({
              level: 'warn',
              source: 'app',
              text:
                `⚠ 已 ${Math.round(idle / 1000)}s 无写入进度——` +
                `${partLabel()}（已写 ${mb(written)}/${mb(total)}）；` +
                '仍在等待芯片响应，长时间无进度会自动判超时中止。',
            })
          }
          return
        }
        const pct = total > 0 ? Math.floor((written / total) * 100) : 0
        if (pct >= lastPct + 5) {
          lastPct = pct
          log.add({
            level: 'info',
            source: 'app',
            text:
              `写入进度 ${pct}%（${lastPart < 0 ? '准备中' : `段 ${lastPart + 1}/${parts.length}`} · ` +
              `${mb(written)}/${mb(total)} · 已用 ${Math.round((Date.now() - startedAt) / 1000)}s）`,
          })
        }
      }, 5000)

      try {
        await writeFlash(
          session,
          parts,
          (prog) => {
            lastAt = Date.now()
            written = prog.written
            if (warned) warned = false // 恢复推进：允许下次停顿再告警
            if (prog.partIndex !== lastPart) {
              lastPart = prog.partIndex
              log.add({
                level: 'info',
                source: 'app',
                text: `写入段 ${prog.partIndex + 1}/${parts.length}（${parts[prog.partIndex]?.label ?? '?'}）…`,
              })
            }
            onProgress(prog)
          },
          flashParams,
        )
      } finally {
        clearInterval(timer)
      }
      log.add({
        level: 'info',
        source: 'app',
        text: `烧录写入完成（用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`,
      })
    },

    async erase(): Promise<void> {
      log.add({ level: 'warn', source: 'app', text: '开始全片擦除…' })
      const session = await ensureSynced()
      await eraseFlash(session)
      log.add({ level: 'info', source: 'app', text: '擦除完成' })
    },

    async hardReset(): Promise<void> {
      log.add({ level: 'info', source: 'app', text: '发送硬复位，设备重启' })
      const session = await ensureSynced()
      await hardReset(session)
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
        syncedName = null
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
      await preparePort()
      // 重新同步（芯片仍在下载模式）；失败会向上抛，由调用方归位报错
      const info = await detectChip(ensureEsptool())
      syncedName = info.name
      log.add({ level: 'info', source: 'app', text: `重试会话已同步：${info.name}` })
    },
  }
}
