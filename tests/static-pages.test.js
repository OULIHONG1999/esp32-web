import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
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

  // 回归守卫：页面只读实时接口，不得再夹带本地假数据（2026-10-06 移除）。
  it('/OTA 页不含本地假数据与模式开关', async () => {
    const html = await (await fetch(base + '/OTA')).text()
    expect(html).not.toContain('modeToggle')
    expect(html).toContain('id="connState"') // 连接状态取代了原「数据源 mock/real」胶囊
    const js = await (await fetch(base + '/ota/ota.js')).text()
    expect(js).not.toContain('mockDevices')
    expect(js).not.toContain('mockRegistry')
    expect(js).not.toContain('loadMock')
    expect(js).not.toContain('MODE_KEY')
  })

  // 回归守卫：Token 的「设置链接」必须是片段形态（# 不上行、不进日志），且页面能解析 + 能复制。
  it('/OTA 页支持设置链接（#token=）与复制设置链接', async () => {
    const html = await (await fetch(base + '/OTA')).text()
    expect(html).toContain('id="copyLinkBtn"')
    const js = await (await fetch(base + '/ota/ota.js')).text()
    expect(js).toContain('#token=')
    expect(js).toContain('consumeTokenFromUrl')
    expect(js).toContain('replaceState') // 写入后把 token 从地址栏抹掉
    expect(js).toContain('settingsLink')
    const j = await (await fetch(base + '/ota.json')).json()
    expect(j.auth.settings_link.format).toContain('#token=')
    expect(j.auth.settings_link.why_fragment).toBeTruthy()
  })

  // 回归守卫：描述符里的 implemented 必须与实现一致——曾把已上线的端点写成 false，
  // 让 AI/接手者以为「设备上报没实现」（实际线上已有设备在报）。
  it('/ota.json 的 implemented 标记与实现一致', async () => {
    const j = await (await fetch(base + '/ota.json')).json()
    for (const [name, api] of Object.entries(j.apis)) {
      expect(api.implemented, `${name} 应为已实现`).toBe(true)
    }
    expect(j.status).not.toContain('not implemented')
  })

  // 回归守卫：过程视图必须真接线（面板 + 渲染函数 + 阶段标签），否则"看不见 OTA 过程"会复发。
  it('/OTA 页具备 OTA 过程视图接线（步骤链 + 时间线 + 卡住判定）', async () => {
    const html = await (await fetch(base + '/OTA')).text()
    expect(html).toContain('id="procBody"')
    expect(html).toContain('id="procHint"')
    expect(html).toContain('/progress') // 页脚写明过程上报端点（数据来源）
    const js = await (await fetch(base + '/ota/ota.js')).text()
    expect(js).toContain('renderProcess')
    expect(js).toContain('stepChain')
    expect(js).toContain('verdict')
    expect(js).toContain('PHASE_ORDER')
    expect(js).toContain('downloading') // 阶段标签表
    expect(js).toContain('cmd.progress') // 读设备上报的进度
    expect(js).toContain('cmd.trail') // 读阶段变化轨迹
    const j = await (await fetch(base + '/ota.json')).json()
    expect(j.apis.report_progress.implemented).toBe(true)
    expect(j.apis.report_progress.path).toContain('/progress')
    expect(j.data_model.Command.progress).toBeTruthy()
    expect(j.data_model.Command.deliveredAt).toBeTruthy()
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

// ── 回归守卫：离线即取消 + 撤销（docs/PUSH-TO-DEVICE.md §3.1/§3.4） ──
describe('独立页 /OTA · 离线取消与撤销的接线', () => {
  it('页面把"离线不下发"写在明面上（按钮置灰 + 文案 + 412 提示）', async () => {
    const html = await (await fetch(base + '/OTA')).text()
    expect(html).toContain('离线不下发') // 命名与约定里的规则行
    expect(html).toContain('id="cCancelled"') // 概览胶囊有"已取消"
    const js = await (await fetch(base + '/ota/ota.js')).text()
    expect(js).toContain('cancelled') // 状态标签
    expect(js).toContain('device_offline') // 取消原因翻译
    expect(js).toContain('err.status === 412') // 412 → 可操作提示，而不是"服务器未实现"
    expect(js).toContain('下发会被取消、不会排队')
  })

  it('页面能撤销未决命令（写操作、带 cmd id、与 CLI 同一端点）', async () => {
    const js = await (await fetch(base + '/ota/ota.js')).text()
    expect(js).toContain('cancelPending')
    expect(js).toContain('data-act="cancel"')
    expect(js).toContain('data-cmd=') // 撤的必须是那条未决命令，不能靠"最近记录"猜
    expect(js).toContain('/cancel')
    expect(js).toContain('wasDelivered') // delivered 撤销要如实警告
    expect(js).toContain('d.unresolved') // 未决命令可能被更新的 cancelled 记录顶下去
  })

  it('ota.json 如实声明 cancelled 状态、412 与 cancel 端点', async () => {
    const j = await (await fetch(base + '/ota.json')).json()
    expect(j.offline_dispatch_rule.rule).toMatch(/412/)
    expect(j.apis.dispatch_command.errors['412']).toBeTruthy()
    expect(j.apis.cancel_command.implemented).toBe(true)
    expect(j.apis.cancel_command.path).toContain('/cancel')
    expect(j.data_model.Command.state).toContain('cancelled')
    expect(j.data_model.Device.unresolved).toBeTruthy()
    expect(j.cancel_semantics.delivered).toBeTruthy()
  })

  it('#ai-data 与 llms.txt 也带上 412 / cancelled（AI 从页面与索引都能读到）', async () => {
    const html = await (await fetch(base + '/OTA')).text()
    const m = /<script type="application\/json" id="ai-data">([\s\S]*?)<\/script>/.exec(html)
    const ai = JSON.parse(m[1])
    expect(ai.command_states).toContain('cancelled')
    expect(ai.dispatch_failure_codes['412']).toBeTruthy()
    expect(ai.offline_dispatch_rule).toBeTruthy()
    expect(ai.apis.cancel_command).toBeTruthy()

    const llms = await (await fetch(base + '/llms.txt')).text()
    expect(llms).toContain('cancelled')
    expect(llms).toContain('412')
  })
})

// ── 回归守卫：CLI 源码镜像（设备机不 clone 也能下载即跑，§6.1） ──
describe('CLI 源码托管 /tools/publish/', () => {
  const FILES = ['index.js', 'lib.js', 'once.js', 'watch.js', 'push.js', 'pushlib.js']

  it('public/tools/publish/ 是 tools/publish/ 的字节级镜像（改一处必须同步另一处）', () => {
    for (const f of FILES) {
      const src = fs.readFileSync(path.join(repo, 'tools', 'publish', f))
      const mirror = fs.readFileSync(path.join(repo, 'public', 'tools', 'publish', f))
      expect(mirror.equals(src), `${f} 与源头不一致`).toBe(true)
    }
  })

  it('镜像下来的 CLI 能直接跑（依赖都在同目录，Node 18+）', () => {
    const out = execFileSync(process.execPath, [path.join(repo, 'public', 'tools', 'publish', 'index.js'), 'push', '--help'], {
      encoding: 'utf8',
    })
    expect(out).toContain('push --to <mac> --build')
    expect(out).toContain('不下发、不排队、直接取消')
  })
})
