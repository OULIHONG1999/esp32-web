import fs from 'node:fs'
import path from 'node:path'

/** 空 registry（数据模型 v3 的 S1 子集：project → variant → release） */
export function emptyRegistry() {
  return { projects: {} }
}

export function registryPath(dataDir) {
  return path.join(dataDir, 'registry.json')
}

/** 读 registry；不存在/损坏返回空结构（损坏时改名留底，不静默覆盖前先由 rebuild 自愈） */
export function readRegistry(dataDir) {
  const p = registryPath(dataDir)
  if (!fs.existsSync(p)) return emptyRegistry()
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return emptyRegistry()
  }
}

/** 原子写：tmp + rename（FIRMWARE-REGISTRY §5.4 崩溃一致性） */
export function writeRegistryAtomic(dataDir, registry) {
  fs.mkdirSync(dataDir, { recursive: true })
  const target = registryPath(dataDir)
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

/**
 * 发布落位后的 registry 纯函数更新：
 * - upsert project（缺省创建）
 * - upsert variant；release 按 id 替换（幂等补传）
 * - variant.latest 指向本次 release
 */
export function upsertRelease(registry, { project, variant, release }) {
  const next = structuredClone(registry)
  const proj = (next.projects[project.id] ??= {
    id: project.id,
    name: project.name ?? project.id,
    description: project.description ?? '',
    subscribed: true, // ★ 默认订阅（单用户简化；F-21 订阅开关只改此字段）
    variants: {},
  })
  if (project.name) proj.name = project.name
  if (project.description !== undefined) proj.description = project.description
  const vars = (proj.variants[variant] ??= { latest: null, releases: [] })
  const i = vars.releases.findIndex((r) => r.id === release.id)
  if (i >= 0) vars.releases[i] = release
  else vars.releases.push(release)
  vars.releases.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  vars.latest = release.id
  return next
}

/** F-21：更新项目 ★订阅状态（服务端持久，跨设备一致；前端另有 localStorage 镜像） */
export function upsertSubscribed(registry, projectId, subscribed) {
  const next = structuredClone(registry)
  next.projects[projectId].subscribed = subscribed
  return next
}
