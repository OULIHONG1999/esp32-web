<script setup lang="ts">
/**
 * 侧栏容器（IDE 左侧 240–260px 资源管理器）。
 * 扩展方式：在 App 的 <Sidebar> 里继续堆 <SidebarSection> 即可；
 * 本组件只提供外壳（标题栏 + 可滚动体），不关心内容。
 */
</script>

<template>
  <aside class="sb">
    <div class="sb__hd">
      <slot name="title">资源管理器</slot>
    </div>
    <div class="sb__body">
      <slot />
    </div>
  </aside>
</template>

<style scoped>
.sb {
  background: var(--panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.sb__hd {
  padding: 9px 14px 7px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 600;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.sb__body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: 14px;
}
</style>
