import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeBuildSignature, runWatch } from '../tools/publish/watch.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = path.join(root, 'tests', 'fixtures')
const configPath = path.join(fixtures, 'publish.config.json')
const buildDir = path.join(fixtures, 'fake-build')
const fontPath = path.join(fixtures, 'assets', 'font.bin')

const cfg = {
  server: 'http://x',
  project: { id: 'hello-world' },
  assets: [{ label: 'font', file: 'assets/font.bin', address: '0x290000' }],
}
const dir = fixtures

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

describe('makeBuildSignature（发布输入签名）', () => {
  it('未变更时稳定', () => {
    expect(makeBuildSignature(buildDir, cfg, dir)).toBe(makeBuildSignature(buildDir, cfg, dir))
  })

  it('产物 mtime 变化 → 签名变化', async () => {
    const a = makeBuildSignature(buildDir, cfg, dir)
    const app = path.join(buildDir, 'hello_world.bin')
    const prev = fs.statSync(app).mtimeMs
    await sleep(10)
    fs.utimesSync(app, new Date(), new Date())
    const b = makeBuildSignature(buildDir, cfg, dir)
    expect(b).not.toBe(a)
    // 还原 mtime（避免污染其它用例的顺序假设）
    const d = new Date(prev)
    fs.utimesSync(app, d, d)
  })

  it('config.assets 文件变化同样触发（N8 附加资源在发布输入内）', () => {
    const a = makeBuildSignature(buildDir, cfg, dir)
    const d = new Date(Date.now() + 5000)
    fs.utimesSync(fontPath, d, d)
    const b = makeBuildSignature(buildDir, cfg, dir)
    expect(b).not.toBe(a)
  })

  it('文件缺失不炸（记 missing）', () => {
    const broken = { ...cfg, assets: [{ label: 'x', file: 'assets/nope.bin', address: '0x1' }] }
    expect(typeof makeBuildSignature(buildDir, broken, dir)).toBe('string')
  })
})

describe('runWatch（防抖/触发/失败补传）', () => {
  let fetchMock
  let publishCalls
  let ac

  beforeEach(() => {
    publishCalls = 0
    ac = new AbortController()
    process.env.FIRMWARE_PUBLISH_TOKEN = 'watch-test-token'
    fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/api/registry')) {
        return { ok: true, json: async () => ({ projects: {} }) }
      }
      if (String(url).includes('/api/publish')) {
        publishCalls += 1
        return { ok: true, status: 200, json: async () => ({ ok: true, release: 'r' }) }
      }
      throw new Error('unexpected fetch ' + url)
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    ac.abort()
    delete process.env.FIRMWARE_PUBLISH_TOKEN
  })

  const watchOnce = (extra = {}) =>
    runWatch(
      { config: configPath, buildDir, server: 'http://x', releaseId: null },
      {
        signal: ac.signal,
        intervalMs: 25,
        debounceMs: 60,
        sleep,
        retries: 0,
        log: () => {},
        ...extra,
      },
    )

  it('启动立即发布一次；无变化的后续轮不重复发', async () => {
    const done = watchOnce()
    await sleep(150) // 首发 + 约 5 轮无变化
    ac.abort()
    await done
    expect(publishCalls).toBe(1)
  }, 10_000)

  it('产物变化 → 防抖静默后再次发布（共 2 次）', async () => {
    const done = watchOnce()
    await sleep(80) // 首发完成
    expect(publishCalls).toBe(1)
    const app = path.join(buildDir, 'hello_world.bin')
    const d = new Date(Date.now() + 7000)
    fs.utimesSync(app, d, d) // 触发签名变化
    await sleep(500) // 防抖 60ms + 轮询 25ms（并行负载下放宽，消除偶发）
    ac.abort()
    await done
    expect(publishCalls).toBe(2)
    // 还原
    const now = new Date()
    fs.utimesSync(app, now, now)
  }, 10_000)

  it('发布失败 → pending 保留，服务恢复后下轮补传', async () => {
    let failing = true
    fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/api/registry')) {
        return { ok: true, json: async () => ({ projects: {} }) }
      }
      if (String(url).includes('/api/publish')) {
        if (failing) return { ok: false, status: 503, json: async () => ({ error: 'down' }) }
        publishCalls += 1 // 只计成功
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }
      throw new Error('unexpected ' + url)
    })
    vi.stubGlobal('fetch', fetchMock)

    const fails = vi.fn()
    const done = runWatch(
      { config: configPath, buildDir, server: 'http://x', releaseId: null },
      {
        signal: ac.signal,
        intervalMs: 25,
        debounceMs: 0,
        sleep,
        retries: 0,
        log: fails,
      },
    )
    await sleep(120) // 若干轮全失败
    expect(publishCalls).toBe(0)
    expect(fails.mock.calls.some((c) => String(c[0]).includes('保留待传'))).toBe(true)

    failing = false // 服务恢复
    await sleep(150)
    ac.abort()
    await done
    expect(publishCalls).toBe(1) // 恢复后补传成功一次
  }, 10_000)
})
