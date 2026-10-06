import { describe, expect, it } from 'vitest'
import { buildTokenLink, parseTokenLink } from '../src/core/tokenLink'

describe('parseTokenLink', () => {
  it('片段形态（推荐）解析出 token，并把片段抹掉', () => {
    const r = parseTokenLink('https://fw.example.com/OTA#token=wk_abc123')
    expect(r.token).toBe('wk_abc123')
    expect(r.cleanHref).toBe('https://fw.example.com/OTA')
  })

  it('兼容旧形态 ?settoken=，同样抹掉参数', () => {
    const r = parseTokenLink('https://fw.example.com/?settoken=wk_abc123')
    expect(r.token).toBe('wk_abc123')
    expect(r.cleanHref).toBe('https://fw.example.com/')
  })

  it('两种形态同时出现时以片段为准，两个都抹掉', () => {
    const r = parseTokenLink('https://fw.example.com/OTA?settoken=old#token=new')
    expect(r.token).toBe('new')
    expect(r.cleanHref).toBe('https://fw.example.com/OTA')
  })

  it('保留无关的查询参数与其它片段', () => {
    const r = parseTokenLink('https://fw.example.com/OTA?dev=b81f#token=wk_x&tab=cmd')
    expect(r.token).toBe('wk_x')
    expect(r.cleanHref).toBe('https://fw.example.com/OTA?dev=b81f#tab=cmd')
  })

  it('没有 token 时原样返回', () => {
    const href = 'https://fw.example.com/OTA?dev=b81f'
    expect(parseTokenLink(href)).toEqual({ token: '', cleanHref: href })
  })

  it('token 是空值时视为没有', () => {
    expect(parseTokenLink('https://fw.example.com/#token=').token).toBe('')
    expect(parseTokenLink('https://fw.example.com/?settoken=%20').token).toBe('')
  })

  it('地址非法不抛异常', () => {
    expect(parseTokenLink('not a url')).toEqual({ token: '', cleanHref: 'not a url' })
  })

  it('构造与解析可以往返（token 含特殊字符也不丢）', () => {
    const token = 'wk_a+b/c=d'
    const link = buildTokenLink('https://fw.example.com/OTA', token)
    expect(link).toBe('https://fw.example.com/OTA#token=wk_a%2Bb%2Fc%3Dd')
    expect(parseTokenLink(link).token).toBe(token)
  })
})

describe('buildTokenLink', () => {
  it('同源同路径 + 片段，且不带查询串（不上行、不进服务器日志）', () => {
    const link = buildTokenLink('https://fw.example.com/OTA?dev=x#tab=cmd', 'wk_abc')
    expect(link).toBe('https://fw.example.com/OTA#token=wk_abc')
    expect(link).not.toContain('settoken')
  })

  it('地址非法时退化为相对片段而非抛异常', () => {
    expect(buildTokenLink('nonsense', 'wk_abc')).toBe('#token=wk_abc')
  })
})
