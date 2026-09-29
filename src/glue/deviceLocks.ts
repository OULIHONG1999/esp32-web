/**
 * 跨标签页设备互斥锁（Web Locks API）——解决"本站多个标签同时连一个串口"。
 * - 浏览器原生：跨标签互斥；标签关闭/崩溃/导航离开时**自动释放**（无需轮询）
 * - 无 Web Locks 的环境（老浏览器）降级为不拦（维持原 PortBusy 文案兜底）
 * 分层：浏览器 API，放 glue；core 不感知（纪律：core 零浏览器依赖）。
 */

const LOCK_NAME = 'esp32-web-device'

function locksSupported(): boolean {
  try {
    return !!globalThis.navigator?.locks?.request
  } catch {
    return false
  }
}

export class DeviceLockedError extends Error {
  constructor() {
    super('device locked by another tab')
    this.name = 'DeviceLockedError'
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

  return {
    get held() {
      return held
    },

    async tryAcquire(): Promise<boolean> {
      if (held) return true
      if (!locksSupported()) return true // 降级：不拦，靠 PortBusy 文案兜底

      let granted = false
      let releaseResolve: (() => void) | null = null
      const holdDone = new Promise<void>((resolve) => {
        releaseResolve = resolve
      })

      // ifAvailable：锁被占时 callback(lock=null) 立即返回，不排队不阻塞
      const req = globalThis.navigator.locks.request(
        LOCK_NAME,
        { ifAvailable: true },
        async (lock: unknown) => {
          if (!lock) return // 被其它标签持有
          granted = true
          await holdDone // 持锁直到 release()
        },
      )
      req.catch(() => {
        /* 安全等意外终止 */
      })

      // 等 callback 决策完成（ifAvailable 在微任务内裁决，留一个宏任务保险）
      await new Promise((r) => setTimeout(r, 0))

      if (granted) {
        held = true
        releaseFn = () => releaseResolve?.()
        return true
      }
      return false
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
