# AGENTS.md — ESP32 Web Flasher 接手指引

给下一个接手的 AI/工程师：**先读 `PROGRESS.md`**（进度与坑），本文只讲纪律和入口。需求与设计的原文以 `docs/REQUIREMENTS.md` / `docs/docs/DESIGN.md` 为准，不要凭记忆重写。

## 快速入口

> 文档组织：`docs/` 现行文档 · `docs/archive/` 开发过程历史 · `docs/research/` 专题调研 · 根目录仅 README/AGENTS/PROGRESS。

| 要做什么 | 入口 |
|---|---|
| 了解当前进度 / 下一步 | `PROGRESS.md` |
| **方案总览 / 快速开始** | `README.md` |
| **使用手册（操作者）** | `docs/USER-GUIDE.md` |
| 验收标准（F-xx） | `docs/REQUIREMENTS.md` §2 |
| 架构与状态机定义 | `docs/docs/DESIGN.md` §3–§4 |
| v1.5 固件库设计 | `docs/FIRMWARE-REGISTRY.md` |
| 部署 / 运维 | `docs/DEPLOY.md`（含本机快速路径）+ `docs/docs/SERVER.md` |
| 为什么选这条路线 | `docs/research/esp32-web-flash/REPORT.md` |
| 历史路线/选型存档 | `docs/archive/README.md`（EXECUTION-PLAN 等） |

## 命令（本机 Node 不在 PATH）

```powershell
& $env:MIMO_NODE $env:MIMO_NPM install
& $env:MIMO_NODE $env:MIMO_NPM test          # Vitest，提交前必须全绿
& $env:MIMO_NODE $env:MIMO_NPM run build     # vue-tsc --noEmit + vite build，必须过
& $env:MIMO_NODE $env:MIMO_NPM run dev      # 简单场景可用；完整启动配方（MIMO_ELECTRON_NODE_HOST 坑）见 PROGRESS.md「关键决策 4」
```

## 硬性纪律

1. **esptool-js 只升不改**：锁 `0.7.0`；`typescript` 锁 `5.9`（TS7 会砸 vue-tsc，见 PROGRESS 坑1）。
2. **分层**：`esptool-js` 的 import 只允许出现在 `src/glue/`；`src/core/` 不得引用任何浏览器 API 或 esptool（这是可单测性的根基）。
3. **改状态机迁移表**（`src/core/device.ts` 的 `TRANSITIONS`/`ALLOWED`，方向1 设备常驻模型）必须同步：`docs/DESIGN.md` §4.1 + `tests/device.test.ts`。
4. **改错误文案/分类**同步 `docs/DESIGN.md` §4.4 与 `tests/errors.test.ts`。
5. 提交信息用中文，正文引用对应 `F-xx` 验收项。
6. 实机相关改动（T4+）不能只靠单测：在 `PROGRESS.md` 记录人工清单执行结果。
7. 不做的事（见 REQUIREMENTS）：读取备份、ELF 转换、espefuse/espsecure、多用户鉴权、Safari 支持。（串口监视已入 v1：F-16，**2026-10-02 起默认关闭、手动 ▶ 开始**；独立日志窗口已移除。）
8. **日志渲染纪律**（实测洪峰卡页教训）：LogEntry 必须带 `seq` 作稳定 key；批量 flush（120ms）后才推视图；显示上限 500；不得恢复"每行一次响应式更新/索引 key 全量 diff"的写法。
9. **自动发布（2026-10-02 用户授权）**：`test` + `run build` 全绿并提交后，**直接发布云端，不再询问**。打包必须用 tools/package-deploy.ps1（dist 占位符 firmware.example.com 注入真实地址后再 zip；真实地址仅存本机 .fw-deploy.local（gitignored），严禁写入仓库/远端）→ scp → 远端 unzip → systemctl restart → 核对 `ExecMainStartTimestamp` 与外网入口 bundle 名，失败必须报告。
10. **font-cloud 自动上线（2026-10-04 用户授权）**：`font-cloud-server/` 改动同步部署，**不再询问**。`powershell -File font-cloud-server/deploy/deploy.ps1` → 核对 `font-cloud-server` 的 `ExecMainStartTimestamp` 与 `/font-cloud`、`/api/subset`。与 firmware-server 共存（8788），勿抢 `/llms.txt`。详见 docs/SERVER.md §5.5。

## 目录约定

```
src/core/     纯逻辑（状态机/日志/错误）— 零依赖，改这里必配测试
src/glue/     esptool-js 粘合层 — 唯一允许 import esptool-js 的地方
src/env/      环境自检
src/api/      外部数据客户端（registry=v1.5 自含服务；dev 中间件 buildArtifacts 已移除）
src/components/  Vue UI（ide/=五区骨架组件：活动栏/侧栏树/标签/底部面板/状态栏）
server/       v1.5 自含服务（纯 JS 零依赖 node:http）— registry/发布/静态托管
tools/publish/  发布 CLI（纯 JS 零依赖，once/--watch 等）
docs/          现行文档（USER-GUIDE/DESIGN/REQUIREMENTS/DEPLOY/SERVER/PUBLISH/TROUBLESHOOTING/FIRMWARE-REGISTRY）
docs/archive/  开发过程历史产出（EXECUTION-PLAN/PAGE-REDESIGN/IDF-ENV 等）
docs/research/ 专题调研报告（选型/复位能力）
tests/        Vitest（node 环境）：*.test.ts=前端核心层；*.test.js=server/CLI
tests/fixtures/ 假构建产物（e2e 用）
```

## 完成定义（DoD）

一个任务算完成 = ① 代码进对应层 ② 测试全绿（`test` + `run build`）③ `PROGRESS.md` 状态与变更日志更新 ④ 若涉及 F-xx，验收表打勾。
