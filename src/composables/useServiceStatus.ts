/**
 * 服务状态共享数据（/api/status，60s 自动刷新）。
 * 单例：侧栏 side-card 与状态栏共用同一份快照，避免双请求。
 */
import { ref } from 'vue'

export interface ServiceSnap {
  projects: number
  releases: number
  latestPublishAt: string | null
  dataDirBytes: number
  uptimeSeconds: number
}

const snap = ref<ServiceSnap | null>(null)
const err = ref('')
let started = false
let timer: ReturnType<typeof setInterval> | null = null

async function refresh(): Promise<void> {
  try {
    const r = await fetch('/api/status')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    snap.value = (await r.json()) as ServiceSnap
    err.value = ''
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

export function fmtSize(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

export function useServiceStatus() {
  if (!started) {
    started = true
    void refresh()
    timer = setInterval(() => void refresh(), 60_000)
  }
  void timer
  return { snap, err, refresh }
}
