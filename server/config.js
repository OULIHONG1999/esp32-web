import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/**
 * 服务配置（FIRMWARE-REGISTRY §0）：
 * - 端口 PORT（默认 8787）
 * - 发布 token：FIRMWARE_PUBLISH_TOKEN（生产必须显式设置；开发默认 dev-token）
 * - 数据目录 server-data/（registry.json + projects/）
 * - 静态前端 dist/
 */
export function loadConfig(env = process.env) {
  return {
    port: Number.parseInt(env.PORT ?? '', 10) || 8787,
    token: env.FIRMWARE_PUBLISH_TOKEN || 'dev-token',
    dataDir: env.FIRMWARE_DATA_DIR
      ? path.resolve(env.FIRMWARE_DATA_DIR)
      : path.join(root, 'server-data'),
    distDir: env.FIRMWARE_DIST_DIR
      ? path.resolve(env.FIRMWARE_DIST_DIR)
      : path.join(root, 'dist'),
  }
}

/** 发布安全上限（FIRMWARE-REGISTRY §5.4） */
export const LIMITS = {
  /** 单文件 ≤64MB */
  maxFileBytes: 64 * 1024 * 1024,
  /** 单发布 ≤256MB（正文整体） */
  maxBodyBytes: 256 * 1024 * 1024,
  /** 文件名白名单 */
  safeName: /^[A-Za-z0-9._-]+$/,
}
