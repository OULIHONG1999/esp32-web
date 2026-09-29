/**
 * SSE hub（F-21 / FIRMWARE-REGISTRY §6）：
 * - GET /api/registry/stream 长连接，publish 事件即时推送
 * - 心跳注释行防反代/空闲断链（客户端据 Last-Event-ID 重连的补偿=重连后全量拉 registry）
 * - X-Accel-Buffering: no 兼容 nginx 反代（DEPLOY §4b 已配 proxy_buffering off，双保险）
 */
export function createSseHub(opts = {}) {
  const heartbeatMs = opts.heartbeatMs ?? 15_000
  /** @type {Set<{res: import('node:http').ServerResponse, done: () => void}>} */
  const clients = new Set()

  function handler(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write('retry: 3000\n\n')
    const hb = setInterval(() => {
      try {
        res.write(': hb\n\n')
      } catch {
        /* 写失败由 close 事件清理 */
      }
    }, heartbeatMs)
    const done = () => {
      clearInterval(hb)
      clients.delete(entry)
    }
    const entry = { res, done }
    clients.add(entry)
    req.on('close', done)
    req.on('error', done)
  }

  /** 向全部订阅连接推送事件；单个连接写失败不影响其它 */
  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const { res } of clients) {
      try {
        res.write(frame)
      } catch {
        /* 留给 close 清理 */
      }
    }
    return clients.size
  }

  function closeAll() {
    for (const { res, done } of [...clients]) {
      done()
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
  }

  return { handler, broadcast, closeAll, get size() { return clients.size } }
}
