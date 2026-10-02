<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import EnvCheck from './components/EnvCheck.vue'
import ConnectPanel from './components/ConnectPanel.vue'
import FirmwarePanel from './components/FirmwarePanel.vue'
import LogPanel from './components/LogPanel.vue'
import FlashHistory from './components/FlashHistory.vue'
import DashboardCard from './components/DashboardCard.vue'
import { checkEnvironment, type EnvReport } from './env/environment'
import { useSession } from './composables/useSession'
import {
  generateWorkToken,
  getStoredToken,
  isSubscribed,
  setStoredToken,
  subscribeRegistry,
  UnauthorizedError,
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
  flashHistory,
  clearHistory,
  streamOn,
  pauseMonitor,
  resumeMonitor,
  setFlashParams,
  toggleViewPause,
} = useSession()

// ---- 独立日志窗口模式（?panel=log：副屏日志页，数据由主窗口 BroadcastChannel 转发）----
const isLogWindow = new URLSearchParams(location.search).get('panel') === 'log'
const LOG_CHANNEL = 'fw-log'

if (isLogWindow && typeof BroadcastChannel !== 'undefined') {
  const ch = new BroadcastChannel(LOG_CHANNEL)
  ch.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as { type?: string; logs?: unknown[]; entries?: unknown[] } | null
    if (!m) return
    if (m.type === 'sync' && Array.isArray(m.logs)) {
      logs.value = m.logs as typeof logs.value
    } else if (m.type === 'append' && Array.isArray(m.entries)) {
      logs.value.push(...(m.entries as typeof logs.value))
      if (logs.value.length > 500) logs.value.splice(0, logs.value.length - 500)
    } else if (m.type === 'clear') {
      logs.value = []
    }
  })
  // 请求主窗口全量同步
  ch.postMessage({ type: 'sync-req' })
  // 主窗口若稍后才开，定期补请求（3s × 5 次收敛）
  let tries = 0
  const retry = setInterval(() => {
    ch.postMessage({ type: 'sync-req' })
    if (++tries >= 5) clearInterval(retry)
  }, 3000)
}

function onRecheck(): void {
  report.value = checkEnvironment()
}

/** 独立日志窗口关闭（window.close 仅脚本打开的窗口允许） */
function closeLogWindow(): void {
  window.close()
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

// ---- 日间/夜间主题（localStorage 持久，首屏由 index.html 内联脚本预置防闪）----
const theme = ref<string>(
  document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
)

function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme.value
  try {
    localStorage.setItem('fw.theme', theme.value)
  } catch {
    /* 私隐模式忽略 */
  }
}

// ---- 发布 token：生成工作 token（主 token 换）或手动设置本机 ----
const hasToken = ref(!!getStoredToken())

async function configureToken(): Promise<void> {
  const current = getStoredToken()
  const wantGenerate = window.confirm(
    (current ? `本机已配置 token（尾号 ${current.slice(-4)}）。\n` : '') +
      '【确定】= 生成新的工作 token（用于交给 AI/其它设备发布，需输入主 token）\n' +
      '【取消】= 手动设置本机 token',
  )

  if (wantGenerate) {
    const master = window.prompt('输入【主 token】（服务器 FIRMWARE_PUBLISH_TOKEN）以生成：')
    if (!master || !master.trim()) return
    try {
      const entry = await generateWorkToken(master.trim(), '页面生成')
      const swap = !getStoredToken()
      if (swap) {
        // 本机还没有 token → 顺手设为新工作 token，页面操作立即可用
        setStoredToken(entry.token)
        hasToken.value = true
      }
      window.alert(
        `✅ 新工作 token 已生成${swap ? '（已设为本机 token）' : '（本机仍用原 token）'}：\n\n` +
          `${entry.token}\n\n` +
          `用途：复制给 AI 或其它发布设备做 Authorization: Bearer\n` +
          `备注：${entry.note || '—'}\n` +
          `撤销：用主 token 调 DELETE /api/token`,
      )
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        window.alert('❌ 主 token 不正确——只有服务器的 FIRMWARE_PUBLISH_TOKEN 能生成。')
      } else {
        window.alert(`生成失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return
  }

  // 手动设置本机
  const input = window.prompt(
    current ? `当前尾号 ${current.slice(-4)}。\n粘贴新 token 替换，留空取消：` : '粘贴 token（主或工作均可）：',
    '',
  )
  if (input === null) return
  const t = input.trim()
  if (!t) return
  setStoredToken(t)
  hasToken.value = true
}
</script>

<template>
  <div class="shell">
    <!-- 独立日志窗口模式（?panel=log）：纯显示，数据由主窗口 BroadcastChannel 转发 -->
    <template v-if="isLogWindow">
      <header class="shell__header">
        <span class="shell__brand">📋 实时日志</span>
        <span class="shell__hint">独立窗口 · 连接与控制在主窗口</span>
        <button class="shell__token" type="button" title="关闭窗口" @click="closeLogWindow">
          ✕ 关闭
        </button>
      </header>
      <main class="shell__main shell__main--logfull">
        <LogPanel
          :logs="logs"
          :export-text="exportLogs"
          :view-paused="viewPaused"
          :stream-on="false"
          :monitor-disabled="true"
          :minimal="true"
          @clear="clearLogs"
          @toggle-pause="toggleViewPause"
        />
      </main>
    </template>

    <template v-else>
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
      <button
        class="shell__token"
        :class="hasToken ? 'shell__token--on' : 'shell__token--off'"
        type="button"
        :title="hasToken ? '发布 token 已配置（点击可更换）——晋升/回滚等操作用' : '设置发布 token——晋升/回滚等操作需要'"
        @click="configureToken"
      >
        🔑 {{ hasToken ? 'Token 已设' : '设置 Token' }}
      </button>
      <button
        class="shell__token"
        type="button"
        :title="theme === 'dark' ? '切换到日间主题' : '切换到夜间主题'"
        @click="toggleTheme"
      >
        {{ theme === 'dark' ? '☀️ 日间' : '🌙 夜间' }}
      </button>
    </header>

    <div v-if="banner" class="banner">
      <span class="banner__text">
        📢 <b>{{ banner.project }}</b> / {{ banner.variant }} 已发布
        <code>{{ banner.release.id }}</code>
      </span>
      <button class="banner__btn" type="button" @click="onBannerView">查看</button>
      <button class="banner__close" type="button" title="关闭" @click="banner = null">✕</button>
    </div>

    <DashboardCard v-if="report.ok" />

    <main class="shell__main">
      <EnvCheck v-if="!report.ok" :report="report" @recheck="onRecheck" />

      <template v-else>
        <div class="shell__layout">
          <!-- 左栏：操作区 -->
          <div class="shell__col shell__col--left">
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

            <div v-if="canOperate" class="toolbar">
              <button class="btn btn--danger" type="button" :disabled="busy" @click="onErase">
                完全擦除
              </button>
              <button class="btn" type="button" :disabled="busy" @click="hardReset">
                硬复位
              </button>
            </div>

            <FirmwarePanel
              :disabled="!canOperate"
              :percent="percent"
              :chip-name="chip?.name ?? null"
              :chip-detail="chip"
              :new-releases="newReleases"
              :refresh-signal="refreshSignal"
              @flash="flash"
              @params="setFlashParams"
              @loaded="onReleaseLoaded"
            />

            <FlashHistory :history="flashHistory" @clear="clearHistory" />
          </div>

          <!-- 右栏：日志常驻（宽屏钉住，内部滚动） -->
          <aside class="shell__col shell__col--right">
            <LogPanel
              :logs="logs"
              :export-text="exportLogs"
              :view-paused="viewPaused"
              :stream-on="streamOn"
              :monitor-disabled="!canOperate"
              @clear="clearLogs"
              @toggle-pause="toggleViewPause"
              @pause-monitor="pauseMonitor"
              @resume-monitor="resumeMonitor"
            />
          </aside>
        </div>
      </template>
    </main>
    </template><!-- /v-else 主界面 -->
  </div>
</template>

<style scoped>
.shell__header {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 1560px;
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
.shell__token {
  margin-left: 4px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  color: var(--ink);
}
.shell__token--on {
  border-color: var(--accent);
  color: var(--accent);
}
.shell__token--off {
  border-color: var(--warn);
  color: var(--warn);
}
.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 auto;
  max-width: 1560px;
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
  color: var(--accent-ink);
}
.banner__close {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
}
.shell__main--logfull {
  max-width: none;
  width: 100%;
  min-height: calc(100vh - 60px);
  padding: 10px 16px 16px;
  /* 日志盒铺满副窗：LogPanel 的 logbox 读取此变量 */
  --log-height: calc(100vh - 165px);
}
.shell__main--logfull .panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.shell__main--logfull .logbox {
  flex: 1;
  height: auto;
  min-height: 0;
}.shell__main {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  max-width: 1560px;
  margin: 0 auto;
}
/* 左右两栏：操作左、日志右（宽屏利用率；窄屏回退单列） */
.shell__layout {
  display: grid;
  grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
  gap: 14px;
  align-items: start;
}
.shell__col {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.shell__col--right {
  position: sticky;
  top: 12px;
  /* 日志盒高度 = 视口减去头部余量（LogPanel 读取此变量） */
  --log-height: calc(100vh - 150px);
}
@media (max-width: 960px) {
  .shell__layout {
    grid-template-columns: 1fr;
  }
  .shell__col--right {
    position: static;
    --log-height: 240px;
  }
}
.toolbar {
  display: flex;
  gap: 10px;
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
