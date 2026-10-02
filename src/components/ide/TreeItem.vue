<script setup lang="ts">
/**
 * 树节点（VS Code 资源管理器行）。
 * 扩展方式：icon/label/sub 一行信息；tags=[{text,kind}] 渲染 ★rel/snap/NEW 徽标；
 * dot=状态灯；active=选中高亮；indent=缩进层级（0/1/2）。整行可点击时传 @click。
 */
export interface TreeTag {
  text: string
  /** rel=发布绿 / new=NEW红 / snap=灰 */
  kind?: 'rel' | 'new' | 'snap'
}

defineProps<{
  icon?: string
  label: string
  sub?: string
  tags?: TreeTag[]
  dot?: 'ok' | 'off' | 'warn' | 'err'
  active?: boolean
  indent?: number
  /** accent 高亮行（如「连接设备」主操作） */
  accent?: boolean
  disabled?: boolean
}>()
</script>

<template>
  <button
    class="ti"
    :class="{ 'ti--active': active, 'ti--accent': accent }"
    type="button"
    :disabled="disabled"
    :style="{ paddingLeft: 10 + (indent ?? 0) * 14 + 'px' }"
  >
    <span v-if="dot" class="ti__dot" :class="'ti__dot--' + dot" />
    <span v-else-if="icon" class="ti__ico">{{ icon }}</span>
    <span class="ti__label">{{ label }}</span>
    <span v-if="sub" class="ti__sub">{{ sub }}</span>
    <span v-for="(t, i) in tags ?? []" :key="i" class="ti__tag" :class="'ti__tag--' + (t.kind ?? 'snap')">
      {{ t.text }}
    </span>
    <span class="ti__tail"><slot name="tail" /></span>
  </button>
</template>

<style scoped>
.ti {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  border: none;
  background: none;
  color: var(--ink);
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  padding: 4.5px 10px;
  border-radius: 4px;
  cursor: pointer;
  min-width: 0;
}
.ti:hover {
  background: #2a2d2e;
}
:root[data-theme='light'] .ti:hover {
  background: #e8e8e8;
}
.ti--active {
  background: #37373d;
  color: #ffffff;
}
.ti--accent {
  color: var(--accent);
  font-weight: 600;
}
.ti:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
:root[data-theme='light'] .ti--active {
  background: #d6ebff;
  color: #1f2328;
}
.ti__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  margin: 0 3px;
}
.ti__dot--ok {
  background: var(--accent);
}
.ti__dot--off {
  background: var(--muted);
}
.ti__dot--warn {
  background: var(--warn);
}
.ti__dot--err {
  background: var(--err);
}
.ti__ico {
  flex: none;
  width: 14px;
  text-align: center;
  font-size: 11px;
  opacity: 0.8;
}
.ti__label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ti__sub {
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}
.ti__tag {
  font-size: 10px;
  font-family: ui-monospace, monospace;
  padding: 0 5px;
  border-radius: 3px;
  border: 1px solid var(--border);
  color: var(--muted);
  flex: none;
}
.ti__tag--rel {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
}
.ti__tag--new {
  color: var(--err);
  border-color: color-mix(in srgb, var(--err) 55%, transparent);
}
.ti__tail {
  margin-left: auto;
  display: flex;
  gap: 4px;
  flex: none;
}
</style>
