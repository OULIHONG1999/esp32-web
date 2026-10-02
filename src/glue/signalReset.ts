/**
 * 信号复位（idf.py monitor 同源实现 · 2026-10-02 R-1；同日极性修正）。
 *
 * ★ 极性（2026-10-03 实机踩坑修正，务必看懂再改）：
 *   `esp_idf_monitor/base/constants.py` 是 **LOW = True / HIGH = False（标签反转）**，
 *   因此 `Reset.hard()` 的真实信号序列是：
 *     _setRTS(LOW=True)  → requestToSend: true  → **EN=LOW，芯片进复位**
 *     sleep(chip_config['reset'] = 5ms @esp32s3)
 *     _setRTS(HIGH=False) → requestToSend: false → **EN=HIGH，正常启动出 boot 日志**
 *   与 esptool `USBJTAGSerialReset` 注释互证（"RTS=True # Reset" / "RTS=False # Chip out of reset"）。
 *   首版实现极性写反（init 拉 true=一直按着复位），现象=开流后只有5ms窗口的
 *   一行 ESP-ROM、随后永久静默——已按官方语义修正。
 *
 * 权威来源（本地 IDF 工具链）：
 * - esp_idf_monitor/base/reset.py：hard() / open_serial()（开流后先放 RTS 再放 DTR=idle）
 * - esp_idf_monitor/base/chip_specific_config.py：esp32s3 → reset = MINIMAL_EN_LOW_DELAY = 0.005s
 * - esptool/reset.py：USBJTAGSerialReset 时序与注释（极性互证）；Windows usbser.sys
 *   DTR 重发变通（_setRTS 内 setDTR(port.dtr)）——重发的是 **idle=false**。
 *
 * 关键性质不变：全部操作作用于【已打开】端口的控制信号——不 close、读流不断。
 * 注意：esptool 官方注明「USB 类目标复位可能导致端口掉线重枚举」（esptool 会重试）；
 * USB-Serial/JTAG(0x303a:0x1001) 实机验证端口保持（2026-10-03 用户实测无 disconnect）。
 *
 * DTR 约定：init 后 idle=false（官方 HIGH=False），期间本模块不改 DTR，仅重发兜底。
 */

const EN_LOW_MS = 5 // esp32s3: MINIMAL_EN_LOW_DELAY = 0.005s（esp_idf_monitor default 配置）

/** 开流后置 idle：先放 RTS 再放 DTR（官方 open_serial 顺序，避免开流瞬间误复位） */
export async function initSignalsIdle(port: SerialPort): Promise<void> {
  await port.setSignals({ requestToSend: false }) // HIGH(False) → EN=HIGH 释放
  await port.setSignals({ dataTerminalReady: false }) // HIGH(False) → idle
}

/**
 * RTS 单独变更 + DTR 重发（Windows usbser.sys：RTS 变更需伴随一次 DTR 请求才会下发）。
 * DTR 恒为 idle=false（官方 port.dtr 语义）。
 */
async function setRTSWithDtrWorkaround(port: SerialPort, rts: boolean): Promise<void> {
  await port.setSignals({ requestToSend: rts })
  await port.setSignals({ dataTerminalReady: false })
}

/**
 * 硬复位进正常 app 启动（出完整 boot 日志）——
 * esp_idf_monitor `Reset.hard()` 的 Web Serial 等价实现（极性已按 constants.py 修正）。
 */
export async function hardResetViaSignals(port: SerialPort): Promise<void> {
  await setRTSWithDtrWorkaround(port, true) // RTS=TRUE（官方 LOW=True）→ EN=LOW 复位
  await new Promise((resolve) => setTimeout(resolve, EN_LOW_MS))
  await setRTSWithDtrWorkaround(port, false) // RTS=FALSE（官方 HIGH=False）→ EN=HIGH 启动
}
