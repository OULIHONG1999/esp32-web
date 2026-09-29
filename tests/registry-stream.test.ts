import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  diffLatest,
  isSubscribed,
  setSubscribed,
  snapshotLatest,
  type Registry,
} from '../src/api/registry'

const reg: Registry = {
  projects: {
    p1: {
      id: 'p1',
      name: 'P1',
      description: '',
      subscribed: true,
      variants: {
        'ESP32-S3': { latest: 'r2', releases: [] },
        'ESP32-C3': { latest: 'c1', releases: [] },
      },
    },
    p2: {
      id: 'p2',
      name: 'P2',
      description: '',
      subscribed: false,
      variants: { 'ESP32-S3': { latest: 'x9', releases: [] } },
    },
  },
}

describe('S3 快照与轮询降级 diff（纯函数）', () => {
  it('snapshotLatest 展平为 pid/vid → latest', () => {
    expect(snapshotLatest(reg)).toEqual({
      'p1/ESP32-S3': 'r2',
      'p1/ESP32-C3': 'c1',
      'p2/ESP32-S3': 'x9',
    })
  })

  it('diffLatest 只报变化的 key（新增项目不报——首个快照后才有基线）', () => {
    const prev = { 'p1/ESP32-S3': 'r2', 'p1/ESP32-C3': 'c1' }
    const next = { 'p1/ESP32-S3': 'r3', 'p1/ESP32-C3': 'c1', 'p2/ESP32-S3': 'x9' }
    expect(diffLatest(prev, next)).toEqual([{ key: 'p1/ESP32-S3', latest: 'r3' }])
  })

  it('无变化 → 空数组', () => {
    const snap = snapshotLatest(reg)
    expect(diffLatest(snap, { ...snap })).toEqual([])
  })
})

describe('★订阅状态（F-21）', () => {
  it('无 localStorage（node）：默认 true；server 值优先于默认', () => {
    expect(isSubscribed('any')).toBe(true)
    expect(isSubscribed('p2', false)).toBe(false)
    expect(isSubscribed('p1', true)).toBe(true)
  })

  it('setSubscribed 双写：POST 服务端（fetch stub 断言）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      status: 200,
    }))
    vi.stubGlobal('fetch', fetchMock)
    await setSubscribed('hello-world', false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/api/registry/projects/hello-world/subscribe')
    expect(JSON.parse(init.body)).toEqual({ subscribed: false })
    vi.unstubAllGlobals()
  })

  it('服务端不可达不抛（乐观本地）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(setSubscribed('x', true)).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})
