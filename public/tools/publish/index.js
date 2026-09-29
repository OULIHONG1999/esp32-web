#!/usr/bin/env node
/**
 * 固件发布 CLI（零依赖，平台无关 —— FIRMWARE-REGISTRY §5.1 / F-23）
 * 用法：
 *   node tools/publish once      [--config <path>] [--build-dir <path>] [--server <url>] [--release-id <id>]
 *   node tools/publish --watch   [--config <path>] [--build-dir <path>] [--server <url>]
 *                                [--interval <ms>] [--debounce <ms>]
 *   环境变量 FIRMWARE_PUBLISH_TOKEN 供 config 的 token 引用
 */
import { runOnce } from './once.js'
import { runWatch } from './watch.js'

function parseArgs(argv) {
  const out = {
    cmd: ['--watch', 'once', 'promote'].includes(argv[0]) ? argv[0] : (argv[0] ?? 'once'),
    config: 'publish.config.json',
    buildDir: null,
    server: null,
    releaseId: null,
    note: null,
    interval: null,
    debounce: null,
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') out.config = argv[++i]
    else if (a === '--build-dir') out.buildDir = argv[++i]
    else if (a === '--server') out.server = argv[++i]
    else if (a === '--release-id') out.releaseId = argv[++i]
    else if (a === '--note') out.note = argv[++i]
    else if (a === '--interval') out.interval = Number(argv[++i])
    else if (a === '--debounce') out.debounce = Number(argv[++i])
    else if (a === '--help' || a === '-h') out.help = true
    else if (!a.startsWith('-') && !out.releaseId) out.releaseId = a // promote <rid> 位置参数
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

function usage() {
  console.log(
    '用法:\n' +
      '  node tools/publish once [--config <path>] [--build-dir <path>] [--server <url>] [--release-id <id>]\n' +
      '  node tools/publish --watch [--config <path>] [--interval <ms>] [--debounce <ms>]\n' +
      '  node tools/publish promote <release-id> --note "发布说明" [--config <path>]\n' +
      '  环境变量 FIRMWARE_PUBLISH_TOKEN 供 config 引用',
  )
}

/** F-24：晋升 snapshot → release（自动按 registry 定位 variant） */
async function runPromote(args) {
  if (!args.releaseId) throw new Error('promote 需要 <release-id>')
  if (!args.note || !args.note.trim()) throw new Error('promote 需要 --note "发布说明"（必填）')
  const { cfg } = parseConfig(args.config)
  const server = (args.server ?? cfg.server).replace(/\/+$/, '')
  if (!cfg.token) throw new Error('publish token missing')

  const reg = await (await fetch(`${server}/api/registry`)).json()
  const variants = reg.projects?.[cfg.project.id]?.variants ?? {}
  let hit = null
  for (const [vid, v] of Object.entries(variants)) {
    if ((v.releases ?? []).some((r) => r.id === args.releaseId)) {
      hit = { vid, rel: v.releases.find((r) => r.id === args.releaseId) }
      break
    }
  }
  if (!hit) throw new Error(`release not found in registry: ${args.releaseId}`)
  if (hit.rel.type === 'release') throw new Error(`already a release: ${args.releaseId}`)

  const res = await fetch(
    `${server}/api/registry/projects/${cfg.project.id}/variants/${hit.vid}/releases/${args.releaseId}/promote`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ note: args.note }),
    },
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`promote → ${res.status} ${json.error ?? ''}`)
  console.log(`[publish] ✓ 已晋升 ${cfg.project.id}/${hit.vid}/${args.releaseId} → 发布版`)
  console.log(`[publish]   说明：${args.note}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.cmd === 'help') {
    usage()
    return
  }
  if (args.cmd === 'watch') {
    const ac = new AbortController()
    const onSigint = () => {
      console.log('\n[watch] 收到退出信号，停止…')
      ac.abort()
    }
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigint)
    await runWatch(args, {
      signal: ac.signal,
      intervalMs: Number.isFinite(args.interval) && args.interval ? args.interval : undefined,
      debounceMs: Number.isFinite(args.debounce) && args.debounce ? args.debounce : undefined,
    })
    return
  }
  if (args.cmd === 'promote') {
    await runPromote(args)
    return
  }
  if (args.cmd !== 'once') throw new Error(`unknown command: ${args.cmd}（支持 once / promote / --watch）`)
  await runOnce(args, { retries: 0 })
}

main().catch((err) => {
  console.error(`[publish] ✗ ${err.message}`)
  process.exitCode = 1
})
