/**
 * 固件工作区（单一实例，App setup 中调用一次）。
 * 把原 FirmwarePanel 内部的「烧录表格 rows + 项目库 registry 状态」上提，
 * 使侧栏项目树、固件标签页、版本时间线标签页共享同一份选择与载入结果。
 * 依赖通过 deps 注入（芯片名 / 参数回调 / 载入完成回调），保持可单测方向。
 */
import { onMounted, reactive } from 'vue'
import {
  fetchRegistry,
  fetchReleasePart,
  flattenLatest,
  setSubscribed,
  toFlashParams,
  type FlashParams,
  type Registry,
  type RegistryOption,
  type RegistryRelease,
} from '../api/registry'

export interface FlashRow {
  id: number
  label: string
  address: number
  file: File | null
  /** F-22 分区类型元数据（旧数据/手动添加缺省 undefined） */
  type?: string
  subType?: string
}

export interface WorkspaceDeps {
  /** F-13 芯片比对用（载入时读取当前实测芯片名） */
  getChipName(): string | null
  /** 注入烧录参数到设备会话 */
  onParams(p: FlashParams): void
  /** 载入完成（key=`pid/vid`）——清 NEW 角标 */
  onLoaded(key: string, releaseId: string): void
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

export function useFirmwareWorkspace(deps: WorkspaceDeps) {
  let nextId = 1

  const state = reactive({
    /** 烧录表格（固件标签页渲染；侧栏/时间线载入后填充） */
    rows: [] as FlashRow[],
    /** 项目库：flattenLatest 平铺列表（每个 pid/variant 一条） */
    options: [] as RegistryOption[],
    rawRegistry: null as Registry | null,
    selectedIdx: -1,
    registryMsg: null as string | null,
    registryLoading: false,
    /** 当前表格来源：项目库载入 / 手动添加（面包屑用） */
    from: null as 'registry' | 'manual' | null,
    /** 最近一次载入的版本（面包屑用） */
    loadedRelease: null as string | null,
    loadedProject: null as string | null,
    /** 最近注入的烧录参数（参数卡用；手动添加时为 null=未注入） */
    flashParams: null as FlashParams | null,
  })

  async function refreshRegistry(): Promise<void> {
    state.registryLoading = true
    state.registryMsg = null
    try {
      const reg = await fetchRegistry()
      state.rawRegistry = reg
      state.options = flattenLatest(reg)
      state.registryMsg = state.options.length === 0 ? '服务器暂无已发布项目' : null
      if (state.selectedIdx >= state.options.length) state.selectedIdx = -1
    } catch (e) {
      console.error('[api] refreshRegistry 失败:', e)
      state.options = []
      state.selectedIdx = -1
      state.registryMsg = `项目库不可达：${e instanceof Error ? e.message : String(e)}（自含服务未启动？node server/index.js）`
    } finally {
      state.registryLoading = false
    }
  }

  /**
   * 载入任意版本到烧录表格（侧栏项目树 / 固件页重载 / 时间线共用入口）。
   * F-13：实测芯片与固件 chipFamily 不符 → 警告（不阻断）。
   */
  async function loadRelease(
    opt: Pick<RegistryOption, 'projectId' | 'projectName' | 'variant'>,
    rel: RegistryRelease,
  ): Promise<void> {
    state.registryMsg = null
    const chipName = deps.getChipName()
    if (
      chipName &&
      rel.chipFamily &&
      rel.chipFamily !== chipName &&
      !window.confirm(
        `⚠ 芯片不匹配：固件为 ${rel.chipFamily}，实测设备为 ${chipName}。\n仍要载入吗？（烧错芯片固件可能无法启动）`,
      )
    ) {
      state.registryMsg = `已取消载入（chipFamily 不符：${rel.chipFamily} ≠ ${chipName}）`
      return
    }
    try {
      const loaded: FlashRow[] = []
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
      state.rows.splice(0, state.rows.length, ...loaded)
      state.from = 'registry'
      state.loadedRelease = rel.id
      state.loadedProject = `${opt.projectName}/${opt.variant}`
      const fp = toFlashParams(rel.flashParams)
      state.flashParams = fp
      deps.onParams(fp)
      deps.onLoaded(`${opt.projectId}/${opt.variant}`, rel.id)
      state.registryMsg = `已载入 ${opt.projectName}/${opt.variant} ${rel.id}（${loaded.length} 段，烧录参数已注入）`
    } catch (e) {
      console.error('[api] loadRelease 失败:', e)
      state.registryMsg = `载入失败：${e instanceof Error ? e.message : String(e)}`
    }
  }

  /** 重新载入当前选中版本（固件页「重新载入版本」按钮） */
  async function reloadSelected(): Promise<void> {
    const opt = state.options[state.selectedIdx]
    if (!opt) return
    await loadRelease(opt, opt.release)
  }

  async function toggleSubscribe(): Promise<void> {
    const opt = state.options[state.selectedIdx]
    if (!opt) return
    const next = !opt.subscribed
    await setSubscribed(opt.projectId, next)
    opt.subscribed = next
    state.registryMsg = next
      ? `已订阅 ${opt.projectName}（发布会横幅提醒）`
      : `已取消订阅 ${opt.projectName}（发布会静默）`
  }

  function selectOption(idx: number): void {
    state.selectedIdx = idx
  }

  function addFiles(files: File[], chipName: string | null): void {
    for (const file of files) {
      state.rows.push({
        id: nextId++,
        label: guessLabel(file.name),
        address: guessAddress(file.name, chipName),
        file,
      })
    }
    state.from = 'manual'
    state.loadedRelease = null
    state.loadedProject = null
    // 手动添加不清 flashParams（保持上次注入值，与旧版一致）
  }

  function removeRow(id: number): void {
    const i = state.rows.findIndex((r) => r.id === id)
    if (i >= 0) state.rows.splice(i, 1)
  }

  function resetRows(): void {
    state.rows.splice(0, state.rows.length)
    state.from = null
    state.loadedRelease = null
    state.loadedProject = null
  }

  function parseAddress(text: string): number | null {
    const t = text.trim().toLowerCase()
    const n = t.startsWith('0x') ? parseInt(t, 16) : parseInt(t, 10)
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  function hex(n: number): string {
    return '0x' + n.toString(16).toUpperCase().padStart(4, '0')
  }

  onMounted(() => {
    void refreshRegistry()
  })

  return {
    state,
    refreshRegistry,
    loadRelease,
    reloadSelected,
    toggleSubscribe,
    selectOption,
    addFiles,
    removeRow,
    resetRows,
    parseAddress,
    hex,
  }
}

export type FirmwareWorkspace = ReturnType<typeof useFirmwareWorkspace>
