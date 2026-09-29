import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseConfig, parseFlashArgs } from './lib.js'
import { runOnce } from './once.js'

/**
 * 发布输入签名（EXECUTION-REGISTRY §9：发布输入 = 项目信息 + bin）：
 * flash_args + 其引用产物 + project_description + config.assets 的 (相对路径,size,mtime) 聚合。
 * 只盯发布输入而非全 build 目录——cmake 中间文件变化不触发发布。
 */
export function makeBuildSignature(buildDir, cfg, configDir) {
  const files = ['flash_args', 'project_description.json']
  const argsPath = path.join(buildDir, 'flash_args')
  if (fs.existsSync(argsPath)) {
    try {
      const { entries } = parseFlashArgs(fs.readFileSync(argsPath, 'utf8'))
      files.push(...entries.map((e) => e.rel))
    } catch {
      /* flash_args 损坏时仍按现有文件签，等它修好自然触发 */
    }
  }
  const absFiles = [
    ...files.map((f) => path.resolve(buildDir, f)),
    ...(cfg.assets ?? []).map((a) => path.resolve(configDir, a.file)),
  ]
  const h = crypto.createHash('sha256')
  for (const abs of absFiles) {
    h.update(abs)
    try {
      const st = fs.statSync(abs)
      h.update(`${st.size}:${st.mtimeMs}`)
    } catch {
      h.update('missing')
    }
  }
  return h.digest('hex').slice(0, 16)
}

/**
 * `publish --watch`：轮询签名 → 防抖静默 → 自动发布（网络失败退避重试 3 次，
 * 未成功则签名保持 pending，下轮补传——EXECUTION-PLAN 风险表）。
 * 停止条件由外部 AbortSignal 控制（测试注入短周期）。
 */
export async function runWatch(args, opts = {}) {
  const intervalMs = opts.intervalMs ?? 5000
  const debounceMs = opts.debounceMs ?? 5000
  const signal = opts.signal
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const log = opts.log ?? console.log

  const { cfg, dir } = parseConfig(args.config)
  const buildDir = path.resolve(args.buildDir ?? cfg.buildDir ?? path.join(dir, 'build'))

  let lastSig = null
  let publishedSig = null
  let lastChangeAt = 0
  let started = false // 首轮立即发布，其后进入防抖

  log(`[watch] 盯 ${buildDir}（interval=${intervalMs}ms debounce=${debounceMs}ms）`)

  while (!signal?.aborted) {
    const sig = makeBuildSignature(buildDir, cfg, dir)
    const now = Date.now()
    if (sig !== lastSig) {
      lastSig = sig
      lastChangeAt = now
    }
    const debounceOk = started || now - lastChangeAt >= debounceMs
    const shouldPublish = sig !== publishedSig && debounceOk
    if (shouldPublish) {
      started = true
      try {
        // 每轮重新读 config（token/工程信息可热改）；网络失败退避 3 次
        await runOnce({ ...args, releaseId: null, config: args.config }, {
          retries: opts.retries ?? 3,
        })
        publishedSig = sig
        log('[watch] ✓ 本轮发布成功')
      } catch (err) {
        log(`[watch] ✗ 发布失败（${err.message}），保留待传，下轮重试`)
        // publishedSig 不更新 → 下轮继续尝试（失败保留本地标记语义）
        await sleep(intervalMs)
        continue
      }
    }
    await sleep(intervalMs)
  }
  log('[watch] 已停止')
}
