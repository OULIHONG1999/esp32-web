# 设备接入指南 —— 单片机侧如何接入 OTA 服务器

> **【智能体速读】**
>
> * **定位**：给**在另一台电脑上开发单片机固件**的工程师/AI 的**唯一入口文档**。目标：让 ESP32 设备接入本 OTA 服务器，完成「上报自身信息 → 接收命令 → 自升级 → 回执」。
>
> * **服务器已就绪**：`/api/devices*` 四个端点**已实现并实测**（不是设计稿）。设备端可直接联调。
>
> * **阅读模式**：`按需查 §4`（接口契约，逐条可复制的 curl）、`动手写代码看 §7`（ESP-IDF 参考实现）、`卡住了看 §10`。第一次接触建议按 §1 → §2 → §4 → §9 顺序。
>
> * **规模**：约 500 行。
>
> * **何时读全文**：第一次接入，或需要改分区表/证书策略时。
>
> * **最易踩点**（按踩坑概率排序）：
>   1. **`app_elf_sha256` ≠ 固件文件的 sha256**——前者是 ELF 的摘要，服务器用的是 `.bin` 的摘要，两者不可互换比对（§7.3）。
>   2. **分区表通常得改**：显示类 demo 工程默认多为单 `factory` 槽，OTA 需要 `otadata + ota_0 + ota_1`，不改写不进去（§8，触发工程规则 R10）。
>   3. **走明文 http 下载必须开 `CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP=y`**，否则 `esp_https_ota` 直接拒绝（§7.4）。
>   4. ESP-IDF 默认 **没开** `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`，不开就没有升级失败自动回滚（§7.7）。
>   5. 设备身份用 **MAC**；命令靠 **HTTP 轮询（pull）**，不是推送。
>
> * **本文不假设你的工程长什么样**：所有需要"看你工程现状"的地方，都给了自查命令与判据（§5、§8），不由本文替你断言。
>
> * **不在本次范围**：批量下发、自动推版本、MQTT/长连接、云端主动探测设备。
> * **推送固件到指定设备（CLI）**：见 [`PUSH-TO-DEVICE.md`](./PUSH-TO-DEVICE.md)——设备开发机上一条命令完成"发布 + 下发 + 等结果 + 打印过程"。**设备端无需为它做任何改动**。

***

## 1. 你的任务边界

你在**另一台电脑**上做设备端固件。服务器（HTTP 端点 + 数据库 + 页面）**已经跑起来**，你不需要碰它。

你要交付的是：设备上电联网后，能自己完成下面这条闭环。

```
上电 → 连 WiFi → 周期性上报（兼心跳）→ 响应里拿到命令 → 下载固件 → 校验 → 写 OTA 槽 → 重启 → 上报新版本 + 回执
```

服务器侧已经能做的事（你不用实现，只需对接）：

| 服务器已提供 | 说明 |
| --- | --- |
| 接收设备上报 | 记录芯片/固件版本/IP/心跳时间，并**顺手把待执行命令返回给你** |
| 判定在线/离线 | 按 `lastSeen` 自动判定（45s 无上报即离线），设备不用管 |
| 暂存命令 | 设备离线时下发的命令会排队，等设备下次上报时投递 |
| 提供固件下载 | 直接给你一个 URL，指向该命令指定的 app 分段 |
| 提供可视化页面 | `服务器地址/OTA`：人在这里看设备列表、点按钮下发命令 |

## 2. 服务器能力现状（对接前必读）

> 真实服务器地址**不入公开文档**（本仓库纪律：地址与 token 只存服务器与本机）。向运维者索取，或在服务器 `/etc/firmware-server.env` 附近确认。
> 下文一律用占位符 `<SERVER>`，例如 `http://firmware.example.com`。

| 项 | 现状 |
| --- | --- |
| `POST /api/devices/{deviceId}/report` | ✅ 已实现 · **免鉴权** |
| `GET /api/devices` | ✅ 已实现 · 公开只读（给你调试用） |
| `POST /api/devices/{deviceId}/commands` | ✅ 已实现 · **需 Bearer token**（页面侧调用，设备不调用） |
| `POST /api/devices/{deviceId}/commands/{commandId}/result` | ✅ 已实现 · **免鉴权** |
| `GET /api/registry` 与固件分段下载 | ✅ 已实现 · 公开只读 |
| 设备端固件（`components/ota` 之类） | ❌ **不存在，就是你要做的** |
| 鉴权策略 | report / 回执免鉴权（**MAC 即身份**）；只有下发命令要 token |

**两个服务器地址通道**（同一台机器）：

| 通道 | 用途 | 注意 |
| --- | --- | --- |
| `http://<SERVER>`（80，明文） | **设备端 dev 期首选**：免证书，最省事 | 明文；若 nginx 对 80 只放行 GET，需请运维者放开 `POST /api/devices/**` |
| `https://<SERVER>`（443，**自签**证书） | 浏览器页面入口 | 设备端要校验就得内置根证书，否则得关校验（见 §7.6） |

## 3. 你在系统里的位置

```
┌──────────────┐   ① report（上报+取命令，免鉴权）   ┌─────────────────────┐
│  ESP32 设备   │ ───────────────────────────────► │   OTA 服务器         │
│  （你在写）    │ ◄─────────────────────────────── │   /api/devices*     │
│              │      响应里带 command（可能是 null） │                     │
│              │                                    │   + /api/registry   │
│              │   ② 下载 app 固件（公开只读）         │     （已有）         │
│              │ ───────────────────────────────► │                     │
│              │                                    │                     │
│              │   ③ result 回执（免鉴权）            │                     │
│              │ ───────────────────────────────► │                     │
└──────────────┘                                    └──────────┬──────────┘
                                                               │ 人在页面点按钮
                                                    ┌──────────▼──────────┐
                                                    │  页面  服务器地址/OTA │
                                                    └─────────────────────┘
```

你可以**先不看服务器代码**：本文 §4 就是完整契约。需要源码时，服务器仓库的 `server/devices.js` 与 `server/app.js` 是权威实现。

## 4. 接口契约（权威）

统一约定：

* **`deviceId`** = ESP32 的 base MAC，**去掉冒号的小写十六进制，正好 12 位**（如 `3485a1b2c3d4`）。大写、带冒号、长度不对都会被 **400** 拒掉。
* **时间**一律 ISO8601 UTC（如 `2026-10-06T10:00:00Z`），由服务器生成，设备不用自己造时间。
* **请求体**必须是一个 **JSON 对象**（不能是数组），单次上报上限 8KB。
* **未知字段会被忽略**（服务器按白名单取字段），所以多加调试字段不会报错。

### 4.1 上报（兼心跳 + 取命令）

```
POST /api/devices/{deviceId}/report        免鉴权
Content-Type: application/json
```

请求体（除 `chip` 外都可选，但**建议都报**）：

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

> `ip` 不填也行——服务器会从 socket（或 nginx 的 `X-Forwarded-For`）回填。设备自己报更准（NAT 场景除外，那正好用回填的）。

**响应（没有命令时）**：

```json
{ "now": "2026-10-06T10:00:00Z", "command": null }
```

**响应（有命令时）**：

```json
{
  "now": "2026-10-06T10:00:00Z",
  "command": {
    "id": "cmd_2f3c9a",
    "type": "ota",
    "releaseId": "20261005-1609-278773",
    "file": "lvgl_demo_v9.bin",
    "url": "/api/registry/projects/lvgl-demo-v9/variants/ESP32-S3/releases/20261005-1609-278773/parts/lvgl_demo_v9.bin",
    "urlAbsolute": "http://firmware.example.com/api/registry/projects/.../lvgl_demo_v9.bin",
    "sha256": "27877362ce8b9524b4e1650cb9b46b80bbd29cec535748ce88580600b9214e2d",
    "size": 1624624,
    "createdAt": "2026-10-06T09:59:00Z"
  }
}
```

**用哪个 URL**：`urlAbsolute` 是服务器按你请求的 Host 拼好的**绝对地址，直接 GET 即可**（推荐，省去设备拼 URL 出错）。`url` 是相对路径，供设备自己拼 base。

关键行为：

| 行为 | 说明 |
| --- | --- |
| **投递即标记** | 命令一旦出现在响应里，服务器立刻把它标为 `delivered`（已投递待回执） |
| **重复投递** | 若你取走命令后**没回执**就重启了，下次上报会**再给你同一条**（响应里多一个 `"redelivered": true`，命令里的 `deliveryCount` 会累加）。所以**设备端必须幂等**：发现当前已在跑这个 `releaseId`，直接回执 success 即可 |
| 上报频率 | 服务器按 45s 判离线。建议 **15s** 一次（默认值），别超过 30s |

### 4.2 设备列表（给你调试用，设备不调用）

```
GET /api/devices          公开只读
```

```json
{
  "_meta": { "service": "firmware-server", "docs": "/docs/DEVICE-OTA.md", "onlineTimeoutMs": 45000 },
  "devices": [
    {
      "deviceId": "3485a1b2c3d4",
      "chip": "ESP32-S3",
      "firmwareVersion": "v0.6.0-3-g64de242",
      "appSha256": "2787...4e2d",
      "sdkVersion": "v6.0.1",
      "ip": "192.168.31.100",
      "online": true,
      "lastSeen": "2026-10-06T10:00:00Z",
      "createdAt": "2026-10-06T08:00:00Z",
      "lastCommand": { "id": "cmd_2f3c9a", "type": "ota", "releaseId": "2026...", "state": "success", "deliveryCount": 1, "createdAt": "...", "finishedAt": "...", "detail": "OTA ok" }
    }
  ]
}
```

`online` 由服务器算（`now - lastSeen > 45s` → `false`），**设备不需要关心**。

### 4.3 下发命令（页面侧用，设备**不**调用）

```
POST /api/devices/{deviceId}/commands      需 Authorization: Bearer <token>
{ "type": "ota", "releaseId": "20261005-1609-278773" }
```

* `type` 目前只支持 `"ota"`。
* `releaseId` 必须真实存在（服务器去 registry 查），否则 **404**。
* 服务器会替你解析出该 release 的 **app 分段**，把 `file/url/sha256/size` 填进命令（设备拿到就是可下载的）。
* 每个设备**至多一条未决命令**：已有未回执命令时再下发 → **409**（带出现有命令）。要顶替，请求体加 `"force": true`，旧命令会被标 `superseded`。
* **设备不在线 → 412（2026-10-07 生效）**：服务器在入队那一刻判在线（`now - lastSeen > 45s` 即离线），离线则**不进队**，只留一条 `state:"cancelled"` + `cancelReason:"device_offline"` 的记录，并把这条记录放在 412 的响应体里。
  * 设备端**什么都不用做**——它仍然只在自己上报时取命令；离线期间不会积压任何命令，因此**不存在"上线后突然收到一条很久以前的刷机命令"**这种情况。
  * 你若是那个下发的操作者（页面或 CLI）：等设备上线后**重跑一次**即可（取消记录不占未决位，不会被 409 挡）。
  * 相关：推错了可以 `POST /api/devices/{deviceId}/commands/{commandId}/cancel`（Bearer）撤销未决命令；撤销 `pending` 真能拦住，撤销已取走的只能停掉重复投递。
  * 完整规则见 **[`PUSH-TO-DEVICE.md`](./PUSH-TO-DEVICE.md)**（推送到指定设备的唯一入口文档；含 CLI 与闸门）。

### 4.4 回执

```
POST /api/devices/{deviceId}/commands/{commandId}/result     免鉴权
{ "state": "success", "detail": "OTA ok, rebooted to 20261005-1609-278773" }
```

* `state` 只能是 `"success"` 或 `"failed"`（其他值 → 400；命令不存在 → 404）。
* `detail` 建议写清原因，会显示在页面和 `/api/devices` 上，是排查的主要线索。
* 回执一旦写入，该设备的"未决位"释放，可以下发下一条。

### 4.5 过程上报（进度，可选但强烈建议）

```
POST /api/devices/{deviceId}/commands/{commandId}/progress     免鉴权
{ "phase": "writing", "percent": 60, "bytes": 983040, "totalBytes": 1624624, "message": "slot ota_0" }
```

响应：`{ "ok": true, "command": { … } }`

**为什么值得做**：不报进度时，页面在设备取走命令后**只能显示"已投递"**——设备是在下载、在写入、还是已经断电，人都看不出来；
而且 OTA 期间设备主循环常被下载/写入阻塞、不再按时 `report`，页面会把它显示成**离线**。
过程上报解决这两件事，代价是每个阶段一行 HTTP。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `phase` | ✅ | 阶段名，≤32 字符。建议用这套（页面有中文标签）：`downloading` / `verifying` / `writing` / `rebooting` / `applying`；自定义阶段服务器照存，页面原样显示 |
| `percent` | | 0–100，越界会被夹住。下载/写入这类有百分比的最有用 |
| `bytes` / `totalBytes` | | 已传/总字节（可选，便于人核对） |
| `message` | | ≤128 字符的一句话，如 `slot ota_0`、`retry 2/3` |

规则：

* `phase` 缺失或超过 32 字符 → **400**；`percent` 不是数字 → **400**；命令不存在 → **404**。
* 服务器只保留**最新一条** `progress`，外加一份**阶段变化**的 `trail`（最多 20 条）——所以同一阶段反复上报不会把历史刷爆，**可以放心秒级上报**。
* **上报会刷新 `lastSeen`**（等价于一次心跳）：这正是"OTA 期间设备不该被显示成离线"的实现方式。
* 报不报都不影响命令流转：`progress` 只是给人看的旁路，**升级结果仍然只由 `result` 决定**（§4.4）。
* 阶段推进到写入前再报 `writing` 更贴近真实；重启后补发 `result` 时不必再报进度。

### 4.6 固件下载

就是命令里的 `urlAbsolute`，**公开只读、无需鉴权**：

```
GET /api/registry/projects/{projectId}/variants/{variant}/releases/{releaseId}/parts/{file}
```

返回 `application/octet-stream`。**下载完必须校验 sha256** 等于命令里的 `sha256`，不匹配就回执 `failed`（别把坏固件写进 OTA 槽）。

### 4.7 错误码对照

| 码 | 含义 | 典型原因 |
| --- | --- | --- |
| 400 | 请求不合法 | `deviceId` 非 12 位小写 hex / body 不是 JSON 对象 / `releaseId` 非法 / `state` 不是 success\|failed / `phase` 缺失或过长 / `percent` 非数字 |
| 401 | 未授权 | 下发命令没带或带错 token（**report / 回执 / 过程上报都不会遇到 401**） |
| 404 | 找不到 | releaseId 在 registry 里不存在 / commandId 不存在 / 下载路径的段名不对 |
| 409 | 冲突 | 该设备已有未回执命令（用 `force: true` 顶替） |
| **412** | 设备不在线，下发被取消 | 下发的那一刻设备离线（`now - lastSeen > 45s`）：**不进队**，只留一条 `cancelled` 记录。设备上线后由操作者重跑一次（§4.3） |
| 413 | body 过大 | 上报超过 8KB（正常上报远小于此） |

## 5. 设备端要实现的 7 件事

| # | 事项 | 要点 |
| --- | --- | --- |
| 1 | **设备身份** | 读 base MAC → 12 位小写 hex。用 `esp_read_mac(buf, ESP_MAC_WIFI_STA)`（`esp_mac.h`） |
| 2 | **联网** | `esp_netif_init` + event loop + `esp_wifi` STA 连接；凭据先放 Kconfig，后续可移 NVS 配网 |
| 3 | **上报循环** | 每 15s `POST report`，解析响应里的 `command`；失败要退避重试，**不能因为服务器暂时不可达就停掉循环** |
| 4 | **命令处理** | 有命令才动：查 `releaseId` 是否已在运行（幂等）→ 下载 → 校验 sha256 → 写 OTA 槽 |
| 5 | **回执** | 升级成功后**重启，下一次上报前**把 `result` 发出去（推荐：重启后第一件事就是补发上次的结果，见 §7.5） |
| 6 | **过程上报**（可选，强烈建议） | 下载/校验/写入/重启各报一次 `progress`（§4.5）。不做也能跑通，但页面上看不到过程、还会把你显示成离线 |
| 7 | **分区表改造** | 加 `otadata/ota_0/ota_1`（§8）。**这一步不做，OTA 根本写不进去** |

## 6. 时序与状态机

```
设备                                     服务器
 │  POST report ─────────────────────────► │  更新 lastSeen，设备上线
 │ ◄───────────────── { command: null }   │
 │                                          │   （人在页面点了「下发 OTA」）
 │  POST report ─────────────────────────► │  取出 pending 命令
 │ ◄──────── { command: {url, sha256,...} }│  标记 delivered
 │                                          │
 │  GET  {urlAbsolute} ──────────────────► │  返回固件字节流
 │  POST progress {phase:downloading} ───► │  页面看到「下载固件 x%」（可选，§4.5）
 │  校验 sha256 ─┐                          │
 │              │不匹配 → 回执 failed ────► │  命令结束（未决位释放）
 │              │匹配                        │
 │  POST progress {phase:writing,60%} ───► │  页面看到「写入 OTA 槽 60%」
 │  写空闲 OTA 槽 → 重启                     │
 │                                          │
 │  POST progress {phase:rebooting} ─────► │  页面看到「重启」
 │  （重启后）补发 result success ────────► │  命令标 success
 │  POST report（带新 firmwareVersion）──► │  页面显示新版本
```

命令状态取值（服务器侧）：`pending` → `delivered` → `success` / `failed`；另有 `superseded`（被新命令顶替）。
过程阶段（`progress.phase`）是**旁路信息**：不参与状态机，也不影响回执判定——报不报都能跑通，报了才看得见过程。

## 7. ESP-IDF 参考实现

> 下面是**骨架与关键 API**，不是可编译的完整工程——你按自己的工程结构落地。
> 建议新增 `components/ota/`（只依赖 `esp_http_client` / `cJSON` / `esp_https_ota` / `mbedtls`），**不要和 UI 代码混在一起**。

### 7.1 建议的组件划分

```
components/ota/
  ota_identity.c/h   # deviceId（MAC）、firmwareVersion、可选 app sha256
  ota_report.c/h     # 上报循环：POST report，解析 command
  ota_apply.c/h      # 下载 + sha256 校验 + 写 OTA 槽
  ota_result.c/h     # 回执（含"重启后补发上次结果"）
  ota.c/h            # 对外只暴露 ota_start()（起 FreeRTOS 任务）
```

### 7.2 设备身份与版本

```c
#include "esp_mac.h"
#include "esp_app_desc.h"

/* deviceId：base MAC → 12 位小写 hex（无冒号） */
void ota_device_id(char out[13])
{
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    snprintf(out, 13, "%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

/* firmwareVersion：取 PROJECT_VER。
   ⚠️ 想让版本号自带 git describe（形如 v0.6.0-3-g64de242），需要你的工程
   没有开启 CONFIG_APP_PROJECT_VER_FROM_CONFIG；若开了，PROJECT_VER 改由 Kconfig
   指定，那就得自己保证发布时把版本号写对——先自查：grep APP_PROJECT_VER sdkconfig */
const char *ota_firmware_version(void)
{
    return esp_app_get_description()->version;
}
```

### 7.3 ⚠️ `appSha256` 的坑（务必看清）

`esp_app_get_description()->app_elf_sha256` 是 **ELF 文件**的 sha256；服务器 registry 里的 `sha256` 是 **`.bin` 固件文件**的 sha256。**这两个值永远不相等，不能互相比较。**

所以：

| 目的 | 正确做法 |
| --- | --- |
| 判"这个 release 我是不是已经在跑了" | 比较 **`firmwareVersion`** 与 `command.releaseId`（推荐，零成本）；若两者命名规则不同，就在本地记录"上次成功升级到的 releaseId"（存 NVS） |
| 校验下载到的固件是否完整 | 用 **`command.sha256`**（这就是 `.bin` 的摘要），下载后自己算 sha256 比对。这是正确且必要的 |
| 上报 `appSha256` 字段 | 服务器目前**只存不判**（信息性字段）。想报就自己算 app 分区的 sha256（`esp_ota_get_running_partition()` + 读分区 + `mbedtls_sha256`），**但不建议初期做**——有启动开销，且不参与任何判定 |

> 一句话：**下载校验用命令里的 sha256，自我识别用 firmwareVersion。**

### 7.4 上报 + 取命令（HTTP 客户端 + cJSON）

```c
static esp_err_t ota_report_once(const char *device_id, const char *version, char **out_cmd_url)
{
    char url[160];
    snprintf(url, sizeof(url), "%s/api/devices/%s/report", CONFIG_OTA_SERVER_BASE, device_id);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 10000,
        // 明文 http 时不要设 crt_bundle_attach；https 见 §7.6
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "application/json");

    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "chip", "ESP32-S3");
    cJSON_AddStringToObject(body, "firmwareVersion", version);
    cJSON_AddStringToObject(body, "sdkVersion", esp_get_idf_version());
    cJSON_AddNumberToObject(body, "uptimeMs", esp_timer_get_time() / 1000);
    cJSON_AddNumberToObject(body, "freeHeap", esp_get_free_heap_size());
    char *payload = cJSON_PrintUnformatted(body);
    esp_http_client_set_post_field(client, payload, strlen(payload));

    esp_err_t err = esp_http_client_perform(client);
    /* ...读响应体到缓冲区，cJSON_Parse，取 command.urlAbsolute 与 command.sha256... */

    cJSON_free(payload);
    cJSON_Delete(body);
    esp_http_client_cleanup(client);
    return err;
}
```

要点：

* **响应体可能不大但别假设**——按 `esp_http_client_read_response` / `esp_http_client_get_content_length` 读全再解析。
* **一定要看 HTTP 状态码**：`esp_http_client_get_status_code(client)`。401/400 时把响应体打日志，别静默重试。
* 上报失败（网络/超时/5xx）→ **简单退避**（如 5s、15s、30s，封顶）后重试，保持心跳不断。

### 7.5 执行 OTA 与回执

**方式 A：`esp_https_ota`（推荐，省事）**

```c
esp_http_client_config_t http = {
    .url = cmd_url_absolute,
    .timeout_ms = 20000,
    .keep_alive_enable = true,
};
esp_https_ota_config_t ota_cfg = { .http_config = &http };

esp_err_t err = esp_https_ota(&ota_cfg);
if (err == ESP_OK) {
    esp_restart();               // 成功：重启到新固件
}
// 失败：err 带原因，回执 failed 并写进 detail
```

> ⚠️ **`esp_https_ota` 默认不允许明文 http**（`CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP` 默认 not set）。想走服务器的 80 明文通道（dev 期最省事），必须开：
> `CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP=y`（menuconfig → Component config → ESP HTTPS OTA）。
> 自查：`grep HTTPS_OTA_ALLOW_HTTP sdkconfig`。
> 不想开这个开关的话，就只能走 https（自签证书，见 §7.6）。

**方式 B：`esp_http_client` + `esp_ota_write`（自己控制）**

要自己算 sha256 时用这条：下载流式读入 → `mbedtls_sha256_update` 累积 → 读完比对 `command.sha256` → 一致才 `esp_ota_end()`。适合需要"边下边校验、校验不过就不落盘"的严格场景。

**回执（含重启后补发）**

```c
/* 升级前把待回执信息写进 NVS：command_id + 期望 state */
nvs_set_str(h, "ota_pend_cmd", command_id);
nvs_set_str(h, "ota_pend_res", "success");   /* 或 failed */
/* ...重启... */
/* 启动后联网成功的第一件事：读 NVS → POST result → 清 NVS */
```

这样"升级成功但回执没发出去"不会丢——这也是服务器侧重复投递（§4.1）能配合起来的另一半。

```c
POST /api/devices/{id}/commands/{cid}/result
{ "state": "success", "detail": "OTA ok, rebooted to 20261005-1609-278773" }
```

### 7.6 证书策略（三选一）

| 方案 | 适用 | 代价 |
| --- | --- | --- |
| **走明文 `http://`（80 端口）** | **dev 首选** | 需 `CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP=y`；明文，仅限内网/开发 |
| 内置服务器根证书（PEM） | 生产自签 | 证书轮换时要重新烧固件 |
| 关校验（`skip_cert_common_name_check` / 不设 `crt_bundle_attach`） | **只允许临时 debug** | 中间人可替换固件，等于没有安全 |

服务器现在是**自签证书**。生产建议让服务器上正式证书（Let's Encrypt，需域名），设备再用 `crt_bundle_attach = esp_crt_bundle_attach` 走标准校验。

### 7.7 回滚（强烈建议开）

ESP-IDF **默认不开** `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`（自查：`grep APP_ROLLBACK_ENABLE sdkconfig`）。建议开启并配合：

```c
/* 新固件首次启动、确认自检通过后调用，取消自动回滚 */
esp_ota_mark_app_valid_cancel_rollback();
```

开了之后：新固件若在标记有效前崩溃/重启，bootloader 会自动切回旧槽位——**这是双槽分区表最大的价值**，别浪费。

⚠️ 开了回滚之后，"启动即崩溃"的新固件会被自动丢弃，表现为"升级像是没生效"。所以**新固件启动路径要短、要稳**，并在自检通过后立刻调 valid。

### 7.8 过程上报（让页面看得见过程，§4.5）

一句话：**在下载和写入的循环里，每隔一段就报一次百分比**。body 只有几个字段，照抄即可：

```c
/* 报一次过程点；阶段名用契约里的英文，percent 可省略（校验/重启这类没有百分比） */
static void report_progress(const char *cmd_id, const char *phase, int percent, const char *message)
{
    char url[256], body[256];
    snprintf(url, sizeof(url), "%s/api/devices/%s/commands/%s/progress",
             s_base_url, s_device_id, cmd_id);
    if (percent >= 0) {
        snprintf(body, sizeof(body), "{\"phase\":\"%s\",\"percent\":%d}", phase, percent);
    } else if (message) {
        snprintf(body, sizeof(body), "{\"phase\":\"%s\",\"message\":\"%s\"}", phase, message);
    } else {
        snprintf(body, sizeof(body), "{\"phase\":\"%s\"}", phase);
    }
    /* 与回执共用一个 HTTP 客户端：POST + Content-Type: application/json。
       失败只记一行日志、绝不打断升级 —— 它是旁路信息，成败仍由 result 决定。 */
    http_post_json(url, body);
}

/* 用法（就放在 §7.4/§7.5 的下载与写入路径里） */
report_progress(cmd_id, "downloading", 5,   NULL);
/* ...esp_http_client_read 循环中，每收到约 10% 报一次... */
report_progress(cmd_id, "downloading", 100, NULL);
report_progress(cmd_id, "verifying",   -1,  "sha256");
report_progress(cmd_id, "writing",     50,  "slot ota_0");
report_progress(cmd_id, "writing",     100, NULL);
report_progress(cmd_id, "rebooting",   -1,  "reboot to new app");
```

注意事项：

* **别报太密**：服务器只留最新值 + 阶段变化（trail ≤20 条），几秒一次没问题，但没必要每读 4KB 就发一个请求——按"每 5~10%"或每几秒节流。
* **报失败不打断升级**：400/404/超时都只记日志继续走。
* **它顺带当心跳**：服务器收到过程上报会刷新 `lastSeen`——OTA 期间设备不再按时 `report`，页面也不会把你标成离线。
* 命令 ID 用取到命令时响应里的 `command.id`（`cmd_xxxx`），**不是** `releaseId`。

## 8. 分区表改造（触发工程规则 R10）

### 8.1 先自查三件事（不要照抄，先看清自己工程）

本文**不假设**你的工程现状（设备工程在另一台电脑上维护）。动手前在设备机上跑这三条，把结果记下来：

```bash
# ① Flash 多大？决定你能切出几个应用槽
grep ESPTOOLPY_FLASHSIZE sdkconfig          # 期望 CONFIG_ESPTOOLPY_FLASHSIZE="16MB"（8MB 也行，但槽要小些）

# ② 分区表用的哪个文件、偏移多少？
grep PARTITION_TABLE sdkconfig              # 期望 CONFIG_PARTITION_TABLE_CUSTOM=y + FILENAME="partitions.csv"
                                            # 以及 CONFIG_PARTITION_TABLE_OFFSET=0x8000
cat partitions.csv                          # 看当前槽布局

# ③ 当前是不是单槽？（判据：没有 otadata，且 app 只有 factory 一个）
grep -E "otadata|ota_0|ota_1" partitions.csv || echo "→ 单槽，必须按 §8.2 改"
```

* **若 ②③ 显示已是 `otadata + ota_0 + ota_1`**：分区表这块你已经满足，跳过 §8.2，直接看 §8.3 的开关表。
* **若 ③ 显示单槽（很常见）**：必须改，否则 `esp_ota_*` 找不到目标分区，OTA 写不进去。
* 若 ① 是 8MB：两个应用槽各留 ~1.9M（合计 ~3.8M），剩余给 `storage`；把下面 CSV 里的 `4M/4M` 按比例改小即可，其余规则不变。

### 8.2 建议改成（16MB flash 示例）

```csv
# Name,   Type, SubType, Offset,   Size,  Flags
nvs,      data, nvs,     0x9000,   0x6000,
otadata,  data, ota,     0xf000,   0x2000,
phy_init, data, phy,     0x11000,  0x1000,
ota_0,    app,  ota_0,   ,         4M,
ota_1,    app,  ota_1,   ,         4M,
storage,  data, spiffs,  ,         7M,
```

规则（比具体数字重要）：

* `otadata` 必须是 `data, ota` 类型、`0x2000` 大小，且**排在两个 app 槽之前**。
* 两个应用槽**大小必须相同**，且偏移要对齐分区表要求。
* 两块应用槽的**总量不应小于**原来单槽的容量——否则你的 app 会突然装不下。原来若是 `factory 8M`，改成 `4M + 4M` 总量持平。
* `nvs` 会被重烧清空，**WiFi 凭据等存在 NVS 的东西会丢**，第一次上电要能重新配网。
* ⚠️ **改分区表 = 必须整片重烧**（不只是烧 app），`storage` 原有数据会失效。发布/烧录两侧的段表要同步更新。

### 8.3 相关开关确认表（按需改）

| 开关 | 为什么 | 怎么确认/处理 |
| --- | --- | --- |
| `CONFIG_PARTITION_TABLE_CUSTOM` + `_FILENAME` | 让工程用你的 `partitions.csv` | 若当前是 `SINGLE_APP` 预设，改 `CUSTOM` 并指向 csv |
| `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` | 失败自动回滚（§7.7） | 默认 not set → 建议 `y` |
| `CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP` | 允许 OTA 走明文 http（§7.4） | 走 80 明文则必须 `y` |
| `CONFIG_APP_PROJECT_VER_FROM_CONFIG` | 决定 `firmwareVersion` 从哪来（§7.2） | 保持 not set 才能拿到 git describe |
| `CONFIG_ESPTOOLPY_FLASHSIZE` | 决定能给几个槽、多大 | 与分区表总面积对得上，否则烧录报"分区超出 flash" |

## 9. 联调步骤（不用等硬件，也不用等设备端写完）

服务器侧带了**设备模拟器**（零依赖 Node，就是假装成一台 ESP32）。**先在设备机上用它把契约验一遍**，再写固件——能省掉大量"到底是设备错还是服务器错"的扯皮。

### 9.1 拿到模拟器

两种方式（选一）：

```bash
# 方式一：从服务器直接下载源码（两文件同目录，零依赖）
curl -O http://<SERVER>/tools/device-sim/lib.js
curl -O http://<SERVER>/tools/device-sim/index.js
# 用法内建：node index.js --help

# 方式二：从服务器仓库拷贝 tools/device-sim/ 整个目录
```

### 9.2 跑起来

```bash
# ① 冒烟：一台假设备上报一次，看服务器收不收
node tools/device-sim/index.js --server http://<SERVER> --once

# ② 常驻：每 5s 上报一次（把 45s 离线判定也一起看到）
node tools/device-sim/index.js --server http://<SERVER> --devices 3 --interval 5

# ③ 指定 deviceId（复现某台具体设备）
node tools/device-sim/index.js --server http://<SERVER> --id 3485a1b2c3d4

# ④ 只上报、不取命令（观察 pending→delivered→重复投递）
node tools/device-sim/index.js --server http://<SERVER> --id 3485a1b2c3d4 --dry-run

# ⑤ 演练失败分支（30% 概率回执 failed）
node tools/device-sim/index.js --server http://<SERVER> --interval 5 --fail-rate 0.3

# ⑥ 看"过程视图"：模拟器默认按阶段报进度，页面 /OTA 上会看到 下载→校验→写入→重启
#    想对比"设备端没实现过程上报"的样子：加 --no-progress
node tools/device-sim/index.js --server http://<SERVER> --id 3485a1b2c3d4 --progress-ms 800
node tools/device-sim/index.js --server http://<SERVER> --id 3485a1b2c3d4 --no-progress
```

### 9.3 手动走一遍完整 OTA

```bash
# 1) 看服务器把设备认出来了吗（应看到你的 deviceId，online=true）
curl http://<SERVER>/api/devices

# 2) 看有哪些固件版本可选（拿 releaseId）
curl http://<SERVER>/api/registry

# 3) 下发命令（需要 token；向运维者索取，或用页面右上角 🔑 生成一个工作 token）
#    不想记 token：让运维者给一个设置链接 https://<host>/OTA#token=<token>，
#    打开即写入本机浏览器（片段不上行，不进服务器日志），或把 /OTA 页的
#    「🔗 复制设置链接」存成书签，换电脑时打开书签即可。
curl -X POST http://<SERVER>/api/devices/3485a1b2c3d4/commands \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"type":"ota","releaseId":"20261005-1609-278773"}'

# 4) 让模拟器去取命令并执行（它会真的下载 + 校验 sha256 + 回执）
node tools/device-sim/index.js --server http://<SERVER> --id 3485a1b2c3d4 --once

# 5) 核对结果
curl http://<SERVER>/api/devices     # lastCommand.state 应为 success，firmwareVersion 已更新
```

**或者更省事**：直接在浏览器打开 `http://<SERVER>/OTA`，页面点「选择并下发」，不用敲 curl（页面读的是实时设备列表，需要先在上方填 Token）。

### 9.4 模拟器会替你验证什么

* 上报字段服务器是否接受（含 400 的非法 deviceId）
* 命令是否被正确解析出 `file/url/sha256/size`
* **下载 URL 是否真的能取到字节**，且 sha256 与命令一致
* 回执链路与状态流转
* 失败分支（篡改固件 → sha256 不匹配 → failed）
* **过程上报**（默认按阶段报 下载→校验→写入→重启；`--no-progress` 可对比"设备端没实现"的样子）——页面 `/OTA` 的「OTA 过程」面板会实时画出来

## 10. 失败模式与排查

| 症状 | 可能原因 | 怎么办 |
| --- | --- | --- |
| 上报一直 **400** | `deviceId` 不是 12 位小写 hex（含大写/冒号/长度不对）；body 不是 JSON 对象 | 打印实际拼出的 URL 与 body 核对 |
| 上报 **401** | 几乎不会（report 免鉴权）。若遇到，说明你打到了别的主机/路径 | 确认 URL 与端口 |
| 上报成功但 `/api/devices` 里 `online:false` | 上报间隔 > 45s | 把间隔调到 15s |
| 下发命令 **404** | `releaseId` 在服务器 registry 里不存在 | 先 `GET /api/registry` 抄准 ID |
| 下发命令 **409** | 该设备已有未回执命令 | 先查 `/api/devices` 的 `lastCommand.state`；确实要顶替就加 `force:true` |
| 命令一直是 `delivered` 不回结果 | 设备取走后崩溃/丢响应 | 服务器会**重复投递**（`redelivered:true`）；设备端务必做幂等并补发回执（§7.5） |
| 命令是 `delivered`，但页面看不到过程 | 设备端没实现过程上报（§4.5），或上报打到别的 commandId | 先看 `GET /api/devices` 里 `lastCommand.progress/trail` 是否为空；自定义阶段要报 ≤32 字符 |
| 下载 **404** | 命令里的 `url` 段名与服务器实际路径不符 | 用 `urlAbsolute` 而不是自己拼；或核对 release 的 parts |
| 下载 sha256 不匹配 | 传输被截断 / 服务器上文件被换过 | 回执 failed 并带上实际 sha；别写入 OTA 槽 |
| `esp_https_ota` 报协议/参数错误 | 用了 `http://` 但没开 `CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP` | §7.4 |
| 升级后启动崩、又回到旧固件 | 正常——说明回滚生效 | 查新固件崩溃原因；确认自检通过再 `esp_ota_mark_app_valid_cancel_rollback()` |
| OTA 写不进去 / 找不到分区 | 分区表没改（还是单 `factory`） | 做 §8，并**整片重烧** |
| 服务器不可达 | 地址/端口/明文通道是否放行 POST | 先用 `curl http://<SERVER>/api/status` 从设备所在网络验证 |

## 11. 验收清单（逐条打勾）

设备端做完后，用下面的清单自证（每条都能在服务器侧观察到证据）：

- [ ] `GET /api/devices` 能看到本设备，`deviceId` 等于本机 MAC 去冒号小写
- [ ] 上报字段齐（chip / firmwareVersion / sdkVersion / ip），`online: true`
- [ ] 断电 60s 后 `online: false`；重新上电后 15s 内恢复 `true`
- [ ] 页面 `/OTA` 能看到本设备（数据源切 real）
- [ ] 下发一条命令 → 设备在 ≤2 个上报周期内取走（状态变 `delivered`）
- [ ] 设备下载的字节数等于 `command.size`，sha256 等于 `command.sha256`
- [ ] 升级后重启，`firmwareVersion` 变成新 `releaseId`，`lastCommand.state = success`
- [ ] 故意篡改固件（或改 sha）→ 设备回执 `failed` 且带原因，**未写入 OTA 槽**
- [ ] 设备取走命令后立刻断电（不回执）→ 重新上电后能**重复收到该命令**并最终回执
- [ ] （可选，强烈建议）下载/写入时页面能看到过程链推进；OTA 期间设备不会被显示成离线
- [ ] 分区表已是 `otadata + ota_0 + ota_1`，用户数据（storage）在新分区表下能正常挂载

## 12. 不在本次范围（后续可扩展）

* 设备"开机自动检查最新版"（现在是页面手动下发）
* 批量下发 / 灰度
* MQTT 或长连接推送（当前是 HTTP 轮询 pull）
* 设备端上报日志回传、远程调试

***

**关联文档**

* 服务器侧总契约与三端设计：[/docs/ota.md](/docs/ota.md)
* 服务器部署与通道现状：[/docs/SERVER.md](/docs/SERVER.md)
* 发布固件（造 releaseId 的源头）：[/docs/PUBLISH.md](/docs/PUBLISH.md)
* AI 总索引：[/llms.txt](/llms.txt) · 机器描述符：[/ota.json](/ota.json)
* 页面：服务器地址 + `/OTA`
