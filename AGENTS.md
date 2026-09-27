# AGENTS.md — ESP32 Web Flasher 接手指引

给下一个接手的 AI/工程师：**先读 `PROGRESS.md`**（进度与坑），本文只讲纪律和入口。需求与设计的原文以 `REQUIREMENTS.md` / `DESIGN.md` 为准，不要凭记忆重写。

## 快速入口

| 要做什么 | 入口 |
|---|---|
| 了解当前进度 / 下一步 | `PROGRESS.md` |
| 验收标准（F-xx） | `REQUIREMENTS.md` §2 |
| 架构与状态机定义 | `DESIGN.md` §3–§4 |
| 为什么选这条路线 | `research/esp32-web-flash/REPORT.md` |

## 命令（本机 Node 不在 PATH）

```powershell
& $env:MIMO_NODE $env:MIMO_NPM install
& $env:MIMO_NODE $env:MIMO_NPM test          # Vitest，提交前必须全绿
& $env:MIMO_NODE $env:MIMO_NPM run build     # vue-tsc --noEmit + vite build，必须过
& $env:MIMO_NODE $env:MIMO_NPM run dev
```

## 硬性纪律

1. **esptool-js 只升不改**：锁 `0.7.0`；`typescript` 锁 `5.9`（TS7 会砸 vue-tsc，见 PROGRESS 坑1）。
2. **分层**：`esptool-js` 的 import 只允许出现在 `src/glue/`；`src/core/` 不得引用任何浏览器 API 或 esptool（这是可单测性的根基）。
3. **改状态机迁移表**（`src/core/device.ts` 的 `TRANSITIONS`/`ALLOWED`，方向1 设备常驻模型）必须同步：`DESIGN.md` §4.1 + `tests/device.test.ts`。
4. **改错误文案/分类**同步 `DESIGN.md` §4.4 与 `tests/errors.test.ts`。
5. 提交信息用中文，正文引用对应 `F-xx` 验收项。
6. 实机相关改动（T4+）不能只靠单测：在 `PROGRESS.md` 记录人工清单执行结果。
7. 不做的事（见 REQUIREMENTS）：读取备份、ELF 转换、espefuse/espsecure、多用户鉴权、Safari 支持。（串口监视已入 v1：F-16，且方向1 下**连接后自动开启**，没有手动开关。）
8. **日志渲染纪律**（实测洪峰卡页教训）：LogEntry 必须带 `seq` 作稳定 key；批量 flush（120ms）后才推视图；显示上限 500；不得恢复"每行一次响应式更新/索引 key 全量 diff"的写法。

## 目录约定

```
src/core/     纯逻辑（状态机/日志/错误）— 零依赖，改这里必配测试
src/glue/     esptool-js 粘合层 — 唯一允许 import esptool-js 的地方
src/env/      环境自检
src/components/  Vue UI
tests/        Vitest（node 环境，不起浏览器）
```

## 完成定义（DoD）

一个任务算完成 = ① 代码进对应层 ② 测试全绿（`test` + `run build`）③ `PROGRESS.md` 状态与变更日志更新 ④ 若涉及 F-xx，验收表打勾。
