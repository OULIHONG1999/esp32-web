<script setup lang="ts">
/**
 * 活动栏（IDE 最左 48px 图标条，图标+中文小标签，VS Code 同款 #333）。
 * 扩展方式：items=顶部图标组；endItems=底部图标组（⚙ 等）；
 * 点击只派发 id，具体行为由 App 决定；选中态由 modelValue 控制。
 */
export interface ActivityItem {
  id: string
  icon: string
  title: string
  /** 图标下的中文小标签（2 字为宜，解决"看不懂图标"） */
  label?: string
  /** NEW 红点徽标（如：版本时间线有新发布） */
  badge?: boolean
}

defineProps<{
  items: ActivityItem[]
  endItems?: ActivityItem[]
  modelValue: string
}>()
const emit = defineEmits<{ 'update:modelValue': [id: string]; select: [id: string] }>()

function pick(id: string): void {
  emit('update:modelValue', id)
  emit('select', id)
}
</script>

<template>
  <nav class="ab" aria-label="活动栏">
    <button
      v-for="it in items"
      :key="it.id"
      class="ab__btn"
      :class="{ 'ab__btn--on': it.id === modelValue }"
      type="button"
      :title="it.title"
      @click="pick(it.id)"
    >
      <span class="ab__ico">{{ it.icon }}</span>
      <span v-if="it.label" class="ab__label">{{ it.label }}</span>
      <span v-if="it.badge" class="ab__badge" />
    </button>
    <div class="ab__spacer" />
    <button
      v-for="it in endItems ?? []"
      :key="it.id"
      class="ab__btn ab__btn--end"
      type="button"
      :title="it.title"
      @click="pick(it.id)"
    >
      <span class="ab__ico">{{ it.icon }}</span>
      <span v-if="it.label" class="ab__label">{{ it.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.ab {
  background: var(--activity);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 6px;
  gap: 4px;
}
.ab__btn {
  width: 48px;
  min-height: 46px;
  border: none;
  background: none;
  color: #8a8a8a;
  cursor: pointer;
  position: relative;
  opacity: 0.75;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 4px 0;
  font-family: inherit;
}
.ab__ico {
  font-size: 17px;
  line-height: 1;
}
.ab__label {
  font-size: 9.5px;
  line-height: 1;
  letter-spacing: 0.02em;
}
.ab__btn:hover {
  opacity: 1;
  color: var(--ink);
}
.ab__btn--on {
  opacity: 1;
  color: #ffffff;
}
:root[data-theme='light'] .ab__btn {
  color: #616161;
}
:root[data-theme='light'] .ab__btn--on {
  color: #1f2328;
}
/* VS Code 式左侧选中指示条 */
.ab__btn--on::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
}
.ab__badge {
  position: absolute;
  top: 5px;
  right: 7px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--err);
  border: 1.5px solid var(--activity);
}
.ab__spacer {
  flex: 1;
}
.ab__btn--end {
  margin-bottom: 6px;
}
</style>
