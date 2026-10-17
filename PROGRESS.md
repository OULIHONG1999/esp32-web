# PROGRESS — ESP32 Web Flasher 工作记录（总览）

> 本文件是**活的进度总览**：每次有意义的推进后更新这里的「当前状态」「验收」「下一步」。
> 新接手的 AI/工程师请先读本文，再读 `AGENTS.md`。
> 最后更新：2026-10-18（**文档拆分**：PROGRESS 瘦身为总分入口；历史/决策/结构拆入 `docs/progress/`——变更日志 `changelog.md`、关键决策与坑 `decisions.md`、代码结构 `structure.md`）

## 一句话

单用户自用的 ESP32 网页烧录工具：官方 esptool-js 做内核（只升不改），UI/日志/文件/命令控制全自研；第一目标芯片 ESP32-S3。核心模型：**设备常驻连接（方向1）+ 连接即自动日志监视（烧录后自动进监视）**。v1.5 起扩展为跨设备服务：远端 publish → 自含 server → 本地订阅烧录 + OTA 推送 + coredump 上报 + fetch 命令通道 + 云盘。

## 文档地图（阅读顺序 · 2026-10-18 拆分后）

> 组织：`docs/` 现行 · `docs/archive/` 开发历史产出 · `docs/research/` 专题调研 · `docs/progress/` 工作记录分文档 · 根目录仅 README/AGENTS/PROGRESS。
> **改文档改 `docs/` 源头，改完同步拷贝到 `public/docs/`（公网 /docs/ 由 build 从 public 拷入 dist）。**
> **`docs/progress/` 与根目录 `PROGRESS.md` 是内部工作记录，不挂公网、不镜像。**

0. **`README.md` — 方案总览（一页纸入口：能力/架构图/快速开始/文档导航）**
1. **`docs/USER-GUIDE.md` — 使用手册（操作者：三分钟上手/监视语义/取证操作卡）**
2. `docs/REQUIREMENTS.md` — 6 项决策（D1–D6）+ 验收清单（F-01…F-24）
3. `docs/DESIGN.md` — 架构/状态机（§4.1）/错误（§4.4）/UI 五区（§4.5）/部署
4. `AGENTS.md` — 接手纪律与命令
5. `docs/DEPLOY.md`（含本机快速路径）+ `docs/SERVER.md`（部署快照）
6. `docs/PUBLISH.md` — 发布指南
7. `docs/TROUBLESHOOTING.md` — 故障排查
8. `docs/FIRMWARE-REGISTRY.md` — v1.5 固件库设计
9. **`docs/ota.md` — OTA 三端设计契约（设备/云端/页面）；页面端已落地为独立页 `/OTA`**
   - `docs/PUSH-TO-DEVICE.md` — **推送固件给指定设备（已实现并上线）**
   - `docs/coredump.md` — **崩溃上报三端契约（服务器+页面已实现）** + `docs/coredump-upload.md`（设备端上传设计）
   - `docs/fetch-channel/` — **FETCH 命令通道交接文档包（服务器已上线；设备端固件 0.12.3 已实现 fetcher）**
   - `docs/cloud-drive.md` — **云盘三端契约（服务器 + 页面已实现并上线）**
10. `docs/research/*/REPORT.md` — 选型与复位能力调研（现行参考）
11. `docs/archive/README.md` — 历史产出索引（EXECUTION-PLAN/PAGE-REDESIGN/IDF-ENV/实测报告等）
12. 本文 — 进度总览（当前状态/验收/下一步）
13. **`docs/progress/` — 工作记录分文档**：`changelog.md`（变更日志，只追加）· `decisions.md`（关键决策与坑 1–24）· `structure.md`（代码结构清单）

## 当前状态（任务面板同步）

| 任务 | 状态 | 证据 |
|---|---|---|
| T1 脚手架 Vue3+Vite+TS | ✅ done | build 通过 |
| T2 环境自检（F-01） | ✅ done | `src/env/environment.ts` + EnvCheck；2026-10-06 修正为**根因优先级单条上报** + 现场信息，`tests/environment.test.ts` 16 用例 |
| T3 核心层（状态机/日志/错误/粘合） | ✅ done | Vitest 全绿 |
| T4 实机连接 | ✅ done | 实测：原生 USB 0x303a:0x1001 识别 ESP32-S3，自动进下载 |
| T5 烧录主链路 | ✅ done | 实测：⚡一键载入三段 → 烧录 → Hello world 重启循环 |
| T6 擦除+manifest 收尾 | ⏸ 并入新线 | 擦除/重烧/日志查看已实测通过；manifest 服务器托管**废弃并入 v1.5 registry 线** |
| T7 方向1 设备常驻重构 | ✅ done | `core/device.ts` + `glue/deviceOps.ts`；真机长期使用验证 |
| T8 日志渲染性能 | ✅ done | 批量 flush + seq key + 显示 500 + 暂停视图；洪峰已修（问题 24） |
| T9 文档同步 | ✅ done | DESIGN §4.1/§4.2、AGENTS、REQUIREMENTS（F-17/F-18） |
| T10 IDF 命令按钮（F-19） | ✖ 已移除 | 2026-09-29 随页面功能优化整体删除 |

| **T11 阶段1 文档+实现债** | ✅ done | 门1 已过 |
| **T12 S1 最小闭环** | ✅ 门2 已过 | 代码+e2e+真机全通；复测 4 项修复全过（80m/2MB 注入、首把成功、D5 三段 verified）；D4/console 已闭环（console 切 USB_SERIAL_JTAG，2026-09-29 问题19 关闭） |
| **S2 自动发布+部署** | ✅ 门3 已过 | watch 自动发布+增量 0 上传+服务器部署+隧道全通；本地载入远端版本实测 |
| **S3 SSE 订阅** | ✅ 门4 已过 | 横幅+●NEW 实测；SSE/轮询降级/★开关全实测 |
| **S4 版本管理** | ✅ 门5 已过 | promote/回滚/retention + CLI + 时间线 + F-13 芯片比对；用户实测流程跑通 |

| **OTA 三端（页面+服务器）** | ✅ 页面与服务器就绪 | 页面 `/OTA` + 描述符 `/ota.json` + 契约 `docs/ota.md` + 服务器四端点；设备模拟器 + 端到端 24/24；**设备端固件已就绪**（真机 `b81f3fc8768c` 在线报固件 0.6.0）；入口 `docs/DEVICE-OTA.md` |
| **推送固件到指定设备（push）** | ✅ 已实现并上线 | 离线不下发（412）/可撤销/迟到回执不覆盖；CLI `push`（退出码 0–12+130）+ 页面置灰与撤销；2026-10-07 真机端到端验证（42s 成功，速度与 USB 相当） |
| **coredump 崩溃上报** | ✅ 服务器+页面已实现 | 上传二进制 body + 幂等排重 + 独立页 `/coredump` + 符号化离线；`tests/coredumps.test.js` 15 用例；设备端上传方待做（另一台电脑） |
| **fetch 命令通道** | ✅ 服务器已实现并上线 | 服务器端 fetch 受理（url/dest/maxBytes 校验钳位 + 六字段信封 + `/files/` 静态托管 + 复用 ota 409/412/撤销语义）；**2026-10-17 真机端到端闭环**（云盘 → fetch → 设备取走 → success 回执）；设备端固件 0.12.3 已实现 fetcher |
| **云盘 /drive** | ✅ 服务器+页面已实现并上线 | `/api/drive/files*` 四端点 + `/drive` 独立页 + `drive.json` 描述符；净化/配额/幂等删除/下载附件头；文档 `docs/cloud-drive.md` |

**待用户决策**：主操作按钮方案——推荐映射「⚡一键烧录 / 查看日志 / 选择文件」vs 字面三按钮（下载 / 下载并查看日志 / 查看日志），见会话记录 2026-09-26。

## 验收对照（REQUIREMENTS F-xx）

| 需求 | 状态 | 备注 |
|---|---|---|
| F-01 环境自检 | ✅ | 代码+实机浏览器路径；根因单条上报 + 现场信息 |
| F-02 文件选择 | ✅ | 手动多选 + 项目库载入 |
| F-03 选固件（服务器） | ✅ | registry 项目库载入（UI+下载+参数注入）；真机发布载入跑通 |
| F-04 连接 | ✅ | 实机 COM3/原生 USB |
| F-05 烧录 | ✅ | 实机三段烧录成功；门2 复测全过（80m/2MB 参数注入、D5 verified） |
| F-06 擦除 | ✅ | 用户实测通过（擦除→重烧→恢复） |
| F-07 自动硬复位 | ✅ | 实机观测 + 单测断言 |
| F-08 日志 | ✅ | 分级/导出/行切分单测 |
| F-09 状态机 | ✅ | DeviceManager 用例（方向1 模型 + D1/D2/D3） |
| F-10 错误翻译 | ✅ | 含 TimeoutError 分类 |
| F-11 S3 三层复位 | ✅ | 实机自动进下载（未按 BOOT） |
| F-12 芯片信息展示 | ✅ | ChipInfo + 详情卡 + 烧录前二次确认 |
| F-13 chipFamily 比对 | ✅ | 载入时 confirm 警告不阻断 |
| F-14 地址预设 | ✅ | flash_args 权威地址 |
| F-15 会话可重复 | ✅ | 实机二次烧录验证 |
| F-16 实时串口日志 | ✅ | 对齐 idf monitor：手动开 + 开即复位 + ↻信号复位；烧录后自动进监视（🖥 可关） |
| F-17 设备常驻连接 | ✅ | 代码+真机长期使用验证；免弹窗/临界区挂起恢复/拔线感知 |
| F-18 日志渲染性能 | ✅ | 洪峰修复（批量 flush/seq key/500 上限）+ 智能自动滚动 |
| F-19 IDF 命令按钮 | ✖ 已移除 | 2026-09-29 应用户要求整体删除 |

| F-20 项目/版本/多芯片变体 | ✅ | 三层+latest 载入+回滚+时间线 |
| F-21 订阅推送 | ✅ | SSE+轮询降级+★开关；门4 实测 |
| F-22 任意烧录文件管理 | 🔄 | parts 统一建模+assets+分区类型；页面补充上传=S5（按需不排期） |
| F-23 发布 CLI 与自动触发 | ✅ | once+watch+Bearer+增量+flash_args/assets |
| F-24 版本说明与保留策略 | ✅ | promote 必填 note + retention；门5 实测 |

> v1.5 之外新增能力（无独立 F-xx，随需求演进）：**程序版本号**（右下角真实 git hash·构建时间）、**烧录后自动监视开关**、**日志智能滚动+回到底部**、**ota/push/coredump/fetch/drive** 五套三端体系。

## 下一步

1. **持续体验优化（进行中）**：当前阶段=收集用户对页面体验的优化建议并落地（最近三连：程序版本号、烧录后自动监视、日志智能滚动）。
2. **backlog（记录不动，按需排查）**：
   - watch 后台网络失败（问题 20）：发布继续用手动 `once`。
   - flash_args 参数生效性收尾核对（镜像头 4MB vs 16MB 等，见 `decisions.md` 外部环境快照）。
   - 硬复位按钮不可用（2026-10-02 报告）：R-1 信号复位已重构端口/复位链路，使用中若再遇再查（排查方向 runCritical assert / glue hardReset 序列）。
3. **设备端（在另一台电脑开发）**：push 过程上报（progress/trail）、coredump 上传方——入口 `docs/DEVICE-OTA.md` / `docs/coredump-upload.md` / `docs/fetch-channel/01-device.md`。
4. **S5 页面补充上传**：按需不排期。
5. 等用户拍板：主操作按钮方案（见会话记录 2026-09-26）。