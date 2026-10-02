/**
 * 信号复位（idf.py monitor 同源实现 · 2026-10-02 R-1）。
 *
 * 权威来源（本地 IDF 工具链，非凭记忆）：
 * - `esp_idf_monitor/base/reset.py` 的 `Reset.hard()`：
 *     _setRTS(LOW) → sleep(chip_config['reset']) → _setRTS(HIGH)
 * - `esp_idf_monitor/base/chip_specific_config.py`：esp32s3 未特殊配置 →
 *     default reset = MINIMAL_EN_LOW_DELAY = 0.005s
 * - `_setRTS` 附带 Windows usbser.sys 变通：RTS 变更后重发一次 DTR
 *   （esptool-js webserial.js setRTS 同款）
 * - `serial_reader.py open_serial()`：开流后先 RTS=HIGH 再 DTR=HIGH（idle，
 *   避免误复位），随后 `if reset: hard()`——即 idf.py monitor **启动默认自动复位**
 *   （`--no-reset` 才关闭）。
 *
 * 关键性质：全部操作作用于【已打开】的 SerialPort 控制信号——
 * 端口不 close、读取流不断、COM 不掉。
 *
 * DTR 状态约定：本模块在 initSignalsIdle 后恒视 DTR=idle(true)；
 * 监视期间其它代码不改 DTR（esptool 会话与监视互斥，重新开流会再次 init）。
 */

const EN_LOW_MS = 5 // esp32s3: MINIMAL_EN_LOW_DELAY = 0.005s（esp_idf_monitor default）

/** 开流后置 idle：先 RTS 再 DTR（官方顺序，避免开流瞬间误复位） */
export async function initSignalsIdle(port: SerialPort): Promise<void> {
  await port.setSignals({ requestToSend: true }) // EN=HIGH
  await port.setSignals({ dataTerminalReady: true })
}

/** RTS 单独变更 + DTR 重发（Windows usbser.sys 变通，官方同款）；DTR 恒为 idle(true) */
async function setRTSWithDtrWorkaround(port: SerialPort, rts: boolean): Promise<void> {
  await port.setSignals({ requestToSend: rts })
  await port.setSignals({ dataTerminalReady: true })
}

/**
 * 硬复位进正常 app 启动（出完整 boot 日志）——
 * esp_idf_monitor `Reset.hard()` 的 Web Serial 等价实现。
 */
export async function hardResetViaSignals(port: SerialPort): Promise<void> {
  await setRTSWithDtrWorkaround(port, false) // EN=LOW，芯片复位
  await new Promise((resolve) => setTimeout(resolve, EN_LOW_MS))
  await setRTSWithDtrWorkaround(port, true) // EN=HIGH，正常启动
}
