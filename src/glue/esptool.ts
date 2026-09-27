import {
  ESPLoader,
  Transport,
  type FlashOptions,
  type IEspLoaderTerminal,
  type LoaderOptions,
} from 'esptool-js'
import type { ChipInfo, FlashPart, Progress } from '../core/device'
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
  const transport = new Transport(port, true)
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
  return { name }
}

export async function writeFlash(
  session: PortSession,
  parts: FlashPart[],
  onProgress: (p: Progress) => void,
  params?: Partial<Pick<FlashOptions, 'flashMode' | 'flashFreq' | 'flashSize'>>,
): Promise<void> {
  const fileArray = parts.map((p) => ({ data: p.data, address: p.address }))
  const total = parts.reduce((n, p) => n + p.data.byteLength, 0)
  const options: FlashOptions = {
    fileArray,
    flashMode: params?.flashMode ?? 'dio',
    flashFreq: params?.flashFreq ?? '40m',
    flashSize: params?.flashSize ?? '4MB',
    eraseAll: false,
    compress: true,
    reportProgress: (fileIndex, written, bytesTotal) => {
      const before = parts
        .slice(0, fileIndex)
        .reduce((n, p) => n + p.data.byteLength, 0)
      onProgress({
        written: before + written,
        total: bytesTotal ?? total,
        partIndex: fileIndex,
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
