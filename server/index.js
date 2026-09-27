import http from 'node:http'
import { createApp } from './app.js'
import { loadConfig } from './config.js'

/** 自含服务入口：node server/index.js（PORT / FIRMWARE_PUBLISH_TOKEN 环境变量） */
const config = loadConfig()
const server = http.createServer(createApp(config))
server.listen(config.port, () => {
  console.log(`[firmware-server] http://localhost:${config.port}`)
  console.log(`  dataDir: ${config.dataDir}`)
  console.log(`  dist:    ${config.distDir}`)
  if (config.token === 'dev-token') {
    console.warn('[firmware-server] 警告：使用开发默认 token，请设置 FIRMWARE_PUBLISH_TOKEN')
  }
})
