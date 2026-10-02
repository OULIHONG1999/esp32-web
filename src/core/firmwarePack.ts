/**
 * 固件导出包文本生成（纯函数、零依赖、可单测）。
 * 产物随 zip 一起给用户：flash_args（esptool 直读）+ README（来源/参数/地址表/烧录指引）。
 */

export interface PackPart {
  address: number
  fileName: string
  label: string
  size: number
}

export type PackFlashParams =
  | {
      flashMode: string
      flashFreq: string
      flashSize: string
    }
  | null

export interface PackMeta {
  /** 来源（项目库版本或"手动选文件"） */
  source: string
  chipName: string | null
  exportedAt?: string
}

export function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/** esptool 可直读的 flash_args（参数未注入时省略选项行，走 esptool 默认） */
export function buildFlashArgsText(parts: PackPart[], fp: PackFlashParams): string {
  const lines: string[] = []
  if (fp) {
    lines.push(`--flash-mode ${fp.flashMode}`)
    lines.push(`--flash-freq ${fp.flashFreq}`)
    lines.push(`--flash-size ${fp.flashSize}`)
  }
  for (const p of parts) {
    lines.push(`0x${p.address.toString(16)} ${p.fileName}`)
  }
  return lines.join('\n') + '\n'
}

export function buildReadmeText(parts: PackPart[], fp: PackFlashParams, meta: PackMeta): string {
  const total = parts.reduce((n, p) => n + p.size, 0)
  const rows = parts
    .map(
      (p) =>
        `  0x${p.address.toString(16).padStart(4, '0')}  ${p.fileName.padEnd(28)} ${fmtSize(p.size).padStart(9)}  (${p.label})`,
    )
    .join('\n')
  const paramLine = fp
    ? `mode=${fp.flashMode}  freq=${fp.flashFreq}  size=${fp.flashSize}`
    : '（未注入——烧录时使用 esptool 默认参数）'
  return [
    'ESP32 Web Flasher 导出固件包',
    '='.repeat(40),
    `来源：${meta.source}`,
    `芯片：${meta.chipName ?? '未指定（烧录前请确认 chipFamily）'}`,
    `烧录参数：${paramLine}`,
    `导出时间：${meta.exportedAt ?? new Date().toISOString()}`,
    `段数：${parts.length}，合计 ${fmtSize(total)}`,
    '',
    '## 段清单（地址 / 文件 / 大小）',
    rows,
    '',
    '## 烧录方式',
    '方式一（esptool，推荐）：',
    '  pip install esptool',
    '  esptool.py --chip <芯片名> write_flash @flash_args',
    '方式二（逐段）：',
    `  esptool.py --chip <芯片名> write_flash ${parts.map((p) => `0x${p.address.toString(16)} ${p.fileName}`).join(' ')}`,
    '方式三（网页）：',
    '  打开本服务页面 → 手动添加本包中的 bin（地址已列于上表）→ 烧录',
    '',
    '注意：写错固件可能无法启动；届时按住 BOOT 键重进下载模式再烧。',
    '',
  ].join('\n')
}
