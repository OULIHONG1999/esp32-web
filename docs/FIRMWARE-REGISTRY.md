# 固件项目库与远程发布 — 设计文档（FIRMWARE-REGISTRY）

> 状态：需求定稿，实现走线以 **`archive/EXECUTION-PLAN.md`（已批准）** 为准 · 2026-09-26 · 关联：DESIGN.md、REQUIREMENTS.md（F-20…F-24）、PROGRESS.md
> 本文是三轮需求讨论（项目管理 → 托管/订阅 → 任意烧录文件）的合并定稿。执行顺序/验收门/实现债见 EXECUTION-PLAN；本文不重复其线路细节。

## 0. 已拍板的技术选型（实现中不再讨论，与 EXECUTION-PLAN §0 同步）

| 项 | 决定 |
|---|---|
| 服务端 | **Node 24 + 原生 `node:http`，零第三方依赖**；单文件夹部署；端口 `PORT`（默认 8787） |
| API | 全部相对路径 `/api/*`；**vite dev 用 proxy** 把 `/api/registry*` `/api/publish*` 转发到 `localhost:8787`，dev 专属中间件（artifacts/build）已于 2026-09-29 移除 |
| 存储 | `server-data/` 下：`registry.json` + `projects/<id>/<variant>/<release>/`；registry 写入 = tmp+rename 原子；附 `rebuild.js` 自愈工具 |
| 鉴权 | 发布/晋升带 `Authorization: Bearer <token>`（服务端 config + 环境变量）；读取公开；多用户命名空间仅预留 |
| 上传安全 | 文件名取 basename 且白名单 `[A-Za-z0-9._-]`、单文件 ≤64MB、单发布 ≤256MB、发布互斥锁、逐文件 SHA256 校验 |
| 发布端 | `tools/publish/` Node CLI（零依赖）：`once` / `--watch` / `--promote` / `--ai-notes`；读 `build/flash_args` + `publish.config.json`（assets 任意文件+地址） |
| 数据模型 | Project → Variant(按 target 自动) → Release(不可变快照, **parts 含 flashParams**）；snapshot/release 分层；retention 分类型 |
| 前端 | 固件区双 Tab（项目库 / ⚡本地构建保留）；载入三来源汇入同一表格；SSE 横幅+手动载入 |
| AI 说明 | S5 期；OpenAI 兼容 endpoint 可配置，diff hash 缓存 |

## 1. 背景与目标

**真实链路**：远端 Windows 电脑（代码 + IDF + build）→ Ubuntu 云服务器（托管）→ 本地网页工具 → 本地 ESP32-S3（USB 烧录）。

**体验目标**：远端编译完，本地页面通过**订阅**感知新版本，一键载入烧录——对标本地 ⚡载入，跨网等价。

**约束（用户定）**：
- 平台无关（远端是 Windows，方案不得绑定 OS/SSH）
- **服务自含**：托管/发布/订阅全部是我们框架自己的组件跑在 Ubuntu，不依赖服务器上其他东西（git/nginx 逻辑/外部 SaaS）
- 当前单用户；鉴权与多用户只留扩展点

## 2. 需求清单

| # | 需求 | 状态 |
|---|---|---|
| N1 | 平台无关的发布端（HTTP） | 定稿 |
| N2 | 自含 Node 服务（registry + 发布 + 订阅 + 静态前端） | 定稿 |
| N3 | 项目/版本模型清晰不乱 | 定稿（§4） |
| N4 | 前端信息架构两跳可达（项目→版本） | 定稿（§7） |
| N5 | 订阅：远端发布 → 本地自动感知（SSE，轮询降级） | 定稿 |
| N6 | 远端可本地模拟（发布输入=项目信息+bin，与 build 解耦） | 定稿（§9） |
| N7 | 本地一键载入复用现有烧录表格 | 定稿 |
| N8 | **任意烧录文件管理**：编译产物之外（字体、littlefs 镜像等）任意文件+地址，随版本管理 | 定稿（§4/§5） |
| N9 | 自动触发发布（watch/钩子） | 定稿（§5，watch 为主） |
| N10 | 版本说明：历史版（免说明）/发布版（说明，支持 AI 或手写） | 定稿（§4.2） |
| N11 | 保留策略按项目配置，切换需确认、不追溯承诺 | 定稿（§4.3） |
| N12 | 多芯片变体（set-target 一码多芯，按 target 自动归类） | 定稿（§4.1） |

## 3. 总体架构（三端）

> **API 路径定案（S1'）**：前后端一律相对路径 `/api/*`，不写死 host。生产：server 同域托管 dist，天然同源；开发：vite dev 配 proxy，把 `/api/registry*`、`/api/publish*` 转发到 `localhost:8787`，而 dev 专属的 IDF 中间件（artifacts/build，DESIGN §4.6）已于 2026-09-29 移除。
>
> **S1 已实现端点**（2026-09-27，`server/app.js`）：`GET /api/registry`（含 ETag）、`POST /api/publish`（Bearer 鉴权 + multipart）、`GET /api/registry/projects/:pid/variants/:vid/releases/:rid/parts/:file`（下载，路径段白名单+前缀双检）、静态 `dist/`（SPA fallback）。SSE `…/registry/stream` 与 promote/notes 未实现（S3/S4）。

```
【Windows build 机】
  publish CLI（Node，跨平台）
    publish --watch   盯 build 目录 → 防抖 → 自动发布
    publish once      手动发布；--promote 升发布版；--ai-notes 生成说明
        │  HTTP POST /api/publish（Bearer token；查缺后只传变化 bin）
        ▼
【Ubuntu 云服务器 · 单一自含服务 server/（Node）】
  GET  /api/registry                      项目/变体/版本清单（读取公开）
  GET  /api/registry/stream               SSE：publish 事件推送（订阅）
  GET  /api/.../releases/:id/parts/:file  下载 bin（SHA256 校验）
  POST /api/publish                       发布（token）；查缺提示接口
  POST /api/.../promote / notes           晋升发布版 / 改说明（token）
  GET  静态资源 dist/                      前端
        ▲                    │
        │ registry(SSE/轮询)  │ 拉取 parts
【本地网页工具】
  项目库 Tab（订阅★ → 新版本横幅 → 手动点载入）→ 复用烧录表格/日志/状态机
  ⚡本地构建 Tab（保留，不经服务器）
```

## 4. 数据模型（v3）

### 4.1 三层结构：Project → Variant（按芯片）→ Release

```
Project {
  id, name, description,
  subscribed: boolean,                    // ★ 订阅（存服务端，跨设备一致）
  retention: { snapshots: number|"all",   // 历史版保留策略（默认 30）
               releases:  "all" },        // 发布版默认永不自动删
  variants: {
    "ESP32-S3": { latest: ReleaseId, releases: Release[] ... }
    "ESP32-C3": { ... }                   // set-target 多芯片 → CLI 自动归类
  }
}

Release（不可变快照，一次烧录的完整文件全集）{
  id: "20260926-2210-3f8a",               // 时间戳 + commit 短哈希
  type: "snapshot" | "release",
  chipFamily: "ESP32-S3",
  flashParams: { mode, freq, size },      // ★ S2'：随快照固化（如 dio/40m/16MB），载入时注入烧录参数
  note: string,                            // snapshot: 自动一行摘要或空
                                            // release: 手写 或 AI 生成
  noteSource?: "manual" | "ai",
  commit?: string, gitDirty?: boolean,
  createdAt,
  parts: [                                 // ★ N8：任意烧录文件统一建模
    { label, address, file, sha256, size,
      type?, subType? }                    // ★ 分区类型（2026-09-29 增强）：CLI 解析
    // partition-table.bin 按地址匹配填入（app/factory、data/littlefs 等）；config.assets 可显式声明
    // 缺省 undefined=旧数据/未识别（bootloader/表/手动添加），前端显示 —，向后兼容
    // 编译产物：来自 flash_args；字体/资源：来自 publish.config.json；页面补充上传同入此数组
  ]
}
```

**关键决定**：
- **一切烧录内容皆 parts**（N8）：flash_args 产出 + config 声明的字体等资源 + 页面补充上传，**统一进 Release.parts**——回滚到旧版=当时的完整烧录内容，杜绝"新字体配旧固件"的错配。
- manifest/meta/checksums 合一：地址、SHA256、说明全在 Release 内；全局入口只有 registry。

### 4.2 历史版 vs 发布版（N10）

| | Snapshot 历史版 | Release 发布版 |
|---|---|---|
| 产生 | publish 自动创建（watch 每次编译） | 从 snapshot `promote` 晋升，或 publish 时 `--release` 直接创建 |
| 说明 | 免填；自动生成一行 `commit+时间` | 必填：`--note` 手写，或 `--ai-notes` 由 **git diff+log 生成**（按 diff hash 缓存去重，防重复内容） |
| 晋升时 | — | **AI 说明生成发生在这里**，不在每次编译 |
| 自动清理 | 受 `retention.snapshots` 管 | 永不自动删 |

AI 说明调用端配置在本机（endpoint+key 进配置文件不进仓库）；`--ai-notes` 失败可回退手写。

### 4.3 保留策略与切换语义（N11）

- 按项目配置、**snapshots/releases 分离**（§4.1）。
- `all → N` 切换：**只影响未来新快照 + 一次性确认弹层列出将删清单**；`releases` 永不波及——解决"说好全保留又被删"的矛盾。
- 执行时机：下次 publish 时按策略清理（服务端做，带日志）。

## 5. 发布链（N1 + N9 + N8）

### 5.1 CLI 命令面

```
publish init                 在工程根生成 publish.config.json（首次）
publish once                 单次发布（读 build/flash_args + config 附加 parts）
publish --watch              轮询/监听 build 目录（防抖 5s）→ 自动发布
publish --promote <id> [--note "..." | --ai-notes]   晋升发布版
publish --config path        多工程/CI 场景显式指定配置
```

### 5.2 publish.config.json（工程根，进 git）

```jsonc
{
  "server": "https://firmware.example.com",
  "token": "${FIRMWARE_PUBLISH_TOKEN}",       // 环境变量引用，不落明文
  "project": { "id": "hello-world", "name": "Hello World", "description": "..." },
  "assets": [                                  // ★ N8 附加烧录文件
    { "label": "font", "file": "assets/fonts.hdr", "address": "0x290000" }
  ],
  "assetsByVariant": { "ESP32-C3": [ ... ] }   // 多芯片差异化资源
}
```

### 5.3 发布流程（增量 + 完整性）

```
1. 读 build/flash_args（地址权威）+ project_description.json（target→variant）
   + config.assets → parts 全集，逐文件算 SHA256
2. GET /api/registry → 对比服务器已有 sha256 → 差集
3. POST /api/publish（JSON 元数据 + 仅缺失文件的 multipart）
4. 服务端：校验每文件 sha256 → 落盘临时目录 → 原子 rename 为 Release 目录
   → 更新 variant.latest → 按 retention 清理 → SSE 广播 publish 事件
```

浏览器直接上传 = 同一 API 的第二客户端（页面"补充文件/上传固件"入口，测试与临时发布用）。

### 5.4 上传安全与崩溃一致性（S3'/S4' 定案，S1 实现）

- **路径安全**：服务端对 multipart 文件名取 `basename` 并过白名单 `[A-Za-z0-9._-]`，拒绝 `..`/分隔符/非 ASCII；落盘路径永远由服务端按 `projects/<id>/<variant>/<release>/` 拼接，不信任客户端路径。
- **体量上限**：单文件 ≤64MB、单发布 ≤256MB，超限 413 拒收；发布按 Release 加互斥锁（并发发布 409）。
- **完整性**：逐文件 SHA256 与元数据比对，不匹配即拒（400），不落正式目录。
- **原子性**：文件先进临时目录，全部校验通过后原子 rename 为 Release 目录，再以 tmp+rename 更新 `registry.json`——读者永远看不到半份 Release。
- **自愈**：`server-data/rebuild.js` 扫描 `projects/` 目录树重建 `registry.json`（registry 丢失/损坏时手动执行）；retention 清理同样只删完整目录。

## 6. 订阅链（N5）

- 页面 `GET /api/registry/stream`（SSE）：事件 `publish {project, variant, release}` →
  - ★订阅项目：顶部横幅 `hello-world/S3 已发布 vX [查看]` + 列表角标 NEW
  - **手动点载入**（已确认，防烧录中被换包）
- 降级：SSE 断开 → 30s 轮询 registry 版本号（etag）。
- 订阅状态存服务端 registry（登录态不需要，单用户）。

## 7. 前端信息架构（N4）

固件区双 Tab：`[📁 项目库] [⚡ 本地构建]`（⚡保留，已确认）。

```
项目库 Tab
├ 项目列表（★订阅置顶 · chip 徽标 · NEW 角标）
├ 变体切换（仅多芯片项目显示）：ESP32-S3 | ESP32-C3
├ 版本时间线（倒序，两跳可达）：
│    vX · [历史版|发布版徽章] · note · 日期   [载入此版本]
└ 展开项：parts 表（label/address/size/sha256前8位）
```

载入 → 复用现有烧录表格（地址可改）→ 设备 ready 后烧录（临界区/自动日志/自动复位全复用）。

## 8. 鉴权与多用户扩展点（已决）

- **发布（写）**：`Authorization: Bearer <token>`，token 存 CLI 配置/页面 localStorage；服务端单 token 校验。
- **读取（registry/bin）**：暂公开（单用户、固件不敏感前提）；扩展点=加读 token 中间件即可。
- **多用户扩展点（不实现，仅预留）**：
  - registry 与存储目录按 `userId/` 命名空间分层
  - token → userId 映射表
  - Release 增加 `owner` 字段
  - 文件管理的配额/可见性策略留接口

## 9. 测试策略（N6）

- **本地模拟远端**：`server/` 同一份代码在 Windows 本地 `node server.js` 跑；用 fixtures（三段 bin + config）执行 `publish once` → 页面 localhost 端到端验证。
- 自动化：server 单测（发布校验/查缺/retention/promote）、CLI 单测（flash_args+assets 解析、差集计算）、页面 e2e 以手工实机为主。
- 远端 Windows 真机验收：`publish --watch` 挂上 → 本机 build → 订阅横幅 → 载入 → 烧录。

## 10. 实现拆解（任务序列）

> ⚠️ **编号以 EXECUTION-PLAN §5 为准**：下表是本设计文档的历史拆解（T11–T14），现行任务面板为 T11=阶段1（文档+实现债）→ T12=S1 最小闭环 → T13=S2 watch+部署 → T14=S3 订阅 → T15=S4 版本管理 → T16=S5 可选。两表内容可按下述映射理解：本表 T11≈现行 T11+T12（server），T12≈T12（CLI），T13≈T13+T14（前端），T14≈T14 收尾。

| 任务 | 内容 | 依赖 |
|---|---|---|
| T11 | `server/`：registry 存储 + 发布 API（校验/原子落位/查缺）+ SSE + 静态托管 | — |
| T12 | `publish` CLI：flash_args/config 解析、增量上传、--watch、--promote/--ai-notes | T11 |
| T13 | 前端：项目库 Tab、订阅横幅/角标、载入、补充文件上传 | T11 |
| T14 | 端到端验收（本地模拟 + 远端 Windows watch 实测）+ 文档收尾 | T11–13 |

**v1 既有功能不受影响**；本扩展新增 REQUIREMENTS F-20（项目/版本/多芯片变体）、F-21（订阅推送）、F-22（任意烧录文件管理）、F-23（发布 CLI 与自动触发）。

## 11. 已决问题记录

1. 发布鉴权：静态 token（写保护、读公开），预留多用户命名空间（§8）。
2. 新版本到达：横幅提示 + 手动载入。
3. ⚡本地构建按钮：保留（不启动 IDF 环境也能烧，有改造空间）。
4. 远端 OS：Windows；发布端 Node CLI 跨平台。
5. 自动触发：`--watch` 为主，包装脚本为备选。
6. 版本说明：snapshot 免说明，promote 时手写或 AI 生成（diff 缓存去重）。
7. 保留策略：按项目、分类型；切换只向未来生效+确认清单。
8. 任意烧录文件（字体等）：统一进 Release.parts（快照完整性）。

## 12. 开放问题

- AI 说明的 endpoint 选型（本地 MiMo / OpenAI 兼容接口 / 其他）——实现 T12 时定，默认做成"可配置任意 OpenAI 兼容 endpoint"。
- SSE 与反向代理缓冲（Caddy/nginx 需 `proxy_buffering off`）——部署 runbook 时写明。
