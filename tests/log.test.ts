import { describe, expect, it } from 'vitest'
import { Logger, classifyLoaderLine } from '../src/core/log'

describe('Logger（F-08）', () => {
  it('环形缓冲保留最近 capacity 条', () => {
    const log = new Logger(5)
    for (let i = 0; i < 10; i++) {
      log.add({ level: 'info', source: 'app', text: `m${i}` })
    }
    const snap = log.snapshot()
    expect(snap.length).toBe(5)
    expect(snap[0].text).toBe('m5')
    expect(snap[4].text).toBe('m9')
  })

  it('订阅与退订', () => {
    const log = new Logger()
    const seen: string[] = []
    const off = log.subscribe((e) => seen.push(e.text))
    log.add({ level: 'info', source: 'app', text: 'a' })
    off()
    log.add({ level: 'info', source: 'app', text: 'b' })
    expect(seen).toEqual(['a'])
  })

  it('导出文本含时间戳与级别', () => {
    const log = new Logger()
    log.add({ ts: 1700000000000, level: 'error', source: 'loader', text: 'boom' })
    const out = log.exportText()
    expect(out).toContain('[error]')
    expect(out).toContain('boom')
    expect(out).toContain('2023-11-14')
  })

  it('空行不产生日志', () => {
    const log = new Logger()
    expect(log.addLoaderLine('   ')).toBeNull()
    expect(log.snapshot().length).toBe(0)
  })
})

describe('classifyLoaderLine esptool 输出分级', () => {
  it('连接/芯片信息 → device', () => {
    expect(classifyLoaderLine('Chip is ESP32-D0WD-V3 (revision 3)').level).toBe('device')
    expect(classifyLoaderLine('MAC: 7c:9e:bd:28:7e:c4').level).toBe('device')
    expect(classifyLoaderLine('Uploading stub...').level).toBe('device')
    expect(classifyLoaderLine('ESP-ROM:esp32s3-20210327').level).toBe('device')
  })

  it('进度 → transfer', () => {
    expect(classifyLoaderLine('Compressed 300 bytes at 0x10000 in 0.0s (12%)').level).toBe('transfer')
    expect(classifyLoaderLine('Writing at 0x00010000... (12 %)').level).toBe('transfer')
  })

  it('失败 → error', () => {
    expect(classifyLoaderLine('Failed to autodetect chip type.').level).toBe('error')
    expect(classifyLoaderLine('A fatal exception occurred').level).toBe('error')
  })

  it('普通行 → info（原文保留）', () => {
    const r = classifyLoaderLine('some plain progress note')
    expect(r.level).toBe('info')
    expect(r.source).toBe('loader')
  })
})
