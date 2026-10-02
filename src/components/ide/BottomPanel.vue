<script setup lang="ts">
/**
 * 底部面板（IDE 下方 dock，终端/问题/输出等寄宿于此）。
 * 扩展方式：App 的 bottomTabs 数组加 {id,label}，模板放 <template #<id>> 内容；
 * actions 插槽用于放每个面板的右侧工具按钮；collapsed 可整体收起（活动栏图标联动）。
 */
export interface BottomTab {
  id: string
  label: string
}

defineProps<{
  tabs: BottomTab[]
  modelValue: string
  collapsed: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [id: string]
  'toggle-collapsed': []
}>()
</script>

<template>
  <section class="bp" :class="{ 'bp--collapsed': collapsed }">
    <div class="bp__bar">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="bp__tab"
        :class="{ 'bp__tab--on': t.id === modelValue && !collapsed }"
        type="button"
        @click="emit('update:modelValue', t.id); collapsed && emit('toggle-collapsed')"
      >
        {{ t.label }}
      </button>
      <div class="bp__actions">
        <slot name="actions" />
        <button
          class="bp__fold"
          type="button"
          :title="collapsed ? '展开底部面板' : '收起底部面板'"
          @click="emit('toggle-collapsed')"
        >
          {{ collapsed ? '▴' : '▾' }}
        </button>
      </div>
    </div>
    <div v-show="!collapsed" class="bp__body">
      <template v-for="t in tabs" :key="t.id">
        <div v-show="t.id === modelValue" class="bp__pane">
          <slot :name="t.id" />
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.bp {
  grid-column: 3;
  grid-row: 2;
  background: var(--panel);
  border-top: 1px solid var(--accent);
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 264px;
}
.bp--collapsed {
  height: auto;
}
.bp--collapsed .bp__body {
  display: none;
}
.bp__bar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 32px;
  padding: 0 8px;
  background: var(--chrome);
  border-bottom: 1px solid var(--border);
  flex: none;
}
.bp__tab {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
  background: none;
  border: none;
  cursor: pointer;
  padding: 7px 8px 6px;
  border-bottom: 1px solid transparent;
  font-family: inherit;
}
.bp__tab--on {
  color: var(--ink);
  border-bottom-color: var(--accent);
  font-weight: 600;
}
.bp__actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}
.bp__fold {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
}
.bp__fold:hover {
  background: var(--border);
  color: var(--ink);
}
.bp__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.bp__pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 10px 10px;
}
/* 寄宿面板（LogPanel 等）压平成内嵌内容 */
.bp__pane :deep(.panel) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: transparent;
  border: none;
  padding: 0;
}
.bp__pane :deep(.panel__title) {
  display: none;
}
.bp__pane :deep(.logbox) {
  flex: 1;
  height: auto;
  min-height: 0;
  border-radius: 4px;
}
</style>
