import { computed, ref, type Ref } from 'vue'
import { Logger, type LogEntry } from '../core/log'
import { FlashSession, type ChipInfo, type FlashPart, type Progress, type SessionState } from '../core/session'
import type { ClassifiedError } from '../core/errors'
import { createSessionDeps } from '../glue/sessionDeps'
import { SerialMonitor } from '../glue/monitor'
import { requestPort } from '../glue/esptool'

/** Vue 与 FlashSession/Logger 的接线（ref 镜像 subscribe 通知） */
export function useSession() {
  const log = new Logger()
  const deps = createSessionDeps(log)
  const session = new FlashSession(deps)

  const state: Ref<SessionState> = ref(session.state)
  const chip: Ref<ChipInfo | null> = ref(null)
  const lastError: Ref<ClassifiedError | null> = ref(null)
  const progress: Ref<Progress | null> = ref(null)
  const logs: Ref<LogEntry[]> = ref([])
  const monitorActive = ref(false)

  let monitor: SerialMonitor | null = null

  session.subscribe(() => {
    state.value = session.state
    chip.value = session.chip
    lastError.value = session.lastError
    progress.value = session.progress
  })
  log.subscribe((entry) => {
    logs.value.push(entry)
    if (logs.value.length > 2000) logs.value.splice(0, logs.value.length - 2000)
  })

  const busy = computed(() =>
    ['requesting', 'detecting', 'flashing', 'erasing', 'resetting'].includes(state.value),
  )
  const canFlash = computed(
    () => ['ready', 'done'].includes(state.value) && !busy.value,
  )
  const percent = computed(() => {
    const p = progress.value
    if (!p || p.total === 0) return null
    return Math.min(100, Math.round((p.written / p.total) * 100))
  })

  async function run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch {
      // 错误已落入 session.lastError / UserCancel 已回 idle，这里吞掉避免 unhandled rejection
    }
  }

  /** 实时日志监视（与烧录会话互斥，需先断开回 idle） */
  async function startMonitor(baudRate = 115200): Promise<void> {
    if (session.state !== 'idle') {
      log.add({
        level: 'warn',
        source: 'app',
        text: '请先断开烧录会话，再启动实时日志',
      })
      return
    }
    try {
      const port = deps.getLastPort() ?? (await requestPort())
      monitor = new SerialMonitor({
        onLine: (line) => {
          log.add({ level: 'device', source: 'device', text: line })
        },
        onStopped: (reason, message) => {
          monitorActive.value = false
          if (reason === 'error') {
            log.add({
              level: 'warn',
              source: 'serial',
              text: `日志流中断：${message ?? '连接断开'}`,
            })
          } else {
            log.add({ level: 'info', source: 'app', text: '实时日志已停止' })
          }
          monitor = null
        },
      })
      await monitor.start(port, baudRate)
      monitorActive.value = true
      log.add({
        level: 'info',
        source: 'app',
        text: `实时日志已启动（${baudRate} 波特率）——设备复位后将在这里滚动输出`,
      })
    } catch (err) {
      monitorActive.value = false
      monitor = null
      log.add({
        level: 'error',
        source: 'serial',
        text: `无法打开串口：${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  async function stopMonitor(): Promise<void> {
    if (monitor) await monitor.stop()
  }

  return {
    log,
    session,
    setFlashParams: deps.setFlashParams,
    monitorActive,
    startMonitor,
    stopMonitor,
    state,
    chip,
    lastError,
    progress,
    logs,
    busy,
    canFlash,
    percent,
    connect: () => run(() => session.connect()),
    flash: (parts: FlashPart[]) => run(() => session.flash(parts)),
    erase: () => run(() => session.erase()),
    hardReset: () => run(() => session.hardReset()),
    release: () => run(() => session.release()),
    exportLogs: () => log.exportText(),
    clearLogs: () => {
      log.clear()
      logs.value = []
    },
  }
}
