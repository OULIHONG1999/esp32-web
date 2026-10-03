# REPORT — 浏览器串口日志与"不掉 COM 复位"能力调研

> 2026-10-02 · 关联：`PROGRESS.md`（启动日志空窗问题 / 硬复位排查线索）、`DESIGN.md` §4.1、`FIRMWARE-REGISTRY.md`
> **性质：纯调研，未改动任何代码。** 结论可用于后续「监视中复位」功能立项评估。
> **调研方式说明**：本会话 Browser Use / IAB 基础设施不可用（无 `agent.browsers` REPL、无 `cua_repl` 工具），按 websearch 技能纪律**未静默降级为网页搜索**；经用户明确批准，改用 WebFetch 只读指定官方页面（esptool-js README、MDN setSignals），其余无法抓取的来源在 §7 如实标注为"未核实"。

---

## 0. 问题定义（用户原始诉求）

1. **乐鑫（Espressif）在 Web 侧有没有"日志能力"？**——即浏览器里持续查看设备 app 输出的能力，等价于 `idf.py monitor`。
2. **是否支持复位操作而不掉 COM 口？**——复位期间串口句柄不关闭、设备不重新枚举、日志流不中断（`idf.py monitor` 按 Ctrl+T/Ctrl+R 的那种体验）。
3. **动机**（来自实际使用）：
   - 当前页面「日志监视默认关闭 + 手动开启」模型下，用户先复位后开监视会**丢失 ROM/boot 早期输出**（串口硬件无缓冲，已输出行不可追回）；
   - 若能做到"监视中复位"，操作顺序固化为 **▶开始监视 → 页面点复位 → 从 `ESP-ROM` 第一行开始抓**，空窗问题根治；
   - 顺带排查线索：页面「硬复位按钮不可用」问题（PROGRESS 下一步 2）可能与复位走 esptool 会话的端口切换路径有关，见 §6.3。

---

## 1. 结论速览

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| Q1 | 乐鑫有官方浏览器版持续日志监视器（idf monitor 等价物）吗？ | **没有成品**。官方 Web 侧只有 `esptool-js`（烧录库，带烧录过程终端输出）与 `esp-web-tools`（网页安装器），均非持续 app 日志监视器 | 高（esp-web-tools 一处待复核，见 §7） |
| Q2 | Web 侧能否"复位但不掉 COM"？ | **能，且是标准做法**。Web Serial `SerialPort.setSignals({dataTerminalReady, requestToSend})` 在端口**保持 open** 状态下拨 DTR/RTS 信号——不 close、不重开、读取流不中断 → COM 口不掉 | **已核实**（MDN + WHATWG 规范 + esptool-js README） |
| Q3 | `idf.py monitor` 的复位是什么原理？ | 同一原理：全程持有打开的串口，复位只是对**已打开的**串口拨信号时序，从不关口重开 | 高（esptool 系实现一致；IDF 官方文档页 404 未取到原文，见 §7） |
| Q4 | 我们项目能否实现"监视中复位"？ | **可行**，且可**绕开当前"监视/烧录互斥"设计**——纯拨信号不需要 esptool 会话；照抄 esptool-js 的复位时序即可 | 高（需实测验证枚举保持，见 §6） |

**一句话**：你要的"边看日志边复位、不掉 COM 口"= 对已打开串口拨 DTR/RTS 复位时序；**Espressif 官方 esptool-js 的复位策略就是这么实现的**。浏览器完全具备该能力，官方只是没有把它包装成"日志监视器"产品。

---

## 2. 背景知识：三种"复位"的层次

| 层次 | 实现 | 是否关串口 | 典型使用者 |
|---|---|---|---|
| ① 拨信号复位（DTR/RTS 时序） | `port.setSignals(...)` 按固定时序切换 | **否**——端口全程 open | `idf.py monitor`、esptool 的 reset strategies、（可选）本项目监视中复位 |
| ② esptool 会话复位 | 建立 esptool 传输层后 `main()` / `after("hard_reset")`（内部仍是拨信号，但会话要独占读写通道） | 会话期间独占端口；我们现有实现需**先停监视再开esptool会话**（互斥） | `idf.py` 烧录、本项目 flash/erase 路径 |
| ③ 物理复位 | 按板载 RST/EN 键、重新上电 | 不涉及串口；但 USB 设备可能重新枚举 → 视芯片/口型可能掉口 | 人工操作 |

**关键洞察**：复位本质上**永远是**①层的信号操作（②只是包了一层会话）。既然①不需要会话，**监视器持有端口时完全可以直接做①**——这是本调研最重要的推论（§6.1）。

---

## 3. Web Serial 能力分析（已核实）

### 3.1 `SerialPort.setSignals()` —— 核心 API

出处：MDN `developer.mozilla.org/en-US/docs/Web/API/SerialPort/setSignals`；规范 WHATWG Serial `serial.spec.whatwg.org/#dom-serialport-setsignals`

```js
await port.open({ baudRate: 115200 });   // 必须先 open
await port.setSignals({
  dataTerminalReady: true,   // DTR
  requestToSend: false,      // RTS
  // break: false,           // BREAK 信号（可选）
});
```

关键语义：

| 事实 | 含义 |
|---|---|
| 未 open 时调用抛 `InvalidStateError` | 反证：**open 状态下随时可拨**，与 readable/writable 流无关 |
| 只设置控制信号，**不触碰 open/close 生命周期** | 拨信号**不影响读取循环**，日志流不断 |
| 不涉及驱动句柄重建 | COM 口编号不掉、设备不重枚举（见 §6.2 风险） |
| 仅安全上下文（HTTPS/localhost）可用 | 我们站点已是 HTTPS ✓ |
| 同时提供 `getSignals()` | 可读回 DTR/RTS/CTS 当前状态，可用于调试 |

### 3.2 与读取流的关系

Web Serial 中 `port.readable` 读循环与 `setSignals` 完全正交：

```
port.open() ──► reader.read() 循环 ──────────────► 持续收日志
                  ▲
port.setSignals() ┴── 任意时刻拨 DTR/RTS 时序 ──► 设备复位，日志继续流
```

**结论：浏览器层面"看日志 + 复位 + 不掉口"三件事互不冲突。**

---

## 4. 乐鑫官方 Web 侧产品盘点

### 4.1 `esptool-js`（官方，已核实 —— github.com/espressif/esptool-js）

基于 Web Serial 的官方烧录库（Apache 2.0，Star 537）。

**（a）日志/终端能力**
- 提供 `IEspLoaderTerminal` 接口（`clean/writeLine/write`），用于接收**烧录器自身的进度输出**（loader log）。
- ❗ 这**不是**持续 app 日志监视器——它只在烧录会话生命周期内有输出，烧录结束会话关闭后即停止。
- 结论：**esptool-js 不提供 idf-monitor 等价能力**，但其 Transport 层对同一 `SerialPort` 的操作方式可直接借鉴。

**（b）复位策略（README §7「Reset Strategies」，原文核实）**

复位命令语言（DTR/RTS/等待 的时序描述）：

| 命令 | 含义 |
|---|---|
| `D0` / `D1` | setDTR(False / True) |
| `R0` / `R1` | setRTS(False / True) |
| `W<n>` | 等待 n 毫秒 |
| `\|` | 分隔，如 `"D0\|R1\|W100\|D1\|R0\|W50\|D0"` |

内置策略类（可自定义替换）：

| 类 | 用途 | 适用 |
|---|---|---|
| `ClassicReset` | 经典 UART 桥复位（EN/IO0 经 DTR/RTS） | CP210x / CH340 / CH9102 等 USB-UART 桥 |
| `UsbJtagSerialReset` | USB-Serial/JTAG 复合设备复位 | **ESP32-S3 原生口（本项目设备 0x303a:0x1001）** |
| `HardReset` | 硬复位（可带 `usingUsbOtg` 参数区分） | 通用；部分场景触发重新枚举（见 §6.2） |
| `CustomReset` | 自定义序列字符串 + `validateCustomResetStringSequence` 校验 | 特殊硬件 |

入口模式：`esploader.main("default_reset" | "hard_reset" | "no_reset")`；烧录后 `esploader.after("hard_reset")`。

**要点**：全部复位策略都只操作**当前已打开的串口信号**——印证 §2 结论①。

> ⚠️ 精确的 DTR/RTS 毫秒参数以上述类的**源码为准**（`src/reset.ts`），本报告不凭记忆抄写具体时序，实现前需读源码。

**（c）其他**
- CDN 单文件加载：`https://unpkg.com/esptool-js/bundle.js`；API 文档：`espressif.github.io/esptool-js/docs/`；Live demo：`espressif.github.io/esptool-js/`
- 不含 ELF→bin 转换、espefuse、espsecure（README 明示）

### 4.2 `esp-web-tools`（官方网页安装器 —— 未核实，标注为印象）

- 印象：基于 Web Serial 的**网页固件安装 UI**（选 bin → 烧录 → 安装向导），被大量厂商安装页使用；**不含持续日志监视**。
- 本次抓取失败（GitHub 返回 404/限流，连续 3 次），见 §7。实现决策前建议复核。

### 4.3 ESP-IDF `idf.py monitor`（CLI —— 结论高置信，官方文档页未取到）

- 形态：仅 CLI（`idf.py monitor` / `python -m esp_idf_monitor`）与 VS Code 集成；**印象中无浏览器版**。
- 机制：启动时打开串口并**全程持有**；内置复位快捷键（印象：Ctrl+T 后接 Ctrl+R 复位、Ctrl+T Ctrl+D 下载模式等）——复位即对**同一打开的**串口拨 DTR/RTS 时序，COM 不掉、日志连续。
- 官方文档 `api-guides/monitoring.html` 多个路径均 404（文档站疑似改版），未拿到原文；但该机制与 esptool/esptool-js 的 reset strategies 同源，交叉印证充分。

---

## 5. 复位时序速查（实现前以 esptool-js 源码为准）

| 策略 | 信号逻辑（概略） | 适用口型 |
|---|---|---|
| ClassicReset | 先利用 DTR/RTS 组合把 IO0 拉低（进下载）或仅 EN 脉冲（正常重启），常见形如 DTR/RTS 交叉序列 + 等待 | UART 桥 |
| UsbJtagSerialReset | 针对 USB-Serial/JTAG 的专用 DTR/RTS 序列（该复合设备用两根信号分别映射 SRST/EN 类语义） | **S3 原生 USB-Serial/JTAG** |
| HardReset | 长按 EN 类时序；USB OTG 场景可能断开重枚举（`usingUsbOtg` 分支） | 需要"真重启"的场景；**掉口风险最高的一类** |

> 具体毫秒参数与电平顺序：**必须**从 `espressif/esptool-js` 的 `src/reset.ts`（或 Python esptool 对应实现）抄录，禁止凭记忆手写——时序差几毫克可能进不了预期状态。

---

## 6. 对本项目（esp32-web）的映射 —— 仅评估，不实施

### 6.1 「监视中复位」功能草案（可行性结论：✅ 可行）

```
现状（互斥模型）：
  监视中 ──点硬复位──► stopStream → esptool 会话(hardReset) → closeEsptool → startStream
                      ▲ 端口两次切换，窗口期丢日志；且该路径当前有 bug（硬复位不可用，PROGRESS 下一步2）

目标（信号模型）：
  监视中 ──点复位──► 对【当前持有的同一 SerialPort】拨 UsbJtagSerialReset 时序（setSignals 循环）
                      ▲ 端口不关、读循环不断、COM 不掉 → 立即从 ROM 第一行开始抓
```

设计要点（供未来立项，不改代码）：

1. **能力归属**：`SerialMonitor` 增加 `resetDevice()` —— 仅需 `port.setSignals` 时序循环 + `setTimeout` 等待，**零 esptool 依赖**。
2. **口型选择**：按 `chipInfo` / `getInfo()` 的 vid:pid 选 `UsbJtagSerialReset`（0x303a:1001）或 `ClassicReset`（UART 桥）；未知口型默认 classic 并容错。
3. **与互斥模型的关系**：信号复位**不需要** esptool 会话 → 不触发 runCritical 挂起/恢复 → 日志一行不丢。烧录/擦除仍走原互斥路径（它们真的需要会话）。
4. **UI 语义**：面板头「▶ 开始监视」旁增加「↻ 复位（不断流）」；与现有「硬复位」（esptool 路径）并存，前者管看日志场景，后者管烧录后复位场景（F-07 烧录后自动复位仍在临界区内，不建议改）。
5. **与 N4 语义叠加**：默认监视关闭 → 推荐动线变为 连接 → ▶开始监视 → **↻复位(不断流)** → 完整启动日志。

### 6.2 风险与实测清单

| # | 风险 | 验证方法 |
|---|---|---|
| R1 | USB-Serial/JTAG 拨信号后**枚举是否保持**（COM 不掉的关键） | 实机：监视中复位 ×10，观察 `port.connected`、COM 号、日志连续性 |
| R2 | 时序参数不适配某批板子（进不了 boot/下载模式） | 以 esptool-js 源码默认值为基线；失败时回退 esptool 会话路径 |
| R3 | native USB CDC（非 JTAG 复合）行为差异 | 若未来支持其它口型，按 `getInfo()` 分流；`HardReset(usingUsbOtg)` 慎用 |
| R4 | 复位瞬间 DTR/RTS 把板子拉进下载模式（而非启动 app） | 序列选用"正常重启"分支而非"进下载"分支；对照 idf monitor 的 Ctrl+T Ctrl+R 语义 |
| R5 | 浏览器差异（仅 Chromium 系支持 Web Serial） | 现状已限定 Chrome/Edge；无新增风险 |

### 6.3 对「硬复位按钮不可用」问题的线索价值

- 现有硬复位走 `DeviceManager.hardReset` → `runCritical` → 关监视 → esptool 会话 → 恢复监视，**链路长、每步都可能失败**（会话 ensureSynced、端口切换、互斥锁）。
- 调研表明：硬复位本身**根本不需要会话**（信号即可完成）。因此未来修复方向可能是**改走 §6.1 的信号复位**，顺带删掉整条会话链——比在现有链上找单点 bug 更彻底。
- 本报告仅记录该线索，不动代码（PROGRESS 下一步 2 维持"待查"）。

### 6.4 与「启动日志空窗」问题的关系（根治方案）

| 方案 | 效果 | 状态 |
|---|---|---|
| 现有引导（先开监视再手动 RST） | 依赖人工顺序，仍可能手慢 | ✅ 已上线（M1） |
| **监视中复位按钮（§6.1）** | 一键固定顺序，物理空窗消失 | 📋 可行性已确认，待立项 |

---

## 7. 来源、核实状态与局限

### ✅ 已核实（本会话实际抓取）

| 来源 | URL | 用途 |
|---|---|---|
| esptool-js README（Espressif 官方） | github.com/espressif/esptool-js | 复位策略类、D/R/W 命令语言、terminal 定位、main() 模式 |
| MDN `SerialPort.setSignals()` | developer.mozilla.org/en-US/docs/Web/API/SerialPort/setSignals | setSignals 语义、异常、open 前提 |
| WHATWG Serial 规范（MDN 内链） | serial.spec.whatwg.org/#dom-serialport-setsignals | 规范级依据 |

### ❌ 未核实（如实标注）

| 来源 | 失败原因 | 影响 | 补救 |
|---|---|---|---|
| ESP-IDF `monitoring.html`（多路径尝试） | 404（文档站疑似改版） | monitor 快捷键细节未拿原文；机制结论靠交叉印证 | Browser Use 可用后检索正确路径 |
| `esp-web-tools` README | GitHub 404/限流（连续 3 次） | "无监视器"为印象结论 | 同上复核 |
| esptool-js `src/reset.ts` 精确时序 | 本次未逐行抓取源码 | §5 仅给概略，**实现前必须读源码** | 实现阶段读仓库源码（无需联网） |

### 局限

- 本会话 **Browser Use / IAB 不可用**（无 `agent.browsers` REPL、无 `cua_repl` 工具、`mimo-browser-use` 技能未安装），未能执行完整 SERP→多源交叉循环；经用户批准以指定官方 URL 的 WebFetch 完成核心核实。
- 全部结论基于官方一手来源 + esptool 系同源实现的交叉印证；**无任何来自博客/二手文章的引用**（这也是为什么未核实项明确留白而非猜测填充）。

---

## 8. 行动建议（优先级）

| 优先级 | 行动 | 说明 |
|---|---|---|
| P1 | 立项评估「监视中复位（setSignals 不断流）」 | §6.1 草案；先读 esptool-js `src/reset.ts` 抄时序 → 实机 R1 验证枚举保持 |
| P1 | 顺带排查「硬复位按钮不可用」 | §6.3：优先尝试改走信号复位而非修会话链 |
| P2 | Browser Use 可用后补 §7 两项核实 | IDF monitor 官方页 + esp-web-tools README |
| P3 | 考虑把 §6.1 动线写进 TROUBLESHOOTING §1 | 现"手动先开监视"引导可升级为"用复位按钮" |

---

*报告完 · 研究目录：`research/serial-monitor-reset/REPORT.md` · 调研过程未修改任何源码*
