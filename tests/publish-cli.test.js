import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildParts,
  collectShaSet,
  parseAddress,
  parseConfig,
  parseFlashArgs,
  pickMissing,
  releaseId,
  toMeta,
  variantFromTarget,
} from '../tools/publish/lib.js'

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const configPath = path.join(fixtures, 'publish.config.json')

describe('parseFlashArgs（IDF flash_args 解析）', () => {
  it('参数行 + 段表解析，地址为 number', () => {
    const text = [
      '--flash-mode dio --flash-freq 40m --flash-size 16MB',
      '0x0 bootloader/bootloader.bin',
      '0x8000 partition_table/partition-table.bin',
      '0x10000 hello_world.bin',
    ].join('\n')
    const { flashParams, entries } = parseFlashArgs(text)
    expect(flashParams).toEqual({ mode: 'dio', freq: '40m', size: '16MB' })
    expect(entries).toHaveLength(3)
    expect(entries[0].address).toBe(0x0)
    expect(entries[2].address).toBe(0x10000)
  })

  it('无段表 → 抛错', () => {
    expect(() => parseFlashArgs('--flash-mode dio\n')).toThrow(/no address/)
  })
})

describe('variantFromTarget（多芯片归类 F-20）', () => {
  it.each([
    ['esp32s3', 'ESP32-S3'],
    ['esp32c3', 'ESP32-C3'],
    ['esp32', 'ESP32'],
    ['esp32h2', 'ESP32-H2'],
    [undefined, 'unknown'],
  ])('%s → %s', (target, want) => {
    expect(variantFromTarget(target)).toBe(want)
  })
})

describe('parseConfig', () => {
  it('${ENV} 展开 + assets 地址 hex → number + buildDir 定位', () => {
    process.env.FIRMWARE_PUBLISH_TOKEN = 'tok-123'
    const { cfg, dir } = parseConfig(configPath)
    expect(cfg.token).toBe('tok-123')
    expect(cfg.assets[0].address).toBe(0x290000)
    expect(dir).toBe(fixtures)
    delete process.env.FIRMWARE_PUBLISH_TOKEN
  })

  it('环境变量未设置 → 抛错（防 token 落空）', () => {
    delete process.env.FIRMWARE_PUBLISH_TOKEN
    expect(() => parseConfig(configPath)).toThrow(/FIRMWARE_PUBLISH_TOKEN/)
  })
})

describe('buildParts（fixtures 全集）', () => {
  it('flash_args 三段 + config 附加 font 共 4 parts；flashParams/variant 正确', () => {
    process.env.FIRMWARE_PUBLISH_TOKEN = 'tok-123'
    const { cfg, dir } = parseConfig(configPath)
    const buildDir = path.join(dir, cfg.buildDir)
    const { parts, flashParams, variant } = buildParts({ cfg, dir, buildDir })
    expect(variant).toBe('ESP32-S3')
    expect(flashParams).toEqual({ mode: 'dio', freq: '40m', size: '16MB' })
    expect(parts.map((p) => p.file)).toEqual([
      'bootloader.bin',
      'partition-table.bin',
      'hello_world.bin',
      'font.bin',
    ])
    expect(parts[0].address).toBe(0x0)
    expect(parts[1].label).toBe('partition-table')
    expect(parts[3].address).toBe(0x290000)
    expect(parts.every((p) => /^[0-9a-f]{64}$/.test(p.sha256))).toBe(true)
    delete process.env.FIRMWARE_PUBLISH_TOKEN
  })
})

describe('pickMissing（查缺差集）', () => {
  const a = { file: 'a.bin', sha256: 'aa'.repeat(32), data: Buffer.alloc(0) }
  const b = { file: 'b.bin', sha256: 'bb'.repeat(32), data: Buffer.alloc(0) }

  it('服务器无该 release → 全量上传', () => {
    expect(pickMissing([a, b], null)).toHaveLength(2)
  })

  it('服务器已有同 sha → 不传；sha 变了 → 传', () => {
    const server = { parts: [{ file: 'a.bin', sha256: a.sha256 }] }
    const missing = pickMissing([a, b], server)
    expect(missing.map((p) => p.file)).toEqual(['b.bin'])
  })

  it('同名但 sha 不同 → 重传（覆盖）', () => {
    const server = { parts: [{ file: 'a.bin', sha256: 'cc'.repeat(32) }] }
    expect(pickMissing([a], server)).toHaveLength(1)
  })

  it('extraShaSet（S2 跨 release 增量）：服务器别处已有同 sha → 不传', () => {
    const shaSet = new Set([b.sha256])
    const missing = pickMissing([a, b], null, shaSet)
    expect(missing.map((p) => p.file)).toEqual(['a.bin'])
  })

  it('collectShaSet 聚合 variant 下全部 release 的 sha', () => {
    const registry = {
      projects: {
        p: {
          variants: {
            V: {
              releases: [
                { id: 'r1', parts: [{ file: 'x.bin', sha256: 'aa'.repeat(32) }] },
                { id: 'r2', parts: [{ file: 'y.bin', sha256: 'bb'.repeat(32) }] },
              ],
            },
          },
        },
      },
    }
    const set = collectShaSet(registry, 'p', 'V')
    expect(set.has('aa'.repeat(32))).toBe(true)
    expect(set.has('bb'.repeat(32))).toBe(true)
    expect(collectShaSet(registry, 'nope', 'V').size).toBe(0)
  })
})

describe('releaseId / toMeta / parseAddress', () => {
  it('releaseId 形如 YYYYMMDD-HHmm-xxxx', () => {
    expect(releaseId()).toMatch(/^\d{8}-\d{4}-[0-9a-f]{4,}$/)
  })

  it('toMeta 结构符合数据模型 v3（parts 仅元数据）', () => {
    const cfg = { project: { id: 'p', name: 'P', description: '' } }
    const meta = toMeta({
      cfg,
      parts: [{ label: 'app', address: 0x10000, file: 'a.bin', sha256: 'd'.repeat(64), size: 9, data: Buffer.alloc(9) }],
      flashParams: { mode: 'dio', freq: '40m', size: '4MB' },
      variant: 'ESP32-S3',
      id: '20260927-1000-aaaa',
    })
    expect(meta.release.id).toBe('20260927-1000-aaaa')
    expect(meta.release.chipFamily).toBe('ESP32-S3')
    expect(meta.release.flashParams.mode).toBe('dio')
    expect(meta.release.parts[0]).toEqual({
      label: 'app', address: 0x10000, file: 'a.bin', sha256: 'd'.repeat(64), size: 9,
    })
    expect(meta.release.parts[0].data).toBeUndefined()
  })

  it('parseAddress 接受 0x 与十进制，拒绝垃圾', () => {
    expect(parseAddress('0x290000')).toBe(0x290000)
    expect(parseAddress('10000')).toBe(10000)
    expect(() => parseAddress('zz')).toThrow(/invalid address/)
  })
})
