/** 纯逻辑：把串口字节流按行切分（可单测）；chunk 之间保留残片 */
export function createLineSplitter(): {
  push(chunk: string): string[]
  flush(): string[]
} {
  let buffer = ''
  return {
    push(chunk: string): string[] {
      buffer += chunk
      const parts = buffer.split(/\r?\n/)
      buffer = parts.pop() ?? ''
      return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0)
    },
    flush(): string[] {
      const rest = buffer.replace(/\r/g, '')
      buffer = ''
      return rest ? [rest] : []
    },
  }
}
