/**
 * 最小 ZIP 生成器（STORE 无压缩，零依赖、纯函数、可单测）。
 * 用途：导出固件包——bin 已是压缩产物，无需 deflate；
 * 浏览器端零依赖打包，格式：本地文件头 + 数据 → 中央目录 → EOCD。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  name: string
  data: Uint8Array
}

const encoder = new TextEncoder()

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, n & 0xffff, true)
  return b
}
function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0, true)
  return b
}
function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/**
 * 生成 STORE 方式 zip。
 * @param entries 文件项（name 用 / 分隔的相对路径；调用方保证唯一）
 */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const nameBytes = encoder.encode(e.name)
    const crc = crc32(e.data)
    const size = e.data.length

    // 本地文件头（30 字节固定 + 文件名）
    const local = concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method = STORE
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(size), // compressed
      u32(size), // uncompressed
      u16(nameBytes.length),
      u16(0), // extra len
      nameBytes,
    ])
    localParts.push(local, e.data)

    // 中央目录项（46 字节固定 + 文件名）
    centralParts.push(
      concat([
        u32(0x02014b50),
        u16(20), // version made by
        u16(20), // version needed
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk
        u16(0), // internal attr
        u32(0), // external attr
        u32(offset),
        nameBytes,
      ]),
    )
    offset += local.length + size
  }

  const localBlob = concat(localParts)
  const centralBlob = concat(centralParts)
  const eocd = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBlob.length),
    u32(localBlob.length),
    u16(0),
  ])
  return concat([localBlob, centralBlob, eocd])
}
