import { describe, expect, it } from 'vitest'
import { normalizeFlashParams } from '../src/api/buildArtifacts'
import { flattenLatest, toFlashParams, type Registry } from '../src/api/registry'

describe('normalizeFlashParams（门2 D4 根因守护）', () => {
  it('新形状 {flashMode,flashFreq,flashSize} 原样通过', () => {
    expect(
      normalizeFlashParams({ flashMode: 'dio', flashFreq: '80m', flashSize: '2MB' }),
    ).toEqual({ flashMode: 'dio', flashFreq: '80m', flashSize: '2MB' })
  })

  it('旧形状 {mode,freq,size} 归一为前端字段（历史 bug 兼容）', () => {
    expect(normalizeFlashParams({ mode: 'qio', freq: '80m', size: '16MB' })).toEqual({
      flashMode: 'qio',
      flashFreq: '80m',
      flashSize: '16MB',
    })
  })

  it('null/缺字段/非字符串 → 逐项落默认', () => {
    expect(normalizeFlashParams(null)).toEqual({
      flashMode: 'dio',
      flashFreq: '40m',
      flashSize: '4MB',
    })
    expect(normalizeFlashParams({ mode: 'qio', freq: '', size: 4 })).toEqual({
      flashMode: 'qio',
      flashFreq: '40m',
      flashSize: '4MB',
    })
  })
})

describe('registry 客户端', () => {
  const reg: Registry = {
    projects: {
      p1: {
        id: 'p1',
        name: 'P1',
        description: '',
        variants: {
          'ESP32-S3': {
            latest: 'r2',
            releases: [
              { id: 'r1', type: 'snapshot', chipFamily: 'ESP32-S3', flashParams: { mode: 'dio', freq: '40m', size: '4MB' }, createdAt: '2026-01-01T00:00:00Z', parts: [] },
              { id: 'r2', type: 'release', chipFamily: 'ESP32-S3', flashParams: { mode: 'dio', freq: '80m', size: '2MB' }, createdAt: '2026-01-02T00:00:00Z', parts: [] },
            ],
          },
        },
      },
    },
  }

  it('flattenLatest 每个 variant 取 latest release，按时间倒序', () => {
    const opts = flattenLatest(reg)
    expect(opts).toHaveLength(1)
    expect(opts[0].release.id).toBe('r2')
    expect(opts[0].variant).toBe('ESP32-S3')
  })

  it('toFlashParams mode/freq/size → flashMode/flashFreq/flashSize', () => {
    expect(toFlashParams({ mode: 'dio', freq: '80m', size: '2MB' })).toEqual({
      flashMode: 'dio',
      flashFreq: '80m',
      flashSize: '2MB',
    })
  })
})
