export type ErrorClass =
  | 'PortBusy'
  | 'UserCancel'
  | 'ResetFailed'
  | 'ChipDetectFail'
  | 'TransferFail'
  | 'PolicyInsecure'
  | 'PermissionDenied'
  | 'Unknown'

export type SessionPhase = 'connect' | 'detect' | 'flash' | 'erase' | 'reset'

export interface ClassifiedError {
  cls: ErrorClass
  /** 面向用户的中文文案 */
  message: string
  /** 恢复动作提示 */
  hint: string
  /** 是否原地重试有意义 */
  retryable: boolean
}

const COPY: Record<ErrorClass, { message: string; hint: string; retryable: boolean }> = {
  PortBusy: {
    message: '串口打开失败：端口被占用',
    hint: '按顺序排查：①关闭本浏览器其它标签页对本工具的连接（本工具已有跨标签锁，若仍失败说明是外部占用）；②关闭串口助手/Arduino IDE/idf.py monitor；③关掉另一个可能占用的浏览器窗口；④仍不行则重插 USB 后重试。',
    retryable: true,
  },
  UserCancel: {
    message: '已取消端口选择',
    hint: '如需继续，请再次点击“连接”。',
    retryable: true,
  },
  ResetFailed: {
    message: '无法让设备进入下载模式',
    hint: '按住开发板 BOOT 键后点“重试”；检查是否接在 USB-Serial/JTAG 口（S3 双口板不要接 OTG 口）。',
    retryable: true,
  },
  ChipDetectFail: {
    message: '芯片识别失败',
    hint: '确认接线与供电后重试；若是全新芯片型号，可能需要升级 esptool-js 内核版本。',
    retryable: true,
  },
  TransferFail: {
    message: '传输中断（烧录/擦除未完成）',
    hint: '将自动降波特率重试一次；若反复失败，改用较短线缆并关闭占用 CPU 的程序。',
    retryable: true,
  },
  PolicyInsecure: {
    message: '页面不在安全上下文，Web Serial 被浏览器禁用',
    hint: '请通过 https:// 或 http://localhost 访问。',
    retryable: false,
  },
  PermissionDenied: {
    message: '页面没有串口权限（Permissions-Policy 或浏览器设置拒绝）',
    hint: '若嵌入在 iframe 中需 allow="serial"；否则检查浏览器站点权限设置。',
    retryable: false,
  },
  Unknown: {
    message: '发生未预期的错误',
    hint: '查看日志详情；重试仍失败时把日志导出排查。',
    retryable: true,
  },
}

function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : ''
}

/** 把底层异常翻译成七类错误（DESIGN §4.4）；phase 用于同文本不同阶段的消歧 */
export function classifyError(err: unknown, phase?: SessionPhase): ClassifiedError {
  const text = errText(err)
  const name = errName(err)

  // D2：core 自抛的超时（detect 20s / flash 空闲 60s）——先于其它规则，避免被 /timeout/ 误吞
  if (name === 'TimeoutError') {
    if (phase === 'detect') {
      return {
        cls: 'ChipDetectFail',
        message: '芯片识别超时（20 秒无响应）',
        hint: '检查接线与供电后重试；设备若已拔出，请重新点「连接」。',
        retryable: true,
      }
    }
    return {
      cls: 'TransferFail',
      message: '操作超时（长时间无进度）',
      hint: '将自动降波特率重试一次；若反复失败，改用较短线缆并关闭占用 CPU 的程序。',
      retryable: true,
    }
  }

  if (name === 'NotFoundError' || /no port selected|user cancelled|denied by user/i.test(text)) {
    return { cls: 'UserCancel', ...COPY.UserCancel }
  }
  if (name === 'SecurityError' || /permissions.?policy/i.test(text)) {
    return { cls: 'PermissionDenied', ...COPY.PermissionDenied }
  }
  if (/secure context|navigator\.serial/i.test(text) && !('serial' in (globalThis.navigator ?? {}))) {
    return { cls: 'PolicyInsecure', ...COPY.PolicyInsecure }
  }
  if (name === 'InvalidStateError' || name === 'NetworkError' || /already open|cannot open|in use|access denied/i.test(text)) {
    return { cls: 'PortBusy', ...COPY.PortBusy }
  }
  if (phase === 'detect' || /magic|autodetect|chip type|unknown chip/i.test(text)) {
    return { cls: 'ChipDetectFail', ...COPY.ChipDetectFail }
  }
  if (phase === 'flash' || phase === 'erase' || /timeout|out of sync|failed to write|stub|no response|invalid checksum/i.test(text)) {
    return { cls: 'TransferFail', ...COPY.TransferFail }
  }
  if (phase === 'reset' || phase === 'connect' || /reset|bootloader|sync/i.test(text)) {
    return { cls: 'ResetFailed', ...COPY.ResetFailed }
  }
  return { cls: 'Unknown', ...COPY.Unknown }
}
