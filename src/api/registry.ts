/** 固件项目库 API 客户端（v1.5 · F-20；相对路径经 vite proxy → localhost:8787） */
import type { FlashParams } from './buildArtifacts'

export interface RegistryPart {
  label: string
  address: number
  file: string
  sha256: string
  size: number
}

export interface RegistryFlashParams {
  mode: string
  freq: string
  size: string
}

export interface RegistryRelease {
  id: string
  type: 'snapshot' | 'release'
  chipFamily: string
  flashParams: RegistryFlashParams
  note?: string
  createdAt: string
  parts: RegistryPart[]
}

export interface RegistryVariant {
  latest: string | null
  releases: RegistryRelease[]
}

export interface RegistryProject {
  id: string
  name: string
  description: string
  variants: Record<string, RegistryVariant>
}

export interface Registry {
  projects: Record<string, RegistryProject>
}

export interface RegistryOption {
  projectId: string
  projectName: string
  variant: string
  release: RegistryRelease
}

/** 可载入选项 = 每个 project/variant 的 latest release（两跳可达的最小实现） */
export function flattenLatest(registry: Registry): RegistryOption[] {
  const out: RegistryOption[] = []
  for (const p of Object.values(registry.projects ?? {})) {
    for (const [variant, v] of Object.entries(p.variants ?? {})) {
      const rel = v.releases?.find((r) => r.id === v.latest) ?? v.releases?.[0]
      if (rel) out.push({ projectId: p.id, projectName: p.name, variant, release: rel })
    }
  }
  out.sort((a, b) => (a.release.createdAt < b.release.createdAt ? 1 : -1))
  return out
}

export async function fetchRegistry(): Promise<Registry> {
  const r = await fetch('/api/registry')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()) as Registry
}

export async function fetchReleasePart(
  pid: string,
  vid: string,
  rid: string,
  file: string,
): Promise<Uint8Array> {
  const r = await fetch(
    `/api/registry/projects/${encodeURIComponent(pid)}/variants/${encodeURIComponent(vid)}` +
      `/releases/${encodeURIComponent(rid)}/parts/${encodeURIComponent(file)}`,
  )
  if (!r.ok) throw new Error(`${file} 下载失败（HTTP ${r.status}）`)
  return new Uint8Array(await r.arrayBuffer())
}

/** Release.flashParams（mode/freq/size）→ 烧录参数注入形状 */
export function toFlashParams(p: RegistryFlashParams): FlashParams {
  return {
    flashMode: (p.mode || 'dio') as FlashParams['flashMode'],
    flashFreq: (p.freq || '40m') as FlashParams['flashFreq'],
    flashSize: (p.size || '4MB') as FlashParams['flashSize'],
  }
}
