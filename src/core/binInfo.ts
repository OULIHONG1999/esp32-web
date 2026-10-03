/**
 * BIN 内容解析（纯函数、零依赖、可单测）——A2 固件详情展示用。
 *
 * 权威依据（esptool-js / ESP 镜像格式）：
 * - 镜像头：magic 0xE9｜段数｜flashMode｜sizeFreq(nibbles)｜entry(u32le)｜…
 *   chipId 在扩展头偏移 12（u16le）；IMAGE_CHIP_ID 映射抄自 esptool-js lib/targets。
 * - 分区表：0x50AA 条目（type/subtype/offset/size/label16/flags）+ 0x50EB 结束标记。
 * - 字符串扫描：可打印 ASCII 连续段（排障用，strings 同款思路）。
 */

export interface ImageInfo {
  kind: 'image'
  segmentCount: number
  flashMode: string
  flashFreq: string
  flashSize: string
  entry: number
  chipId: number | null
  chipName: string | null
}

export interface PartitionEntry {
  label: string
  type: string
  subType: string
  offset: number
  size: number
}

export interface PartitionTableInfo {
  kind: 'partition-table'
  partitions: PartitionEntry[]
}

export interface RawBinInfo {
  kind: 'raw'
  reason: string
}

export type BinInfo = ImageInfo | PartitionTableInfo | RawBinInfo

const FLASH_MODES: Record<number, string> = { 0: 'qio', 1: 'qout', 2: 'dio', 3: 'dout' }
const FLASH_FREQS: Record<number, string> = { 0: '40m', 1: '26m', 2: '20m', 15: 'keep' }
const FLASH_SIZES: Record<number, string> = {
  0: '1MB', 1: '2MB', 2: '4MB', 3: '8MB', 4: '16MB', 5: '32MB', 6: '64MB', 7: '128MB', 15: 'keep',
}
/** esptool-js lib/targets 的 IMAGE_CHIP_ID */
const CHIP_IDS: Record<number, string> = {
  0: 'ESP32', 2: 'ESP32-S2', 5: 'ESP32-C3', 9: 'ESP32-S3', 12: 'ESP32-C2',
  13: 'ESP32-C6', 16: 'ESP32-H2', 18: 'ESP32-P4', 20: 'ESP32-C61', 23: 'ESP32-C5',
  25: 'ESP32-H21', 28: 'ESP32-H4', 31: 'ESP32-E22', 32: 'ESP32-S31',
}

const APP_SUBTYPES: Record<number, string> = {
  0x00: 'factory', 0x10: 'ota_0', 0x11: 'ota_1', 0x12: 'ota_2', 0x13: 'ota_3', 0x20: 'test',
}
const DATA_SUBTYPES: Record<number, string> = {
  0x00: 'ota', 0x01: 'phy', 0x02: 'nvs', 0x03: 'coredump', 0x04: 'nvs_keys',
  0x05: 'efuse', 0x06: 'undefined', 0x80: 'esphttpd', 0x81: 'fat', 0x82: 'spiffs', 0x83: 'littlefs',
}

function u16le(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8)
}
function u32le(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0
}
function hex(n: number): string {
  return '0x' + n.toString(16)
}

/** 镜像头解析（magic 0xE9） */
export function parseImageHeader(b: Uint8Array): ImageInfo | null {
  if (b.length < 14 || b[0] !== 0xe9) return null
  const sf = b[3]
  const chipId = u16le(b, 12)
  return {
    kind: 'image',
    segmentCount: b[1],
    flashMode: FLASH_MODES[b[2]] ?? hex(b[2]),
    flashFreq: FLASH_FREQS[sf & 0x0f] ?? hex(sf & 0x0f),
    flashSize: FLASH_SIZES[(sf >> 4) & 0x0f] ?? hex((sf >> 4) & 0x0f),
    entry: u32le(b, 4),
    chipId,
    chipName: CHIP_IDS[chipId] ?? null,
  }
}

/** 分区表解析（0x50AA 条目 / 0x50EB 结束） */
export function parsePartitionTable(b: Uint8Array): PartitionEntry[] | null {
  if (b.length < 32 || u16le(b, 0) !== 0x50aa) return null
  const out: PartitionEntry[] = []
  for (let off = 0; off + 32 <= b.length; off += 32) {
    const magic = u16le(b, off)
    if (magic === 0x50eb) break // 结束标记
    if (magic !== 0x50aa) {
      if (out.length === 0) return null
      break
    }
    const type = b[off + 2]
    const sub = b[off + 3]
    const labelRaw = b.subarray(off + 12, off + 28)
    let label = ''
    for (const c of labelRaw) {
      if (c === 0) break
      label += String.fromCharCode(c)
    }
    const typeStr = type === 0x00 ? 'app' : type === 0x01 ? 'data' : hex(type)
    const subMap = type === 0x00 ? APP_SUBTYPES : type === 0x01 ? DATA_SUBTYPES : {}
    out.push({
      label,
      type: typeStr,
      subType: subMap[sub] ?? hex(sub),
      offset: u32le(b, off + 4),
      size: u32le(b, off + 8),
    })
  }
  return out.length ? out : null
}

/** strings 式提取：可打印 ASCII 连续段 */
export function extractStrings(b: Uint8Array, minLen = 6): string[] {
  const out: string[] = []
  let cur = ''
  for (const c of b) {
    if (c >= 0x20 && c < 0x7f) {
      cur += String.fromCharCode(c)
    } else {
      if (cur.length >= minLen) out.push(cur)
      cur = ''
    }
  }
  if (cur.length >= minLen) out.push(cur)
  return out
}

/** 综合判定：镜像 / 分区表 / 原始 bin */
export function parseBin(b: Uint8Array): BinInfo {
  const img = parseImageHeader(b)
  if (img) return img
  const parts = parsePartitionTable(b)
  if (parts) return { kind: 'partition-table', partitions: parts }
  return { kind: 'raw', reason: '未识别镜像头（非 0xE9）与分区表（非 0x50AA）——按原始数据段处理' }
}

/** SHA-256（hex）——浏览器/Node 通用 */
export async function sha256Hex(b: Uint8Array): Promise<string> {
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}
