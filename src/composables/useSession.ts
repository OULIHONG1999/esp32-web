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

const DISPLAY_CAP = 500
const FLUSH_MS = 120

/** 设备管理 + Vue 接线：批量 flush（渲染性能）、暂停视图、方向1 状态镜像 */
export function useSession() {
  const log = new Logger()
  const ops = createDeviceOps(log)
  const device = new DeviceManager(ops)

  const state: Ref<DeviceState> = ref(device.state)
  const chip: Ref<ChipInfo | null> = ref(null)
  const lastError: Ref<ClassifiedError | null> = ref(null)
  const progress: Ref<Progress | null> = ref(null)
  const logs: Ref<LogEntry[]> = ref([])
  const viewPaused = ref(false)

  device.setLineHandler((line) => {
    log.add({ level: 'device', source: 'device', text: line })
  })
  device.setNoticeHandler((message) => {
    log.add({ level: 'warn', source: 'serial', text: `⚠ ${message}——请重新连接` })
  })

  device.subscribe(() => {
    state.value = device.state
    chip.value = device.chip
    lastError.value = device.lastError
    progress.value = device.progress
  })

  // ---- 批量 flush：串口高速输出时避免每行触发一次响应式渲染 ----
  const pending: LogEntry[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function flush(): void {
    flushTimer = null
    if (viewPaused.value) return // 暂停期间不往视图推（logger 全量仍在收集）
    if (pending.length === 0) return
    logs.value.push(...pending)
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

  async function run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch {
      // 错误已入 device.lastError；UserCancel 已静默回 disconnected
    }
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
    connect: () => run(() => device.connect()),
    switchPort: () => run(() => device.switchPort()),
    disconnect: () => run(() => device.disconnect()),
    flash: (parts: FlashPart[]) => run(() => device.flash(parts)),
    erase: () => run(() => device.erase()),
    hardReset: () => run(() => device.hardReset()),
    toggleViewPause,
    exportLogs: () => log.exportText(),
    clearLogs: () => {
      log.clear()
      logs.value = []
      pending.length = 0
    },
  }
}
