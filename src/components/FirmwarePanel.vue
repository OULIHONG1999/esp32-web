<script setup lang="ts">
/**
 * 固件标签页（b-ide 编辑区复刻：面包屑 + 参数条 + 操作行 + 烧录表格）。
 * 数据与项目库选择在 useFirmwareWorkspace（侧栏树 / 时间线共享）；
 * 本组件只负责展示与烧录确认。扩展：操作行按钮走 emits（flash/erase/hardReset）。
 * 版面纪律（2026-10-06 用户要求「控件瘦身」）：纵向只保留 参数条 / 操作行 / 表格 / 进度或回执，
 * 次要操作进 ⋯ 菜单，参数不再用卡片块。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ChipInfo, FlashPart } from '../core/device'
import type { FirmwareWorkspace } from '../composables/useFirmwareWorkspace'
import type { FlashResult } from '../composables/useSession'
import { zipStore } from '../core/zip'
import { buildFlashArgsText, buildReadmeText, type PackPart } from '../core/firmwarePack'
import { extractStrings, parseBin, sha256Hex, type BinInfo } from '../core/binInfo'

const props = defineProps<{
  ws: FirmwareWorkspace
  disabled: boolean
  percent: number | null
  chipName: string | null
  /** F-12：芯片详情（烧录前二次确认用） */
  chipDetail: ChipInfo | null
  /** 烧录逐段状态（行背景进度） */
  flashPart: { index: number; written: number; total: number } | null
  /** 失败段索引（标红即停） */
  flashFailedIndex: number | null
  /** 最近一次烧录回执（✅/❌ 结论行） */
  flashResult: FlashResult | null
  /** 打开共享的隐藏文件选择器（App 持有 input） */
  pickFiles: () => void
}>()
const emit = defineEmits<{
  flash: [parts: FlashPart[]]
  erase: []
  hardReset: []
}>()

const rows = props.ws.state.rows

/**
 * ⋯ 更多操作（原生 <details>）：次要按钮收进菜单，把可见控件压到一行——
 * 2026-10-06 用户反馈「烧录清单控件有点大、占地方」。
 */
const menuEl = ref<HTMLDetailsElement | null>(null)
function closeMenu(): void {
  if (menuEl.value) menuEl.value.open = false
}
function onDocClick(e: MouseEvent): void {
  const el = menuEl.value
  if (el?.open && !el.contains(e.target as Node)) el.open = false
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

const crumbs = computed<string>(() => {
  const s = props.ws.state
  if (s.from === 'registry' && s.loadedProject) {
    return `项目库 ▸ ${s.loadedProject} ▸ ${s.loadedRelease ?? ''}`
  }
  if (s.from === 'manual') return '手动选文件（地址按文件名猜测，可手改）'
  return '尚未载入 —— 从侧栏「项目库」选择版本，或点「添加 bin…」'
})

const totalBytes = computed<number>(() =>
  rows.reduce((n, r) => n + (r.file?.size ?? 0), 0),
)

/** 烧录逐段状态 → 行样式/标记（失败标红即停；进度背景条） */
function rowClass(i: number): string {
  if (props.flashFailedIndex === i) return 'fw__row--failed'
  if (props.flashPart && props.flashPart.index === i) return 'fw__row--writing'
  if (props.flashPart && i < props.flashPart.index) return 'fw__row--done'
  return ''
}
function rowMark(i: number): string {
  if (props.flashFailedIndex === i) return '✖'
  if (props.flashPart && props.flashPart.index === i) return '▶'
  if (props.flashPart && i < props.flashPart.index) return '✓'
  return ''
}
function rowStyle(i: number): string {
  const fp = props.flashPart
  if (!fp || fp.index !== i || !fp.total) return ''
  const pct = Math.min(100, Math.round((fp.written / fp.total) * 100))
  return `background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 20%, transparent) ${pct}%, transparent ${pct}%);`
}

/** ISO 时间 → 可读时间戳（含秒） */
function fmtStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pz = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pz(d.getMonth() + 1)}-${pz(d.getDate())} ${pz(d.getHours())}:${pz(d.getMinutes())}:${pz(d.getSeconds())}`
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

const chipFamilyCell = computed(() => {
  if (!props.chipName) return { text: '未连接', ok: false }
  return { text: props.chipName, ok: true }
})

/** ⋯ 菜单项：先收起菜单再执行（<details> 原生开合，不用自绘下拉状态） */
function eraseNow(): void {
  closeMenu()
  emit('erase')
}
function resetNow(): void {
  closeMenu()
  emit('hardReset')
}
function reloadNow(): void {
  closeMenu()
  void props.ws.reloadSelected()
}
function packNow(): void {
  closeMenu()
  void exportPack()
}

async function doFlash(): Promise<void> {
  const parts: FlashPart[] = []
  for (const r of rows) {
    if (!r.file) continue
    const data = new Uint8Array(await r.file.arrayBuffer())
    parts.push({ label: r.label, address: r.address, data })
  }
  if (parts.length === 0) return
  // F-12：烧录前二次确认（芯片 + 段摘要 + 地址清单）
  const total = parts.reduce((n, p) => n + p.data.byteLength, 0)
  const chipLine = props.chipDetail
    ? `${props.chipDetail.name}${props.chipDetail.mac ? ' @ ' + props.chipDetail.mac : ''}${
        props.chipDetail.flashSize ? ' · Flash ' + props.chipDetail.flashSize : ''
      }`
    : props.chipName ?? '未识别'
  const addrList = parts
    .map((p) => `  0x${p.address.toString(16).toUpperCase()}  ${p.label}（${p.data.byteLength} B）`)
    .join('\n')
  const ok = window.confirm(
    `确认烧录到设备？\n\n芯片：${chipLine}\n段数：${parts.length}，共 ${total} 字节\n\n地址清单：\n${addrList}\n\n写错固件可能无法启动，确定继续？`,
  )
  if (!ok) return
  emit('flash', parts)
}

function onAddressChange(r: { address: number }, e: Event): void {
  const input = e.target as HTMLInputElement
  const v = props.ws.parseAddress(input.value)
  if (v !== null) r.address = v
  else input.value = props.ws.hex(r.address)
}

// ---- A2 固件详情（bin 解析：镜像头/分区表/字符串/校验和） ----
const inspect = ref<{
  name: string
  label: string
  info: BinInfo
  sha: string
  strings: string[]
} | null>(null)

async function inspectRow(r: { label: string; file: File | null }): Promise<void> {
  if (!r.file) return
  const bytes = new Uint8Array(await r.file.arrayBuffer())
  const info = parseBin(bytes)
  const sha = await sha256Hex(bytes)
  const strings = extractStrings(bytes, 8).slice(0, 24)
  inspect.value = { name: r.file.name, label: r.label, info, sha, strings }
}

/** N7：把当前清单全部段 + flash_args + README 打成 zip 下载 */
async function exportPack(): Promise<void> {
  const entries: { name: string; data: Uint8Array }[] = []
  const packParts: PackPart[] = []
  const used = new Set<string>()
  for (const r of rows) {
    if (!r.file) continue
    let name = r.file.name
    if (used.has(name)) name = `${r.label}-${r.id}-${name}`
    used.add(name)
    const data = new Uint8Array(await r.file.arrayBuffer())
    entries.push({ name, data })
    packParts.push({ address: r.address, fileName: name, label: r.label, size: data.byteLength })
  }
  if (packParts.length === 0) return

  const s = props.ws.state
  const source =
    s.from === 'registry' && s.loadedProject
      ? `${s.loadedProject} ${s.loadedRelease ?? ''}`.trim()
      : '手动选文件'
  const meta = { source, chipName: props.chipName, exportedAt: new Date().toISOString() }
  const text = new TextEncoder()
  entries.push({ name: 'flash_args', data: text.encode(buildFlashArgsText(packParts, s.flashParams)) })
  entries.push({
    name: 'README.txt',
    data: text.encode(buildReadmeText(packParts, s.flashParams, meta)),
  })

  const zip = zipStore(entries)
  const base = (s.loadedProject ?? 'firmware').replace(/[\\/:*?"<>|]/g, '-')
  const blob = new Blob([zip as unknown as BlobPart], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const now = new Date()
  const pz = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pz(now.getMonth() + 1)}${pz(now.getDate())}-${pz(now.getHours())}${pz(now.getMinutes())}${pz(now.getSeconds())}`
  a.download = `${base}-${stamp}.zip`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="fw">
    <div class="fw__crumbs">{{ crumbs }}</div>
    <div v-if="ws.state.loadedMeta" class="fw__meta">
  <span class="fw__meta-item"><i>来源</i>{{ ws.state.loadedProject }}</span>
  <span class="fw__meta-item"><i>版本</i><code>{{ ws.state.loadedMeta.id }}</code></span>
  <span
    class="fw__meta-badge"
    :class="ws.state.loadedMeta.type === 'release' ? 'fw__meta-badge--rel' : ''"
  >
    {{ ws.state.loadedMeta.type === 'release' ? '★ 发布版' : '快照' }}
  </span>
  <span class="fw__meta-item"><i>创建于</i>{{ fmtStamp(ws.state.loadedMeta.createdAt) }}</span>
  <span v-if="ws.state.loadedMeta.chipFamily" class="fw__meta-item"><i>固件芯片</i>{{ ws.state.loadedMeta.chipFamily }}</span>
  <span v-if="ws.state.loadedMeta.note" class="fw__meta-item fw__meta-note"><i>说明</i>{{ ws.state.loadedMeta.note }}</span>
</div>

    <!-- 参数条：一行带过（替代原 5 张参数卡 + 独立标题，纵向省掉一整块） -->
    <div class="fw__bar">
      <span class="fw__bar-title">烧录清单</span>
      <span class="fw__kv"><i>模式</i><code>{{ ws.state.flashParams?.flashMode ?? '—' }}</code></span>
      <span class="fw__kv"><i>频率</i><code>{{ ws.state.flashParams?.flashFreq ?? '—' }}</code></span>
      <span class="fw__kv"><i>容量</i><code>{{ ws.state.flashParams?.flashSize ?? '—' }}</code></span>
      <span class="fw__kv">
        <i>芯片</i>
        <code :class="chipFamilyCell.ok ? 'fw__ok' : 'fw__muted'">{{ chipFamilyCell.text }}</code>
      </span>
      <span class="fw__kv"><i>合计</i><code>{{ rows.length }} 段 · {{ fmtSize(totalBytes) }}</code></span>
    </div>

    <!-- 操作行：主操作留按钮，次要操作收进 ⋯ 菜单（可见控件压到一行） -->
    <div class="fw__actions">
      <button
        class="btn btn--primary"
        type="button"
        :disabled="disabled || rows.length === 0"
        title="写入前会弹出二次确认（段数/字节/地址清单）；写错固件可能无法启动，届时按住 BOOT 重进下载模式"
        @click="doFlash"
      >
        ⚡ 烧录 {{ rows.length }} 段（{{ fmtSize(totalBytes) }}）
      </button>
      <button class="btn btn--ghost" type="button" title="手动添加 bin 文件段" @click="pickFiles()">
        ＋ 添加 bin
      </button>
      <details ref="menuEl" class="menu">
        <summary class="btn btn--ghost menu__sum" title="擦除 / 复位 / 重新载入版本 / 导出固件包">
          ⋯ 更多
        </summary>
        <div class="menu__list">
          <button class="menu__item" type="button" :disabled="disabled" @click="eraseNow">
            <span class="menu__ico">⌫</span>完全擦除 flash
          </button>
          <button class="menu__item" type="button" :disabled="disabled" @click="resetNow">
            <span class="menu__ico">↻</span>硬复位
          </button>
          <button
            class="menu__item"
            type="button"
            :disabled="ws.state.selectedIdx < 0 || ws.state.registryLoading"
            @click="reloadNow"
          >
            <span class="menu__ico">⟲</span>重新载入版本
          </button>
          <button
            class="menu__item"
            type="button"
            :disabled="rows.length === 0"
            title="全部段 + flash_args + README 打 zip（可离线 esptool 烧录）"
            @click="packNow"
          >
            <span class="menu__ico">⬇</span>导出固件包
          </button>
        </div>
      </details>
      <span class="fw__inline-tip">地址与参数以发布记录（flash_args）为准；未连接也可浏览与载入</span>
    </div>

    <div v-if="ws.state.loading" class="fw__loading">
      ⏳ 正在载入 <code>{{ ws.state.loading }}</code>
      <template v-if="ws.state.loadProgress">
        —— {{ ws.state.loadProgress.done }}/{{ ws.state.loadProgress.total }} 段
        · {{ fmtSize(ws.state.loadProgress.bytes) }}
      </template>
    </div>
    <p v-if="ws.state.registryMsg" class="fw__msg">{{ ws.state.registryMsg }}</p>

    <!-- 烧录表格 -->
    <table v-if="rows.length" class="fw__tbl">
      <thead>
        <tr><th>段</th><th>文件</th><th>分区</th><th>地址</th><th>大小</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="(r, i) in rows" :key="r.id" :class="rowClass(i)" :style="rowStyle(i)">
          <td><code>{{ r.label }}</code><span v-if="rowMark(i)" class="fw__mark">{{ rowMark(i) }}</span></td>
          <td class="fw__file">{{ r.file?.name }}</td>
          <td>
            <span
              v-if="r.type"
              class="fw__part"
              :title="r.type === 'app' ? '固件分区' : '数据分区'"
            >
              {{ r.type }}<template v-if="r.subType">/{{ r.subType }}</template>
            </span>
            <span v-else class="fw__part fw__part--none" title="旧版本数据或手动添加">—</span>
          </td>
          <td>
            <input
              class="fw__addr"
              :value="ws.hex(r.address)"
              spellcheck="false"
              @change="onAddressChange(r, $event)"
            />
          </td>
          <td class="fw__size">{{ r.file ? fmtSize(r.file.size) : '—' }}</td>
          <td>
            <button
              class="fw__info"
              type="button"
              title="查看固件详情（镜像头 / 分区表 / 字符串 / 校验和）"
              @click="inspectRow(r)"
            >
              ⓘ
            </button>
            <button class="fw__del" type="button" title="移除该段" @click="ws.removeRow(r.id)">
              ✕
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="fw__empty">（清单为空——载入版本或添加 bin 文件）</p>

    <!-- 烧录进度 -->
    <div v-if="percent !== null" class="fw__prog">
      <div class="fw__prog-bar" :style="{ width: percent + '%' }"></div>
      <span class="fw__prog-t">{{ percent }}%</span>
    </div>

    <!-- 烧录回执：成功/失败都留一条明确结论（配提示音，不用去日志里找） -->
    <div
      v-else-if="flashResult"
      class="fw__result"
      :class="flashResult.ok ? 'fw__result--ok' : 'fw__result--err'"
    >
      <b>{{ flashResult.ok ? '✅ 烧录完成' : '❌ 烧录失败' }}</b>
      <span>
        {{ flashResult.parts }} 段 · {{ fmtSize(flashResult.bytes) }} ·
        {{ (flashResult.ms / 1000).toFixed(1) }}s
      </span>
      <span v-if="flashResult.error" class="fw__result-err">—— {{ flashResult.error }}</span>
    </div>

    <p class="fw__hint">
      地址与参数以发布记录为准（flash_args 权威）；写错固件可能无法启动，届时按住 BOOT 重进下载模式。
    </p>

    <!-- A2 固件详情弹层 -->
    <div v-if="inspect" class="insp" @click.self="inspect = null">
      <div class="insp__card">
        <div class="insp__hd">
          <span class="insp__title">固件详情 · <code>{{ inspect.name }}</code></span>
          <button class="insp__x" type="button" @click="inspect = null">✕</button>
        </div>

        <template v-if="inspect.info.kind === 'image'">
          <div class="insp__grid">
            <div><i>类型</i>ESP 镜像（0xE9）</div>
            <div><i>芯片</i>{{ inspect.info.chipName ?? '未知(ID ' + inspect.info.chipId + ')' }}</div>
            <div><i>段数</i>{{ inspect.info.segmentCount }}</div>
            <div><i>入口</i><code>0x{{ inspect.info.entry.toString(16) }}</code></div>
            <div><i>FLASH MODE</i>{{ inspect.info.flashMode }}</div>
            <div><i>FREQ / SIZE</i>{{ inspect.info.flashFreq }} / {{ inspect.info.flashSize }}</div>
          </div>
        </template>
        <template v-else-if="inspect.info.kind === 'partition-table'">
          <table class="insp__tbl">
            <thead><tr><th>标签</th><th>类型</th><th>子类型</th><th>偏移</th><th>大小</th></tr></thead>
            <tbody>
              <tr v-for="(p, i) in inspect.info.partitions" :key="i">
                <td><code>{{ p.label }}</code></td>
                <td>{{ p.type }}</td>
                <td>{{ p.subType }}</td>
                <td><code>0x{{ p.offset.toString(16) }}</code></td>
                <td>{{ (p.size / 1024).toFixed(1) }} KB</td>
              </tr>
            </tbody>
          </table>
        </template>
        <p v-else class="insp__raw">{{ inspect.info.reason }}</p>

        <div class="insp__sec">SHA-256</div>
        <code class="insp__sha">{{ inspect.sha }}</code>

        <div class="insp__sec">可打印字符串（前 {{ inspect.strings.length }} 条）</div>
        <div class="insp__strings">
          <code v-for="(s, i) in inspect.strings" :key="i">{{ s }}</code>
          <span v-if="inspect.strings.length === 0" class="insp__raw">（无）</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fw {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.fw__crumbs {
  font-size: 12px;
  color: var(--muted);
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
}
/* 参数条：一行内带过（原 5 张参数卡 → 一条 kv 行，纵向省一块） */
.fw__bar {
  display: flex;
  align-items: baseline;
  gap: 6px 18px;
  flex-wrap: wrap;
  padding: 6px 10px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12.5px;
}
.fw__bar-title {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--ink);
  padding-right: 10px;
  border-right: 1px solid var(--border);
}
.fw__kv i {
  font-style: normal;
  color: var(--muted);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  margin-right: 4px;
}
.fw__kv code {
  font-family: ui-monospace, monospace;
  color: var(--ink);
}
.fw__ok {
  color: var(--accent) !important;
}
.fw__muted {
  color: var(--muted) !important;
}
/* 操作行 */
.fw__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.fw__inline-tip {
  font-size: 11.5px;
  color: var(--muted);
  margin-left: 2px;
}
/* ⋯ 更多操作菜单（原生 details，点外部/点条目自动收起） */
.menu {
  position: relative;
}
.menu__sum {
  list-style: none;
  display: inline-block;
  cursor: pointer;
  user-select: none;
}
.menu__sum::-webkit-details-marker {
  display: none;
}
.menu[open] .menu__sum {
  color: var(--ink);
  border-color: var(--muted);
}
.menu__list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 20;
  min-width: 190px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
}
.menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--ink);
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  padding: 6px 10px;
  cursor: pointer;
}
.menu__item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.menu__item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.menu__ico {
  width: 14px;
  text-align: center;
  color: var(--muted);
}
.btn {
  background: var(--panel);
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 5px 12px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.btn:hover:not(:disabled) {
  border-color: var(--muted);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
  font-weight: 700;
}
.btn--ghost {
  background: transparent;
  border-style: dashed;
  color: var(--muted);
}
.fw__meta {
  display: flex;
  align-items: center;
  gap: 8px 16px;
  flex-wrap: wrap;
  background: color-mix(in srgb, var(--accent) 7%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12.5px;
}
.fw__meta-item i {
  font-style: normal;
  color: var(--muted);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  margin-right: 6px;
}
.fw__meta-item code {
  font-family: ui-monospace, monospace;
  color: var(--accent);
}
.fw__meta-badge {
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 9px;
  color: var(--muted);
}
.fw__meta-badge--rel {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.fw__meta-note {
  flex-basis: 100%;
  line-height: 1.6;
}
.fw__loading {
  margin: 0;
  font-size: 12.5px;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--border));
  border-radius: 6px;
  padding: 8px 12px;
}
.fw__loading code {
  font-family: ui-monospace, monospace;
}
.fw__msg {
  margin: 0;
  font-size: 12.5px;
  color: var(--accent);
}
/* 表格 */
.fw__tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.fw__tbl th,
.fw__tbl td {
  text-align: left;
  padding: 7px 9px;
  border-bottom: 1px solid var(--border);
}
.fw__tbl th {
  color: var(--muted);
  font-weight: 500;
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.fw__tbl code {
  font-family: ui-monospace, monospace;
  font-size: 12.5px;
  color: var(--ink);
}
.fw__tbl tbody tr:hover td {
  background: color-mix(in srgb, var(--panel) 70%, transparent);
}
.fw__file {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.fw__part {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  border: 1px solid var(--border);
  padding: 1px 7px;
  border-radius: 4px;
  color: var(--accent);
  white-space: nowrap;
}
.fw__part--none {
  color: var(--muted);
  opacity: 0.5;
}
.fw__addr {
  width: 92px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--ink);
  padding: 4px 7px;
  font-family: ui-monospace, monospace;
  font-size: 12.5px;
}
.fw__size {
  color: var(--muted);
  font-family: ui-monospace, monospace;
  font-size: 12.5px;
}
.fw__del {
  background: none;
  border: none;
  color: var(--err);
  cursor: pointer;
  font-size: 13px;
}
.fw__empty {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 18px;
  text-align: center;
}
/* 烧录回执（成功/失败结论行） */
.fw__result {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 7px 12px;
  border-radius: 6px;
  font-size: 12.5px;
}
.fw__result b {
  font-weight: 700;
}
.fw__result--ok {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
}
.fw__result--err {
  color: var(--err);
  background: color-mix(in srgb, var(--err) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--err) 45%, var(--border));
}
.fw__result span {
  color: var(--ink);
}
.fw__result-err {
  color: inherit !important;
  word-break: break-all;
}
/* 进度条 */
.fw__prog {
  position: relative;
  height: 20px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 5px;
  overflow: hidden;
}
.fw__prog-bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}
.fw__prog-t {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11.5px;
  color: var(--ink);
}
/* 烧录逐段行状态 */
.fw__row--done {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.fw__row--failed {
  background: color-mix(in srgb, var(--err) 14%, transparent);
}
.fw__row--failed td {
  color: var(--err);
}
.fw__mark {
  margin-left: 8px;
  font-size: 11px;
}
/* A2 固件详情 */
.fw__info {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 13px;
  margin-right: 4px;
}
.fw__info:hover {
  color: var(--accent);
}
.insp {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.insp__card {
  width: min(680px, 92vw);
  max-height: 82vh;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 18px;
}
.insp__hd {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}
.insp__title {
  font-size: 14px;
  font-weight: 650;
}
.insp__title code {
  font-family: ui-monospace, monospace;
  color: var(--accent);
}
.insp__x {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
}
.insp__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px 14px;
  font-size: 12.5px;
  margin-bottom: 6px;
}
.insp__grid i {
  font-style: normal;
  color: var(--muted);
  display: block;
  font-size: 10.5px;
  letter-spacing: 0.06em;
  margin-bottom: 1px;
}
.insp__tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.insp__tbl th, .insp__tbl td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
}
.insp__tbl th {
  color: var(--muted);
  font-weight: 500;
}
.insp__sec {
  margin: 12px 0 6px;
  font-size: 10.5px;
  letter-spacing: 0.08em;
  color: var(--muted);
  font-weight: 600;
}
.insp__sha {
  display: block;
  font-size: 11px;
  word-break: break-all;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
}
.insp__strings {
  max-height: 160px;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.insp__strings code {
  font-size: 11px;
  color: var(--info);
  word-break: break-all;
}
.insp__raw {
  color: var(--muted);
  font-size: 12px;
}
.fw__hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
}
</style>
