import { onBeforeUnmount, ref, type Ref } from 'vue'
import type { Logger } from '../core/log'
import { abortIdfCommand, fetchBuildStatus, startIdfCommand } from '../api/buildCommands'

const POLL_MS = 900

/**
 * idf.py build / fullclean 的前端编排（仅 dev 中间件可用时存在）。
 * 输出行 → Logger（与设备日志同面板）；成功回调用于"编译完自动载入"。
 */
export function useIdfBuild(log: Logger, onBuildSuccess?: () => void) {
  const available = ref(false)
  const running = ref(false)
  const currentCmd = ref<'build' | 'clean' | null>(null)
  let cursor = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let probed = false

  async function probe(): Promise<void> {
    if (probed) return
    probed = true
    const s = await fetchBuildStatus(cursor)
    if (!s) {
      available.value = false
      return
    }
    available.value = true
    cursor = s.totalLines - s.newLines.length
    if (s.running) {
      running.value = true
      currentCmd.value = s.cmd
      appendLines(s.newLines)
      ensurePolling()
    }
  }

  function appendLines(newLines: string[]): void {
    for (const line of newLines) {
      const level = /error|failed|失败/i.test(line)
        ? 'error'
        : /warning|warn/i.test(line)
          ? 'warn'
          : 'info'
      log.add({ level, source: 'app', text: `[idf] ${line}` })
    }
  }

  async function tick(): Promise<void> {
    const s = await fetchBuildStatus(cursor)
    if (!s) return
    if (s.newLines.length) {
      appendLines(s.newLines)
      cursor += s.newLines.length
    }
    if (!s.running && running.value) {
      // 命令结束
      running.value = false
      currentCmd.value = null
      stopPolling()
      if (s.exitCode === 0 && s.cmd === 'build') {
        log.add({ level: 'info', source: 'app', text: '编译成功——自动载入固件段' })
        onBuildSuccess?.()
      } else if (s.exitCode !== 0) {
        log.add({
          level: 'error',
          source: 'app',
          text: `编译失败（exit ${s.exitCode}）——详见上方输出`,
        })
      }
    }
  }

  function ensurePolling(): void {
    if (timer) return
    timer = setInterval(() => void tick(), POLL_MS)
  }

  function stopPolling(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  async function run(cmd: 'build' | 'clean'): Promise<void> {
    if (running.value) return
    const ok = await startIdfCommand(cmd)
    if (!ok) {
      log.add({ level: 'error', source: 'app', text: '启动 idf.py 命令失败（可能已有任务在跑）' })
      return
    }
    running.value = true
    currentCmd.value = cmd
    cursor = 0
    log.add({
      level: 'info',
      source: 'app',
      text: cmd === 'build' ? '🔨 开始编译（idf.py build）…' : '🧹 清理构建目录（idf.py fullclean）…',
    })
    ensurePolling()
  }

  async function abort(): Promise<void> {
    await abortIdfCommand()
  }

  probe()
  onBeforeUnmount(stopPolling)

  return {
    available: available as Ref<boolean>,
    running: running as Ref<boolean>,
    currentCmd,
    build: () => run('build'),
    clean: () => run('clean'),
    abort,
  }
}
