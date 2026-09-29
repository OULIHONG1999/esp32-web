<script setup lang="ts">
import type { FlashHistoryItem } from '../composables/useSession'

defineProps<{
  history: readonly FlashHistoryItem[]
}>()
defineEmits<{ clear: [] }>()

function fmt(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}
</script>

<template>
  <details class="hist">
    <summary class="hist__summary">
      📜 烧录历史（{{ history.length }}）
      <button
        v-if="history.length"
        class="hist__clear"
        type="button"
        title="清空历史（仅本机浏览器记录）"
        @click.prevent.stop="$emit('clear')"
      >
        清空
      </button>
    </summary>
    <p v-if="history.length === 0" class="hist__empty">尚无记录——每次烧录（成功或失败）都会记在这里。</p>
    <ul v-else class="hist__list">
      <li v-for="(h, i) in history" :key="h.ts + '-' + i" class="hist__item">
        <span class="hist__flag" :class="h.ok ? 'hist__flag--ok' : 'hist__flag--err'">
          {{ h.ok ? '✓' : '✗' }}
        </span>
        <span class="hist__time">{{ fmt(h.ts) }}</span>
        <span class="hist__chip">{{ h.chip }}</span>
        <span class="hist__meta">{{ h.parts }} 段 · {{ fmtSize(h.bytes) }}</span>
        <span v-if="!h.ok && h.error" class="hist__err" :title="h.error">{{ h.error }}</span>
      </li>
    </ul>
  </details>
</template>

<style scoped>
.hist {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
}
.hist__summary {
  cursor: pointer;
  color: var(--muted);
  user-select: none;
  display: flex;
  align-items: center;
  gap: 10px;
}
.hist__clear {
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--muted);
  font-size: 11px;
  padding: 1px 8px;
  cursor: pointer;
}
.hist__empty {
  margin: 8px 0 2px;
  color: var(--muted);
  font-size: 12px;
}
.hist__list {
  list-style: none;
  margin: 8px 0 2px;
  padding: 0;
  max-height: 180px;
  overflow-y: auto;
}
.hist__item {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 4px 0;
  border-top: 1px dashed var(--border);
  flex-wrap: wrap;
}
.hist__flag {
  font-weight: 700;
}
.hist__flag--ok {
  color: var(--accent);
}
.hist__flag--err {
  color: var(--err);
}
.hist__time,
.hist__meta {
  color: var(--muted);
  font-size: 12px;
}
.hist__chip {
  color: var(--ink);
}
.hist__err {
  color: var(--err);
  font-size: 12px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
