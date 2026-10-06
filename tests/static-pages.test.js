import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../server/app.js'

// 独立页 /OTA 的静态托管：模拟 build（public/ → dist/）后验证真实产物可被访问。
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let dataDir
let server
let base

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-static-'))
  const dist = path.join(dataDir, 'dist')
  fs.mkdirSync(dist, { recursive: true })
  // 只拷与独立页相关的产物（等价 build 的 public/ → dist/ 拷贝）
  fs.cpSync(path.join(repo, 'public', 'ota'), path.join(dist, 'ota'), { recursive: true })
  fs.cpSync(path.join(repo, 'public', 'docs'), path.join(dist, 'docs'), { recursive: true })
  for (const f of ['ota.json', 'llms.txt']) fs.copyFileSync(path.join(repo, 'public', f), path.join(dist, f))
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>SPA-FALLBACK</title>')
  server = http.createServer(createApp({ dataDir, token: 't', distDir: dist }))
  await new Promise((r) => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => {
  server.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('独立页 /OTA 静态托管', () => {
  // 大小写与尾斜杠归一：/OTA 与 /ota/ 等价
  for (const p of ['/OTA', '/ota', '/ota/', '/OTA/', '/ota/index.html']) {
    it(`${p} → 200 且返回 OTA 页面`, async () => {
      const res = await fetch(base + p)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain('OTA Console')
      expect(html).toContain('/ota/ota.css')
    })
  }

  it('页面资源与 AI 入口可达（css/js/json/md）', async () => {
    const cases = [
      ['/ota/ota.css', 'text/css'],
      ['/OTA/ota.js', 'javascript'],
      ['/ota.json', 'application/json'],
      ['/docs/ota.md', 'text/markdown'],
      ['/llms.txt', 'text/plain'],
    ]
    for (const [p, type] of cases) {
      const res = await fetch(base + p)
      expect(res.status, p).toBe(200)
      expect(res.headers.get('content-type'), p).toContain(type)
    }
    const descriptor = await (await fetch(base + '/ota.json')).json()
    expect(descriptor.tool_id).toBe('ota-console')
    expect(descriptor.canonical_path).toBe('/OTA')
  })

  it('未知路由 → SPA 兜底 index.html（不影响主站）', async () => {
    const res = await fetch(base + '/some/spa/route')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('SPA-FALLBACK')
  })

  // 回归守卫：/OTA 下发是写操作、必须带 Bearer——曾因漏接线而只能 401。
  // 页面无法在无浏览器环境端到端单测，这里守住「接线存在」这条底线。
  it('/OTA 页具备下发鉴权接线（token 输入 + Authorization 头）', async () => {
    const html = await (await fetch(base + '/OTA')).text()
    expect(html).toContain('id="dToken"')
    expect(html).toContain('id="dForce"')
    expect(html).toContain('id="tokenState"')
    const js = await (await fetch(base + '/ota/ota.js')).text()
    expect(js).toContain('Authorization')
    expect(js).toContain('Bearer')
    expect(js).toContain('fw.token') // 与主站共用同一 localStorage 键
  })

  it('/ota.json 描述符如实声明下发需鉴权且端点已实现', async () => {
    const j = await (await fetch(base + '/ota.json')).json()
    expect(j.auth.dispatch_requires_token).toBe(true)
    expect(j.auth.report_and_result_are_unauthenticated).toBe(true)
    expect(j.apis.dispatch_command.implemented).toBe(true)
    expect(j.apis.dispatch_command.errors['401']).toBeTruthy()
    expect(j.apis.dispatch_command.errors['409']).toBeTruthy()
  })

  it('dist 缺失 → 404 not built', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-nodist-'))
    const s = http.createServer(createApp({ dataDir, token: 't', distDir: empty }))
    await new Promise((r) => s.listen(0, r))
    const res = await fetch(`http://127.0.0.1:${s.address().port}/OTA`)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('not built')
    s.close()
    fs.rmSync(empty, { recursive: true, force: true })
  })
})
