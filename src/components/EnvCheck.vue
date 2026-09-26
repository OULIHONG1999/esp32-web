<script setup lang="ts">
import type { EnvReport } from '../env/environment'

defineProps<{ report: EnvReport }>()
defineEmits<{ recheck: [] }>()
</script>

<template>
  <section class="env" :class="report.ok ? 'env--ok' : 'env--bad'">
    <h2 class="env__title">环境自检</h2>
    <ul class="env__list">
      <li :class="report.secureContext ? 'pass' : 'fail'">
        安全上下文（HTTPS / localhost）
        <span class="state">{{ report.secureContext ? '通过' : '失败' }}</span>
      </li>
      <li :class="report.serialApi ? 'pass' : 'fail'">
        Web Serial API 可用
        <span class="state">{{ report.serialApi ? '通过' : '不可用' }}</span>
      </li>
    </ul>
    <div v-if="!report.ok" class="env__problems">
      <div v-for="p in report.problems" :key="p.id" class="env__problem">
        <p class="env__problem-msg">{{ p.message }}</p>
        <p class="env__problem-hint">修复：{{ p.hint }}</p>
      </div>
    </div>
    <p v-else class="env__allgood">环境就绪，可以进入下一步（连接向导尚未实现，见 PROGRESS.md）。</p>
    <button class="env__btn" type="button" @click="$emit('recheck')">重新检测</button>
  </section>
</template>

<style scoped>
.env {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  max-width: 640px;
}
.env--ok {
  border-left: 3px solid var(--accent);
}
.env--bad {
  border-left: 3px solid var(--err);
}
.env__title {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
}
.env__list {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
}
.env__list li {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
  font-size: 14px;
}
.env .pass .state {
  color: var(--accent);
}
.env .fail .state {
  color: var(--err);
}
.env__problem {
  margin: 8px 0;
  font-size: 13px;
}
.env__problem-msg {
  margin: 0 0 4px;
  color: var(--err);
}
.env__problem-hint {
  margin: 0;
  color: var(--muted);
  line-height: 1.6;
}
.env__allgood {
  color: var(--accent);
  font-size: 13px;
}
.env__btn {
  margin-top: 12px;
  background: transparent;
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
}
.env__btn:hover {
  border-color: var(--accent);
}
</style>
