import { describe, expect, it } from 'vitest'
import { FlashSession, BusyError, type SessionDeps, type ChipInfo } from '../src/core/session'

interface FakeOptions {
  failDetect?: boolean
  failFlash?: boolean
}

function makeDeps(opts: FakeOptions = {}): { deps: SessionDeps; calls: string[] } {
  const calls: string[] = []
  const deps: SessionDeps = {
    async requestPort() {
      calls.push('requestPort')
    },
    async detect(): Promise<ChipInfo> {
      calls.push('detect')
      if (opts.failDetect) throw new Error('Unexpected CHIP magic value 0x30e1706f')
      return { name: 'ESP32-S3' }
    },
    async flash() {
      calls.push('flash')
      if (opts.failFlash) throw new Error('timeout out of sync')
    },
    async erase() {
      calls.push('erase')
    },
    async hardReset() {
      calls.push('hardReset')
    },
    async release() {
      calls.push('release')
    },
  }
  return { deps, calls }
}

async function connectReady(deps: SessionDeps): Promise<FlashSession> {
  const s = new FlashSession(deps)
  await s.connect()
  expect(s.state).toBe('ready')
  return s
}

const sampleParts = [{ label: 'app', address: 0x10000, data: new Uint8Array([1, 2, 3]) }]

describe('FlashSession 状态机', () => {
  it('idle → connect 成功 → ready，并记录芯片名', async () => {
    const { deps } = makeDeps()
    const s = await connectReady(deps)
    expect(s.chip?.name).toBe('ESP32-S3')
    expect(s.lastError).toBeNull()
  })

  it('检测失败 → error，可 release 回 idle', async () => {
    const { deps } = makeDeps({ failDetect: true })
    const s = new FlashSession(deps)
    await expect(s.connect()).rejects.toThrow()
    expect(s.state).toBe('error')
    expect(s.lastError?.cls).toBe('ChipDetectFail')
    await s.release()
    expect(s.state).toBe('idle')
  })

  it('idle 状态下禁止 flash（单飞行守卫）', async () => {
    const { deps } = makeDeps()
    const s = new FlashSession(deps)
    await expect(s.flash(sampleParts)).rejects.toBeInstanceOf(BusyError)
  })

  it('flash 全链路：flashing → resetting → done，且硬复位被调用', async () => {
    const { deps, calls } = makeDeps()
    const s = await connectReady(deps)
    await s.flash(sampleParts)
    expect(s.state).toBe('done')
    expect(calls).toEqual(['requestPort', 'detect', 'flash', 'hardReset'])
  })

  it('flash 传输失败 → error（TransferFail），release 后可重来', async () => {
    const { deps } = makeDeps({ failFlash: true })
    const s = await connectReady(deps)
    await expect(s.flash(sampleParts)).rejects.toThrow()
    expect(s.state).toBe('error')
    expect(s.lastError?.cls).toBe('TransferFail')
    await s.release()
    expect(s.state).toBe('idle')
    await s.connect()
    expect(s.state).toBe('ready')
  })

  it('erase：ready → erasing → ready', async () => {
    const { deps } = makeDeps()
    const s = await connectReady(deps)
    await s.erase()
    expect(s.state).toBe('ready')
  })

  it('手动 hardReset：ready → resetting → ready（不进 done）', async () => {
    const { deps } = makeDeps()
    const s = await connectReady(deps)
    await s.hardReset()
    expect(s.state).toBe('ready')
  })

  it('done 状态允许再次 flash（F-15 会话可重复）', async () => {
    const { deps } = makeDeps()
    const s = await connectReady(deps)
    await s.flash(sampleParts)
    expect(s.state).toBe('done')
    await s.flash(sampleParts)
    expect(s.state).toBe('done')
  })

  it('done 状态禁止 connect（必须先 release）', async () => {
    const { deps } = makeDeps()
    const s = await connectReady(deps)
    await s.flash(sampleParts)
    await expect(s.connect()).rejects.toBeInstanceOf(BusyError)
  })

  it('状态变化会通知订阅者', async () => {
    const { deps } = makeDeps()
    const s = new FlashSession(deps)
    const seen: string[] = []
    s.subscribe(() => seen.push(s.state))
    await s.connect()
    expect(seen).toEqual(['requesting', 'detecting', 'ready'])
  })

  it('非法迁移被拒绝（内部一致性）', async () => {
    const { deps } = makeDeps()
    const s = await connectReady(deps)
    // flashing 只能来自 ready/done；直接测 flash 中不能 erase —— 用并发守卫体现
    const p1 = s.flash(sampleParts)
    await expect(s.erase()).rejects.toBeInstanceOf(BusyError)
    await p1
  })
})
