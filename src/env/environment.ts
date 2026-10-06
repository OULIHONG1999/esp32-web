export type EnvProblemId = 'insecure' | 'embedded' | 'no-serial'

export interface EnvProblem {
  id: EnvProblemId
  message: string
  hint: string
}

export interface EnvReport {
  secureContext: boolean
  serialApi: boolean
  ok: boolean
  /**
   * 唯一根因清单。设计纪律：**同一根因只报一条**——非安全上下文会让
   * `navigator.serial` 一并消失（Chrome 只在安全上下文暴露该接口），
   * 若再补一条「浏览器不支持」就是同因两报、且把责任推给浏览器。
   */
  problems: EnvProblem[]
  /** 现场：带协议的来源，一眼判断 http / https / localhost */
  origin: string
  inIframe: boolean
  /** 现场：浏览器名 + 主版本（UA 不可解析时为「未知浏览器」） */
  browser: string
  userAgent: string
}

/** 可注入的最小全局视图，便于单测 */
export interface EnvProbe {
  isSecureContext?: boolean
  userAgent?: string
  hasSerial?: boolean
  origin?: string
  inIframe?: boolean
}

export function describeBrowser(userAgent: string): string {
  // 按优先级匹配，不能取「第一个命中」：Edge/Opera 的 UA 里也含 Chrome/<版本>
  const patterns: Array<[RegExp, string]> = [
    [/EdgA?\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/Version\/(\d+)[^)]*Safari\//, 'Safari'],
  ]
  for (const [re, name] of patterns) {
    const m = re.exec(userAgent)
    if (m) return `${name} ${m[1]}`
  }
  return '未知浏览器'
}

function defaultProbe(): EnvProbe {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const loc = typeof location !== 'undefined' ? location : undefined
  let inIframe = false
  try {
    inIframe = typeof window !== 'undefined' && window.self !== window.top
  } catch {
    // 跨域 iframe 访问 window.top 会抛 SecurityError——能抛就证明确实在 iframe 内
    inIframe = true
  }
  return {
    isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
    userAgent: nav?.userAgent ?? '',
    hasSerial: nav ? 'serial' in nav : false,
    origin: loc?.origin ?? '',
    inIframe,
  }
}

export function checkEnvironment(probe?: EnvProbe): EnvReport {
  const p = probe ?? defaultProbe()
  const secureContext = p.isSecureContext === true
  const serialApi = p.hasSerial === true
  const inIframe = p.inIframe === true
  const problems: EnvProblem[] = []

  if (!secureContext) {
    problems.push({
      id: 'insecure',
      message:
        '当前页面不在安全上下文，浏览器不向页面暴露 Web Serial——“Web Serial API 可用”这项失败是它的后果，不是浏览器不支持',
      hint: '改用 https:// 打开——自签证书首次点“继续访问”即可（安全上下文只按协议判定，https 一律算），或走 http://localhost:<端口>（本机 dev / 本地服务）。明文 http:// 的 IP 或域名无解；chrome://flags/#unsafely-treat-insecure-origin-as-secure 只作临时自救（重启与换端口即失效）。',
    })
  } else if (!serialApi && inIframe) {
    problems.push({
      id: 'embedded',
      message:
        '页面运行在 iframe / 内嵌预览中，且浏览器不提供 navigator.serial（内嵌时串口接口常被 Permissions-Policy 屏蔽）',
      hint: '把地址复制到浏览器独立标签页打开，先排除内嵌因素：独立标签页里仍然缺失就是浏览器本身不支持（用 Chrome / Edge 桌面版 89+）。若必须内嵌，宿主页面需声明 allow="serial"。',
    })
  } else if (!serialApi) {
    problems.push({
      id: 'no-serial',
      message: '页面已是安全上下文，但当前浏览器不提供 navigator.serial',
      hint: '用 Chrome / Edge 桌面版（89+）——Safari、iOS/Android WebView 不支持，Firefox 虽有实现但本工具未验证。确认已是桌面版仍失败时，按 Ctrl+Shift+N 开一个无扩展的干净窗口重试。',
    })
  }

  return {
    secureContext,
    serialApi,
    ok: secureContext && serialApi,
    problems,
    origin: p.origin ?? '',
    inIframe,
    browser: describeBrowser(p.userAgent ?? ''),
    userAgent: p.userAgent ?? '',
  }
}
