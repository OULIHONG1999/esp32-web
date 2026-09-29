# 发布指南 — 固件发布操作手册（PUBLISH）

> 面向发布操作者（远端 Windows build 机）· 2026-09-29
> 服务地址：`https://firmware.example.com`（HTTP 只读通道：`http://firmware.example.com`）
> 设计细节见 `/docs/FIRMWARE-REGISTRY.md`，服务器部署见 `/docs/DEPLOY.md`

## 0. 三分钟上手

```powershell
# 1. 工程根放 publish.config.json（见 §1）
# 2. 设置 token（与服务器 FIRMWARE_PUBLISH_TOKEN 一致）
$env:FIRMWARE_PUBLISH_TOKEN = "<服务器上的token>"

# 3. 发布一次（读 build/flash_args → 查缺 → 上传）
node tools\publish\index.js once --config publish.config.json
```

成功标志：`[publish] ✓ 已发布 <project>/<variant>/<release-id>`。
随后打开 `https://firmware.example.com`，项目库刷新即可见新版本。

## 1. publish.config.json（工程根，进 git）

```jsonc
{
  "server": "https://firmware.example.com",
  "token": "${FIRMWARE_PUBLISH_TOKEN}",   // 环境变量引用，不落明文
  "project": {
    "id": "hello-world",                  // 唯一项目 id（小写+数字+中划线）
    "name": "Hello World",
    "description": "..."
  },
  "buildDir": "build",                    // 可选；默认 <config目录>/build
  "assets": [                             // 可选：编译产物之外的任意烧录文件
    { "label": "font", "file": "assets/fonts.hdr", "address": "0x290000",
      "type": "data", "subType": "littlefs" }   // 可选：显式声明分区类型
  ]
}
```

- **token**：服务器 `/etc/firmware-server.env` 里的 `FIRMWARE_PUBLISH_TOKEN` 值
- **地址权威**：段地址/烧录参数来自 `build/flash_args`（idf.py 产出），config 不用写
- **分区类型**：发布端自动解析 `partition-table.bin` 按地址匹配（app/factory、data/littlefs 等）；assets 可用 `type/subType` 显式声明

## 2. 命令一览

| 命令 | 用途 |
|---|---|
| `publish once` | 单次发布（查缺增量：服务器已有同 SHA 文件不重传） |
| `publish --watch` | 盯 build 目录自动发布（防抖 5s、失败退避重试 3 次）⚠️ 当前后台网络问题见 PROGRESS 问题 20，暂用手动 once |
| `publish promote <release-id> --note "说明"` | 把 snapshot 晋升为发布版（note 必填，永不自动删） |
| `--config <path>` | 指定配置文件（默认 ./publish.config.json） |
| `--build-dir <path>` | 覆盖 build 目录 |
| `--server <url>` | 覆盖服务地址 |
| `--release-id <id>` | 指定版本 id（默认 时间戳-commit短哈希） |

通用参数：`--help`

**没有 CLI 也能发布**：CLI 源码可在本站下载（见 §7），或直接用裸 HTTP 发布（见 §2.1）。

### 2.1 裸 HTTP 发布（curl / 任意语言，无 CLI 依赖）

`POST /api/publish`，`multipart/form-data`，两个字段：
- `meta`：JSON 字符串（元数据，见下）
- `file`：可重复多个（本次上传的固件段；服务器已有同 SHA 的段可不传）

`meta` 完整样例（`parts` 必须列**全部**段——缺的靠服务器已有的补，新增的随请求上传）：

```json
{
  "project": { "id": "hello-world", "name": "Hello World", "description": "" },
  "variant": "ESP32-S3",
  "release": {
    "id": "20260930-1000-abcd",
    "type": "snapshot",
    "chipFamily": "ESP32-S3",
    "flashParams": { "mode": "dio", "freq": "80m", "size": "2MB" },
    "note": "",
    "createdAt": "2026-09-30T10:00:00.000Z",
    "parts": [
      { "label": "bootloader", "address": 0,       "file": "bootloader.bin",      "sha256": "<64位小写hex>", "size": 21120 },
      { "label": "app",         "address": 65536,  "file": "hello_world.bin",     "sha256": "<64位小写hex>", "size": 150720, "type": "app", "subType": "factory" }
    ]
  }
}
```

curl 示例：

```bash
curl -X POST http://firmware.example.com/api/publish \
  -H "Authorization: Bearer ${FIRMWARE_PUBLISH_TOKEN}" \
  -F 'meta={"project":{"id":"hello-world","name":"Hello World"},"variant":"ESP32-S3","release":{"id":"20260930-1000-abcd","type":"snapshot","chipFamily":"ESP32-S3","flashParams":{"mode":"dio","freq":"80m","size":"2MB"},"note":"","createdAt":"2026-09-30T10:00:00.000Z","parts":[{"label":"app","address":65536,"file":"hello_world.bin","sha256":"…","size":150720}]}}' \
  -F "file=@hello_world.bin"
```

- 每个上传文件的 SHA256 必须与 meta.parts 声明一致，否则 400
- 段地址/烧录参数的权威来源是构建机的 `build/flash_args`
- 成功返回 `{ ok, project, variant, release, retentionRemoved }`

## 3. 发布了什么（数据模型速记）

```
Project → Variant（按芯片自动归类，如 ESP32-S3）→ Release（不可变快照）
Release {
  id, type: snapshot|release, chipFamily,
  flashParams: { mode, freq, size },       // 烧录参数随快照固化
  parts: [ { label, address, file, sha256, size, type?, subType? } ]
}
```

- 每次 `once` = 一个新 snapshot（时间戳+git hash 命名）
- 快照受保留策略管理（默认留 30 个，服务器端下次发布时自动清理）
- 晋升后的 release **永不自动删**

## 4. 页面端操作（版本管理）

打开站点 → 连接设备 → 项目库选中项目 → **版本时间线**：

- **载入**：下载该版本全部段进烧录表格（烧录参数同步注入）
- **晋升**：snapshot → ★发布版（必填说明；首次需输入 token）
- **回滚到此**：把 latest 指向任意历史版本（纯指针，文件不动）
- **保留快照**：设置自动清理策略（先预览将删清单，下次发布生效）

## 5. 常见问题

| 现象 | 原因/处理 |
|---|---|
| `401 unauthorized` | token 不对：检查环境变量与服务器 `/etc/firmware-server.env` 一致 |
| `flash_args not found` | 还没编译过：先 `idf.py build`，或 `--build-dir` 指对路径 |
| 上传=0（服务器已有，秒回） | 正常：内容未变（增量按 SHA 复用，含跨 release） |
| 中文 JSON 报 `Unexpected token` | Windows PowerShell 写配置带了 BOM/双重编码——用编辑器存 UTF-8（无 BOM） |
| 页面看不到新版本 | 项目库点「刷新」；或看横幅（SSE 推送） |

## 6. CLI 源码下载（跨网设备免仓库克隆）

CLI 零依赖（仅 Node 内置模块），4 个文件放下即用：

```
http://firmware.example.com/tools/publish/index.js
http://firmware.example.com/tools/publish/once.js
http://firmware.example.com/tools/publish/lib.js
http://firmware.example.com/tools/publish/watch.js
```

```bash
mkdir -p tools/publish && cd tools/publish
for f in index once lib watch; do curl -O http://firmware.example.com/tools/publish/$f.js; done
cd ../.. && node tools/publish/index.js once --config publish.config.json
```

## 7. 相关文档（本站点均可直接读取）

- 本文件：`/docs/PUBLISH.md`
- API 速查（AI 友好）：`/llms.txt`
- 部署运维：`/docs/DEPLOY.md`
- 设计与数据模型：`/docs/FIRMWARE-REGISTRY.md`
- 验收清单：`/docs/REQUIREMENTS.md`
- CLI 源码：`/tools/publish/*.js`（见 §6）
