import path from 'node:path'
import { buildParts, collectShaSet, parseConfig, pickMissing, releaseId, toMeta } from './lib.js'

/**
 * 单次发布（`publish once` 主体，供 watch 复用）。
 * @param {{config:string, buildDir?:string|null, server?:string|null, releaseId?:string|null}} args
 * @param {{retries?:number}} [opts] 网络重试退避（watch 用 3 次；once 默认 0）
 */
export async function runOnce(args, opts = {}) {
  const { cfg, dir } = parseConfig(args.config)
  const buildDir = path.resolve(args.buildDir ?? cfg.buildDir ?? path.join(dir, 'build'))
  const server = (args.server ?? cfg.server).replace(/\/+$/, '')
  if (!cfg.token) throw new Error('publish token missing (config token 或 FIRMWARE_PUBLISH_TOKEN)')

  const { parts, flashParams, variant } = buildParts({ cfg, dir, buildDir })
  const id = args.releaseId ?? releaseId(dir)
  const meta = toMeta({ cfg, parts, flashParams, variant, id })

  const maxRetries = opts.retries ?? 0
  let lastErr = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = 1000 * 2 ** (attempt - 1) // 1s, 2s, 4s
      console.log(`[publish] 网络重试 ${attempt}/${maxRetries}（${backoff}ms 后）…`)
      await new Promise((r) => setTimeout(r, backoff))
    }
    try {
      // ---- 查缺：GET registry → 同 project/variant 已有 release 的 parts 差集 ----
      const regRes = await fetch(`${server}/api/registry`)
      if (!regRes.ok) throw new Error(`GET /api/registry → ${regRes.status}`)
      const registry = await regRes.json()
      const serverRelease =
        registry.projects?.[cfg.project.id]?.variants?.[variant]?.releases?.find(
          (r) => r.id === id,
        ) ?? null
      // S2 增量：跨 release 的 sha 集合（服务器端同样按 sha 复用，双端一致）
      const shaSet = collectShaSet(registry, cfg.project.id, variant)
      const missing = pickMissing(parts, serverRelease, shaSet)

      console.log(
        `[publish] project=${cfg.project.id} variant=${variant} release=${id}`,
      )
      console.log(
        `[publish] parts=${parts.length} 上传=${missing.length}${missing.length ? `（${missing.map((p) => p.file).join(', ')}）` : '（服务器已有，秒回）'} `,
      )

      // ---- multipart 上传 ----
      const fd = new FormData()
      fd.set('meta', JSON.stringify(meta))
      for (const p of missing) {
        fd.append('file', new Blob([p.data]), p.file)
      }
      const res = await fetch(`${server}/api/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token}` },
        body: fd,
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(`POST /api/publish → ${res.status} ${json.error ?? ''}`)
      console.log(`[publish] ✓ 已发布 ${json.project}/${json.variant}/${json.release}`)
      return json
    } catch (err) {
      // 保留 cause（fetch failed 的真因在 err.cause：ECONNRESET/CERT 等）
      const cause = err instanceof Error ? err.cause : null
      lastErr =
        cause && typeof cause === 'object'
          ? new Error(
              `${err instanceof Error ? err.message : String(err)} cause=[${'code' in cause ? cause.code : ''}] ${'message' in cause ? cause.message : ''}`,
            )
          : err
    }
  }
  throw lastErr
}
