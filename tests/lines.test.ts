import { describe, expect, it } from 'vitest'
import { createLineSplitter } from '../src/core/lines'

describe('createLineSplitter 串口行切分', () => {
  it('完整行直接输出，残片留到下一块', () => {
    const s = createLineSplitter()
    expect(s.push('Hello world!\nRest')).toEqual(['Hello world!'])
    expect(s.push('arting now.\r\n')).toEqual(['Restarting now.'])
    expect(s.flush()).toEqual([])
  })

  it('CRLF 与 LF 混合', () => {
    const s = createLineSplitter()
    expect(s.push('a\r\nb\nc\r\n')).toEqual(['a', 'b', 'c'])
  })

  it('空行被丢弃，flush 输出无换行残片', () => {
    const s = createLineSplitter()
    expect(s.push('\n\nx\n')).toEqual(['x'])
    expect(s.push('tail')).toEqual([])
    expect(s.flush()).toEqual(['tail'])
  })

  it('一次多行', () => {
    const s = createLineSplitter()
    expect(s.push('1\n2\n3\n')).toEqual(['1', '2', '3'])
  })
})
