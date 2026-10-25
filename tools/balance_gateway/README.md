# 小米 MiMo 余额网关（balance_gateway）

> 交付版本：2026-10-25
> 依赖：Python 3.8+，**仅标准库**；只有 `browser_session.py` / `session_keeper.py`
> 需要额外装 `websocket-client`。
> 目标读者：接手继续开发的人 / 智能体。读完应该能独立跑起来、改得动、知道哪些地方不能碰。

---

## 0. 这个包是什么 / 不是什么

**是**：一台你能控制的机器上的小 HTTP 服务，把「小米 MiMo 控制台的额度数据」翻译成
「DeepSeek `/user/balance` 的形状」，外加一个自建的 `/summary` 聚合接口。这样设备
（ESP32）和任何前端都能用同一个契约展示余额。

**不是**：官方 API 客户端。小米没有提供任何能用 API Key 查余额的接口，本包是**逆向
控制台前端接口 + 复用浏览器登录态**实现的。小米改版就会断，这是前提，不是 bug。

**不包含**：`config.json`、`session.json`（里面有真实 Cookie / token），已被
`.gitignore` 排除。拿到包后需要自己生成，见 §3。

---

## 1. 背景：为什么需要它

设备上原本有一个 DeepSeek 余额页，契约固定为：

```
GET <base>/user/balance           Authorization: Bearer <key>
{"is_available": true,
 "balance_infos": [{"currency": "CNY",
                    "total_balance": "2.84",
                    "granted_balance": "0.00",
                    "topped_up_balance": "2.84"}]}
```

DeepSeek 官方提供这个接口，所以直连即可。小米 MiMo 的情况：

| 尝试 | 结果 |
|---|---|
| `GET /user/balance`（带 API Key） | 404 |
| `GET /v1/usage` / `dashboard/billing` | 404 |
| `GET /v1/models` | 401（说明路由存在，只是要账号态） |
| 控制台 `/api/v1/*` | 有效，但被 SSO 拦住，要浏览器 Cookie |

结论：**官方没有给 API Key 查余额的路**。要统一展示，只能由服务器代取、代翻译。

---

## 2. 架构

```
┌──────────────┐   GET /summary           ┌─────────────────────────┐
│ ESP32 / 网页  │ ───────────────────────► │  balance_gateway.py     │
└──────────────┘   X-Auth-Token            │  :8088                  │
                                           │  ├ 60s TTL 缓存          │
                                           │  ├ 单飞（并发合并）       │
                                           │  ├ 失败回上次快照(stale)  │
                                           │  └ 上游重试(仅 5xx/网络)  │
                                           └───────────┬─────────────┘
                                                       │ 5 × GET /api/v1/*
                                                       │ Cookie（热加载）
                                           ┌───────────▼─────────────┐
                                           │ session.json            │
                                           └───────────▲─────────────┘
                                                       │ 写入（失效时自动交接）
                                           ┌───────────┴─────────────┐
                                           │ session_keeper.py       │
                                           │  ├ 每 300s 探活          │
                                           │  ├ 401 → 从 CDP 抓 Cookie│
                                           │  └ 抓不到 → webhook 告警  │
                                           └───────────▲─────────────┘
                                                       │ CDP :9223
                                           ┌───────────┴─────────────┐
                                           │ Chrome/Edge（有人登录过） │
                                           │ 云上通过 noVNC 给人看     │
                                           └─────────────────────────┘
```

三条关键设计：

1. **网关永不登录**。它只读 `session.json`，登录是人的事。
2. **人只登录一次**。剩下的探活、交接、告警全自动。
3. **上游挂了页面不能白**。有过成功数据就返回它，标 `stale: true`。

---

## 3. 快速开始

### 3.1 Windows 本机（开发/调试）

```powershell
cd <项目根>\tools\balance_gateway

# 1) 起一个专用浏览器的窗口（不是你的默认 Edge），登录小米控制台
python browser_session.py --launch

# 2) 登录完成后，把 Cookie 交出来（写 session.json，网关热加载）
python browser_session.py --write-session

# 3) 探活
python session_keeper.py            # 期望：session: OK (status=200, ...)

# 4) 起网关
python balance_gateway.py --port 8088

# 5) 验证（有 auth_token 时带请求头）
curl http://127.0.0.1:8088/summary -H "X-Auth-Token: <token>"
```

想先看 UI 效果、不碰真账号：

```powershell
python balance_gateway.py --mode mock --port 8088
# 或只打印一次
python balance_gateway.py --mode mock --summary
python balance_gateway.py --summary          # 读 config.json 打真实数据
```

### 3.2 Linux 服务器（7×24）

```bash
# 先把代码放到 /opt/mimo（目录里要有 tools/balance_gateway）
sudo APP=/opt/mimo python3 /opt/mimo/tools/balance_gateway/cloud/setup_debian.py
```

脚本会：装依赖 → 建 `mimo` 用户 → 生成 noVNC 密码和随机 `auth_token` →
洗掉文件换行 → 装三个 systemd 单元并启动。

然后：

```
1) 浏览器打开 http://<服务器IP>:6080/vnc.html（用户名 mimo + 脚本打印的密码）
2) 在里面登录 platform.xiaomimimo.com
3) cd /opt/mimo/tools/balance_gateway && python3 session_keeper.py --once
4) 设备 GET http://<IP>:8088/summary，带 X-Auth-Token
5) 云安全组只放行 8088 / 6080，5900 和 9223 不要开
```

> ⚠ `setup_debian.py` 的 systemd 部分**没有在真实 Linux 上验证过**（开发机是
> Windows）。第一次部署请逐个 `systemctl status mimo-console mimo-gateway
> mimo-keeper` 确认；起不来就看 `journalctl -u <单元名> -n 50`。

---

## 4. HTTP 接口

除 `/health` 外，配置了 `auth_token` 后都必须带 `X-Auth-Token: <token>`
（也接受 `?token=`，方便浏览器手测）。错误 token → `401`。

### 4.1 `GET /summary`（设备主接口，推荐）

一条请求返回全部字段。`X-Cache` 头告诉你这次是怎么来的。

```json
{
  "ok": true,
  "provider": "xiaomi",
  "fetched_at": "2026-10-25T19:14:45+0800",
  "plan": {"code": "lite", "name": "Lite",
           "expires": "2026-11-23 23:59:59",
           "expired": false, "auto_renew": true},
  "quota": {"used": 248754948.0, "limit": 4100000000.0,
            "remaining": 3851245052.0, "percent": 6.07,
            "bucket": "plan_total_token", "unit": "credits"},
  "tokens": {"total": 34002122, "input": 33783873,
             "output": 218249, "cache": 29811900},
  "cost": {"total": "55.00", "month": "0.00", "currency": "CNY"},
  "limits": {"tpm": 3000000, "rpm": 1000, "concurrency": 100},
  "balance": {"amount": "0.00", "frozen": "0.00", "gift": "0.00", "currency": "CNY"},
  "alert": {"threshold": 10.0, "enabled": true}
}
```

字段语义：

| 字段 | 含义 | 备注 |
|---|---|---|
| `quota.used/limit/remaining` | Token Plan 的 Credits | 上游**不返回** `remaining`，网关自己算 |
| `quota.percent` | 已用百分比，2 位小数 | `used / limit * 100` |
| `quota.unit` | 固定 `"credits"` | 1 亿 CR 是展示单位，不是字段单位 |
| `tokens.*` | 累计 token 用量 | 来自 `/api/v1/usage` |
| `cost.total/month` | 累计 / 本月费用 | **字符串**，和 DeepSeek 契约保持一致 |
| `limits.*` | 账号速率上限 | tpm / rpm / 并发 |
| `balance.*` | 按量余额 | 走 Token Plan 时通常是 0.00 |
| `alert.threshold` | 余额预警阈值 | 元 |

`ok` 的判定：**只看 `quota` 是否拿到**。理由：余额页没有这个数字就没有意义。
其余字段失败不阻塞，但会进 `errors`：

```json
{"ok": true, "errors": {"alert": 500}, ...}
```

`errors` 的值是上游状态码；`"network"` 表示根本没连上（状态码 0）。

HTTP 状态码：

| 状态 | 原因 |
|---|---|
| 200 | `ok: true`，或返回了 stale 快照 |
| 502 | quota 没拿到，且没有历史快照 |
| 504 | 并发超时（单飞等待超时），罕见 |
| 401 | 鉴权失败 |

### 4.2 `X-Cache` 语义（重要）

| 值 | 含义 | 客户端该怎么做 |
|---|---|---|
| `miss` | 这次真的打了上游 | 正常渲染 |
| `hit` | 命中 TTL 缓存（默认 60 s） | 正常渲染 |
| `shared` | 并发了，等别人的结果 | 正常渲染 |
| `stale` | 上游失败，返回的是上次成功快照 | 渲染 + 灰显/提示"数据为 xx 时间的" |

`stale` 的 body 里额外带：

```json
{"stale": true, "cached_at": "2026-10-25T19:20:03+0800",
 "error": "upstream failed", "errors": {"plan": 401, "quota": 401, ...}}
```

### 4.3 `GET /user/balance`（兼容 DeepSeek 契约）

给现有的 DeepSeek 页用，形状见 §1。行为随 `mode`：

| 模式 | 行为 |
|---|---|
| `mock` | 返回假数据；支持 `?total=12.34&currency=CNY&available=0` |
| `deepseek` | 原样转发 `api.deepseek.com/user/balance` |
| `xiaomi` | 用控制台数据拼出同样的形状 |

调试用的强制失败：`GET /user/balance?mode=fail&code=503`。

小米模式下额外字段（不影响老客户端，多余字段会被忽略）：

```json
{"xiaomi": {"source": "/api/v1/tokenPlan/usage", "bucket": "plan_total_token",
            "used": 248754948, "limit": 4100000000,
            "remaining": 3851245052, "percent": 6.07, "unit": "亿 credits"}}
```

> Credits 不是钱。`total_balance` 里放的是「剩余 Credits ÷ 1e8」，`currency` 是
> `"CR"`，单位写在 `xiaomi.unit` 里，避免被误读成人民币。

### 4.4 `GET /health`（不需要鉴权）

给存活探针用：

```json
{"ok": true, "mode": "xiaomi",
 "has_deepseek_key": false, "has_xiaomi_cookie": true,
 "cookie_at": "2026-10-25T20:01:02+0800",
 "has_auth_token": true, "cache_ttl": 60.0,
 "last_ok_at": "2026-10-25T20:05:11+0800"}
```

`cookie_at` 空字符串 = 用的是 `config.json` 里的旧式字段；有时间戳 = 已热加载
`session.json`。`last_ok_at` 为 `null` 表示启动后还没成功过一次。

### 4.5 调试端点（生产环境建议关掉/不暴露）

| 端点 | 用途 |
|---|---|
| `GET /debug/xiaomi/probe?url=/api/v1/...` | 返回上游状态码 + 所有数字字段的路径（看 schema，不刷屏） |
| `GET /debug/xiaomi/dump?url=/api/v1/...` | 返回原始 JSON 前 4000 字节 |

`url` 必须以 `xiaomi_base` 开头，防止被当成 SSRF 跳板。

---

## 5. 配置项（`config.json`，与脚本同目录）

```json
{
  "mode": "xiaomi",
  "xiaomi_kind": "credits",
  "listen_host": "0.0.0.0",
  "listen_port": 8088,
  "auth_token": "<随机串，设备必须带>",
  "cache_ttl": 60,
  "upstream_retries": 2,
  "keeper_webhook": "",
  "keeper_interval": 300,
  "cdp_port": 9223
}
```

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `mock` | `mock` / `deepseek` / `xiaomi` |
| `xiaomi_kind` | `credits` | `credits`（Token Plan）/ `money`（按量余额） |
| `listen_host` | `0.0.0.0` | 有反代时改 `127.0.0.1` |
| `listen_port` | `8088` | |
| `auth_token` | `""` | 空 = 不鉴权。**公网必须设置** |
| `cache_ttl` | `60` | `/summary` 缓存秒数 |
| `upstream_retries` | `2` | 网络错误/5xx 重试次数，401 不重试 |
| `keeper_webhook` | `""` | 失效告警地址。含 `feishu`/`larksuite` 时用飞书格式 |
| `keeper_interval` | `300` | keeper 探活间隔 |
| `cdp_port` | `9223` | 浏览器调试端口 |

其它可选（一般不用改）：`xiaomi_base`（控制台 origin）、`xiaomi_scale`（默认 1e8）、
`xiaomi_value_paths`（强制指定取值路径）、`cookie_file`（默认同目录 `session.json`）、
`deepseek_key` / `deepseek_url`。

命令行参数会覆盖配置文件同名项：`--mode --key --cookie --xiaomi-base
--xiaomi-kind --host --port --auth-token --cache-ttl --summary`。

---

## 6. 小米控制台接口（2026-10-25 真账号实测）

所有接口都是 `${origin}/api/v1<path>`，`origin = https://platform.xiaomimimo.com`。
**全站被 SSO 拦在同一面墙后**：未登录时任意路径都 401 并跳
`account.xiaomi.com`，所以**不能靠 401/404 猜路由**。

| 接口 | 内容 | 实测要点 |
|---|---|---|
| `GET /tokenPlan/detail` | 套餐名 / 到期 / 自动续费 | `planCode: lite`，`currentPeriodEnd: 2026-11-23 23:59:59`，`hasAutoRenewSubscribed: true` |
| `GET /tokenPlan/usage` | 已用 / 总量 / 百分比 | `data.usage.items[] = {name, used, limit, percent}`；真实桶名 `plan_total_token`，used 2.48e8 / limit 4.1e9。**没有 remaining** |
| `GET /usage` | token 明细 + 速率 + 费用 | `tokenUsage{totalToken,inputToken,outputToken,cacheToken}`、`accountRateLimit{tpm,rpm,concurrency}`、`costUsage{totalCost,currentMonthCost}`、`pluginUsage` |
| `GET /balance` | 按量余额 | `data.balance` 是**字符串** `"0.00"`，另有 `frozenBalance`/`giftBalance`/`currency` |
| `GET /balanceAlertConfig` | 余额预警 | `data.config.balance_threshold = 10.0`，`data.enabled = true` |
| `GET /userProfile` | 账号 | userId / 打码手机邮箱 / idc（个人隐私，别落库） |
| `GET /projects` | 空间列表 | 个人账号只有一个「我的空间」 |
| `GET /tokenPlan/list` | 套餐**目录** | ⚠ 这是商品目录（价格/权益），不是你的额度。**不要拿它当余额** |
| `POST /usage/detail/list` | 按天 / 按模型账单 | ⚠ **未打通**：需要前端注入的 `api-platform_ph` 查询参数，直接构造会 400/401 |

响应外层统一是 `{"code": 0, "data": {...}}`，`code != 0` 视为业务失败。

### 取值策略

`tokenPlan/usage` 里可能有多个桶（plan / 补偿 / 当月），只有 `plan_total_token`
是真正的额度。`find_usage()` 的规则：

1. 递归找所有同时含 `used` 和 `limit` 的对象；
2. 优先取 `name` 含 `plan_total_token` 的；
3. 否则退而取第一个 `limit > 0` 的（补偿桶 limit 是 0，会被跳过）。

这是启发式的，能扛字段改名，扛不住路径变化。如果小米把桶换了名字，改这里。

---

## 7. Cookie 是怎么拿到的（关键机制，别改成别的写法）

会话 Cookie（`serviceToken` 等）是 **HttpOnly**，且有 Edge 的 **App-Bound 加密（v20）**：

| 尝试 | 结果 |
|---|---|
| 页面里 `document.cookie` | 看不到 HttpOnly |
| 直接读 Edge 的 Cookie 数据库 | 浏览器运行时被独占（PermissionError）；关掉浏览器能读，但值是 v20 |
| DPAPI + AES-GCM 本地解密 v20 | **解不了**（密钥绑定浏览器安装路径） |
| 用默认配置目录开 `--remote-debugging-port` | 被忽略（Chromium 136+ 安全策略） |
| 把默认目录做成 junction 指向 | 端口能开，但 ABE 绑路径 → 打开即登录页 |
| 复制默认目录 | 端口能开，Cookie 不解密 → 登录页 |
| **专用 profile + 调试端口 + CDP `Network.getCookies`** | ✅ **唯一可行** |

所以流程固定为：

```
专用配置目录启动浏览器 → 人登录一次 → CDP 把含 HttpOnly 的 Cookie 交出来
```

`browser_cookie.py` 是最早尝试本地解密的那版，**已确认不可用，仅作记录**，
不要基于它继续做。

专用 profile 位置：

- Windows：`%LOCALAPPDATA%\mimo-balance-profile`
- Linux：`~/.local/share/mimo-balance-profile`

复用同一个 profile 意味着「登录一次，之后只在过期时再登一次」。

---

## 8. 代码结构

```
tools/balance_gateway/
├── balance_gateway.py      网关本体（HTTP 服务 + 上游调用 + 缓存/兜底）
├── browser_session.py      启动专用浏览器 / 通过 CDP 取 Cookie / 写 session.json
├── session_keeper.py       常驻探活 + 自动交接 + 告警
├── browser_cookie.py       ⚠ 失败的本地解密尝试，勿用
├── README.md               本文档
└── cloud/
    ├── setup_debian.py     一键安装（Linux，无 Docker）
    ├── start_console.sh    Xvfb + x11vnc + noVNC + Chrome 启动脚本
    ├── mimo-console.service
    ├── mimo-gateway.service
    └── mimo-keeper.service
```

职责边界：

- `balance_gateway.py`：只做「读 Cookie → 拼请求 → 翻译成契约 → 缓存」。**不负责登录**。
- `browser_session.py`：只做「浏览器 + CDP」。可单独当 CLI 用。
- `session_keeper.py`：只做「判断死活 + 交接 + 通知」。不解析业务字段。

三者共享的只有 `session.json` 一个文件，耦合很低，可以单独替换。

### 关键实现点

**单飞（single-flight）**：`summary_cached()` 用 `_inflight[key] = threading.Event()`。
第一个线程持锁登记自己是 owner，其余线程 `wait()`；owner 完成后 `pop + set()`，
等待者醒来读缓存。效果：5 个并发请求 → 1 次 `miss` + 4 次 `shared`。

**stale 兜底**：失败时不清缓存，只把上次成功的 body `dict()` 浅拷贝出来加
`stale/cached_at/error/errors`。缓存对象本身不被污染。

**热加载**：`_load_cookie_file()` 每次请求前 `stat` 一次 mtime，变了才解析 JSON。
成本是一次 stat，比定时线程简单可靠。

**重试**：`_console_get()` 只重试 `OSError` 和 `5xx`，退避 0.4s/0.8s。
**401/403 立即返回**——反复敲 SSO 会招风控。

---

## 9. 已验证 / 未验证

### 已验证（本机，2026-10-25）

| 项 | 方法 | 结果 |
|---|---|---|
| `/summary` 真实数据 | 真账号 | 与下表一致 |
| 语法 | `py_compile` 全部文件 | 通过 |
| mock 模式 | `--mode mock --summary` | 字段齐全 |
| 鉴权 | 无 token 请求 | 401 |
| `/health` 免鉴权 | 无 token | 200 |
| 缓存 | 连续两次 | `miss` → `hit` |
| TTL 过期 | 等 4s（ttl=3） | 回到 `miss` |
| 单飞 | 5 线程并发 | `1 miss + 4 shared`，上游只打 5 次（非 25） |
| stale（401） | 假控制台改返回 401 | 200 + `stale:true`，配额仍在 |
| stale（500） | 假控制台改返回 500 | 重试后 stale |
| 自动恢复 | 假控制台改回 200 | 回 `miss`，无 `stale` 字段 |
| 热加载 | 中途写 `session.json` | `/health.cookie_at` 立即变新 |
| keeper 探活 | 真账号 | `session: OK (status=200, ...)` |

真账号实测值（用于回归对照）：

```
plan   Lite / 到期 2026-11-23 23:59:59 / 自动续费开
quota  248,754,948 / 4,100,000,000（6.07%），剩余 3,851,245,052
tokens 总 34,002,122（in 33.78M / out 0.22M / cache 29.8M）
cost   累计 ¥55.00，本月 ¥0.00
limits tpm 3,000,000 / rpm 1,000 / 并发 100
balance 0.00 CNY
alert  阈值 10.0，开启
```

另：相隔十几秒两次请求，`used` 从 247,732,020 涨到 248,754,948（+102 万 CR），
说明这是**实时**值，不是缓存快照。

### 未验证 / 未完成

1. **systemd 单元没在真实 Linux 上跑过**。逻辑、路径、依赖按 Debian/Ubuntu 写，
   但 `start_console.sh` 里 Chrome 在 Xvfb 下的行为、noVNC 的 Basic 认证、三个单元的
   启动顺序都需要实机确认。
2. **`POST /usage/detail/list` 未打通**（按天/按模型账单）。需要浏览器内注入
   `api-platform_ph`，或从前端 bundle 里逆出它怎么算的。目前 `/summary` 不含细分。
3. **Webhook 只做了两种格式**（飞书 / 通用 `{"text": ...}`）。Slack 的字段名也是
   `text`，通用格式可用；企业微信需要改成 `{"msgtype":"text","text":{"content":...}}`。
4. **没有自动化测试**。上面的验证都是一次性脚本（已删），没有沉淀成 pytest。

---

## 10. 踩过的坑（省下重复排查的时间）

1. **`find_usage()` 必须优先挑 `plan_total_token`**。一开始取第一个 `limit > 0`
   的桶，结果拿到过补偿桶（limit 0）或错误桶。
2. **不要用 `tokenPlan/list` 当余额**。它是商品目录，里面 41 亿是「套餐总量」，
   不是你的额度。曾因此展示错误数字。
3. **金额是字符串**。`"balance": "0.00"`，直接当数字用会 `TypeError`。
   `collect_numbers()` 里特意把 numeric string 也算成数字。
4. **`remaining` 要自己算**。`tokenPlan/usage` 不返回这个字段。
5. **`deepseek_shape()` 返回 dict，但 handler 期望三元组**。`mock_body()` 曾因此
   让 `/user/balance` 返回空，补一个 `""` 作为 ctype。
6. **§7 那张表里的 6 种取 Cookie 方案全部失败过**，最后靠专用 profile + CDP。
   不要再试本地解密。
7. **`cmd /c mklink` 在某些受限环境会被拦**，用 `New-Item -ItemType Junction`。
8. **CRLF**：仓库 `core.autocrlf=true`，`.sh`/`.service` 检出是 CRLF，Linux 上第一行
   就 `$'\r': command not found`。父仓库 `.gitignore` 里有 `**/.gitattributes`，
   加不了换行规则，所以安装入口用 `.py`，由它 `replace("\r\n","\n")` 后
   `newline="\n"` 落地。
9. **重试 401 是反模式**。SSO 会对反复失败的会话更激进地失效，只重试 5xx/网络。
10. **`wfile.write()` 要捕获 `BrokenPipeError`**。设备熄屏/切 WiFi 时会断连，
    不接会刷一堆无意义的异常栈。
11. **`s_running` 类的状态判断**（同项目音频模块的教训）：不要用「当前任务变量」
    判断「是否正在播放/正在请求」，那个变量往往已经被清空，判断恒假。

---

## 11. 云部署细节（Linux 无 Docker，只有公网 IP）

### 组件与端口

| 组件 | 端口 | 绑定 | 对外 |
|---|---|---|---|
| 网关 | 8088 | `0.0.0.0` | ✅ 设备访问 |
| noVNC | 6080 | `0.0.0.0` | ✅ 人登录用（Basic 认证） |
| x11vnc | 5900 | `127.0.0.1` | ❌ |
| Chrome CDP | 9223 | `127.0.0.1` | ❌ |
| Xvfb | — | 虚拟屏 `:99` | ❌ |

安全组/防火墙只开 **8088、6080**。

### 三个 systemd 单元

- `mimo-console.service`：跑 `start_console.sh`（Xvfb → x11vnc → websockify → Chrome），
  `KillMode=control-group`，Chrome 挂了整组重启。
- `mimo-gateway.service`：跑网关，`Restart=always`。
- `mimo-keeper.service`：跑 `session_keeper.py --watch`，依赖 console。

### 只有 IP 的现实

设备只能 `http://<IP>:8088/summary`，**token 明文传输**。当前缓解手段：
随机长 token + 仅暴露必要端口。真正的解法是域名 + HTTPS（Let's Encrypt），
或 Cloudflare Tunnel。这件事没做，属于已知缺口。

### 日常运维

```bash
journalctl -u mimo-gateway -f          # 网关日志（每请求一行，含耗时）
journalctl -u mimo-keeper -f           # 探活/交接/告警日志
systemctl restart mimo-console         # 浏览器卡死时
python3 session_keeper.py --once       # 手动确认会话状态
curl -s localhost:8088/health | python3 -m json.tool
```

---

## 12. 设备端对接（下一步开发）

设备上要做的是一个独立 app（不改现有 DeepSeek 页）。约定：

1. `GET http://<IP>:8088/summary`，头 `X-Auth-Token: <token>`。
2. 解析 §4.1 的 JSON。建议展示：`quota.percent`（进度条）、
   `quota.remaining / 1e8`（亿 CR）、`plan.expires`、`cost.month`。
3. 看到 `"stale": true` 就把数据灰显并标上 `cached_at`，不要让用户以为是最新的。
4. 轮询间隔 **≥ 60 s**（等于 `cache_ttl`），更密只是打缓存，没有收益。
5. 网络错误不要清屏，保留上次数据 + 重试提示。
6. 401 说明 token 配错，不是网络问题——提示语要区分。

如果要加 `/summary` 之外的东西（比如按天账单），先解决 §9 第 2 条。

---

## 13. 安全与风险

| 风险 | 现状 | 建议 |
|---|---|---|
| Cookie 是个人账号凭证 | 存 `session.json`，chmod 600，专用 `mimo` 用户 | 不要进 git（已 ignore）；不要贴到聊天/日志 |
| 明文 HTTP | 只有 IP，无法上证书 | 尽快搞域名 + HTTPS 或 Tunnel |
| 无鉴权时裸奔 | `auth_token` 为空则不校验 | 公网部署必须设置 |
| 逆向接口随时失效 | 小米改版就断 | 定期跑 `session_keeper.py --once`；字段变了看 `errors` |
| 非官方接口 | 理论上有 ToS 风险 | 自用、低频率（缓存 60s 已降频） |

**不要做**：把这个网关包装成对外的公共 API 服务；不要多账号轮询；不要把
Cookie 写进镜像/仓库/日志。

---

## 14. 给下一位开发者的任务清单

按优先级：

1. **在真实 Linux 上跑通 `setup_debian.py`**，修掉 systemd / Xvfb / Chrome 的实际问题
   （这是唯一没验证的大块）。
2. **给网关补 pytest**：把 §9 的验证固化成测试，尤其是单飞和 stale 两条路径
   （可用本地假控制台，参考被删掉的一次性脚本思路）。
3. **打通 `usage/detail/list`**：得到按天/按模型的数据，扩展 `/summary`。
   需要先弄清 `api-platform_ph` 怎么生成（在控制台 bundle 里找）。
4. **域名 + HTTPS**，替换掉 IP 明文方案。
5. **设备端独立 app**（§12），ESP32 + LVGL，读 `/summary`。
6. 可选：`/metrics`（Prometheus 格式），把 `last_ok_at`、上游耗时、缓存命中率暴露出来。

**改代码的边界**：

- 小米接口路径集中在 `summary()` / `xiaomi_body()` 里，改版时只动这两处。
- 契约形状集中在 `deepseek_shape()`，改它对所有客户端都有影响。
- 不要为了「好看」把 `stale`、`X-Cache`、`errors` 去掉，那是这套东西能上云的理由。
