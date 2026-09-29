import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 动态工作 token（FIRMWARE-REGISTRY §8 扩展 · 2026-09-29）：
 * - 主 token = 环境变量 FIRMWARE_PUBLISH_TOKEN（永不失效，唯一可"生成"新 token 的凭证）
 * - 工作 token = 页面/CLI 生成后分发给发布端或 AI（可撤销，持久化 tokens.json）
 */
function tokensPath(dataDir) {
  return path.join(dataDir, 'tokens.json')
}

export function readTokens(dataDir) {
  try {
    const v = JSON.parse(fs.readFileSync(tokensPath(dataDir), 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function writeTokens(dataDir, list) {
  fs.mkdirSync(dataDir, { recursive: true })
  const tmp = tokensPath(dataDir) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
  fs.renameSync(tmp, tokensPath(dataDir))
}

/** 生成工作 token（32 字节 hex，前缀便于识别来源）；note 用途备注 */
export function createToken(dataDir, note) {
  const token = 'wk_' + crypto.randomBytes(24).toString('hex')
  const list = readTokens(dataDir)
  const entry = {
    token,
    note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 64) : '',
    createdAt: new Date().toISOString(),
  }
  list.push(entry)
  writeTokens(dataDir, list)
  return entry
}

/** 撤销（按完整 token 值删除）；返回是否删到 */
export function revokeToken(dataDir, token) {
  const list = readTokens(dataDir)
  const next = list.filter((t) => t.token !== token)
  const removed = next.length !== list.length
  if (removed) writeTokens(dataDir, next)
  return removed
}

/** 列表（不含完整 token？—— 单用户自用：含，方便页面核对；撤销需要值） */
export function listTokens(dataDir) {
  return readTokens(dataDir).map((t) => ({ ...t }))
}

/** 任一有效：主 token 或动态列表 */
export function isValidToken(dataDir, presented, masterToken) {
  if (!presented) return false
  if (presented === masterToken) return true
  return readTokens(dataDir).some((t) => t.token === presented)
}

/** 仅主 token 可管理（生成/撤销） */
export function isMasterToken(presented, masterToken) {
  return !!presented && presented === masterToken
}
