#!/usr/bin/env python3
"""从专用 Edge 实例（带调试端口）里取出小米控制台会话 Cookie，写进网关配置。

为什么这样取
------------
控制台的会话是 HttpOnly + Edge 新版 App-Bound 加密（v20）：
  - 页面里的 document.cookie 看不到；
  - Cookie 数据库在浏览器运行时被独占，且 v20 值无法用 DPAPI 直接解；
  - 默认配置目录又禁止开调试端口（Chromium 136+ 的安全策略）。
所以用一个**专用配置目录**启动 Edge（不是默认目录，允许调试端口），登录一次后
由浏览器自己通过 CDP 把 Cookie 交出来（含 HttpOnly）。

第一次使用
----------
    # 1) 启动专用浏览器（会弹出窗口，登录 platform.xiaomimimo.com）
    python tools/balance_gateway/browser_session.py --launch
    # 2) 在那个窗口里登录一次（同一账号），然后：
    python tools/balance_gateway/browser_session.py --write-session

--write-session 写的是 session.json，网关会**热加载**（不重启）。
--write-config 是旧方式（写 config.json），保留兼容。

以后 Cookie 过期
----------------
    重新在同一个窗口登录一次，再跑一次 --write-session 即可（浏览器配置会保留）。
    云上不想手打命令就用 session_keeper.py --watch，它会自己发现并交接。

跨平台
------
Windows 用系统自带的 Edge；Linux（含 noVNC 容器）自动找 google-chrome /
chromium，也可以用 MIMO_BROWSER 指定路径。加了 --no-sandbox，因为容器里
通常以 root 跑 Chrome。

依赖：websocket-client（Anaconda 自带；否则 pip install websocket-client）
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

try:
    import websocket  # websocket-client
except ImportError:  # pragma: no cover
    print("需要 websocket-client：pip install websocket-client", file=sys.stderr)
    raise SystemExit(1)

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
SESSION = HERE / "session.json"
TARGET = "https://platform.xiaomimimo.com/console/plan-manage"

# Windows 用系统自带的 Edge；Linux 云主机通常只有 Chrome/Chromium。
# MIMO_BROWSER 可以覆盖（noVNC 容器里路径可能不同）。
BROWSER_CANDIDATES = [
    os.environ.get("MIMO_BROWSER", ""),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
]


def profile_dir() -> Path:
    if sys.platform.startswith("win"):
        return Path.home() / "AppData/Local/mimo-balance-profile"
    return Path.home() / ".local/share/mimo-balance-profile"


def find_browser() -> str:
    for c in BROWSER_CANDIDATES:
        if c and Path(c).exists():
            return c
    return "msedge" if sys.platform.startswith("win") else "google-chrome"


def cdp_up(port: int) -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/json/version" % port,
                                    timeout=2) as r:
            r.read(64)
            return True
    except Exception:  # noqa: BLE001
        return False


def launch(port: int):
    profile_dir().mkdir(parents=True, exist_ok=True)
    subprocess.Popen([find_browser(),
                      "--remote-debugging-port=%d" % port,
                      "--user-data-dir=%s" % profile_dir(),
                      "--no-first-run", "--no-default-browser-check",
                      # Containers/cloud boxes usually run as root, where Chrome
                      # refuses to start without this. It is a throwaway profile.
                      "--no-sandbox", "--disable-dev-shm-usage",
                      TARGET])
    for _ in range(20):
        time.sleep(1)
        if cdp_up(port):
            return True
    return False


def rpc(ws, msg_id, method, params=None):
    ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == msg_id:
            return msg.get("result", {})


def find_page(port: int):
    """The console tab, or None. Needs a live CDP port."""
    with urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=3) as r:
        targets = json.loads(r.read())
    return next((t for t in targets
                 if t.get("type") == "page" and "xiaomimimo" in (t.get("url") or "")),
                None)


def grab_cookie(port: int):
    """(href, cookies) from the logged-in console tab. ([], None) if absent.

    HttpOnly cookies only ever leave the browser through CDP, which is the
    whole reason this dance exists. Shared by the CLI and session_keeper.
    """
    page = find_page(port)
    if page is None:
        return None, []
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=10)
    try:
        rpc(ws, 1, "Network.enable")
        href = rpc(ws, 2, "Runtime.evaluate",
                   {"expression": "location.href", "returnByValue": True})
        cookies = rpc(ws, 3, "Network.getCookies",
                      {"urls": ["https://platform.xiaomimimo.com/"]}).get("cookies", [])
    finally:
        ws.close()
    return href.get("result", {}).get("value"), cookies


def cookie_header(cookies) -> str:
    return "; ".join("%s=%s" % (c["name"], c["value"]) for c in cookies)


def write_session(cookies, path=SESSION) -> Path:
    """Persist the credential for the gateway (it hot-reloads this file)."""
    payload = {"cookie": cookie_header(cookies),
               "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
               "names": [c["name"] for c in cookies]}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                    encoding="utf-8")
    try:
        os.chmod(path, 0o600)       # it is a live account credential
    except OSError:
        pass
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9223)
    ap.add_argument("--launch", action="store_true", help="启动专用浏览器（首次）")
    ap.add_argument("--write-session", action="store_true",
                    help="把 Cookie 写进 session.json（网关热加载，不用重启）")
    ap.add_argument("--write-config", action="store_true",
                    help="把 Cookie 写进同目录 config.json（旧方式，已 gitignore）")
    args = ap.parse_args()

    if args.launch:
        ok = launch(args.port)
        print("launched=%s browser=%s profile=%s"
              % (ok, find_browser(), profile_dir()))
        if not ok:
            return 1
        print("请在弹出的窗口里登录 platform.xiaomimimo.com，然后重跑本脚本 "
              "（不带 --launch）。")
        return 0

    if not cdp_up(args.port):
        print("调试端口没开：先跑 --launch（或那个窗口已被关掉）", file=sys.stderr)
        return 1

    href, cookies = grab_cookie(args.port)
    print("page:", href)
    if not cookies:
        print("没有 Cookie：那个窗口还没登录成功（或当前不是控制台页面）",
              file=sys.stderr)
        return 2
    header = cookie_header(cookies)
    print("cookies:", [(c["name"], len(c["value"])) for c in cookies])

    if args.write_config:
        cfg = {}
        if CONFIG.is_file():
            try:
                cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                cfg = {}
        cfg.setdefault("mode", "xiaomi")
        cfg["xiaomi_cookie"] = header
        CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        print("wrote", CONFIG, "(%d chars)" % len(header))

    if args.write_session:
        print("wrote", write_session(cookies), "(%d chars)" % len(header))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
