<script setup lang="ts">
/**
 * 固件标签页（b-ide 编辑区复刻：面包屑 + 参数卡 + 操作行 + 烧录表格）。
 * 数据与项目库选择在 useFirmwareWorkspace（侧栏树 / 时间线共享）；
 * 本组件只负责展示与烧录确认。扩展：操作行按钮走 emits（flash/erase/hardReset）。
 */
import { computed, ref } from 'vue'
import type { ChipInfo, FlashPart } from '../core/device'
import type { FirmwareWorkspace } from '../composables/useFirmwareWorkspace'
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
  /** 打开共享的隐藏文件选择器（App 持有 input） */
  pickFiles: () => void
}>()
const emit = defineEmits<{
  flash: [parts: FlashPart[]]
  erase: []
  hardReset: []
}>()

const rows = props.ws.state.rows

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

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

const chipFamilyCell = computed(() => {
  if (!props.chipName) return { text: '未连接', cls: 'st__v--muted' }
  return { text: props.chipName, cls: 'st__v--ok' }
})

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
    <h2 class="fw__title">烧录清单</h2>

    <!-- 参数卡（b-ide 同款 stat cards） -->
    <div class="fw__stats">
      <div class="fw__stat">
        <div class="fw__stat-k">FLASH MODE</div>
        <div class="fw__stat-v">{{ ws.state.flashParams?.flashMode ?? '—' }}</div>
      </div>
      <div class="fw__stat">
        <div class="fw__stat-k">FREQ</div>
        <div class="fw__stat-v">{{ ws.state.flashParams?.flashFreq ?? '—' }}</div>
      </div>
      <div class="fw__stat">
        <div class="fw__stat-k">SIZE</div>
        <div class="fw__stat-v">{{ ws.state.flashParams?.flashSize ?? '—' }}</div>
      </div>
      <div class="fw__stat">
        <div class="fw__stat-k">CHIP FAMILY</div>
        <div class="fw__stat-v" :class="chipFamilyCell.cls">{{ chipFamilyCell.text }}</div>
      </div>
      <div class="fw__stat">
        <div class="fw__stat-k">合计</div>
        <div class="fw__stat-v">{{ rows.length }} 段 · {{ fmtSize(totalBytes) }}</div>
      </div>
    </div>

    <!-- 操作行 -->
    <div class="fw__actions">
      <button
        class="btn btn--primary"
        type="button"
        :disabled="disabled || rows.length === 0"
        title="写入前会弹出二次确认（段数/字节/地址清单）"
        @click="doFlash"
      >
        ⚡ 烧录 {{ rows.length }} 段（{{ fmtSize(totalBytes) }}）
      </button>
      <button
        class="btn btn--danger"
        type="button"
        :disabled="disabled"
        title="擦除整个 flash（需确认）"
        @click="emit('erase')"
      >
        完全擦除
      </button>
      <button class="btn" type="button" :disabled="disabled" @click="emit('hardReset')">
        硬复位
      </button>
      <button
        class="btn btn--sec"
        type="button"
        :disabled="ws.state.selectedIdx < 0 || ws.state.registryLoading"
        title="按当前选中版本重新下载全部段"
        @click="ws.reloadSelected()"
      >
        重新载入版本
      </button>
      <button class="btn btn--ghost" type="button" @click="pickFiles()">添加 bin…</button>
      <button
        class="btn btn--ghost"
        type="button"
        :disabled="rows.length === 0"
        title="把当前清单所有段 + flash_args + README 打包为 zip 下载（可离线 esptool 烧录）"
        @click="exportPack"
      >
        ⬇ 导出固件包
      </button>
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
        <tr v-for="r in rows" :key="r.id">
          <td><code>{{ r.label }}</code></td>
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

    <p class="fw__hint">
      地址与参数以发布记录为准（flash_args 权威）；写错固件可能无法启动，届时按住 BOOT 重进下载模式。
      未连接也可浏览与载入，仅「烧录 / 擦除 / 复位」需要先连接设备。
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
.fw__title {
  font-size: 15px;
  font-weight: 650;
  margin: 0;
  color: var(--ink);
}
/* 参数卡 */
.fw__stats {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.fw__stat {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 14px;
  min-width: 118px;
}
.fw__stat-k {
  font-size: 10.5px;
  letter-spacing: 0.08em;
  color: var(--muted);
  font-weight: 600;
}
.fw__stat-v {
  font-size: 14px;
  font-family: ui-monospace, monospace;
  color: var(--ink);
  margin-top: 2px;
}
.fw__stat-v--ok {
  color: var(--accent);
}
.fw__stat-v--muted {
  color: var(--muted);
}
/* 操作行 */
.fw__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.btn {
  background: var(--panel);
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 7px 16px;
  font-size: 13.5px;
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
.btn--danger {
  color: var(--err);
  border-color: color-mix(in srgb, var(--err) 55%, var(--border));
}
.btn--sec {
  background: transparent;
}
.btn--ghost {
  background: transparent;
  border-style: dashed;
  color: var(--muted);
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
