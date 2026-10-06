import { describe, expect, it } from 'vitest'
import { overallTotal, overallWritten } from '../src/core/progress'

/** 典型三段：bootloader 20KB / 分区表 3KB / app 2MB（压缩后约一半） */
const SIZES = [20 * 1024, 3 * 1024, 2 * 1024 * 1024]

describe('烧录进度换算', () => {
  it('分母是各段真实字节之和', () => {
    expect(overallTotal(SIZES)).toBe(20 * 1024 + 3 * 1024 + 2 * 1024 * 1024)
    expect(overallTotal([])).toBe(0)
  })

  it('未开始写任何段时为 0', () => {
    expect(overallWritten(SIZES, 0, 0, 10 * 1024)).toBe(0)
  })

  it('第二段开始前 = 第一段真实字节（压缩与否都不影响）', () => {
    // 第一段 20KB 压到 10KB 写完 → 已写真实字节 = 20KB
    expect(overallWritten(SIZES, 0, 10 * 1024, 10 * 1024)).toBe(20 * 1024)
  })

  it('写入最后一段的过程中百分比能爬到 100%（旧口径只到约一半）', () => {
    const sizes = [100, 100, 1000]
    const total = overallTotal(sizes)
    // 段内比例与压缩无关：50% → 该段真实字节的一半
    expect(overallWritten(sizes, 2, 5, 10)).toBe(200 + 500)
    expect(Math.round((overallWritten(sizes, 2, 6, 10) / total) * 100)).toBeGreaterThan(50)
    // 末尾：压缩后全写完 → 真实口径正好写满
    expect(overallWritten(sizes, 2, 10, 10)).toBe(total)
  })

  it('真实尺寸（2MB app 压到 1MB）：中间态已过一半，末尾到 100%', () => {
    const total = overallTotal(SIZES)
    const halfApp = overallWritten(SIZES, 2, 524288, 1048576)
    expect(halfApp).toBe(20 * 1024 + 3 * 1024 + 1024 * 1024)
    expect(Math.round((halfApp / total) * 100)).toBe(51)
    expect(overallWritten(SIZES, 2, 1048576, 1048576)).toBe(total)
  })

  it('压缩比随机变化时单调递增且不超过真实字节', () => {
    const total = overallTotal(SIZES)
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const w = overallWritten(SIZES, 2, i * 1024, 100 * 1024)
      expect(w).toBeGreaterThanOrEqual(prev)
      expect(w).toBeLessThanOrEqual(total)
      prev = w
    }
  })

  it('异常输入不越界：partTotal 缺失/为 0 时退回已完成段；比例越界被夹紧', () => {
    expect(overallWritten(SIZES, 1, 999, 0)).toBe(20 * 1024)
    expect(overallWritten(SIZES, 1, 999, -1)).toBe(20 * 1024)
    expect(overallWritten(SIZES, 1, 20 * 1024, 10 * 1024)).toBe(23 * 1024)
    expect(overallWritten(SIZES, 2, -5, 10 * 1024)).toBe(23 * 1024)
  })

  it('越界段索引按空段处理', () => {
    expect(overallWritten(SIZES, 9, 1, 1)).toBe(overallTotal(SIZES))
  })
})
