import { describe, expect, it } from 'vitest'
import { checkEnvironment, describeBrowser, type EnvProbe } from '../src/env/environment'

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.55 Safari/537.36'

function probe(over: Partial<EnvProbe> = {}): EnvProbe {
  return {
    isSecureContext: true,
    hasSerial: true,
    userAgent: CHROME_UA,
    origin: 'https://firmware.example.com',
    inIframe: false,
    ...over,
  }
}

describe('checkEnvironment', () => {
  it('安全上下文 + 有 serial → 就绪，无根因', () => {
    const r = checkEnvironment(probe())
    expect(r.ok).toBe(true)
    expect(r.secureContext).toBe(true)
    expect(r.serialApi).toBe(true)
    expect(r.problems).toEqual([])
  })

  it('现场信息（origin / 浏览器 / iframe 标志）如实带出', () => {
    const r = checkEnvironment(probe({ origin: 'http://127.0.0.1:8787', inIframe: true }))
    expect(r.origin).toBe('http://127.0.0.1:8787')
    expect(r.inIframe).toBe(true)
    expect(r.browser).toBe('Chrome 141')
    expect(r.userAgent).toBe(CHROME_UA)
  })

  it('回归：非安全上下文且无 serial（Chrome 真实现场）只报一条根因，不推给浏览器', () => {
    const r = checkEnvironment(probe({ isSecureContext: false, hasSerial: false }))
    expect(r.ok).toBe(false)
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0].id).toBe('insecure')
    expect(r.problems[0].hint).toContain('https://')
  })

  it('非安全上下文即使探针说 serial 存在，也只报 insecure', () => {
    const r = checkEnvironment(probe({ isSecureContext: false, hasSerial: true }))
    expect(r.problems.map((p) => p.id)).toEqual(['insecure'])
  })

  it('探针值原样透传，不擅自改判某一行', () => {
    const r = checkEnvironment(probe({ isSecureContext: false, hasSerial: true }))
    expect(r.secureContext).toBe(false)
    expect(r.serialApi).toBe(true)
  })

  it('安全上下文 + 顶层 + 无 serial → no-serial', () => {
    const r = checkEnvironment(probe({ hasSerial: false }))
    expect(r.problems.map((p) => p.id)).toEqual(['no-serial'])
    expect(r.problems[0].hint).toContain('Chrome')
  })

  it('安全上下文 + iframe + 无 serial → embedded（先排除内嵌因素）', () => {
    const r = checkEnvironment(probe({ hasSerial: false, inIframe: true }))
    expect(r.problems.map((p) => p.id)).toEqual(['embedded'])
    expect(r.problems[0].hint).toContain('独立标签页')
  })

  it('iframe 本身不算故障：只要接口在，就绪', () => {
    const r = checkEnvironment(probe({ inIframe: true }))
    expect(r.ok).toBe(true)
  })

  it('缺省现场不炸：origin 空串、浏览器未知', () => {
    const r = checkEnvironment({})
    expect(r.origin).toBe('')
    expect(r.browser).toBe('未知浏览器')
    expect(r.inIframe).toBe(false)
    expect(r.problems.map((p) => p.id)).toEqual(['insecure'])
  })

  it('不传探针时（node 环境无 window/navigator）走保守判定', () => {
    const r = checkEnvironment()
    expect(r.ok).toBe(false)
    expect(r.secureContext).toBe(false)
  })
})

describe('describeBrowser', () => {
  it.each([
    [CHROME_UA, 'Chrome 141'],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.71',
      'Edge 141',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0', 'Firefox 151'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      'Safari 26',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari 18',
    ],
    ['', '未知浏览器'],
  ])('%s → %s', (ua, want) => {
    expect(describeBrowser(ua)).toBe(want)
  })
})
