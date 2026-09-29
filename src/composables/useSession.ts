import { computed, ref, type Ref } from 'vue'
import { Logger, type LogEntry } from '../core/log'
import {
  DeviceManager,
  type ChipInfo,
  type DeviceState,
  type FlashPart,
  type Progress,
} from '../core/device'
import type { ClassifiedError } from '../core/errors'
import { createDeviceOps } from '../glue/deviceOps'
import { createDeviceLock } from '../glue/deviceLocks'

const DISPLAY_CAP = 500
const FLUSH_MS = 120
const HISTORY_KEY = 'fw.flashHistory'
const HISTORY_CAP = 20

/** 跨窗口日志同步频道（主窗口=数据源；?panel=log 独立日志窗口=订阅者） */
const LOG_CHANNEL = 'fw-log'

/** 烧录历史条目（localStorage 持久，F 追加：排障/追溯） */
export interface FlashHistoryItem {
  ts: number
  chip: string
  parts: number
  bytes: number
  ok: boolean
  error?: string
}

/** 设备管理 + Vue 接线：批量 flush（渲染性能）、暂停视图、方向1 状态镜像 */
export function useSession() {
  const log = new Logger()
  const ops = createDeviceOps(log)
  const device = new DeviceManager(ops)
  /** 跨窗口日志同步：本窗口（数据源）向 ?panel=log 独立窗口广播 */
  const logChannel: BroadcastChannel | null =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(LOG_CHANNEL) : null
  logChannel?.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as { type?: string } | null
    if (m?.type === 'sync-req') {
      // 独立窗口请求全量同步
      logChannel.postMessage({ type: 'sync', logs: logs.value })
    }
  })
  /** 跨标签设备互斥锁（Web Locks）：防多标签同时连一个串口 */
  const deviceLock = createDeviceLock()

  const state: Ref<DeviceState> = ref(device.state)
  const streamOn = ref<boolean>(device.isStreamOn)
  const chip: Ref<ChipInfo | null> = ref(null)
  const lastError: Ref<ClassifiedError | null> = ref(null)
  const progress: Ref<Progress | null> = ref(null)
  const logs: Ref<LogEntry[]> = ref([])
  const viewPaused = ref(false)

  // ---- 烧录历史（localStorage）----
  const flashHistory = ref<FlashHistoryItem[]>(loadHistory())
  function loadHistory(): FlashHistoryItem[] {
    try {
      const raw = globalThis.localStorage?.getItem(HISTORY_KEY)
      const v = raw ? JSON.parse(raw) : []
      return Array.isArray(v) ? v.slice(0, HISTORY_CAP) : []
    } catch {
      return []
    }
  }
  function pushHistory(item: FlashHistoryItem): void {
    flashHistory.value = [item, ...flashHistory.value].slice(0, HISTORY_CAP)
    try {
      globalThis.localStorage?.setItem(HISTORY_KEY, JSON.stringify(flashHistory.value))
    } catch {
      /* 私隐模式忽略 */
    }
  }
  function clearHistory(): void {
    flashHistory.value = []
    try {
      globalThis.localStorage?.removeItem(HISTORY_KEY)
    } catch {
      /* ignore */
    }
  }

  device.setLineHandler((line) => {
    log.add({ level: 'device', source: 'device', text: line })
  })
  device.setNoticeHandler((message) => {
    // 后缀由 core 消息自带（重试提示等不应拼"请重新连接"）
    log.add({ level: 'warn', source: 'serial', text: `⚠ ${message}` })
  })

  device.subscribe(() => {
    state.value = device.state
    streamOn.value = device.isStreamOn
    chip.value = device.chip
    lastError.value = device.lastError
    progress.value = device.progress
    // 回到 disconnected/error 即释放跨标签锁（拔线/断开/连接失败/错误归位）
    if (device.state === 'disconnected' || device.state === 'error') {
      deviceLock.release()
    }
  })

  // ---- 批量 flush：串口高速输出时避免每行触发一次响应式渲染 ----
  const pending: LogEntry[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function flush(): void {
    flushTimer = null
    if (viewPaused.value) return // 暂停期间不往视图推（logger 全量仍在收集）
    if (pending.length === 0) return
    const batch = [...pending]
    logs.value.push(...batch)
    pending.length = 0
    if (logs.value.length > DISPLAY_CAP) {
      logs.value.splice(0, logs.value.length - DISPLAY_CAP)
    }
    // 独立日志窗口同步（append 本批）
    logChannel?.postMessage({ type: 'append', entries: batch })
  }

  function scheduleFlush(): void {
    if (flushTimer !== null || viewPaused.value) return
    flushTimer = setTimeout(flush, FLUSH_MS)
  }

  log.subscribe((entry) => {
    pending.push(entry)
    scheduleFlush()
  })

  function toggleViewPause(): void {
    viewPaused.value = !viewPaused.value
    if (!viewPaused.value) {
      // 恢复视图：把暂停期间积压的行补上（超量只显示最近 DISPLAY_CAP 条）
      if (pending.length > DISPLAY_CAP) {
        pending.splice(0, pending.length - DISPLAY_CAP)
      }
      flush()
      log.add({ level: 'info', source: 'app', text: '视图已恢复' })
    } else {
      log.add({ level: 'info', source: 'app', text: '视图已暂停（日志仍在收集，导出不受影响）' })
    }
  }

  const busy = computed(() =>
    ['requesting', 'detecting', 'working'].includes(state.value),
  )
  const connected = computed(() => ['ready', 'working'].includes(state.value))
  const canOperate = computed(() => state.value === 'ready')
  const percent = computed(() => {
    const p = progress.value
    if (!p || p.total === 0) return null
    return Math.min(100, Math.round((p.written / p.total) * 100))
  })

  async function run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch {
      // 错误已入 device.lastError；UserCancel 已静默回 disconnected
    }
  }

  /** 连接/切换端口：先抢跨标签锁，抢不到给明确提示（设备占用治理） */
  async function runWithLock(fn: () => Promise<void>): Promise<void> {
    const ok = await deviceLock.tryAcquire()
    if (!ok) {
      log.add({
        level: 'warn',
        source: 'serial',
        text: '⚠ 设备连接被本浏览器的其它标签页占用——请关闭那边的连接/页面后重试',
      })
      return
    }
    await run(fn)
  }

  return {
    log,
    device,
    setFlashParams: ops.setFlashParams,
    state,
    chip,
    lastError,
    progress,
    logs,
    viewPaused,
    busy,
    connected,
    canOperate,
    percent,
    connect: () => runWithLock(() => device.connect()),
    switchPort: () => runWithLock(() => device.switchPort()),
    disconnect: () => run(() => device.disconnect()),
    flash: async (parts: FlashPart[]) => {
      let ok = true
      let errMsg: string | undefined
      try {
        await device.flash(parts)
      } catch (e) {
        ok = false
        errMsg = e instanceof Error ? e.message : String(e)
      }
      pushHistory({
        ts: Date.now(),
        chip: device.chip?.name ?? '未连接芯片',
        parts: parts.length,
        bytes: parts.reduce((n, p) => n + p.data.byteLength, 0),
        ok,
        error: errMsg,
      })
    },
    erase: () => run(() => device.erase()),
    hardReset: () => run(() => device.hardReset()),
    pauseMonitor: () => run(() => device.pauseMonitor()),
    resumeMonitor: () => run(() => device.resumeMonitor()),
    streamOn,
    clearError: () => device.clearError(),
    toggleViewPause,
    flashHistory,
    clearHistory,
    exportLogs: () => log.exportText(),
    clearLogs: () => {
      log.clear()
      logs.value = []
      pending.length = 0
      logChannel?.postMessage({ type: 'clear' })
    },
  }
}
