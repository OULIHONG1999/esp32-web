# 执行计划 — 跨设备固件下载服务（防烂尾定稿）

> 状态：**已批准；门1 ✅ 门2 ✅（D4/console 用户暂缓挂起）门3 ✅（2026-09-29 远端发布→本地页面拉取实测）——进行 S3** · 关联：FIRMWARE-REGISTRY.md（设计）、DESIGN.md、PROGRESS.md
> 本文回答四件事：最终方案、执行线路、全部已知问题、每个步骤的具体实现与验收流程。

## 0. 一句话方案（不再变）

**远端 Windows `publish --watch` 自动发布 → Ubuntu 单一自含 Node 服务（registry+发布+SSE+静态前端）→ 本地页面订阅感知 → 一键载入 → 浏览器烧录本地 ESP32。**
烧录时序永不过网（P2P USB 失败的教训），网络只搬文件。

### 已拍板的技术选型（实现中不再讨论）

| 项 | 决定 |
|---|---|
| 服务端 | **Node 24 + 原生 `node:http`，零第三方依赖**；单文件夹部署；端口 `PORT`（默认 8787） |
| API | 全部相对路径 `/api/*`；**vite dev 用 proxy** 把 `/api/registry*` `/api/publish*` 转发到 `localhost:8787`，dev 专属（artifacts/build）留 vite 自管 |
| 存储 | `server-data/` 下：`registry.json` + `projects/<id>/<variant>/<release>/`；registry 写入 = tmp+rename 原子；附 `rebuild.js` 自愈工具 |
| 鉴权 | 发布/晋升带 `Authorization: Bearer <token>`（服务端 config + 环境变量）；读取公开；多用户命名空间仅预留 |
| 上传安全 | 文件名取 basename 且白名单 `[A-Za-z0-9._-]`、单文件 ≤64MB、单发布 ≤256MB、发布互斥锁、逐文件 SHA256 校验 |
| 发布端 | `tools/publish/` Node CLI（零依赖）：`once` / `--watch` / `--promote` / `--ai-notes`；读 `build/flash_args` + `publish.config.json`（assets 任意文件+地址） |
| 数据模型 | Project → Variant(按 target 自动) → Release(不可变快照, **parts 含 flashParams**)；snapshot/release 分层；retention 分类型 |
| 前端 | 固件区双 Tab（项目库 / ⚡本地构建保留）；载入三来源汇入同一表格；SSE 横幅+手动载入 |
| AI 说明 | S5 期；OpenAI 兼容 endpoint 可配置，diff hash 缓存 |

## 1. 线路总图（分片 + 验收门）

每片 = 一个可独立运行/验收的增量；**过门才进下一片，任何门后都可安全停止**（已完成部分独立可用）。

```
阶段1 文档修订 + v1 实现债          [门1: 单测全绿 + 你过一眼文档]
   ↓
S1  最小闭环（server+CLI once+手动载入） [门2: 本地端到端 + 你真机烧录一次 ★核心目标达成]
   ↓        （同门核对 D4 参数生效 / D5 MD5 校验）
S2  --watch 自动发布 + 增量 + Ubuntu 部署 [门3: 远端 Windows 真机：build→自动→本地烧录]
   ↓
S3  SSE 订阅 + 横幅/角标             [门4: 双开页面演示"远端发布、本地即知"]
   ↓
S4  版本管理完整形态（promote/说明/retention/项目库 UI/F-13 比对） [门5: 晋升/回滚/清理各一次]
   ↓
S5  可选增强（AI 说明/页面上传/多芯片 UI）——按需，可永不执行
   部署 runbook：随 S2 一并交付（Caddy + SSE 反代配置）
```

**关键次序说明**：
- D4/D5 需要实机，安排在**门2**（与 S1 验收同一次插板完成，不单独占你的时间）。
- Ubuntu 部署在 S2 末（远端 Windows 要访问公网 server 才能实测 watch）。
- 之所以 S1 先于 S2/S3：S1 就是"跨设备下载"本体（手动版），核心价值先落地。

## 2. 全部已知问题清单（分组，逐条对应处理点）

### A. 结构性（阶段1 文档修订必须写进设计，防返工）

| ID | 问题 | 处理 |
|---|---|---|
| S1' | dev/v1.5 双 API 割裂 | 定案：相对路径 + vite proxy（本文 §0） |
| S2' | Release 缺 flashParams | 模型补字段（阶段1 改 FIRMWARE-REGISTRY §4.1） |
| S3' | 上传路径穿越/超大/并发 | §0 安全条目写入设计（S1 实现） |
| S4' | registry 崩溃一致性 | 原子写 + rebuild.js（阶段1 设计、S1 实现） |
| S5' | 服务端栈未定 | §0 已拍板 |
| S6' | T6/F-03 旧线与 DESIGN §7 矛盾 | 阶段1：T6 废弃并入新线；§7 加 superseded 注 |

### B. v1 实现债（阶段1 代码修复，带测试）

| ID | 问题 | 处理 |
|---|---|---|
| D1 | F-05 承诺的降速重试未实现 | ✅ 2026-09-26 完成：flash 失败且 retryable → `reopenForRetry`（波特率/2 下限 115200，重建+重新同步）→ 重试一次；单测 4 用例 |
| D2 | detecting/working 无超时 → UI 锁死 | ✅ 2026-09-26 完成：detect 20s 超时→归位 error；flash 空闲 60s 无进度→归位 ready（进度重置计时）；TimeoutError 分类；单测 5 用例 |
| D3 | 烧录失败错误卡不可见（ready 态不显示 lastError） | ✅ 2026-09-26 完成：ready+error 态均显示可关闭错误条；临界区成功自动清除；单测 2 用例 |

### C. 实机核对（门2）

| ID | 问题 | 验收方式 |
|---|---|---|
| D4 | flash 参数生效疑云（80m vs 40MHz、SHA 警告、size） | 烧录后 `idf.py monitor` 看启动日志与传入参数一致性；不合则查 esptool-js 参数写入路径 |
| D5 | MD5 写入校验 | 传 `calculateMD5Hash`，日志出现 "Hash verified" |

### D. 已识别风险（各片内消化）

| 风险 | 对策 |
|---|---|
| watch 期间网络断 | CLI 重试退避（3 次），失败保留本地标记下次补传 |
| 发布并发 | 服务端互斥锁 + CLI 端 watch 防抖 |
| SSE 过反代缓冲 | runbook 写 Caddy `proxy_buffering off`；客户端有轮询降级 |
| 磁盘增长 | retention（S4）；runbook 记录检查命令 |
| token 泄露 | env 注入；泄露=换 token 重启（单用户可接受） |
| Windows 路径/编码 | CLI 全程 UTF-8、路径用 path 模块；门3 远端实测覆盖 |
| AI endpoint 未定 | S5 才需要，届时配置化（开放问题不阻塞） |

### E. 明确不做（直到对应片通过）

页面补充上传（S5）、自动载入（永不做）、擦除单区、监视波特率配置、多用户（仅预留）、esptool 升级（另有纪律）。

## 3. 每阶段的具体实现流程

### 阶段1：文档修订 + 实现债（预计 1 个会话内完成）——✅ 全部完成（2026-09-26，待门1）

1. ✅ 改 `FIRMWARE-REGISTRY.md`：§3 加 API proxy 定案、§4.1 Release 补 `flashParams`、§5.4 补安全条目与 rebuild 工具、§0 技术选型表（同步 §0）；
2. ✅ 改 `DESIGN.md` §7 superseded 注 + §4.1/§4.4 超时与降速规则；`PROGRESS.md` 任务线重排（T11）；
3. ✅ 代码：D1（flash 重试）、D2（超时）、D3（错误条）各带单测 → `test + build` 全绿（43 测试）→ `fix(v1-debt)` commit；
4. ✅ 更新验收表 F-05 状态标注。
**门1**：✅ 已过（2026-09-27）——43 测试全绿；用户确认 5 项拍板（降速语义/20s·60s 超时/错误条/64MB·256MB 限制/超时范围砍削）。

### S1：最小闭环（预计 1–2 个会话）——✅ 代码+本地 e2e 完成（2026-09-27），待门2 真机

实现顺序（每步可编译可测）：
1. ✅ `server/` 骨架：config（token/port/dataDir）+ 静态托管 dist + `GET /api/registry`（读，含 ETag）；
2. ✅ `POST /api/publish`：鉴权→校验（白名单/64MB/256MB）→SHA256→原子落位→更新 registry→互斥；**单测**（穿越、超限、坏 hash、幂等补传）；
3. ✅ `tools/publish/`：`publish once`（解析 flash_args+config.assets→查缺→multipart 上传）；**单测**（解析、差集、fixtures 全集）；
4. ✅ 前端：固件区"项目库"最小版——拉 registry、列 latest、点载入进现有表格（flashParams 注入）；vite proxy 已配；
5. ✅ fixtures：`tests/fixtures/fake-build/`（计划原文 test/fixtures，实现统一进 tests/）四段假 bin；e2e 测试：CLI→server→registry→下载比对→幂等 0 上传→错 token 拒收，5 用例全过。
**门2（核心）**：本地 fixtures 全链路自动通过 ✅ → 真机 publish hello_world ✅ → 页面载入 → 烧录成功（两轮实测，第二轮 4 项修复全过）✅ → **D5 校验 ✅**（三段 Hash of data verified）→ **D4 待核**（参数已注入 80m/2MB，boot banner 确认待 console 切换后页面日志完成）→ 验收表勾选待执行。附：F-17/F-18/F-19 同轮回归通过；"无设备日志"定位 console=UART0 配置（问题 19）。

### S2：自动发布 + 部署——✅ 已过门3（2026-09-29）

1. ✅ CLI `--watch`（防抖 5s + 失败退避 3 次 + pending 补传；发布输入签名盯 flash_args/产物/desc/assets）；
2. ✅ 增量效率（跨 release 按 sha 复用：server `findPartBySha` + CLI `collectShaSet`，**实测"上传=0 秒回"**）；
3. ✅ Ubuntu 部署（腾讯云 firmware.example.com：Node 24.21 + systemd + 免密 + SSH 隧道；nginx/certbot 待 dpkg 锁释放补 HTTPS——DEPLOY §5 隧道方案已覆盖验收）；
4. ✅ watch 真机：本机挂 watch → 远端 registry 自动出现 → **本地浏览器 localhost:8787 页面载入 80m/2MB 注入（用户日志确认）**。
**门3**：✅ 过（烧录核对随 D4 暂缓项一并）。尾巴：HTTPS/域名 DNS 解析（非阻塞）。

### S3：订阅——🔄 代码完成（2026-09-29），待门4 演示

SSE 端点（`server/stream.js`：心跳、断开清理、X-Accel-Buffering no）+ publish 成功广播 + subscribe 写接口 → 前端订阅状态（EventSource + localStorage/服务端双写 ★）→ 横幅/●NEW 角标/header 状态点 → 30s 轮询降级（快照 diff 纯函数）→ 手动载入清角标。服务器已部署 SSE 版（retry:3000 握手验证）。**门4**：双开页面演示"远端发布、本地即知"（待用户）。

### S4：版本管理

`--promote`（手写 note）→ 前端版本时间线/晋升/回滚 → retention 清理+确认语义 → F-13 芯片比对 → rebuild 工具实测。**门5**：晋升/回滚/清理各走一遍。

### S5：按需增强
AI notes（endpoint 配置化）、页面上传、多芯片 UI。

## 4. 防烂尾机制（纪律）

1. **门制度**：不过门不进下一片；每门有明确的"你亲手做的验收动作"（上表）；
2. **可停点**：任何门后停止，已交付部分独立可用、文档一致、仓库全绿；
3. **commit 粒度**：每完成一个步骤小 commit，每片结束一个带 F-xx 的功能 commit；测试/build 不绿不提交；
4. **文档同步**：每片结束更新 PROGRESS（进度+变更日志）与验收表——本文要求的验收动作本身就是文档更新点；
5. **范围冻结**：E 组"明确不做"在对应门通过前出现的需求，一律记入 backlog，不插队；
6. **上下文经济**：每片开工只读「本文 + FIRMWARE-REGISTRY 相关节 + PROGRESS」，不重翻全部会话历史。

## 5. 任务面板映射

| 任务 | 内容 |
|---|---|
| T11 | 阶段1：文档修订 S1'–S6' + 实现债 D1–D3 |
| T12 | S1：server + CLI once + 前端手动载入（门2 含 D4/D5） |
| T13 | S2：watch + 增量 + 部署 runbook + 远端实测（门3） |
| T14 | S3：SSE 订阅 + 横幅（门4） |
| T15（新建） | S4：版本管理完整形态（门5） |
| T16（新建） | S5：可选增强（不排期） |

## 6. 剩余开放问题（不阻塞任何门）

- AI 说明的 endpoint 具体选型（S5 时定）；
- 部署域名/Caddy vs nginx（S2 部署时定，runbook 两者都给）；
- 监视波特率、擦除单区等 backlog 小项。
