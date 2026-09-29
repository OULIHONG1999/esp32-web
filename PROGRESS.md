# PROGRESS — ESP32 Web Flasher 工作记录

> 本文件是**活的进度表**：每次有意义的推进后更新。新接手的 AI/工程师请先读本文，再读 AGENTS.md。
> 最后更新：2026-09-27（门2 复测：4 项修复真机验证通过；console 根因定位，编译交用户）

## 一句话

单用户自用的 ESP32 网页烧录工具：官方 esptool-js 做内核（只升不改），UI/日志/文件/命令控制全自研；第一目标芯片 ESP32-S3。当前模型：**设备常驻连接（方向1）+ 连接即自动日志监视**。v1.5 走 **`EXECUTION-PLAN.md`**（跨设备固件下载服务：远端 publish → 自含 server → 本地订阅烧录）。

## 文档地图（阅读顺序）

1. `REQUIREMENTS.md` — 6 项决策（D1–D6）+ v1 验收清单（F-01…F-18）
2. `DESIGN.md` — 三层架构、设备状态机（§4.1）、错误分类（§4.4）、部署（§7）
3. `research/esp32-web-flash/REPORT.md` — 选型调研报告（为什么这么做）
4. `AGENTS.md` — 接手纪律与命令
5. `IDF-ENV.md` — IDF 环境激活/命令/坑（本机操作指南）
6. 本文 — 进度与下一步

## 当前状态（任务面板同步）

| 任务 | 状态 | 证据 |
|---|---|---|
| T1 脚手架 Vue3+Vite+TS | ✅ done | build 通过 |
| T2 环境自检（F-01） | ✅ done | `src/env/environment.ts` + EnvCheck |
| T3 核心层（状态机/日志/错误/粘合） | ✅ done | Vitest 全绿 |
| T4 实机连接 | ✅ done | 实测：原生 USB 0x303a:0x1001 识别 ESP32-S3，自动进下载 |
| T5 烧录主链路 | ✅ done | 实测：⚡一键载入三段 → 烧录 → Hello world 重启循环 |
| T6 擦除+manifest 收尾 | ⏸ 并入新线 | 擦除/重烧/日志查看已实测通过；manifest 服务器托管**废弃并入 v1.5 registry 线**（S6'，随 T12/S1 一并做 F-03 另一半、F-13） |
| T7 方向1 设备常驻重构 | ✅ 代码完成 | `core/device.ts` + `glue/deviceOps.ts`，32 测试全绿；**待实机回归** |
| T8 日志渲染性能 | ✅ 代码完成 | 批量 flush + seq key + 显示 500 + 暂停视图；**待实机压测** |
| T9 文档同步 | ✅ done | DESIGN §4.1/§4.2、AGENTS、REQUIREMENTS（F-17/F-18）、本文 |
| T10 IDF 命令按钮（F-19） | ✅ 代码完成 | dev 中间件 `/api/build`（build/fullclean/abort/轮询）+ 🔨🧹■ 按钮 + 编译成功自动载入；冒烟 exit 0；**待实机点按验证** |
| **T11 阶段1 文档+实现债** | ✅ done | 门1 已过（2026-09-27 用户确认 5 项拍板） |
| **T12 S1 最小闭环** | 🔄 门2 进行中 | 代码+e2e+首轮真机（发布→载入→烧录→复位全通）；**复测 4 项修复全过**（80m/2MB 注入、首把成功、D5 三段 verified）；剩 D4 核对+console 切换闭环 |

**待用户决策**：主操作按钮方案——推荐映射「⚡一键烧录 / 查看日志 / 选择文件」vs 字面三按钮（下载 / 下载并查看日志 / 查看日志），见会话记录 2026-09-26。

## 代码结构（2026-09-27 S1 后）

```
src/core/device.ts            # DeviceManager 设备常驻状态机（deps 注入可单测；含 D1 降速重试/D2 超时/D3 clearError）
src/core/log.ts               # Logger 环形缓冲 + seq 序号 + esptool 行分级
src/core/errors.ts            # 七类错误翻译（TimeoutError name 前置分类）
src/core/lines.ts             # 串口行切分器（纯逻辑）
src/glue/esptool.ts           # esptool-js 唯一接触面
src/glue/monitor.ts           # SerialMonitor 实时读取流
src/glue/deviceOps.ts         # DeviceDeps 实现：lastPort 复用 + 流/esptool 互斥 + reopenForRetry（D1 降速重建）
src/composables/useSession.ts # Vue 接线：批量 flush、暂停视图、状态镜像
src/components/               # EnvCheck / ConnectPanel / FirmwarePanel / LogPanel
src/api/buildArtifacts.ts     # ⚡一键载入客户端
src/api/registry.ts           # v1.5 项目库客户端（registry/parts 下载、flattenLatest、flashParams 映射）
server/{config,registry,multipart,publish,app,index}.js  # 自含服务（纯 JS 零依赖 node:http）+ rebuild.js 自愈
tools/publish/{lib,index}.js  # 发布 CLI：flash_args/assets 解析、查缺、multipart 上传（once）
vite.config.ts                # idfBuildArtifacts dev 中间件 + /api/registry* /api/publish* proxy（→8787）
tests/{device,log,errors,lines}.test.ts   # 前端核心 43 用例
tests/{server,publish-cli,e2e}.test.js    # server 17 + CLI 16 + e2e 5 = 38 用例（合计 81 全绿）
tests/fixtures/               # fake-build 四段假 bin + publish.config.json（e2e 用）
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

### 阶段1 实现问题记录（D1–D3，2026-09-26）

8. **D1 降速重试的现实边界**：当前默认波特率 115200 即下限，降速空间为零——重试实际退化为"原速率释放会话 + 重新同步 + 再写一次"（glue 日志明确写"已达下限"）。若未来提高默认波特率（如 460800），降速路径自动生效。重试假设芯片仍停留在下载模式（硬复位只在成功后发生，逻辑不冲突），**实机行为待门2 观察**。
9. **TimeoutError 必须按 name 先于文本分类**：`classifyError` 原有 `/timeout/` 文本规则会把 core 自抛的超时吞进 flash 分类（detect 超时曾差点被误判成 TransferFail）——已改为 `name==='TimeoutError'` 前置分支。教训：core 新增错误一律带特征 `name`，不要依赖 message 文本。
10. **超时覆盖范围（backlog，不插队）**：仅 detect 20s + flash 空闲 60s；`erase` 全片擦除（分钟级、无进度回调）与 `requesting`（用户停留在系统端口选择器）未设超时——按 EXECUTION-PLAN 范围冻结记入 backlog。

### S1 实现问题记录（2026-09-27）

11. **FormData 同名多文件必须 `append`**：`set()` 会覆盖前一个同名字段——曾导致多段上传只剩最后一个文件（测试捕获）。
12. **Node 的 FormData 没有 `arrayBuffer()`**：测试/CLI 侧转字节用 `new Response(fd).arrayBuffer()`（或直接 `fetch body: fd` 由 undici 自动序列化）。
13. **fixtures 路径归一**：EXECUTION-PLAN 原文写 `test/fixtures/`，项目测试目录实为 `tests/`——已统一为 `tests/fixtures/`（计划已同步修正）。
14. **发布互斥锁 409 在当前实现下实际不可达**：`handlePublish` 主体为同步代码，node 单线程天然串行——锁保留为将来异步化的防御；e2e 用"连续两次发布均成功"代理验证无死锁。若未来加入异步步骤需重测 409。
15. **vitest include 扩为 `*.{ts,js}`**：server/ 与 tools/publish 为零依赖纯 JS（不进 vue-tsc），配套测试用 `.js`；前端核心层保持 `.ts`。改 vite.config 的 test.include 时勿回退。

### 门2 首轮实测问题记录（2026-09-27，真机烧录暴露）

16. **方向1 裸会话直接 writeFlash 必失败（已修）**：connect 后 `closeEsptool` 归还端口，flash/erase/hardReset 新建的会话从未 `main()` 同步就发命令 → esptool-js 不会自动同步 → 首把秒败；D1 重试的 `reopenForRetry` 恰好跑了完整 main() 兜底，造成"每次烧录先失败一次"的假象。方向1 后首次实机烧录才暴露（F-17 回归价值的直接证据）。**修复**：glue 加 `ensureSynced()`（新会话首次使用前自动同步），detect/flash/erase/hardReset 四入口全覆盖；`reopenForRetry` 同步维护 synced 状态。
17. **⚡载入 flashParams 字段名失配——D4 疑云真根因（已修）**：dev 中间件返回 `{mode,freq,size}`，前端按 `{flashMode,flashFreq,flashSize}` 消费 → TS 类型撒谎抓不到（vite.config 不在 tsconfig include）→ 参数全落默认 **40m/4MB**，flash_args 的 80m/2MB **从未生效**——历史"80m vs 启动日志 40MHz"疑云即此（烧录实际就按 40m 烧的）。**修复**：中间件改返回 `flashMode/flashFreq/flashSize` + `buildArtifacts.normalizeFlashParams` 双形状归一兜底 + `tests/api.test.ts` 守护。项目库（toFlashParams）路径字段名本就正确。
18. **重试首因不可见（已修）**：D1 重试成功后 `lastError` 被清、首败错误也不进日志——盲区。**修复**：core 重试前经 noticeHandler 写"首次写入失败（原因），自动重建会话重试…"进日志；useSession 不再硬编码"——请重新连接"后缀（拔线默认消息由 core 自带）。附带观察：⚡/项目库载入后**表格只显示段数不显示烧录参数**，参数生效性只能从日志行读——backlog：载入成功提示中带上 mode/freq/size。
19. **"复位后无设备日志" = console 配置使然（非 bug）**：hello_world sdkconfig 为 `CONFIG_ESP_CONSOLE_UART_DEFAULT=y`（console=UART0），USB-Serial/JTAG 口上没有 app 输出——页面日志流开启本身正常。曾以文本替换直改 sdkconfig（备份 `sdkconfig.bak-console`）切到 `USB_SERIAL_JTAG`，`idf.py build` 在 KConfig 重配置阶段 FATAL（stderr 空消息，疑 SECONDARY_NONE/dead UART_NUM 依赖冲突）——**编译已交由用户接管**，后续经 `idf.py menuconfig` 交互修正为宜（工具自动处理 Kconfig 依赖，避免盲改文本）。D4 核对（boot banner 80MHz/2MB）待 console 切换后烧录时在页面日志完成。

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
| F-03 选固件（服务器） | 🔄 | manifest 语义由 **registry 载入取代**（S6'）：项目库 UI+下载+参数注入完成，本地 e2e 过，**待真机** |
| F-04 连接 | ✅ | 实机 COM3/原生 USB |
| F-05 烧录 | ✅ | 实机三段烧录成功；**门2 复测全过**：参数注入 80m/2MB（`Flash params set to 21f`）、首把直接成功（无重试）、D5 三段 `Hash of data verified.`；降速重试机制首轮实测触发成功 |
| F-06 擦除 | ✅ | 用户实测通过（擦除→重烧→恢复） |
| F-07 自动硬复位 | ✅ | 实机 `Hard resetting` 观测 + 单测断言 |
| F-08 日志 | ✅ | 分级/导出/行切分单测 |
| F-09 状态机 | ✅ | DeviceManager 21 用例（方向1 模型 + D1/D2/D3） |
| F-10 错误翻译 | ✅ | 10 用例（含 TimeoutError 分类） |
| F-11 S3 三层复位 | ✅ | 实机自动进下载（未按 BOOT） |
| F-12 芯片信息展示 | ✅ | ConnectPanel 显示 chip 名 |
| F-13 chipFamily 比对 | ⬜ | 随 manifest |
| F-14 地址预设 | ✅ | flash_args 权威地址（不再靠猜） |
| F-15 会话可重复 | ✅ | 实机二次烧录验证 |
| F-16 实时串口日志 | 🔄 | 机制实测正常（烧录前后自动挂起/恢复）；**hello_world console=UART0（sdkconfig），USB 口无 app 输出**——待 console 改 USB Serial/JTAG 后闭环 |
| F-17 设备常驻连接 | 🔄 | 代码+单测完成，**待实机回归** |
| F-18 日志渲染性能 | 🔄 | 代码+单测完成，**待洪峰实测** |
| F-19 IDF 命令按钮 | 🔄 | 代码完成+冒烟 exit 0，**待实机点按** |
| F-20 项目/版本/多芯片变体 | 🔶 | 三层模型+variant 自动归类+latest 载入已实现（S1，e2e 过）；时间线/回滚 UI=S4 |
| F-21 订阅推送 | ⬜ | S3（T14/门4） |
| F-22 任意烧录文件管理 | 🔶 | parts 统一建模+assets 随发布+SHA256 完整（S1）；页面补充上传=S5 |
| F-23 发布 CLI 与自动触发 | 🔶 | `once`+Bearer token+查缺差集已实现（S1，e2e 过）；`--watch`=S2 |
| F-24 版本说明与保留策略 | ⬜ | S4（T15/门5） |

## 下一步

1. **门2 收尾（编译归用户）**：用户完成 hello_world console 切换编译（sdkconfig 已改/备份，KConfig 冲突见问题 19）→ 我 `publish once` 发新 release → 页面载入烧录 → 页面日志核对 **D4**（`boot: SPI Speed: 80MHz / Flash Size: 2MB`）+ 确认 Hello world 实时滚动 → 验收表勾 F-03 等，关门2。
2. 门2 过后 → S2（--watch + Ubuntu 部署 runbook，门3）。
3. 等用户拍板：主操作按钮方案（推荐映射 vs 字面三按钮，见会话记录 2026-09-26）。
3. S1 最小闭环（T12）：server 骨架 + `publish once` + 前端项目库最小版 → **门2 真机**（含 D4 参数生效 / D5 MD5 核对、F-17/F-18/F-19 同批实机回归）。
4. S2 起：--watch + Ubuntu 部署 runbook（门3）；S3 SSE（门4）；S4 版本管理（门5）；S5 按需不排期。
5. 打磨项归属：D4/D5→门2、连接超时→D2、部署方案（纯静态描述已 superseded，见 DESIGN §7 注）→S2 runbook。


## 变更日志

- **2026-09-27（门2 复测通过 + console 根因）**：复测 4 项修复全部真机验证——参数注入 80m/2MB（`Flash params set to 21f`，此前错参数时 220）、首把直接成功（ensureSynced 生效，无重试）、D5 三段 `Hash of data verified.`。"复位后无设备日志"定位为 **console=UART0 配置使然**（非 bug，问题 19）：sdkconfig 已备份并改文本切 USB Serial/JTAG，KConfig 重配置失败，编译交用户接管（menuconfig 修正为宜）。F-05 验收表更新 ✅；F-16 改 🔄（待 console 切换闭环）；F-17/F-18/F-19 同轮真机回归通过。
- **2026-09-27（门2 首轮实测修复）**：真机烧录链路走通（发布→载入→三段烧录→硬复位→D1 重试兜底成功），暴露并修复四问题（记录 16–18 + D5）：① 裸会话未 sync 首把必败——glue `ensureSynced` 四入口；② flashParams 字段名失配（D4 真根因，参数从未生效）——中间件改形状+normalize+单测；③ 重试首因不可见——notice 进日志；④ **D5 实现**——`core/md5.ts` 同步 MD5（node:crypto 对拍 13 长度 + RFC 向量）接入 `calculateMD5Hash`，日志将出现 File md5 / Flash md5 / Hash of data verified.。88 测试 + build 全绿（+@types/node）。烧录后无设备日志输出待查（疑 console=UART0，IDF-ENV §6）。
- **2026-09-27（S1 最小闭环）**：跨设备下载本体（手动版）落地——`server/`（零依赖 node:http：registry 原子读写+ETag、POST publish 鉴权/白名单/SHA256/原子落位/幂等补传、parts 下载双检、静态 SPA、rebuild 自愈）；`tools/publish` once CLI（flash_args+assets 解析、差集查缺、multipart、--release-id）；前端项目库最小版（latest 列表+载入+flashParams 注入）+ vite proxy；fixtures e2e（发布→registry→下载比对→0 上传幂等→401 拒收）5 用例。**81 测试全绿 + build 通过**。新问题记录 11–15。门2 本地部分过，待真机。

- **2026-09-26（阶段1 实现债 D1–D3）**：`fix(v1-debt)`——**D1**：`DeviceDeps.reopenForRetry`（glue：释放会话→波特率/2 下限 115200→重建→重新同步）+ `DeviceManager.flash` 可重试错误降速重试一次（仅一次）；**D2**：`DeviceTimeouts` 注入（detect 20s→error、flash 空闲 60s→ready，进度重置计时，`TimeoutError` name 前置分类）；**D3**：ready+error 态可关闭错误条（`clearError`）+ 临界区成功自动清除。43 测试（+11）+ build 全绿；同步 DESIGN §4.1/§4.4、EXECUTION-PLAN B 组、REQUIREMENTS F-05、本文验收表/问题记录（8–10）。
- **2026-09-26（阶段1 文档同步）**：按 EXECUTION-PLAN 全面同步——FIRMWARE-REGISTRY：新增 §0 技术选型表（与计划 §0 对齐）、§3 API proxy 定案（S1'）、Release 补 `flashParams`（S2'）、§5.4 上传安全+原子写+rebuild.js（S3'/S4'）、§10 任务编号映射注（附加 a）；DESIGN：§7 加 v1.5 自含服务 superseded 注（S6'）、§6 部署行与 §4.6 加路由分流定案（附加 d）；AGENTS：快速入口补执行计划/固件库设计、修重复命令行；REQUIREMENTS：F-05 标注 D1 实现债；EXECUTION-PLAN 状态改"已批准"（附加 c）；本文：T6 并入新线（S6'）、新增 T11、验收表补 F-19…F-24（附加 b）、下一步重排。
- **2026-09-26（IDF 命令按钮）**：新增 F-19——`/api/build` dev 中间件（spawn PowerShell+EIM profile 跑 `idf.py build/fullclean`，行缓冲+900ms 轮询回传，单飞行/taskkill 中止），页面 [🔨编译][🧹清理][■中止] 按钮，**编译成功自动载入固件段**；冒烟测试 exit 0。探测端点在生产构建下不存在→按钮自动隐藏。
- **2026-09-26（方向1 重构）**：应用户"操作连贯性/COM 口管理"反馈，完成方向1 重构——`DeviceManager` 设备常驻状态机（端口复用免弹窗、连接即自动日志、烧录/擦除临界区自动挂起恢复、拔线感知）；日志渲染性能四项（批量 flush/seq key/显示 500/暂停视图）；修复烧录后自动硬复位回归（F-07 断言守护）。32 测试 + build 全绿；DESIGN/AGENTS/REQUIREMENTS 同步（新增 F-17/F-18）。
- **2026-09-26（深夜）**：全链路实机验收（工具链修复 → S3 编译 → ⚡一键载入 → 三段烧录 → Hello world + 重启循环）；新增 F-16 实时日志监视器。已知问题：SHA-256 启动警告、flash 尺寸/频率参数疑不对齐（待核对）。
- **2026-09-26（晚）**：T4/T5/T6 代码主体完成；设备确认 ESP32-S3 @ COM3（已写全局记忆）；xtensa-esp-elf esp32s3 multilib 缺失修复（idf_tools 重装）。
- **2026-09-26**：T1/T2/T3 完成；PROGRESS/AGENTS 建立。此前：调研报告、DESIGN、REQUIREMENTS、C 盘分析、工具链 junction 迁移。

- **2026-09-26（连接编排修复）**：实测 PortBusy——connect() 路径 detect 后未归还 esptool 端口即 startStream（设计中的 closeEsptool 步骤在连接路径漏执行）。修复+调用序断言（32 测试全绿）。教训：互斥编排只在 runCritical 里做了，connect 也要走同一条编排链。

## 固件项目库扩展（v1.5，2026-09-26 定稿）

- 设计文档：**`FIRMWARE-REGISTRY.md`**（三端架构、数据模型 v3、发布/订阅链、鉴权扩展点、任务拆解 T11–T14）。
- 关键定稿：自含 Node 服务（发布+registry+SSE+静态）；Release=烧录全集快照（含字体等任意文件）；snapshot/release 分层+AI 说明；多芯片 variant；⚡本地构建保留；发布=静态 token（预留多用户命名空间）。
- 任务（旧编号已作废，以 EXECUTION-PLAN §5 为准）：原 T11–T14 服务端/CLI/前端/验收重排为 **T11=阶段1 → T12=S1 → T13=S2 → T14=S3 → T15=S4 → T16=S5**。

## 执行计划与接力（2026-09-26 更新）

- **执行计划（唯一权威线路）：`EXECUTION-PLAN.md`** —— 分片路线 + 五道验收门 + 全量问题清单（S1'–S6' 结构性 / D1–D5 实现债 / 风险表）+ 每阶段实现流程。
- 任务面板映射（面板跨会话会丢，以此为准）：**T11=阶段1（文档修订+D1–D3，门1）→ T12=S1 最小闭环（门2 含真机+D4/D5）→ T13=S2 watch+部署（门3）→ T14=S3 订阅（门4）→ T15=S4 版本管理（门5）→ T16=S5 可选（不排期）**。
- 项目状态：阶段1（门1 ✅）+ S1 代码/本地 e2e ✅ + **门2 复测 4 项修复真机验证通过**；剩 D4 核对与 console 切换闭环（编译归用户）→ 过门2 进 S2。
