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
    /** 载入版本元信息（面包屑下的来源信息栏：时间/类型/说明/chipFamily） */
    loadedMeta: null as
      | { id: string; type: string; createdAt: string; note?: string; chipFamily?: string }
      | null,
    loadedProject: null as string | null,
    /** 最近注入的烧录参数（参数卡用；手动添加时为 null=未注入） */
    flashParams: null as FlashParams | null,
    /** 载入中的版本 id（防重复点击；树行/固件页 loading 态） */
    loading: null as string | null,
    /** 载入进度（并行下载 + 字节级实时进度） */
    loadProgress: null as {
      done: number
      total: number
      bytes: number
      totalBytes: number
      current: string[]
      startedAt: number
    } | null,
    /** 最近一次载入失败（重试入口；成功后清空） */
    lastFailure: null as
      | { opt: Pick<RegistryOption, 'projectId' | 'projectName' | 'variant'>; rel: RegistryRelease }
      | null,
  })

  /** 载入取消句柄（AbortController 跨下载复用） */
  let abortCtrl: AbortController | null = null

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
    if (state.loading) return // 已有载入进行中——防重复点击
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
    state.loading = rel.id
    state.lastFailure = null
    const totalBytes = rel.parts.reduce((n, p) => n + (p.size ?? 0), 0)
    const received = new Map<string, number>()
    const finished = new Set<string>()
    const startedAt = Date.now()
    const recalc = (): void => {
      let sum = 0
      for (const p of rel.parts) sum += received.get(p.file) ?? 0
      const current = rel.parts.filter((p) => !finished.has(p.file)).map((p) => p.file)
      state.loadProgress = {
        done: finished.size,
        total: rel.parts.length,
        bytes: sum,
        totalBytes,
        current,
        startedAt,
      }
    }
    recalc()
    abortCtrl = new AbortController()
    try {
      // 并行下载 + 每段字节级进度 + 失败定位到具体文件
      const loaded: FlashRow[] = await Promise.all(
        rel.parts.map(async (p) => {
          try {
            const b = await fetchReleasePart(opt.projectId, opt.variant, rel.id, p.file, {
              signal: abortCtrl!.signal,
              onProgress: ({ received: r }) => {
                received.set(p.file, r)
                recalc()
              },
            })
            received.set(p.file, p.size ?? b.byteLength)
            finished.add(p.file)
            recalc()
            return {
              id: nextId++,
              label: p.label,
              address: p.address,
              file: new File([b as BlobPart], p.file, {
                type: 'application/octet-stream',
              }),
              type: (p as { type?: string }).type,
              subType: (p as { subType?: string }).subType,
            }
          } catch (e) {
            throw new Error(
              `段「${p.file}」下载失败：${e instanceof Error ? e.message : String(e)}`,
            )
          }
        }),
      )
      state.rows.splice(0, state.rows.length, ...loaded)
      state.from = 'registry'
      state.loadedRelease = rel.id
      state.loadedMeta = {
        id: rel.id,
        type: rel.type,
        createdAt: rel.createdAt,
        note: rel.note,
        chipFamily: rel.chipFamily,
      }
      state.loadedProject = `${opt.projectName}/${opt.variant}`
      const fp = toFlashParams(rel.flashParams)
      state.flashParams = fp
      deps.onParams(fp)
      deps.onLoaded(`${opt.projectId}/${opt.variant}`, rel.id)
      state.registryMsg = `已载入 ${opt.projectName}/${opt.variant} ${rel.id}（${loaded.length} 段，烧录参数已注入）`
    } catch (e) {
      if (abortCtrl?.signal.aborted) {
        state.registryMsg = '已取消载入'
      } else {
        console.error('[api] loadRelease 失败:', e)
        state.registryMsg = `载入失败：${e instanceof Error ? e.message : String(e)}`
        state.lastFailure = { opt, rel }
      }
    } finally {
      state.loading = null
      state.loadProgress = null
      abortCtrl = null
    }
  }

  /** 重新载入当前选中版本（固件页「重新载入版本」按钮） */
  async function reloadSelected(): Promise<void> {
    const opt = state.options[state.selectedIdx]
    if (!opt) return
    await loadRelease(opt, opt.release)
  }

  /** 取消进行中的载入（AbortController 中止所有段的 fetch） */
  function cancelLoad(): void {
    abortCtrl?.abort()
  }

  /** 失败后重试最近一次载入（走 loadRelease，芯片比对/进度照常） */
  function retryLoad(): void {
    const f = state.lastFailure
    if (!f) return
    void loadRelease(f.opt, f.rel)
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
    state.loadedMeta = null
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
    state.loadedMeta = null
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
    cancelLoad,
    retryLoad,
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
