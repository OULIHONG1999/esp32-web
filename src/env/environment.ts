export interface EnvProblem {
  id: 'insecure' | 'no-serial'
  message: string
  hint: string
}

export interface EnvReport {
  secureContext: boolean
  serialApi: boolean
  ok: boolean
  problems: EnvProblem[]
  userAgent: string
}

/** 可注入的最小全局视图，便于单测 */
export interface EnvProbe {
  isSecureContext?: boolean
  userAgent?: string
  hasSerial?: boolean
}

function defaultProbe(): EnvProbe {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  return {
    isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
    userAgent: nav?.userAgent ?? '',
    hasSerial: nav ? 'serial' in nav : false,
  }
}

export function checkEnvironment(probe?: EnvProbe): EnvReport {
  const p = probe ?? defaultProbe()
  const secureContext = p.isSecureContext === true
  const serialApi = p.hasSerial === true
  const problems: EnvProblem[] = []

  if (!secureContext) {
    problems.push({
      id: 'insecure',
      message: '当前页面不在安全上下文中，Web Serial 不可用',
      hint: '请使用 https:// 访问（本地开发用 http://localhost 即可）；内网自签证书可在浏览器中选择“继续访问”，或用 chrome://flags/#unsafely-treat-insecure-origin-as-secure 豁免站点。',
    })
  }
  if (!serialApi) {
    problems.push({
      id: 'no-serial',
      message: '浏览器不支持 Web Serial API（navigator.serial 不存在）',
      hint: '请使用 Chrome 或 Edge 桌面版（89+）。Safari / iOS / Android WebView 不支持；Firefox 151+ 虽有 API 但本工具未经验证。',
    })
  }

  return {
    secureContext,
    serialApi,
    ok: secureContext && serialApi,
    problems,
    userAgent: p.userAgent ?? '',
  }
}
