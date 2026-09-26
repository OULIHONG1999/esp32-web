# ESP32 Web Flasher — 架构设计文档

> 状态：设计稿（未实现） · 日期：2026-09-26 · 依据：research/esp32-web-flash/REPORT.md

## 1. 目标与边界

**做什么**：一个可部署到自有服务器的网页工具，用户通过浏览器把固件烧录到 ESP32 系列设备（重点场景：ESP32-S3 原生 USB CDC 直连，兼容外置 USB-UART 桥），日志、文件选择、命令控制、交互流程全部自研定制。

**怎么做**：烧录内核不自研、不 fork——直接以 npm 依赖引入官方 `esptool-js`（Apache-2.0，锁版本）；内核之上的一切（UI、文件管理、日志、状态机、错误处理、部署）由本项目实现。

**不做什么**：
- 不做 ELF→bin 转换、不做 espefuse/espsecure（esptool-js 官方能力边界，报告 §3）
- 不做设备端 OTA（另一条路线，见报告 §4）
- 不实现 esp-web-tools 的 Improv 配网 / Home Assistant 接入（后续可选）

## 2. 总体架构

```
┌─────────────────────────────────────────────────────┐
│ UI 层（框架待定：Vue3/React/原生 TS）                  │
│  连接向导 · 文件选择 · 日志面板 · 进度条 · 命令按钮      │
├─────────────────────────────────────────────────────┤
│ 应用服务层（本项目核心代码）                            │
│  FlashSession 状态机   │  Logger 日志服务              │
│  FirmwareSet 文件管理  │  CommandBus 命令编排           │
│  ErrorMapper 错误翻译  │  PresetTable 芯片/地址预设     │
├─────────────────────────────────────────────────────┤
│ 粘合层（唯一接触 esptool-js API 的地方）                │
│  LoaderFactory · TerminalBridge · ResetBridge         │
├─────────────────────────────────────────────────────┤
│ esptool-js（npm 依赖，锁定版本，只升不改）              │
├─────────────────────────────────────────────────────┤
│ 浏览器 Web Serial API（安全上下文/HTTPS 硬约束）        │
└─────────────────────────────────────────────────────┘
```

**依赖纪律**：esptool-js 的类型只在 `粘合层` 出现。UI 层只认识本项目自己的类型（`FlashState`、`LogEntry`、`FirmwarePart`）。将来升级 esptool-js 只改粘合层，UI 不动。

## 3. esptool-js 定制点映射

| 我们要定制的东西 | esptool-js 注入点 | 粘合层职责 |
|---|---|---|
| 日志系统（分级/面板/导出） | 实现 `IEspLoaderTerminal`（clean/writeLine/write） | TerminalBridge 把字节流解析成带 level 的 `LogEntry` 推给 Logger |
| 进度展示 | `FlashOptions.reportProgress(fileIndex, written, total)` | 归一化为 `ProgressState` |
| 下载命令控制（连接/复位/擦除/烧录/硬复位） | `main()` / `writeFlash()` / `eraseFlash()` / `after()` / `readFlash()` | CommandBus 串成状态机，禁止非法并发调用 |
| 复位策略（S3 USB / 普通 UART / 自定义硬件） | `resetConstructors`：`classicReset` / `hardReset` / `usbJtagSerialReset` / 自定义 `D0\|R1\|W…` 序列 | ResetBridge 按检测到的芯片/端口类型选择策略，失败时给出手动 BOOT 指引 |
| 波特率策略 | `LoaderOptions.baudrate` | PresetTable 提供默认值（先低后高策略见 §8） |
| 文件与地址 | `FlashOptions.fileArray: {data, address}[]` | FirmwareSet 生成；地址来自预设表或用户显式覆盖 |
| 端口选择与授权 | `navigator.serial.requestPort({filters})` | Session 发起，处理 getPorts()/connect/disconnect 事件 |
| 芯片信息展示 | `esploader.main()` 返回 chip name；`esploader.chip` 等 | 透传到状态与日志 |

## 4. 核心模块设计

### 4.1 FlashSession（状态机，中枢）

```
idle
 └─ connect() → requesting-port     （用户手势触发 requestPort）
      ├─(用户取消)→ idle
      └─ selected → detecting       （main()：自动复位 + 检测芯片）
           ├─(识别失败)→ error:chip-detect
           └─ ok → ready            （持锁：chip / baud / transport）
                ├─ flash()  → flashing → verifying → resetting → done → ready
                ├─ erase()  → erasing → ready
                ├─ read()   → reading → ready
                ├─ hardReset() → ready
                └─ disconnect() → idle
任意状态 ─(不可恢复错误)→ error ─release()→ idle
```

规则：
- **单飞行**：flashing/erasing/reading 互斥，命令按钮按状态机灰化（这就是"下载命令控制"的主体）。
- **释放纪律**：离开 ready/done/error 必须 `transport.disconnect()` + 释放 reader，否则串口被占用、二次连接失败（报告 F4[10] 的坑）。
- 断线（disconnect 事件）→ 立即回收到 idle 并记 warning 日志。

### 4.2 Logger（日志系统）

```ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'transfer' | 'device'
interface LogEntry {
  ts: number            // 时间戳
  level: LogLevel
  source: 'loader' | 'serial' | 'app' | 'device'
  text: string
  bytes?: number        // transfer 级用于流量统计
}
```

- `source: 'device'`：解析 stub/ROM 回显（`Connecting...`、`Chip is …`、`Changed baudrate` 等）提取结构化字段（芯片名、MAC、flash 大小）反哺 UI。
- `source: 'app'`：本项目的操作日志（用户点了什么、状态迁移）。
- 内存环形缓冲（如 2000 条）+ UI 虚拟滚动；支持导出 .txt（自用排障刚需）。
- esptool-js 原始输出保留原文，**解析失败不丢原文**，只降级为 `source:'loader'` 纯文本。

### 4.3 FirmwareSet（文件选择与地址管理）

```ts
interface FirmwarePart {
  id: string
  label: string          // bootloader / partition-table / app / 用户自定义
  file: File | Uint8Array
  address: number        // 十六进制输入，带默认值
}
interface FirmwareSet {
  parts: FirmwarePart[]
  chipFamily?: ChipFamily  // 可选：与实测芯片比对，不符则警告
}
```

- 支持拖拽/多选 `.bin`；每个 part 地址可编辑，按芯片预设自动填（见下表）。
- **S3 单文件场景**（最常见）：选 1 个 merged bin + 1 个地址即可，向导第一步就引导这个路径。
- 高级模式：多段烧录（对应 esptool `write-flash` 多文件）。
- **简化 manifest 进 v1 范围**（参考 esp-web-tools JSON 自研裁剪，供服务器托管固件一键载入；本地选文件为主路径，manifest 失败仅降级不阻断）：

```json
{
  "schema": "esp-web-flash/v1",
  "name": "My Device FW",
  "chipFamily": "ESP32-S3",
  "parts": [
    { "label": "app", "path": "firmware/app.bin", "address": "0x10000" }
  ]
}
```

> manifest 与固件**同域托管**（部署约束，§7），`fetch` 时不需要 CORS。

**地址预设表（PresetTable，初版以 ESP-IDF 常见布局为准，实现前用实际产物核对）**：

| 芯片 | bootloader | partition-table | app |
|---|---|---|---|
| ESP32（经典） | 0x1000 | 0x8000 | 0x10000 |
| ESP32-S3/S2/C3 等 | 0x0 | 0x8000 | 0x10000 |

> **S3 为已确认的第一款目标芯片**：上表 S3 行实现时用实际固件产物核对一次；注意 merged bin（合并在 0x0 的整片镜像）只有起始地址一个条目。

预设只是默认值，**永远允许用户改**；与实测 `chipFamily` 不一致时显示警告而非阻断。

### 4.4 CommandBus + ErrorMapper（命令控制与错误翻译）

命令集：`connect / flash / erase / readFlash / hardReset / disconnect / abort`。

错误分类（UI 文案自定，这里定分类与恢复动作）：

| 内部错误类 | 典型来源 | 用户提示方向 | 恢复动作 |
|---|---|---|---|
| `PortBusy` | 打开失败/claimInterface 失败、他处占用 | "串口被占用，关闭串口助手/其他标签页后重试" | 回 idle |
| `UserCancel` | requestPort 取消 | 静默 | 回 idle |
| `ResetFailed` | 复位序列无响应 | "无法进入下载模式：按住 BOOT 再点重试"（S3 USB 场景提示换对端口） | 停在 ready 前，可重试 |
| `ChipDetectFail` | magic 不匹配等 | "芯片识别失败，升级内核/选择芯片型号强制模式" | 支持手动指定 chip |
| `TransferFail` | 高波特率失步（报告 F4 案例2） | "传输中断，已自动降波特率重试 1 次" | 自动降速重试一次，再失败才报错 |
| `PolicyInsecure` | 非安全上下文 | "需 HTTPS 访问（或浏览器 flag 豁免）" | 阻断在 connect 前 |
| `PermissionDenied` | Permissions-Policy 无 serial | "页面未获串口权限" | 检测 `navigator.serial === undefined` 提前拦截 |

**自动降速策略**：flash 断在中途 → 以 `原波特率/2` 重试一次（下限 115200），重试写入日志；只重试一次，避免死循环。

### 4.5 连接向导（UI 流程，五步）

```
① 检查环境   浏览器支持? 安全上下文? （不满足给出修复指引，见 §7）
② 选固件     单文件模式(默认) / 多段模式 / 载入 manifest
③ 连接设备   「连接」按钮 → requestPort（用户手势）→ 自动复位检测 → 展示芯片信息
             失败 → 引导：换 USB 口 / 按住 BOOT / 关串口助手
④ 烧录       进度条 + 实时日志（transfer 级滚动）
⑤ 完成       自动 hard_reset → 显示"设备已重启" → 保持会话可再次烧录
```

任何步骤可回退；②③ 顺序可互换（先连后选也允许，检测结果反过来预填地址）。

## 5. ESP32-S3 原生 USB（CDC）专项

1. **复位策略**：默认尝试 `usbJtagSerialReset` → 失败回退 `classicReset` → 再失败提示手动 BOOT（三层兜底）。
2. **端口提示**：双口 DevKit 引导"接 USB-Serial/JTAG 口，不要接 OTG 口"。
3. **Linux 权限**：检测失败且为 `/dev/ttyACM*` 形态时，日志提示 dialout 组/udev 规则。
4. **manifest/固件**：`serialType: "cdc"` 概念保留在自研 manifest schema 中（与 uart 变体区分）。
5. **WebUSB 不做**（v1 拒绝范围）：官方通道仍是实验性质，Web Serial 对 CDC 已够用（报告 F3）。

## 6. 技术选型（已定，2026-09-26）

| 项 | 结论 |
|---|---|
| 前端框架 | **Vue 3 + Vite + TypeScript**（架构不依赖框架：粘合层+状态机独立于 UI 可测） |
| 状态管理 | Pinia（或按需手写 store；状态机本身手写） |
| 样式 | 深色终端风为默认审美 |
| 打包部署 | 纯静态产物（dist/）；固件文件作为静态资源同域放置 |

相关决策（详见 REQUIREMENTS.md）：v1 范围 = 烧录 + 擦除 + 硬复位；单用户自用；固件来源 = 本地选文件 + 服务器 manifest 一键载入；开发先 localhost，部署后置。

## 7. 部署设计（自用放宽版）

```
https://your.host/
├── index.html + assets/        # 应用本体
└── firmware/                   # 固件与 manifest，与应用同域（免 CORS）
    ├── manifest.json
    └── app.bin
```

- **HTTPS 是浏览器硬约束，无法靠服务器配置放宽**（报告 §2）。自用三选一：
  1. 反代 + 自签证书，浏览器首次点"继续访问"；
  2. `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 加入站点 origin，纯 HTTP 直接跑（最省事，仅本机可控浏览器）；
  3. 有域名就 Caddy/Let's Encrypt 免费自动证书（推荐长期方案）。
- 站点鉴权自用可省（Web Serial 只能操作本机用户手动选择的端口）；要加就一层 HTTP Basic / URL token。
- 若嵌入 iframe：需要 `allow="serial"`。
- 应用启动即自检：`!window.isSecureContext || !navigator.serial` → 环境引导页。

## 8. 版本与升级策略

- `esptool-js` **精确锁定版本**（如 `0.7.0`，不写 `^`），升级走显式动作：升级前核对 CHANGELOG 中芯片支持/复位修复条目，跑一遍 S3 实机冒烟（连接→检测→小固件烧录→复位）。
- 粘合层是唯一改动面；升级破坏 API 时 UI 层零改动。
- 关注上游 issue（如 #218 高波特率读取），作为升级触发条件。

## 9. 风险清单

| 风险 | 影响 | 对策 |
|---|---|---|
| 高波特率失步（上游 issue #218 仍 open） | 大固件/读取失败 | 降速重试一次；默认波特率保守 |
| 芯片识别滞后（历史 issue #262 模式重演） | 新芯片连不上 | 手动指定 chip 强制模式作为兜底；及时升内核 |
| 四段式固件未 merge | 烧录后不跑 | 文档+UI 提示"需要 merged bin"；不做在线合并（v1 范围外） |
| 串口占用/多标签页 | 连接失败 | ErrorMapper 文案 + disconnect 事件回收 |
| Safari/iOS 用户 | 完全不可用 | 环境自检页明确告知（无解，浏览器不支持） |

## 10. 未决问题（2026-09-26 需求确认后更新）

已关闭：① 前端框架 → Vue 3 + Vite；② v1 范围 → 烧录+擦除+硬复位（读取备份移出）；③ manifest 一键载入 → 进 v1。详见 REQUIREMENTS.md。

仍开放：
1. ~~第一款目标芯片~~ → **ESP32-S3 已确认（2026-09-26）**；实现阶段用实际固件产物核对预设地址（bootloader 0x0 / partition-table 0x8000 / app 0x10000）即可。
2. 服务器 HTTPS 方案（有域名 / 仅 IP / 先 localhost 开发）——只阻塞部署阶段。
