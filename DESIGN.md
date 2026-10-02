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
│  设备连接 · IDF命令 · 固件烧录 · 日志面板        │
├─────────────────────────────────────────────────────┤
│ 应用服务层（本项目核心代码）                            │
│  DeviceManager 设备状态机 │ Logger 日志服务              │
│  FirmwareSet 文件管理  │  DeviceManager 编排 + Logger    │
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
| 下载命令控制（连接/切换端口/擦除/烧录/硬复位） | `main()` / `writeFlash()` / `eraseFlash()` / `after()` | DeviceManager 临界区编排：stopStream → esptool → startStream，working 单飞行 |
| 复位策略（S3 USB / 普通 UART / 自定义硬件） | `resetConstructors`：`classicReset` / `hardReset` / `usbJtagSerialReset` / 自定义 `D0\|R1\|W…` 序列 | ResetBridge 按检测到的芯片/端口类型选择策略，失败时给出手动 BOOT 指引 |
| 波特率策略 | `LoaderOptions.baudrate` | PresetTable 提供默认值（先低后高策略见 §8） |
| 文件与地址 | `FlashOptions.fileArray: {data, address}[]` | FirmwareSet 生成；地址来自预设表或用户显式覆盖 |
| 端口选择与授权 | `navigator.serial.requestPort({filters})` | Session 发起，处理 getPorts()/connect/disconnect 事件 |
| 芯片信息展示 | `esploader.main()` 返回 chip name；`esploader.chip` 等 | 透传到状态与日志 |

## 4. 核心模块设计

### 4.1 DeviceManager（设备常驻状态机，中枢 · 2026-09-26 方向1 重构）

> 旧版 FlashSession（idle/双会话互斥）已被本模型取代：**端口授权与连接是长生命周期，日志是默认背景流，烧录/擦除/复位是短暂临界区**。

```
disconnected
 └─ connect() → requesting            （无授权端口才弹选择器；否则复用 lastPort）
      ├─(用户取消)→ disconnected（静默）
      └─ → detecting                  （esptool main()：自动复位 + 检测芯片）
           ├─(识别失败)→ error ─disconnect()→ disconnected
           └─ ok → ready              （已连接 · 日志监视**默认关闭** N4：streamWanted=false；▶手动开启后保持，重连自动恢复）
                ├─ flash()   → working（stopStream(仅监视开着时) → 写入 → closeEsptool → 按 streamWanted 恢复流）→ ready
                ├─ erase()   → working（同上临界区）→ ready
                ├─ hardReset() → working → ready
                ├─ switchPort() → 停流关会话 → requesting（强制弹选择器）
                └─ disconnect() → disconnected
ready ─(日志流意外中断/拔线, onStopped error)→ disconnected + notice
任意临界区失败 → 按 streamWanted 恢复日志流回 ready（lastError 置位）；恢复失败 → error
```

规则：
- **端口复用**：`lastPort` 长期保留，二次 connect/重连不弹系统选择器；「切换端口」才弹。
- **日志自动**：进入 ready 即开实时日志流；进入 working 自动挂起、结束自动恢复（用户无感知）。**手动覆盖（F-16 增补）**：`pauseMonitor/resumeMonitor`（ready 态幂等）——停止即释放串口，供本机 `idf.py monitor` 等外部工具使用，再点恢复切回页面监视。
- **互斥靠编排而非用户**：流（SerialMonitor）与 esptool 会话独占同一端口，切换顺序固定为 stopStream → esptool → closeEsptool → startStream。
- **单飞行**：working 期间禁止一切其他命令（按钮灰化即由此而来）。
- **拔线感知**：日志流 error 停止 → 自动回 disconnected 并出 notice。
- **操作超时（D2，2026-09-26）**：`detect` 20s 无响应 → `TimeoutError` → 归位 **error**（ChipDetectFail 超时文案），UI 不再锁死；`flash` **空闲 60s 无进度** → `TimeoutError` → 走临界区失败路径归位 ready（TransferFail 超时文案）。进度回调会重置 flash 空闲计时。超时值经 `DeviceTimeouts` 注入，测试可覆盖。
- **自动降速重试（D1，2026-09-26）**：flash 失败且错误 `retryable` → 调 `deps.reopenForRetry()`（glue：释放会话 → 波特率/2 下限 115200 → 重建 → 重新同步）后**重试一次**；仅一次，重试仍失败才上抛。
- **错误可见性（D3，2026-09-26）**：`lastError` 在 **error 与 ready 态都显示**（可关闭的错误条）；临界区操作**成功后自动清除**旧错误，`clearError()` 供手动关闭。

### 4.2 Logger（日志系统）

```ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'transfer' | 'device'
interface LogEntry {
  seq: number           // 单调序号：渲染稳定 key（性能关键）
  ts: number            // 时间戳
  level: LogLevel
  source: 'loader' | 'serial' | 'app' | 'device'
  text: string
  bytes?: number        // transfer 级用于流量统计
}
```

- `source: 'device'`：解析 stub/ROM 回显（`Connecting...`、`Chip is …`、`Changed baudrate` 等）提取结构化字段（芯片名、MAC、flash 大小）反哺 UI。
- `source: 'app'`：本项目的操作日志（用户点了什么、状态迁移）。
- 内存环形缓冲 2000 条；支持导出 .txt（自用排障刚需）。
- esptool-js 原始输出保留原文，**解析失败不丢原文**，只降级为 `source:'loader'` 纯文本。
- **渲染性能（2026-09-26，实测日志洪峰卡页后引入）**：① 订阅端**批量 flush**（120ms 聚合一次推入视图）；② 视图列表**稳定 seq key**（避免索引 key 全量重绘）；③ 显示上限 500 条（导出仍为全量 2000）；④ 「暂停视图」缓冲继续收集、恢复时补显。

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

### 4.4 DeviceManager + ErrorMapper（命令控制与错误翻译）

命令集：`connect / flash / erase / readFlash / hardReset / disconnect / abort`。

错误分类（UI 文案自定，这里定分类与恢复动作）：

| 内部错误类 | 典型来源 | 用户提示方向 | 恢复动作 |
|---|---|---|---|
| `PortBusy` | 打开失败/claimInterface 失败、他处占用 | "端口被占用：①本站其它标签（已有 Web Locks 跨标签锁预拦截）②串口助手/monitor ③另一浏览器 ④重插 USB" | 回 disconnected/ready；锁随 disconnected/error 自动释放 |
| `UserCancel` | requestPort 取消 | 静默 | 回 disconnected |
| `ResetFailed` | 复位序列无响应 | "无法进入下载模式：按住 BOOT 再点重试"（S3 USB 场景提示换对端口） | 停在 ready 前，可重试 |
| `ChipDetectFail` | magic 不匹配等 | "芯片识别失败，升级内核/选择芯片型号强制模式" | 支持手动指定 chip |
| `TransferFail` | 高波特率失步（报告 F4 案例2） | "传输中断，已自动降波特率重试 1 次" | 自动降速重试一次，再失败才报错 |
| `PolicyInsecure` | 非安全上下文 | "需 HTTPS 访问（或浏览器 flag 豁免）" | 阻断在 connect 前 |
| `PermissionDenied` | Permissions-Policy 无 serial | "页面未获串口权限" | 检测 `navigator.serial === undefined` 提前拦截 |

**自动降速策略**：flash 断在中途 → 以 `原波特率/2` 重试一次（下限 115200），重试写入日志；只重试一次，避免死循环。

**超时分类（D2，2026-09-26 实现）**：core 自抛的 `TimeoutError`（`name==='TimeoutError'`，先于文本规则分类）——detect 阶段映射 `ChipDetectFail`（"芯片识别超时"），flash/erase 阶段映射 `TransferFail`（"操作超时（长时间无进度）"）。错误条在 ready 态也显示且可关闭（D3）。改文案/分类须同步 `tests/errors.test.ts`（AGENTS 纪律 4）。

### 4.5 UI 流程（IDE 五区布局，2026-10-02 按 b-ide 预览复刻）

> 蓝本：`public/design-preview/b-ide.html`（选型记录见 PAGE-REDESIGN.md）；accent 选型定案=**品牌绿**（状态栏为深绿色条 `--status`）。

```
区1 活动栏 48px   ▣设备 ⬚固件 ◷版本(NEW红点) 📁项目 ▤历史 ◉服务 …(底)⚙设置
                  图标下带中文小标签（N6）；选中态=左侧 accent 指示条；点击=切标签/定位/历史开面板/主题
区2 侧栏 250px    「资源管理器」树（TreeItem 树行；右缘可拖拽 N3 → --sb-w / fw.sbW）：
                  ▾ 设备 —— 信息行(芯片/MAC/Flash/状态灯) + 操作树行(▶连接(accent)/⇄切换/⏏断开)
                             + 错误条(D3)
                  ▾ 项目库 —— 📁项目/变体（折叠 N1：📁/📂 +「N 版本」；点文件夹=选中+折叠切换）
                               → 版本行(★发布=绿底徽标 · 快照=灰淡 · NEW=红) 点版本行=下载载入
                  ▾ 快捷操作 —— ＋添加 bin… / ⌫完全擦除 / ↻硬复位（后两个仅 canOperate 可见）
                  底部 side-card：服务在线 · 项目/版本/数据 · ↻（烧录历史已移入区4）
区3 工作区        SSE 横幅（顶部）+ 标签页 [固件 · <文件名> | 版本时间线]（EditorTabs 注册式）
                  固件 = 面包屑 + 参数卡(FLASH MODE/FREQ/SIZE/CHIP FAMILY/合计)
                        + 操作行(⚡烧录/擦除/硬复位/重新载入/添加bin/**⬇导出固件包 N7**)
                        + 烧录表格 + 进度条
                  导出固件包 = 当前清单全部段 + flash_args + README.txt → zip（core/zip STORE 零依赖）
                  时间线 = 选中项目后：晋升/回滚/保留数（VersionTimeline 原组件）
区4 底部面板      高度上缘可拖拽（N3 → --bp-h / fw.bpH，默认 264px）
                  四标签 [问题 | 输出 | 日志监视器 | 烧录历史 N5]
                  （问题=warn/error、输出=device 真实过滤；历史=原侧栏模块移入，手动点击查看）
                  头部右侧控制行：级别▾(v-model 过滤) ⏸暂停视图 ⏹/▶监视 导出 清空 [+▾收起]
                  （⧉ 独立窗口已整链移除 N2：按钮/?panel=log/fw-log 协议）
                  日志监视器 = LogPanel 纯终端体（行号/❯闪烁光标；渲染纪律不动）
                  **日志监视默认关闭（N4）**：连接后手动「▶ 开始监视」；streamWanted 意图跨重连保持，
                  烧录临界区只按意图恢复（手动暂停后烧录不再抢串口）
区5 状态栏 26px    accent 绿色条通栏：● state · 芯片 · ⌀MAC · 品牌 ‖ 右:烧录参数 · ★订阅N · ◉服务在线 x/y · 订阅 · 🔑 · 版本
```

**数据层**：`useFirmwareWorkspace`（单例）共享「烧录表格 rows + 项目库 registry 状态」——侧栏树 / 固件标签 / 时间线标签三处同源；`useServiceStatus`（单例）供 side-card 与状态栏共用 /api/status 快照。依赖注入（getChipName/onParams/onLoaded）。**core 变更仅 N4 监视意图语义**（`streamWanted`，131 测试同步守护）；日志渲染纪律（seq key/批量 flush/500 上限/暂停视图）不动；`?panel=log` 独立窗口与 `fw-log` BroadcastChannel 协议已移除（N2）。

组件注册式扩展：新标签 = `workTabs` 加一行 + `#pane-<id>` 插槽；新侧栏节 = `<TreeSection>` + `<TreeItem>`；新活动栏图标 = `activityItems` 加一行。

典型动线：连接（一次）→ 侧栏项目树点版本载入（或手动添加 bin）→ ⚡烧录（二次确认）→（自动硬复位+日志滚出 Hello world）。
拔线：日志流 error → 自动回 disconnected（无自动重连，重新点连接即可，端口授权保留）。

### 4.6 dev 中间件 API（**已移除**，2026-09-29 页面功能优化）

> ⚠️ 历史记录：曾由 `vite.config.ts` 的 `idfBuildArtifacts()` 插件提供 `/api/artifacts`（⚡一键载入本地构建）与 `/api/build`（🔨🧹■ 编译命令）五个端点。**部署云端后该功能失效，经用户确认整体移除**（前端入口、vite 中间件、`buildArtifacts.ts`/`buildCommands.ts`/`useIdfBuild.ts` 客户端、`tests/api.test.ts` 一并删除，`FlashParams` 类型迁至 `registry.ts`）。

> **路由分流（v1.5 定案）**：`/api/registry*`、`/api/publish*` 走 vite proxy 转发到 `localhost:8787`（自含服务）。见 FIRMWARE-REGISTRY §3。

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
| 打包部署 | 纯静态产物（dist/）；固件文件作为静态资源同域放置（v1 描述；v1.5 起由自含服务托管，见 §7 注） |

相关决策（详见 REQUIREMENTS.md）：v1 范围 = 烧录 + 擦除 + 硬复位；单用户自用；固件来源 = 本地选文件 + 服务器 manifest 一键载入；开发先 localhost，部署后置。

## 7. 部署设计（自用放宽版）

> ⚠️ **v1.5 起 superseded（2026-09-26）**：部署将改为**自含 Node 服务**（`server/`，registry + 发布 + SSE + 静态托管，见 `FIRMWARE-REGISTRY.md` §0 与 `EXECUTION-PLAN.md`）。本节"纯静态 dist/ + firmware/ 目录"的描述**仅适用于 v1**（本地 localhost / 无 registry 场景）；HTTPS 三选一与 iframe `allow="serial"` 的约束在 v1.5 仍有效（部署 runbook 随 S2 交付）。

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
