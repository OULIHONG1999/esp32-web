<script setup lang="ts">
import { ref } from 'vue'
import EnvCheck from './components/EnvCheck.vue'
import ConnectPanel from './components/ConnectPanel.vue'
import FirmwarePanel from './components/FirmwarePanel.vue'
import LogPanel from './components/LogPanel.vue'
import { checkEnvironment, type EnvReport } from './env/environment'
import { useSession } from './composables/useSession'
import { useIdfBuild } from './composables/useIdfBuild'

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
</script>

<template>
  <div class="shell">
    <header class="shell__header">
      <span class="shell__brand">ESP32 Web Flasher</span>
      <span class="shell__hint">v0.2.0 · 设备常驻连接</span>
    </header>

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
          @flash="flash"
          @params="setFlashParams"
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
