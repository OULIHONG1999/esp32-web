import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeviceLock } from '../src/glue/deviceLocks'

/**
 * Web Locks 行为 fake（贴近规范）：
 * - ifAvailable：锁空闲 → callback(lock 非空)；被占 → callback(null)
 * - 同一时刻一个 name 只有一个持有者
 */
function makeFakeLocks() {
  let held = false
  return {
    request: vi.fn(
      async (
        _name: string,
        opts: { ifAvailable?: boolean },
        cb: (lock: unknown) => Promise<void>,
      ) => {
        if (held && opts.ifAvailable) {
          await cb(null)
          return
        }
        held = true
        try {
          await cb({ name: _name })
        } finally {
          held = false
        }
      },
    ),
    _busy() {
      held = true
    },
    _free() {
      held = false
    },
  }
}

describe('deviceLock（跨标签设备互斥）', () => {
  beforeEach(() => {
    // node 的 globalThis.navigator 为 getter-only → 必须用 vi.stubGlobal 覆盖
    vi.stubGlobal('navigator', {
      locks: makeFakeLocks(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('空闲时获取成功，release 后可再次获取', async () => {
    const lock = createDeviceLock()
    expect(await lock.tryAcquire()).toBe(true)
    expect(lock.held).toBe(true)
    // 已持有时重复获取直接 true（幂等）
    expect(await lock.tryAcquire()).toBe(true)
    lock.release()
    expect(lock.held).toBe(false)
    lock.release() // 幂等
    // fake 锁的释放在微任务链完成 → 等一拍再取
    await new Promise((r) => setTimeout(r, 0))
    expect(await lock.tryAcquire()).toBe(true)
    lock.release()
  })

  it('被其它"标签"占用 → false；对方释放后 → true', async () => {
    const locks = globalThis.navigator.locks as unknown as ReturnType<typeof makeFakeLocks>
    locks._busy() // 模拟另一标签持有
    const lock = createDeviceLock()
    expect(await lock.tryAcquire()).toBe(false)
    expect(lock.held).toBe(false)

    locks._free() // 对方关闭/断开
    expect(await lock.tryAcquire()).toBe(true)
    lock.release()
  })

  it('无 Web Locks 环境降级放行（不拦）', async () => {
    vi.stubGlobal('navigator', {})
    const lock = createDeviceLock()
    expect(await lock.tryAcquire()).toBe(true)
    lock.release()
  })

  it('幽灵锁回归防护：callback 延迟调度时判定仍正确（旧 setTimeout 判定会误报被占）', async () => {
    // 模拟真实调度延迟：callback 在一个宏任务后才执行
    let heldByOther = false
    vi.stubGlobal('navigator', {
      locks: {
        request: (_n: string, _o: unknown, cb: (l: unknown) => Promise<void>) =>
          new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              const lockObj = heldByOther ? null : { name: 'esp32-web-device' }
              cb(lockObj).then(resolve, reject)
            }, 5)
          }),
      },
    })

    const lock = createDeviceLock()
    // 旧实现在 callback 尚未执行时就判定 → false 且幽灵持锁；新实现必须拿到
    expect(await lock.tryAcquire()).toBe(true)
    expect(lock.held).toBe(true)
    // 重复获取幂等
    expect(await lock.tryAcquire()).toBe(true)
    lock.release()
    await new Promise((r) => setTimeout(r, 40)) // 等释放链完成
    expect(await lock.tryAcquire()).toBe(true)
    lock.release()
  })
})
