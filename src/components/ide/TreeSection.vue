<script setup lang="ts">
/**
 * 树形分节（VS Code 资源管理器风格）。
 * 扩展方式：默认插槽放 TreeItem/分组；actions 插槽放节头右侧按钮（如 ★订阅/刷新）。
 */
const props = withDefaults(
  defineProps<{
    title: string
    open?: boolean
  }>(),
  { open: true },
)
</script>

<template>
  <details class="ts" :open="props.open">
    <summary class="ts__hd">
      <span class="ts__caret">▾</span>
      {{ title }}
      <span class="ts__actions" @click.stop>
        <slot name="actions" />
      </span>
    </summary>
    <div class="ts__body">
      <slot />
    </div>
  </details>
</template>

<style scoped>
.ts {
  border-bottom: 1px solid var(--border);
}
.ts__hd {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px 5px;
  font-size: 12px;
  font-weight: 700;
  color: var(--ink);
  cursor: pointer;
  user-select: none;
}
.ts__hd::-webkit-details-marker {
  display: none;
}
.ts__caret {
  font-size: 10px;
  color: var(--muted);
  transition: transform 0.12s;
}
.ts:not([open]) > .ts__hd .ts__caret {
  transform: rotate(-90deg);
}
.ts__actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.ts__body {
  padding: 1px 6px 8px;
}
</style>
