#!/usr/bin/env python3
"""云端会话守护：探活 + 自动交接 Cookie + 失效告警。

分工
----
网关只读 session.json，从不登录。本脚本负责让它一直有新鲜凭证：

  1. 每 interval 秒用当前 Cookie 打一次 /api/v1/tokenPlan/detail；
  2. 200            → 什么都不做（安静，不写日志噪音）；
  3. 401/403        → 先试着从已登录的浏览器窗口（CDP）把新 Cookie 抓出来
                      写进 session.json，网关热加载，下一个请求就生效；
  4. 抓不到         → 告警一次（webhook），等你通过 noVNC 登录；
                      登录完下一轮会自己接上，不需要重启任何东西。
  5. 网络错误       → 不当作失效（上游抖动 ≠ Cookie 过期），不告警。

为什么不能全自动
----------------
小米登录要短信/扫码，无头浏览器过不去。所以这里是"半自动"：人只负责登录，
交接、探活、告警全自动。这是这条路线的本质，不是没做完。

用法
----
    python session_keeper.py                      # 探活一次（0=好，2=失效）
    python session_keeper.py --once               # 探活 + 尝试交接一次
    python session_keeper.py --watch --ensure-browser \
        --webhook https://open.feishu.cn/open-apis/bot/v2/hook/xxxx

    --interval 300        探活间隔（秒）
    --cdp-port 9223       浏览器调试端口
    --ensure-browser      CDP 不通时自动拉起浏览器（7x24 建议开）
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import browser_session as bs  # noqa: E402  (same directory)

CONFIG = HERE / "config.json"
SESSION = HERE / "session.json"
BASE = "https://platform.xiaomimimo.com"
PROBE_PATH = "/api/v1/tokenPlan/detail"   # cheapest endpoint that needs auth


def load_cfg() -> dict:
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def current_cookie():
    """(cookie, source). session.json wins: it is the newer artifact."""
    for path, key in ((SESSION, "cookie"), (CONFIG, "xiaomi_cookie")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        cookie = (data or {}).get(key) or ""
        if cookie:
            return cookie, path.name
    return "", ""


def probe(cfg, cookie=None):
    """(ok, status). status is an int, "network" or "no-cookie"."""
    cookie = cookie if cookie is not None else current_cookie()[0]
    if not cookie:
        return False, "no-cookie"
    base = cfg.get("xiaomi_base", BASE)
    req = urllib.request.Request(base + PROBE_PATH, headers={
        "Cookie": cookie,
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (session-keeper)",
        "Referer": base + "/",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status == 200, r.status
    except urllib.error.HTTPError as e:
        return False, e.code
    except OSError:
        return False, "network"


def adopt(port: int) -> bool:
    """Lift fresh cookies out of the logged-in tab into session.json."""
    if not bs.cdp_up(port):
        return False
    try:
        href, cookies = bs.grab_cookie(port)
    except Exception as e:  # noqa: BLE001 - a broken CDP must not kill the loop
        print("[keeper] grab failed: %s" % e, file=sys.stderr)
        return False
    if not cookies:
        return False
    path = bs.write_session(cookies)
    print("[keeper] adopted %d cookies from %s -> %s"
          % (len(cookies), href, path.name), flush=True)
    return True


def notify(url: str, text: str):
    if not url:
        return
    low = url.lower()
    payload = ({"msg_type": "text", "content": {"text": text}}
               if "feishu" in low or "larksuite" in low else {"text": text})
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:  # noqa: BLE001
        print("[keeper] webhook failed: %s" % e, file=sys.stderr)


def watch(cfg, port: int, interval: int, webhook: str, ensure_browser: bool):
    notified = False
    while True:
        ok, status = probe(cfg)
        stamp = time.strftime("%m-%d %H:%M:%S")

        if ok:
            if notified:
                print("[%s] session OK again" % stamp, flush=True)
                notify(webhook, "小米会话已恢复，设备可以继续用")
                notified = False
            time.sleep(interval)
            continue

        if status == "network":
            # Upstream is unreachable — not our problem, and definitely not a
            # reason to bother the user. Keep the last known state.
            print("[%s] upstream unreachable, not a cookie issue" % stamp, flush=True)
            time.sleep(min(interval, 120))
            continue

        print("[%s] session DEAD (status=%s)" % (stamp, status), flush=True)
        if ensure_browser and not bs.cdp_up(port):
            print("[keeper] browser gone, relaunching", flush=True)
            bs.launch(port)

        if adopt(port):
            ok2, st2 = probe(cfg)
            if ok2:
                print("[%s] recovered automatically" % stamp, flush=True)
                notify(webhook, "小米会话已自动续期，设备无需重启")
                notified = False
                time.sleep(interval)
                continue
            print("[keeper] adopted cookie still dead (status=%s)" % st2, flush=True)

        if not notified:
            notify(webhook,
                   "小米 Cookie 已失效，需要人工登录一次：\n"
                   "http://<服务器>:7900/vnc.html （noVNC）\n"
                   "登录后 keeper 会自动把新 Cookie 交接给网关，不用重启。")
            notified = True
        time.sleep(min(interval, 120))


def main():
    cfg = load_cfg()
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="探活 + 尝试交接一次")
    ap.add_argument("--watch", action="store_true", help="常驻监控（生产用）")
    ap.add_argument("--interval", type=int,
                    default=int(cfg.get("keeper_interval", 300)),
                    help="探活间隔（秒）")
    ap.add_argument("--cdp-port", type=int, default=int(cfg.get("cdp_port", 9223)))
    ap.add_argument("--webhook", default=cfg.get("keeper_webhook", ""),
                    help="失效时 POST 告警（飞书/Slack）")
    ap.add_argument("--ensure-browser", action="store_true",
                    help="CDP 不通时自动拉起浏览器（没有 systemd 管浏览器时用）")
    args = ap.parse_args()

    if args.watch:
        watch(cfg, args.cdp_port, args.interval, args.webhook,
              args.ensure_browser)
        return 0

    ok, status = probe(cfg)
    cookie, src = current_cookie()
    print("session: %s (status=%s, cookie from %s, %d chars)"
          % ("OK" if ok else "DEAD", status, src or "-", len(cookie)))
    if ok or not args.once:
        return 0 if ok else 2

    if not adopt(args.cdp_port):
        print("没有可交接的 Cookie：先在浏览器窗口登录一次", file=sys.stderr)
        return 2
    ok, status = probe(cfg)
    print("after adopt: %s (status=%s)" % ("OK" if ok else "DEAD", status))
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
