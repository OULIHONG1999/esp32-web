import crypto from 'node:crypto'

/**
 * 设备模拟器纯逻辑（零依赖，可单测）。
 * CLI 见同目录 index.js；用法与背景见 docs/DEVICE-OTA.md。
 */

/** 由任意种子稳定派生 12 位小写十六进制 deviceId（同一 seed → 同一台"设备"） */
export function deviceIdFromSeed(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 12)
}

/** 12 位 hex → 冒号分隔 MAC（展示用） */
export function formatMac(deviceId) {
  return /^[0-9a-f]{12}$/.test(deviceId) ? deviceId.match(/.{2}/g).join(':') : String(deviceId)
}

/** 构造 report 请求体（模拟设备真实会报的字段） */
export function buildReportBody({
  chip,
  firmwareVersion,
  sdkVersion,
  ip,
  uptimeMs,
  freeHeap,
  psramFree,
} = {}) {
  const body = {
    chip: chip || 'ESP32-S3',
    firmwareVersion: firmwareVersion || 'v0.0.0-sim',
    sdkVersion: sdkVersion || 'v6.0.1',
    uptimeMs: Math.max(0, Math.round(Number(uptimeMs) || 0)),
    freeHeap: freeHeap ?? 230000,
    psramFree: psramFree ?? 4000000,
  }
  if (ip) body.ip = ip
  return body
}

/**
 * 回执判定：sha256 不匹配必失败（这是设备端真实会做的校验）；
 * 否则按 failRate 概率性失败（用于演练 failed 分支）。
 */
export function decideAck({ shaMatch, failRate = 0, random = Math.random }) {
  if (shaMatch === false) return { state: 'failed', reason: 'sha256 mismatch' }
  if (failRate > 0 && random() < failRate) return { state: 'failed', reason: 'simulated failure' }
  return { state: 'success', reason: 'OTA ok' }
}

/**
 * CLI 参数解析（不认识就抛错，避免静默跑成默认值）。
 * 用法见 docs/DEVICE-OTA.md §8。
 */
export function parseArgs(argv) {
  const out = {
    server: 'http://127.0.0.1:8787',
    devices: 1,
    interval: 15,
    failRate: 0,
    chip: 'ESP32-S3',
    version: 'v0.6.0-sim',
    sdkVersion: 'v6.0.1',
    ids: [],
    once: false,
    dryRun: false,
    timeout: 30,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} 需要一个值`)
      return v
    }
    if (a === '--server') out.server = next().replace(/\/+$/, '')
    else if (a === '--devices') out.devices = num(next(), a, { min: 1, max: 50 })
    else if (a === '--interval') out.interval = num(next(), a, { min: 1, max: 3600 })
    else if (a === '--fail-rate') out.failRate = num(next(), a, { min: 0, max: 1 })
    else if (a === '--timeout') out.timeout = num(next(), a, { min: 1, max: 600 })
    else if (a === '--chip') out.chip = next()
    else if (a === '--version') out.version = next()
    else if (a === '--sdk-version') out.sdkVersion = next()
    else if (a === '--id') out.ids.push(next())
    else if (a === '--once') out.once = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  // --id 优先；否则按序号派生稳定 deviceId
  if (out.ids.length) out.devices = out.ids.length
  return out
}

function num(raw, flag, { min, max }) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${flag} 需为 ${min}~${max} 的数字，收到 ${raw}`)
  }
  return n
}

/** 待模拟设备清单 */
export function buildDevices(opts) {
  if (opts.ids.length) return opts.ids.map((id, i) => ({ id, seed: id, index: i }))
  return Array.from({ length: opts.devices }, (_, i) => ({
    id: deviceIdFromSeed(`device-sim-${i + 1}`),
    seed: `device-sim-${i + 1}`,
    index: i,
  }))
}

export const HELP = `
设备模拟器 — 假装成 ESP32 跑通 OTA 全链路（零依赖，Node 18+）

  node tools/device-sim/index.js [选项]

选项
  --server <url>      服务器地址（默认 http://127.0.0.1:8787）
  --devices <n>       模拟几台设备（默认 1，上限 50）
  --id <hex12>        指定 deviceId（可重复；给了 --id 则忽略 --devices）
  --interval <秒>     上报间隔（默认 15；服务端 45s 判离线）
  --version <字符串>  初始固件版本（默认 v0.6.0-sim）
  --chip <字符串>     芯片名（默认 ESP32-S3）
  --sdk-version <s>   SDK 版本（默认 v6.0.1）
  --fail-rate <0..1>  回执失败概率（默认 0，用于演练 failed 分支）
  --dry-run           只上报、不取命令、不回执（用于观察 pending→delivered 与重投递）
  --once              每台设备上报一次即退出（冒烟用）
  --timeout <秒>      单次请求超时（默认 30）
  -h, --help          显示本帮助

示例
  node tools/device-sim/index.js --once
  node tools/device-sim/index.js --devices 3 --interval 5
  node tools/device-sim/index.js --server http://firmware.example.com --id 3485a1b2c3d4
`
