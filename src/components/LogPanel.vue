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

/** 距底 24px 内视为「在底部」——在此范围内新日志才自动跟随，否则视为用户正在翻看历史 */
const SCROLL_SLACK = 24
const atBottom = ref(true)

function scrollToBottom(): void {
  const el = body.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  atBottom.value = true
}

function onScroll(): void {
  const el = body.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_SLACK
}

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
    if (atBottom.value) scrollToBottom()
  },
)

// 过滤条件变化会重排列表，重置到底部并恢复自动跟随
watch(
  () => props.filter,
  () => {
    nextTick(scrollToBottom)
  },
)
</script>

<template>
  <section class="panel">
    <p v-if="viewPaused" class="logbar__hint">⏸ 视图已暂停——日志仍在后台收集，导出不受影响</p>
    <div ref="body" class="logbox" @scroll="onScroll">
      <p v-for="(e, i) in filtered" :key="e.seq" class="logline" :class="'logline--' + e.level">
        <span class="logline__n">{{ i + 1 }}</span>
        <span class="logline__ts">{{ new Date(e.ts).toLocaleTimeString() }}</span>
        <span class="logline__text">{{ e.text }}</span>
      </p>
      <p v-if="filtered.length === 0" class="logbox__empty">
        {{ logs.length === 0 ? '（暂无日志——连接设备并点「▶ 开始监视」）' : '（当前过滤条件下无匹配）' }}
      </p>
      <p v-if="listeningIdle" class="logbox__hint">
        已在监听但暂无设备输出——串口无缓冲，设备之前的输出无法追回：
        点面板「硬复位」（或按设备 RST 键）重启，即可从启动日志开头看起。
        若重启后仍长时间空白，多半是固件 console 口问题，见 <b>/docs/TROUBLESHOOTING.md §1</b>。
      </p>
      <!-- 终端提示符（b-ide 同款闪烁光标） -->
      <p class="logbox__prompt">❯<span class="logbox__cursor"></span></p>
      <p v-if="!atBottom" class="logbox__jumpbar">
        <button class="logbox__jump" type="button" title="回到底部并恢复自动滚动" @click="scrollToBottom">
          ↓ 回到底部
        </button>
      </p>
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
/* 「回到底部」悬浮按钮：sticky 固定在日志可视区底部，用户上翻看历史时出现 */
.logbox__jumpbar {
  position: sticky;
  bottom: 0;
  display: flex;
  justify-content: flex-end;
  margin: 4px 0 0;
  pointer-events: none;
}
.logbox__jump {
  pointer-events: auto;
  font-size: 11px;
  padding: 2px 10px;
  border: none;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  font-family: var(--sans, sans-serif);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}
.logbox__jump:hover {
  filter: brightness(1.12);
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
