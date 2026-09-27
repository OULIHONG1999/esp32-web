/**
 * S1 本地端到端（门2 自动部分）：
 * 真实 server（http listen）← spawn CLI once ← fixtures 假构建
 * 覆盖：发布 → registry 可见 → parts 下载字节一致 → flashParams 随快照 → 幂等补传 0 上传 → 错 token 拒收
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../server/app.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.join(root, 'tests', 'fixtures', 'publish.config.json')
const buildDir = path.join(root, 'tests', 'fixtures', 'fake-build')
const TOKEN = 'e2e-token'

let dataDir
let server
let base

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'tools', 'publish', 'index.js'), ...args], {
      cwd: root,
      env: { ...process.env, FIRMWARE_PUBLISH_TOKEN: TOKEN, ...env },
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
  })
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-e2e-'))
  server = http.createServer(createApp({ dataDir, token: TOKEN, distDir: path.join(dataDir, 'no-dist') }))
  await new Promise((r) => server.listen(0, r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(() => {
  server.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('S1 端到端：publish once → registry → 下载', () => {
  const RID = '20260927-1500-e2e1'

  it('CLI 发布 fixtures → exit 0，日志含已发布', async () => {
    const { code, out } = await runCli([
      'once',
      '--config', configPath,
      '--build-dir', buildDir,
      '--server', base,
      '--release-id', RID,
    ])
    expect(out).not.toMatch(/✗/)
    expect(code).toBe(0)
    expect(out).toContain('已发布 hello-world/ESP32-S3/' + RID)
    expect(out).toContain('parts=4') // flash_args 三段 + font asset
  }, 15_000)

  it('registry 可见 latest、flashParams 随快照、4 parts 完整', async () => {
    const reg = await (await fetch(`${base}/api/registry`)).json()
    const v = reg.projects['hello-world'].variants['ESP32-S3']
    expect(v.latest).toBe(RID)
    const rel = v.releases.find((r) => r.id === RID)
    expect(rel.flashParams).toEqual({ mode: 'dio', freq: '40m', size: '16MB' })
    expect(rel.parts.map((p) => p.file)).toEqual([
      'bootloader.bin', 'partition-table.bin', 'hello_world.bin', 'font.bin',
    ])
    expect(rel.parts.find((p) => p.file === 'font.bin').address).toBe(0x290000)
  })

  it('下载的每个 part 字节与本地 fixtures 一致（SHA256 同源）', async () => {
    const cases = [
      ['bootloader/bootloader.bin', 'bootloader.bin'],
      ['partition_table/partition-table.bin', 'partition-table.bin'],
      ['hello_world.bin', 'hello_world.bin'],
      ['../assets/font.bin', 'font.bin'],
    ]
    for (const [rel, served] of cases) {
      const local = fs.readFileSync(path.join(buildDir, rel))
      const res = await fetch(
        `${base}/api/registry/projects/hello-world/variants/ESP32-S3/releases/${RID}/parts/${served}`,
      )
      expect(res.status).toBe(200)
      const remote = Buffer.from(await res.arrayBuffer())
      expect(sha(remote)).toBe(sha(local))
    }
  })

  it('幂等补传：同 release-id 重发 → 0 上传仍成功，registry 无重复条目', async () => {
    const { code, out } = await runCli([
      'once',
      '--config', configPath,
      '--build-dir', buildDir,
      '--server', base,
      '--release-id', RID,
    ])
    expect(code).toBe(0)
    expect(out).toContain('上传=0')
    const reg = await (await fetch(`${base}/api/registry`)).json()
    const rels = reg.projects['hello-world'].variants['ESP32-S3'].releases.filter((r) => r.id === RID)
    expect(rels).toHaveLength(1)
  }, 15_000)

  it('错 token → CLI exit 1 且服务器 registry 不变', async () => {
    const before = await (await fetch(`${base}/api/registry`)).text()
    const { code, out } = await runCli(
      ['once', '--config', configPath, '--build-dir', buildDir, '--server', base, '--release-id', '20260927-1600-bad1'],
      { FIRMWARE_PUBLISH_TOKEN: 'wrong-token' },
    )
    expect(code).toBe(1)
    expect(out).toContain('401')
    expect(await (await fetch(`${base}/api/registry`)).text()).toBe(before)
  }, 15_000)
})
