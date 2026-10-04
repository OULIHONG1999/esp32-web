# Font Cloud · API 协议（本站已实现）

> 面向调用方（设备端客户端 / AI Agent / curl）。基址默认 `http://127.0.0.1:8787/`。

## 能力协商

### `GET /health`

```json
{ "ok": true, "proto": "1.0.0" }
```

### `GET /api/meta`

返回协议版本、子集能力说明、端点列表、当前字体数与缓存占用。

## 字体库

### `GET /api/fonts`

```json
{
  "fonts": [
    {
      "id": "misans-regular",
      "name": "MiSans-Regular",
      "family": "MiSans",
      "file": "MiSans-Regular.ttf",
      "bytes": 8122324,
      "glyph_count": 10000,
      "units_per_em": 1000
    }
  ]
}
```

### `POST /api/fonts/reload`

重新扫描 `fonts/` 目录。返回同 `/api/fonts`。

## 子集化（核心）

### `POST /api/subset`

请求体（JSON）：

```json
{
  "font": "misans-regular",
  "chars": "天青色等烟雨而我在等你",
  "include_latin": false
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `font` | 是 | `/api/fonts` 返回的 `id` |
| `chars` | 是 | 整段文本；服务端按码点去重（跳过控制字符） |
| `include_latin` | 否 | **默认 `true`**：自动附带可打印 ASCII（字母/数字/标点）。仅当显式 `false`/`0` 才关闭 |

**不接受 `px`**：字号属设备端渲染维度，同一字体多字号共享字形源。

响应：`Content-Type: font/ttf`，body 为子集 TTF 字节。

| 响应头 | 含义 |
|--------|------|
| `X-Font-Id` | 字体 id |
| `X-Subset-Chars` | 去重后请求字数（不含自动附带的 ASCII） |
| `X-Subset-Missing` | 源字体 cmap 中不存在的字数 |
| `X-Subset-Glyphs` | 子集内字形总数（含拉丁/组合） |
| `X-Latin-Included` | `1` 已附带可打印 ASCII / `0` 未附带 |
| `X-Cache-Hit` | `1` 服务端缓存命中 / `0` 实时子集化 |
| `X-Subset-Bytes` | 返回字节数 |
| `X-Subset-Ms` | 服务端处理耗时 |
| `X-Cache-Key` | 缓存键（`sha1(font + sorted(chars))` 前 20 位） |
| `Content-Disposition` | 建议下载文件名 |

### `GET /api/subset?font=&chars=&include_latin=`

与 POST 等价，便于 curl / 浏览器调试。长文本请用 POST（URL 长度有限制）。

### 缓存语义

- 键 = `font_id + sorted(unique_chars)`，**与字符顺序、重复无关**。
- 相同字集重复请求 → `X-Cache-Hit: 1`，字节与首次一致。
- 服务端缓存目录：`cache/<font_id>/<key>.ttf`（重启仍在）。

### 错误

| 状态 | 场景 | body |
|------|------|------|
| 400 | 缺 font/chars，或去重后为空 | `{"error": "..."}` |
| 404 | 未知字体（附 `available` 列表） | `{"error": "...", "available": [...]}` |
| 405 | 方法不允许 | `{"error": "..."}` |
| 500 | 子集化失败 | `{"error": "..."}` |

## 统计

### `GET /api/stats`

聚合：`subset_requests` / `cache_hits` / `cache_hit_rate` / `bytes_out` / `latency_ms{avg,p50,p95,max}` / `subset_bytes` / `per_font` / `cache{entries,bytes}` 等。

### `GET /api/stats/history`

最近请求日志（新→旧）：`ts, font, chars_count, unique_count, cache_hit, bytes, ms, missing, path`。

### `POST /api/stats/reset`

清空计数与历史（不影响已缓存字体文件）。测试用。

## 设备端建议调用流程

```
文本分段
  → 去重（跳过 <0x20）
  → 查本地索引，得缺字集合 S
  → if S 非空: POST /api/subset {font, chars: S}
  → 存 LittleFS + 更新索引
  → lv_tiny_ttf_create_file(path, px)   # 多字号 = 多实例，勿 set_size 轮换
```

整段缺字一次请求（对应方案 §6.6「按段批量拉」）。

## 测试台

`GET /` → 交互式测试页（请求、缺字比对、统计图表、历史日志）。

## 工具指针与文档（供 AI / Agent 抓取）

| 路径 | 内容 |
|------|------|
| **`/font-cloud`** | **本工具的规范指针**（人读工具卡；分享 URL 时保留此路径） |
| **`/font-cloud.json`** | **机器可读工具描述**（tool_id / 端点 / 调用约定） |
| `/llms.txt` | Agent 总入口 |
| `/llms-full.txt` | 协议 + 架构合并全文 |
| `/docs/architecture.md` | 架构方案 |
| `/docs/protocol.md` | 本文件 |
| `/api/meta` | 能力协商（`docs.canonical_path = /font-cloud`） |

推荐抓取顺序：`/font-cloud.json` → `/docs/protocol.md` + `/docs/architecture.md`（或 `/llms-full.txt`）。
