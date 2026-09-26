<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { LogEntry } from '../core/log'

const props = defineProps<{
  logs: readonly LogEntry[]
  exportText: () => string
  monitorActive: boolean
  canStartMonitor: boolean
}>()
defineEmits<{ clear: []; start: []; stop: [] }>()

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
      <button
        v-if="!monitorActive"
        class="btn btn--live"
        type="button"
        :disabled="!canStartMonitor"
        :title="canStartMonitor ? '打开串口持续读取设备输出' : '需先断开烧录会话（状态 idle）'"
        @click="$emit('start')"
      >
        ▶ 实时日志
      </button>
      <button
        v-else
        class="btn btn--stop"
        type="button"
        @click="$emit('stop')"
      >
        ■ 停止
      </button>
      <button class="btn" type="button" @click="doExport">导出 .txt</button>
      <button class="btn" type="button" @click="$emit('clear')">清空</button>
      <span class="logbar__count">{{ logs.length }} 条</span>
    </div>
    <p v-if="monitorActive" class="logbar__hint">● 实时采集中——设备复位/重启的输出会实时滚动到这里</p>
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
