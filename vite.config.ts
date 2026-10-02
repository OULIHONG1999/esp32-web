import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  base: './',
  plugins: [vue()],
  // v1.5：/api/registry* 与 /api/publish* 转发自含服务（dev 专属 IDF 中间件 artifacts/build 已移除）
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
