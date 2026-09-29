<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import type { ChipInfo, FlashPart } from '../core/device'
import { fetchBuildManifest, fetchBuildPartBytes, type FlashParams } from '../api/buildArtifacts'
import {
  fetchRegistry,
  fetchReleasePart,
  flattenLatest,
  setSubscribed,
  toFlashParams,
  type Registry,
  type RegistryOption,
  type RegistryRelease,
} from '../api/registry'
import VersionTimeline from './VersionTimeline.vue'

interface Row {
  id: number
  label: string
  address: number
  file: File | null
  /** F-22 分区类型元数据（旧数据/手动添加缺省 undefined） */
  type?: string
  subType?: string
}

const rows = reactive<Row[]>([])
let nextId = 1

const emit = defineEmits<{
  flash: [parts: FlashPart[]]
  'params': [params: FlashParams]
  /** 载入完成（key=`pid/vid`）——父层据此清 NEW 角标 */
  'loaded': [key: string]
}>()

const props = defineProps<{
  disabled: boolean
  percent: number | null
  chipName: string | null
  /** F-12：芯片详情（烧录前二次确认用） */
  chipDetail: ChipInfo | null
  buildRunning: boolean
  autoLoadSignal: number
  /** S3：待发布的 `${pid}/{vid}` 集合（NEW 角标） */
  newReleases: Record<string, boolean>
  /** S3：远端有新版本时 +1，触发项目库自动刷新 */
  refreshSignal: number
}>()

const localLoadMsg = ref<string | null>(null)

// 编译成功信号 → 自动载入（loadLocalBuild 内部会把 buildRunning 期间禁用）
watch(
  () => props.autoLoadSignal,
  (n) => {
    if (n > 0) void loadLocalBuild()
  },
)

/** 一键载入：从 dev 中间件读取 IDF build 目录（flash_args 权威地址 + 烧录参数） */
async function loadLocalBuild(): Promise<void> {
  localLoadMsg.value = null
  const manifest = await fetchBuildManifest()
  if (!manifest) {
    localLoadMsg.value =
      '本地构建载入不可用：需设置 IDF_BUILD_DIR 环境变量并已执行过 idf.py build'
    return
  }
  try {
    const loaded: Row[] = []
    for (const p of manifest.parts) {
      const bytes = await fetchBuildPartBytes(p.rel)
      const file = new File([bytes as BlobPart], p.name, {
        type: 'application/octet-stream',
      })
      loaded.push({ id: nextId++, label: p.label, address: p.address, file })
    }
    rows.splice(0, rows.length, ...loaded)
    emit('params', manifest.flashParams)
    localLoadMsg.value = `已载入 ${loaded.length} 段（${manifest.buildDir}）`
  } catch (e) {
    localLoadMsg.value = `载入失败：${e instanceof Error ? e.message : String(e)}`
  }
}

function hex(n: number): string {
  return '0x' + n.toString(16).toUpperCase().padStart(4, '0')
}

function parseAddress(text: string): number | null {
  const t = text.trim().toLowerCase()
  const n = t.startsWith('0x') ? parseInt(t, 16) : parseInt(t, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 按文件名猜测地址：经典 ESP32 bootloader@0x1000，其余芯片@0x0；partition 0x8000；app 0x10000 */
function guessAddress(name: string, chipName: string | null): number {
  const lower = name.toLowerCase()
  if (lower.includes('partition')) return 0x8000
  if (lower.includes('bootloader')) return chipName === 'ESP32' ? 0x1000 : 0x0
  return 0x10000
}

function guessLabel(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('partition')) return 'partition-table'
  if (lower.includes('bootloader')) return 'bootloader'
  return 'app'
}

function onFiles(e: Event): void {
  const input = e.target as HTMLInputElement
  for (const file of Array.from(input.files ?? [])) {
    rows.push({
      id: nextId++,
      label: guessLabel(file.name),
      address: guessAddress(file.name, props.chipName),
      file,
    })
  }
  input.value = ''
}

function removeRow(id: number): void {
  const i = rows.findIndex((r) => r.id === id)
  if (i >= 0) rows.splice(i, 1)
}

function addressText(row: Row): string {
  return hex(row.address)
}

function onAddressInput(row: Row, e: Event): void {
  const v = parseAddress((e.target as HTMLInputElement).value)
  if (v !== null) row.address = v
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

function reset(): void {
  rows.splice(0, rows.length)
}

// ---- 项目库（v1.5 F-20 最小版：拉 registry、列 latest、载入进同一表格）----
const registryOptions = ref<RegistryOption[]>([])
const rawRegistry = ref<Registry | null>(null)
const registryMsg = ref<string | null>(null)
const registryLoading = ref(false)
const selectedIdx = ref(-1)

async function refreshRegistry(): Promise<void> {
  registryLoading.value = true
  registryMsg.value = null
  try {
    const reg = await fetchRegistry()
    rawRegistry.value = reg
    registryOptions.value = flattenLatest(reg)
    registryMsg.value =
      registryOptions.value.length === 0 ? '服务器暂无已发布项目' : null
    if (selectedIdx.value >= registryOptions.value.length) selectedIdx.value = -1
  } catch (e) {
    registryOptions.value = []
    selectedIdx.value = -1
    registryMsg.value = `项目库不可达：${e instanceof Error ? e.message : String(e)}（自含服务未启动？node server/index.js）`
  } finally {
    registryLoading.value = false
  }
}

async function loadRegistryRelease(): Promise<void> {
  const opt = registryOptions.value[selectedIdx.value]
  if (!opt) return
  await loadRelease(opt, opt.release)
}

/**
 * 载入任意版本到烧录表格（项目库 latest 与时间线共用入口）。
 * F-13：实测芯片与固件 chipFamily 不符 → 警告（不阻断）。
 */
async function loadRelease(
  opt: Pick<RegistryOption, 'projectId' | 'projectName' | 'variant'>,
  rel: RegistryRelease,
): Promise<void> {
  registryMsg.value = null
  // F-13 芯片比对（不阻断）
  if (
    props.chipName &&
    rel.chipFamily &&
    rel.chipFamily !== props.chipName &&
    !window.confirm(
      `⚠ 芯片不匹配：固件为 ${rel.chipFamily}，实测设备为 ${props.chipName}。\n仍要载入吗？（烧错芯片固件可能无法启动）`,
    )
  ) {
    registryMsg.value = `已取消载入（chipFamily 不符：${rel.chipFamily} ≠ ${props.chipName}）`
    return
  }
  try {
    const loaded: Row[] = []
    for (const p of rel.parts) {
      const bytes = await fetchReleasePart(opt.projectId, opt.variant, rel.id, p.file)
      const file = new File([bytes as BlobPart], p.file, {
        type: 'application/octet-stream',
      })
      loaded.push({
        id: nextId++,
        label: p.label,
        address: p.address,
        file,
        type: (p as { type?: string }).type,
        subType: (p as { subType?: string }).subType,
      })
    }
    rows.splice(0, rows.length, ...loaded)
    emit('params', toFlashParams(rel.flashParams))
    emit('loaded', `${opt.projectId}/${opt.variant}`)
    registryMsg.value = `已载入 ${opt.projectName}/${opt.variant} ${rel.id}（${loaded.length} 段，烧录参数已注入）`
  } catch (e) {
    registryMsg.value = `载入失败：${e instanceof Error ? e.message : String(e)}`
  }
}

onMounted(() => {
  void refreshRegistry()
})

// S3：远端 publish 到达 → 自动刷新 latest 列表
watch(
  () => props.refreshSignal,
  (n) => {
    if (n > 0) void refreshRegistry()
  },
)

/** ★订阅开关（F-21）：切换选中项目的 subscribed（localStorage+服务端双写） */
async function toggleSubscribe(): Promise<void> {
  const opt = registryOptions.value[selectedIdx.value]
  if (!opt) return
  const next = !opt.subscribed
  await setSubscribed(opt.projectId, next)
  opt.subscribed = next
  registryMsg.value = next
    ? `已订阅 ${opt.projectName}（发布会横幅提醒）`
    : `已取消订阅 ${opt.projectName}（发布会静默）`
}
</script>

<template>
  <section class="panel">
    <h2 class="panel__title">② 选择固件文件</h2>
    <p class="panel__hint">
      多选 bin 后地址按文件名自动填（bootloader / partition-table / app），可手改。
      当前芯片：<code>{{ chipName ?? '未连接' }}</code>
      <template v-if="!chipName">
        —— <b>未连接也可浏览项目库/版本时间线并载入</b>，仅「烧录」需要先连接设备。
      </template>
    </p>

    <div class="loadrow">
      <button
        class="btn btn--load"
        type="button"
        :disabled="buildRunning"
        :title="buildRunning ? '编译进行中，完成后会自动载入' : '从 IDF build 目录自动载入 flash_args 中的全部固件段与烧录参数'"
        @click="loadLocalBuild"
      >
        ⚡ 载入本地构建（一键）
      </button>
      <label class="filebtn">
        添加 bin 文件…
        <input type="file" accept=".bin" multiple @change="onFiles" />
      </label>
    </div>
    <p v-if="localLoadMsg" class="loadmsg">{{ localLoadMsg }}</p>

    <!-- 项目库（v1.5 F-20 最小版）：两跳可达——选项目 → 载入 latest -->
    <div class="registry">
      <span class="registry__label">📁 项目库</span>
      <select
        v-model="selectedIdx"
        class="registry__select"
        :disabled="registryLoading || registryOptions.length === 0"
      >
        <option :value="-1" disabled>— 点「刷新」加载 —</option>
        <option v-for="(o, i) in registryOptions" :key="o.projectId + '/' + o.variant" :value="i">
          {{ o.subscribed ? '★' : '☆' }}{{ newReleases[o.projectId + '/' + o.variant] ? ' ●NEW ' : ' ' }}{{ o.projectName }} · {{ o.variant }} · {{ o.release.id }}{{ o.release.type === 'release' ? ' ★' : '' }}
        </option>
      </select>
      <button
        class="btn"
        type="button"
        :disabled="selectedIdx < 0"
        :title="selectedIdx >= 0 && registryOptions[selectedIdx]?.subscribed ? '取消订阅该项目（发布会静默）' : '订阅该项目（发布会横幅提醒）'"
        @click="toggleSubscribe"
      >
        {{ selectedIdx >= 0 && registryOptions[selectedIdx]?.subscribed ? '★ 已订阅' : '☆ 订阅' }}
      </button>
      <button
        class="btn"
        type="button"
        :disabled="registryLoading"
        title="拉取 /api/registry 最新版本列表"
        @click="refreshRegistry"
      >
        {{ registryLoading ? '拉取中…' : '刷新' }}
      </button>
      <button
        class="btn btn--load"
        type="button"
        :disabled="selectedIdx < 0 || buildRunning"
        title="下载该版本全部段并填入下方表格（含烧录参数）——无需连接设备"
        @click="loadRegistryRelease"
      >
        载入此版本
      </button>
    </div>
    <p v-if="registryMsg" class="loadmsg">{{ registryMsg }}</p>

    <!-- S4 版本时间线（F-20 回滚 / F-24 晋升与 retention / F-13 比对共用载入入口）
         全部为数据操作，未连接设备同样可用 -->
    <VersionTimeline
      v-if="selectedIdx >= 0 && registryOptions[selectedIdx]"
      :option="registryOptions[selectedIdx]"
      :registry="rawRegistry"
      :chip-name="chipName"
      :disabled="buildRunning"
      @load="(rel) => loadRelease(registryOptions[selectedIdx], rel)"
      @changed="refreshRegistry"
    />

    <table v-if="rows.length" class="tbl">
      <thead>
        <tr><th>段</th><th>文件</th><th>分区</th><th>地址</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td><code>{{ r.label }}</code></td>
          <td class="tbl__file">{{ r.file?.name }}</td>
          <td class="tbl__part">
            <span v-if="r.type" class="tbl__part-badge" :title="r.type === 'app' ? '固件分区' : '数据分区'">
              {{ r.type }}<template v-if="r.subType">/{{ r.subType }}</template>
            </span>
            <span v-else class="tbl__part-none" title="未识别分区类型（旧版本数据或手动添加）">—</span>
          </td>
          <td>
            <input
              class="tbl__addr"
              :value="addressText(r)"
              spellcheck="false"
              @change="onAddressInput(r, $event)"
            />
          </td>
          <td><button class="tbl__del" type="button" @click="removeRow(r.id)">✕</button></td>
        </tr>
      </tbody>
    </table>

    <div class="panel__actions">
      <button
        class="btn btn--primary"
        type="button"
        :disabled="disabled || rows.length === 0"
        @click="doFlash"
      >
        烧录
      </button>
      <button v-if="rows.length" class="btn" type="button" :disabled="disabled" @click="reset">
        清空列表
      </button>
    </div>

    <div v-if="percent !== null" class="progress">
      <div class="progress__bar" :style="{ width: percent + '%' }"></div>
      <span class="progress__text">{{ percent }}%</span>
    </div>
  </section>
</template>

<style scoped>
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}
.panel__title {
  margin: 0 0 10px;
  font-size: 15px;
  font-weight: 600;
}
.panel__hint {
  margin: 0 0 12px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}
.loadrow {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.btn--load {
  background: transparent;
  color: var(--accent);
  border: 1px dashed var(--accent);
  border-radius: 6px;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
}
.btn--load:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.loadmsg {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--muted);
}
.registry {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.registry__label {
  font-size: 13px;
  color: var(--muted);
}
.registry__select {
  flex: 1;
  min-width: 220px;
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 8px;
  font-size: 13px;
}
.registry__select:disabled {
  opacity: 0.45;
}
.filebtn {
  display: inline-block;
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
  color: var(--ink);
}
.filebtn:hover {
  border-color: var(--accent);
}
.filebtn input {
  display: none;
}
.tbl {
  width: 100%;
  margin: 12px 0;
  border-collapse: collapse;
  font-size: 13px;
}
.tbl th,
.tbl td {
  border-bottom: 1px solid var(--border);
  padding: 6px 8px;
  text-align: left;
}
.tbl th {
  color: var(--muted);
  font-weight: 500;
}
.tbl__file {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tbl__part {
  white-space: nowrap;
}
.tbl__part-badge {
  font-size: 11px;
  border-radius: 4px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  color: var(--accent);
}
.tbl__part-none {
  color: var(--muted);
  opacity: 0.5;
}
.tbl__addr {
  width: 90px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--ink);
  padding: 4px 6px;
  font-family: ui-monospace, monospace;
}
.tbl__del {
  background: none;
  border: none;
  color: var(--err);
  cursor: pointer;
}
.panel__actions {
  display: flex;
  gap: 10px;
}
.btn {
  background: transparent;
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 16px;
  cursor: pointer;
  font-size: 14px;
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
.progress {
  position: relative;
  margin-top: 12px;
  height: 22px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.progress__bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}
.progress__text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--ink);
}
</style>
