import { describe, expect, it } from 'vitest'
import {
  extractStrings,
  parseBin,
  parseImageHeader,
  parsePartitionTable,
  sha256Hex,
} from '../src/core/binInfo'

/** 构造最小镜像头向量（0xE9 + 段数/模式/sizeFreq/entry/chipId） */
function makeImage(over: Partial<{ seg: number; mode: number; sf: number; chipId: number }> = {}): Uint8Array {
  const b = new Uint8Array(24)
  b[0] = 0xe9
  b[1] = over.seg ?? 3
  b[2] = over.mode ?? 2 // dio
  b[3] = over.sf ?? 0x20 // size=2(4MB) freq=0(40m)
  const entry = 0x40380824
  new DataView(b.buffer).setUint32(4, entry, true)
  new DataView(b.buffer).setUint16(12, over.chipId ?? 9, true) // ESP32-S3
  return b
}

function makePartitionTable(): Uint8Array {
  const b = new Uint8Array(96) // 2 条 + 结束标记
  const dv = new DataView(b.buffer)
  // 条目1：app/factory @0x10000 8MB 'factory'
  dv.setUint16(0, 0x50aa, true)
  b[2] = 0x00; b[3] = 0x00
  dv.setUint32(4, 0x10000, true)
  dv.setUint32(8, 0x800000, true)
  for (const [i, ch] of [...'factory'].entries()) b[12 + i] = ch.charCodeAt(0)
  // 条目2：data/nvs @0x9000 24KB 'nvs'
  dv.setUint16(32, 0x50aa, true)
  b[34] = 0x01; b[35] = 0x02
  dv.setUint32(36, 0x9000, true)
  dv.setUint32(40, 0x6000, true)
  for (const [i, ch] of [...'nvs'].entries()) b[44 + i] = ch.charCodeAt(0)
  // 结束标记
  dv.setUint16(64, 0x50eb, true)
  return b
}

describe('core/binInfo（A2 固件详情解析）', () => {
  it('镜像头：段数/flash 参数/入口/芯片全部解析', () => {
    const info = parseImageHeader(makeImage())
    expect(info).not.toBeNull()
    expect(info!.kind).toBe('image')
    expect(info!.segmentCount).toBe(3)
    expect(info!.flashMode).toBe('dio')
    expect(info!.flashSize).toBe('4MB')
    expect(info!.flashFreq).toBe('40m')
    expect(info!.entry).toBe(0x40380824)
    expect(info!.chipId).toBe(9)
    expect(info!.chipName).toBe('ESP32-S3')
  })

  it('镜像头：size/freq nibble 组合（16MB/80m=keep 映射之外的值）', () => {
    const info = parseImageHeader(makeImage({ sf: 0x41, mode: 0 })) // size=4(16MB) freq=1(26m)
    expect(info!.flashSize).toBe('16MB')
    expect(info!.flashFreq).toBe('26m')
    expect(info!.flashMode).toBe('qio')
  })

  it('分区表：条目与子类型解析 + 结束标记止步', () => {
    const parts = parsePartitionTable(makePartitionTable())
    expect(parts).not.toBeNull()
    expect(parts!).toHaveLength(2)
    expect(parts![0]).toMatchObject({ label: 'factory', type: 'app', subType: 'factory', offset: 0x10000, size: 0x800000 })
    expect(parts![1]).toMatchObject({ label: 'nvs', type: 'data', subType: 'nvs', offset: 0x9000, size: 0x6000 })
  })

  it('parseBin 分类：image / partition-table / raw', () => {
    expect(parseBin(makeImage()).kind).toBe('image')
    expect(parseBin(makePartitionTable()).kind).toBe('partition-table')
    expect(parseBin(new Uint8Array([1, 2, 3, 4])).kind).toBe('raw')
  })

  it('extractStrings：可打印连续段按最小长度过滤', () => {
    const data = new TextEncoder().encode('xx hello_world yy\x00\x01ab\x00ESP-IDF-v6.0')
    const s = extractStrings(data, 6)
    expect(s.some((x) => x.includes('hello_world'))).toBe(true)
    expect(s.some((x) => x.includes('ESP-IDF-v6.0'))).toBe(true)
  })

  it('sha256Hex：标准向量 abc', async () => {
    const h = await sha256Hex(new TextEncoder().encode('abc'))
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
