# PROGRESS — ESP32 Web Flasher 工作记录

> 本文件是**活的进度表**：每次有意义的推进后更新。新接手的 AI/工程师请先读本文，再读 AGENTS.md。
> 最后更新：2026-10-06（**OTA 三端推进**：独立页 `/OTA` + 服务器四端点 + 设备接入文档/模拟器均已上线；页面 mock 假数据已移除，只读实时接口）

## 一句话

单用户自用的 ESP32 网页烧录工具：官方 esptool-js 做内核（只升不改），UI/日志/文件/命令控制全自研；第一目标芯片 ESP32-S3。当前模型：**设备常驻连接（方向1）+ 连接即自动日志监视**。v1.5 走 **`EXECUTION-PLAN.md`**（跨设备固件下载服务：远端 publish → 自含 server → 本地订阅烧录）。

## 文档地图（阅读顺序 · 2026-10-03 文档重整后）

> 组织：`docs/` 现行 · `docs/archive/` 开发历史产出 · `docs/research/` 专题调研 · 根目录仅 README/AGENTS/PROGRESS。
> **改文档改 `docs/` 源头，改完同步拷贝到 `public/docs/`（公网 /docs/ 由 build 从 public 拷入 dist）。**

0. **`README.md` — 方案总览（一页纸入口：能力/架构图/快速开始/文档导航）**
1. **`docs/USER-GUIDE.md` — 使用手册（操作者：三分钟上手/监视语义/取证操作卡）**
2. `docs/REQUIREMENTS.md` — 6 项决策（D1–D6）+ 验收清单（F-01…F-24）
3. `docs/DESIGN.md` — 架构/状态机（§4.1）/错误（§4.4）/UI 五区（§4.5）/部署
4. `AGENTS.md` — 接手纪律与命令
5. `docs/DEPLOY.md`（含本机快速路径）+ `docs/SERVER.md`（部署快照）
6. `docs/PUBLISH.md` — 发布指南
7. `docs/TROUBLESHOOTING.md` — 故障排查
8. `docs/FIRMWARE-REGISTRY.md` — v1.5 固件库设计
9. **`docs/ota.md` — OTA 三端设计契约（设备/云端/页面）；页面端已落地为独立页 `/OTA`（§6.0）**
10. `docs/research/*/REPORT.md` — 选型与复位能力调研（现行参考）
11. `docs/archive/README.md` — 历史产出索引（EXECUTION-PLAN/PAGE-REDESIGN/IDF-ENV/实测报告等）
12. 本文 — 进度与下一步

## 当前状态（任务面板同步）

| 任务 | 状态 | 证据 |
|---|---|---|
| T1 脚手架 Vue3+Vite+TS | ✅ done | build 通过 |
| T2 环境自检（F-01） | ✅ done | `src/env/environment.ts` + EnvCheck；2026-10-06 修正为**根因优先级单条上报** + 现场信息（origin/浏览器/iframe），`tests/environment.test.ts` 16 用例 |
| T3 核心层（状态机/日志/错误/粘合） | ✅ done | Vitest 全绿 |
| T4 实机连接 | ✅ done | 实测：原生 USB 0x303a:0x1001 识别 ESP32-S3，自动进下载 |
| T5 烧录主链路 | ✅ done | 实测：⚡一键载入三段 → 烧录 → Hello world 重启循环 |
| T6 擦除+manifest 收尾 | ⏸ 并入新线 | 擦除/重烧/日志查看已实测通过；manifest 服务器托管**废弃并入 v1.5 registry 线**（S6'，随 T12/S1 一并做 F-03 另一半、F-13） |
| T7 方向1 设备常驻重构 | ✅ 代码完成 | `core/device.ts` + `glue/deviceOps.ts`，32 测试全绿；**待实机回归** |
| T8 日志渲染性能 | ✅ 代码完成 | 批量 flush + seq key + 显示 500 + 暂停视图；**待实机压测** |
| T9 文档同步 | ✅ done | DESIGN §4.1/§4.2、AGENTS、REQUIREMENTS（F-17/F-18）、本文 |
| T10 IDF 命令按钮（F-19） | ✖ 已移除 | 2026-09-29 随页面功能优化整体删除（历史：dev 中间件+按钮+自动载入） |

| **T11 阶段1 文档+实现债** | ✅ done | 门1 已过（2026-09-27 用户确认 5 项拍板） |
| **T12 S1 最小闭环** | 🔄 门2 进行中 | 代码+e2e+首轮真机（发布→载入→烧录→复位全通）；**复测 4 项修复全过**（80m/2MB 注入、首把成功、D5 三段 verified）；D4/console 核对**用户暂缓**（现有编译结果可用），不阻塞 S2 |
| **S2 自动发布+部署** | ✅ 门3 已过 | watch 自动发布+增量 0 上传+服务器部署+隧道全通；**浏览器确认：localhost:8787 页面载入远端版本、80m/2MB 注入（2026-09-29 用户日志）**；HTTPS/域名解析为尾巴（不阻塞） |
| **S3 SSE 订阅** | ✅ 门4 已过 | 用户确认横幅+●NEW（20260929-2029）；SSE hub/广播/subscribe/前端横幅/角标/★开关/轮询降级全实测；108 测试全绿；文档挂载公网 /docs/ |
| **S4 版本管理** | ✅ 门5 已过 | server promote/回滚/retention（Bearer 鉴权）+CLI `promote --note`+前端时间线（晋升/回滚/保留数确认/F-13 芯片比对）+SSE promote/latest 刷新+parts 分区类型 type/subType；115 测试+build 全绿；**用户实测：流程基本跑通、日志可用（2026-09-29）** |

| **OTA 三端（页面+服务器）** | ✅ 页面与服务器就绪 | 页面 `/OTA`（`public/ota/`）+ 描述符 `/ota.json` + 契约 `docs/ota.md` + 静态托管 8 用例；**服务器四端点已实现**（`server/devices.js` 存储 + `app.js` 接线，`tests/devices.test.js` 30 用例）；设备模拟器 `tools/device-sim/`（12 用例）+ **端到端 24/24 实测**（上报→派发→投递→下载→sha256 校验→回执→版本回写，含重投递/409+force/篡改失败）。**未实现：设备端固件（在另一台电脑上开发）**，其入口文档为 `docs/DEVICE-OTA.md`。注：全量套件 1 红在 `tests/progress.test.ts`（烧录进度在途改动，非本次引入） |

**待用户决策**：主操作按钮方案——推荐映射「⚡一键烧录 / 查看日志 / 选择文件」vs 字面三按钮（下载 / 下载并查看日志 / 查看日志），见会话记录 2026-09-26。

## 代码结构（2026-09-27 S1 后）

```
src/core/device.ts            # DeviceManager 设备常驻状态机（deps 注入可单测；含 D1 降速重试/D2 超时/D3 clearError）
src/core/log.ts               # Logger 环形缓冲 + seq 序号 + esptool 行分级
src/core/errors.ts            # 七类错误翻译（TimeoutError name 前置分类）
src/core/lines.ts             # 串口行切分器（纯逻辑）
src/core/zip.ts               # STORE zip 生成器（N7 导出固件包，零依赖可单测）
src/core/firmwarePack.ts      # flash_args/README 文本生成（N7）
src/glue/esptool.ts           # esptool-js 唯一接触面
src/glue/monitor.ts           # SerialMonitor 实时读取流
src/glue/deviceOps.ts         # DeviceDeps 实现：lastPort 复用 + 流/esptool 互斥 + reopenForRetry（D1 降速重建）
src/composables/useSession.ts # Vue 接线：批量 flush、暂停视图、状态镜像
src/composables/useFirmwareWorkspace.ts # 固件工作区单例（rows+registry 侧栏树/固件页/时间线共享）
src/composables/useServiceStatus.ts # /api/status 单例快照（side-card + 状态栏共用）
src/components/ide/           # 五区组件：ActivityBar/Sidebar/TreeSection/TreeItem/EditorTabs/BottomPanel/StatusBar
src/components/               # EnvCheck / FirmwarePanel / LogPanel / FlashHistory / VersionTimeline / ide/(五区组件)

src/api/registry.ts           # v1.5 项目库客户端（registry/parts 下载、flattenLatest、flashParams 映射）
public/ota/{index.html,ota.css,ota.js}  # OTA 独立页（服务 ip/OTA；原生 JS 零依赖，不进主 SPA 构建）
public/ota.json               # OTA 页机器描述符（AI 入口；tool_id=ota-console）
server/{config,registry,multipart,publish,app,index}.js  # 自含服务（纯 JS 零依赖 node:http）+ rebuild.js 自愈（serveStatic 含 /OTA 归一 + 目录 index.html）
tools/publish/{lib,index}.js  # 发布 CLI：flash_args/assets 解析、查缺、multipart 上传（once）
vite.config.ts                # /api/registry* /api/publish* proxy（→8787；dev 中间件已移除）
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
4. **dev 服务器启动（坑已减一）**：`IDF_BUILD_DIR` 已随 artifacts 中间件移除（2026-09-29），不再需要；脱离 MiMo 会话需 `MIMO_ELECTRON_NODE_HOST`，npm shim 会报错——推荐 WMI 直启 vite（命令见 git 历史 8ef1458 或 AGENTS.md）。验证：`GET http://localhost:5173/api/registry`（需本地 server 起着）。
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
20. **watch 后台进程网络失败（未定位，backlog）**：`Start-Process` 起的 watch 持续 `fetch failed`（err.cause 为空、无代理 env、服务器无封禁痕迹、探针脚本同样挂起），而**同一 shell 前台 `publish once` 始终成功**（门4 期间 2019/2020/2027/2029 连发成功）。逻辑本身有 7 个单测守护——判断为**运行环境差异**（疑安全软件/进程会话网络策略）。**处置：发布一律用手动 once（可靠）**；watch 恢复自动化待查（S2 收尾/backlog）。
21. **PowerShell 5.1 编码双坑（已踩，勿再犯）**：① `Get-Content` 不带 `-Encoding` 按 ANSI 读 UTF-8 中文 → `Set-Content` 写回=**双重编码写坏**；② `Set-Content -Encoding UTF8`=**带 BOM**，Node JSON.parse 报 `Unexpected token '﻿'`。**正解**：`[IO.File]::ReadAllText/WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))`，或用 Node/Write 工具写含中文的 JSON。
22. **Web Locks 判定时序 bug（门2 后线上误报，已修）**：`tryAcquire` 用 `setTimeout(0)` 等锁 callback 决策——callback 调度晚于定时器时 ①误报"被其它标签占用"②锁已实际拿到却记为失败（**幽灵锁**）→ 后续每次重试都撞自己这把无人认领的锁 = **自锁死，连续连接必失败**（用户实测连续 3 次全拒）。**修复**：granted/rejected 的 resolve 全部移到 callback **内部**（零时序赌博）+ 失败后 30ms 短重试一次（覆盖"自己刚 release、锁未回收"重入窗口）+ 延迟调度回归测试。教训：**异步原语的判定必须发生在回调内，禁止用定时器赌调度顺序**。
23. **拔线后句柄残留 → 重连必须刷新（已修）**：`SerialMonitor.readLoop` 出错路径 ①不置 `running=false`（循环风暴重复报错）②**从不 `port.close()`**——Web Serial 句柄残留，下次 `port.open()` 报错、只能刷新页面（用户 22:17 实测）。**修复双保险**：monitor 错误即自终止+关端口；deviceOps 加 `preparePort()`（detect/ensureSynced/startStream/reopenForRetry 四入口强制归零残留句柄，命中时打日志）。同轮按用户要求**移除 IDF 编译命令块**（🔨🧹■ + useIdfBuild 接线，⚡载入本地构建保留）。122 测试+build 全绿。注：烧录后仍无设备输出 = 问题 19（menuconfig 未做，非本 bug）。
24. **进度口径与 tracing 洪峰（2026-10-06 用户报「烧录卡住到一半」）**：① `reportProgress(fileIndex, written, bytesTotal)` 的三个数字都按**压缩后**字节给（`compress:true` 时 `written` 是已发压缩字节、`bytesTotal` 是该段压缩长度），而整体进度的分母是**未压缩**总量——分子压缩、分母未压缩，2MB app 段 deflate 后约剩一半，进度条在这最长的一段最多爬到 ~50%，且 `device.progress` 不随烧录结束清空，于是**烧完永久停在半途**（表现为"卡住"）。**纪律：跨压缩使用 esptool 进度时必须走段内比例换算**（`core/progress.ts` 的 `overallWritten`），不要直接把 `written` 加进真实字节。② `new Transport(port, true)` 打开的是 **tracing**：每次读写都做 hex dump 进 `console.log` 并把内容追加进 `traceLog` 字符串（无界）——16KB/块、2MB 固件就是数 MB 字符串洪峰，开 DevTools 时足以让主线程假死；**Transport 第二参必须为 false**（要调试就用 `LoaderOptions.debugLogging`，别再开 tracing）。

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
| F-01 环境自检 | ✅ | 代码+实机浏览器路径；同一根因只报一条（非安全上下文不再另报「浏览器不支持」）+ 显示现场 |
| F-02 文件选择 | ✅ | 手动多选 + 项目库载入（⚡本地一键载入已移除） |
| F-03 选固件（服务器） | 🔄 | manifest 语义由 **registry 载入取代**（S6'）：项目库 UI+下载+参数注入完成，本地 e2e 过，**待真机** |
| F-04 连接 | ✅ | 实机 COM3/原生 USB |
| F-05 烧录 | ✅ | 实机三段烧录成功；**门2 复测全过**：参数注入 80m/2MB（`Flash params set to 21f`）、首把直接成功（无重试）、D5 三段 `Hash of data verified.`；降速重试机制首轮实测触发成功 |
| F-06 擦除 | ✅ | 用户实测通过（擦除→重烧→恢复） |
| F-07 自动硬复位 | ✅ | 实机 `Hard resetting` 观测 + 单测断言 |
| F-08 日志 | ✅ | 分级/导出/行切分单测 |
| F-09 状态机 | ✅ | DeviceManager 21 用例（方向1 模型 + D1/D2/D3） |
| F-10 错误翻译 | ✅ | 10 用例（含 TimeoutError 分类） |
| F-11 S3 三层复位 | ✅ | 实机自动进下载（未按 BOOT） |
| F-12 芯片信息展示 | ✅ | 检测即读 MAC/Revision/Flash 容量入 ChipInfo（失败缺省）+ 设备面板详情卡 + **烧录前二次确认**（段数/字节/地址清单）——本轮补全 |
| F-13 chipFamily 比对 | ✅ | S4 实现：载入时 chipFamily≠实测 → confirm 警告不阻断；门5 实测顺带验证 |
| F-14 地址预设 | ✅ | flash_args 权威地址（不再靠猜） |
| F-15 会话可重复 | ✅ | 实机二次烧录验证 |
| F-16 实时串口日志 | ✅ | console 问题19 已关；N4 默认关（streamWanted 跨重连保持）；**R-1 对齐 idf monitor**：开监视自动硬复位抓全启动日志 +「↻ 复位」信号复位不断流；独立窗口已按用户要求移除 |
| F-17 设备常驻连接 | 🔄 | 代码+单测完成，**待实机回归** |
| F-18 日志渲染性能 | 🔄 | 代码+单测完成，**待洪峰实测** |
| F-19 IDF 命令按钮 | ✖ 已移除 | 2026-09-29 应用户要求整体删除（云端部署后失效）：按钮/useIdfBuild/vite 中间件/tests 全清；DESIGN §4.6 同步 |

| F-20 项目/版本/多芯片变体 | ✅ | S4 三层+latest 载入+回滚(设 latest)+版本时间线；门5 用户实测流程跑通 |
| F-21 订阅推送 | ✅ | 门4 用户实测（横幅+查看+●NEW）：SSE+30s 轮询降级+★开关双写+心跳；nginx 经 IP HTTPS 实测无缓冲 |
| F-22 任意烧录文件管理 | 🔄 | S4 增强：parts 统一建模+assets 随发布+**分区类型 type/subType**（partition-table 解析/声明/前端列，向后兼容缺省）；页面补充上传=S5 |
| F-23 发布 CLI 与自动触发 | ✅ | `once`+`--watch`+Bearer token+增量（跨 release 0 上传实测）+flash_args/assets 识别——门3 全链实测（2026-09-29） |
| F-24 版本说明与保留策略 | ✅ | S4 promote 必填 note（CLI+页面）+retention 设置/预览/发布后自动清理（releases 永不删）；门5 用户实测 |

## 下一步

1. **页面功能优化（进行中）**：门5 过、v1.5 核心关账——当前阶段=收集用户对页面功能的优化建议并落地。
2. **等实机复测（2026-10-06「卡住到一半」修复后）**：插板烧一次，核对 ①进度条能走到 100% 并消失（不再停在半途）②完成/失败提示音是否响（状态栏 🔊 开着）③日志每 5s 的 `写入进度 N%…` 心跳与异常时的 ⚠「已 15s 无写入进度——卡在第 N/M 段」；若仍卡，把这两行日志贴回来定位。
2. **硬复位按钮不可用（2026-10-02 用户报告，backlog 待查）**：页面点击无响应——先记录不动，排查方向：runCritical assert / glue hardReset 序列。
3. **watch 后台网络问题（问题 20，backlog）**：发布暂用手动 once；根因定位（疑进程会话网络策略/安全软件）。
3. **HTTPS 尾巴**：文档已挂 `https://firmware.example.com/docs/`（DEPLOY/FIRMWARE-REGISTRY/REQUIREMENTS）；后续可加使用说明页。
4. **门2 挂起项（用户暂缓）**：D4/boot 日志核对——console 已切（问题19 关闭），恢复时一并做。
5. 等用户拍板：主操作按钮方案（见会话记录 2026-09-26）。
7. S5 页面补充上传：按需不排期。


## 变更日志
- **2026-10-06（部署上线 + 打包脚本修坑）**：按纪律 9 走完云端部署——build（bundle `index-DPC6vB74`）→ `tools/package-deploy.ps1` → scp → 远端 unzip → `systemctl restart firmware-server`。**核对通过**：`ExecMainStartTimestamp` 00:19:11 → **19:59:08**（新 PID 3166615）；HTTP 与 HTTPS 入口页面均引用 `index-DPC6vB74.js`；`/api/status`、`/api/devices`、`/OTA`、`/llms.txt` 全 200；新 JS 资源 200（306 KB）。踩坑与修复：
  ① `Compress-Archive` 在 Windows 写 `\` 作路径分隔符 → 远端 `unzip` 报 backslash 警告并**以退出码 1 结束**，`unzip && systemctl restart` 链在此中断——文件解出来了、服务却没重启（正是 SERVER.md 记过的「unzip 成功≠进程重启」，本次复现）。改为脚本自建 zip、显式写 `/` 条目名，并加产出自检（条目数 / 反斜杠数 / 体积），远端实测 `unzip_exit=0`。
  ② 编辑 `.ps1` 会丢掉 UTF-8 **BOM** → PowerShell 5.1 按 ANSI 读中文注释乱码、引号错位直接解析失败（问题 21 的变体）。**纪律：改完 `.ps1` 必须确认前 3 字节是 239,187,191**。
  ③ `ZipArchive/ZipArchiveMode` 在 `System.IO.Compression`、`ZipFileExtensions` 在 `System.IO.Compression.FileSystem`——两个程序集都要 `Add-Type`；只加后者时 `New-Object` 静默失败并产出 **0 字节 zip**（中央目录损坏）。脚本已加 `$ErrorActionPreference='Stop'` + 产出后自检兜住。
  ⚠ **注意：本次部署包带上了未提交代码**——打包取的是**工作区**的 `server/`，其中 `server/app.js`（+157 行：`/api/devices*` 路由等）与 `server/devices.js` 都是**并行会话尚未提交**的 OTA 后端改动，即**线上 `/api/devices` 现在跑的是未提交代码**（本地冒烟 + 线上 200 均已验证可用）。经核实 **HEAD 的 `server/app.js` 不含 devices 引用**（与本文开头「服务器端 `/api/devices*` 尚未实现」一致），所以不存在「已提交代码引用未跟踪文件」的不自洽；但**这些改动提交时 `app.js` 与 `devices.js` 必须一起提交**，只提一个会让 HEAD 变成启动即崩（`ERR_MODULE_NOT_FOUND` → systemd 重启循环）。**→ 已满足**：`e5acf98` 同时提交了这两个文件，HEAD 自洽可启动。

- **2026-10-06（「烧录卡住到一半」根因修复 + 提示音 + 清单控件瘦身）**：用户报「烧录经常卡住到一半，不知道为什么」——查出**两条独立原因**，都在自研层，与 esptool-js 本身无关：
  ① **进度口径不一致（观感"卡住"的主因）**：`reportProgress` 的 `written/bytesTotal` 是**压缩后**字节（`compress:true`），而分母是**未压缩**总量（各段 `data.byteLength` 之和）。2MB app 段 deflate 后约剩一半 → 进度条在最长的这一段最多爬到 ~50%，且 `device.progress` 结束后不清空 → **烧完永久停在半途**。新增 `core/progress.ts`（纯函数：按段内比例换算回真实字节，+8 单测），glue 调用；新增 `DeviceManager.clearProgress()` + useSession `finally` 结束时清 → 进度条正确走满再消失。
  ② **esptool Transport tracing 开着**：`openSession` 里是 `new Transport(port, true)`——每写一个 16KB 块就把整块 hex dump 进 `console.log`，并往 `traceLog` 字符串无界累积，一次 2MB 烧录就是数 MB 字符串洪峰，开 DevTools 时主线程被拖到假死。改 `false`（带注释说明为何不能开）。
  ③ **卡死可观测**：glue 烧录期间每 5s 检查——进度推进 ≥5% 打一行心跳（百分比/段号/已写/已用），15s 无进度打 ⚠ 告警（写明卡在第几段、已写多少），随后由 60s 空闲超时判失败；完成日志带总耗时。以后卡住直接看日志最后两行。
  ④ **提示音**：`glue/audioFeedback.ts`（Web Audio 合成，零音频文件）——完成=上行三音 C5→E5→G5，失败=双低音下行 G4→E4。**关键修复**：完成音发生在点击后数分钟，手势早已过期，直接 new AudioContext 会被自动播放策略挂起=没声音；改为首次 `pointerdown/keydown` 即 `primeAudio()` 解锁。状态栏右侧 🔊/🔇 静音开关（localStorage `fw.sound`）。面板新增**烧录回执行**（✅完成/❌失败 · 段数 · 字节 · 耗时）。
  ⑤ **清单控件瘦身**：原 5 张参数卡 + 6 个平铺按钮 + 2 行提示 → **一行参数条**（模式/频率/容量/芯片/合计）+ **⚡烧录 + ＋添加bin + ⋯更多菜单**（原生 `<details>`，收 完全擦除/硬复位/重新载入/导出固件包，点外部自动收起）+ 1 行短提示；删掉冗余 `<h2>烧录清单</h2>` 与死样式。**158 测试 + build 全绿**。
  未做：实机复测（待用户插板验证心跳行/提示音）、UI 视觉核验（本机无 Playwright 浏览器，未截图）。

- **2026-10-06（环境自检的误导性双报修正：同因只报一条 + 显示现场）**：用户贴来页面自检面板，两条失败并列——「安全上下文 失败」＋「Web Serial API 不可用 · 浏览器不支持 Web Serial API（navigator.serial 不存在）」。定位为**旧代码把同一根因报了两遍，且第二遍把责任推给浏览器**：Chrome 只在安全上下文里暴露 `navigator.serial`，所以「非安全上下文」必然连带 API 缺失，于是「换浏览器」的提示方向完全错了（用户多半只是用 `http://<IP>` 打开了站点）。根因确认口径：MDN《Secure contexts》——潜在可信来源**只看 scheme 与主机**（`https`/`wss`/`file`、`localhost`、`127.0.0.0/8`、`::1`），**与证书是否有效无关**，故「自签证书点继续访问也算 https」成立；而明文 `http://` 的 IP/域名无解（旧提示里把「自签放行」与「flag 豁免」并列，容易读成两者都要）。修复：① `checkEnvironment` 改为**根因优先级、只产一条**——`!isSecureContext` → `insecure`（消息里明确「Web Serial 那一项的失败是这条的后果，不是浏览器不支持」）；安全上下文但缺 API 且在 iframe 内 → `embedded`（先排除内嵌/Permissions-Policy）；否则才是 `no-serial`。② 报告新增**现场**字段 `origin` / `inIframe` / `browser`（UA 解析为 `Chrome 141` 这类短标识），引导页直接显示「现场：http://… · Chrome 141」，排查不必再问「你用什么打开的」；并列出**能通过自检的两种打开方式**（https 自签放行 / localhost）。③ 新增 `tests/environment.test.ts`（16 用例）——**其中一条就是本次的防回归**：非安全上下文 + 无 serial 必须恰好 1 条且 id=`insecure`；写测试时还当场抓到 `describeBrowser` 的真缺陷（Edge 的 UA 里也含 `Chrome/<版本>`，取「第一个命中」会认成 Chrome），改为按优先级匹配（iOS Safari 的 `Version/x Mobile/… Safari/` 同理，已一并覆盖）。④ **面板真实渲染校验**：临时用 `vite build --ssr` 把 `EnvCheck.vue` 渲成 HTML，跑四种根因（明文 http／https+内嵌／https+不支持／正常）逐条看输出——「受上项影响」只在非安全上下文时出现、现场行与两种打开方式按预期渲染，跑完即删。⑤ 文档同步：DESIGN §7（判定优先级写进部署节）+ §4.4 `PermissionDenied` 行、REQUIREMENTS F-01、USER-GUIDE §0、TROUBLESHOOTING 新增 §5、本文档。**223 测试 + build 全绿**。**已部署（纪律 9）**：`package-deploy.ps1`（57 文件、无 node_modules）→ scp → 远端 unzip → restart；`ExecMainStartTimestamp` 21:44:23 → **21:56:39 CST**、`active`；外网 https 与 http:80 入口 bundle **均为 `index-BGILbUos.js`**、逐条 200（`/`、`/OTA`、`/docs/{TROUBLESHOOTING,USER-GUIDE}.md`、`/api/status`、`/api/devices`），远端 bundle 内 `grep 受上项影响` = 1、`dist/docs/TROUBLESHOOTING.md` 含新 §5。
- **2026-10-06（Token 自助化 + 打包新鲜度自检）**：用户反馈「token 好麻烦，不知道怎么搞」——先确认机制真相：主站与 `/OTA` **用的是同一个 localStorage 键 `fw.token`**（同源共用），所以在主站 🔑 设过一次，`/OTA` 自动就有，不需要两处各填一遍；痛点是「去哪拿」而非机制。处置：① **页面内自助指引**——Token 框下加 `hintline`：说明「设一次长期有效 + 与主站共用 `fw.token`」并给出两条路径（打开主站首页 → 右上角 🔑 生成；或直接粘贴 `wk_` 工作 token）。② **代生成一个工作 token** 交给用户（用服务器 env 里的主 token 换，全程不显示主 token；`POST /api/token` note=`owner-one-click-web`），并用**非破坏性方式**验证它过鉴权（故意用不存在的 releaseId：真 token 返回 **404 release not found**、假 token 返回 401，从而不留任何命令）。③ **打包脚本加新鲜度自检**（`tools/package-deploy.ps1`）：`dist/index.html` 必须晚于 `src/`+`public/` 的最新改动，否则 **throw 拒绝打包**并提示「先 npm run build（vue-tsc 失败会静默跳过 vite build）」。**这条是本次真踩的坑**：改完 `public/ota/index.html` 后那次 `npm run build` 失败被输出截断吞掉，打包脚本照样把**上一版 dist** 打了进去，部署成功、改动却不生效（线上 grep `hintline` = 0）。已实测该自检会拦住（故意 touch 让 public 比 dist 新 → 明确 throw），另：编辑 `.ps1` 又丢了一次 BOM（问题 21 同款），已补回 `239,187,191`。④ **附带确认设备端已跑通全链路**：`b81f3fc8768c` 有三条命令记录——`cmd_12bd9b` 完整 OTA（delivered 13:02:26 → finished 13:02:56，`detail=OTA ok, rebooted to 20261006-1237-cb5ebb`），另两条 `detail=already running this release`（**幂等也实现了**）。**观察**：该设备 `firmwareVersion` 始终报 `0.4.0`，OTA 后没变——说明其 `PROJECT_VER` 未随发布更新（不影响回执，但页面显示的版本会滞后）。
- **2026-10-06（移除 /OTA 页的 mock 假数据：只读实时接口）**：真设备已在线上报，页面里的内置假设备失去意义，按用户要求**整体移除 mock 模式**——① 删掉 `mockDevices()/mockRegistry()/loadMock()/mockDispatch()` 与顶栏 **mock/real 开关**、`localStorage.ota.mode` 持久化、`state.mode` 全部分支；`loadReal`→`loadData`、`realDispatch`→`dispatchCommand`，页面只走一条实时数据路径（每 5s 拉 `/api/devices` + `/api/registry`）。② 原来显示「数据源 mock」的胶囊**改造成连接状态**（`connState`：已连接 / 连接失败）——这补上了一个真实缺口：此前「服务器连不上」与「确实没有设备」在页面上长得一样，现在能区分（失败时附原因提示）。③ 文案同步：速读区改「数据全部来自服务器实时接口，无本地假数据」、空态改「设备端第一次 report 后就会出现」、去掉「切回 mock」类提示；`ota.json` 删 `page_modes` 改 `data_source{mode:live only}`、status 改为「服务器+页面已实现并上线，仅设备端固件未做」；`ota.md` §6.0「数据源」行重写 + §6.1 去掉「服务器就绪前用 mock」的测试建议（改为指向 `tools/device-sim/` 模拟器）；`SERVER.md` §3 通道行、`DEVICE-OTA.md` §9.3「切到 real 模式」措辞、`llms.txt` 描述符说明一并同步。④ 新增回归守卫 `static-pages.test.js`「/OTA 页不含本地假数据与模式开关」（守 `modeToggle`/`mockDevices`/`mockRegistry`/`loadMock`/`MODE_KEY` 不得回归）。**注**：`tools/device-sim/` 是给设备端做的**测试工具**、与页面假数据无关，保留不动。
- **2026-10-06（修复 /OTA 页下发必然 401：漏接鉴权 + 误导文案）**：用户实测「下发失败：HTTP 401 …（服务器端 /api/devices 可能尚未实现）」。定位为**我这个页面的两个问题叠加**——① `realDispatch` **根本没带 `Authorization` 头**（写页面时后端还不存在，token 一直没接线），所以 real 模式下发**永远 401**，跟 token 有无无关；② 错误文案把 401 说成「服务器端可能尚未实现」，**把鉴权失败误导成功能缺失**，方向完全错了。修复：**token 接线**（新增 Token 输入框，存 `localStorage.fw.token`——与主站同一个键，主站 🔑 设过的直接可用；请求带 `Authorization: Bearer`；无 token 时前置拦截并聚焦输入框，不发无效请求）＋ **按状态码给可操作提示**（401→填 token、409→提示勾「顶替未决命令」、404→release 不存在、其他→透传服务端 error）＋ 新增 **force 顶替复选框** ＋ Token 状态徽标（已设置/未设置会 401/mock 不需要）。同步：`ota.json` 补 `auth` 段与 `dispatch_command.errors` 各码含义、`negotiated` 实现状态；`ota.md` §6.0 增「鉴权」「失败提示」两行；页面 `#ai-data` 补 auth 与错误码；页脚补 DEVICE-OTA 入口。**验证**：DOM 桩 16/16（token 从 `fw.token` 读入、确带 Bearer、force 进 body、401/409/404 文案分流、无 token 前置拦截）；`tests/static-pages.test.js` +2 回归守卫（守住 token 输入/Authorization/`fw.token` 接线与描述符如实声明，防这类「漏接线」复发）。**附**：核对线上时发现**真设备已在线**（`b81f3fc8768c` · ESP32-S3 · 固件 `0.4.0` · SDK `v6.0.1-dirty` · IP `10.233.68.224`），说明设备端**上报这步已跑通**，卡点确实只在页面下发。
- **2026-10-06（设备接入文档上云 + 打包脚本 node_modules 污染修复）**：按纪律 9 部署 `e5acf98`（设备接入文档 + 模拟器镜像 + llms.txt + ota/SERVER 文档）——build（bundle `index-DPC6vB74`，与线上入口一致）→ `package-deploy.ps1` → scp → 远端 unzip → restart；**核对通过**：`ExecMainStartTimestamp` 19:59:08 → **20:07:03**，`is-active=active`；外网 http:80 逐条 200 —— `/docs/DEVICE-OTA.md`(30960B 含「设备接入指南」)、`/tools/device-sim/{index,lib}.js`、`/api/devices`(_meta.docs 正确)、`/OTA`、`/llms.txt`(含「设备接入」)、`/api/status`、`/docs/ota.md`、`/docs/SERVER.md`；并用 `tools/device-sim` 真打线上服务器完成一次注册（随后删掉该测试设备，`/api/devices` 复归空）。**踩坑（两处）**：① **打包把整个仓库根的 node_modules 扫进去了**——`Get-ChildItem -Path server,dist,package.json -Recurse` 里放了个**文件**，PowerShell 会从该文件**父目录**（仓库根）开始递归，于是 82 个 `node_modules/**/package.json` 进包（139 条目）；你 19:58 那次同样中招，远端 `/opt/firmware-server/node_modules` 已被塞成 82 个只有 package.json 的目录（经 `find -type f ! -name package.json | wc -l` = **0** 证实无一个代码文件；server 纯 JS 零依赖本不需要该目录）。改为「目录用 -Recurse 枚举、单文件用 Get-Item 单独取」并加 `node_modules` 过滤 → 包变 **57 条目（45 dist + 11 server + 1 package.json）**、零 node_modules。**已清理线上垃圾**（先 `find … > /tmp/fw-deploy-junk-list.txt` 留清单再 `rm -rf`，删后 `active` 与时间戳不变、端点复验全 200）。② **改 `.ps1` 丢了 UTF-8 BOM**——正是你记在问题 21 的坑，编辑后前 3 字节变 `35,32,229`，已补回 `239,187,191`。**并发会话的两条硬约束均已满足**：`app.js` 与 `devices.js` 同提交（`e5acf98`），HEAD 自洽可启动。
- **2026-10-06（OTA 服务器端点 + 设备接入文档 + 模拟器）**：把 `docs/ota.md` 的契约真正落地成可联调的东西，并解决"设备在另一台电脑开发"的交接问题——① **服务器端四端点**（`server/devices.js` 纯函数+原子写 `devices.json`；`app.js` 接 `report`/`GET /api/devices`/`commands`/`result`）：`report` 与 `result` **免鉴权**（MAC 即身份，§7#6 定案），`commands` 需 Bearer；在线判定服务端按 `lastSeen` 45s；下发时在 registry 里按 `releaseId` 定位 release 并取 `type==='app'` 段填 `file/url/sha256/size`；未决命令冲突返 **409** + `force` 可顶替（旧标 `superseded`）；**新增命令重复投递**（取走未回执则下次再投，带 `redelivered`+`deliveryCount`）根治"设备取走即崩溃永久卡死"。② **设备模拟器** `tools/device-sim/`（零依赖 Node，report 循环→下载→sha256 校验→回执；`--dry-run`/`--fail-rate`/`--id`/`--once`），并镜像到 `public/tools/device-sim/` 供设备机直接下载。③ **设备接入文档** `docs/DEVICE-OTA.md`（约 600 行，设备端唯一入口）：契约逐条 curl、ESP-IDF 代码骨架、分区表改造自查+C SV、联调步骤、失败模式表、验收清单。④ **验证**：`tests/devices.test.js` 30 + `tests/device-sim.test.js` 12 全绿；临时端到端脚本（真实服务器+真实固件文件+模拟器子进程）**24/24 通过**，覆盖成功链路、重投递、409/force、sha256 篡改失败、参数错误退出码。⑤ 文档同步：`ota.md` §5 改写（删掉对不存在的 `components/net` 的假设）+ §6.2 服务器实现表 + §7 决策结案、`SERVER.md` §3/§7、`llms.txt`、`AGENTS.md`。**明确不做**：设备端固件（另一台电脑）、批量/灰度、MQTT 推送、设备端上报鉴权。**关键正确性发现**：`app_elf_sha256`（ELF 摘要）≠ registry 里 app 段 sha256（`.bin` 摘要），自我识别须用 `firmwareVersion`、下载校验才用命令里的 sha256。
- **2026-10-06（OTA 独立页 `/OTA`）**：按 `docs/ota.md` 契约把**页面端**先落地为**独立页**（不进主 SPA 构建）——① **页面** `public/ota/{index.html,ota.css,ota.js}`：深色运维控制台风格（品牌绿 accent），设备卡（MAC/芯片/固件/IP/心跳/最近命令）+ 概览计数（在线/离线/待执行/成功/失败）+ 设备与 release 双下拉 + 下发 + 命令状态流转 + 5s 轮询；**mock/real 双模式**（mock 内置 §4.2 形状三台假设备，默认；real 打真实 `/api/devices`+`/api/registry`，选择持久化 `localStorage.ota.mode`，后端未实现时明确提示而非静默失败）。② **AI 可读**：`/ota.json` 机器描述符（tool_id=ota-console，接口清单/数据模型/不变量/mock-real 说明）+ 页内 meta 标签与 `#ai-data` 结构化摘要 + `/llms.txt` 新增 OTA 段 + 契约文档 `/docs/ota.md` 挂公网（`docs/ota.md` 补 §6.0 已实现说明）。③ **服务器路由** `server/app.js`：`serveStatic` 新增 `/OTA`→`/ota` 大小写归一（Linux 大小写敏感）+ 目录命中 `index.html`（`/ota/` 可访问），SPA 兜底不变；MIME 补 `.md`/`.txt`（此前 `/docs/*.md`、`/llms.txt` 以 octet-stream 下发，对 AI 直读不友好）。④ **验证**：新 `tests/static-pages.test.js` 8 用例（大小写/尾斜杠/资源/描述符/SPA 兜底/dist 缺失）+ 真实 dist 起服务 9 条路由 200 实测 + 页面逻辑 DOM 桩 30/30（含 pending→delivered→success 流转）+ build 全绿。**未做**：服务器端 `/api/devices*`、设备端 `components/ota`。
- **2026-10-06（烧录进度在途：`tests/progress.test.ts` 1 红，待用户定）**：全量套件 156 用例 1 红，位于 `tests/progress.test.ts`「写入最后一段的过程中百分比能爬到 100%」——期望 `1072128`、实得 `1047552`。**根因在断言口径而非实现**：该用例把 `partWritten=500*1024`、`partTotal=1024*1024` 当作「正好一半」，但 `512000/1048576 = 48.83%`，`23552 + 2MB×0.4883 = 1047552` 才是正确的线性插值；若想表达「恰好一半」应写 `partTotal = 1000*1024`。属在途未提交改动（`src/core/progress.ts` / `tests/progress.test.ts`），与 `/OTA` 无关，未代为修改。
- **2026-10-03（命名/载入体验/多文件）**：用户反馈三连修——① **命名**：release id 升为 YYYYMMDD-HHmmss-短哈希（时间到秒）；时间线日期改 YYYY-MM-DD HH:mm（含年）；导出 zip 文件名弃 epoch 时间戳改可读 …-YYYYMMDD-HHmmss.zip；② **载入反馈**：防重复点击（loading 守卫）、树行「载入中…」、固件页醒目进度条（n/N 段 · 字节）；③ **多文件载入**：串行改**并行下载**、进度实时计数、失败定位到具体文件名（「段 X 下载失败」）。另 flaky 再加固（双段事件等待+20s 上限，全量三连跑 141 全绿）。
- **2026-10-03（A1–A3 打磨批次）**：① **A1 时间线高度自适应**——.tl__list 去掉写死 max-height:220px，高度随内容自然生长（外层滚动）；② **A2 bin 解析展示**——新 core/binInfo.ts（镜像头 0xE9：芯片/段数/入口/flash mode·freq·size、分区表 0x50AA/0x50EB、strings 提取、SHA-256；芯片 ID 映射抄 esptool-js targets）+ 烧录表格每行「ⓘ 固件详情」弹层（字段网格/分区表/字符串/校验和）；**+6 单测**（含 crc 向量级 sha256 标准向量）；③ **A3 GitHub Actions CI**（push/PR 跑 test+build）+ **flaky 修复**（watch 防抖用例改事件等待 5s 上限，双跑全绿）。141 测试 + build 全绿。
- **2026-10-03（P4 可观测性）**：程序日志三入口落地——① 前端编排日志：信号复位**逐步打点**（[复位] 步骤 x/2…，超时单步告警继续），fetch 失败进 console（[api] …）；② 后端**访问日志**（[http] 方法 路径 状态 耗时，4xx/5xx 走 stderr）+ 错误堆栈带请求路径；③ TROUBLESHOOTING 新增「程序日志去哪看」对照表（页面日志 / F12 / journalctl）。本地冒烟验证 [http] GET /api/status 200 18ms；135 测试+build 全绿。
- **2026-10-03（文档重整）**：按"归档历史 + 现行全集 + 目录整理"重组——① **现行文档迁 `docs/`**（DESIGN/REQUIREMENTS/DEPLOY/SERVER/TROUBLESHOOTING/FIRMWARE-REGISTRY/PUBLISH），根目录只留 README/AGENTS/PROGRESS；② **新增 `docs/USER-GUIDE.md` 使用手册**（三分钟上手/五区导览/监视三语义/抓全量日志与崩溃取证操作卡/FAQ）+ **`docs/DEPLOY.md` §0.5 本机 5 分钟快速路径**（localhost 安全上下文直烧）；③ **历史产出归档 `docs/archive/`**（EXECUTION-PLAN/PAGE-REDESIGN/IDF-ENV/两份一次性分析报告 + 归档索引 README）；④ 专题调研移 `docs/research/`（仍为现行参考）；⑤ PUBLISH.md 源头化（原只存在于 public/docs，现以 docs/ 为源）；⑥ 清理根目录废件（deploy-package.zip / *.log / *.err ×8）；⑦ AGENTS/README/本文档地图全部指向新路径，双份纪律改为「改 docs/ 源头 → 拷 public/docs/」。
- **2026-10-03（R-1 极性修正：开流后静默根因）**：用户实测「开监视后只有单行 ESP-ROM、随即永久静默」——根因=**esp_idf_monitor constants.py 标签反转（LOW=True / HIGH=False）**，首版把 RTS 极性写反：init 拉 true = 全程按住 EN 复位，hard() 变成放开 5ms 又按住（单行 ROM 正是 5ms 窗口冲进 USB FIFO 的残余）。修正：init=idle `requestToSend:false`（EN 释放）+ hard()=`true → 5ms → false`（EN 拉低→释放启动）；与 esptool USBJTAGSerialReset 注释（RTS=True # Reset）互证。教训入册：**抄官方源码必须连常量表一起抄，命名语义反直觉时以真值为准**。133 测试 + build 全绿。
- **2026-10-02（R-1 监视对齐 idf.py monitor）**：调研驱动实现——① `glue/signalReset.ts`：**esp_idf_monitor 官方同源时序**（本地 IDF 源码核实：`Reset.hard()` = RTS低→**5ms**(esp32s3 MINIMAL_EN_LOW_DELAY)→RTS高 + Windows usbser DTR 重发变通；开流后先置 RTS/DTR=idle 防误复位）；② **▶开始监视 → 自动硬复位一次**（官方 `open_serial(reset=True)` 同款，`--no-reset` 等价语义留待需要）→ 从 ROM 第一行抓全启动日志；③ **「↻ 复位」按钮**（面板头）：硬复位智能路由——**监视开=signalReset 信号路径（端口不关/日志不断/COM 不掉）**、监视关=原 esptool 临界区兜底，快捷操作硬复位同享；④ 读取权威源码：`node_modules/esptool-js/lib/reset.js` + `D:\Espressif\...\esp_idf_monitor\base\reset.py/chip_specific_config.py/serial_reader.py`。core 依赖 `deps.signalReset` 注入，**+2 新测试**（信号路径不断流/启动自动复位），擦除与硬复位用例重写。**133 测试 + build 全绿**（publish-watch 防抖用例单独复跑 2 次过，判定计时偶发）。**待实机验证**：USB-Serial/JTAG 枚举保持 + 时序效果。
- **2026-10-02（M1 默认折叠+启动日志引导）**：① 项目库文件夹**默认折叠**（openFolders 语义反转，显示「N 版本」，点开才列版本行）；② 启动日志缺失定位=**串口无缓冲**（监视开启前的输出无法追回，非丢读）——glue 开流路径无冗余延迟（port.open 直读）；引导两处：resume notice「先开监视、再复位设备，才能抓全启动日志」+ 空窗提示改写（点硬复位/RST 从头看起）。131 测试+build 全绿。
- **2026-10-02（页面任务批次 N1–N7）**：① **N1 项目库折叠**——点文件夹 📁/📂+「N 版本」折叠切换（选中兼折叠）；快照/发布版区分强化（★发布=绿底徽标、快照灰淡、NEW 红）；② **N2 独立窗口整链移除**——⧉ 按钮/?panel=log 分支/fw-log BroadcastChannel 收发/LogPanel minimal 全删，LogPanel 精简为纯终端体；③ **N3 拖拽调尺寸**——侧栏右缘/底板上缘 6px 拖拽条（pointer capture），`--sb-w`/`--bp-h` + localStorage fw.sbW/fw.bpH 持久；④ **N4 日志监视默认关闭**（core 变更）——新增 `streamWanted` 意图位：连接不再自动开流（连接 notice 提示手动开启），手动 ▶ 后跨重连保持，烧录临界区只按意图恢复（**暂停后烧录不再抢串口**）——DESIGN §4.1 状态图/F-16/13 个测试同步重写；⑤ **N5 烧录历史**移入底部面板第 4 标签（活动栏「历史」直接开面板），side-card 只留服务；⑥ **N6 活动栏中文标签**——图标下 9.5px 设备/固件/版本/项目/历史/服务/设置；⑦ **N7 导出固件包**——操作行「⬇ 导出固件包」：全部段+flash_args+README.txt 打 zip（新 core/zip STORE 零依赖 + firmwarePack 文本生成，+6 测试含 crc32 标准向量与 zip 回环解析）。**131 测试 + build 全绿**，Playwright DOM 验收（标签/折叠/拖拽条/默认关监视/无独立窗口）通过。硬复位不可用问题仅记录（下一步2）。
- **2026-10-02（b-ide 新版上云）**：按 SERVER.md 流程部署——build（index-8VoAskEc.js）→ Compress-Archive → scp → unzip → systemctl restart（ExecMainStartTimestamp=10-02 12:04:16 核对通过）。外网验证：https 入口 bundle ✓、http:80 只读通道 ✓、/design-preview/b-ide.html ✓、/docs/DEPLOY.md ✓、/api/status ✓（2 项目/14 版本）。注：首轮 ssh 重启静默失败（unzip backslash 警告后命令链中断），按 SERVER.md「unzip 成功≠进程重启」教训补重启+时间戳核对。
- **2026-10-02（页面重排：b-ide 整页复刻）**：应用户「完全以 design-preview/b-ide.html 为模板、旧内容全拆」两轮重构——第一轮五区骨架（ActivityBar/Sidebar/TreeSection/TreeItem/EditorTabs/BottomPanel/StatusBar 注册式组件 + base.css IDE 色系 token --activity/--status，accent 定案=品牌绿）；第二轮模板复刻：设备/项目库/快捷操作全改 VS Code 树行（连接操作=accent 树行）、侧栏底部合一张 side-card（FlashHistory plain 模式+服务行）、底部面板三标签**问题=warn/error、输出=device、日志监视器=LogPanel embedded（控件上提面板头：级别▾/⏸/⏹/⧉/导出/清空）**、状态栏补 ⌀MAC/★订阅N/◉服务在线、活动栏顺序+◷NEW红点、标签动态名（固件 · <文件名>）、终端行号+❯闪烁光标。状态上提 useFirmwareWorkspace（rows+registry 三处共享）+ useServiceStatus（side-card/状态栏共用）；删除 ConnectPanel/DashboardCard/SidebarSection；vite proxy 补 /api/status /api/token。**红线守住：core/glue 零改动、日志渲染纪律与 ?panel=log 不变，122 测试+build 全绿**；Playwright 全量交互回归（选项目→时间线→载入→dio/80m/2MB 注入→面包屑）通过。踩坑：TreeSection 裸 `open` 标识符不解析 props（withDefaults+props.open 修复）；vite HMR 陈旧需重启 dev。
- **2026-09-29（移除⚡一键载入与 IDF build 中间件）**：应用户要求删除本地构建载入/编译链路（云端部署后失效）——删 `src/api/buildArtifacts.ts`、`src/api/buildCommands.ts`、`src/composables/useIdfBuild.ts`、`tests/api.test.ts`（5 用例）与 `vite.config.ts` 的 `idfBuildArtifacts()` 插件（`/api/artifacts`、`/api/build` 五端点）；FirmwarePanel 去 ⚡按钮/`loadLocalBuild`/`buildRunning`/`autoLoadSignal`，VersionTimeline 去 `disabled` prop，App 去两绑定；`FlashParams` 类型迁至 `registry.ts`。项目库/时间线/SSE/烧录链路零改动。122 测试+build 全绿。文档同步：DESIGN §4.5/§4.6、REQUIREMENTS F-19、FIRMWARE-REGISTRY §0/§3、AGENTS、双份拷贝。
- **2026-09-29（门5 过）**：用户实测 S4 版本管理流程基本跑通、日志可用——晋升/回滚/时间线/retention 链路成立，v1.5 核心关账（S1–S4 四门全过）。F-13/F-20/F-24 转 ✅。当前阶段转入页面功能优化（用户给建议中）。
- **2026-09-29（🎉 问题19 关闭 + 布局三优化）**：用户实测**"终于看见日志了"**——console=UART0 挂起项关闭，实时日志全链路打通。布局：① **日志按钮精简**——导出/清空收纳进 `⋯` 下拉，主行=暂停视图/监视开关/⧉独立窗口；② **页宽 1280→1560**（header/banner/main/状态卡四处）；③ **日志独立窗口**（`?panel=log`）：BroadcastChannel `fw-log` 三协议（sync-req/sync/append/clear）主窗口实时转发，副屏常驻看日志；副窗 minimal 模式（隐藏监视控制，连接归主窗）。127 测试+build 全绿，已部署（公网 panel=log/独立窗口/fw-log 三标记验证 ✓）。
- **2026-09-29（F-16 手动监视开关）**：用户澄清需求=**手动让出串口给本机 idf.py monitor**（自动流独占端口导致外部 monitor 打不开）。实现：core `pauseMonitor/resumeMonitor`（ready 态幂等；暂停 notice 提示"端口已释放可使用外部工具"）+ useSession 接线 + LogPanel 工具栏 `⏹ 停止监视（让出串口）/ ▶ 开始监视` 按钮（区分于"暂停视图"）；烧录临界区结束仍自动恢复（设计如此，4 个单测覆盖含该语义）。F-16 需求行与 DESIGN §4.1 同步（"无手动开关"→有）。**另：menuconfig 网页面板中途否决撤回**（dev 中间件管不到目标电脑开发代码），已 revert。126 测试+build 全绿，已上线（bundle 含按钮文案）。
- **2026-09-29（页面内容四件套）**：应"更丰富内容功能"全选四方向——① **F-12 芯片详情补全**：detectChip 顺读 MAC/Revision/detectFlashSize（ChipInfo 扩展、可选缺省）+ ConnectPanel 详情卡 + 烧录前二次确认（段数/字节/地址清单）；② **日志级别过滤**：LogPanel 全部/⚠警告+/✖错误/设备 四档 + 计数改 filtered/总；③ **烧录历史**：useSession pushHistory（localStorage 20 条，成败/芯片/段数/字节/错误）+ FlashHistory 折叠组件（左栏底部）；④ **服务状态摘要卡**：`GET /api/status`（项目/版本计数、数据占用、运行时长、最近发布）+ DashboardCard 全宽横条（60s 自动刷新）+ llms 索引。121 测试（+1 status）全绿，已部署（公网 status 实测：2 项目/12 版本——跨网发布已在真实使用）。
- **2026-09-29（设备占用治理）**：五类占用方矩阵落地——① **Web Locks 跨标签互斥**（`glue/deviceLocks.ts`：连接/切换端口前抢 `esp32-web-device` 锁，拿不到=另一标签持有→日志明确警告；断开/拔线/error 归位自动释放、标签关闭浏览器级自动释放、无 Locks 环境降级放行）+ useSession 接入（runWithLock）；② **PortBusy 文案四步排查**（本标签→外部程序→另一浏览器→重插，DESIGN §4.4 同步）；③ **TROUBLESHOOTING §2 扩充为占用方矩阵**（5 类情况×症状×方案+机制说明+排查口诀）。锁逻辑单测 3 用例（获取/被占 false→释放恢复/降级）——**120 测试全绿**，已部署（bundle 含 esp32-web-device 锁名）。
- **2026-09-29（日间/夜间主题 + 配色修正）**：base.css 双主题变量体系——暗色（默认，accent 由 #2ea87d 提亮为 #3fb950 修正暗底对比不足）+ 新增日间整套（GitHub Light 系：#f6f8fa 底/#1a7f5a 深绿 accent 保白底对比）；新增语义变量 `--accent-ink`（色块上文字）、`--info`（设备日志蓝）并清除 4 处硬编码色（3×#04150f、#79c0ff）与 bg fallback；切换机制：header ☀️/🌙 按钮 + localStorage `fw.theme` + index.html 内联脚本首屏预置（防闪烁）+ 默认跟随系统 `prefers-color-scheme`。117 测试+build 全绿，已部署（bundle index-Bh_7NxQg，防闪三关键字公网 ✓）。
- **2026-09-29（布局优化：左右两栏）**：应用户"页面利用率优化"（选定方案：操作左/日志右）——App 改 `.shell__layout` grid（7fr/5fr），左栏=设备+IDF+擦除+固件，右栏=日志 `position: sticky` 钉住 + `--log-height: calc(100vh-150px)` 满高内部滚动（LogPanel 的 logbox 由固定 240px 改读 CSS 变量，窄屏 ≤960px 回退单列 240px）；页面 max-width 860→1280。117 测试 + build 全绿，已部署（bundle index-CXZv80QS 含新结构）。
- **2026-09-29（安全事件：token 公网泄露轮换）**：SERVER.md §4 曾将主 token 明文写入并挂公网 `/docs/`（与"秘密勿走 http 通道"自相矛盾，用户指出）。处置：① §4 改为指引式（见 env/向运维者索取）+ 三份拷贝与 dist 全量清理（全仓 grep 无残留）；② **主 token 已轮换**（改 env → restart，旧值 401 实测作废、新值 200 实测生效，新值不入文档）；③ SERVER.md 增加"任何 token 明文不得写入本仓库文档"纪律条。附注：DEPLOY §9 SSE"已实现"版其实已在服务器（用户所见疑为缓存）。git 仓库无远程，历史中的旧值随轮换失效。
- **2026-09-29（前端可见性 + 双层 token 体系）**：应用户两点反馈——① **项目库/版本时间线/载入脱离串口连接**：App 移除 FirmwarePanel 的 `v-if="connected"`，面板内拆分设备依赖语义（仅「烧录/擦除/复位」需连接；⚡载入/项目库载入/时间线全部操作改为仅 `buildRunning` 禁用；未连接提示文案）；② **token 页面手动生成**：服务端 `tokens.js` 双层体系——主 token（env，永不失效，唯一可管理）+ 工作 token（`wk_` 前缀，`server-data/tokens.json` 持久化、可撤销），`POST/GET/DELETE /api/token` 仅主 token 鉴权，publish/promote 等写接口接受二者；前端 🔑 升级为「生成（主 token 换 wk_ 交给 AI）/手动设置」两路。117 测试全绿（+2：401 防抢注/生成→使用→撤销全链）；公网实测无 auth 401、主 token 生成 `wk_` 成功；文档同步（PUBLISH/SERVER/llms）。
- **2026-09-29（故障排查指南 TROUBLESHOOTING.md）**：应"实时日志以前能跑现在不行"排查产出——定位为**问题 19 的 console=UART0 挂起态**（非回归：git log 证实门2 后无人碰日志链路 monitor.ts 自 F-16 未改）；将知识沉淀为公网文档 `TROUBLESHOOTING.md`（根+public/docs 双份）：§1 实时日志无输出——症状判定表/口归属原理图/硬复位为何无效（编译期定死口，重启不换频道）/menuconfig 修复三步+禁手改 sdkconfig 警告；§2-5 收编串口占用/401/增量与重试日志含义/SSE 不弹横幅。llms.txt 索引置顶。已部署公网 200。**附带结论：待用户 menuconfig+build 后重发，可一并关闭问题19 与 D4。**
- **2026-09-29（文档体系全量同步 + SERVER.md）**：补记此前未入日志的连续增强——① **发布指南** `PUBLISH.md`（config/命令/裸 HTTP curl 示例/meta 完整样例/FAQ）；② **跨网自助闭环**：CLI 四文件托管 `/tools/publish/`、llms.txt 加发布方式二选一与文档索引（陌生 AI 从 URL 到发布全程零先验，已 WebFetch 实测）；③ **token 便利化**：页面 🔑 显式设置/状态按钮 + config 明文 token 写法 + 获取三途径；④ **双通道定型**：http:80 只读 AI 通道（nginx `firmware-server.conf` 加 listen 80，server_name=IP 不碰域名站点，备份 .bak）+ https:443 浏览器自签；⑤ 文档迁 `public/docs/`（源头化，防 build 清 dist）；⑥ **新建 `SERVER.md`**（部署状态快照：拓扑/环境/通道表/token 轮换/运维命令与时间戳核对教训/已知限制清单）；DEPLOY.md 补 §10 站点结构、§11 双通道、S3 SSE 状态修正。**双份纪律：根目录文档为源，改后 Copy 至 public/docs/**。
- **2026-09-29（AI 友好度增强）**：让 AI 智能体免 JS 获取站点信息——`public/llms.txt`（服务说明+真实 API 路由清单含 promote/latest/retention/订阅+数据结构含 type/subType+认证+curl 示例；**放 public/ 而非 dist/**，否则下次 build 被清）；根 `index.html` 加 meta description + JSON-LD(WebApplication) + 隐藏 `#ai-data` 说明块；`GET /api/registry` 响应加 `_meta{service,version,docs}`（向后兼容，spread 追加）。三条验证公网通过（llms.txt 200/_meta 正确/页面三标记齐）。115 测试 + build 全绿，服务器 20:53 重启上线。注：任务模板中 parts 下载路径与实际路由不符，已按真实路由写入 llms.txt（防 AI 照抄 404）。
- **2026-09-29（S4 版本管理 + 分区类型）**：**S4**——server `releases.js`（promote 必填 note/setLatest 回滚/retention 设置+预览+publish 后自动清理，releases 永不删）+ 写操作 Bearer 鉴权（401 测试）+ CLI `promote <rid> --note`（registry 自动定位 variant）+ 前端 `VersionTimeline.vue`（时间线/晋升 prompt/回滚 confirm/保留数预览确认/401 引导输 token）+ F-13 芯片比对 confirm + SSE promote/latest 事件刷新。**插入需求（用户提出）**：parts 增加 `type/subType` 分区类型——CLI `parsePartitionTable`（0x50AA 条目/0x50EB 尾、app/data 子类型枚举）按地址匹配 + config.assets 显式声明 + 前端"分区"列徽标；**server 三文件零改动**（parts 整对象透传，`.meta.json`/rebuild 天然携带）；fixtures 换真实格式分区表。115 测试 + build 全绿。剩：部署+rebuild 实测 → 门5。
- **2026-09-29（门4 过）**：用户在 `https://firmware.example.com` 实测确认横幅与 ●NEW（发布 20260929-2029 经 SSE 即时推送）——**"远端发布、本地即知"订阅形态达成**，F-21 关。同轮完善：公网直连部署（自签 IP 证书、Node 侧 `NODE_TLS_REJECT_UNAUTHORIZED=0`、SSE 经 nginx 无缓冲实测）、server/dist MD5 全 SYNC 校验、文档挂载 `/docs/`（DEPLOY/FIRMWARE-REGISTRY/REQUIREMENTS，200）。问题记录 20（watch 后台 fetch failed，前台 once 可靠）、21（PS5.1 编码双坑）。
- **2026-09-29（S3 SSE 订阅）**：server `stream.js`（SSE hub：retry 握手/15s 心跳/断开清理/closeAll 清 interval）+ `POST …/subscribe`（`upsertSubscribed` 持久化）+ publish `onPublished` 广播；前端 `subscribeRegistry`（EventSource+断线 30s 轮询降级、`snapshotLatest/diffLatest` 纯函数）+ App 横幅/`● 订阅中`状态点 + FirmwarePanel `●NEW` 角标/★开关（localStorage+服务端双写）/载入 emit 清角标/事件触发自动刷新。服务器重打包部署 SSE 版（**教训：unzip 成功≠进程重启——核对 `ExecMainStartTimestamp`**）。108 测试 + build 全绿。
- **2026-09-29（门3 过）**：浏览器确认 localhost:8787 页面载入远端版本（用户日志：连接远端前端成功、载入后 `烧录参数 mode=dio freq=80m size=2MB` 注入）——**"远端发布、本地即知"核心闭环达成**。门2/门3 状态落账（D4/console 挂起注明），F-23 转 ✅。下一步 S3 SSE。
- **2026-09-29（门3 部署实测）**：服务器上线——Ubuntu 22.04（firmware.example.com，panel.example.com）装 Node 24.21、部署包上传（本机 ed25519 免密，passwd 重置后密码认证仍失败遂改密钥）、systemd `firmware-server` active、`/api/registry` 返回 `{"projects":{}}`。**SSH 隧道 `localhost:8787` 全通**（nginx+certbot 因 unattended-upgr 占 dpkg 锁暂缓——DEPLOY §5 方案 B）。**watch 实测**：本机 `--watch` → 隧道 → 远端 registry 出现 `hello-world/ESP32-S3/20260929-1949-fff989`（80m/2MB）；touch 产物防抖后新 release **`上传=0（服务器已有，秒回）`**——跨 release 增量实证。

- **2026-09-29（S2 自动发布+部署文档）**：**--watch**（`tools/publish/watch.js`：发布输入签名 flash_args+产物+project_description+assets、轮询防抖 5s、失败退避 3 次+pending 下轮补传、SIGINT 优雅退出；once 主体抽 `once.js` 供复用）+ **跨 release 增量**（server `findPartBySha` 按 sha 从旧 release 复用、CLI `collectShaSet` 差集，双端一致）+ **`DEPLOY.md` runbook**（systemd/Caddy `flush_interval -1`/nginx `proxy_buffering off`/token 注入/watch 挂机/SSH 隧道回退/验证清单/S3 SSE 预留）。98 测试 + build 全绿。剩 T19 服务器实测（门3，待 SSH 信息）。
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
