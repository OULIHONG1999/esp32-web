<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { LogEntry } from '../core/log'

const props = defineProps<{
  logs: readonly LogEntry[]
  exportText: () => string
  viewPaused: boolean
}>()
defineEmits<{ clear: []; togglePause: [] }>()

const body = ref<HTMLElement | null>(null)

// ---- 级别过滤（高频排障：只看警告以上/错误/设备输出）----
type Filter = 'all' | 'warn' | 'error' | 'device'
const filter = ref<Filter>('all')

const FILTERS: { id: Filter; label: string; title: string }[] = [
  { id: 'all', label: '全部', title: '显示所有级别' },
  { id: 'warn', label: '⚠ 警告+', title: '仅 warn / error' },
  { id: 'error', label: '✖ 错误', title: '仅 error' },
  { id: 'device', label: '设备', title: '仅设备串口输出（device 级）' },
]

const filtered = computed<LogEntry[]>(() => {
  const list = props.logs
  switch (filter.value) {
    case 'warn':
      return list.filter((e) => e.level === 'warn' || e.level === 'error')
    case 'error':
      return list.filter((e) => e.level === 'error')
    case 'device':
      return list.filter((e) => e.level === 'device')
    default:
      return list as LogEntry[]
  }
})

watch(
  () => props.logs.length,
  async () => {
    await nextTick()
    body.value?.scrollTo({ top: body.value.scrollHeight })
  },
)

function doExport(): void {
  const blob = new Blob([props.exportText()], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `esp32-web-flash-log-${Date.now()}.txt`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="panel">
    <h2 class="panel__title">④ 日志</h2>
    <div class="logbar">
      <button
        class="btn"
        :class="viewPaused ? 'btn--live' : ''"
        type="button"
        :title="viewPaused ? '恢复滚动显示' : '暂停滚动显示（日志仍在收集）'"
        @click="$emit('togglePause')"
      >
        {{ viewPaused ? '▶ 恢复视图' : '⏸ 暂停视图' }}
      </button>
      <button class="btn" type="button" @click="doExport">导出 .txt</button>
      <button class="btn" type="button" @click="$emit('clear')">清空</button>
      <span class="logbar__count">
        {{ filtered.length }}/{{ logs.length }} 条{{ logs.length >= 500 ? '（仅显示最近 500）' : '' }}
      </span>
    </div>
    <div class="logbar logbar--filter">
      <button
        v-for="f in FILTERS"
        :key="f.id"
        class="btn btn--tiny"
        :class="filter === f.id ? 'btn--on' : ''"
        type="button"
        :title="f.title"
        @click="filter = f.id"
      >
        {{ f.label }}
      </button>
    </div>
    <p v-if="viewPaused" class="logbar__hint">⏸ 视图已暂停——日志仍在后台收集，导出不受影响</p>
    <div ref="body" class="logbox">
      <p v-for="e in filtered" :key="e.seq" class="logline" :class="'logline--' + e.level">
        <span class="logline__ts">{{ new Date(e.ts).toLocaleTimeString() }}</span>
        <span class="logline__text">{{ e.text }}</span>
      </p>
      <p v-if="filtered.length === 0" class="logbox__empty">
        {{ logs.length === 0 ? '（暂无日志）' : '（当前过滤条件下无匹配）' }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}
.panel__title {
  margin: 0 0 10px;
  font-size: 15px;
  font-weight: 600;
}
.logbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.btn--live {
  color: var(--accent);
  border-color: var(--accent);
}
.btn--stop {
  color: var(--err);
  border-color: var(--err);
}
.logbar__hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--accent);
}
.logbar__count {
  color: var(--muted);
  font-size: 12px;
  margin-left: auto;
}
.btn {
  background: transparent;
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 13px;
}
.logbox {
  height: var(--log-height, 240px);
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 1.7;
}
.logbox__empty {
  color: var(--muted);
}
.logline {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
}
.logline__ts {
  color: var(--muted);
  margin-right: 8px;
}
.logline--error {
  color: var(--err);
}
.logline--warn {
  color: var(--warn);
}
.logline--device {
  color: var(--info);
}
.logline--transfer {
  color: var(--accent);
}
.logline--info,
.logline--debug {
  color: var(--ink);
}
</style>
