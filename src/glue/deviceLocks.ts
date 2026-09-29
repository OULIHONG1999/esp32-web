/**
 * 跨标签页设备互斥锁（Web Locks API）——解决"本站多个标签同时连一个串口"。
 * - 浏览器原生：跨标签互斥；标签关闭/崩溃/导航离开时**自动释放**（无需轮询）
 * - 无 Web Locks 的环境（老浏览器）降级为不拦（维持原 PortBusy 文案兜底）
 * 分层：浏览器 API，放 glue；core 不感知（纪律：core 零浏览器依赖）。
 *
 * 修复记录（2026-09-29 门2 后线上误报）：
 * 旧实现用 setTimeout(0) 等 callback 决策——callback 调度晚于定时器时
 * ①误报"被占"②锁已被拿到却记为失败（幽灵锁）→ 后续全部自锁失败。
 * 新实现：granted/rejected 的 resolve 全部发生在 callback **内部**，零时序赌博；
 * 另加一次短延迟重试，覆盖"自己刚 release、锁尚未回收"的重入窗口。
 */

const LOCK_NAME = 'esp32-web-device'

function locksSupported(): boolean {
  try {
    return !!globalThis.navigator?.locks?.request
  } catch {
    return false
  }
}

export interface DeviceLock {
  /** 尝试持锁；true=成功（或本标签已持有/环境不支持）。false=被其它标签占用 */
  tryAcquire(): Promise<boolean>
  /** 主动释放（disconnect/连接失败/error 归位时调用）；页面关闭时浏览器自动释放 */
  release(): void
  /** 当前本标签是否持有 */
  readonly held: boolean
}

export function createDeviceLock(): DeviceLock {
  let held = false
  let releaseFn: (() => void) | null = null

  /** 单次 ifAvailable 尝试：结果在 callback 内确定性返回 */
  function once(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      let releaseResolve: (() => void) | null = null
      const holdDone = new Promise<void>((r) => {
        releaseResolve = r
      })

      globalThis.navigator.locks
        .request(LOCK_NAME, { ifAvailable: true }, async (lock: unknown) => {
          if (!lock) {
            done(false) // 被其它标签持有
            return
          }
          held = true
          releaseFn = () => releaseResolve?.()
          done(true) // 先通知调用方，再持锁等待释放
          await holdDone
        })
        .catch(() => done(false))
    })
  }

  return {
    get held() {
      return held
    },

    async tryAcquire(): Promise<boolean> {
      if (held) return true
      if (!locksSupported()) return true // 降级：不拦，靠 PortBusy 文案兜底

      if (await once()) return true
      // 防御窗口：本标签刚 release、锁尚未被浏览器回收 → 短延迟重试一次
      await new Promise((r) => setTimeout(r, 30))
      if (held) return true // 期间已被其它路径持有
      return once()
    },

    release(): void {
      if (!held) return
      held = false
      const fn = releaseFn
      releaseFn = null
      fn?.()
    },
  }
}
