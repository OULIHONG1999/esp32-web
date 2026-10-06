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

// ---------- 分区类型元数据（F-22 增强：parts[].type / subType） ----------

/** ESP-IDF 分区子类型名（与 partition 表规范对齐；未知保留数字） */
const APP_SUBTYPES = { 0x00: 'factory' }
for (let i = 0; i < 16; i++) APP_SUBTYPES[0x10 + i] = `ota_${i}`
APP_SUBTYPES[0x20] = 'test'
const DATA_SUBTYPES = {
  0x01: 'otadata',
  0x02: 'nvs',
  0x03: 'phy_init',
  0x04: 'nvs_keys',
  0x05: 'efuse',
  0x81: 'fatfs',
  0x82: 'spiffs',
  0x83: 'littlefs',
}

/**
 * 解析 ESP-IDF partition-table.bin（32 字节/条，magic 0x50AA；尾部 0x50EB=MD5）。
 * 解析失败返回 []（前端/CLI 对缺失字段做缺省处理——向后兼容）。
 */
export function parsePartitionTable(bytes) {
  const out = []
  if (!bytes || bytes.length < 32) return out
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let off = 0; off + 32 <= bytes.length; off += 32) {
    const magic = dv.getUint16(off, true)
    if (magic === 0x50eb) break // MD5 结尾
    if (magic !== 0x50aa) continue
    const rawType = dv.getUint8(off + 2)
    const rawSub = dv.getUint8(off + 3)
    const offset = dv.getUint32(off + 4, true)
    const size = dv.getUint32(off + 8, true)
    const nameBytes = bytes.subarray(off + 12, off + 28)
    const end = nameBytes.indexOf(0)
    const name = new TextDecoder()
      .decode(end >= 0 ? nameBytes.subarray(0, end) : nameBytes)
      .trim()
    let type = null
    let subTypeName = null
    if (rawType === 0x00) {
      type = 'app'
      subTypeName = APP_SUBTYPES[rawSub] ?? String(rawSub)
    } else if (rawType === 0x01) {
      type = 'data'
      subTypeName = DATA_SUBTYPES[rawSub] ?? String(rawSub)
      // 兜底：subtype 未知但名字可辨识
      if (DATA_SUBTYPES[rawSub] === undefined && /littlefs|spiffs|fatfs/i.test(name)) {
        subTypeName = name.toLowerCase()
      }
    } else {
      continue // 0xFF 空槽
    }
    out.push({ offset, size, name, type, subType: subTypeName })
  }
  return out
}

/** 按烧录地址匹配分区条目（app/data 才有；bootloader/表不匹配属预期） */
export function findPartitionByAddress(entries, address) {
  return entries.find((e) => e.offset === address) ?? null
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
  // 先解析分区表（若有）→ 为匹配地址的段填 type/subType（F-22 增强）
  let partitionEntries = []
  const tableEntry = entries.find((e) => /partition/i.test(path.basename(e.rel)))
  if (tableEntry) {
    try {
      const tableAbs = path.resolve(buildDir, tableEntry.rel)
      if (fs.existsSync(tableAbs)) {
        partitionEntries = parsePartitionTable(fs.readFileSync(tableAbs))
      }
    } catch {
      /* 分区表异常不阻塞发布（type 缺省，前端兼容） */
    }
  }
  for (const e of entries) {
    const abs = path.resolve(buildDir, e.rel)
    if (!abs.startsWith(path.resolve(buildDir) + path.sep)) {
      throw new Error(`flash_args entry escapes buildDir: ${e.rel}`)
    }
    if (!fs.existsSync(abs)) throw new Error(`build artifact missing: ${e.rel}`)
    const data = fs.readFileSync(abs)
    const part = {
      label: guessLabel(e.rel),
      address: e.address,
      file: path.basename(e.rel),
      sha256: sha256(data),
      size: data.length,
      data,
    }
    const hit = findPartitionByAddress(partitionEntries, e.address)
    if (hit) {
      part.type = hit.type
      part.subType = hit.subType
    }
    parts.push(part)
  }

  const assets = [...(cfg.assets ?? []), ...(cfg.assetsByVariant?.[variant] ?? [])]
  for (const a of assets) {
    const abs = path.resolve(dir, a.file)
    if (!fs.existsSync(abs)) throw new Error(`asset missing: ${a.file}`)
    const data = fs.readFileSync(abs)
    const part = {
      label: a.label ?? path.basename(a.file),
      address: parseAddress(a.address),
      file: path.basename(a.file),
      sha256: sha256(data),
      size: data.length,
      data,
    }
    // config 可显式声明分区类型（未声明时按地址查分区表兜底）
    if (a.type) part.type = a.type
    if (a.subType) part.subType = a.subType
    if (!part.type) {
      const hit = findPartitionByAddress(partitionEntries, part.address)
      if (hit) {
        part.type = hit.type
        part.subType = hit.subType
      }
    }
    parts.push(part)
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

/** release id：YYYYMMDD-HHmmss-<commit短哈希|随机4hex>（时间到秒，突出可读时间） */
export function releaseId(cwd = process.cwd()) {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const ts =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
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
        // 分区类型元数据（F-22 增强；undefined 不序列化，旧消费方缺省兼容）
        ...(p.type ? { type: p.type } : {}),
        ...(p.subType ? { subType: p.subType } : {}),
      })),
    },
  }
}
