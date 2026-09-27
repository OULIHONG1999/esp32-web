import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { md5Hex } from '../src/core/md5'

describe('md5Hex（D5 烧录校验，与 node:crypto 对拍）', () => {
  it('RFC 1321 标准向量', () => {
    expect(md5Hex(new Uint8Array(0))).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5Hex(new TextEncoder().encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(md5Hex(new TextEncoder().encode('message digest'))).toBe('f96b697d7cb7938d525a2f31aaf161d0')
    expect(md5Hex(new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz'))).toBe('c3fcd3d76192e4007dfb496cca67e13b')
  })

  it('与 node:crypto 随机数据对拍（多种长度覆盖 padding 边界）', () => {
    for (const len of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 1024, 65537]) {
      const data = randomBytes(len)
      const expectMd5 = createHash('md5').update(data).digest('hex')
      expect(md5Hex(new Uint8Array(data)), `len=${len}`).toBe(expectMd5)
    }
  })
})
