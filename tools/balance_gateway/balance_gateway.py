#!/usr/bin/env python3
"""余额网关：把不同厂商的"余额/额度"统一成 DeepSeek 的 /user/balance 形状。

为什么要它
----------
设备上的 DeepSeek 页只认一个契约（components/deepseek/deepseek.cpp）：

    GET <base>/user/balance           Authorization: Bearer <key>
    {"is_available": true,
     "balance_infos": [{"currency": "CNY",
                        "total_balance": "2.84",
                        "granted_balance": "0.00",
                        "topped_up_balance": "2.84"}]}

DeepSeek 自己提供这个接口；小米 MiMo **没有**任何用 API Key 可查的余额接口
（/user/balance、/v1/usage、dashboard/billing 全是 404，控制台接口要小米账号
Cookie）。所以"看小米额度"只能由一台你控制的服务器去拿数据、再翻译成上面的形状。
这就是本文件。

三种模式（--mode 或 config.json 的 "mode"）
------------------------------------------
  mock      返回固定的假数据，用来在不动设备代码的前提下验证链路/UI。
  deepseek  把请求原样转发给 api.deepseek.com（用服务器上的 key），身体已经是
            目标形状 —— 用来确认"经过网关"和"直连"结果一致。
  xiaomi    用控制台 Cookie 读小米的额度（详见下）。

小米控制台接口（从 console 前端 bundle 逆出，并用真实账号验证过，2026-10-25）
--------------------------------------------------------------------------
控制台所有接口都是 `${origin}/api/v1<path>`，且**全站被 SSO 拦在同一面墙后**
（任意路径未登录都返回 401 + account.xiaomi.com 跳转，不能用 401/404 猜路由）。

实测响应（真账号）：

    GET /api/v1/tokenPlan/usage  → {"data":{"usage":{"items":[{"name":"plan_total_token",
                                     "used":247732020,"limit":4100000000,"percent":0.06}]}},
                                     "monthUsage":{...同结构...}}
        ⚠ 没有 "remaining" 字段，要自己算 limit - used。
    GET /api/v1/tokenPlan/detail → 套餐名/到期 currentPeriodEnd/自动续费/expired
    GET /api/v1/balance          → {"data":{"balance":"0.00","frozenBalance":"0.00",
                                     "currency":"CNY","giftBalance":"0.00",...}}
        ⚠ 金额是**字符串**。
    GET /api/v1/usage            → tokenUsage{input/output/cache/total} +
                                     accountRateLimit{tpm,rpm,concurrency} +
                                     costUsage{totalCost,currentMonthCost} + pluginUsage
    GET /api/v1/balanceAlertConfig → config.balance_threshold + enabled
    GET /api/v1/userProfile       → userId / 打码手机邮箱 / idc
    GET /api/v1/projects          → 空间列表（个人账号只有一个）
    GET /api/v1/tokenPlan/list    → 套餐**目录**（价格/权益），不是用户额度，别用。

    ⚠ POST /api/v1/usage/detail/list（按天/按模型的账单）需要前端加的
      `api-platform_ph` 查询参数，直接构造会 400/401；目前**没有**接进网关。
      需要时用浏览器（browser_session.py 的窗口）在页面里调用。

两种"数字"含义不同，用 --xiaomi-kind 选：
    credits（默认）Token Plan 剩余 Credits（= limit - used），显示换算成「亿 CR」
    money          按量余额，人民币元

Cookie 怎么来（见 browser_session.py）
-------------------------------------
会话是 HttpOnly + Edge 的 App-Bound 加密（v20）：JS 读不到、数据库被浏览器独占、
v20 值本地解不了，默认配置目录还禁止开调试端口。所以用**专用配置目录 + 调试端口**
的 Edge 登录一次，由浏览器自己通过 CDP 交出 Cookie：

    python tools/balance_gateway/browser_session.py --launch        # 弹窗，登录一次
    python tools/balance_gateway/browser_session.py --write-config  # 取 Cookie 写配置

过期后在同一个窗口重新登录一次，再跑一次 --write-config 即可。

用法
----
    python tools/balance_gateway/balance_gateway.py                  # 读 config.json
    python tools/balance_gateway/balance_gateway.py --mode mock
    python tools/balance_gateway/balance_gateway.py --mode deepseek --key sk-xxxx
    python tools/balance_gateway/balance_gateway.py --mode xiaomi --xiaomi-kind money

    # 本地联调（不需要小米账号）：--xiaomi-base 指向一个假控制台
    python tools/balance_gateway/balance_gateway.py --mode xiaomi \
        --cookie "session=fake" --xiaomi-base http://127.0.0.1:8090

自检 / 排错
-----------
    GET /health
    GET /user/balance                     （按当前模式）
    GET /user/balance?mode=mock&total=12.34&currency=CNY
    GET /user/balance?mode=fail&code=503  （验证设备的错误态）
    GET /summary                          （一条请求拿全部，给设备页面用）
    GET /debug/xiaomi/probe?url=<console url>
         → 上游状态码 + 所有数字字段的路径（看 schema，不刷屏）
    GET /debug/xiaomi/dump?url=<console url>
         → 原始 JSON 前 4000 字节

/summary 的形状（2026-10-25 真实账号实测，xiaomi 模式与 --mode mock 一致）
    {"ok":true,"provider":"xiaomi","fetched_at":"2026-10-25T19:14:45+0800",
     "plan":   {"code":"lite","name":"Lite","expires":"2026-11-23 23:59:59",
                "expired":false,"auto_renew":true},
     "quota":  {"used":248754948.0,"limit":4100000000.0,"remaining":3851245052.0,
                "percent":6.07,"bucket":"plan_total_token","unit":"credits"},
     "tokens": {"total":34002122,"input":33783873,"output":218249,"cache":29811900},
     "cost":   {"total":"55.00","month":"0.00","currency":"CNY"},
     "limits": {"tpm":3000000,"rpm":1000,"concurrency":100},
     "balance":{"amount":"0.00","frozen":"0.00","gift":"0.00","currency":"CNY"},
     "alert":  {"threshold":10.0,"enabled":true}}
  ok=true 的条件是 quota 拿到了（余额页没这个数字就没意义）；其余字段尽力而为，
  失败进 "errors":{字段名: 上游状态码}，整体仍回 200。quota 也失败才回 502。

上云（7x24）时打开的三层保护
---------------------------
config.json 里加：
    "auth_token": "<随机串>"   设备请求必须带 X-Auth-Token，否则 401（/health 除外）
    "cache_ttl": 60            /summary 缓存秒数；并发请求合并成一次上游
    "upstream_retries": 2      只重试网络错误和 5xx，401 不重试（重试只会招风控）

实测行为（用本地假控制台逐条跑过）：
    X-Cache: miss / hit / shared   缓存命中、并发合并
    X-Cache: stale                 上游挂了但有过成功快照 → 仍返回 200 并带
                                   "stale":true + cached_at，页面灰显而不是白屏；
                                   上游恢复后自动回到 miss
    errors 里的 "network"          状态码 0，表示根本没连上上游

⚠ Cookie 是唯一凭证：SSO 一过期，/summary 只能返回 stale 数据，errors 全是 401。
   云端要有一个能人工登录的浏览器把新 Cookie 交给网关（session_keeper.py）。
   前面必须挂 HTTPS 反代，别把 8088 直接暴露到公网。只有标准库依赖。
"""
import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"

DEFAULT_DEEPSEEK_URL = "https://api.deepseek.com/user/balance"
UPSTREAM_TIMEOUT = 15


def load_config() -> dict:
    cfg = {}
    if CONFIG.is_file():
        try:
            cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001 - a broken config must not be fatal
            print("[gateway] config.json unreadable: %s" % e, file=sys.stderr)
    return cfg


def deepseek_shape(total="0.00", currency="CNY", available=True,
                   granted="0.00", topped=None, extra=None) -> dict:
    """The ONE shape the device understands (amounts are strings on purpose)."""
    body = {
        "is_available": bool(available),
        "balance_infos": [{
            "currency": currency,
            "total_balance": str(total),
            "granted_balance": str(granted),
            "topped_up_balance": str(topped if topped is not None else total),
        }],
    }
    if extra:
        body.update(extra)
    return body


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def http_get(url: str, headers: dict, timeout=UPSTREAM_TIMEOUT):
    """Return (status, body_bytes, content_type). Network errors raise OSError."""
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "")


def pick_number(obj, paths):
    """First numeric value found at any dotted path (e.g. "data.balance")."""
    for path in paths:
        cur = obj
        ok = True
        for part in path.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
                cur = cur[int(part)]
            else:
                ok = False
                break
        if ok:
            if isinstance(cur, bool):
                continue
            if isinstance(cur, (int, float)):
                return float(cur)
            if isinstance(cur, str):
                try:
                    return float(cur.strip())
                except ValueError:
                    continue
    return None


def collect_numbers(obj, out, path=""):
    """Every numeric leaf, with its dotted path (schema-agnostic extraction).

    Xiaomi sends money as STRINGS ("0.00"), so numeric strings count as numbers.
    """
    if isinstance(obj, dict):
        for k, v in obj.items():
            collect_numbers(v, out, ("%s.%s" % (path, k)) if path else str(k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            collect_numbers(v, out, "%s[%d]" % (path, i))
    elif isinstance(obj, bool):
        return
    elif isinstance(obj, (int, float)):
        out.append((path, float(obj)))
    elif isinstance(obj, str):
        try:
            out.append((path, float(obj.strip())))
        except ValueError:
            pass


def find_usage(data):
    """(used, limit, name) from a Xiaomi `tokenPlan/usage` payload.

    The payload carries several buckets (plan, compensation, month); the plan
    bucket is the one with the real quota, and "compensation" has limit 0.
    """
    items = []

    def walk(node):
        if isinstance(node, dict):
            if "used" in node and "limit" in node:
                items.append(node)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    pick = None
    for it in items:
        if "plan_total_token" in str(it.get("name", "")):
            pick = it
            break
        if pick is None and float(it.get("limit") or 0) > 0:
            pick = it
    if pick is None:
        return None, None, None
    return (float(pick.get("used") or 0), float(pick.get("limit") or 0),
            str(pick.get("name", "")))


# What "the number" means per product. Order = preference: a remaining counter
# beats a total, otherwise a 38-billion "Total" would be reported as "left".
CREDIT_KEYS = ("remaining", "left", "available", "balance", "credit", "quota",
               "total", "amount")
MONEY_KEYS = ("balance", "total", "amount", "cash", "available")


def pick_by_key(nums, keys):
    for want in keys:
        for path, val in nums:
            if want in path.lower():
                return path, val
    return None, None


class Gateway:
    def __init__(self, cfg: dict):
        self.mode = cfg.get("mode", "mock")
        self.deepseek_key = cfg.get("deepseek_key", "")
        self.deepseek_url = cfg.get("deepseek_url", DEFAULT_DEEPSEEK_URL)
        self.cookie = cfg.get("xiaomi_cookie", "")
        # Console routing, reverse-engineered from the console's own JS bundle
        # (static/main.*.chunk.js): every console API is `${origin}/api/v1<path>`.
        self.xiaomi_base = cfg.get("xiaomi_base", "https://platform.xiaomimimo.com")
        self.xiaomi_kind = cfg.get("xiaomi_kind", "credits")  # credits | money
        self.xiaomi_paths = cfg.get("xiaomi_value_paths", [])  # explicit override
        self.xiaomi_scale = float(cfg.get("xiaomi_scale", 1e8))  # credits -> 亿
        # Ask the endpoint that matches the product first: the money balance
        # endpoint has no credit counters and vice versa.
        if "xiaomi_candidates" not in cfg:
            self.xiaomi_candidates = (
                ["/api/v1/balance", "/api/v1/tokenPlan/list"]
                if self.xiaomi_kind == "money"
                else ["/api/v1/tokenPlan/list", "/api/v1/tokenPlan/usage",
                      "/api/v1/balance"])
        self.mock = cfg.get("mock", {"total": "12.34", "currency": "CNY",
                                     "available": True})
        # --- resilience knobs (matter once this runs 7x24 on a cloud box) ---
        self.cache_ttl = float(cfg.get("cache_ttl", 60))   # seconds, /summary only
        self.auth_token = str(cfg.get("auth_token", ""))   # empty = no auth
        self.retries = int(cfg.get("upstream_retries", 2))
        self._cache = {}        # key -> {"at": ts, "status": int, "body": dict}
        self._inflight = {}     # key -> Event (single-flight)
        self._lock = threading.Lock()
        self.last_ok_at = None
        # A login is a human event; the gateway must pick the new cookie up
        # WITHOUT a restart, otherwise "renew" means "restart a container".
        self.cookie_file = Path(cfg.get("cookie_file") or (HERE / "session.json"))
        self._cookie_mtime = 0.0
        self.cookie_at = ""
        self._load_cookie_file()

    def _load_cookie_file(self):
        """Adopt session.json when it changes (cheap stat, no restart)."""
        try:
            mtime = self.cookie_file.stat().st_mtime
        except OSError:
            return
        if mtime == self._cookie_mtime:
            return
        try:
            data = json.loads(self.cookie_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        cookie = (data or {}).get("cookie") or ""
        if cookie and cookie != self.cookie:
            self.cookie = cookie
            self.cookie_at = (data or {}).get("at", "")
        self._cookie_mtime = mtime

    # ---------------- modes ----------------
    def mock_body(self, q: dict) -> dict:
        return deepseek_shape(
            total=q.get("total", self.mock.get("total", "12.34")),
            currency=q.get("currency", self.mock.get("currency", "CNY")),
            available=q.get("available", "1") not in ("0", "false", "no"),
        )

    def deepseek_body(self):
        if not self.deepseek_key:
            return 503, {"error": "deepseek_key missing in config.json"}, ""
        status, body, ctype = http_get(
            self.deepseek_url,
            {"Authorization": "Bearer " + self.deepseek_key,
             "Accept": "application/json"})
        return status, body, ctype

    def _console_get(self, path: str):
        """One console GET with the stored cookie. Returns (status, bytes).

        Retries only what is worth retrying: transport errors and 5xx. A 401
        means the SSO session is gone — hammering it just risks the account.
        Status 0 means "never reached the server"; callers surface it as
        "network".
        """
        url = self.xiaomi_base + path
        headers = {
            "Cookie": self.cookie,
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (balance-gateway)",
            "Referer": self.xiaomi_base + "/",
        }
        last = (0, b"", "")
        for attempt in range(self.retries + 1):
            try:
                status, body, ctype = http_get(url, headers)
            except OSError as e:                   # DNS / timeout / reset
                last = (0, ("%s" % e).encode("utf-8", "replace"), "")
                if attempt < self.retries:
                    time.sleep(0.4 * (attempt + 1))
                    continue
                return last
            last = (status, body, ctype)
            if status < 500:
                return last
            if attempt < self.retries:
                time.sleep(0.4 * (attempt + 1))
        return last

    def _extract(self, data):
        """Pull the interesting number out of an unknown console payload."""
        if self.xiaomi_paths:                      # explicit config wins
            value = pick_number(data, self.xiaomi_paths)
            return (self.xiaomi_paths[0], value) if value is not None else (None, None)
        nums = []
        collect_numbers(data, nums)
        keys = MONEY_KEYS if self.xiaomi_kind == "money" else CREDIT_KEYS
        return pick_by_key(nums, keys)

    def _mapped(self, value: float, source: str, field: str):
        """Turn the raw console number into the DeepSeek contract."""
        if self.xiaomi_kind == "money":
            shown, currency, unit = "%.2f" % value, "CNY", "CNY"
        else:
            # Credits are not money: show them in 亿 (100M) so the 2" panel is
            # readable, and say so in the extra field.
            shown, currency, unit = "%.2f" % (value / self.xiaomi_scale), "CR", "亿 credits"
        return deepseek_shape(
            total=shown, currency=currency, topped=shown,
            extra={"xiaomi": {"source": source, "field": field, "raw": value,
                              "unit": unit}})

    def xiaomi_body(self):
        self._load_cookie_file()
        if not self.cookie:
            return 503, {"error": "xiaomi_cookie missing: paste the console "
                                  "Cookie after logging in at "
                                  "platform.xiaomimimo.com (DevTools -> "
                                  "Network -> any /api/v1 request -> Cookie)"}, ""
        # Verified against a real account (2026-10-25):
        #   /api/v1/tokenPlan/usage -> data.usage.items[] {name, used, limit}
        #                              (plan_total_token = the real quota)
        #   /api/v1/balance         -> data.balance as a STRING ("0.00")
        #   /api/v1/tokenPlan/list  -> the plan CATALOG, not the user's quota
        order = (["/api/v1/balance", "/api/v1/tokenPlan/usage"]
                 if self.xiaomi_kind == "money"
                 else ["/api/v1/tokenPlan/usage", "/api/v1/balance"])
        tried = []
        for path in order:
            status, body, _ = self._console_get(path)
            tried.append({"path": path, "status": status})
            if status != 200:
                continue
            try:
                data = json.loads(body or b"{}")
            except ValueError:
                tried[-1]["error"] = "not JSON"
                continue

            if self.xiaomi_kind == "credits":
                used, limit, bucket = find_usage(data)
                if limit:
                    remaining = max(0.0, limit - used)
                    shown = "%.2f" % (remaining / self.xiaomi_scale)
                    return 200, deepseek_shape(
                        total=shown, currency="CR", topped=shown,
                        extra={"xiaomi": {
                            "source": path, "bucket": bucket,
                            "used": used, "limit": limit, "remaining": remaining,
                            "percent": round(used / limit * 100.0, 2),
                            "unit": "亿 credits"}}), ""

            field, value = self._extract(data)
            if value is not None:
                return 200, self._mapped(value, path, field), ""
            tried[-1]["error"] = "no numeric field matched"
            nums = []
            collect_numbers(data, nums)
            tried[-1]["numbers"] = [p for p, _ in nums[:12]]

        return 502, {"error": "no usable console endpoint", "tried": tried,
                     "hint": "run /debug/xiaomi/dump?url=/api/v1/tokenPlan/usage "
                             "to see the raw payload"}, ""

    def _get_json(self, path):
        status, body, _ = self._console_get(path)
        if status != 200:
            return status, None
        try:
            return 200, json.loads(body or b"{}")
        except ValueError:
            return 200, None

    def mock_summary(self):
        """Canned summary so a UI can be built without an account."""
        return {
            "ok": True, "provider": "mock", "fetched_at": _now(),
            "plan": {"code": "lite", "name": "Lite",
                     "expires": "2026-11-23 23:59:59",
                     "expired": False, "auto_renew": True},
            "quota": {"used": 247732020, "limit": 4100000000,
                      "remaining": 3852267980, "percent": 6.04,
                      "bucket": "plan_total_token", "unit": "credits"},
            "tokens": {"total": 34002122, "input": 33783873, "output": 218249,
                       "cache": 29811900},
            "cost": {"total": "55.00", "month": "0.00", "currency": "CNY"},
            "limits": {"tpm": 3000000, "rpm": 1000, "concurrency": 100},
            "balance": {"amount": "0.00", "frozen": "0.00", "gift": "0.00",
                        "currency": "CNY"},
            "alert": {"threshold": 10.0, "enabled": True},
        }

    def summary(self):
        """One request for everything the console knows (device-friendly).

        Five upstream GETs (~1 s total). "ok" is true when the QUOTA bucket came
        back, because that is the number a balance page cannot work without;
        the rest are best-effort and their failures land in "errors".
        """
        out = {"ok": False, "provider": "xiaomi", "fetched_at": _now()}
        errors = {}
        self._load_cookie_file()

        st, d = self._get_json("/api/v1/tokenPlan/detail")
        p = (d or {}).get("data") or {}
        if st == 200 and d and d.get("code") == 0 and p:
            out["plan"] = {"code": p.get("planCode"), "name": p.get("planName"),
                           "expires": p.get("currentPeriodEnd"),
                           "expired": bool(p.get("expired")),
                           "auto_renew": bool(p.get("hasAutoRenewSubscribed"))}
        else:
            errors["plan"] = st or "network"

        st, d = self._get_json("/api/v1/tokenPlan/usage")
        if st == 200 and d and d.get("code") == 0:
            used, limit, bucket = find_usage(d)
            if limit:
                out["quota"] = {"used": used, "limit": limit,
                                "remaining": max(0.0, limit - used),
                                "percent": round(used / limit * 100.0, 2),
                                "bucket": bucket, "unit": "credits"}
            else:
                errors["quota"] = "no quota bucket"
        else:
            errors["quota"] = st or "network"

        st, d = self._get_json("/api/v1/usage")
        u = (d or {}).get("data") or {}
        if st == 200 and u:
            t = u.get("tokenUsage") or {}
            c = u.get("costUsage") or {}
            r = u.get("accountRateLimit") or {}
            out["tokens"] = {"total": t.get("totalToken"),
                             "input": t.get("inputToken"),
                             "output": t.get("outputToken"),
                             "cache": t.get("cacheToken")}
            out["cost"] = {"total": c.get("totalCost"),
                           "month": c.get("currentMonthCost"), "currency": "CNY"}
            out["limits"] = {"tpm": r.get("tpm"), "rpm": r.get("rpm"),
                             "concurrency": r.get("concurrency")}
        else:
            errors["usage"] = st or "network"

        st, d = self._get_json("/api/v1/balance")
        b = (d or {}).get("data") or {}
        if st == 200 and b:
            out["balance"] = {"amount": b.get("balance"),
                              "frozen": b.get("frozenBalance"),
                              "gift": b.get("giftBalance"),
                              "currency": b.get("currency")}
        else:
            errors["balance"] = st or "network"

        st, d = self._get_json("/api/v1/balanceAlertConfig")
        a = (d or {}).get("data") or {}
        if st == 200 and a:
            out["alert"] = {
                "threshold": (a.get("config") or {}).get("balance_threshold"),
                "enabled": bool(a.get("enabled"))}
        else:
            errors["alert"] = st or "network"

        out["ok"] = "quota" in out
        if errors:
            out["errors"] = errors
        return (200 if out["ok"] else 502), out

    def summary_cached(self):
        """`summary()` behind a TTL cache, single-flight and a stale fallback.

        Returns (status, body, how) where how is hit|miss|shared|stale.

        Why each layer exists:
          hit     the device polls every few seconds; 5 upstream GETs per poll
                  would look like a scraper to Xiaomi and costs ~1 s each time.
          shared  N devices asking at once must produce ONE upstream round, not N.
          stale   a dead cookie should not blank the screen: serve the last good
                  snapshot with "stale": true so the UI can grey it out.
        """
        key = "summary"
        now = time.time()
        with self._lock:
            ent = self._cache.get(key)
            if ent and now - ent["at"] < self.cache_ttl:
                return ent["status"], ent["body"], "hit"
            ev = self._inflight.get(key)
            owner = ev is None
            if owner:
                ev = threading.Event()
                self._inflight[key] = ev

        if not owner:                       # someone else is fetching: wait for it
            ev.wait(timeout=UPSTREAM_TIMEOUT * (self.retries + 1))
            with self._lock:
                ent = self._cache.get(key)
            if ent:
                return ent["status"], ent["body"], "shared"
            return 504, {"ok": False, "error": "upstream busy"}, "shared"

        try:
            status, body = self.summary()
        except Exception as e:              # noqa: BLE001 - never 500 a page
            status, body = 502, {"ok": False, "error": "internal: %s" % e}

        with self._lock:
            if status == 200:
                self._cache[key] = {"at": time.time(), "status": status, "body": body}
                self.last_ok_at = _now()
            stale = self._cache.get(key)
            self._inflight.pop(key, None)
        ev.set()

        if status != 200 and stale:
            out = dict(stale["body"])
            out["stale"] = True
            out["cached_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z",
                                             time.localtime(stale["at"]))
            out["error"] = (body or {}).get("error", "upstream failed")
            out["errors"] = (body or {}).get("errors", {})
            return 200, out, "stale"
        return status, body, "miss"

    def probe(self, url: str, raw=False):
        """Fetch a console URL with the stored cookie (discovery aid)."""
        if not self.cookie:
            return 503, {"error": "xiaomi_cookie missing"}
        if not url.startswith(self.xiaomi_base):
            return 400, {"error": "only URLs under %s are probed" % self.xiaomi_base}
        status, body, ctype = http_get(url, {
            "Cookie": self.cookie,
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (balance-gateway)",
            "Referer": self.xiaomi_base + "/",
        })
        text = body.decode("utf-8", "replace")
        if raw:
            return 200, {"upstream_status": status, "content_type": ctype,
                         "body": text[:4000]}
        # Summary: status + the shape (numeric paths) so the schema is visible
        # without dumping a huge JSON into a 2" screen or a chat window.
        nums = []
        try:
            collect_numbers(json.loads(body or b"{}"), nums)
        except ValueError:
            pass
        return 200, {"upstream_status": status, "content_type": ctype,
                     "numbers": [{"path": p, "value": v} for p, v in nums[:20]],
                     "body_head": text[:300]}

    # ---------------- dispatch ----------------
    def handle_balance(self, q: dict):
        mode = q.get("mode", self.mode)
        if mode == "fail":
            try:
                code = int(q.get("code", "503"))
            except ValueError:
                code = 503
            return code, {"error": "forced failure for testing"}, ""
        if mode == "deepseek":
            return self.deepseek_body()
        if mode == "xiaomi":
            return self.xiaomi_body()
        return 200, self.mock_body(q), ""


def make_handler(gw: Gateway):
    class Handler(BaseHTTPRequestHandler):
        server_version = "BalanceGateway/0.1"
        _status = 0

        def _send(self, code, body, ctype="application/json; charset=utf-8",
                  extra=None):
            if not isinstance(body, (bytes, bytearray)):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self._status = code
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, max-age=0")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass        # the device gave up (screen rotated, wifi dropped)

        def do_GET(self):  # noqa: N802 - http.server API
            parsed = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            started = time.time()

            # One shared token keeps a cloud deployment from being a public
            # window into your account. /health stays open for liveness probes.
            if gw.auth_token and parsed.path != "/health":
                got = self.headers.get("X-Auth-Token") or q.get("token", "")
                if got != gw.auth_token:
                    self._send(401, {"error": "missing or wrong X-Auth-Token"})
                    return

            if parsed.path == "/health":
                gw._load_cookie_file()      # report the cookie actually in use
                self._send(200, {"ok": True, "mode": gw.mode,
                                 "has_deepseek_key": bool(gw.deepseek_key),
                                 "has_xiaomi_cookie": bool(gw.cookie),
                                 "cookie_at": gw.cookie_at,
                                 "has_auth_token": bool(gw.auth_token),
                                 "cache_ttl": gw.cache_ttl,
                                 "last_ok_at": gw.last_ok_at})
            elif parsed.path == "/user/balance":
                status, body, ctype = gw.handle_balance(q)
                self._send(status, body, ctype or "application/json; charset=utf-8")
            elif parsed.path == "/summary":
                if gw.mode == "mock":
                    self._send(200, gw.mock_summary())
                else:
                    status, body, how = gw.summary_cached()
                    self._send(status, body, extra={"X-Cache": how})
            elif parsed.path == "/debug/xiaomi/probe":
                status, body = gw.probe(q.get("url", ""))
                self._send(status, body)
            elif parsed.path == "/debug/xiaomi/dump":
                status, body = gw.probe(q.get("url", gw.xiaomi_base
                                              + "/api/v1/tokenPlan/list"), raw=True)
                self._send(status, body)
            else:
                self._send(404, {"error": "not found",
                                 "try": ["/health", "/user/balance", "/summary",
                                         "/debug/xiaomi/probe?url=...",
                                         "/debug/xiaomi/dump?url=..."]})

            print("[gateway] %s %s -> %d (%d ms)" % (
                self.command, self.path, self._status,
                int((time.time() - started) * 1000)), file=sys.stderr)

        def log_message(self, fmt, *args):
            # Suppress the default per-request line; we print our own above.
            pass

    return Handler


def main():
    cfg = load_config()
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["mock", "deepseek", "xiaomi"],
                    default=cfg.get("mode", "mock"))
    ap.add_argument("--key", default=cfg.get("deepseek_key", ""),
                    help="DeepSeek API key (deepseek mode)")
    ap.add_argument("--cookie", default=cfg.get("xiaomi_cookie", ""),
                    help="Xiaomi console Cookie (xiaomi mode)")
    ap.add_argument("--xiaomi-base", default=cfg.get("xiaomi_base",
                                                     "https://platform.xiaomimimo.com"),
                    help="console origin (point it at a local fake for tests)")
    ap.add_argument("--xiaomi-kind", choices=["credits", "money"],
                    default=cfg.get("xiaomi_kind", "credits"),
                    help="what the extracted number means")
    ap.add_argument("--host", default=cfg.get("listen_host", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(cfg.get("listen_port", 8088)))
    ap.add_argument("--auth-token", default=cfg.get("auth_token", ""),
                    help="require X-Auth-Token on every endpoint but /health "
                         "(set this before exposing the gateway)")
    ap.add_argument("--cache-ttl", type=float, default=float(cfg.get("cache_ttl", 60)),
                    help="seconds to reuse a /summary result (default 60)")
    ap.add_argument("--summary", action="store_true",
                    help="print /summary once and exit (no server)")
    args = ap.parse_args()

    cfg.update({"mode": args.mode, "deepseek_key": args.key,
                "xiaomi_cookie": args.cookie,
                "xiaomi_base": args.xiaomi_base,
                "xiaomi_kind": args.xiaomi_kind,
                "auth_token": args.auth_token, "cache_ttl": args.cache_ttl})
    gw = Gateway(cfg)

    if args.summary:
        status, body = ((200, gw.mock_summary()) if gw.mode == "mock"
                        else gw.summary())
        print(json.dumps(body, ensure_ascii=False, indent=2))
        return 0 if status == 200 else 1

    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(gw))
    print("[gateway] mode=%s listen=http://%s:%d" % (gw.mode, args.host, args.port))
    if args.mode == "xiaomi" and not gw.cookie:
        print("[gateway] ! xiaomi mode needs --cookie; /user/balance answers 503 "
              "until it is set", file=sys.stderr)
    print("[gateway] console = %s (candidates: %s)"
          % (gw.xiaomi_base, ", ".join(gw.xiaomi_candidates)))
    print("[gateway] device URL would be: http://<this-PC-LAN-IP>:%d/user/balance"
          % args.port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[gateway] bye")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
