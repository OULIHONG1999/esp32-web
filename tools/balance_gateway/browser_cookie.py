#!/usr/bin/env python3
"""从本机 Edge / Chrome 的 Cookie 库里取出某个域名的 Cookie（Windows）。

⚠ 实测（Edge 156）：小米的 cookie 是 **v20 App-Bound 加密**，本脚本只能解 v10/v11，
   会明确报错。请改用 `browser_session.py`（专用配置目录 + CDP，让浏览器自己解密）。

为什么曾经想这么做
------------------
小米控制台的会话是 HttpOnly Cookie：页面里的 `document.cookie` 看不到它，
只能从浏览器的 Cookie 库里读。Edge/Chrome 在 Windows 上用「DPAPI 保护的
主密钥 + AES-256-GCM」加密每个 cookie，本脚本就是照着这个格式解：

    Local State  -> os_crypt.encrypted_key (base64, 去掉 "DPAPI" 前缀)
                 -> CryptUnprotectData  -> 32 字节主密钥
    Cookies 表   -> encrypted_value = "v10"/"v11" + 12B nonce + 密文 + 16B tag

⚠ 只在本机读写你自己的浏览器数据；输出里含会话凭据，别贴到公开地方。
⚠ 浏览器正在运行也能读：先用 `immutable=1` 只读打开，失败再复制到临时目录。

用法
----
    python tools/balance_gateway/browser_cookie.py --domain xiaomimimo.com
        → 打印可直接用的 Cookie 头
    python tools/balance_gateway/browser_cookie.py --domain xiaomimimo.com --json
        → 打印 [{name, value, host, expires}]（value 已解密）
    python tools/balance_gateway/browser_cookie.py --domain xiaomimimo.com --write-config
        → 写进 tools/balance_gateway/config.json（该文件已 gitignore），供网关直接使用
    --browser edge|chrome|auto（默认 auto，Edge 优先）
"""
import argparse
import base64
import ctypes
import json
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:  # pragma: no cover
    print("需要 cryptography：pip install cryptography", file=sys.stderr)
    raise SystemExit(1)

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"

BROWSERS = {
    "edge": Path.home() / "AppData/Local/Microsoft/Edge/User Data",
    "chrome": Path.home() / "AppData/Local/Google/Chrome/User Data",
}


# --------------------------------------------------------------------------
# DPAPI
# --------------------------------------------------------------------------
class _Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32),
                ("pbData", ctypes.POINTER(ctypes.c_char))]


def dpapi_unprotect(data: bytes) -> bytes:
    buf = ctypes.create_string_buffer(data, len(data))
    src = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    dst = _Blob()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(src), None, None, None, None, 0, ctypes.byref(dst))
    if not ok:
        raise OSError("CryptUnprotectData failed (err %d)" % ctypes.GetLastError())
    try:
        return ctypes.string_at(dst.pbData, dst.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(dst.pbData)


def master_key(user_data: Path) -> bytes:
    state = json.loads((user_data / "Local State").read_text(encoding="utf-8"))
    blob = base64.b64decode(state["os_crypt"]["encrypted_key"])
    if blob[:5] != b"DPAPI":
        raise RuntimeError("unexpected encrypted_key prefix: %r" % blob[:5])
    return dpapi_unprotect(blob[5:])


def decrypt(enc: bytes, key: bytes) -> str:
    if enc[:3] in (b"v10", b"v11"):
        nonce, payload = enc[3:15], enc[15:]
        return AESGCM(key).decrypt(nonce, payload, None).decode("utf-8", "replace")
    if enc[:3] == b"v20":
        raise RuntimeError("v20/App-Bound encryption: 需要新版解密方式")
    return enc.decode("utf-8", "replace")


# --------------------------------------------------------------------------
# Cookie DB
# --------------------------------------------------------------------------
def profiles(user_data: Path):
    """Every profile dir that has a Cookies database."""
    found = []
    for child in sorted(user_data.iterdir() if user_data.is_dir() else []):
        db = child / "Network" / "Cookies"
        if db.is_file():
            found.append(child)
    return found


def read_domain(user_data: Path, domain: str):
    key = master_key(user_data)
    rows = []
    errors = []
    tmpdir = Path(tempfile.mkdtemp(prefix="cookiecopy_"))
    try:
        for prof in profiles(user_data):
            src = prof / "Network" / "Cookies"
            con = None
            try:
                # The live DB is locked by the browser on Windows. `immutable=1`
                # tells SQLite to read it without taking any lock, which works
                # while Edge is running (a plain file copy fails with WinError 32).
                uri = "file:%s?mode=ro&immutable=1" % src.as_posix()
                try:
                    con = sqlite3.connect(uri, uri=True, timeout=3)
                    con.execute("SELECT count(*) FROM cookies").fetchone()
                except sqlite3.Error:
                    if con is not None:
                        con.close()
                    dst = tmpdir / (prof.name + ".sqlite")
                    shutil.copy2(src, dst)
                    con = sqlite3.connect(str(dst))

                cur = con.execute(
                    "SELECT host_key, name, encrypted_value, expires_utc "
                    "FROM cookies WHERE host_key LIKE ?", ("%" + domain + "%",))
                for host, name, enc, exp in cur.fetchall():
                    try:
                        value = decrypt(enc, key)
                    except Exception as e:  # noqa: BLE001
                        errors.append({"host": host, "name": name, "error": str(e)})
                        continue
                    rows.append({"host": host, "name": name, "value": value,
                                 "expires": exp, "profile": prof.name})
            except Exception as e:  # noqa: BLE001
                errors.append({"profile": prof.name, "error": str(e)})
            finally:
                if con is not None:
                    con.close()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return rows, errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="xiaomimimo.com")
    ap.add_argument("--browser", choices=["auto", "edge", "chrome"], default="auto")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--write-config", action="store_true",
                    help="把 Cookie 写进本目录的 config.json（已 gitignore）")
    args = ap.parse_args()

    order = ["edge", "chrome"] if args.browser == "auto" else [args.browser]
    for name in order:
        root = BROWSERS[name]
        if not (root / "Local State").is_file():
            continue
        try:
            rows, errors = read_domain(root, args.domain)
        except Exception as e:  # noqa: BLE001
            print("[%s] failed: %s" % (name, e), file=sys.stderr)
            continue
        if not rows:
            print("[%s] no cookies for %s (errors: %d)" % (name, args.domain, len(errors)),
                  file=sys.stderr)
            continue

        # Cookies for platform.* and the parent domain both count. Keep them in
        # a stable order and drop expired ones.
        now = time.time()
        alive = [r for r in rows if not r["expires"] or
                 (r["expires"] / 1e6 - 11644473600) > now]
        header = "; ".join("%s=%s" % (r["name"], r["value"]) for r in alive)

        if args.json:
            print(json.dumps([{k: r[k] for k in ("host", "name", "value")} for r in alive],
                             ensure_ascii=False, indent=2))
        else:
            print(header)

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
            print("[%s] wrote %s (%d cookies)" % (name, CONFIG, len(alive)), file=sys.stderr)
        return 0

    print("没找到可用 Cookie：先在 Edge 里登录 platform.xiaomimimo.com", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
