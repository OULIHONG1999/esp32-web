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
> * **页面已落地**：前端控制台在 **`/OTA`**（独立页 `public/ota/`，复用 firmware-server，不参与主 SPA 构建），数据全部来自实时接口；机器描述符 `/ota.json`。见 §6。
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

> ⚠️ **设备工程在另一台电脑上维护，且本仓库不假设其现状**。下面只列"要做什么/坑在哪"；
> **可直接照做的完整实现指引（含 ESP-IDF 代码骨架、分区表 CSV、联调步骤、验收清单）在
> [`docs/DEVICE-OTA.md`](./DEVICE-OTA.md)** —— 设备端开工先读那一份，本文只作契约来源。

* 建议新增 `components/ota/`（只依赖 `esp_http_client` / `cJSON` / `esp_https_ota` / `mbedtls`，不与 UI 代码耦合）：负责上报、取命令、下载、写 OTA、回执。

* 联网：需要 `esp_netif_init` + event loop + `esp_wifi` STA。**若工程尚无网络层，这层要自己加**（凭据先放 Kconfig，后续可移 NVS 配网）。

* 下载固件走 `esp_https_ota`（直接给 URL 最省事）；⚠️ **走明文 http 必须开 `CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP=y`**，否则直接被拒；要自己校验再落盘就用 `esp_http_client` + `esp_ota_write`。

* 版本号 `firmwareVersion` 取自 `esp_app_get_description()->version`（即 `PROJECT_VER`；注意 `CONFIG_APP_PROJECT_VER_FROM_CONFIG` 若开启则改由 Kconfig 指定）。

* ⚠️ **`app_elf_sha256` 不等于固件 `.bin` 的 sha256**（前者是 ELF 摘要），**不能**拿去和 registry 里的段 sha256 比对。自我识别用 `firmwareVersion`，下载校验用命令里的 `sha256`。详见 DEVICE-OTA §7.3。

* 分区表：**多数 demo 工程默认单 `factory` 槽，必须改成 `otadata(0x2000) + ota_0 + ota_1`**（两槽等大、`otadata` 在 app 之前）。⚠️ **触发 R10**——需整片重烧，nvs/storage 数据失效，发布/烧录两侧段表同步更新。具体 CSV 见 DEVICE-OTA §8。

* 证书：服务器现为自签 HTTPS。三选一——dev 走明文 80（最省事）/ 内置根证书 PEM / 临时关校验（仅 debug）。生产建议服务器上正式证书。

* 回滚：开 `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`（**默认不开**），首次自检通过后调 `esp_ota_mark_app_valid_cancel_rollback()`。

* OTA 前提是已联网；设备端应把"待回执结果"落 NVS，重启联网后补发（避免升级成功但回执丢失）。

## 6. 页面端（前端）修改要点（先测）

页面端**不依赖设备端完成**即可先行开发，接口契约见 §4。

### 6.0 已实现：独立页 `/OTA`

| 项 | 值 |
| --- | --- |
| 访问地址 | `/OTA`（大小写等价 `/ota`、`/ota/`；由 firmware-server `serveStatic` 归一） |
| 源码 | `public/ota/index.html` + `ota.css` + `ota.js`（零依赖原生 JS，**不进主 SPA 构建**，属独立页） |
| 机器描述符 | `/ota.json`（tool_id=`ota-console`，含接口清单 / 数据模型 / 鉴权说明） |
| 契约文档 | `/docs/ota.md`（本文件，公网可读） |
| 数据源 | **只有实时接口**（页面内无假数据）：每 5s 拉 `GET /api/devices` + `GET /api/registry`；取数失败时胶囊显示「连接失败」并给出原因 |
| 鉴权 | 下发是写操作：页面有 **Token 输入框**（存 `localStorage.fw.token`，与主站共用同一键、不上传），请求带 `Authorization: Bearer`；无 token 时前置拦截并提示。**免记口令**：设置链接 `https://<host>/OTA#token=<token>` 打开即写入本机并抹掉地址栏（片段不上行 → 不进日志/Referer），页面可「🔗 复制设置链接」存书签，换浏览器/换电脑打开书签即完成配置；旧的 `?settoken=` 仍兼容但会进日志，不用。**report / 回执免鉴权**，设备侧无需 token |
| 失败提示 | 按状态码给「下一步做什么」：401→填 token、409→勾「顶替未决命令(force)」重试、404→release 不存在、其他→透传服务端文案 |
| 已覆盖 | 概览计数（在线/离线/待执行/成功/失败）· 设备卡（MAC/芯片/固件/IP/心跳/最近命令）· 设备与 release 下拉 · 下发（含 force 顶替）· 命令状态流转 · 5s 轮询 · AI 速读区 · 页内结构化摘要 `#ai-data` |
| 未实现 | **无**——§4 四个端点均已实现并实测（见 §6.2）；设备端固件由另一台电脑开发，入口见 `docs/DEVICE-OTA.md` |

**页面不再需要 mock 兜底**：服务器四端点已实现（§6.2），页面数据全部来自实时接口；
设备端联调用 `tools/device-sim/` 模拟器喂数据（见 `docs/DEVICE-OTA.md` §9），不必往页面里塞假数据。

### 6.2 服务器端已实现（2026-10-06）

| 项 | 值 |
| --- | --- |
| 存储 | `server-data/devices.json`（设备 + 每设备命令队列，保留最近 20 条）；`server/devices.js` 纯函数 + 原子写 |
| 端点 | `report` / `GET /api/devices` / `commands` / `result` 四个（§4.1–§4.4 全部） |
| 鉴权 | `report` 与 `result` **免鉴权**（MAC 即身份）；`commands` 需 Bearer（主 token 或工作 token） |
| 离线判定 | 服务端按 `lastSeen` 算，阈值 **45s**（`ONLINE_TIMEOUT_MS`） |
| app 段解析 | 下发时在 registry 里按 `releaseId` 定位 release，取 `type==='app'` 的段（退化到最大的 `.bin`），把 `file/url/sha256/size` 填进命令 |
| 未决命令 | 每设备至多一条；冲突返回 **409** + 现有命令；`{"force":true}` 可顶替（旧命令标 `superseded`）——§7#3 定为「报冲突 + 可选顶替」 |
| 重复投递 | 命取走后未回执 → 下次上报**再投递同一条**（响应带 `redelivered:true`，命令内 `deliveryCount` 累加），避免设备取走即崩溃造成永久卡死；设备端需幂等 |
| 测试 | `tests/devices.test.js` 30 用例（存储纯函数 + 四端点链路 + 409/force/重投递/篡改失败） |

### 6.1 模块规划（原设计表，已全部实现）

| 模块    | 功能                                     | 依赖的 API                                                    |
| ----- | -------------------------------------- | ---------------------------------------------------------- |
| 设备列表页 | 展示在线/离线设备、固件版本、IP、lastSeen、最近命令状态；自动刷新 | `GET /api/devices`                                         |
| 下发面板  | 选中设备 → 从版本下拉选 release（或最新）→ 下发         | `GET /api/registry`（版本）+ `POST /api/devices/{id}/commands` |
| 状态反馈  | 命令下发后展示 pending→success/failed 流转      | `GET /api/devices` 轮询刷新                                    |

## 7. 关键决策点（含已定）

| # | 事项     | 结论 / 现状                | 备注                        |
| - | ------ | ---------------------- | ------------------------- |
| 1 | 分区槽位   | ✅ **双槽 `ota_0 + ota_1`** | 原担心的"storage 缩到 ~7M"不成立——16MB 盘切 4M+4M 后 storage 仍可留 7M+（详见 DEVICE-OTA §8.2） |
| 2 | 证书     | ✅ **dev 走明文 80；生产上正式证书** | 自签下设备端要么内置根证书、要么临时关校验；dev 用明文最省事 |
| 3 | 未决命令并发 | ✅ **报冲突 409 + 可选 `force` 顶替** | 不静默覆盖；顶替时旧命令标 `superseded` |
| 4 | 触发方式   | ⏸ 现为**页面手动下发** | 「设备开机自动检查最新版」未做，留作扩展 |
| 5 | 服务器端归属 | ✅ **已实现于 firmware-server** | `server/devices.js` + `server/app.js`；`tests/devices.test.js` 30 用例 |
| 6 | 设备上报鉴权 | ✅ **report/回执免鉴权，仅下发需 token** | MAC 即身份；防伪造不在本期范围 |

> 本文是**设计契约**。进度：页面端 ✅（`/OTA`）→ 服务器端 ✅（§4 四端点 + §6.2）→ **设备端待开发**。
> 设备端开工请以 **[`docs/DEVICE-OTA.md`](./DEVICE-OTA.md)** 为准（含代码骨架、分区表、联调步骤、验收清单）；
> 本文负责"为什么这么定"，那份负责"具体怎么做"。

