export interface FlashParams {
  flashMode: 'qio' | 'qout' | 'dio' | 'dout'
  flashFreq: '80m' | '40m' | '26m' | '20m'
  flashSize:
    | '256KB'
    | '512KB'
    | '1MB'
    | '2MB'
    | '4MB'
    | '8MB'
    | '16MB'
    | '32MB'
    | '64MB'
    | '128MB'
}

export interface BuildPart {
  address: number
  rel: string
  name: string
  label: string
  size: number
}

export interface BuildManifest {
  buildDir: string
  flashParams: FlashParams
  parts: BuildPart[]
}

/**
 * 归一化中间件返回的 flashParams。
 * 门2 踩坑（2026-09-27）：中间件曾返回 {mode,freq,size} 而前端按
 * {flashMode,flashFreq,flashSize} 消费 → 参数全落默认 40m/4MB（D4 根因）。
 * 双形状兼容 + 单测守护，防止再次静默失配。
 */
export function normalizeFlashParams(raw: unknown): FlashParams {
  const r = (raw ?? {}) as Record<string, unknown>
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v ? v : fallback
  return {
    flashMode: str(r.flashMode ?? r.mode, 'dio') as FlashParams['flashMode'],
    flashFreq: str(r.flashFreq ?? r.freq, '40m') as FlashParams['flashFreq'],
    flashSize: str(r.flashSize ?? r.size, '4MB') as FlashParams['flashSize'],
  }
}

/** 拉取 dev 中间件暴露的本地构建清单（IDF_BUILD_DIR 未配置或未编译时返回 null） */
export async function fetchBuildManifest(): Promise<BuildManifest | null> {
  try {
    const r = await fetch('api/artifacts')
    if (!r.ok) return null
    const j = (await r.json()) as Omit<BuildManifest, 'flashParams'> & { flashParams: unknown }
    return { ...j, flashParams: normalizeFlashParams(j.flashParams) }
  } catch {
    return null
  }
}

export async function fetchBuildPartBytes(rel: string): Promise<Uint8Array> {
  const r = await fetch(`api/artifacts/file?path=${encodeURIComponent(rel)}`)
  if (!r.ok) throw new Error(`下载固件段失败：${rel} (HTTP ${r.status})`)
  return new Uint8Array(await r.arrayBuffer())
}
