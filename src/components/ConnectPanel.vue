<script setup lang="ts">
import type { ChipInfo, SessionState } from '../core/session'
import type { ClassifiedError } from '../core/errors'

defineProps<{
  state: SessionState
  chip: ChipInfo | null
  lastError: ClassifiedError | null
  busy: boolean
}>()
defineEmits<{ connect: []; release: [] }>()
</script>

<template>
  <section class="panel">
    <h2 class="panel__title">① 连接设备</h2>
    <p class="panel__state">
      状态：<code>{{ state }}</code>
      <span v-if="chip" class="chip">芯片：{{ chip.name }}</span>
    </p>

    <div class="panel__actions">
      <button
        class="btn btn--primary"
        type="button"
        :disabled="state !== 'idle' || busy"
        @click="$emit('connect')"
      >
        {{ busy && (state === 'requesting' || state === 'detecting') ? '连接中…' : '连接（选择串口）' }}
      </button>
      <button
        v-if="['ready', 'done', 'error'].includes(state)"
        class="btn"
        type="button"
        :disabled="busy"
        @click="$emit('release')"
      >
        断开
      </button>
    </div>

    <div v-if="lastError && state === 'error'" class="panel__error">
      <p class="panel__error-msg">{{ lastError.message }}</p>
      <p class="panel__error-hint">{{ lastError.hint }}</p>
      <p class="panel__error-cls">分类：{{ lastError.cls }}</p>
    </div>
    <p v-if="state === 'done'" class="panel__done">✅ 烧录完成，设备已复位。可再次烧录或断开。</p>
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
.chip {
  margin-left: 12px;
  color: var(--accent);
  font-weight: 600;
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
  color: #04150f;
  font-weight: 600;
}
.panel__error {
  margin-top: 12px;
  padding: 10px;
  border: 1px solid var(--err);
  border-radius: 6px;
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
.panel__done {
  margin: 12px 0 0;
  color: var(--accent);
  font-size: 14px;
}
</style>
