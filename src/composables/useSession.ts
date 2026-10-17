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
import { playFlashErr, playFlashOk, primeAudio, isSoundEnabled, setSoundEnabled } from '../glue/audioFeedback'

const DISPLAY_CAP = 500
const FLUSH_MS = 120
const HISTORY_KEY = 'fw.flashHistory'
const HISTORY_CAP = 20
const AUTO_MONITOR_KEY = 'fw.autoMonitor'

/** 烧录历史条目（localStorage 持久，F 追加：排障/追溯） */
export interface FlashHistoryItem {
  ts: number
  chip: string
  parts: number
  bytes: number
  ok: boolean
  error?: string
}

/** 最近一次烧录结果（面板显式回执：✅/❌ + 段数/字节/耗时；新载入固件或再次烧录时清空） */
export interface FlashResult {
  ok: boolean
  parts: number
  bytes: number
  ms: number
  error?: string
}

/** 设备管理 + Vue 接线：批量 flush（渲染性能）、暂停视图、方向1 状态镜像 */
export function useSession() {
  const log = new Logger()
  const ops = createDeviceOps(log)
  const device = new DeviceManager(ops)
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

  /** 烧录逐段状态（表格行背景进度用） */
  const flashPart = computed(() => {
    const p = progress.value
    if (!p) return null
    return { index: p.partIndex, written: p.partWritten ?? 0, total: p.partTotal ?? 0 }
  })
  /** 失败段索引（该行标红后停止；载入新固件时复位） */
  const flashFailedIndex = ref<number | null>(null)
  /** 最近一次烧录回执（成功/失败都留一条可见结论） */
  const flashResult = ref<FlashResult | null>(null)
  /** 提示音开关（默认开，localStorage 持久） */
  const soundOn = ref(isSoundEnabled())
  function toggleSound(): void {
    soundOn.value = !soundOn.value
    setSoundEnabled(soundOn.value)
    if (soundOn.value) playFlashOk() // 打开立即试听一声，确认能听见
  }
  /** 烧录后自动监视开关（默认开，localStorage 持久）：烧写成功后自动开串口 + 信号复位抓启动日志 */
  const autoMonitor = ref(loadAutoMonitor())
  function loadAutoMonitor(): boolean {
    try {
      return globalThis.localStorage?.getItem(AUTO_MONITOR_KEY) !== '0'
    } catch {
      return true
    }
  }
  function toggleAutoMonitor(): void {
    autoMonitor.value = !autoMonitor.value
    try {
      globalThis.localStorage?.setItem(AUTO_MONITOR_KEY, autoMonitor.value ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  function resetFlashMarks(): void {
    flashFailedIndex.value = null
    flashResult.value = null
  }

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
    flashPart,
    flashFailedIndex,
    flashResult,
    resetFlashMarks,
    soundOn,
    toggleSound,
    autoMonitor,
    toggleAutoMonitor,
    connect: () => runWithLock(() => device.connect()),
    switchPort: () => runWithLock(() => device.switchPort()),
    disconnect: () => run(() => device.disconnect()),
    flash: async (parts: FlashPart[]) => {
      let ok = true
      let errMsg: string | undefined
      flashFailedIndex.value = null
      flashResult.value = null
      // 提示音解锁：必须在点击手势内创建/恢复 AudioContext，否则完成音会被自动播放策略静音
      primeAudio()
      const startedAt = Date.now()
      try {
        await device.flash(parts)
      } catch (e) {
        ok = false
        errMsg = e instanceof Error ? e.message : String(e)
        // 失败即停（esptool 段间串行）：标红当前段，其余段不会被写入
        flashFailedIndex.value = progress.value?.partIndex ?? 0
      } finally {
        // 结束后必须清进度：否则进度条停在上次位置不动（「卡住到一半」观感）
        device.clearProgress()
      }
      flashResult.value = {
        ok,
        parts: parts.length,
        bytes: parts.reduce((n, p) => n + p.data.byteLength, 0),
        ms: Date.now() - startedAt,
        error: errMsg,
      }
      pushHistory({
        ts: Date.now(),
        chip: device.chip?.name ?? '未连接芯片',
        parts: parts.length,
        bytes: parts.reduce((n, p) => n + p.data.byteLength, 0),
        ok,
        error: errMsg,
      })
      if (ok) {
        playFlashOk()
        // 烧录后自动监视（可关）：烧写成功自动开串口 + 信号复位，抓新固件完整启动日志。
        // 失败静默——烧录已成功，监视起不来不回调烧录结果、也不该变成 error。
        if (autoMonitor.value) {
          try {
            await device.resumeMonitor()
          } catch {
            /* ignore */
          }
        }
      } else {
        playFlashErr()
      }
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
    },
  }
}
