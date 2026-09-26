import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

/**
 * dev-only 中间件：读取 IDF 构建目录（flash_args 为权威来源），
 * 暴露 /api/artifacts 一键载入本地编译产物。
 * 通过环境变量 IDF_BUILD_DIR 指定 build 目录；未设置则功能关闭。
 *
 *   $env:IDF_BUILD_DIR = 'D:\ESP\v6.1\esp-idf\examples\get-started\hello_world\build'
 *   & $env:MIMO_NODE $env:MIMO_NPM run dev
 */
function idfBuildArtifacts(): Plugin {
  const buildDir = process.env.IDF_BUILD_DIR
    ? path.resolve(process.env.IDF_BUILD_DIR)
    : null

  return {
    name: 'idf-build-artifacts',
    configureServer(server) {
      if (!buildDir) return

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
            const lines = fs.readFileSync(argsPath, 'utf8').split(/\r?\n/)
            const paramsLine = lines.find((l) => l.startsWith('--flash-mode')) ?? ''
            const mode = /--flash-mode\s+(\S+)/.exec(paramsLine)?.[1] ?? 'dio'
            const freq = /--flash-freq\s+(\S+)/.exec(paramsLine)?.[1] ?? '40m'
            const size = /--flash-size\s+(\S+)/.exec(paramsLine)?.[1] ?? '4MB'

            const parts = lines
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
            res.end(JSON.stringify({ buildDir, flashParams: { mode, freq, size }, parts }))
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
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
