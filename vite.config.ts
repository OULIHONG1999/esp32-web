import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

/**
 * dev-only 中间件：
 *  1. /api/artifacts — 读取 IDF 构建目录（flash_args 权威来源），一键载入
 *  2. /api/build     — 服务端执行 idf.py build / fullclean，输出行缓存供轮询
 * 通过环境变量 IDF_BUILD_DIR 指定 build 目录（其父目录为工程目录）；未设置则全部关闭。
 * 仅限 localhost 开发环境（D1 单用户自用），不进生产构建。
 */
function idfBuildArtifacts(): Plugin {
  const buildDir = process.env.IDF_BUILD_DIR
    ? path.resolve(process.env.IDF_BUILD_DIR)
    : null
  const projectDir = buildDir ? path.dirname(buildDir) : null
  const profile =
    process.env.IDF_EXPORT_PROFILE ??
    'C:\\Espressif\\tools\\Microsoft.v6.1.PowerShell_profile.ps1'

  // ---- build 命令执行状态（单飞行） ----
  let child: ChildProcess | null = null
  let running = false
  let cmd: 'build' | 'clean' | null = null
  const lines: string[] = []
  let totalLines = 0
  let exitCode: number | null = null

  function pushLines(chunk: string): void {
    for (const raw of chunk.split(/\r?\n/)) {
      const line = raw.replace(/\r$/, '')
      if (!line) continue
      lines.push(line)
      totalLines += 1
      if (lines.length > 1000) lines.splice(0, lines.length - 1000)
    }
  }

  function startIdfCommand(nextCmd: 'build' | 'clean'): boolean {
    if (running || !projectDir) return false
    running = true
    cmd = nextCmd
    exitCode = null
    lines.length = 0
    totalLines = 0

    const psScript = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      `. '${profile}'`,
      `Set-Location '${projectDir}'`,
      nextCmd === 'build' ? 'idf.py build' : 'idf.py fullclean',
    ].join('; ')

    pushLines(`$ idf.py ${nextCmd === 'build' ? 'build' : 'fullclean'} （项目：${projectDir}）`)
    const c = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      psScript,
    ])
    child = c
    c.stdout?.on('data', (d: Buffer) => pushLines(d.toString('utf8')))
    c.stderr?.on('data', (d: Buffer) => pushLines(d.toString('utf8')))
    c.on('error', (err) => {
      pushLines(`[spawn error] ${err.message}`)
      running = false
      exitCode = -1
      child = null
      cmd = null
    })
    c.on('close', (code) => {
      pushLines(
        code === 0
          ? '=== idf.py 命令完成（exit 0）==='
          : `=== idf.py 命令失败（exit ${code}）===`,
      )
      exitCode = code
      running = false
      child = null
      cmd = null
    })
    return true
  }

  return {
    name: 'idf-build-artifacts',
    configureServer(server) {
      if (!buildDir) return

      server.middlewares.use('/api/build', (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')

          if (req.method === 'GET' && url.pathname === '/status') {
            const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                available: true,
                running,
                cmd,
                exitCode,
                totalLines,
                newLines: lines.slice(Math.max(0, since)),
              }),
            )
            return
          }

          if (req.method === 'POST' && url.pathname === '/start') {
            const body = url.searchParams.get('cmd') === 'clean' ? 'clean' : 'build'
            const ok = startIdfCommand(body)
            res.statusCode = ok ? 200 : 409
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok, running }))
            return
          }

          if (req.method === 'POST' && url.pathname === '/abort' && child) {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'])
            pushLines('$ 已请求中止（taskkill /T /F）')
            res.statusCode = 200
            res.end(JSON.stringify({ ok: true }))
            return
          }

          res.statusCode = 404
          res.end('not found')
        } catch (err) {
          res.statusCode = 500
          res.end(String(err))
        }
      })

      server.middlewares.use('/api/artifacts', (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')

          if (url.pathname === '' || url.pathname === '/') {
            const argsPath = path.join(buildDir, 'flash_args')
            if (!fs.existsSync(argsPath)) {
              res.statusCode = 404
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: `flash_args 不存在：${argsPath}` }))
              return
            }
            const raw = fs.readFileSync(argsPath, 'utf8')
            const linesF = raw.split(/\r?\n/)
            const paramsLine = linesF.find((l) => l.startsWith('--flash-mode')) ?? ''
            const mode = /--flash-mode\s+(\S+)/.exec(paramsLine)?.[1] ?? 'dio'
            const freq = /--flash-freq\s+(\S+)/.exec(paramsLine)?.[1] ?? '40m'
            const size = /--flash-size\s+(\S+)/.exec(paramsLine)?.[1] ?? '4MB'

            const parts = linesF
              .filter((l) => /^0x[0-9a-fA-F]+\s+\S+/.test(l.trim()))
              .map((l) => {
                const [addr, rel] = l.trim().split(/\s+/)
                const abs = path.resolve(buildDir, rel.replace(/\//g, path.sep))
                const name = path.basename(rel)
                const label = /partition/i.test(name)
                  ? 'partition-table'
                  : /bootloader/i.test(name)
                    ? 'bootloader'
                    : name.replace(/\.bin$/i, '')
                return {
                  address: parseInt(addr, 16),
                  rel,
                  name,
                  label,
                  size: fs.existsSync(abs) ? fs.statSync(abs).size : 0,
                }
              })
              .filter((p) => p.size > 0)

            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                buildDir,
                // 字段名与前端 FlashParams 对齐（门2 实测：曾因 mode/freq/size 形状不符
                // 导致全部落入默认 40m/4MB，flash_args 参数从未生效——D4 根因）
                flashParams: { flashMode: mode, flashFreq: freq, flashSize: size },
                parts,
              }),
            )
            return
          }

          if (url.pathname === '/file') {
            const rel = url.searchParams.get('path') ?? ''
            const abs = path.resolve(buildDir, rel.replace(/\//g, path.sep))
            if (!abs.startsWith(buildDir) || !fs.existsSync(abs)) {
              res.statusCode = 404
              res.end('not found')
              return
            }
            const data = fs.readFileSync(abs)
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/octet-stream')
            res.setHeader('Content-Length', String(data.length))
            res.end(data)
            return
          }

          res.statusCode = 404
          res.end('not found')
        } catch (err) {
          res.statusCode = 500
          res.end(String(err))
        }
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [vue(), idfBuildArtifacts()],
  // v1.5：/api/registry* 与 /api/publish* 转发自含服务；dev 专属 artifacts/build 留 vite 自管（FIRMWARE-REGISTRY §3）
  server: {
    proxy: {
      '/api/registry': 'http://localhost:8787',
      '/api/publish': 'http://localhost:8787',
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // .ts = 前端核心层；.js = server/ 与 tools/publish（纯 JS 零依赖，不进 vue-tsc）
    include: ['tests/**/*.test.{ts,js}'],
  },
})
