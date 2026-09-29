import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

/** 解析 flash_args：参数行（--flash-mode…）+ 段表（0x地址 相对路径） */
export function parseFlashArgs(text) {
  const lines = text.split(/\r?\n/)
  const paramLine = lines.find((l) => l.startsWith('--flash-mode')) ?? ''
  const flashParams = {
    mode: /--flash-mode\s+(\S+)/.exec(paramLine)?.[1] ?? 'dio',
    freq: /--flash-freq\s+(\S+)/.exec(paramLine)?.[1] ?? '40m',
    size: /--flash-size\s+(\S+)/.exec(paramLine)?.[1] ?? '4MB',
  }
  const entries = []
  for (const raw of lines) {
    const l = raw.trim()
    if (!/^0x[0-9a-fA-F]+\s+\S+/.test(l)) continue
    const [addr, rel] = l.split(/\s+/)
    entries.push({ address: parseInt(addr, 16), rel: rel.replace(/\//g, path.sep) })
  }
  if (entries.length === 0) throw new Error('flash_args: no address entries found')
  return { flashParams, entries }
}

/** ESP-IDF project_description.json 的 target → Variant 名（FIRMWARE-REGISTRY §4.1） */
export function variantFromTarget(target) {
  if (!target) return 'unknown'
  const t = String(target).toLowerCase()
  if (t === 'esp32') return 'ESP32'
  const m = /^esp32([a-z0-9]+)$/.exec(t)
  if (m) return `ESP32-${m[1].toUpperCase()}`
  return String(target).toUpperCase()
}

/** 展开 "${ENV_VAR}" 引用；未设置的环境变量原样报错 */
export function expandEnv(value) {
  if (typeof value !== 'string') return value
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
  if (!m) return value
  const v = process.env[m[1]]
  if (v === undefined) throw new Error(`environment variable not set: ${m[1]}`)
  return v
}

export function parseConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8')
  // 允许 // 注释（jsonc 风格，方便手写配置）
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '')
  const cfg = JSON.parse(stripped)
  if (!cfg.project?.id) throw new Error('publish.config: project.id required')
  if (!cfg.server) throw new Error('publish.config: server required')
  cfg.token = expandEnv(cfg.token)
  const dir = path.dirname(path.resolve(configPath))
  for (const list of [cfg.assets, ...Object.values(cfg.assetsByVariant ?? {})]) {
    for (const a of list ?? []) {
      if (typeof a.address === 'string') a.address = parseAddress(a.address)
    }
  }
  return { cfg, dir }
}

export function parseAddress(text) {
  const t = String(text).trim().toLowerCase()
  const n = t.startsWith('0x') ? parseInt(t, 16) : parseInt(t, 10)
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid address: ${text}`)
  return n
}

function guessLabel(rel) {
  const name = path.basename(rel)
  if (/partition/i.test(name)) return 'partition-table'
  if (/bootloader/i.test(name)) return 'bootloader'
  return name.replace(/\.bin$/i, '') || 'app'
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * 构建本地 parts 全集（flash_args 权威地址 + config 附加 assets）。
 * @returns {{ parts: Array<{label,address,file,sha256,size,data:Buffer}>, flashParams: object, variant: string }}
 */
export function buildParts({ cfg, dir, buildDir }) {
  const argsPath = path.join(buildDir, 'flash_args')
  if (!fs.existsSync(argsPath)) throw new Error(`flash_args not found: ${argsPath}`)
  const { flashParams, entries } = parseFlashArgs(fs.readFileSync(argsPath, 'utf8'))

  let variant = cfg.project.chipFamily ?? null
  const descPath = path.join(buildDir, 'project_description.json')
  if (fs.existsSync(descPath)) {
    try {
      const desc = JSON.parse(fs.readFileSync(descPath, 'utf8'))
      if (desc.target) variant = variantFromTarget(desc.target)
    } catch {
      /* 描述文件损坏时退回 config */
    }
  }
  if (!variant) variant = 'unknown'

  const parts = []
  for (const e of entries) {
    const abs = path.resolve(buildDir, e.rel)
    if (!abs.startsWith(path.resolve(buildDir) + path.sep)) {
      throw new Error(`flash_args entry escapes buildDir: ${e.rel}`)
    }
    if (!fs.existsSync(abs)) throw new Error(`build artifact missing: ${e.rel}`)
    const data = fs.readFileSync(abs)
    parts.push({
      label: guessLabel(e.rel),
      address: e.address,
      file: path.basename(e.rel),
      sha256: sha256(data),
      size: data.length,
      data,
    })
  }

  const assets = [...(cfg.assets ?? []), ...(cfg.assetsByVariant?.[variant] ?? [])]
  for (const a of assets) {
    const abs = path.resolve(dir, a.file)
    if (!fs.existsSync(abs)) throw new Error(`asset missing: ${a.file}`)
    const data = fs.readFileSync(abs)
    parts.push({
      label: a.label ?? path.basename(a.file),
      address: parseAddress(a.address),
      file: path.basename(a.file),
      sha256: sha256(data),
      size: data.length,
      data,
    })
  }

  return { parts, flashParams, variant }
}

/**
 * 查缺：
 * - 同 release（serverRelease）已有同 file 同 sha → 不传
 * - extraShaSet（S2 增量）：服务器同 project/variant 跨 release 已有的 sha 集合 → 不传
 */
export function pickMissing(localParts, serverRelease, extraShaSet) {
  const have = new Map((serverRelease?.parts ?? []).map((p) => [p.file, p.sha256]))
  return localParts.filter(
    (p) => have.get(p.file) !== p.sha256 && !(extraShaSet && extraShaSet.has(p.sha256)),
  )
}

/** 从 registry 收集某 project/variant 下全部 release 的 sha256 集合（增量查缺用） */
export function collectShaSet(registry, projectId, variant) {
  const rels = registry.projects?.[projectId]?.variants?.[variant]?.releases ?? []
  const set = new Set()
  for (const rel of rels) for (const p of rel.parts ?? []) set.add(p.sha256)
  return set
}

/** release id：YYYYMMDD-HHmm-<commit短哈希|随机4hex>（FIRMWARE-REGISTRY §4.1） */
export function releaseId(cwd = process.cwd()) {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const ts =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  let suffix
  try {
    suffix = execSync('git rev-parse --short=4 HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    suffix = crypto.randomBytes(2).toString('hex')
  }
  return `${ts}-${suffix}`
}

export function toMeta({ cfg, parts, flashParams, variant, id }) {
  return {
    project: {
      id: cfg.project.id,
      name: cfg.project.name ?? cfg.project.id,
      description: cfg.project.description ?? '',
    },
    variant,
    release: {
      id,
      type: 'snapshot',
      chipFamily: variant,
      flashParams,
      note: '',
      createdAt: new Date().toISOString(),
      parts: parts.map((p) => ({
        label: p.label,
        address: p.address,
        file: p.file,
        sha256: p.sha256,
        size: p.size,
      })),
    },
  }
}
