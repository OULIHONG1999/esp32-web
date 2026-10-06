import {
  ESPLoader,
  Transport,
  type FlashOptions,
  type IEspLoaderTerminal,
  type LoaderOptions,
} from 'esptool-js'
import type { ChipInfo, FlashPart, Progress } from '../core/device'
import { md5Hex } from '../core/md5'
import { overallWritten } from '../core/progress'
import type { Logger } from '../core/log'

/** esptool 原始输出 → Logger（ESLint 无法替换的官方注入点，DESIGN §3） */
export function createTerminal(log: Logger): IEspLoaderTerminal {
  return {
    clean() {
      log.add({ level: 'debug', source: 'app', text: '—— terminal clean ——' })
    },
    writeLine(data: string) {
      log.addLoaderLine(data)
    },
    write(data: string) {
      // esptool 以 \n 分块；无换行的残片按行处理即可（原文始终保留）
      for (const line of data.split(/\r?\n/)) {
        if (line.trim()) log.addLoaderLine(line)
      }
    },
  }
}

export interface PortSession {
  port: SerialPort
  transport: Transport
  esploader: ESPLoader
}

/** 用户手势中调用 requestPort（F-04 第一步） */
export async function requestPort(): Promise<SerialPort> {
  if (!('serial' in navigator)) {
    throw new Error('Web Serial API unavailable (navigator.serial missing)')
  }
  return navigator.serial.requestPort()
}

export function openSession(port: SerialPort, log: Logger, baudrate = 115200): PortSession {
  // tracing 必须为 false：开启后 Transport 会把**每一次读写的原始字节**做 hex dump 进
  // console.log，并往 traceLog 字符串里无界累积。一次 2MB 烧录（16KB/块、每块数十行）
  // 就是数 MB 字符串洪峰，主线程被拖到假死——表现为「烧录卡住到一半」（2026-10-06 定位）。
  const transport = new Transport(port, false)
  const options: LoaderOptions = {
    transport,
    baudrate,
    terminal: createTerminal(log),
    debugLogging: false,
  }
  const esploader = new ESPLoader(options)
  return { port, transport, esploader }
}

export async function detectChip(session: PortSession): Promise<ChipInfo> {
  const name = await session.esploader.main()
  // F-12：检测阶段顺带读 MAC/Revision/Flash 容量（均失败可缺省，不阻塞连接）
  const info: ChipInfo = { name }
  try {
    const mac = await session.esploader.chip?.readMac?.(session.esploader)
    if (mac) info.mac = String(mac)
  } catch {
    /* 可选字段 */
  }
  try {
    const rev = await session.esploader.chip?.getChipRevision?.(session.esploader)
    if (rev !== undefined && rev !== null) info.revision = String(rev)
  } catch {
    /* 可选字段 */
  }
  try {
    const size = await session.esploader.detectFlashSize()
    if (size) info.flashSize = String(size)
  } catch {
    /* 可选字段 */
  }
  return info
}

export async function writeFlash(
  session: PortSession,
  parts: FlashPart[],
  onProgress: (p: Progress) => void,
  params?: Partial<Pick<FlashOptions, 'flashMode' | 'flashFreq' | 'flashSize'>>,
): Promise<void> {
  const fileArray = parts.map((p) => ({ data: p.data, address: p.address }))
  const partSizes = parts.map((p) => p.data.byteLength)
  const total = partSizes.reduce((n, s) => n + s, 0)
  const options: FlashOptions = {
    fileArray,
    flashMode: params?.flashMode ?? 'dio',
    flashFreq: params?.flashFreq ?? '40m',
    flashSize: params?.flashSize ?? '4MB',
    eraseAll: false,
    compress: true,
    // D5：写入后芯片读回 MD5 比对（日志 File md5 / Flash md5 / Hash of data verified.）
    calculateMD5Hash: (image: Uint8Array) => md5Hex(image),
    reportProgress: (fileIndex, written, bytesTotal) => {
      // esptool-js 语义：written/bytesTotal 是【当前段压缩后】的字节（compress:true）；
      // 整体进度按段内比例换算回真实字节，否则百分比到不了 100%（见 core/progress.ts）。
      const partTotal = bytesTotal ?? partSizes[fileIndex] ?? 0
      onProgress({
        written: overallWritten(partSizes, fileIndex, written, partTotal),
        total,
        partIndex: fileIndex,
        partWritten: written,
        partTotal,
      })
    },
  }
  await session.esploader.writeFlash(options)
}

export async function eraseFlash(session: PortSession): Promise<void> {
  await session.esploader.eraseFlash()
}

export async function hardReset(session: PortSession): Promise<void> {
  await session.esploader.after('hard_reset')
}

export async function releaseSession(session: PortSession): Promise<void> {
  try {
    await session.transport.disconnect()
  } catch {
    // 断开失败也视为已释放
  }
}
