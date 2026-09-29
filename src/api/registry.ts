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
  subscribed?: boolean
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
  subscribed: boolean
}

/** 可载入选项 = 每个 project/variant 的 latest release（两跳可达的最小实现） */
export function flattenLatest(registry: Registry): RegistryOption[] {
  const out: RegistryOption[] = []
  for (const p of Object.values(registry.projects ?? {})) {
    for (const [variant, v] of Object.entries(p.variants ?? {})) {
      const rel = v.releases?.find((r) => r.id === v.latest) ?? v.releases?.[0]
      if (rel) {
        out.push({
          projectId: p.id,
          projectName: p.name,
          variant,
          release: rel,
          subscribed: p.subscribed !== false,
        })
      }
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

// ---------- S3 订阅（F-21） ----------

export interface PublishEvent {
  project: string
  variant: string
  release: { id: string; type?: string; createdAt?: string }
}

export type StreamStatus = 'connected' | 'polling'

export interface StreamHandlers {
  onPublish: (e: PublishEvent) => void
  onStatus: (s: StreamStatus) => void
}

/** `${pid}/${vid}` → latest id 快照（轮询降级的 diff 基线） */
export function snapshotLatest(registry: Registry): Record<string, string> {
  const snap: Record<string, string> = {}
  for (const p of Object.values(registry.projects ?? {})) {
    for (const [vid, v] of Object.entries(p.variants ?? {})) {
      snap[`${p.id}/${vid}`] = v.latest ?? ''
    }
  }
  return snap
}

/** 快照 diff → 变化的 project/variant 列表（轮询降级触发依据；纯函数可测） */
export function diffLatest(
  prev: Record<string, string>,
  next: Record<string, string>,
): { key: string; latest: string }[] {
  const changed: { key: string; latest: string }[] = []
  for (const [key, id] of Object.entries(next)) {
    if (prev[key] !== undefined && prev[key] !== id) {
      changed.push({ key, latest: id })
    }
  }
  return changed
}

const POLL_MS = 30_000

/**
 * 订阅 registry：SSE 即时 + 断线 30s 轮询降级（FIRMWARE-REGISTRY §6）。
 * SSE 断开时 EventSource 自身指数重连，onopen 自动停轮询。
 * 返回退订函数。
 */
export function subscribeRegistry(h: StreamHandlers): () => void {
  let es: EventSource | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let snap: Record<string, string> | null = null
  let firstPoll = true

  const stopPoll = (): void => {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  const pollOnce = async (): Promise<void> => {
    try {
      const reg = await fetchRegistry()
      const next = snapshotLatest(reg)
      if (firstPoll) {
        firstPoll = false
        snap = next
        return
      }
      const changed = diffLatest(snap ?? {}, next)
      snap = next
      if (changed.length > 0) h.onStatus('polling')
      for (const c of changed) {
        const [project, variant] = c.key.split('/')
        h.onPublish({ project, variant, release: { id: c.latest } })
      }
    } catch {
      /* 服务器不可达：保持轮询下轮再试 */
    }
  }

  const startPoll = (): void => {
    if (pollTimer !== null) return
    h.onStatus('polling')
    void pollOnce()
    pollTimer = setInterval(() => void pollOnce(), POLL_MS)
  }

  const connect = (): void => {
    es = new EventSource('/api/registry/stream')
    es.onopen = () => {
      stopPoll()
      h.onStatus('connected')
    }
    es.addEventListener('publish', (ev) => {
      h.onStatus('connected')
      try {
        h.onPublish(JSON.parse((ev as MessageEvent).data) as PublishEvent)
      } catch {
        /* 坏帧忽略 */
      }
    })
    es.onerror = () => {
      // EventSource 自动重连期间用轮询兜底
      startPoll()
    }
  }

  connect()

  return () => {
    es?.close()
    es = null
    stopPoll()
  }
}

// ---------- ★订阅状态（服务端持久 + localStorage 镜像，F-21） ----------

const LS_PREFIX = 'fw.subscribed.'

function lsGet(pid: string): boolean | null {
  try {
    const v = globalThis.localStorage?.getItem(LS_PREFIX + pid)
    return v === null || v === undefined ? null : v === '1'
  } catch {
    return null
  }
}

function lsSet(pid: string, v: boolean): void {
  try {
    globalThis.localStorage?.setItem(LS_PREFIX + pid, v ? '1' : '0')
  } catch {
    /* 私隐模式忽略 */
  }
}

/** 本地镜像（缺省 true=默认订阅）；服务端为准的权威值在 registry.projects[].subscribed */
export function isSubscribed(projectId: string, serverValue?: boolean): boolean {
  const local = lsGet(projectId)
  if (local !== null) return local
  if (serverValue !== undefined) return serverValue
  return true
}

/** 双写：localStorage 乐观 + POST 服务端（失败仅记日志，下次 GET 对齐） */
export async function setSubscribed(projectId: string, subscribed: boolean): Promise<void> {
  lsSet(projectId, subscribed)
  try {
    const r = await fetch(
      `/api/registry/projects/${encodeURIComponent(projectId)}/subscribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscribed }),
      },
    )
    if (!r.ok) console.warn('[subscribe] server rejected', r.status)
  } catch (e) {
    console.warn('[subscribe] offline, local only', e)
  }
}
