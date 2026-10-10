# coredump 崩溃上报 — 三端契约（设备端 / 服务端 / 页面）

> **【速读】**
>
> * **定位**：ESP32-S3 崩溃时，设备在开机（网络就绪）后把 flash `coredump` 分区里的转储**主动上传**到服务器；服务器可靠落盘 + 存元数据；运维在独立页 `/coredump` 查看、下载。本文是**设备端 / 服务端 / 页面三端的唯一契约**。
>
> * **阅读模式**：`全文必读`。
>
> * **规模**：约 200 行。
>
> * **最易踩点**：① 上报是 **at-least-once 语义**，服务器按 `(deviceId, sha256)` 幂等排重；② **sha256 是「原始 body 字节」的签名**，两端必须对同一数据源计算，服务器会校验，不符直接 400；③ 崩溃的**绝对时间无法还原**，服务器以 `receivedAt`（接收时间）为准；④ 服务器落盘的是设备上传的**原始字节**，**不保证是标准 ELF**——符号化是离线动作，见 §7。

---

## 1. 背景

设备崩溃时 ESP-IDF 把 coredump 写入 flash 的 `coredump` 分区（64K，`CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH=y`）。设备端在开机时检测「新的、未上传」的 dump 并推送，成功后擦除本地并记录签名。

设备端的检测/上传流程（轮询、`esp_core_dump_image_check` 判新、NVS 记签名）见 [`docs/coredump-upload.md`](./coredump-upload.md)。本文是**服务器与页面已实现的那一半**的落地契约。

## 2. 数据模型

`Coredump`（服务器落库的一条记录，见 `server/coredumps.js`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `cdump_<8 hex>`，服务器生成，页面/下载用 |
| `deviceId` | string | base MAC 去冒号小写十六进制（12 位），与 OTA 同源 |
| `sha256` | string | **原始 body 字节**的 sha256（64 位小写 hex），幂等排重键 |
| `size` | number | body 字节数 |
| `firmwareVersion` | string \| null | 崩溃固件版本（query `fw`） |
| `panicReason` | string \| null | panic 原因字符串（含简要 backtrace，header 传入，服务器已 decode） |
| `excTask` | string \| null | 崩溃任务名（`esp_core_dump_get_summary().exc_task`） |
| `excPc` | string \| null | 崩溃 PC，如 `0x42001234` |
| `appElfSha256` | string \| null | 崩溃固件 ELF 的 sha256（可选，用于离线符号化时匹配调试符号） |
| `chip` | string \| null | 芯片，如 `ESP32-S3` |
| `sdkVersion` | string \| null | SDK 版本 |
| `receivedAt` | ISO8601 UTC | 服务器接收时间（**崩溃绝对时间不可还原，以此为准**） |

二进制 dump 本身**不进 JSON**，落盘到 `server-data/coredumps/<sha256>.bin`，按 sha256 命名天然幂等。

## 3. 服务端存储

- 元数据：`server-data/coredumps.json`，结构 `{ coredumps: [Coredump, ...] }`（新→旧）。
- dump 文件：`server-data/coredumps/<sha256>.bin`。
- 写入：单文件原子写（tmp + rename），同 `devices.json`。
- **幂等**：`(deviceId, sha256)` 唯一。重复请求 → 返回旧记录的 `id` + `duplicate:true`，不重复入库、不重复建文件。
- **retention**：每设备保留最近 `20` 条（`MAX_COREDUMPS_PER_DEVICE`），超出的最旧记录连同其 dump 文件一并删除。

## 4. 上报协议（设备端 → 服务器）

**方案 A —— 二进制 body**（元数据走 query + header），这是定稿方案。

```
POST /api/devices/{deviceId}/coredump?sha256={sha256}&size={sizeBytes}&fw={firmwareVersion} HTTP/1.1
Host: <firmware-server>
Content-Type: application/octet-stream
X-Panic-Reason: {urlencode(panicReason)}
X-Exc-Task: main
X-Exc-Pc: 0x42001234
X-App-Elf-Sha256: {64 hex, optional}
X-Chip: ESP32-S3
X-Sdk-Version: {sdkVersion}

<body = 原始 coredump 字节，长度 = sizeBytes>
```

### 4.1 参数

| 位置 | 参数 | 必填 | 说明 |
| --- | --- | --- | --- |
| path | `deviceId` | 是 | 12 位小写 hex，不合法 → 400 |
| query | `sha256` | 是 | body 字节的 sha256，64 位 hex（大小写均收，服务器归一为小写）；服务器对 body 重算并比对，不符 → 400 |
| query | `size` | 否 | body 字节数；给出则必须等于实际 body 长度，否则 400 |
| query | `fw` | 否 | 固件版本，≤128 字符 |
| header | `X-Panic-Reason` | 否 | urlencode 过的 panic 原因（≤2KB），服务器 decode 后入库 |
| header | `X-Exc-Task` | 否 | 崩溃任务名 ≤128 |
| header | `X-Exc-Pc` | 否 | ≤32 |
| header | `X-App-Elf-Sha256` | 否 | 崩溃固件 ELF sha256，64 hex（可选，符号化用） |
| header | `X-Chip` | 否 | ≤32 |
| header | `X-Sdk-Version` | 否 | ≤64 |

### 4.2 响应

成功（首次入库）：

```json
{ "ok": true, "id": "cdump_a1b2c3d4", "duplicate": false }
```

幂等命中（`(deviceId, sha256)` 已存在）：

```json
{ "ok": true, "id": "cdump_<旧记录的 id>", "duplicate": true }
```

失败（设备据此保留 dump，下轮重试）：

| 状态 | 场景 |
| --- | --- |
| 400 | deviceId 非法 / sha256 缺失或非 64 hex / body 空 / sha256 与 body 不符 / size 不符 |
| 413 | body 超过 64K 上限 |

## 5. 查询 / 下载端点（页面用，公开只读）

| 端点 | 说明 |
| --- | --- |
| `GET /api/coredumps` | 全部 coredump 列表（新→旧），返回 `{ _meta, coredumps: Coredump[] }`，每条含 `downloadUrl` |
| `GET /api/devices/{deviceId}/coredumps` | 单设备列表，`{ deviceId, coredumps }` |
| `GET /api/coredumps/{id}` | 单条摘要 `{ coredump }` |
| `GET /api/coredumps/{id}/download` | 下载原始 dump 字节（`application/octet-stream` + `Content-Disposition`） |

`id` 不合法 → 400；不存在 → 404。

## 6. 鉴权与安全

- 上报**免鉴权**（`deviceId` 即身份），与 `POST /api/devices/{id}/report` 一致；查询/下载公开只读。
- 因为是无鉴权的二进制写入端点，服务器强制三道校验防磁盘灌水：`deviceId` 白名单、body ≤ 64K、sha256 与 body 一致。
- **已知信任边界**（与现有 OTA 上报相同的既有限制）：明文 HTTP 下任何人可冒充任意 `deviceId` 上传伪造数据。若要收紧（token/HTTPS），需设备端同步改动，属后续项。

## 7. 符号化（离线动作，不在页面内做）

服务器落盘的是设备上传的**原始字节**。ESP-IDF `to-flash` 默认写的是**专有二进制格式**，不保证是标准 ELF。要拿到可读的 backtrace 需要三样东西齐备：

1. 下载到的 dump 文件（`GET /api/coredumps/{id}/download`）；
2. 崩溃固件的 ELF 文件（用 `appElfSha256` 在 registry 里匹配对应版本，或直接取发布产物）；
3. 官方工具 `espcoredump.py`（esptool 自带）。

```bash
# raw 分区镜像（若设备上传的是 esp_core_dump_image_get 的原始格式）
espcoredump.py --chip esp32s3 info_corefile -t raw -g app.elf coredump.bin
# 已是标准 ELF 时
espcoredump.py info_corefile coredump.bin
```

页面 `/coredump` 只做收集/查看/下载，符号化留给人或脚本离线完成。

## 8. 待设备端确认

1. **上传的到底是 raw 分区格式还是已转 ELF**——决定 `espcoredump.py` 的 `-t raw` 是否必须（§7）。服务器两端都不改，落盘原样保存。
2. `X-Panic-Reason` 的编码：契约为 **urlencode**，服务器会 `decodeURIComponent`；若设备端直接传原始 ASCII（非 urlencode），服务器也兼容（decode 失败时保留原样）。
3. `appElfSha256` 是否上报：可选，建议上报，符号化才能精确匹配崩溃固件。
