# PROGRESS — ESP32 Web Flasher 工作记录

> 本文件是**活的进度表**：每次有意义的推进后更新。新接手的 AI/工程师请先读本文，再读 AGENTS.md。
> 最后更新：2026-09-29（**门5 已过**——S4 版本管理流程用户实测基本跑通、日志可用；v1.5 核心关账，进入页面功能优化阶段）

## 一句话

单用户自用的 ESP32 网页烧录工具：官方 esptool-js 做内核（只升不改），UI/日志/文件/命令控制全自研；第一目标芯片 ESP32-S3。当前模型：**设备常驻连接（方向1）+ 连接即自动日志监视**。v1.5 走 **`EXECUTION-PLAN.md`**（跨设备固件下载服务：远端 publish → 自含 server → 本地订阅烧录）。

## 文档地图（阅读顺序）

1. `REQUIREMENTS.md` — 6 项决策（D1–D6）+ v1 验收清单（F-01…F-18）
2. `DESIGN.md` — 三层架构、设备状态机（§4.1）、错误分类（§4.4）、部署（§7）
3. `research/esp32-web-flash/REPORT.md` — 选型调研报告（为什么这么做）
4. `AGENTS.md` — 接手纪律与命令
5. `IDF-ENV.md` — IDF 环境激活/命令/坑（本机操作指南）
6. `EXECUTION-PLAN.md` — 分片路线 + 五道验收门（唯一权威线路）
7. `SERVER.md` — 当前部署状态详解（拓扑/双通道/token/运维命令/已知限制）
8. `DEPLOY.md` — Ubuntu 部署 runbook（S2 交付，门3 依据）
9. 本文 — 进度与下一步

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
| **T12 S1 最小闭环** | 🔄 门2 进行中 | 代码+e2e+首轮真机（发布→载入→烧录→复位全通）；**复测 4 项修复全过**（80m/2MB 注入、首把成功、D5 三段 verified）；D4/console 核对**用户暂缓**（现有编译结果可用），不阻塞 S2 |
| **S2 自动发布+部署** | ✅ 门3 已过 | watch 自动发布+增量 0 上传+服务器部署+隧道全通；**浏览器确认：localhost:8787 页面载入远端版本、80m/2MB 注入（2026-09-29 用户日志）**；HTTPS/域名解析为尾巴（不阻塞） |
| **S3 SSE 订阅** | ✅ 门4 已过 | 用户确认横幅+●NEW（20260929-2029）；SSE hub/广播/subscribe/前端横幅/角标/★开关/轮询降级全实测；108 测试全绿；文档挂载公网 /docs/ |
| **S4 版本管理** | ✅ 门5 已过 | server promote/回滚/retention（Bearer 鉴权）+CLI `promote --note`+前端时间线（晋升/回滚/保留数确认/F-13 芯片比对）+SSE promote/latest 刷新+parts 分区类型 type/subType；115 测试+build 全绿；**用户实测：流程基本跑通、日志可用（2026-09-29）** |

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
20. **watch 后台进程网络失败（未定位，backlog）**：`Start-Process` 起的 watch 持续 `fetch failed`（err.cause 为空、无代理 env、服务器无封禁痕迹、探针脚本同样挂起），而**同一 shell 前台 `publish once` 始终成功**（门4 期间 2019/2020/2027/2029 连发成功）。逻辑本身有 7 个单测守护——判断为**运行环境差异**（疑安全软件/进程会话网络策略）。**处置：发布一律用手动 once（可靠）**；watch 恢复自动化待查（S2 收尾/backlog）。
21. **PowerShell 5.1 编码双坑（已踩，勿再犯）**：① `Get-Content` 不带 `-Encoding` 按 ANSI 读 UTF-8 中文 → `Set-Content` 写回=**双重编码写坏**；② `Set-Content -Encoding UTF8`=**带 BOM**，Node JSON.parse 报 `Unexpected token '﻿'`。**正解**：`[IO.File]::ReadAllText/WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))`，或用 Node/Write 工具写含中文的 JSON。
22. **Web Locks 判定时序 bug（门2 后线上误报，已修）**：`tryAcquire` 用 `setTimeout(0)` 等锁 callback 决策——callback 调度晚于定时器时 ①误报"被其它标签占用"②锁已实际拿到却记为失败（**幽灵锁**）→ 后续每次重试都撞自己这把无人认领的锁 = **自锁死，连续连接必失败**（用户实测连续 3 次全拒）。**修复**：granted/rejected 的 resolve 全部移到 callback **内部**（零时序赌博）+ 失败后 30ms 短重试一次（覆盖"自己刚 release、锁未回收"重入窗口）+ 延迟调度回归测试。教训：**异步原语的判定必须发生在回调内，禁止用定时器赌调度顺序**。
23. **拔线后句柄残留 → 重连必须刷新（已修）**：`SerialMonitor.readLoop` 出错路径 ①不置 `running=false`（循环风暴重复报错）②**从不 `port.close()`**——Web Serial 句柄残留，下次 `port.open()` 报错、只能刷新页面（用户 22:17 实测）。**修复双保险**：monitor 错误即自终止+关端口；deviceOps 加 `preparePort()`（detect/ensureSynced/startStream/reopenForRetry 四入口强制归零残留句柄，命中时打日志）。同轮按用户要求**移除 IDF 编译命令块**（🔨🧹■ + useIdfBuild 接线，⚡载入本地构建保留）。122 测试+build 全绿。注：烧录后仍无设备输出 = 问题 19（menuconfig 未做，非本 bug）。

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
| F-12 芯片信息展示 | ✅ | 检测即读 MAC/Revision/Flash 容量入 ChipInfo（失败缺省）+ 设备面板详情卡 + **烧录前二次确认**（段数/字节/地址清单）——本轮补全 |
| F-13 chipFamily 比对 | ✅ | S4 实现：载入时 chipFamily≠实测 → confirm 警告不阻断；门5 实测顺带验证 |
| F-14 地址预设 | ✅ | flash_args 权威地址（不再靠猜） |
| F-15 会话可重复 | ✅ | 实机二次烧录验证 |
| F-16 实时串口日志 | 🔄 | 机制实测正常（烧录前后自动挂起/恢复）；**hello_world console=UART0（sdkconfig），USB 口无 app 输出**——待 console 改 USB Serial/JTAG 后闭环 |
| F-17 设备常驻连接 | 🔄 | 代码+单测完成，**待实机回归** |
| F-18 日志渲染性能 | 🔄 | 代码+单测完成，**待洪峰实测** |
| F-19 IDF 命令按钮 | 🔄 | 代码完成+冒烟 exit 0，**待实机点按** |
| F-20 项目/版本/多芯片变体 | ✅ | S4 三层+latest 载入+回滚(设 latest)+版本时间线；门5 用户实测流程跑通 |
| F-21 订阅推送 | ✅ | 门4 用户实测（横幅+查看+●NEW）：SSE+30s 轮询降级+★开关双写+心跳；nginx 经 IP HTTPS 实测无缓冲 |
| F-22 任意烧录文件管理 | 🔄 | S4 增强：parts 统一建模+assets 随发布+**分区类型 type/subType**（partition-table 解析/声明/前端列，向后兼容缺省）；页面补充上传=S5 |
| F-23 发布 CLI 与自动触发 | ✅ | `once`+`--watch`+Bearer token+增量（跨 release 0 上传实测）+flash_args/assets 识别——门3 全链实测（2026-09-29） |
| F-24 版本说明与保留策略 | ✅ | S4 promote 必填 note（CLI+页面）+retention 设置/预览/发布后自动清理（releases 永不删）；门5 用户实测 |

## 下一步

1. **页面功能优化（进行中）**：门5 过、v1.5 核心关账——当前阶段=收集用户对页面功能的优化建议并落地。
2. **watch 后台网络问题（问题 20，backlog）**：发布暂用手动 once；根因定位（疑进程会话网络策略/安全软件）。
3. **HTTPS 尾巴**：文档已挂 `https://firmware.example.com/docs/`（DEPLOY/FIRMWARE-REGISTRY/REQUIREMENTS）；后续可加使用说明页。
4. **门2 挂起项（用户暂缓）**：D4/boot 日志核对——console 已切（问题19 关闭），恢复时一并做。
5. 等用户拍板：主操作按钮方案（见会话记录 2026-09-26）。
7. S5 页面补充上传：按需不排期。


## 变更日志

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
