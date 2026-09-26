<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { FlashPart } from '../core/session'
import { fetchBuildManifest, fetchBuildPartBytes, type FlashParams } from '../api/buildArtifacts'

interface Row {
  id: number
  label: string
  address: number
  file: File | null
}

const rows = reactive<Row[]>([])
let nextId = 1

const emit = defineEmits<{
  flash: [parts: FlashPart[]]
  'params': [params: FlashParams]
}>()

const props = defineProps<{
  disabled: boolean
  percent: number | null
  chipName: string | null
}>()

const localLoadMsg = ref<string | null>(null)

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
  emit('flash', parts)
}

function reset(): void {
  rows.splice(0, rows.length)
}
</script>

<template>
  <section class="panel">
    <h2 class="panel__title">② 选择固件文件</h2>
    <p class="panel__hint">
      多选 bin 后地址按文件名自动填（bootloader / partition-table / app），可手改。
      当前芯片：<code>{{ chipName ?? '未连接' }}</code>
    </p>

    <div class="loadrow">
      <button
        class="btn btn--load"
        type="button"
        :disabled="disabled"
        title="从 IDF build 目录自动载入 flash_args 中的全部固件段与烧录参数"
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

    <table v-if="rows.length" class="tbl">
      <thead>
        <tr><th>段</th><th>文件</th><th>地址</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td><code>{{ r.label }}</code></td>
          <td class="tbl__file">{{ r.file?.name }}</td>
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
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  color: #04150f;
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
