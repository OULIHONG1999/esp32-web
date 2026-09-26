<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { LogEntry } from '../core/log'

const props = defineProps<{
  logs: readonly LogEntry[]
  exportText: () => string
}>()
defineEmits<{ clear: [] }>()

const body = ref<HTMLElement | null>(null)

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
      <button class="btn" type="button" @click="doExport">导出 .txt</button>
      <button class="btn" type="button" @click="$emit('clear')">清空</button>
      <span class="logbar__count">{{ logs.length }} 条</span>
    </div>
    <div ref="body" class="logbox">
      <p v-for="(e, i) in logs" :key="i" class="logline" :class="'logline--' + e.level">
        <span class="logline__ts">{{ new Date(e.ts).toLocaleTimeString() }}</span>
        <span class="logline__text">{{ e.text }}</span>
      </p>
      <p v-if="logs.length === 0" class="logbox__empty">（暂无日志）</p>
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
  height: 240px;
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
  color: #79c0ff;
}
.logline--transfer {
  color: var(--accent);
}
.logline--info,
.logline--debug {
  color: var(--ink);
}
</style>
