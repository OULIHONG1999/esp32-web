# font-cloud-server

本地字体云端服务原型 —— 对应《字体云端服务架构方案》腿 A（云端最小实现）。

**仅供本机验证，不部署上线。**

## 快速开始

```powershell
# 依赖（已建好 .venv 可跳过）
& $env:MIMO_PYTHON -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 启动
.\.venv\Scripts\python.exe server.py --port 8787
```

浏览器打开 <http://127.0.0.1:8787/> 即为测试台（请求、统计、历史日志）。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/meta` | 协议版本与能力 |
| GET | `/api/fonts` | 字体库列表 |
| GET/POST | `/api/subset` | 按字符子集化，返回 `font/ttf` |
| GET | `/api/stats` | 聚合统计 |
| GET | `/api/stats/history` | 最近请求日志 |
| POST | `/api/stats/reset` | 清空统计（测试用） |
| GET | `/health` | 存活探测 |

### /subset 参数

```json
{ "font": "misans-regular", "chars": "天青色等烟雨", "include_latin": false }
```

- `chars`：整段文本，服务端去重后一次子集化（对应方案「按段批量拉」）
- 不接受 `px`：字号属设备端渲染维度（方案 §4）
- 响应头：`X-Cache-Hit` / `X-Subset-Bytes` / `X-Subset-Ms` / `X-Subset-Chars` / `X-Subset-Missing` / `X-Cache-Key`
- 服务端缓存键 = `font + sorted(unique chars)`，与字符顺序无关

## 目录

```
server.py        HTTP API + fontTools 子集化 + 统计
fonts/           字体库（MiSans / Ubuntu；*.ttf 不进 git，见 fonts/README.md）
cache/           子集缓存（自动生成，不进 git）
data/stats.json  统计持久化（不进 git）
public/          测试页（index.html / styles.css / app.js）
public/docs/     挂载文档：architecture.md / protocol.md（AI 可抓取）
tests/verify.py  自验证脚本
```

## 文档挂载（给 AI / Agent）

**规范工具指针：`/font-cloud`**（分享地址时保留该路径；不要用泛化的 `/tool`）。

| 路径 | 作用 |
|------|------|
| `GET /font-cloud` | **工具卡**（本工具是谁、怎么测、去哪读） |
| `GET /font-cloud.json` | **机器可读工具描述**（tool_id / 端点 / 调用约定） |
| `GET /llms.txt` | Agent 总入口 |
| `GET /llms-full.txt` | 协议 + 架构合并全文，单次抓取学完 |
| `GET /docs/architecture.md` | 字体云端架构方案（设计原文 + 实现差异点） |
| `GET /docs/protocol.md` | API 契约与设备端调用流程 |
| `GET /api/meta` | 能力协商 JSON（`docs.canonical_path`） |
| `GET /robots.txt` | 爬虫入口，指向 `/llms.txt` |

## 部署到已有的 esp32-web 服务器（共存）

```powershell
powershell -File font-cloud-server/deploy/deploy.ps1
```

- 落地：`/opt/font-cloud-server`，systemd `font-cloud-server`，端口 **8788**
- nginx 在 `firmware-server.conf` 插入分流，**不抢** firmware 的 `/llms.txt`、`/api/registry` 等
- 对外入口：`/font-cloud`（工具指针）· `/font-bench/`（测试台）· `/api/subset`
- 详见 `docs/SERVER.md` §5.5

## 自验证

```powershell
# 另开一个终端已启动服务的情况下：
.\.venv\Scripts\python.exe tests\verify.py --port 8787

# 或由脚本自行拉起服务：
.\.venv\Scripts\python.exe tests\verify.py --port 8787 --spawn
```

## 与架构方案的对应关系

| 方案 | 本原型 |
|------|--------|
| 子集化在云端（fontTools） | `build_subset()` + fontTools |
| 固定文本预置 | 不在本服务范围（构建期 `pyftsubset`） |
| 动态文本按段拉字 | `chars` 整段去重一次请求 |
| 不带 px | 接口刻意不接受 px |
| 服务端可缓存子集结果 | `cache/<font>/<key>.ttf` |
| 协议克制 | JSON 仅用于控制面，子集二进制直出 |

> 实现时采纳了评估结论：`/subset` 支持 POST（避免 GET URL 长度限制），缓存键按去重字集而非文件名编码。
