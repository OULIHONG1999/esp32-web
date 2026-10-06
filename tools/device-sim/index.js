#!/usr/bin/env node
/**
 * 设备模拟器 —— 假装成一台 ESP32，把 OTA 全链路跑一遍：
 *   report 心跳（兼取命令） → 下载 app 固件 → 校验 sha256 → 回执 success/failed
 *
 * 为什么需要它：服务器端与设备端可以由两台电脑/两个 AI 并行开发，
 * 有了它，任何一端都能在没有硬件的情况下把契约验证到底（含失败分支）。
 *
 * 零依赖（只用 Node 内置 fetch / crypto），Node 18+。
 * 参数说明与联调步骤见 docs/DEVICE-OTA.md §8。
 */
import crypto from 'node:crypto'
import { HELP, buildDevices, buildReportBody, decideAck, formatMac, parseArgs } from './lib.js'

let opts
try {
  opts = parseArgs(process.argv.slice(2))
} catch (err) {
  console.error(`参数错误：${err.message}\n运行 node tools/device-sim/index.js --help 查看用法`)
  process.exit(2)
}
if (opts.help) {
  console.log(HELP)
  process.exit(0)
}

const devices = buildDevices(opts)
const startedAt = Date.now()
const stats = { success: 0, failed: 0, reports: 0, errors: 0 }
let stopping = false

process.on('SIGINT', () => {
  stopping = true
  log('收到中断信号，正在退出…')
})

function log(msg) {
  const t = new Date().toISOString().slice(11, 19)
  console.log(`${t}  ${msg}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 单次请求（带超时；非 2xx 抛错并带上服务端 error 文案） */
async function req(path, { method = 'GET', body } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeout * 1000)
  try {
    const res = await fetch(opts.server + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) {
      const err = new Error(json?.error || `HTTP ${res.status}`)
      err.status = res.status
      err.json = json
      throw err
    }
    return json
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`请求超时（${opts.timeout}s）`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function download(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeout * 1000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`下载超时（${opts.timeout}s）`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** 取到命令后的动作：下载 → 校验 → 回执（模拟真实设备） */
async function handleCommand(dev, cmd) {
  const tag = formatMac(dev.id)
  const url = cmd.urlAbsolute || opts.server + cmd.url
  log(`${tag}    ← 命令 ${cmd.id} · release=${cmd.releaseId} · ${cmd.file ?? '?'} · ${cmd.size ?? '?'}B`)

  let shaMatch = null
  let failReason = ''
  try {
    const buf = await download(url)
    const sha = crypto.createHash('sha256').update(buf).digest('hex')
    shaMatch = !cmd.sha256 || sha === cmd.sha256
    log(`${tag}      下载 ${buf.length} 字节 · sha256 ${shaMatch ? '匹配' : `不匹配（期望 ${String(cmd.sha256).slice(0, 12)}… 实得 ${sha.slice(0, 12)}…）`}`)
  } catch (err) {
    shaMatch = false
    failReason = `download failed: ${err.message}`
    log(`${tag}      下载失败：${err.message}`)
  }

  const decision = failReason ? { state: 'failed', reason: failReason } : decideAck({ shaMatch, failRate: opts.failRate })
  try {
    await req(`/api/devices/${dev.id}/commands/${cmd.id}/result`, {
      method: 'POST',
      body: { state: decision.state, detail: decision.reason },
    })
  } catch (err) {
    stats.errors++
    log(`${tag}      回执发送失败：${err.message}`)
    return
  }
  if (decision.state === 'success') {
    stats.success++
    dev.version = cmd.releaseId // 模拟"重启后跑在新固件上"
    log(`${tag}      回执 success · 重启后固件版本 → ${cmd.releaseId}`)
  } else {
    stats.failed++
    log(`${tag}      回执 failed · ${decision.reason}`)
  }
}

/** 一台设备的一轮：上报（兼心跳，响应里带命令）→ 有命令则处理 */
async function cycle(dev) {
  const tag = formatMac(dev.id)
  let res
  try {
    res = await req(`/api/devices/${dev.id}/report`, {
      method: 'POST',
      body: buildReportBody({
        chip: opts.chip,
        firmwareVersion: dev.version,
        sdkVersion: opts.sdkVersion,
        uptimeMs: Date.now() - startedAt,
      }),
    })
  } catch (err) {
    stats.errors++
    log(`${tag}  上报失败：${err.message}`)
    return
  }
  stats.reports++
  const cmd = res?.command ?? null
  log(
    `${tag}  上报 ok · 固件 ${dev.version} · ${cmd ? `收到命令 ${cmd.id}` : '无命令'}` +
      (res?.redelivered ? '（重复投递）' : ''),
  )
  if (!cmd) return
  if (opts.dryRun) {
    log(`${tag}      dry-run：不下载、不回执（命令保持 delivered，用于观察重投递）`)
    return
  }
  await handleCommand(dev, cmd)
}

async function main() {
  for (const d of devices) d.version = opts.version
  log(`目标服务器 ${opts.server}`)
  log(`模拟 ${devices.length} 台设备：${devices.map((d) => formatMac(d.id)).join(', ')}`)
  if (opts.dryRun) log('dry-run 模式：只上报，不下载/不回执')

  let round = 0
  for (;;) {
    round++
    if (!opts.once && round > 1) log(`—— 第 ${round} 轮 ——`)
    for (const dev of devices) {
      if (stopping) break
      await cycle(dev)
    }
    if (opts.once || stopping) break
    await sleep(opts.interval * 1000)
  }

  log(
    `退出：上报 ${stats.reports} 次 · OTA 成功 ${stats.success} · 失败 ${stats.failed} · 请求出错 ${stats.errors}`,
  )
  process.exitCode = stats.errors > 0 && stats.reports === 0 ? 1 : 0
}

main().catch((err) => {
  console.error(`模拟器异常：${err.message}`)
  process.exit(1)
})
