import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.js'
import { emptyRegistry, registryPath, writeRegistryAtomic } from './registry.js'

/**
 * 自愈工具（FIRMWARE-REGISTRY §5.4）：扫描 server-data/projects/ 目录树重建 registry.json。
 * 用法：node server/rebuild.js   （registry 丢失/损坏时执行）
 */
const { dataDir } = loadConfig()
const projectsDir = path.join(dataDir, 'projects')
const reg = emptyRegistry()

if (fs.existsSync(projectsDir)) {
  for (const pid of fs.readdirSync(projectsDir)) {
    const pDir = path.join(projectsDir, pid)
    if (!fs.statSync(pDir).isDirectory()) continue
    for (const vid of fs.readdirSync(pDir)) {
      const vDir = path.join(pDir, vid)
      if (!fs.statSync(vDir).isDirectory()) continue
      for (const rid of fs.readdirSync(vDir)) {
        const rDir = path.join(vDir, rid)
        if (!fs.statSync(rDir).isDirectory()) continue
        const metaPath = path.join(rDir, '.meta.json')
        if (!fs.existsSync(metaPath)) {
          console.warn(`[rebuild] 跳过 ${pid}/${vid}/${rid}：缺 .meta.json`)
          continue
        }
        try {
          const release = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
          const proj = (reg.projects[pid] ??= {
            id: pid,
            name: pid,
            description: '',
            variants: {},
          })
          const vars = (proj.variants[vid] ??= { latest: null, releases: [] })
          vars.releases.push(release)
          if (!vars.latest || release.createdAt > vars.latest) vars.latest = release.id
        } catch (e) {
          console.warn(`[rebuild] 跳过 ${pid}/${vid}/${rid}：${e.message}`)
        }
      }
    }
  }
}

writeRegistryAtomic(dataDir, reg)
console.log(`[rebuild] 已写入 ${registryPath(dataDir)}`)
console.log(
  `[rebuild] 项目数：${Object.keys(reg.projects).length}` +
    `，版本总数：${Object.values(reg.projects).reduce(
      (n, p) => n + Object.values(p.variants).reduce((m, v) => m + v.releases.length, 0),
      0,
    )}`,
)
