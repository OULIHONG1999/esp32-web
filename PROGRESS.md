# PROGRESS — ESP32 Web Flasher 工作记录

> 本文件是**活的进度表**：每次有意义的推进后更新。新接手的 AI/工程师请先读本文，再读 AGENTS.md。
> 最后更新：2026-09-26（方向1 重构完成）

## 一句话

单用户自用的 ESP32 网页烧录工具：官方 esptool-js 做内核（只升不改），UI/日志/文件/命令控制全自研；第一目标芯片 ESP32-S3。当前模型：**设备常驻连接（方向1）+ 连接即自动日志监视**。

## 文档地图（阅读顺序）

1. `REQUIREMENTS.md` — 6 项决策（D1–D6）+ v1 验收清单（F-01…F-18）
2. `DESIGN.md` — 三层架构、设备状态机（§4.1）、错误分类（§4.4）、部署（§7）
3. `research/esp32-web-flash/REPORT.md` — 选型调研报告（为什么这么做）
4. `AGENTS.md` — 接手纪律与命令
5. 本文 — 进度与下一步

## 当前状态（任务面板同步）

| 任务 | 状态 | 证据 |
|---|---|---|
| T1 脚手架 Vue3+Vite+TS | ✅ done | build 通过 |
| T2 环境自检（F-01） | ✅ done | `src/env/environment.ts` + EnvCheck |
| T3 核心层（状态机/日志/错误/粘合） | ✅ done | Vitest 全绿 |
| T4 实机连接 | ✅ done | 实测：原生 USB 0x303a:0x1001 识别 ESP32-S3，自动进下载 |
| T5 烧录主链路 | ✅ done | 实测：⚡一键载入三段 → 烧录 → Hello world 重启循环 |
| T6 擦除+manifest 收尾 | 🔄 in_progress | 擦除/重烧/日志查看已实测通过；**manifest 服务器托管载入未做**（F-03 另一半、F-13） |
| T7 方向1 设备常驻重构 | ✅ 代码完成 | `core/device.ts` + `glue/deviceOps.ts`，32 测试全绿；**待实机回归** |
| T8 日志渲染性能 | ✅ 代码完成 | 批量 flush + seq key + 显示 500 + 暂停视图；**待实机压测** |
| T9 文档同步 | ✅ done | DESIGN §4.1/§4.2、AGENTS、REQUIREMENTS（F-17/F-18）、本文 |
| T10 IDF 命令按钮（F-19） | ✅ 代码完成 | dev 中间件 `/api/build`（build/fullclean/abort/轮询）+ 🔨🧹■ 按钮 + 编译成功自动载入；冒烟 exit 0；**待实机点按验证** |

**待用户决策**：主操作按钮方案——推荐映射「⚡一键烧录 / 查看日志 / 选择文件」vs 字面三按钮（下载 / 下载并查看日志 / 查看日志），见会话记录 2026-09-26。

## 代码结构（2026-09-26 方向1 重构后）

```
src/core/device.ts            # DeviceManager 设备常驻状态机（方向1 核心，deps 注入可单测）
src/core/log.ts               # Logger 环形缓冲 + seq 序号 + esptool 行分级
src/core/errors.ts            # 七类错误翻译
src/core/lines.ts             # 串口行切分器（纯逻辑）
src/glue/esptool.ts           # esptool-js 唯一接触面
src/glue/monitor.ts           # SerialMonitor 实时读取流
src/glue/deviceOps.ts         # DeviceDeps 实现：lastPort 复用 + 流/esptool 互斥编排
src/composables/useSession.ts # Vue 接线：批量 flush、暂停视图、状态镜像
src/components/               # EnvCheck / ConnectPanel / FirmwarePanel / LogPanel
src/api/buildArtifacts.ts     # ⚡一键载入客户端
vite.config.ts                # idfBuildArtifacts dev 中间件（读 flash_args）
tests/{device,log,errors,lines}.test.ts   # 32 用例
```

> 已删除（方向1 取代）：`core/session.ts`、`glue/sessionDeps.ts`、`tests/session.test.ts`

## 关键技术决策与坑（务必继承）

1. **esptool-js 锁 `0.7.0`**（不带 ^）；**`typescript` 锁 `5.9`**（TS7 砸 vue-tsc，已踩坑）。
2. **分层铁律**：esptool-js 的 import 只允许出现在 `src/glue/`；core 零浏览器依赖。
3. **构建/测试命令**（本机 Node 不在系统 PATH，用打包运行时）：
   ```powershell
   & $env:MIMO_NODE $env:MIMO_NPM install / test / run build
   ```
4. **dev 服务器启动（两个坑）**：必须带 `IDF_BUILD_DIR`；脱离 MiMo 会话需 `MIMO_ELECTRON_NODE_HOST`，npm shim 会报错——推荐 WMI 直启 vite（命令见 git 历史 8ef1458 或 AGENTS.md）。验证：`GET http://localhost:5173/api/artifacts`。
5. **状态机迁移表在 `src/core/device.ts`** 的 `TRANSITIONS`/`ALLOWED`；改表必须同步 `DESIGN.md` §4.1 + `tests/device.test.ts`。
6. **日志渲染纪律**（洪峰卡页教训）：seq 稳定 key、120ms 批量 flush、显示上限 500、暂停视图——禁止恢复"每行一次响应式更新 + 索引 key"写法（AGENTS 纪律 8）。
7. **烧录后自动硬复位在 `DeviceManager.flash` 临界区内**（写入成功后调 `deps.hardReset()`，F-07）——重构时曾弄丢一次，有断言测试守护，勿删。

## 外部环境快照

- IDF 工具链已迁 D 盘（junction `C:\Espressif → D:\Espressif`）；**esp32s3 multilib 缺失已修复**（idf_tools 重装 xtensa-esp-elf，坏包残留 `xtensa-esp-elf.broken` 待用户确认后可删，约 1.07GB）。
- hello_world 官方示例 target=esp32s3 编译通过，三段产物 flash_args：`0x0 / 0x8000 / 0x10000`。
- npm 缓存/全局在 `D:\dev\npm-cache` / `D:\dev\npm-global`。
- ⚠️ 已知问题：`SHA-256 comparison failed` 启动警告、镜像头 4MB vs 实际 16MB、flash_args 80m vs 启动日志 40MHz——烧录参数生效性待核对（打磨清单）。

## 验收对照（REQUIREMENTS F-xx）

| 需求 | 状态 | 备注 |
|---|---|---|
| F-01 环境自检 | ✅ | 代码+实机浏览器路径 |
| F-02 文件选择 | ✅ | 手动多选 + ⚡一键载入双路径 |
| F-03 manifest | 🔶 | 本地构建载入✅；服务器 manifest JSON ⬜ |
| F-04 连接 | ✅ | 实机 COM3/原生 USB |
| F-05 烧录 | ✅ | 实机三段烧录成功；MD5 校验/降速重试为打磨项 |
| F-06 擦除 | ✅ | 用户实测通过（擦除→重烧→恢复） |
| F-07 自动硬复位 | ✅ | 实机 `Hard resetting` 观测 + 单测断言 |
| F-08 日志 | ✅ | 分级/导出/行切分单测 |
| F-09 状态机 | ✅ | DeviceManager 12 用例（方向1 模型） |
| F-10 错误翻译 | ✅ | 8 用例 |
| F-11 S3 三层复位 | ✅ | 实机自动进下载（未按 BOOT） |
| F-12 芯片信息展示 | ✅ | ConnectPanel 显示 chip 名 |
| F-13 chipFamily 比对 | ⬜ | 随 manifest |
| F-14 地址预设 | ✅ | flash_args 权威地址（不再靠猜） |
| F-15 会话可重复 | ✅ | 实机二次烧录验证 |
| F-16 实时串口日志 | ✅ | 实机验证通过 |
| F-17 设备常驻连接 | 🔄 | 代码+单测完成，**待实机回归** |
| F-18 日志渲染性能 | 🔄 | 代码+单测完成，**待洪峰实测** |

## 下一步

1. **等用户拍板**：主操作按钮方案（推荐映射 vs 字面三按钮）。
2. 实机回归方向1（F-17/F-18）：连接免弹窗二次进入、烧录中日志自动挂起恢复、拔线自动断开、日志洪峰不卡页。
3. T6 收尾：manifest 服务器托管载入 + F-13 校验 → 验收对账关 v1。
4. 打磨清单：烧录参数生效核对（80m/flash size）+ MD5 写入校验 + 连接超时保护。
5. 部署阶段（后置）：静态产物 + HTTPS 三选一 + firmware/ 目录。

## 变更日志

- **2026-09-26（IDF 命令按钮）**：新增 F-19——`/api/build` dev 中间件（spawn PowerShell+EIM profile 跑 `idf.py build/fullclean`，行缓冲+900ms 轮询回传，单飞行/taskkill 中止），页面 [🔨编译][🧹清理][■中止] 按钮，**编译成功自动载入固件段**；冒烟测试 exit 0。探测端点在生产构建下不存在→按钮自动隐藏。
- **2026-09-26（方向1 重构）**：应用户"操作连贯性/COM 口管理"反馈，完成方向1 重构——`DeviceManager` 设备常驻状态机（端口复用免弹窗、连接即自动日志、烧录/擦除临界区自动挂起恢复、拔线感知）；日志渲染性能四项（批量 flush/seq key/显示 500/暂停视图）；修复烧录后自动硬复位回归（F-07 断言守护）。32 测试 + build 全绿；DESIGN/AGENTS/REQUIREMENTS 同步（新增 F-17/F-18）。
- **2026-09-26（深夜）**：全链路实机验收（工具链修复 → S3 编译 → ⚡一键载入 → 三段烧录 → Hello world + 重启循环）；新增 F-16 实时日志监视器。已知问题：SHA-256 启动警告、flash 尺寸/频率参数疑不对齐（待核对）。
- **2026-09-26（晚）**：T4/T5/T6 代码主体完成；设备确认 ESP32-S3 @ COM3（已写全局记忆）；xtensa-esp-elf esp32s3 multilib 缺失修复（idf_tools 重装）。
- **2026-09-26**：T1/T2/T3 完成；PROGRESS/AGENTS 建立。此前：调研报告、DESIGN、REQUIREMENTS、C 盘分析、工具链 junction 迁移。

- **2026-09-26（连接编排修复）**：实测 PortBusy——connect() 路径 detect 后未归还 esptool 端口即 startStream（设计中的 closeEsptool 步骤在连接路径漏执行）。修复+调用序断言（32 测试全绿）。教训：互斥编排只在 runCritical 里做了，connect 也要走同一条编排链。

## 固件项目库扩展（v1.5，2026-09-26 定稿）

- 设计文档：**`FIRMWARE-REGISTRY.md`**（三端架构、数据模型 v3、发布/订阅链、鉴权扩展点、任务拆解 T11–T14）。
- 关键定稿：自含 Node 服务（发布+registry+SSE+静态）；Release=烧录全集快照（含字体等任意文件）；snapshot/release 分层+AI 说明；多芯片 variant；⚡本地构建保留；发布=静态 token（预留多用户命名空间）。
- 任务：T11 服务端 / T12 publish CLI / T13 前端项目库 / T14 端到端验收 —— 均 open，依赖链 T11→{T12,T13}→T14。
