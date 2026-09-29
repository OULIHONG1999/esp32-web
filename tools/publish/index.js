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
    cmd: argv[0] === '--watch' ? 'watch' : (argv[0] ?? 'once'),
    config: 'publish.config.json',
    buildDir: null,
    server: null,
    releaseId: null,
    interval: null,
    debounce: null,
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') out.config = argv[++i]
    else if (a === '--build-dir') out.buildDir = argv[++i]
    else if (a === '--server') out.server = argv[++i]
    else if (a === '--release-id') out.releaseId = argv[++i]
    else if (a === '--interval') out.interval = Number(argv[++i])
    else if (a === '--debounce') out.debounce = Number(argv[++i])
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

function usage() {
  console.log(
    '用法:\n' +
      '  node tools/publish once [--config <path>] [--build-dir <path>] [--server <url>] [--release-id <id>]\n' +
      '  node tools/publish --watch [--config <path>] [--build-dir <path>] [--server <url>]\n' +
      '           [--interval <ms>] [--debounce <ms>]',
  )
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
  if (args.cmd !== 'once') throw new Error(`unknown command: ${args.cmd}（支持 once / --watch）`)
  await runOnce(args, { retries: 0 })
}

main().catch((err) => {
  console.error(`[publish] ✗ ${err.message}`)
  process.exitCode = 1
})
