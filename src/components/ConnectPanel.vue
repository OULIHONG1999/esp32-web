<script setup lang="ts">
import type { DeviceState, ChipInfo } from '../core/device'
import type { ClassifiedError } from '../core/errors'

defineProps<{
  state: DeviceState
  chip: ChipInfo | null
  lastError: ClassifiedError | null
  busy: boolean
}>()
defineEmits<{ connect: []; disconnect: []; switchPort: []; dismissError: [] }>()

const LABEL: Record<DeviceState, string> = {
  disconnected: '未连接',
  requesting: '选择端口…',
  detecting: '识别芯片…',
  ready: '已连接 · 日志监视中',
  working: '操作进行中…',
  error: '连接错误',
}
</script>

<template>
  <section class="panel">
    <h2 class="panel__title">① 设备</h2>
    <p class="panel__state">
      状态：<code>{{ state }}</code>
      <span class="statelabel">{{ LABEL[state] }}</span>
      <span v-if="chip" class="chip">{{ chip.name }}</span>
    </p>

    <!-- F-12 芯片详情卡（MAC/Revision/Flash 容量，检测阶段读取） -->
    <div v-if="chip && (chip.mac || chip.revision || chip.flashSize)" class="chipcard">
      <span v-if="chip.mac" class="chipcard__item"><i>MAC</i>{{ chip.mac }}</span>
      <span v-if="chip.revision" class="chipcard__item"><i>Rev</i>{{ chip.revision }}</span>
      <span v-if="chip.flashSize" class="chipcard__item"><i>Flash</i>{{ chip.flashSize }}</span>
    </div>

    <div class="panel__actions">
      <button
        class="btn btn--primary"
        type="button"
        :disabled="!['disconnected', 'error'].includes(state)"
        @click="$emit('connect')"
      >
        {{ state === 'detecting' || state === 'requesting' ? '连接中…' : '连接设备' }}
      </button>
      <button
        v-if="state === 'ready'"
        class="btn"
        type="button"
        :disabled="busy"
        title="换一个串口（重新弹出系统选择器）"
        @click="$emit('switchPort')"
      >
        切换端口
      </button>
      <button
        v-if="state !== 'disconnected'"
        class="btn"
        type="button"
        :disabled="state === 'working'"
        @click="$emit('disconnect')"
      >
        断开设备
      </button>
    </div>

    <!-- D3：ready 态烧录失败的错误条也可见，可手动关闭 -->
    <div
      v-if="lastError && (state === 'error' || state === 'ready')"
      class="panel__error"
    >
      <button
        class="panel__error-close"
        type="button"
        title="关闭错误提示"
        @click="$emit('dismissError')"
      >
        ✕
      </button>
      <p class="panel__error-msg">{{ lastError.message }}</p>
      <p class="panel__error-hint">{{ lastError.hint }}</p>
      <p class="panel__error-cls">分类：{{ lastError.cls }}</p>
    </div>
    <p v-if="state === 'ready'" class="panel__hint">
      设备常驻连接：烧录/擦除会自动挂起日志，结束后自动恢复；无需手动切换模式。
    </p>
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
.panel__state {
  margin: 0 0 12px;
  color: var(--muted);
  font-size: 13px;
}
.statelabel {
  margin-left: 10px;
  color: var(--ink);
}
.chip {
  margin-left: 12px;
  color: var(--accent);
  font-weight: 600;
}
.chipcard {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin: -6px 0 12px;
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
}
.chipcard__item i {
  font-style: normal;
  color: var(--muted);
  margin-right: 6px;
}
.chipcard__item {
  font-family: ui-monospace, monospace;
}
.panel__actions {
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
.btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
.panel__error {
  position: relative;
  margin-top: 12px;
  padding: 10px;
  border: 1px solid var(--err);
  border-radius: 6px;
}
.panel__error-close {
  position: absolute;
  top: 6px;
  right: 8px;
  background: none;
  border: none;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  padding: 2px 4px;
}
.panel__error-close:hover {
  color: var(--err);
}
.panel__error-msg {
  margin: 0 0 6px;
  color: var(--err);
  font-size: 14px;
}
.panel__error-hint {
  margin: 0 0 4px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}
.panel__error-cls {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  opacity: 0.7;
}
.panel__hint {
  margin: 12px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}
</style>
