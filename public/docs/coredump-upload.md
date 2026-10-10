# Coredump 开机上报 — 设备端 / 服务端接口设计

> **【速读】** 供**服务器侧 AI** 评估并实现服务端接口的设计文档。
>
> * **定位**：定义设备在开机（或网络就绪）时检测到的「新的、未上传」coredump 如何推送到服务器的**两端契约**。服务器端目前尚未实现，本文档即服务器侧的实现依据。
>
> * **阅读模式**：`全文必读`（服务器 AI 实现前通读）。
>
> * **规模**：约 200 行。
>
> * **何时读全文**：实现服务端 coredump 接收接口、或核对设备端上报行为时。
>
> * **最易踩点**：① 设备上报是 **at-least-once 语义**，服务器必须按 `(deviceId, sha256)` 幂等排重；② coredump 体积为「几 KB \~ 几十 KB」（分区 64K，实际按 dump 大小），非固定 64K；③ 崩溃的**绝对时间无法还原**，服务器应以「接收时间」为准。

***

## 1. 背景与目标

设备（ESP32-S3）崩溃时，ESP-IDF 会把崩溃转储（coredump，ELF 格式）写入 flash 的 `coredump` 分区（地址 `0x412000`，大小 `0x10000` = 64K）。这份数据只有两种去向：被本地工具 `espcoredump.py` 读取，或由设备自己上传。

**目标**：设备端在开机时本地检测是否存在「新的、尚未成功推送」的 coredump；若存在且网络可用，推送到服务器；推送成功后擦除本地 coredump 并记录签名，避免重复上传。服务器端收集后可用于崩溃归类、自动符号化、回归分析。

## 2. 总体流程（设备端）

```
[设备崩溃] ──panic──► espcoredump 写 coredump 分区 ──重启──► app_main
                                                              │
                                        ┌─────────────────────┘
                                        ▼
                              coredump_sync::start()  (后台任务，低频轮询)
                                        │
                    ┌───────────────────┴────────────────────┐
                    │  wifi_connected()?                     │
                    │    否 ──► connect_wifi() 后延时重试      │
                    │    是 ──► esp_core_dump_image_check()   │
                    └───────────────────┬────────────────────┘
                                        │
            ┌───────────────────────────┼───────────────────────────┐
            │ ESP_ERR_NOT_FOUND         │ ESP_OK                    │ 损坏(INVALID_SIZE/CRC)
            │ （无 dump，正常）           │ 读 dump 算 sha256         │
            │ 本周期无活，继续轮询        │ 与 NVS 已传签名比对        │ erase() 清理
            │                           │   相同 → 仅 erase 残留     │
            │                           │   不同 → 上传              │
            │                           │      200 → 写签名 + erase │
            │                           │      失败 → 保留，下轮重试 │
            └───────────────────────────┴───────────────────────────┘
```

## 3. 设备端检测逻辑

依赖 ESP-IDF 运行时 API（`esp_core_dump.h`，`CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH=y` 已启用）：

| API                                       | 作用                                  | 返回值关键点                                                                            |
| ----------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| `esp_core_dump_image_check()`             | 校验 flash 里的 coredump 是否有效           | `ESP_OK` 有效；`ESP_ERR_NOT_FOUND` 无；`ESP_ERR_INVALID_SIZE`/`ESP_ERR_INVALID_CRC` 损坏 |
| `esp_core_dump_image_get(&addr,&size)`    | 取 dump 在 flash 的地址与大小（含尾部 checksum） | —                                                                                 |
| `esp_core_dump_get_panic_reason(buf,len)` | 取 panic 原因字符串（含简要 backtrace）        | 可能较长，需截断                                                                          |
| `esp_core_dump_get_summary(&s)`           | 取结构化摘要                              | 含 `exc_task[16]`（崩溃任务名）、`exc_pc`、`core_dump_version`、`app_elf_sha256`             |
| `esp_core_dump_image_erase()`             | 擦除 flash 中的 coredump                | 擦除后 `check()` 变 `NOT_FOUND`                                                       |

「**是否更新**」的判定：

1. `check() == ESP_OK`（存在有效 dump）是前提；
2. 对 dump 数据本身（`image_get` 的 `addr` 起 `size` 字节，含尾部 checksum）计算 `sha256`；
3. 与 NVS 中上次已上传的签名比对：

   * **不同 → 新的，需要上传**；

   * 相同 → 已处理过的残留（擦除失败），跳过上传、仅重试擦除。

该签名即下文元数据里的 `sha256` 字段，两端用同一数据源计算，天然可用作排重键。

## 4. 上传协议（核心）

### 4.1 公共约定

| 项           | 值                                                                   |
| ----------- | ------------------------------------------------------------------- |
| Base URL    | `http://175.178.156.231`（与现有固件服务器一致，明文 HTTP，无鉴权）                    |
| 方法          | `POST`                                                              |
| `device_id` | WiFi STA MAC 12 位小写 hex（如 `aabbccddeeff`），与 OTA 组件 `device_id()` 同源 |
| 重试语义        | **at-least-once**（上传失败保留 dump，下轮重试；ack 丢失会重传）                       |
| 排重键         | `(deviceId, sha256)`，服务器收到相同键应直接返回成功、不重复入库                          |

### 4.2 方案 A —— 二进制原文（推荐）

元数据放 query + 自定义 header，body 为原始 coredump ELF 字节。

```
POST /api/devices/{device_id}/coredump?fw={firmwareVersion}&sha256={sha256}&panic={urlencode(panicReason)}&size={sizeBytes} HTTP/1.1
Host: 175.178.156.231
Content-Type: application/octet-stream
X-Device-Id: aabbccddeeff
X-Chip: ESP32-S3
X-Exc-Task: main
X-App-Elf-Sha256: <64 hex of the crashing app's ELF>

<body = 原始 coredump ELF 字节，长度 = sizeBytes>
```

* `sizeBytes` 与 body 实际长度一致；服务器可按此校验完整性。

* 可选 header（`X-Exc-Task`、`X-App-Elf-Sha256`）供崩溃归类与固件符号匹配，缺省可不传。

* 优点：省流量；服务器落盘后即为标准 coredump，可直接用官方 `espcoredump.py info_corefile` 解析。

* 设备端代价：需在 `net` 组件新增 `http_post_binary()`（用 `esp_http_client_set_post_field()` 传显式 `body_len`，替代现有 `http_post` 的 `strlen` 定长，因 ELF 含 `\0` 字节会截断）。

curl 示例：

```bash
curl -X POST \
  "http://175.178.156.231/api/devices/aabbccddeeff/coredump?fw=0.11.1&sha256=$(shasum -a 256 coredump.bin | cut -d' ' -f1)&panic=GuruMeditationError&size=$(stat -c%s coredump.bin)" \
  -H "Content-Type: application/octet-stream" \
  -H "X-Device-Id: aabbccddeeff" \
  -H "X-Chip: ESP32-S3" \
  --data-binary @coredump.bin
```

### 4.3 方案 B —— JSON envelope + base64

沿用设备端现有 `net::http_post`（不改 `net`），元数据与数据打包进一个 JSON，数据字段用 base64。

```
POST /api/devices/{device_id}/coredump HTTP/1.1
Host: 175.178.156.231
Content-Type: application/json

{
  "chip": "ESP32-S3",
  "deviceId": "aabbccddeeff",
  "firmwareVersion": "0.11.1",
  "sdkVersion": "v6.0.1-1-g1234567",
  "sha256": "<64 hex of coredump data>",
  "panicReason": "Guru Meditation Error: ...",
  "excTask": "main",
  "excPc": "0x42001234",
  "appElfSha256": "<64 hex of crashing app ELF, optional>",
  "sizeBytes": 1234,
  "uptimeMs": 123456,
  "data": "<base64 of coredump ELF bytes>"
}
```

* 优点：实现最简单，服务器一次取全字段；缺点：体积约 +33%，服务器需 base64 解码。

* `deviceId` 已同时出现在 URL 路径与 body，服务器可只信其一（建议以 body 为准做校验）。

### 4.4 成功响应（两种方案通用）

服务器处理成功后返回 200 + 简短 JSON 确认，设备据此「写签名 + 擦除」：

```json
{"ok": true, "id": "<server-generated dump id, optional>"}
```

* 设备收到 `HTTP 200`（并解析到 `ok:true`）→ 写 NVS 签名 + `erase()`；

* 其余状态（4xx/5xx/网络异常）→ 设备保留 dump，下轮重试（带退避，见 §6）。

## 5. 幂等与排重

* **设备侧**：NVS 键 `coredump_sha256`（`appcfg` 命名空间，64 hex）记录「最近一次成功上传的 dump 签名」，防止「擦除失败残留」导致的重复上传。

* **服务器侧**：按 `(deviceId, sha256)` 幂等。收到已存在的键 → 直接返回 `{"ok":true}`，不重复入库。这同时覆盖「上传成功但 ack 丢失、设备重传」的 at-least-once 场景。

* 顺序保证：设备**仅在收到 200 后才写签名、再擦除**；没有 200 则原样保留 dump，由服务器幂等兜底重传重复。

## 6. 边界与错误处理

| 场景                              | 处理                                                                |
| ------------------------------- | ----------------------------------------------------------------- |
| WiFi 未就绪                        | 后台任务低频轮询（默认约 30s），连接成功后即处理                                        |
| coredump 损坏（`INVALID_SIZE/CRC`） | 直接 `erase()` 清理，不占后续开机时间                                          |
| 上传失败                            | 保留 dump，下轮重试；连续失败追加指数退避（建议上限 10 分钟），避免打爆服务器                       |
| dump 体积                         | 分区 64K 上限，实际 dump 通常远小于此（几 KB\~几十 KB），单次 POST 即可承载                |
| 崩溃绝对时间                          | coredump 内**不含时间戳**，无法精确还原崩溃时刻；服务器应以「接收时间」为准，设备可附 `uptimeMs` 仅作参考 |

## 7. 服务器侧需实现接口清单

| 项  | 内容                                                                                                                                           |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 端点 | `POST /api/devices/{device_id}/coredump`                                                                                                     |
| 鉴权 | 当前无（明文 HTTP，与 OTA 上报一致）；是否加 token/HTTPS 由服务器侧定                                                                                               |
| 入库 | 原始 coredump 落盘 + 元数据入库（`deviceId`, `sha256`, `firmwareVersion`, `panicReason`, `excTask`, `excPc`, `appElfSha256`, `sizeBytes`, `createdAt`） |
| 排重 | `(deviceId, sha256)` 唯一约束，重复请求返回 200 不重复入库                                                                                                   |
| 响应 | `200 {"ok":true,"id":...}`；失败返回 4xx/5xx（设备据此重试）                                                                                              |

## 8. 待服务器 AI 确认项

1. **payload 选方案 A（二进制）还是 B（JSON+base64）** —— 决定设备端是否新增 `net::http_post_binary`。
2. **端点路径** 是否就用 `POST /api/devices/{device_id}/coredump`，还是并入现有 OTA 上报的 `/api/devices` 体系。
3. **成功响应字段** `ok` / `id` 的命名是否可接受。
4. **鉴权**：维持明文无鉴权，还是补 token / 升 HTTPS。
5. 是否需要设备回传 `appElfSha256`（帮助服务端匹配崩溃固件的调试符号），可设为必需/可选。

