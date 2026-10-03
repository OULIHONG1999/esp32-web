/**
 * 信号复位（idf.py monitor 同源实现 · 2026-10-02 R-1；同日极性修正；10-03 加超时防挂）。
 *
 * ★ 极性（2026-10-03 实机踩坑修正，务必看懂再改）：
 *   `esp_idf_monitor/base/constants.py` 是 **LOW = True / HIGH = False（标签反转）**，
 *   因此 `Reset.hard()` 的真实信号序列是：
 *     _setRTS(LOW=True)  → requestToSend: true  → **EN=LOW，芯片进复位**
 *     sleep(chip_config['reset'] = 5ms @esp32s3)
 *     _setRTS(HIGH=False) → requestToSend: false → **EN=HIGH，正常启动出 boot 日志**
 *   与 esptool `USBJTAGSerialReset` 注释互证（"RTS=True # Reset" / "RTS=False # Chip out of reset"）。
 *
 * ★ 防挂（2026-10-03 用户实测「点复位后系统卡住」）：
 *   芯片复位瞬间 USB 控制传输可能停摆 → setSignals 的 Promise 不返回 → 状态机卡 working。
 *   现在每次 setSignals 带 500ms 超时、逐条尽力而为；全部失败才抛错，绝不无限挂起。
 *
 * 权威来源（本地 IDF 工具链）：
 * - esp_idf_monitor/base/reset.py：hard() / open_serial()
 * - esp_idf_monitor/base/chip_specific_config.py：esp32s3 reset = MINIMAL_EN_LOW_DELAY = 0.005s
 * - esptool/reset.py：USBJTAGSerialReset 时序互证；Windows usbser.sys DTR 重发变通。
 *
 * 关键性质：全部操作作用于【已打开】端口的控制信号——不 close、读流不断。
 */

const EN_LOW_MS = 5 // esp32s3: MINIMAL_EN_LOW_DELAY = 0.005s
const SIGNAL_TIMEOUT_MS = 500 // 单次 setSignals 超时：芯片复位瞬间 USB 可能停摆

/** 单次信号操作：限时 + 尽力而为（返回是否成功） */
async function safeSetSignals(
  port: SerialPort,
  init: SerialOutputSignals,
  label: string,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      port.setSignals(init),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error(`${label} timed out after ${SIGNAL_TIMEOUT_MS}ms`)
          e.name = 'TimeoutError'
          reject(e)
        }, SIGNAL_TIMEOUT_MS)
      }),
    ])
    return true
  } catch {
    return false // 复位已尽量发出；不阻塞后续步骤
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 开流后置 idle：先放 RTS 再放 DTR（官方 open_serial 顺序，避免开流瞬间误复位） */
export async function initSignalsIdle(port: SerialPort): Promise<void> {
  await safeSetSignals(port, { requestToSend: false }, 'idle RTS') // HIGH(False) → EN=HIGH 释放
  await safeSetSignals(port, { dataTerminalReady: false }, 'idle DTR') // HIGH(False) → idle
}

/**
 * RTS 单独变更 + DTR 重发（Windows usbser.sys：RTS 变更需伴随一次 DTR 请求才会下发）。
 * DTR 恒为 idle=false（官方 port.dtr 语义）。
 */
async function setRTSWithDtrWorkaround(port: SerialPort, rts: boolean): Promise<boolean> {
  const okRts = await safeSetSignals(port, { requestToSend: rts }, `RTS=${rts}`)
  await safeSetSignals(port, { dataTerminalReady: false }, 'DTR resend')
  return okRts
}

/**
 * 硬复位进正常 app 启动（出完整 boot 日志）——
 * esp_idf_monitor `Reset.hard()` 的 Web Serial 等价实现（极性已按 constants.py 修正）。
 * 任何一步超时都不会挂起；关键的两次 EN 沿（拉低/释放）若全失败则抛错给上层。
 * onLog：逐步打点（P4 可观测性——页面日志可见复位进行到哪一步）。
 */
export async function hardResetViaSignals(
  port: SerialPort,
  onLog?: (msg: string) => void,
): Promise<void> {
  const say = onLog ?? (() => {})
  say('步骤 1/2：EN → LOW（芯片进复位）…')
  const okLow = await setRTSWithDtrWorkaround(port, true) // RTS=TRUE（官方 LOW=True）
  if (!okLow) say('⚠ 步骤 1 信号超时（可能未生效），继续')
  say('步骤 2/2：保持 5ms 后 EN → HIGH（释放，正常启动）…')
  await new Promise((resolve) => setTimeout(resolve, EN_LOW_MS))
  const okHigh = await setRTSWithDtrWorkaround(port, false) // RTS=FALSE（官方 HIGH=False）
  if (!okHigh) say('⚠ 步骤 2 信号超时（可能未生效），继续')
  if (!okLow && !okHigh) {
    throw new Error('signal reset failed: setSignals timed out on both edges')
  }
}
