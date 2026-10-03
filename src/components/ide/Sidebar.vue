<script setup lang="ts">
/**
 * 侧栏容器（IDE 左侧资源管理器，宽度可拖拽：右缘 6px 拖拽条 → --sb-w + fw.sbW 持久）。
 * 扩展方式：在 App 的 <Sidebar> 里继续堆树节组件；本组件只提供外壳。
 */
function startResize(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  document.body.style.userSelect = 'none'
  const onMove = (ev: PointerEvent): void => {
    // 左侧固定 48px 活动栏；范围 190–480px
    const w = Math.round(Math.min(480, Math.max(190, ev.clientX - 48)))
    document.documentElement.style.setProperty('--sb-w', `${w}px`)
  }
  const onUp = (ev: PointerEvent): void => {
    el.releasePointerCapture(ev.pointerId)
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onUp)
    document.body.style.userSelect = ''
    try {
      const cur = getComputedStyle(document.documentElement).getPropertyValue('--sb-w').trim()
      if (cur) globalThis.localStorage?.setItem('fw.sbW', cur)
    } catch {
      /* 私隐模式忽略 */
    }
  }
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
}
</script>

<template>
  <aside class="sb">
    <div class="sb__rz" title="拖拽调整侧栏宽度" @pointerdown="startResize" />
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
  position: relative;
}
/* N3：右缘拖拽条 */
.sb__rz {
  position: absolute;
  top: 0;
  right: -3px;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 6;
  background: transparent;
}
.sb__rz:hover,
.sb__rz:active {
  background: color-mix(in srgb, var(--accent) 55%, transparent);
}
@media (max-width: 960px) {
  .sb__rz {
    display: none;
  }
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
