/**
 * 设置链接（token 深链）的解析与构造——纯字符串逻辑，零依赖。
 *
 * 形态：`https://<站点>/<路径>#token=<token>`
 * **为什么用片段而不是查询串**：片段（`#` 后面）浏览器不会发给服务器，
 * 因此不会落进 nginx access log，也不会经 Referer 泄给第三方；
 * 旧的 `?settoken=` 形态仍在解析时兼容（它会上行，能不用就不用）。
 */

/** 片段里的键名 */
export const TOKEN_FRAGMENT_KEY = 'token'

/** 旧形态（`?settoken=`）——兼容读取，构造时不使用 */
export const LEGACY_QUERY_KEY = 'settoken'

export interface ParsedTokenLink {
  /** 链接携带的 token；没有则为空串 */
  token: string
  /** 抹掉 token 之后的同页地址（保留其它查询参数与片段） */
  cleanHref: string
}

/** 解析当前页地址里是否带着 token（片段优先，兼容旧查询串） */
export function parseTokenLink(href: string): ParsedTokenLink {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { token: '', cleanHref: href }
  }

  const fragParams = new URLSearchParams(url.hash.replace(/^#/, ''))
  const query = url.searchParams
  const token = (fragParams.get(TOKEN_FRAGMENT_KEY) ?? '').trim() || (query.get(LEGACY_QUERY_KEY) ?? '').trim()
  if (!token) return { token: '', cleanHref: href }

  fragParams.delete(TOKEN_FRAGMENT_KEY)
  query.delete(LEGACY_QUERY_KEY)
  const restHash = fragParams.toString()
  const restQuery = query.toString()
  return {
    token,
    cleanHref:
      url.origin + url.pathname + (restQuery ? `?${restQuery}` : '') + (restHash ? `#${restHash}` : ''),
  }
}

/** 用当前页地址构造设置链接：同源同路径 + `#token=` */
export function buildTokenLink(currentHref: string, token: string): string {
  const suffix = `#${TOKEN_FRAGMENT_KEY}=${encodeURIComponent(token)}`
  try {
    const url = new URL(currentHref)
    return `${url.origin}${url.pathname}${suffix}`
  } catch {
    return suffix
  }
}
