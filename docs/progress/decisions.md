# DECISIONS — 关键技术决策与坑（务必继承）

> PROGRESS 拆出的「分」文档之一。这些决策与踩过的坑是给后续接手者的硬约束，**改代码前先读这里**。
> 现行状态/下一步见根目录 `PROGRESS.md`；变更历史见 `docs/progress/changelog.md`；代码结构见 `docs/progress/structure.md`。
> 编号 1–7 为全局纪律（与 `AGENTS.md` 硬性纪律一一对应）；8–24 为各阶段问题记录（按时间顺序，含门2 真机实测）。**勿删旧条目，只在末尾追加新号。**

---

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

---

## 外部环境快照

- IDF 工具链已迁 D 盘（junction `C:\Espressif → D:\Espressif`）；**esp32s3 multilib 缺失已修复**（idf_tools 重装 xtensa-esp-elf，坏包残留 `xtensa-esp-elf.broken` 待用户确认后可删，约 1.07GB）。
- hello_world 官方示例 target=esp32s3 编译通过，三段产物 flash_args：`0x0 / 0x8000 / 0x10000`。
- npm 缓存/全局在 `D:\dev\npm-cache` / `D:\dev\npm-global`。
- ⚠️ 已知问题：`SHA-256 comparison failed` 启动警告、镜像头 4MB vs 实际 16MB、flash_args 80m vs 启动日志 40MHz——烧录参数生效性待核对（打磨清单）。