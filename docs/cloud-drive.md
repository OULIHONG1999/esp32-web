# 云盘（Cloud Drive）—— 三端契约

> **【智能体速读】**
>
> * **定位**：给「设备 + 智能体 + 人」协作体系一个**共享文件仓库**——宿主机/智能体上传任意文件到云端，设备经 fetch 命令下载安装到 `/fs` 或 `/sdcard`，智能体/人经 HTTP 下载查看。需求背景见 `docs/fetch-channel/03-cloud-drive.md`（本文是其**定稿契约**，API 以此为准）。
> * **什么时候读**：接云盘服务端、写上传/下载脚本、或用 fetch 命令时填 `url`。
> * **阅读模式**：`按需查 §2`（API）、`按需查 §6`（与 fetch 通道衔接）。
> * **关键小节**：§2 API 契约；§4 存储与限额；§6 与 fetch 通道的关系。
> * **最容易踩的点**：① 设备单次下载上限 **4 MB**（fetch `maxBytes` 硬顶），云盘单文件上限是 8 MB——要装进设备的东西必须 ≤4 MB；② 存储名用 `fileId`、**展示名另存**，不要拿用户文件名直接落盘；③ 读（列表/下载）**公开**是因为设备 `net::http_get` 不带 token，写（上传/删除）才要 Bearer。

***

## 1. 目标与范围

| 目标 | 说明 |
|---|---|
| 存 | 宿主机 / 智能体把任意文件（JSON、字体、音频、图片、文档…）上传到云端留存 |
| 取 | 设备经 fetch 命令下载安装到 `/fs` 或 `/sdcard`；智能体 / 人经 HTTP 直接下载查看 |
| 管 | 列表、元数据（大小 / 上传时间 / 备注）、删除 |

一句话：**给这套"设备 + 智能体 + 人"的协作体系一个共享文件仓库。**

## 2. API 契约

> 命名对齐现有服务器（camelCase、`/api/` 前缀、token 鉴权同 publish）。`{fileId}` = 服务端生成的 `f_` + 8 位 hex。

### 2.1 上传

`POST /api/drive/files`（**需 Bearer**：主 token 或工作 token）

两种形态二选一：

- **multipart/form-data**：字段 `file`（二进制，必填）+ `note`（可选备注）。
- **raw body + 头**：请求体即文件字节，`X-Filename` 头给展示名（必填）、`X-Note` 头给备注（可选）。

响应（200）：

```json
{ "file": { "fileId": "f_1a2b3c4d", "name": "robot.json", "size": 11234, "note": "vanim 动画", "createdAt": "2026-10-16T08:00:00Z", "url": "http://175.178.156.231/api/drive/files/f_1a2b3c4d" } }
```

错误：400（缺 file 字段 / 空 body / 缺 X-Filename）、401（token 无效）、413（单文件 >8 MB 或总配额 >1 GB）。

### 2.2 列表

`GET /api/drive/files`（公开只读）

```json
{
  "_meta": { "service": "firmware-server", "docs": "/docs/cloud-drive.md", "maxFileBytes": 8388608, "maxTotalBytes": 1073741824, "totalBytes": 22468 },
  "files": [ { "fileId": "f_...", "name": "...", "size": 1234, "note": null, "createdAt": "...", "url": ".../api/drive/files/f_..." } ]
}
```

新→旧排序；`url` 是绝对下载地址。

### 2.3 下载 / 元数据

`GET /api/drive/files/{fileId}`（公开只读）

- 默认：返回原始字节；`Content-Type` 按展示名扩展名给（未知 `application/octet-stream`），**始终 `Content-Disposition: attachment`**（HTML/SVG 不会被浏览器内联执行）。
- `?meta=1`：返回元数据 JSON `{ "file": DriveFile }`。

错误：400（坏 fileId）、404（不存在 / 磁盘文件丢失）。

### 2.4 删除

`DELETE /api/drive/files/{fileId}`（**需 Bearer**）

- 磁盘文件 + 元数据一起删；**幂等**——重复删除也返回 200，用 `removed` 区分：`{ "ok": true, "removed": true|false }`。
- 错误：400（坏 fileId）、401（token 无效）。

## 3. 数据模型

```json
{
  "fileId": "f_1a2b3c4d",
  "name": "robot.json",
  "size": 11234,
  "note": "vanim 动画",
  "createdAt": "2026-10-16T08:00:00Z",
  "url": "http://175.178.156.231/api/drive/files/f_1a2b3c4d"
}
```

| 字段 | 说明 |
|---|---|
| `fileId` | 服务端生成（`f_` + 8 hex），**与用户文件名解耦** |
| `name` | 展示名（净化后：去控制字符、路径分隔符、`..`，截断 200；空兜底 `unnamed`），**只作展示，绝不作路径** |
| `size` | 字节数 |
| `note` | 可选备注（≤500） |
| `createdAt` | 上传时间（ISO8601 UTC） |
| `url` | 下载地址（列表/上传响应里给绝对地址） |

## 4. 存储与限额

| 项 | 值 | 说明 |
|---|---|---|
| 磁盘布局 | `server-data/drive/<fileId>` 平坦文件 + `server-data/drive/index.json` 元数据 | 字节按 fileId 命名，与展示名解耦 |
| 单文件上限 | **8 MB** | 设备经 fetch 下载受 4 MB 顶；更大文件面向智能体/人 |
| 总配额 | **1 GB** | 超额上传返回 **413** |
| 文件名净化 | 去控制字符、`/`、`\`、`..`，trim + 截断 200 | 存储只用 fileId，净化是为展示安全 |
| 删除 | 磁盘 + 元数据一起删；幂等（重复 DELETE → 200 `removed:false`） | |

## 5. 安全

* **写（上传/删除）**：沿用 publish token（`Authorization: Bearer`，主 token 或工作 token）。
* **读（列表/下载）**：默认**开放**——设备端 `net::http_get` 不带 token，设备要下载就不能要求鉴权。私密文件 v2 加"带过期时间的签名 URL"。
* 上传内容**不做病毒/内容审查**（内网工具属性）；但下载**始终 `Content-Disposition: attachment`**，HTML/SVG 不会被浏览器当页面内联执行。
* 展示名净化是纵深防御：即使上传 `../`、控制字符、超长名，落盘也只用 fileId，展示名被清洗。

## 6. 与 fetch 通道的关系（对齐点）

云盘是 fetch 的**推荐文件源**，两者通过一个 URL 字段衔接，无其他耦合：

```
智能体 ──POST /api/drive/files──► 云盘（返回 url）
智能体 ──POST /api/devices/{id}/commands {type:"fetch", url, dest}──► 命令通道
设备  ──GET url──► 云盘 ──字节──► 设备落盘 /fs 或 /sdcard
```

* **fetch 命令的 `url` 直接填云盘下载地址**（`/api/drive/files/{fileId}`）。
* 设备侧约束（fetch 契约）：`url` 必须完整 `http://`；文件 ≤ `maxBytes`（≤4 MB）；目标路径白名单 `/fs/`、`/sdcard/`。云盘**不需要**知道 dest，也不解析文件内容。
* 静态目录（`/files/`，见 `docs/fetch-channel/02-server.md` §5）与云盘并存；云盘稳定后 `/files/` 可退役。

## 7. 验收清单

1. 上传 100 KB JSON → 返回 fileId；curl 下载字节一致（md5 对得上）。
2. 上传 9 MB 文件 → 413。
3. 列表含新文件，字段齐全；删除后列表消失、再 GET 下载 → 404；重复 DELETE → 200 `removed:false`。
4. 设备端到端：fetch 命令 `url=云盘 URL`，`dest=/fs/vanim/test.json` → 15 s 内回执 success，设备页可见可播。
5. 展示名含中文/空格/`../` → 上传成功且存储名安全，列表展示名正确。

## 8. 非目标（v1）

多用户/多租户、目录层级（扁平存储）、版本历史、断点续传、秒传/去重、分享链接权限、客户端同步、重命名/更新备注（F6）、私密文件的签名 URL。

## 9. 实现状态

- **服务器端点** ✅（`server/drive.js` 存储层 + `server/app.js` 四端点：上传/列表/下载+meta/删除）。
- **页面** ✅（`/drive` 独立页：上传/列表/下载/删除 + 概览胶囊；描述符 `/drive.json`）。
- **测试** ✅（`tests/drive.test.js` 16 用例）。
- **设备端** 无需新动作——通过既有 fetch 命令通道取文件（设备端固件在另一台电脑，见 `docs/fetch-channel/01-device.md`）。
- **待做**：首个真实用例（上传 vanim 预置 JSON → 下发 fetch 装进 `/fs/vanim/`）；`/files/` 目录退役评估。
