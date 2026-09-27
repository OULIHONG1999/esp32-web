#!/usr/bin/env node
/**
 * 固件发布 CLI（零依赖，平台无关 —— FIRMWARE-REGISTRY §5.1 / F-23）
 * 用法：
 *   node tools/publish once [--config <path>] [--build-dir <path>] [--server <url>]
 *   环境变量 FIRMWARE_PUBLISH_TOKEN 供 config 的 token 引用
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildParts, parseConfig, pickMissing, releaseId, toMeta } from './lib.js'

function parseArgs(argv) {
  const out = {
    cmd: argv[0] ?? 'once',
    config: 'publish.config.json',
    buildDir: null,
    server: null,
    releaseId: null,
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') out.config = argv[++i]
    else if (a === '--build-dir') out.buildDir = argv[++i]
    else if (a === '--server') out.server = argv[++i]
    else if (a === '--release-id') out.releaseId = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

async function once(args) {
  const { cfg, dir } = parseConfig(args.config)
  const buildDir = path.resolve(
    args.buildDir ?? cfg.buildDir ?? path.join(dir, 'build'),
  )
  const server = (args.server ?? cfg.server).replace(/\/+$/, '')
  if (!cfg.token) throw new Error('publish token missing (config token 或 FIRMWARE_PUBLISH_TOKEN)')

  const { parts, flashParams, variant } = buildParts({ cfg, dir, buildDir })
  const id = args.releaseId ?? releaseId(dir)
  const meta = toMeta({ cfg, parts, flashParams, variant, id })

  // ---- 查缺：GET registry → 同 project/variant 已有 release 的 parts 差集 ----
  const regRes = await fetch(`${server}/api/registry`)
  if (!regRes.ok) throw new Error(`GET /api/registry → ${regRes.status}`)
  const registry = await regRes.json()
  const serverRelease =
    registry.projects?.[cfg.project.id]?.variants?.[variant]?.releases?.find((r) => r.id === id) ?? null
  const missing = pickMissing(parts, serverRelease)

  console.log(`[publish] project=${cfg.project.id} variant=${variant} release=${id}`)
  console.log(`[publish] parts=${parts.length} 上传=${missing.length}${missing.length ? `（${missing.map((p) => p.file).join(', ')}）` : '（服务器已有，秒回）'} `)

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
  console.log(`[publish] 下载地址：${server}/api/registry`)
  return json
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.cmd === 'help') {
    console.log('用法: node tools/publish once [--config publish.config.json] [--build-dir <path>] [--server <url>] [--release-id <id>]')
    return
  }
  if (args.cmd !== 'once') throw new Error(`unknown command: ${args.cmd}（S1 仅支持 once）`)
  await once(args)
}

main().catch((err) => {
  console.error(`[publish] ✗ ${err.message}`)
  process.exitCode = 1
})
