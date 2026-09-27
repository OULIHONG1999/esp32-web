/**
 * 零依赖 multipart/form-data 解析（仅覆盖本项目发布接口所需形态）：
 * - 普通字段（name=meta）
 * - 文件字段（name=file; filename=...），data 以 Buffer 保留
 * 全量缓冲后解析——body 已在上层按 maxBodyBytes 限制。
 */
export function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  const boundary = m?.[1] ?? m?.[2]
  if (!boundary) throw new Error('missing multipart boundary')
  const delim = Buffer.from(`--${boundary}`)
  const fields = new Map()
  const files = []

  let pos = body.indexOf(delim)
  if (pos < 0) throw new Error('boundary not found')
  pos += delim.length
  while (pos < body.length) {
    // 跳过分隔符后的 CRLF 或终结符 "--"
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break // "--"
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2
    const headerEnd = body.indexOf('\r\n\r\n', pos)
    if (headerEnd < 0) break
    const headerText = body.subarray(pos, headerEnd).toString('utf8')
    const next = body.indexOf(delim, headerEnd + 4)
    const contentEnd = next < 0 ? body.length : next - 2 // 去掉数据后 CRLF
    const data = body.subarray(headerEnd + 4, Math.max(headerEnd + 4, contentEnd))

    const nameM = /name="([^"]*)"/i.exec(headerText)
    const fileM = /filename="([^"]*)"/i.exec(headerText)
    const name = nameM?.[1] ?? ''
    if (fileM) {
      files.push({ field: name, filename: fileM[1], data: Buffer.from(data) })
    } else {
      fields.set(name, data.toString('utf8'))
    }

    if (next < 0) break
    pos = next + delim.length
  }
  return { fields, files }
}
