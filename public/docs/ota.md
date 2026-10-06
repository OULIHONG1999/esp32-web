# OTA 云端方案设计（设备上报 + 命令下发 + 页面端）

> **【智能体速读】**
>
> * **定位**：OTA 云端方案的**接口契约 + 三端协同设计**（设备 / 云端 / 页面）。服务于三件事：设备上报在线状态与信息、页面端看到设备并下发 OTA 命令、设备收到命令后自升级。
>
> * **阅读模式**：`按需查 §4`（页面端 / 服务器端开发）、`按需查 §5`（设备端实现）、其余按需。
>
> * **规模**：约 300 行。
>
> * **何时读全文**：动手实现 OTA 设备端或对接口契约时。
>
> * **页面已落地**：前端控制台在 **`/OTA`**（独立页 `public/ota/`，复用 firmware-server，不参与主 SPA 构建），可先用内置 mock 数据开发；机器描述符 `/ota.json`。见 §6。
>
> * **最易踩点**：设备身份用 MAC；命令采用 **HTTP 轮询（pull）**，不是推送；改分区表触发工程规则 **R10**；服务器为自签 HTTPS，设备端要处理证书。

***

## 1. 目标与范围

| 目标    | 说明                                                     |
| ----- | ------------------------------------------------------ |
| 设备可见  | 云端页面能看到**当前在线**及**曾经在线过**的设备，含设备信息（固件版本 / IP / 上下线时间等） |
| 设备上报  | 设备周期性上报自身信息，兼作心跳（服务器据此判在线/离线）                          |
| 命令下发  | 页面指定**某一台设备** + 指定**某个固件版本（release）**，下发 OTA 命令        |
| 设备自升级 | 设备轮询到命令后，拉取命令指定的固件文件，完成 OTA 并重启，回执结果                   |

**明确不做（本阶段）**：多设备批量下发、自动推版本、MQTT/实时长连接。

## 2. 总体架构

```
┌──────────────┐   轮询上报/拉命令    ┌────────────────────┐
│   ESP32 设备  │ ◄──────────────────► │  firmware-server     │
│  components/ota│   HTTP (WiFi)      │  175.178.156.231    │
└──────────────┘                     │  + registry(已有)    │
        ▲                            │  + devices(新增)     │
        │ 下载固件                     │  + commands(新增)    │
        └──────────────────────────► └──────────┬─────────┘
                                                │ REST API
                                      ┌─────────▼─────────┐
                                      │   云端页面（前端）   │
                                      │  设备列表 + 下命令   │
                                      └───────────────────┘
```

* **通信模型**：HTTP 轮询（用户已确认）。设备周期打一个 `report` 请求，响应里顺带返回"待执行命令"（有则返回，无则空）。简单、天然支持设备离线时命令暂存。

* **设备身份**：`device_id` = ESP32 的 base MAC，去掉冒号的小写十六进制（如 `3485a1b2c3d4`），稳定唯一、免配置。页面展示时可按 `34:85:a1:b2:c3:d4` 格式化。

* **版本依据**：沿用发布闸门判据 —— **app 段 sha256**（服务器 registry 里已有），下载端点直接复用 `parts/{file}`。

## 3. 数据流与时序

1. 设备上电 → 初始化 WiFi → 首个 `report` 上报（注册）。
2. 设备每隔 `REPORT_INTERVAL_MS`（默认 15 s）再 `report`（兼心跳）。
3. 服务器每次 `report` 更新 `last_seen`；`now - last_seen > ONLINE_TIMEOUT_MS`（默认 45 s）判定离线。
4. 用户在页面选择某设备 + 某 release → `POST .../commands` 下发命令，服务器存队列（`state=pending`）。
5. 设备下一次 `report` 的响应里拿到该命令 → 按命令里的 URL 下载固件 → `esp_https_ota` 写入空闲槽位 → 重启。
6. 设备重启后再次上报，并 `POST .../commands/{id}/result` 回执 `success/failed`。
7. 页面轮询 `GET /api/devices` 刷新设备状态与命令结果。

> 可调参数：`REPORT_INTERVAL_MS`、`ONLINE_TIMEOUT_MS` 均为设备端/服务器端可配常量，开发期可放宽以方便观察。

## 4. 云端 API 契约（新增）

> 命名沿用现有服务器的 camelCase 风格（对齐 registry 里的 `createdAt` / `chipFamily` / `sha256`）。
> 下面 `{pid}`=`lvgl-demo-v9`，`{vid}`=`ESP32-S3`，`{deviceId}`=去冒号小写 MAC，`{commandId}`=命令 ID。

### 4.0 复用现有端点（无需新增）

| 端点                                                                            | 用途                     |
| ----------------------------------------------------------------------------- | ---------------------- |
| `GET /api/registry`                                                           | 版本列表（页面下拉选择 release 用） |
| `GET /api/registry/projects/{pid}/variants/{vid}/releases/{rid}/parts/{file}` | 设备下载固件文件用              |

### 4.1 设备上报（含拉取命令）

`POST /api/devices/{deviceId}/report`

请求：

```json
{
  "chip": "ESP32-S3",
  "firmwareVersion": "v0.6.0-3-g64de242",
  "appSha256": "27877362ce8b9524b4e1650cb9b46b80bbd29cec535748ce88580600b9214e2d",
  "sdkVersion": "v6.0.1",
  "ip": "192.168.31.100",
  "uptimeMs": 3600000,
  "freeHeap": 230000,
  "psramFree": 4000000
}
```

响应（无命令时 `command` 为 `null`）：

```json
{
  "now": "2026-10-06T10:00:00Z",
  "command": null
}
```

响应（有待执行命令时返回完整命令体）：

```json
{
  "now": "2026-10-06T10:00:00Z",
  "command": {
    "id": "cmd_2f3c9a",
    "type": "ota",
    "releaseId": "20261005-1609-278773",
    "file": "lvgl_demo_v9.bin",
    "url": "/api/registry/projects/lvgl-demo-v9/variants/ESP32-S3/releases/20261005-1609-278773/parts/lvgl_demo_v9.bin",
    "sha256": "27877362ce8b9524b4e1650cb9b46b80bbd29cec535748ce88580600b9214e2d",
    "size": 1624624,
    "createdAt": "2026-10-06T09:59:00Z"
  }
}
```

> 服务器在返回命令时可顺手把 `state` 置为 `delivered`（已投递，待设备回执）。

### 4.2 设备列表

`GET /api/devices`

```json
{
  "devices": [
    {
      "deviceId": "3485a1b2c3d4",
      "chip": "ESP32-S3",
      "firmwareVersion": "v0.6.0-3-g64de242",
      "appSha256": "27877362ce8b9524b4e1650cb9b46b80bbd29cec535748ce88580600b9214e2d",
      "sdkVersion": "v6.0.1",
      "ip": "192.168.31.100",
      "online": true,
      "lastSeen": "2026-10-06T10:00:00Z",
      "createdAt": "2026-10-06T08:00:00Z",
      "lastCommand": {
        "id": "cmd_2f3c9a",
        "type": "ota",
        "releaseId": "20261005-1609-278773",
        "state": "success"
      }
    }
  ]
}
```

* `online`：服务器按 `last_seen` 实时判定（页面无需自算）。

* `lastCommand`：最近一次命令 + 状态（`pending` / `delivered` / `success` / `failed`），没有历史命令则为 `null`。

### 4.3 下发 OTA 命令

`POST /api/devices/{deviceId}/commands`

请求：

```json
{ "type": "ota", "releaseId": "20261005-1609-278773" }
```

响应：

```json
{
  "command": {
    "id": "cmd_2f3c9a",
    "deviceId": "3485a1b2c3d4",
    "type": "ota",
    "releaseId": "20261005-1609-278773",
    "state": "pending",
    "createdAt": "2026-10-06T09:59:00Z"
  }
}
```

> 服务器仅存 `pending` 命令（每个设备至多一条未决命令；再次下发可用新命令覆盖或直接报冲突，二选一，见 §7）。

### 4.4 设备回执

`POST /api/devices/{deviceId}/commands/{commandId}/result`

请求：

```json
{ "state": "success", "detail": "OTA ok, rebooted to 20261005-1609-278773" }
```

失败示例：

```json
{ "state": "failed", "detail": "download timeout" }
```

响应：`{ "ok": true }`

## 5. 设备端实现要点

* 新增 `components/ota/`（纯逻辑 + 网络，不引用 LVGL，参照 `components/net` 的分层）：负责上报、轮询、下载、OTA、回执。

* 网络复用 `components/net` 的 WiFi + `http_get`（PSRAM 流式）；下载固件建议走 `esp_https_ota`（前面加一个 Range/流式下载或直接给它 URL）。

* 版本号 `firmwareVersion` 取自 `esp_app_get_description()->version`（即 `PROJECT_VER`，git describe）。

* `appSha256` 来自 `esp_app_get_description()->app_elf_sha256` 或启动时自算 app 段（与发布闸门口径一致）。

* 分区表改造：`factory 4M` → `otadata(0x2000) + ota_0 2M + ota_1 2M`，`storage` 相应缩小。⚠️ **触发 R10**，需重烧分区表，storage 数据失效，发布/烧录两侧段表同步更新。

* 证书：服务器自签 HTTPS，设备端需内置根证书 PEM 或先跳校验（dev 阶段）。

* 回滚：首次成功启动后调 `esp_ota_mark_app_valid_cancel_rollback()`。

* WiFi 凭据已在 NVS 持久化（`components/net`），OTA 前提是已联网。

## 6. 页面端（前端）修改要点（先测）

页面端**不依赖设备端完成**即可先行开发，接口契约见 §4。

### 6.0 已实现：独立页 `/OTA`

| 项 | 值 |
| --- | --- |
| 访问地址 | `/OTA`（大小写等价 `/ota`、`/ota/`；由 firmware-server `serveStatic` 归一） |
| 源码 | `public/ota/index.html` + `ota.css` + `ota.js`（零依赖原生 JS，**不进主 SPA 构建**，属独立页） |
| 机器描述符 | `/ota.json`（tool_id=`ota-console`，含接口清单 / 数据模型 / mock-real 说明） |
| 契约文档 | `/docs/ota.md`（本文件，公网可读） |
| 数据源 | 顶栏开关 **mock / real**：mock 用内置假设备（默认，无需后端）；real 打真实 `/api/devices` + `/api/registry`，选择持久化于 `localStorage.ota.mode` |
| 已覆盖 | 概览计数（在线/离线/待执行/成功/失败）· 设备卡（MAC/芯片/固件/IP/心跳/最近命令）· 设备与 release 下拉 · 下发 · 命令状态流转 · 5s 轮询 · AI 速读区 · 页内结构化摘要 `#ai-data` |
| 未实现 | 服务器端 `/api/devices*`（§4.1/§4.3/§4.4）——real 模式会明确提示而非静默失败 |

**服务器端接入前**：页面在 mock 下即可完成 UI 与交互验收；接入后把 `/api/devices` 与 `/api/devices/{id}/commands` 实现出来（§4），real 模式即通。

### 6.1 模块规划（原设计表）

| 模块    | 功能                                     | 依赖的 API                                                    |
| ----- | -------------------------------------- | ---------------------------------------------------------- |
| 设备列表页 | 展示在线/离线设备、固件版本、IP、lastSeen、最近命令状态；自动刷新 | `GET /api/devices`                                         |
| 下发面板  | 选中设备 → 从版本下拉选 release（或最新）→ 下发         | `GET /api/registry`（版本）+ `POST /api/devices/{id}/commands` |
| 状态反馈  | 命令下发后展示 pending→success/failed 流转      | `GET /api/devices` 轮询刷新                                    |

**测试建议（服务器就绪前用 mock）**：

1. 用 `GET /api/devices` 的响应样例（§4.2）造 2\~3 个假设备（1 在线 + 1 离线 + 1 无历史命令），撑起设备列表 UI 与在线/离线样式。
2. 造 `POST /api/devices/{id}/commands` → 成功 / 设备不存在 / 已存在未决命令 三种返回，验证交互与提示。
3. mock 一个 `GET /api/devices` 轮询，让某设备的 `lastCommand.state` 从 `pending` 迁到 `success`，验证状态刷新。
4. 后端联调时，用真实设备 `report` 喂数据，确认在线判定阈值（45 s）与页面刷新节奏匹配。

## 7. 关键决策点 / 待确认

| # | 事项     | 现状 / 建议                | 待定                        |
| - | ------ | ---------------------- | ------------------------- |
| 1 | 分区槽位   | 双槽 `ota_0+ota_1`（标准回滚） | 是否接受 `storage` 相应缩到 \~7 M |
| 2 | 证书     | 自签 HTTPS               | 内置根证书 还是 dev 期先跳校验        |
| 3 | 未决命令并发 | 每设备至多一条 `pending`      | 再次下发时「覆盖」还是「报冲突」          |
| 4 | 触发方式   | 页面手动下发                 | 后续是否加「设备开机自动检查最新版」        |
| 5 | 服务器端归属 | 扩展现有 firmware-server   | 确认服务器代码位置 / 由谁实现 §4 端点    |

> 本文是**设计契约**。进度：**页面端已落地**（`/OTA`，§6.0，mock 可跑）→ 下一步确认 §7 决策 → 服务器端实现 §4 的 `/api/devices*` 端点（real 模式即通）→ 最后设备端 `components/ota` 落地联调。

