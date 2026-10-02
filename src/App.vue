<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import EnvCheck from './components/EnvCheck.vue'
import FirmwarePanel from './components/FirmwarePanel.vue'
import VersionTimeline from './components/VersionTimeline.vue'
import LogPanel, { type LogFilter } from './components/LogPanel.vue'
import FlashHistory from './components/FlashHistory.vue'
import ActivityBar, { type ActivityItem } from './components/ide/ActivityBar.vue'
import Sidebar from './components/ide/Sidebar.vue'
import TreeSection from './components/ide/TreeSection.vue'
import TreeItem, { type TreeTag } from './components/ide/TreeItem.vue'
import EditorTabs, { type WorkTab } from './components/ide/EditorTabs.vue'
import BottomPanel, { type BottomTab } from './components/ide/BottomPanel.vue'
import StatusBar from './components/ide/StatusBar.vue'
import { checkEnvironment, type EnvReport } from './env/environment'
import { useSession } from './composables/useSession'
import { useFirmwareWorkspace } from './composables/useFirmwareWorkspace'
import { useServiceStatus, fmtSize } from './composables/useServiceStatus'
import {
  collectReleases,
  generateWorkToken,
  getStoredToken,
  isSubscribed,
  setStoredToken,
  subscribeRegistry,
  UnauthorizedError,
  type FlashParams,
  type PublishEvent,
  type RegistryOption,
  type RegistryRelease,
  type StreamStatus,
} from './api/registry'

const report = ref<EnvReport>(checkEnvironment())

const {
  state,
  chip,
  lastError,
  logs,
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

// ---- 发布 token / 主题（先声明，workspace deps 引用） ----
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

// ---- S3 订阅（F-21）：SSE 横幅 + NEW 角标 + 轮询降级 ----
const streamStatus = ref<StreamStatus | 'off'>('off')
const banner = ref<PublishEvent | null>(null)
const newReleases = ref<Record<string, boolean>>({}) // 项目/变体级（侧栏文件夹 NEW）
const newReleaseIds = ref<Record<string, boolean>>({}) // 版本级（侧栏版本行 NEW）
const refreshSignal = ref(0)
let unsubscribe: (() => void) | null = null

function onStreamPublish(e: PublishEvent): void {
  if (!isSubscribed(e.project)) return // ★未订阅项目不打扰
  banner.value = e
  const key = `${e.project}/${e.variant}`
  newReleases.value = { ...newReleases.value, [key]: true }
  newReleaseIds.value = { ...newReleaseIds.value, [e.release.id]: true }
  refreshSignal.value += 1 // 项目库列表自动拉新 latest
}

function onBannerView(): void {
  banner.value = null
  refreshSignal.value += 1
}

function onReleaseLoaded(key: string, releaseId?: string): void {
  const { [key]: _gone, ...rest } = newReleases.value
  newReleases.value = rest
  if (releaseId) {
    const { [releaseId]: _gone2, ...rest2 } = newReleaseIds.value
    newReleaseIds.value = rest2
  }
}

// ---- 固件工作区（侧栏项目树 / 固件标签页 / 时间线标签页共享） ----
const activeParams = ref<FlashParams | null>(null)

const ws = useFirmwareWorkspace({
  getChipName: () => chip.value?.name ?? null,
  onParams: (p) => {
    activeParams.value = p
    setFlashParams(p)
  },
  onLoaded: (key, releaseId) => onReleaseLoaded(key, releaseId),
})

// 远端发布 → 项目库自动刷新（原 FirmwarePanel 内 watch，上提至此）
watch(refreshSignal, (n) => {
  if (n > 0) void ws.refreshRegistry()
})

// ---- 隐藏的共享文件选择器（侧栏「添加 bin」与固件页共用） ----
const addInput = ref<HTMLInputElement | null>(null)

function pickFiles(): void {
  addInput.value?.click()
}

function onAddFiles(e: Event): void {
  const input = e.target as HTMLInputElement
  ws.addFiles(Array.from(input.files ?? []), chip.value?.name ?? null)
  input.value = ''
  activeTab.value = 'fw'
}

// ---- IDE 注册表（扩展点：加一行 + 对应插槽即完成接入；顺序按 b-ide 蓝本） ----
const hasNewRelease = computed(
  () =>
    Object.keys(newReleaseIds.value).length > 0 ||
    Object.keys(newReleases.value).length > 0,
)

const activityItems = computed<ActivityItem[]>(() => [
  { id: 'device', icon: '▣', title: '设备（定位侧栏）' },
  { id: 'firmware', icon: '⬚', title: '固件（工作区）' },
  { id: 'timeline', icon: '◷', title: '版本时间线（工作区）', badge: hasNewRelease.value },
  { id: 'library', icon: '📁', title: '项目库（定位侧栏）' },
  { id: 'history', icon: '▤', title: '烧录历史（定位侧栏）' },
  { id: 'service', icon: '◉', title: '服务状态（定位侧栏）' },
])
const activityEndItems: ActivityItem[] = [
  { id: 'theme', icon: '⚙', title: '切换日 / 夜主题' },
]
const activeActivity = ref('firmware')

/** 标签动态名：载入后带首个文件名（b-ide「固件 · hello_world.bin」） */
const workTabs = computed<WorkTab[]>(() => [
  {
    id: 'fw',
    label:
      ws.state.rows.length > 0 && ws.state.rows[0].file
        ? `固件 · ${ws.state.rows[0].file.name}`
        : '固件',
    icon: '⬚',
  },
  { id: 'tl', label: '版本时间线', icon: '◷' },
])
const activeTab = ref('fw')

// ---- 底部面板（b-ide 三标签：问题 / 输出 / 日志监视器） ----
const bottomTabs: BottomTab[] = [
  { id: 'issues', label: '问题' },
  { id: 'output', label: '输出' },
  { id: 'log', label: '日志监视器' },
]
const activeBottom = ref('log')
const bottomCollapsed = ref(false)
const bpFilter = ref<LogFilter>('all')

const issueLogs = computed(() =>
  logs.value.filter((e) => e.level === 'warn' || e.level === 'error'),
)
const deviceLogs = computed(() => logs.value.filter((e) => e.level === 'device'))

// ---- 服务状态（side-card + 状态栏共用单例快照） ----
const svc = useServiceStatus()
const subscribedCount = computed(
  () => ws.state.options.filter((o) => o.subscribed).length,
)
const serviceLabel = computed(() => {
  if (svc.err.value) return '◉ 服务不可达'
  const s = svc.snap.value
  return s ? `◉ 服务在线 ${s.projects}/${s.releases}` : '◉ 服务…'
})

/** 独立日志窗口（面板头 ⧉ 按钮） */
function openLogWindow(): void {
  window.open(
    `${location.pathname}?panel=log`,
    'fw-log-window',
    'width=860,height=920,menubar=no,toolbar=no,location=no',
  )
}

/** 面板头「导出」 */
function downloadLogs(): void {
  const blob = new Blob([exportLogs()], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `esp32-web-flash-log-${Date.now()}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

function onActivity(id: string): void {
  if (id === 'firmware') {
    activeTab.value = 'fw'
    bottomCollapsed.value = false
    return
  }
  if (id === 'timeline') {
    activeTab.value = 'tl'
    return
  }
  if (id === 'theme') {
    toggleTheme()
    return
  }
  // 定位类：滚动侧栏对应分区到可视区
  document.getElementById('sec-' + id)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

/** 项目树/时间线载入成功后切到固件标签展示清单 */
function loadAndShow(opt: RegistryOption | null | undefined, rel: RegistryRelease): void {
  if (!opt) return
  void ws.loadRelease(opt, rel).then(() => {
    activeTab.value = 'fw'
  })
}

const selectedOption = computed<RegistryOption | null>(
  () => ws.state.options[ws.state.selectedIdx] ?? null,
)

function releasesOf(opt: RegistryOption): RegistryRelease[] {
  if (!ws.state.rawRegistry) return []
  return collectReleases(ws.state.rawRegistry, opt.projectId, opt.variant)
}

function folderTags(opt: RegistryOption): TreeTag[] {
  return newReleases.value[opt.projectId + '/' + opt.variant]
    ? [{ text: 'NEW', kind: 'new' }]
    : []
}

function releaseTags(rel: RegistryRelease): TreeTag[] {
  const tags: TreeTag[] =
    rel.type === 'release' ? [{ text: '★发布', kind: 'rel' }] : [{ text: '快照', kind: 'snap' }]
  if (newReleaseIds.value[rel.id]) tags.push({ text: 'NEW', kind: 'new' })
  return tags
}

const STATE_DOT: Record<string, 'ok' | 'off' | 'warn' | 'err'> = {
  disconnected: 'off',
  requesting: 'warn',
  detecting: 'warn',
  ready: 'ok',
  working: 'warn',
  error: 'err',
}

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
  <!-- ═══ 独立日志窗口（?panel=log）：纯显示，数据由主窗口 BroadcastChannel 转发 ═══ -->
  <div v-if="isLogWindow" class="logwin">
    <header class="logwin__hd">
      <span class="logwin__brand">📋 实时日志</span>
      <span class="logwin__hint">独立窗口 · 连接与控制在主窗口</span>
      <button class="logwin__close" type="button" title="关闭窗口" @click="closeLogWindow">
        ✕ 关闭
      </button>
    </header>
    <main class="logwin__main">
      <LogPanel
        :logs="logs"
        :export-text="exportLogs"
        :view-paused="viewPaused"
        :stream-on="false"
        :monitor-disabled="true"
        :filter="bpFilter"
        :minimal="true"
        @clear="clearLogs"
        @toggle-pause="toggleViewPause"
        @update:filter="(f) => (bpFilter = f)"
      />
    </main>
  </div>

  <!-- ═══ 主界面：IDE 五区骨架（b-ide 复刻） ═══ -->
  <div v-else class="ide">
    <!-- 区1 活动栏（跨行） -->
    <ActivityBar
      v-model="activeActivity"
      :items="activityItems"
      :end-items="activityEndItems"
      @select="onActivity"
    />

    <!-- 区2 侧栏：VS Code 树形资源管理器（跨行） -->
    <Sidebar>
      <!-- 设备（b-ide：纯信息树行 + 树行操作） -->
      <TreeSection id="sec-device" title="设备">
        <TreeItem
          icon="▣"
          :label="chip?.name ?? '（未连接）'"
          :sub="chip && state === 'ready' ? '@ 常驻' : undefined"
          :dot="STATE_DOT[state]"
        />
        <TreeItem v-if="chip?.mac" icon="⌗" :label="chip.mac" :indent="1" />
        <TreeItem
          v-if="chip?.flashSize"
          icon="◫"
          :label="'Flash ' + chip.flashSize"
          :sub="chip.revision ? 'Rev ' + chip.revision : undefined"
          :indent="1"
        />
        <TreeItem icon="◉" :label="state" :sub="state === 'ready' ? '日志监视中' : undefined" />

        <!-- 操作行（树行形态，b-ide 快捷操作同款） -->
        <TreeItem
          v-if="state === 'disconnected' || state === 'error'"
          accent
          icon="▶"
          label="连接设备"
          title="选择串口（首次弹出浏览器选择器，之后免弹窗复用）"
          @click="connect"
        />
        <TreeItem
          v-else-if="state === 'requesting' || state === 'detecting'"
          icon="…"
          label="连接中…"
          disabled
        />
        <template v-else>
          <TreeItem v-if="state === 'ready'" icon="⇄" label="切换端口" @click="switchPort" />
          <TreeItem icon="⏏" label="断开设备" :disabled="state === 'working'" @click="disconnect" />
        </template>

        <!-- D3：ready 态烧录失败的错误条也可见，可手动关闭 -->
        <div v-if="lastError && (state === 'error' || state === 'ready')" class="dev-err">
          <button class="dev-err__x" type="button" title="关闭" @click="clearError">✕</button>
          <p class="dev-err__msg">{{ lastError.message }}</p>
          <p class="dev-err__hint">{{ lastError.hint }}</p>
          <p class="dev-err__cls">分类：{{ lastError.cls }}</p>
        </div>
        <p v-if="state === 'ready'" class="dev-hint">
          设备常驻连接：烧录/擦除会自动挂起日志，结束后自动恢复。
        </p>
      </TreeSection>

      <!-- 项目库（树形：项目文件夹 → 版本行） -->
      <TreeSection id="sec-library" title="项目库">
        <template #actions>
          <button
            class="mini"
            type="button"
            :disabled="ws.state.selectedIdx < 0"
            :title="
              ws.state.selectedIdx >= 0 && ws.state.options[ws.state.selectedIdx]?.subscribed
                ? '取消订阅该项目（发布会静默）'
                : '订阅该项目（发布会横幅提醒）'
            "
            @click="ws.toggleSubscribe()"
          >
            {{
              ws.state.selectedIdx >= 0 && ws.state.options[ws.state.selectedIdx]?.subscribed
                ? '★'
                : '☆'
            }}
          </button>
          <button
            class="mini"
            type="button"
            :disabled="ws.state.registryLoading"
            title="拉取 /api/registry 最新版本列表"
            @click="ws.refreshRegistry()"
          >
            {{ ws.state.registryLoading ? '…' : '↻' }}
          </button>
        </template>

        <p v-if="ws.state.registryLoading && ws.state.options.length === 0" class="tree-msg">
          拉取中…
        </p>
        <p v-else-if="ws.state.options.length === 0" class="tree-msg">
          {{ ws.state.registryMsg ?? '服务器暂无已发布项目' }}
        </p>
        <template v-else>
          <template v-for="(opt, i) in ws.state.options" :key="opt.projectId + '/' + opt.variant">
            <TreeItem
              icon="📁"
              :label="opt.projectName + ' / ' + opt.variant"
              :active="ws.state.selectedIdx === i"
              :tags="folderTags(opt)"
              @click="ws.selectOption(i)"
            />
            <TreeItem
              v-for="rel in releasesOf(opt)"
              :key="rel.id"
              :indent="1"
              :label="rel.id"
              :tags="releaseTags(rel)"
              :active="rel.id === opt.release.id"
              @click="loadAndShow(opt, rel)"
            />
          </template>
        </template>
        <p v-if="ws.state.registryMsg && ws.state.options.length > 0" class="tree-msg">
          {{ ws.state.registryMsg }}
        </p>
      </TreeSection>

      <!-- 快捷操作 -->
      <TreeSection id="sec-actions" title="快捷操作">
        <TreeItem icon="＋" label="添加 bin 文件…" @click="pickFiles()" />
        <template v-if="canOperate">
          <TreeItem icon="⌫" label="完全擦除" @click="onErase()" />
          <TreeItem icon="↻" label="硬复位" @click="hardReset()" />
        </template>
        <TreeItem v-if="state === 'ready'" icon="⇄" label="切换端口" @click="switchPort()" />
      </TreeSection>

      <!-- b-ide 侧栏底部卡：烧录历史 + 服务状态 合一 -->
      <div class="side-card">
        <div id="sec-history">
          <FlashHistory plain :history="flashHistory" @clear="clearHistory" />
        </div>
        <div id="sec-service" class="side-card__svc">
          <span class="side-card__svc-live" :class="{ 'side-card__svc-live--bad': svc.err.value }">
            {{ svc.err.value ? '服务不可达' : '服务在线' }}
          </span>
          <template v-if="!svc.err.value && svc.snap.value">
            <span><i>项目</i>{{ svc.snap.value.projects }}</span>
            <span><i>版本</i>{{ svc.snap.value.releases }}</span>
            <span><i>数据</i>{{ fmtSize(svc.snap.value.dataDirBytes) }}</span>
          </template>
          <button class="mini side-card__refresh" type="button" title="立即刷新" @click="svc.refresh()">
            ↻
          </button>
        </div>
      </div>
    </Sidebar>

    <!-- 区3 中央：横幅 + 环境自检 / 工作区标签 -->
    <div class="ide__center">
      <div v-if="banner" class="banner">
        <span class="banner__text">
          📢 <b>{{ banner.project }}</b> / {{ banner.variant }} 已发布
          <code>{{ banner.release.id }}</code>
        </span>
        <button class="banner__btn" type="button" @click="onBannerView">查看</button>
        <button class="banner__close" type="button" title="关闭" @click="banner = null">✕</button>
      </div>

      <EnvCheck v-if="!report.ok" :report="report" @recheck="onRecheck" />

      <EditorTabs v-else v-model="activeTab" :tabs="workTabs">
        <template #pane-fw>
          <FirmwarePanel
            :ws="ws"
            :disabled="!canOperate"
            :percent="percent"
            :chip-name="chip?.name ?? null"
            :chip-detail="chip"
            :pick-files="pickFiles"
            @flash="flash"
            @erase="onErase"
            @hard-reset="hardReset"
          />
        </template>
        <template #pane-tl>
          <VersionTimeline
            v-if="selectedOption"
            :option="selectedOption"
            :registry="ws.state.rawRegistry"
            :chip-name="chip?.name ?? null"
            @load="(rel) => loadAndShow(selectedOption, rel)"
            @changed="ws.refreshRegistry()"
          />
          <div v-else class="tl-empty">
            在侧栏「项目库」选择一个项目，即可在此晋升 / 回滚 / 设置保留数。
          </div>
        </template>
      </EditorTabs>
    </div>

    <!-- 区4 底部面板（b-ide：问题 / 输出 / 日志监视器 + 头部控制行） -->
    <BottomPanel
      v-model="activeBottom"
      :tabs="bottomTabs"
      :collapsed="bottomCollapsed"
      @toggle-collapsed="bottomCollapsed = !bottomCollapsed"
    >
      <template #actions>
        <label class="bp-ctl bp-ctl--select">
          级别：
          <select v-model="bpFilter" title="日志级别过滤">
            <option value="all">全部</option>
            <option value="warn">警告+</option>
            <option value="error">错误</option>
            <option value="device">设备</option>
          </select>
        </label>
        <button
          class="bp-ctl"
          :class="{ 'bp-ctl--on': viewPaused }"
          type="button"
          :title="viewPaused ? '恢复滚动显示' : '暂停滚动显示（日志仍在收集）'"
          @click="toggleViewPause"
        >
          {{ viewPaused ? '▶ 恢复视图' : '⏸ 暂停视图' }}
        </button>
        <button
          class="bp-ctl"
          type="button"
          :disabled="!canOperate"
          :title="streamOn ? '停止读取串口并释放端口——之后可运行本机 idf.py monitor' : '重新打开串口实时读取'"
          @click="streamOn ? pauseMonitor() : resumeMonitor()"
        >
          {{ streamOn ? '⏹ 停止监视' : '▶ 开始监视' }}
        </button>
        <button class="bp-ctl" type="button" title="在新窗口打开日志（适合副屏常驻）" @click="openLogWindow">
          ⧉ 独立窗口
        </button>
        <button class="bp-ctl" type="button" title="导出 .txt" @click="downloadLogs">导出</button>
        <button class="bp-ctl" type="button" title="清空日志" @click="clearLogs">清空</button>
      </template>

      <!-- 问题：warn/error 级日志（真实过滤） -->
      <template #issues>
        <div class="bp-list">
          <p v-if="issueLogs.length === 0" class="bp-empty">（暂无警告 / 错误）</p>
          <p v-for="e in issueLogs" :key="e.seq" class="bp-row" :class="'bp-row--' + e.level">
            <span class="bp-ts">{{ new Date(e.ts).toLocaleTimeString() }}</span>
            <span class="bp-lvl">{{ e.level === 'error' ? '✖' : '⚠' }}</span>
            {{ e.text }}
          </p>
        </div>
      </template>

      <!-- 输出：设备串口输出（device 级） -->
      <template #output>
        <div class="bp-list">
          <p v-if="deviceLogs.length === 0" class="bp-empty">（暂无设备串口输出——连接设备后自动采集）</p>
          <p v-for="e in deviceLogs" :key="e.seq" class="bp-row bp-row--device">
            <span class="bp-ts">{{ new Date(e.ts).toLocaleTimeString() }}</span>
            {{ e.text }}
          </p>
        </div>
      </template>

      <template #log>
        <LogPanel
          :logs="logs"
          :export-text="exportLogs"
          :view-paused="viewPaused"
          :stream-on="streamOn"
          :monitor-disabled="!canOperate"
          :filter="bpFilter"
          :embedded="true"
          @clear="clearLogs"
          @toggle-pause="toggleViewPause"
          @pause-monitor="pauseMonitor"
          @resume-monitor="resumeMonitor"
          @update:filter="(f) => (bpFilter = f)"
        />
      </template>
    </BottomPanel>

    <!-- 区5 状态栏（accent 色条，b-ide 字段齐套） -->
    <StatusBar
      :state="state"
      :chip-name="chip?.name ?? null"
      :mac="chip?.mac ?? null"
      :stream-status="streamStatus"
      :has-token="hasToken"
      :subscribed="subscribedCount"
      :service-label="serviceLabel"
      :flash-params="activeParams"
      @configure-token="configureToken"
    />

    <!-- 共享隐藏文件选择器（侧栏「添加 bin」与固件页共用） -->
    <input ref="addInput" class="hidden-input" type="file" accept=".bin" multiple @change="onAddFiles" />
  </div>
</template>

<style scoped>
/* ══════════ IDE 主骨架 ══════════ */
.ide {
  display: grid;
  grid-template-columns: 48px 250px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto 26px;
  height: 100vh;
  overflow: hidden;
  background: var(--bg);
}
/* 活动栏 + 侧栏跨前两行 */
.ide > :first-child,
.ide > .sb {
  grid-row: 1 / 3;
}
.ide__center {
  grid-column: 3;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  padding: 12px 14px 0;
  gap: 12px;
  overflow: hidden;
}
.hidden-input {
  display: none;
}

/* SSE 横幅（中央区顶部） */
.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  background: var(--panel);
  border: 1px solid var(--accent);
  border-radius: 6px;
  font-size: 13px;
  flex: none;
}
.banner__text {
  flex: 1;
  min-width: 0;
}
.banner code {
  font-family: ui-monospace, monospace;
  background: var(--bg);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
}
.banner__btn {
  background: var(--accent);
  border: none;
  border-radius: 5px;
  padding: 5px 14px;
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

/* ── 侧栏：错误条 / 提示 / 树消息 / side-card ── */
.dev-err {
  position: relative;
  margin: 6px 8px;
  padding: 8px 9px;
  border: 1px solid var(--err);
  border-radius: 5px;
}
.dev-err__x {
  position: absolute;
  top: 4px;
  right: 6px;
  background: none;
  border: none;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}
.dev-err__msg {
  margin: 0 0 4px;
  color: var(--err);
  font-size: 12.5px;
}
.dev-err__hint {
  margin: 0 0 3px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.55;
}
.dev-err__cls {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  opacity: 0.7;
}
.dev-hint {
  margin: 4px 10px 2px;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.55;
}
.tree-msg {
  margin: 4px 8px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.55;
}
.mini {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
  padding: 1px 7px;
  font-family: inherit;
}
.mini:hover:not(:disabled) {
  color: var(--ink);
  border-color: var(--muted);
}
.mini:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
/* b-ide 侧栏底部卡：历史 + 服务 合一 */
.side-card {
  margin: 10px 8px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 12.5px;
}
.side-card__svc {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
  color: var(--ink);
}
.side-card__svc i {
  font-style: normal;
  color: var(--muted);
  margin-right: 5px;
  font-size: 11.5px;
}
.side-card__svc-live {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.side-card__svc-live::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
}
.side-card__svc-live--bad {
  color: var(--err);
}
.side-card__svc-live--bad::before {
  background: var(--err);
}
.side-card__refresh {
  margin-left: auto;
}
/* 底部面板头部控制行（b-ide 右侧组） */
.bp-ctl {
  background: none;
  border: none;
  color: var(--muted);
  font-size: 11.5px;
  font-family: inherit;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
  white-space: nowrap;
}
.bp-ctl:hover:not(:disabled) {
  color: var(--ink);
  background: var(--border);
}
.bp-ctl:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.bp-ctl--on {
  color: var(--accent);
}
.bp-ctl--select {
  cursor: default;
  display: flex;
  align-items: center;
  gap: 4px;
}
.bp-ctl--select select {
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11.5px;
  font-family: inherit;
  padding: 2px 4px;
}
/* 问题 / 输出 列表（终端行样式） */
.bp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 1.75;
  padding: 4px 6px;
}
.bp-empty {
  margin: 6px;
  color: var(--muted);
}
.bp-row {
  margin: 0;
  padding: 0 6px;
  white-space: pre-wrap;
  word-break: break-all;
  border-radius: 3px;
}
.bp-row:hover {
  background: color-mix(in srgb, var(--panel) 80%, transparent);
}
.bp-ts {
  color: var(--muted);
  margin-right: 8px;
}
.bp-lvl {
  margin-right: 6px;
}
.bp-row--warn {
  color: var(--warn);
}
.bp-row--error {
  color: var(--err);
}
.bp-row--device {
  color: var(--info);
}
.tl-empty {
  color: var(--muted);
  font-size: 13.5px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 28px 20px;
  text-align: center;
  line-height: 1.7;
}

/* ══════════ 独立日志窗口 ══════════ */
.logwin {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
.logwin__hd {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.logwin__brand {
  font-weight: 700;
  font-size: 14px;
}
.logwin__hint {
  color: var(--muted);
  font-size: 12px;
}
.logwin__close {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  color: var(--ink);
}
.logwin__main {
  flex: 1;
  min-height: 0;
  padding: 12px 16px 16px;
  display: flex;
  flex-direction: column;
  /* 日志盒铺满副窗：LogPanel 的 logbox 读取此变量 */
  --log-height: calc(100vh - 165px);
}
.logwin__main :deep(.panel) {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.logwin__main :deep(.logbox) {
  flex: 1;
  height: auto;
  min-height: 0;
}

/* ══════════ 响应式（窄屏回退：侧栏移上、活动栏隐藏） ══════════ */
@media (max-width: 960px) {
  .ide {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto minmax(0, 1fr) auto 26px;
    height: auto;
    min-height: 100vh;
    overflow: visible;
  }
  .ide > :first-child {
    display: none;
  }
  .ide > .sb {
    grid-row: 2;
    grid-column: 1;
    max-height: 46vh;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .ide__center {
    grid-column: 1;
    grid-row: 3;
    overflow: visible;
  }
  .ide .bp {
    grid-column: 1;
    grid-row: 4;
    height: 240px;
  }
  .ide .st {
    grid-column: 1;
    grid-row: 5;
    /* 窄屏不做 sticky：否则会压住底部面板的过滤按钮 */
    position: static;
  }
}
</style>
