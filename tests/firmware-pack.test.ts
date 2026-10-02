import { describe, expect, it } from 'vitest'
import { crc32, zipStore, type ZipEntry } from '../src/core/zip'
import {
  buildFlashArgsText,
  buildReadmeText,
  type PackPart,
} from '../src/core/firmwarePack'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** 最小 STORE zip 解析器（回环验证用） */
function parseZip(buf: Uint8Array): Map<string, { data: Uint8Array; crc: number }> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  // 从尾部找 EOCD（0x06054b50）
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  expect(eocd).toBeGreaterThan(-1)
  const count = dv.getUint16(eocd + 10, true)
  const cdOff = dv.getUint32(eocd + 16, true)

  const out = new Map<string, { data: Uint8Array; crc: number }>()
  let p = cdOff
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50)
    const crc = dv.getUint32(p + 16, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOff = dv.getUint32(p + 42, true)
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen))

    // 本地头：0 sig..26 nameLen(2) 28 extraLen(2) 30 name → data
    expect(dv.getUint32(localOff, true)).toBe(0x04034b50)
    const lNameLen = dv.getUint16(localOff + 26, true)
    const lExtraLen = dv.getUint16(localOff + 28, true)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const data = buf.subarray(dataStart, dataStart + size)
    out.set(name, { data, crc })

    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

describe('core/zip（STORE 打包）', () => {
  it('crc32 标准向量（"123456789" = 0xCBF43926）', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
  })

  it('zipStore 回环：多文件名/内容/CRC 全部一致', () => {
    const entries: ZipEntry[] = [
      { name: 'bootloader.bin', data: new Uint8Array([0x00, 0x01, 0xe9, 0x03]) },
      { name: 'README.txt', data: enc.encode('你好，ESP32\n') },
      { name: 'flash_args', data: enc.encode('--flash-mode dio\n0x0 bootloader.bin\n') },
    ]
    const zip = zipStore(entries)
    // EOCD 签名收尾
    expect(zip[zip.length - 22]).toBe(0x50)
    expect(zip[zip.length - 21]).toBe(0x4b)
    const parsed = parseZip(zip)
    expect([...parsed.keys()].sort()).toEqual(
      ['README.txt', 'bootloader.bin', 'flash_args'].sort(),
    )
    for (const e of entries) {
      const got = parsed.get(e.name)!
      expect(Array.from(got.data)).toEqual(Array.from(e.data))
      expect(got.crc).toBe(crc32(e.data))
    }
  })

  it('zipStore 空数据文件也能打包', () => {
    const zip = zipStore([{ name: 'empty.bin', data: new Uint8Array(0) }])
    const parsed = parseZip(zip)
    expect(parsed.get('empty.bin')!.data.length).toBe(0)
  })
})

describe('core/firmwarePack（导出文本）', () => {
  const parts: PackPart[] = [
    { address: 0x0, fileName: 'bootloader.bin', label: 'bootloader', size: 23100 },
    { address: 0x8000, fileName: 'partition-table.bin', label: 'partition-table', size: 3072 },
    { address: 0x10000, fileName: 'hello_world.bin', label: 'app', size: 150784 },
  ]

  it('flash_args：参数齐全 = 三行选项 + 按地址的段行', () => {
    const text = buildFlashArgsText(parts, {
      flashMode: 'dio',
      flashFreq: '80m',
      flashSize: '2MB',
    })
    expect(text).toContain('--flash-mode dio')
    expect(text).toContain('--flash-freq 80m')
    expect(text).toContain('--flash-size 2MB')
    expect(text).toContain('0x0 bootloader.bin')
    expect(text).toContain('0x8000 partition-table.bin')
    expect(text).toContain('0x10000 hello_world.bin')
  })

  it('flash_args：参数未注入 → 省略选项行（esptool 默认）', () => {
    const text = buildFlashArgsText(parts, null)
    expect(text).not.toContain('--flash-mode')
    expect(text).toContain('0x0 bootloader.bin')
  })

  it('README：含来源/参数/地址表/esptool 指引', () => {
    const text = buildReadmeText(
      parts,
      { flashMode: 'dio', flashFreq: '80m', flashSize: '2MB' },
      { source: 'hello-world/ESP32-S3 20261002-001', chipName: 'ESP32-S3' },
    )
    expect(text).toContain('hello-world/ESP32-S3 20261002-001')
    expect(text).toContain('ESP32-S3')
    expect(text).toContain('mode=dio')
    expect(text).toContain('0x10000 hello_world.bin')
    expect(text).toContain('write_flash @flash_args')
    expect(text).toContain('按住 BOOT')
  })
})
