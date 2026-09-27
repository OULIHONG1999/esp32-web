<script setup lang="ts">
import { ref } from 'vue'
import EnvCheck from './components/EnvCheck.vue'
import ConnectPanel from './components/ConnectPanel.vue'
import FirmwarePanel from './components/FirmwarePanel.vue'
import LogPanel from './components/LogPanel.vue'
import { checkEnvironment, type EnvReport } from './env/environment'
import { useSession } from './composables/useSession'

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
  exportLogs,
  clearLogs,
  setFlashParams,
  toggleViewPause,
} = useSession()

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
          v-if="connected"
          :disabled="!canOperate"
          :percent="percent"
          :chip-name="chip?.name ?? null"
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
