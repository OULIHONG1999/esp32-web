<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import EnvCheck from './components/EnvCheck.vue'
import ConnectPanel from './components/ConnectPanel.vue'
import FirmwarePanel from './components/FirmwarePanel.vue'
import LogPanel from './components/LogPanel.vue'
import { checkEnvironment, type EnvReport } from './env/environment'
import { useSession } from './composables/useSession'
import { useIdfBuild } from './composables/useIdfBuild'
import {
  isSubscribed,
  subscribeRegistry,
  type PublishEvent,
  type StreamStatus,
} from './api/registry'

const report = ref<EnvReport>(checkEnvironment())

const {
  state,
  chip,
  lastError,
  logs,
  busy,
  connected,
  canOperate,
  percent,
  viewPaused,
  connect,
  switchPort,
  disconnect,
  flash,
  erase,
  hardReset,
  clearError,
  exportLogs,
  clearLogs,
  setFlashParams,
  toggleViewPause,
  log,
} = useSession()

/** 编译完成 → 自动载入信号（FirmwarePanel watch 此值触发） */
const autoLoadSignal = ref(0)

const idf = useIdfBuild(log, () => {
  if (connected.value) {
    autoLoadSignal.value += 1
  } else {
    log.add({ level: 'info', source: 'app', text: '编译完成——设备未连接，连接后点「⚡ 载入本地构建」' })
  }
})

function onRecheck(): void {
  report.value = checkEnvironment()
}

function onErase(): void {
  const ok = window.confirm('确定要完全擦除设备 flash 吗？设备上所有数据将被清除，且不可恢复。')
  if (ok) void erase()
}

// ---- S3 订阅（F-21）：SSE 横幅 + NEW 角标 + 轮询降级 ----
const streamStatus = ref<StreamStatus | 'off'>('off')
const banner = ref<PublishEvent | null>(null)
const newReleases = ref<Record<string, boolean>>({})
const refreshSignal = ref(0)
let unsubscribe: (() => void) | null = null

function onStreamPublish(e: PublishEvent): void {
  if (!isSubscribed(e.project)) return // ★未订阅项目不打扰
  banner.value = e
  const key = `${e.project}/${e.variant}`
  newReleases.value = { ...newReleases.value, [key]: true }
  refreshSignal.value += 1 // 项目库列表自动拉新 latest
}

function onBannerView(): void {
  banner.value = null
  refreshSignal.value += 1
}

function onReleaseLoaded(key: string): void {
  const { [key]: _gone, ...rest } = newReleases.value
  newReleases.value = rest
}

onMounted(() => {
  unsubscribe = subscribeRegistry({
    onPublish: onStreamPublish,
    onStatus: (s) => {
      streamStatus.value = s
    },
    onGovern: () => {
      // 晋升/回滚 → 项目库与时间线自动刷新（不弹横幅，操作者自己就在页面）
      refreshSignal.value += 1
    },
  })
})
onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
  streamStatus.value = 'off'
})
</script>

<template>
  <div class="shell">
    <header class="shell__header">
      <span class="shell__brand">ESP32 Web Flasher</span>
      <span class="shell__hint">v0.2.0 · 设备常驻连接</span>
      <span
        class="shell__stream"
        :class="'shell__stream--' + streamStatus"
        :title="streamStatus === 'connected' ? 'SSE 订阅中：远端发布即时感知' : streamStatus === 'polling' ? 'SSE 断开，30s 轮询降级中' : '订阅未启动'"
      >
        {{ streamStatus === 'connected' ? '● 订阅中' : streamStatus === 'polling' ? '○ 轮询' : '○ 未订阅' }}
      </span>
    </header>

    <div v-if="banner" class="banner">
      <span class="banner__text">
        📢 <b>{{ banner.project }}</b> / {{ banner.variant }} 已发布
        <code>{{ banner.release.id }}</code>
      </span>
      <button class="banner__btn" type="button" @click="onBannerView">查看</button>
      <button class="banner__close" type="button" title="关闭" @click="banner = null">✕</button>
    </div>

    <main class="shell__main">
      <EnvCheck v-if="!report.ok" :report="report" @recheck="onRecheck" />

      <template v-else>
        <ConnectPanel
          :state="state"
          :chip="chip"
          :last-error="lastError"
          :busy="busy"
          @connect="connect"
          @switch-port="switchPort"
          @disconnect="disconnect"
          @dismiss-error="clearError"
        />

        <div v-if="idf.available" class="toolbar toolbar--idf">
          <span class="toolbar__label">IDF 命令：</span>
          <button
            class="btn"
            type="button"
            :disabled="idf.running.value"
            title="在本机执行 idf.py build，输出见日志面板"
            @click="idf.build"
          >
            🔨 编译
          </button>
          <button
            class="btn"
            type="button"
            :disabled="idf.running.value"
            title="idf.py fullclean 清理构建目录"
            @click="idf.clean"
          >
            🧹 清理
          </button>
          <button
            v-if="idf.running.value"
            class="btn btn--danger"
            type="button"
            title="taskkill 中止编译（慎用，可能留下半个 build 目录）"
            @click="idf.abort"
          >
            ■ 中止
          </button>
          <span v-if="idf.running.value" class="toolbar__hint">编译进行中…</span>
        </div>

        <div v-if="canOperate" class="toolbar">
          <button class="btn btn--danger" type="button" :disabled="busy" @click="onErase">
            完全擦除
          </button>
          <button class="btn" type="button" :disabled="busy" @click="hardReset">
            硬复位
          </button>
        </div>

        <FirmwarePanel
          v-if="connected"
          :disabled="!canOperate"
          :percent="percent"
          :chip-name="chip?.name ?? null"
          :build-running="idf.running.value"
          :auto-load-signal="autoLoadSignal"
          :new-releases="newReleases"
          :refresh-signal="refreshSignal"
          @flash="flash"
          @params="setFlashParams"
          @loaded="onReleaseLoaded"
        />

        <LogPanel
          :logs="logs"
          :export-text="exportLogs"
          :view-paused="viewPaused"
          @clear="clearLogs"
          @toggle-pause="toggleViewPause"
        />
      </template>
    </main>
  </div>
</template>

<style scoped>
.shell__header {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 860px;
  margin: 0 auto;
  padding: 16px 20px 0;
}
.shell__stream {
  margin-left: auto;
  font-size: 12px;
}
.shell__stream--connected {
  color: var(--accent);
}
.shell__stream--polling {
  color: var(--warn);
}
.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 auto;
  max-width: 860px;
  width: calc(100% - 40px);
  padding: 10px 14px;
  background: var(--panel);
  border: 1px solid var(--accent);
  border-radius: 8px;
  font-size: 13px;
}
.banner__text {
  flex: 1;
}
.banner__btn {
  background: var(--accent);
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
  font-weight: 600;
  color: #04150f;
}
.banner__close {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
}
.shell__main {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  max-width: 860px;
  margin: 0 auto;
}
.toolbar {
  display: flex;
  gap: 10px;
}
.toolbar--idf {
  align-items: center;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 16px;
}
.toolbar__label {
  color: var(--muted);
  font-size: 13px;
}
.toolbar__hint {
  color: var(--warn);
  font-size: 12px;
}
.btn {
  background: transparent;
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 16px;
  cursor: pointer;
  font-size: 14px;
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn--danger {
  border-color: var(--err);
  color: var(--err);
}
</style>
