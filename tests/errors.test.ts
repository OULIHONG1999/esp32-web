import { describe, expect, it } from 'vitest'
import { classifyError } from '../src/core/errors'

describe('classifyError 错误翻译（F-10）', () => {
  it('requestPort 用户取消 → UserCancel', () => {
    const err = new DOMException('No port selected by the user.', 'NotFoundError')
    expect(classifyError(err).cls).toBe('UserCancel')
  })

  it('端口已打开 / NetworkError → PortBusy', () => {
    expect(classifyError(new DOMException('already open', 'InvalidStateError')).cls).toBe('PortBusy')
    expect(classifyError(new DOMException('failed', 'NetworkError')).cls).toBe('PortBusy')
  })

  it('Permissions-Policy 拒绝 → PermissionDenied', () => {
    expect(classifyError(new DOMException('blocked', 'SecurityError')).cls).toBe('PermissionDenied')
  })

  it('detect 阶段 magic 不匹配 → ChipDetectFail', () => {
    const err = new Error('Unexpected CHIP magic value 0x30e1706f. Failed to autodetect chip type.')
    expect(classifyError(err, 'detect').cls).toBe('ChipDetectFail')
  })

  it('flash 阶段超时失步 → TransferFail', () => {
    const err = new Error('Timeout: No response from target')
    expect(classifyError(err, 'flash').cls).toBe('TransferFail')
  })

  it('reset 阶段同步失败 → ResetFailed', () => {
    expect(classifyError(new Error('Failed to get into bootloader'), 'reset').cls).toBe('ResetFailed')
  })

  it('未知错误 → Unknown，且带恢复提示', () => {
    const r = classifyError(new Error('boom'))
    expect(r.cls).toBe('Unknown')
    expect(r.hint.length).toBeGreaterThan(0)
  })

  it('TimeoutError + detect 阶段 → ChipDetectFail 超时文案（D2）', () => {
    const e = new Error('chip detect timed out after 20000ms')
    e.name = 'TimeoutError'
    const r = classifyError(e, 'detect')
    expect(r.cls).toBe('ChipDetectFail')
    expect(r.message).toContain('超时')
    expect(r.retryable).toBe(true)
  })

  it('TimeoutError + flash 阶段 → TransferFail 超时文案（D2 空闲超时）', () => {
    const e = new Error('flash idle for 60000ms without progress')
    e.name = 'TimeoutError'
    const r = classifyError(e, 'flash')
    expect(r.cls).toBe('TransferFail')
    expect(r.message).toContain('超时')
    expect(r.retryable).toBe(true)
  })

  it('TimeoutError + reset 阶段 → ResetFailed 复位超时（2026-10-03 防挂分类）', () => {
    const e = new Error('signal reset timed out after 3000ms')
    e.name = 'TimeoutError'
    const r = classifyError(e, 'reset')
    expect(r.cls).toBe('ResetFailed')
    expect(r.message).toContain('复位超时')
    expect(r.retryable).toBe(true)
  })
  it('七类文案全部非空（结构完整性）', () => {
    const cases = [
      classifyError(new DOMException('x', 'NotFoundError')),
      classifyError(new DOMException('x', 'InvalidStateError')),
      classifyError(new DOMException('x', 'SecurityError')),
      classifyError(new Error('magic'), 'detect'),
      classifyError(new Error('timeout'), 'flash'),
      classifyError(new Error('reset'), 'reset'),
      classifyError(new Error('boom')),
    ]
    for (const c of cases) {
      expect(c.message.length).toBeGreaterThan(0)
      expect(c.hint.length).toBeGreaterThan(0)
    }
  })
})
