export interface BuildStatus {
  available: boolean
  running: boolean
  cmd: 'build' | 'clean' | null
  exitCode: number | null
  totalLines: number
  newLines: string[]
}

/** 轮询服务端 idf.py 命令状态；endpoint 不存在（生产构建）返回 null */
export async function fetchBuildStatus(since: number): Promise<BuildStatus | null> {
  try {
    const r = await fetch(`api/build/status?since=${since}`)
    if (!r.ok) return null
    return (await r.json()) as BuildStatus
  } catch {
    return null
  }
}

export async function startIdfCommand(cmd: 'build' | 'clean'): Promise<boolean> {
  try {
    const r = await fetch(`api/build/start?cmd=${cmd}`, { method: 'POST' })
    return r.ok
  } catch {
    return false
  }
}

export async function abortIdfCommand(): Promise<boolean> {
  try {
    const r = await fetch('api/build/abort', { method: 'POST' })
    return r.ok
  } catch {
    return false
  }
}
