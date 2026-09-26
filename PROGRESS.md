# PROGRESS — ESP32 Web Flasher 工作记录

> 本文件是**活的进度表**：每次有意义的推进后更新。新接手的 AI/工程师请先读本文，再读 AGENTS.md。
> 最后更新：2026-09-26

## 一句话

单用户自用的 ESP32 网页烧录工具：官方 esptool-js 做内核（只升不改），UI/日志/文件/命令控制全自研；第一目标芯片 ESP32-S3。

## 文档地图（阅读顺序）

1. `REQUIREMENTS.md` — 6 项决策（D1–D6）+ v1 验收清单（F-01…F-15）
2. `DESIGN.md` — 三层架构、状态机（§4.1）、错误分类（§4.4）、部署（§7）
3. `research/esp32-web-flash/REPORT.md` — 选型调研报告（为什么这么做）
4. `AGENTS.md` — 接手纪律与命令
5. 本文 — 进度与下一步

## 当前状态（任务面板同步）

| 任务 | 状态 | 证据 |
|---|---|---|
| T1 脚手架 Vue3+Vite+TS | ✅ done | `npm run build` 通过（vue-tsc + vite） |
| T2 环境自检（F-01） | ✅ done | `src/env/environment.ts` + `EnvCheck.vue` |
| T3 粘合层+状态机+日志+错误翻译 | ✅ done | **27/27 Vitest 全绿** + typecheck 通过；覆盖 F-08/09/10 |
| T4 连接与芯片检测实机 | 🔄 **代码完成，待实机** | glue/sessionDeps + useSession + ConnectPanel 已接线；需浏览器选 COM3 实测 |
| T5 烧录主链路实机 | 🔄 **UI 代码完成，待实机** | FirmwarePanel（多段+地址猜测+进度条）+ 自动硬复位已接；待 S3 固件产物 |
| T6 擦除+manifest+日志导出 | 🔶 部分 | 擦除（带确认）/硬复位按钮已接；日志面板+导出已接；manifest 一键载入未做 |

## 已完成代码清单（2026-09-26 首次实现）

```
package.json / tsconfig.json / vite.config.ts / index.html
src/main.ts  src/App.vue  src/vite-env.d.ts  src/styles/base.css
src/env/environment.ts        # F-01 自检（可注入 probe，可测）
src/components/EnvCheck.vue   # 自检 UI（深色终端风）
src/core/log.ts               # F-08 Logger 环形缓冲 + esptool 行分级
src/core/errors.ts            # F-10 七类错误翻译（中文文案+恢复提示）
src/core/session.ts           # F-09 FlashSession 状态机（deps 注入，纯逻辑）
src/glue/esptool.ts           # esptool-js 唯一接触面：Terminal/Transport/ESPLoader 封装
tests/{session,errors,log}.test.ts   # 27 用例
```

## 关键技术决策与坑（务必继承）

1. **esptool-js 锁 `0.7.0` 精确版本**（package.json 不带 ^）；升级走 DESIGN §8 流程。
2. **`typescript` 锁 `5.9`**：vue-tsc 3.x 会 resolve `typescript/lib/tsc`，TS 7 已移除该导出 → 装最新 TS 会构建失败（已踩坑）。
3. **esptool-js 的类型只允许出现在 `src/glue/`**：core 层零浏览器依赖、零 esptool 依赖，保证可单测。
4. **构建/测试命令**（本机 Node 不在系统 PATH，用打包运行时）：
   ```powershell
   & $env:MIMO_NODE $env:MIMO_NPM install        # 装依赖
   & $env:MIMO_NODE $env:MIMO_NPM test           # 27 用例
   & $env:MIMO_NODE $env:MIMO_NPM run build      # typecheck + 产物
   ```
5. **dev 服务器启动（含一键载入功能，两个坑都踩过）**：必须带 `IDF_BUILD_DIR`；且脱离 MiMo 会话启动时 node 需要 `MIMO_ELECTRON_NODE_HOST`，npm shim 会报错——推荐 WMI 直启 vite：
   ```powershell
   $cmd = "cmd /c cd /d `"$wd`" && set `"IDF_BUILD_DIR=<你的 build 目录>`" && set `"MIMO_ELECTRON_NODE_HOST=$env:MIMO_ELECTRON_NODE_HOST`" && `"$env:MIMO_NODE`" `"$wd\node_modules\vite\bin\vite.js`" > `"$env:TEMP\esp32-web-dev.out.log`" 2>&1"
   Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
   ```
   验证：`GET http://localhost:5173/api/artifacts` 返回 flash_args 三段+烧录参数即成功。
6. **一键载入（F-03 本地路径）**：页面「⚡ 载入本地构建」按钮经 dev 中间件读 `IDF_BUILD_DIR/flash_args`（权威地址 + dio/freq/size 参数）。服务器部署场景的 manifest JSON 路径仍未做。
7. 状态机迁移表在 `src/core/session.ts` 顶部 `TRANSITIONS`/`ALLOWED`；**改表必须同步 DESIGN §4.1 和 tests/session.test.ts**。

## 外部环境快照（与本项目相关）

- IDF 工具链已迁 D 盘（junction：`C:\Espressif → D:\Espressif`），环境验证通过（idf.py v6.1 / esptool 5.3.1 / S3 gcc 15.2.0）。
- ⚠️ **未决**：官方 hello_world 编译曾报 `crt0.o: compiled for a big endian system`（直连 D 盘同样复现，与 junction 无关，疑似工具链包问题）。用户自行编译结果待确认；若确认失败，先修工具链再进 T4（T4 烧录不强依赖 IDF，esptool-js 可独立工作，但固件产物需要能编出来）。
- npm 缓存/全局已重定向到 `D:\dev\npm-cache` / `D:\dev\npm-global`。

## 验收对照（REQUIREMENTS F-xx）

| 需求 | 状态 | 备注 |
|---|---|---|
| F-01 环境自检 | ✅ 代码完成 | 待浏览器人工过一遍两种失败分支 |
| F-08 日志 | ✅ 单测覆盖 | 分级/环形/导出；UI 面板未接 |
| F-09 状态机 | ✅ 单测覆盖 | 11 用例含守卫/恢复/订阅 |
| F-10 错误翻译 | ✅ 单测覆盖 | 8 用例 |
| F-02/04/05/06/07/11–15 | ⬜ | 随 T4/T5/T6 |

## 下一步（T4 具体动作，按序）

1. 在 `src/glue/` 写 `sessionDeps.ts`：把 `requestPort/openSession/detectChip/writeFlash/eraseFlash/hardReset/releaseSession` 组装成 `SessionDeps` 实现（注意：`connect` 期间 SessionDeps 内部持有 `PortSession` 状态）。
2. 连接向导 UI（DESIGN §4.5 步骤③）：连接按钮 → 调 `session.connect()` → 显示 `session.chip`；失败显示 `session.lastError.message/hint` + 重试。
3. Vue 接线：`useSession()` composable（ref 镜像 `subscribe` 通知）。
4. 实机清单（REQUIREMENTS 人工验收）：S3 插板→连接→日志出现 `Chip is ESP32-S3`→拔插→disconnect 回收→按住 BOOT 兜底。

## 变更日志

- **2026-09-26（晚）**：T4/T5/T6 代码主体完成——`glue/sessionDeps.ts`（SessionDeps 实现）、`composables/useSession.ts`（Vue 接线）、`ConnectPanel`/`FirmwarePanel`/`LogPanel` 三个组件、App 组装；27 测试 + build 全绿。**设备确认：ESP32-S3 @ COM3**（已写入全局记忆）；用户旧 hello_world 为 target=esp32，正在重编 esp32s3 版本（注意：之前 set-target esp32s3 曾触发 crt0 大端链接错误，若复发需修工具链——esp32 能编而 s3 不能，问题定位于 esp32s3 multilib 路径）。
- **2026-09-26**：T1/T2/T3 完成（27 测试全绿，build 通过）；建立 PROGRESS/AGENTS 交接文档。此前完成：调研报告、DESIGN、REQUIREMENTS、C 盘分析、IDF 工具链 junction 迁移。
