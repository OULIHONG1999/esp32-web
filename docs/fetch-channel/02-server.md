# FETCH 通道 —— 服务器端实现（02，交服务器智能体执行）

> **【智能体速读】**
>
> * **这篇讲什么**：固件服务器（`175.178.156.231`）要为 `fetch` 命令通道做的三件事：① 命令通道放行并透传新命令类型；② 服务端参数校验（纵深防御）；③ 一个静态文件托管位（fetch 的 URL 源）。末尾附验收 curl 清单。
> * **什么时候读**：服务器端实现本通道时——**全文必读**。接口契约（命令 JSON / 信封 / 回执 / 状态机）以 [`README.md`](README.md) §3 为**唯一权威定义**；本文只写服务器侧职责与验收。
> * **阅读模式**：`全文必读`（约 190 行）。动手前**先做 §0 探测**，结论决定 §3 的工作量。
> * **关键小节**：§0 探测；§3 通道改造点；§6 验收清单。
> * **最容易踩的点**：① **不要改回执端点和状态机**——result 与 pending/delivered/success/failed 流转全部沿用现状；② **服务器端校验不是可选项**（设备能写自己两个文件系统，服务端必须同规则把关）；③ **离线 412 / 冲突 409 语义不能动**，宿主机 CLI 靠它们做交互。

***

## 0. 先做一次探测（动手前必做）

向一台在线设备发一条 fetch 命令，观察服务器现状属于哪种：

```bash
curl -k -X POST https://175.178.156.231/api/devices/b8:1f:3f:c8:76:8c/commands \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"type":"fetch","url":"http://175.178.156.231/files/probe.json","dest":"/fs/probe.json"}'
```

| 探测结果 | 结论 | 工作量 |
|---|---|---|
| A. 201/200，命令被持久化，且 report 响应里**原样透传**全部字段 | 服务器对 type 不做白名单，只做存取转发 | 只需补**服务端校验**（§3.3）+ 静态托管（§5） |
| B. 命令被持久化，但 report 响应里**字段被剥掉/改名**（只回已知的 ota 字段） | 信封是按 type 硬编码构造的 | 需给 fetch 加信封构造分支（§3.2） |
| C. 400/422 拒绝未知 type | 有类型白名单 | 在白名单加 `fetch` + 校验 + 信封（§3 全量） |

探测后**把结论写进本文 §0**，再开工。

> ✅ **探测结论（2026-10-16 08:35，设备 b81f3fc8768c 在线时实测）**：**分支 C**。
> `POST /api/devices/b81f3fc8768c/commands` 携带 `{"type":"fetch",...}` → **400** `{"error":"unsupported command type"}`。
> 即：服务器存在**命令类型白名单**，fetch 需按 §3 **全量实现**（受理 + 校验 + 信封 + 托管）。设备端已并行开发中，接口以 [`README.md`](README.md) §3 为准。

## 1. 服务器现状回顾（已有，不要重造）

以下端点与语义已存在并经 OTA 长期验证（契约详见本项目 `docs/ota.md` §4）：

| 端点 | 说明 |
|---|---|
| `POST /api/devices/{deviceId}/report` | 设备 15 s 一报；响应携带该设备的一条未决命令（`command: {...}` 或 `null`），返回时可置 `state=delivered` |
| `POST /api/devices/{deviceId}/commands` | 下发命令；设备离线 → **412 且不入队**；已有未决命令 → **409** |
| `POST /api/devices/{deviceId}/commands/{commandId}/result` | 设备回执 `{state: "success"|"failed", detail}` |
| `GET /api/devices/{deviceId}/commands/{commandId}` | 查命令状态（宿主机轮询回执用） |
| `GET /api/devices` | 设备列表（含 `lastCommand`） |

命令生命周期：`pending → delivered → success/failed`（另有 `cancelled` / `superseded`）。**fetch 完整复用这套，不新增状态。**

## 2. 你要做的三件事

1. **命令通道接受 `fetch`**：存取、投递、回执、重投逻辑不变，只是 type 集合多一个成员。
2. **服务端参数校验**（与设备端同规则，纵深防御）。
3. **静态文件托管**：给 fetch 的 `url` 一个可用的 HTTP 源（§5；长期方案见云盘文档 [`03-cloud-drive.md`](03-cloud-drive.md)）。

## 3. 命令通道改造点

### 3.1 受理（`POST /commands`）

* 接受 `type: "fetch"`，载荷字段：`url`（必填）、`dest`（必填）、`maxBytes`（可选）。
* 校验规则（**拒绝 → 400 + 错误说明**）：

| 字段 | 规则 |
|---|---|
| `url` | 以 `http://` 开头的完整绝对 URL；长度 ≤ 256 |
| `dest` | 以 `/fs/` 或 `/sdcard/` 开头；仅 ASCII 可打印字符；不含 `..`；总长 ≤ 127 |
| `maxBytes` | 整数 ∈ 1..4194304；缺省 262144；越界**取边界**（与设备端钳位行为一致） |

### 3.2 投递（report 响应信封）

设备只认信封里这六个字段（字段名精确一致，见 [`README.md`](README.md) §3.2）：

```json
{ "id": "cmd_a1b2c3", "type": "fetch", "url": "...", "dest": "...", "maxBytes": 262144, "createdAt": "..." }
```

* 若现有实现按 type 硬编码构造信封（探测结果 B/C），给 fetch 加对应分支；**多余字段设备会忽略**，但上述六个一个不能少。
* `maxBytes` 缺省值在**存储时**就补成 262144，保证信封里总有数值。

### 3.3 重投

* 未收到回执的命令重投——**现有机制不变**。fetch 幂等（设备重复覆盖同一文件），无需去重或限次；若想保守，可给 fetch 重投设上限（如 5 次后标 `failed: not acked`），非必需。

### 3.4 回执与状态

* `POST .../result`、`GET .../commands/{id}`、`GET /api/devices` 的 `lastCommand` 展示——**全部不动**。`detail` 是设备给的 ASCII 字符串，原样存储展示即可。
* 失败不重试：设备不会自动重跑；宿主机重发即可，服务器无需"失败重排"逻辑。

## 4. 安全与边界（服务端必须做的把关）

1. `dest` 白名单与设备端完全一致——**不要**因为"设备也会校验"就跳过服务端校验。
2. `url` 限定 `http://`：设备端只支持明文 HTTP，让 https 的命令在服务端就失败，错误信息更友好。
3. 命令大小限制：请求体整体 ≤ 2 KB，防滥用。
4. 鉴权：沿用现有 commands 端点的 token 机制，不因新 type 放宽。

## 5. 静态文件托管（fetch 的 URL 源）

* **v1（本期）**：服务器上开一个目录做静态托管，例如 `GET /files/<path>` ← 服务器磁盘 `data/files/`。上传方式 v1 由运维直接放文件（SCP 等），不强制做上传 API。
  * 该目录**只读**对外；路径即 URL 路径；Content-Type 按扩展名给（`.json` → `application/json`）。
* **v2**：上传/管理走云盘项目（[`03-cloud-drive.md`](03-cloud-drive.md)），`/files/` 退居兼容或由 `/api/drive/...` 取代。
* 本项目 vanim 预置（`robot.json` / `blob.json`）将是第一批托管文件，期望 URL：
  * `http://175.178.156.231/files/vanim/robot.json`
  * `http://175.178.156.231/files/vanim/blob.json`

> 设备端 `page_vanim.hpp` 里 `kFetchUrl = "http://175.178.156.231/vanim/demo.json"` 是早期占位——如果 `/vanim/` 这个根路径没有静态映射，属正常；以本节约定的 `/files/` 为准。

## 6. 验收清单（curl 逐条过）

前置：一台在线设备（`node scripts/list-devices/list-devices.js` 确认，45 s 窗口）+ 托管位上放一个测试文件 `probe.json`。

| # | 操作 | 期望 |
|---|---|---|
| 1 | POST 合法 fetch（dest=`/fs/probe.json`） | 201/200，`state=pending`；≤15 s 后 `delivered`；随后 `success`，detail 形如 `wrote N bytes to /fs/probe.json` |
| 2 | GET 命令状态 | 六字段信封完整；`state` 流转正确 |
| 3 | dest=`/nvs/x` | 400（服务端校验拒绝）；若放过去了，设备回 `failed: bad dest`（纵深防御生效，但服务端这条算 bug） |
| 4 | url=`https://...` | 400 |
| 5 | maxBytes=99999999 | 存储时钳位到 4194304 |
| 6 | 设备离线时下发 | **412**，命令不入队（现有语义不变） |
| 7 | 已有未决命令再发 | **409** |
| 8 | 回执后 `GET /api/devices` | `lastCommand` 显示 fetch + success |
| 9 | 服务器重启后 | 未回执命令仍按现有持久化语义处理（不因新 type 丢失） |

## 7. 与宿主机 CLI 的对接（知会，无需你实现）

本项目宿主机会给 `tools/publish` 加 `fetch` 子命令（设备端仓库内实现）：

```
node tools/publish/index.js fetch --to <mac> --url <url> --dest /fs/... [--max-bytes N] [--wait]
```

依赖的端点就是现有四个（下发 / 查命令 / 412 / 409），**不需要服务器提供任何新端点**；`--wait` 轮询 `GET .../commands/{id}` 到 `success/failed`。

## 8. 开放问题（实现时按默认值走，有异议再回包反馈）

| # | 事项 | 默认 |
|---|---|---|
| 1 | fetch 命令是否记入配额/限频 | 暂不限 |
| 2 | `detail` 非法字符 | 原样存储（设备保证 ASCII） |
| 3 | 静态托管目录的磁盘配额 | 跟随云盘项目（03）统一定，v1 不设 |
| 4 | 命令持久化的存储位置 | 沿用现状 |

## 9. 实现状态（2026-10-16 已落地）

按 §2 三件事全部完成并上线：

| 项 | 状态 | 落点 |
|---|---|---|
| 命令通道接受 `fetch` | ✅ | `server/app.js` `POST /commands` type 分支；`server/devices.js` `buildFetchCommand()` 校验+钳位 |
| 服务端参数校验 | ✅ | 同 `buildFetchCommand`：`url` 仅 `http://` ≤256、`dest` 白名单 `/fs/`/`/sdcard/` + ASCII 可打印 + 无 `..` ≤127、`maxBytes` 缺省 262144 / 越界取边界 1..4194304；校验不过 400 |
| 静态文件托管 | ✅ | `server/app.js` `serveHostedFile()` + `GET /files/<path>` ← `dataDir/files/`（只读、防穿越、Content-Type 按扩展名） |

- 信封六字段、离线 412、冲突 409、未决位、回执、撤销**全部沿用 ota 语义**（fetch 与 ota 共用"每设备一条未决"）。
- 验收：`tests/fetch.test.js` 19 用例 + 全量 375 全绿；线上部署后外网核验见 PROGRESS 变更日志。
- **`/files/` 目录尚未放文件**（v1 由运维 SCP 放，首个用例 vanim 预置 JSON 待放）；云盘（`03-cloud-drive.md`）另立项目，本次未做。
