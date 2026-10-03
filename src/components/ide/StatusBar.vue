<script setup lang="ts">
/**
 * 底部状态栏（VS Code 同款：accent 色条通栏 + 白字）。
 * 扩展方式：字段 props 进、动作 emits 出；额外信息用 #extra / #right 插槽。
 */
import type { DeviceState } from '../../core/device'
import type { StreamStatus } from '../../api/registry'
import type { FlashParams } from '../../api/registry'

defineProps<{
  state: DeviceState
  chipName: string | null
  /** b-ide 状态栏 ⌀ MAC 行 */
  mac: string | null
  streamStatus: StreamStatus | 'off'
  hasToken: boolean
  /** 已订阅项目数（b-ide ★ 订阅 N） */
  subscribed: number
  /** 服务状态一行文案（b-ide ◉ 服务在线 2/12） */
  serviceLabel: string
  /** 最近注入的烧录参数（null=未注入） */
  flashParams: FlashParams | null
  version?: string
}>()
defineEmits<{ 'configure-token': [] }>()

const STATE_LABEL: Record<DeviceState, string> = {
  disconnected: '未连接',
  requesting: '选择端口…',
  detecting: '识别芯片…',
  ready: 'ready',
  working: '操作中…',
  error: '连接错误',
}
</script>

<template>
  <footer class="st">
    <span class="st__lamp" :class="'st__lamp--' + state" />
    <span class="st__state">{{ STATE_LABEL[state] }}</span>
    <span v-if="chipName" class="st__item">▣ {{ chipName }}</span>
    <span v-if="mac" class="st__item st__mono">⌀ {{ mac }}</span>
    <span class="st__item st__item--brand">ESP32 Web Flasher</span>
    <slot name="extra" />
    <div class="st__right">
      <span v-if="flashParams" class="st__item st__mono">
        {{ flashParams.flashMode }} · {{ flashParams.flashFreq }} · {{ flashParams.flashSize }}
      </span>
      <span class="st__item">★ 订阅 {{ subscribed }}</span>
      <span class="st__item">{{ serviceLabel }}</span>
      <span
        class="st__item"
        :title="
          streamStatus === 'connected'
            ? 'SSE 订阅中：远端发布即时感知'
            : streamStatus === 'polling'
              ? 'SSE 断开，30s 轮询降级中'
              : '订阅未启动'
        "
      >
        {{ streamStatus === 'connected' ? '● 订阅中' : streamStatus === 'polling' ? '○ 轮询' : '○ 未订阅' }}
      </span>
      <button
        class="st__btn"
        :class="hasToken ? 'st__btn--on' : 'st__btn--warn'"
        type="button"
        :title="hasToken ? '发布 token 已配置（点击可更换）' : '设置发布 token——晋升/回滚等操作需要'"
        @click="$emit('configure-token')"
      >
        🔑 {{ hasToken ? '已设' : '设置' }}
      </button>
      <span class="st__item st__ver">{{ version ?? 'v0.2.0' }}</span>
    </div>
  </footer>
</template>

<style scoped>
.st {
  grid-column: 1 / 4;
  grid-row: 3;
  /* VS Code 同款：accent 色条通栏 */
  background: var(--status);
  color: #ffffff;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 10px;
  font-size: 12px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.st__lamp {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.55);
  flex: none;
}
.st__lamp--ready {
  background: #b7f7c8;
  box-shadow: 0 0 4px rgba(255, 255, 255, 0.8);
}
.st__lamp--working,
.st__lamp--detecting,
.st__lamp--requesting {
  background: #ffe08a;
}
.st__lamp--error {
  background: #ffd0cd;
}
.st__state {
  font-weight: 700;
}
.st__item {
  color: rgba(255, 255, 255, 0.88);
}
.st__item--brand {
  font-weight: 600;
  padding-left: 4px;
  border-left: 1px solid rgba(255, 255, 255, 0.35);
  margin-left: 2px;
  opacity: 0.92;
}
.st__mono {
  font-family: ui-monospace, monospace;
  font-size: 11px;
}
.st__right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.st__btn {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.88);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 3px 6px;
  border-radius: 4px;
}
.st__btn:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}
.st__btn--on {
  color: #ffffff;
  font-weight: 600;
}
.st__btn--warn {
  color: #ffe08a;
}
.st__ver {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  opacity: 0.85;
}
@media (max-width: 960px) {
  .st__item--brand,
  .st__ver {
    display: none;
  }
}
</style>
