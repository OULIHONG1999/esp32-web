import { computed, ref, type Ref } from 'vue'
import { Logger, type LogEntry } from '../core/log'
import { FlashSession, type ChipInfo, type FlashPart, type Progress, type SessionState } from '../core/session'
import type { ClassifiedError } from '../core/errors'
import { createSessionDeps } from '../glue/sessionDeps'

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

  return {
    log,
    session,
    setFlashParams: deps.setFlashParams,
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
