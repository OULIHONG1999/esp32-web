<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

interface StatusSnap {
  projects: number
  releases: number
  latestPublishAt: string | null
  dataDirBytes: number
  uptimeSeconds: number
}

const st = ref<StatusSnap | null>(null)
const err = ref('')
let timer: ReturnType<typeof setInterval> | null = null

async function refresh(): Promise<void> {
  try {
    const r = await fetch('/api/status')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    st.value = (await r.json()) as StatusSnap
    err.value = ''
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function fmtAgo(iso: string | null): string {
  if (!iso) return '—'
  const diff = Math.max(0, Date.now() - new Date(iso).getTime())
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600)
  if (h >= 24) return `${Math.floor(h / 24)} 天 ${h % 24} 小时`
  if (h >= 1) return `${h} 小时 ${Math.floor((sec % 3600) / 60)} 分`
  return `${Math.floor(sec / 60)} 分`
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), 60_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="dash" :class="{ 'dash--err': !!err }" :title="err ? '状态接口异常：' + err : '服务状态（每分钟自动刷新）'">
    <span class="dash__cell dash__cell--live">
      <i class="dash__dot" :class="err ? 'dash__dot--off' : ''"></i>
      {{ err ? '服务不可达' : '服务在线' }}
    </span>
    <span class="dash__cell"><i>项目</i>{{ st?.projects ?? '—' }}</span>
    <span class="dash__cell"><i>版本</i>{{ st?.releases ?? '—' }}</span>
    <span class="dash__cell"><i>数据</i>{{ st ? fmtSize(st.dataDirBytes) : '—' }}</span>
    <span class="dash__cell"><i>最近发布</i>{{ st ? fmtAgo(st.latestPublishAt) : '—' }}</span>
    <span class="dash__cell"><i>运行</i>{{ st ? fmtUptime(st.uptimeSeconds) : '—' }}</span>
    <button class="dash__refresh" type="button" title="立即刷新" @click="refresh()">↻</button>
  </div>
</template>

<style scoped>
.dash {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  max-width: 1560px;
  width: calc(100% - 40px);
  margin: 8px auto 0;
  padding: 8px 14px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 12px;
}
.dash--err {
  border-color: var(--err);
}
.dash__cell {
  color: var(--ink);
  white-space: nowrap;
}
.dash__cell i {
  font-style: normal;
  color: var(--muted);
  margin-right: 6px;
}
.dash__cell--live {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.dash__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  display: inline-block;
}
.dash__dot--off {
  background: var(--err);
}
.dash__refresh {
  margin-left: auto;
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--muted);
  cursor: pointer;
  padding: 1px 8px;
  font-size: 12px;
}
.dash__refresh:hover {
  color: var(--accent);
  border-color: var(--accent);
}
</style>
