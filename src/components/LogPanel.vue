<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { LogEntry } from '../core/log'

/** 日志级别过滤（与底部面板头「级别」下拉 v-model 共享） */
export type LogFilter = 'all' | 'warn' | 'error' | 'device'

const props = defineProps<{
  logs: readonly LogEntry[]
  viewPaused: boolean
  /** 当前级别过滤（面板头控制） */
  filter: LogFilter
}>()

const body = ref<HTMLElement | null>(null)

const filtered = computed<LogEntry[]>(() => {
  const list = props.logs
  switch (props.filter) {
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

/** 监听中但无设备输出的引导提示：出现过「实时日志已开启」却从未有过 device 级行 */
const listeningIdle = computed<boolean>(() => {
  const opened = props.logs.some((e) => e.text.includes('实时日志已开启'))
  const anyDevice = props.logs.some((e) => e.level === 'device')
  return opened && !anyDevice
})

watch(
  () => props.logs.length,
  async () => {
    await nextTick()
    body.value?.scrollTo({ top: body.value.scrollHeight })
  },
)
</script>

<template>
  <section class="panel">
    <p v-if="viewPaused" class="logbar__hint">⏸ 视图已暂停——日志仍在后台收集，导出不受影响</p>
    <div ref="body" class="logbox">
      <p v-for="(e, i) in filtered" :key="e.seq" class="logline" :class="'logline--' + e.level">
        <span class="logline__n">{{ i + 1 }}</span>
        <span class="logline__ts">{{ new Date(e.ts).toLocaleTimeString() }}</span>
        <span class="logline__text">{{ e.text }}</span>
      </p>
      <p v-if="filtered.length === 0" class="logbox__empty">
        {{ logs.length === 0 ? '（暂无日志——连接设备并点「▶ 开始监视」）' : '（当前过滤条件下无匹配）' }}
      </p>
      <p v-if="listeningIdle" class="logbox__hint">
        日志流已监听但暂无设备输出——若烧录/复位后仍长时间空白，多半是固件 console 口问题（非网站故障），
        见 <b>/docs/TROUBLESHOOTING.md §1</b>
      </p>
      <!-- 终端提示符（b-ide 同款闪烁光标） -->
      <p class="logbox__prompt">❯<span class="logbox__cursor"></span></p>
    </div>
  </section>
</template>

<style scoped>
.panel {
  background: transparent;
  border: none;
  padding: 0;
}
.logbar__hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--accent);
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
.logbox__hint {
  color: var(--warn);
  font-size: 12px;
  font-family: var(--sans, sans-serif);
  line-height: 1.6;
}
.logline {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
}
.logline__n {
  display: inline-block;
  width: 26px;
  text-align: right;
  margin-right: 10px;
  color: var(--muted);
  opacity: 0.45;
  user-select: none;
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
/* 终端提示符与闪烁光标（b-ide 同款） */
.logbox__prompt {
  margin: 2px 0 0;
  color: var(--accent);
  font-weight: 700;
}
.logbox__cursor {
  display: inline-block;
  width: 7px;
  height: 13px;
  background: var(--ink);
  margin-left: 4px;
  vertical-align: -2px;
  animation: logblink 1s steps(1) infinite;
}
@keyframes logblink {
  50% {
    opacity: 0;
  }
}
</style>
