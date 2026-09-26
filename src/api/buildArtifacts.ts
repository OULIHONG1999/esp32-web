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

/** 拉取 dev 中间件暴露的本地构建清单（IDF_BUILD_DIR 未配置或未编译时返回 null） */
export async function fetchBuildManifest(): Promise<BuildManifest | null> {
  try {
    const r = await fetch('api/artifacts')
    if (!r.ok) return null
    return (await r.json()) as BuildManifest
  } catch {
    return null
  }
}

export async function fetchBuildPartBytes(rel: string): Promise<Uint8Array> {
  const r = await fetch(`api/artifacts/file?path=${encodeURIComponent(rel)}`)
  if (!r.ok) throw new Error(`下载固件段失败：${rel} (HTTP ${r.status})`)
  return new Uint8Array(await r.arrayBuffer())
}
