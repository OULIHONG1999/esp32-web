<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { LogEntry } from '../core/log'

/** 日志级别过滤（与底部面板头「级别」下拉 v-model 共享） */
export type LogFilter = 'all' | 'warn' | 'error' | 'device'

const props = defineProps<{
  logs: readonly LogEntry[]
  exportText: () => string
  viewPaused: boolean
  /** 实时日志流是否开启（false=端口已释放，可交外部 idf.py monitor） */
  streamOn: boolean
  /** 未连接/操作中禁用手动监视开关 */
  monitorDisabled: boolean
  /** 独立日志窗口模式：保留自带工具行（控制在副窗） */
  minimal?: boolean
  /** 底部面板嵌入模式：标题/工具行/过滤行上提到面板头，只留终端本体 */
  embedded?: boolean
  /** 当前级别过滤（v-model:filter） */
  filter: LogFilter
}>()
defineEmits<{
  clear: []
  togglePause: []
  pauseMonitor: []
  resumeMonitor: []
  'update:filter': [f: LogFilter]
}>()

const body = ref<HTMLElement | null>(null)

const FILTERS: { id: LogFilter; label: string; title: string }[] = [
  { id: 'all', label: '全部', title: '显示所有级别' },
  { id: 'warn', label: '⚠ 警告+', title: '仅 warn / error' },
  { id: 'error', label: '✖ 错误', title: '仅 error' },
  { id: 'device', label: '设备', title: '仅设备串口输出（device 级）' },
]

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

/** 监听中但无设备输出的引导提示：出现过「实时日志已自动开启」却从未有过 device 级行 */
const listeningIdle = computed<boolean>(() => {
  const opened = props.logs.some((e) => e.text.includes('实时日志已自动开启'))
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

function doExport(): void {
  const blob = new Blob([props.exportText()], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `esp32-web-flash-log-${Date.now()}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

/** 独立日志窗口（副屏）：主窗口连接，数据经 BroadcastChannel 实时同步 */
function openLogWindow(): void {
  window.open(
    `${location.pathname}?panel=log`,
    'fw-log-window',
    'width=860,height=920,menubar=no,toolbar=no,location=no',
  )
}
</script>

<template>
  <section class="panel">
    <h2 v-if="!embedded" class="panel__title">④ 日志</h2>
    <div v-if="!embedded" class="logbar">
      <button
        class="btn"
        :class="viewPaused ? 'btn--live' : ''"
        type="button"
        :title="viewPaused ? '恢复滚动显示' : '暂停滚动显示（日志仍在收集）'"
        @click="$emit('togglePause')"
      >
        {{ viewPaused ? '▶ 恢复视图' : '⏸ 暂停视图' }}
      </button>
      <template v-if="!minimal">
        <button
          v-if="streamOn"
          class="btn"
          type="button"
          :disabled="monitorDisabled"
          title="停止读取串口并释放端口——之后可运行本机 idf.py monitor 查看日志"
          @click="$emit('pauseMonitor')"
        >
          ⏹ 停止监视
        </button>
        <button
          v-else
          class="btn btn--monitor"
          type="button"
          :disabled="monitorDisabled"
          title="重新打开串口实时读取（等价于本机 idf.py monitor，页面内进行）"
          @click="$emit('resumeMonitor')"
        >
          ▶ 开始监视
        </button>
        <button
          class="btn"
          type="button"
          title="在新窗口打开日志（适合副屏常驻）"
          @click="openLogWindow"
        >
          ⧉ 独立窗口
        </button>
      </template>
      <!-- 导出/清空在副窗同样需要（始终显示） -->
      <details class="more">
        <summary class="btn" title="更多操作">⋯</summary>
        <div class="more__pop">
          <button class="more__item" type="button" @click="doExport">导出 .txt</button>
          <button class="more__item" type="button" @click="$emit('clear')">清空</button>
        </div>
      </details>
      <span class="logbar__count">
        {{ filtered.length }}/{{ logs.length }} 条{{ logs.length >= 500 ? '（仅显示最近 500）' : '' }}
      </span>
    </div>
    <div v-if="!embedded" class="logbar logbar--filter">
      <button
        v-for="f in FILTERS"
        :key="f.id"
        class="btn btn--tiny"
        :class="filter === f.id ? 'btn--on' : ''"
        type="button"
        :title="f.title"
        @click="$emit('update:filter', f.id)"
      >
        {{ f.label }}
      </button>
      <span class="logbar__count">
        {{ filtered.length }}/{{ logs.length }} 条{{ logs.length >= 500 ? '（仅显示最近 500）' : '' }}
      </span>
    </div>
    <p v-if="viewPaused" class="logbar__hint">⏸ 视图已暂停——日志仍在后台收集，导出不受影响</p>
    <div ref="body" class="logbox">
      <p v-for="(e, i) in filtered" :key="e.seq" class="logline" :class="'logline--' + e.level">
        <span class="logline__n">{{ i + 1 }}</span>
        <span class="logline__ts">{{ new Date(e.ts).toLocaleTimeString() }}</span>
        <span class="logline__text">{{ e.text }}</span>
      </p>
      <p v-if="filtered.length === 0" class="logbox__empty">
        {{ logs.length === 0 ? '（暂无日志）' : '（当前过滤条件下无匹配）' }}
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
