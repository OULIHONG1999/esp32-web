<script setup lang="ts">
/**
 * 工作区标签页（IDE 编辑区顶栏）。
 * 扩展方式：App 的 workTabs 数组加 {id,label,icon?}，再在模板里放一个
 * <template #pane-<id>> 内容即完成接入；切换用 v-show 保留各面板组件状态。
 */
export interface WorkTab {
  id: string
  label: string
  icon?: string
}

defineProps<{
  tabs: WorkTab[]
  modelValue: string
}>()
const emit = defineEmits<{ 'update:modelValue': [id: string] }>()
</script>

<template>
  <div class="et">
    <div class="et__bar" role="tablist">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="et__tab"
        :class="{ 'et__tab--on': t.id === modelValue }"
        type="button"
        role="tab"
        :aria-selected="t.id === modelValue"
        @click="emit('update:modelValue', t.id)"
      >
        <span v-if="t.icon" class="et__ico">{{ t.icon }}</span>
        {{ t.label }}
      </button>
      <div class="et__flex" />
    </div>
    <div class="et__body">
      <template v-for="t in tabs" :key="t.id">
        <div v-show="t.id === modelValue" class="et__pane" role="tabpanel">
          <slot :name="'pane-' + t.id" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.et {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.et__bar {
  display: flex;
  align-items: stretch;
  background: var(--chrome);
  border-bottom: 1px solid var(--border);
  min-height: 35px;
  flex: none;
  overflow-x: auto;
}
.et__tab {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 14px;
  font-size: 12.5px;
  font-family: inherit;
  color: var(--muted);
  background: transparent;
  border: none;
  border-right: 1px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
  position: relative;
}
.et__tab:hover {
  color: var(--ink);
}
.et__tab--on {
  background: var(--bg);
  color: var(--ink);
}
/* 激活标签顶部 accent 线（VS Code 风） */
.et__tab--on::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--accent);
}
.et__ico {
  font-size: 12px;
  opacity: 0.85;
}
.et__flex {
  flex: 1;
  border-bottom: 0;
}
.et__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg);
}
.et__pane {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 100%;
}
</style>
