"""字体云端服务 — 本地原型（对应《字体云端服务架构方案》腿 A）。

API:
  GET  /api/meta            协议/能力
  GET  /api/fonts           字体库列表
  POST /api/subset          {font, chars, include_latin?} → 子集 TTF
  GET  /api/subset?font=&chars=   同上（便于 curl / 书签调试）
  GET  /api/stats           统计
  GET  /api/stats/history   最近请求
  POST /api/stats/reset     清空统计（测试用）
  GET  /health              存活
  GET  /                    测试页
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import threading
import time
from collections import Counter, defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent
FONTS_DIR = ROOT / "fonts"
CACHE_DIR = ROOT / "cache"
DATA_DIR = ROOT / "data"
PUBLIC_DIR = ROOT / "public"
STATS_FILE = DATA_DIR / "stats.json"

PROTO_VERSION = "1.0.0"
HISTORY_MAX = 200
LATENCY_WINDOW = 200

# 可选的基础拉丁（空格/可打印 ASCII），默认不强制
ASCII_BASIC = "".join(chr(c) for c in range(0x20, 0x7F))


class Stats:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.started_at = time.time()
        self.reset(keep_meta=True)

    def reset(self, keep_meta: bool = False) -> None:
        with self.lock:
            if not keep_meta:
                self.started_at = time.time()
            self.requests_total = 0
            self.subset_requests = 0
            self.cache_hits = 0
            self.cache_misses = 0
            self.bytes_out = 0
            self.chars_requested_total = 0
            self.unique_chars_ever: set[str] = set()
            self.latencies_ms: deque[float] = deque(maxlen=LATENCY_WINDOW)
            self.history: deque[dict] = deque(maxlen=HISTORY_MAX)
            self.per_font: dict[str, dict] = defaultdict(
                lambda: {
                    "requests": 0,
                    "cache_hits": 0,
                    "bytes_out": 0,
                    "chars": 0,
                    "subset_sizes": deque(maxlen=50),
                }
            )
            self.subset_sizes: deque[int] = deque(maxlen=100)
            self.errors = 0
            self.error_messages: deque[str] = deque(maxlen=20)

    def snapshot(self) -> dict:
        with self.lock:
            lat = list(self.latencies_ms)
            sizes = list(self.subset_sizes)
            fonts = {}
            for fid, v in self.per_font.items():
                fonts[fid] = {
                    "requests": v["requests"],
                    "cache_hits": v["cache_hits"],
                    "bytes_out": v["bytes_out"],
                    "chars": v["chars"],
                    "avg_subset_bytes": (
                        int(sum(v["subset_sizes"]) / len(v["subset_sizes"]))
                        if v["subset_sizes"]
                        else 0
                    ),
                }
            total = self.subset_requests or 1
            return {
                "started_at": self.started_at,
                "uptime_sec": round(time.time() - self.started_at, 1),
                "requests_total": self.requests_total,
                "subset_requests": self.subset_requests,
                "cache_hits": self.cache_hits,
                "cache_misses": self.cache_misses,
                "cache_hit_rate": round(self.cache_hits / total, 4),
                "bytes_out": self.bytes_out,
                "chars_requested_total": self.chars_requested_total,
                "unique_chars_ever": len(self.unique_chars_ever),
                "errors": self.errors,
                "latency_ms": {
                    "avg": round(sum(lat) / len(lat), 2) if lat else 0,
                    "p50": round(percentile(lat, 50), 2) if lat else 0,
                    "p95": round(percentile(lat, 95), 2) if lat else 0,
                    "max": round(max(lat), 2) if lat else 0,
                    "samples": len(lat),
                },
                "subset_bytes": {
                    "avg": int(sum(sizes) / len(sizes)) if sizes else 0,
                    "max": max(sizes) if sizes else 0,
                    "min": min(sizes) if sizes else 0,
                    "samples": len(sizes),
                },
                "per_font": fonts,
                "cache": cache_info(),
            }

    def history_list(self) -> list[dict]:
        with self.lock:
            return list(self.history)

    def record_request(self) -> None:
        with self.lock:
            self.requests_total += 1

    def record_error(self, msg: str) -> None:
        with self.lock:
            self.errors += 1
            self.error_messages.append(msg[:300])

    def record_subset(
        self,
        *,
        font_id: str,
        chars_count: int,
        unique_chars: str,
        cache_hit: bool,
        out_bytes: int,
        elapsed_ms: float,
        path: str,
        missing_chars: str = "",
    ) -> None:
        with self.lock:
            self.subset_requests += 1
            if cache_hit:
                self.cache_hits += 1
            else:
                self.cache_misses += 1
            self.bytes_out += out_bytes
            self.chars_requested_total += chars_count
            self.unique_chars_ever.update(unique_chars)
            self.latencies_ms.append(elapsed_ms)
            self.subset_sizes.append(out_bytes)
            pf = self.per_font[font_id]
            pf["requests"] += 1
            if cache_hit:
                pf["cache_hits"] += 1
            pf["bytes_out"] += out_bytes
            pf["chars"] += chars_count
            pf["subset_sizes"].append(out_bytes)
            self.history.appendleft(
                {
                    "ts": time.time(),
                    "font": font_id,
                    "chars_count": chars_count,
                    "unique_count": len(unique_chars),
                    "chars_sample": unique_chars[:40],
                    "missing": missing_chars[:40],
                    "cache_hit": cache_hit,
                    "bytes": out_bytes,
                    "ms": round(elapsed_ms, 2),
                    "path": path,
                }
            )

    def persist(self) -> None:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            snap = self.snapshot()
            snap["history"] = self.history_list()[:50]
            STATS_FILE.write_text(
                json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError:
            pass


def percentile(data: list[float], p: float) -> float:
    if not data:
        return 0.0
    s = sorted(data)
    k = (len(s) - 1) * p / 100.0
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def cache_info() -> dict:
    entries = 0
    total = 0
    if CACHE_DIR.exists():
        for f in CACHE_DIR.rglob("*.ttf"):
            entries += 1
            total += f.stat().st_size
    return {"entries": entries, "bytes": total, "dir": str(CACHE_DIR)}


class FontRegistry:
    def __init__(self) -> None:
        self._fonts: dict[str, dict] = {}
        self.reload()

    def reload(self) -> None:
        fonts = {}
        if FONTS_DIR.exists():
            for p in sorted(FONTS_DIR.glob("*")):
                if p.suffix.lower() not in {".ttf", ".otf"}:
                    continue
                meta = inspect_font(p)
                fonts[meta["id"]] = meta
        self._fonts = fonts

    def list(self) -> list[dict]:
        return list(self._fonts.values())

    def get(self, font_id: str) -> dict | None:
        return self._fonts.get(font_id)

    def path_of(self, font_id: str) -> Path | None:
        meta = self._fonts.get(font_id)
        return Path(meta["path"]) if meta else None


def inspect_font(path: Path) -> dict:
    info = {
        "id": path.stem.lower().replace(" ", "-"),
        "name": path.stem,
        "file": path.name,
        "path": str(path),
        "bytes": path.stat().st_size,
        "family": path.stem,
        "glyph_count": 0,
        "units_per_em": 0,
    }
    try:
        tt = TTFont(path, fontNumber=0, lazy=True)
        info["glyph_count"] = tt["maxp"].numGlyphs if "maxp" in tt else 0
        info["units_per_em"] = tt["head"].unitsPerEm if "head" in tt else 0
        if "name" in tt:
            for rec in tt["name"].names:
                if rec.nameID == 1:
                    try:
                        info["family"] = rec.toUnicode()
                        break
                    except Exception:
                        pass
        tt.close()
    except Exception as e:
        info["error"] = str(e)
    return info


REGISTRY = FontRegistry()
STATS = Stats()


def unique_chars(text: str) -> str:
    """按码点去重，保留首次出现顺序；跳过控制字符。"""
    seen: set[str] = set()
    out: list[str] = []
    for ch in text:
        if ch in seen:
            continue
        if ord(ch) < 0x20 or ord(ch) == 0x7F:
            continue
        seen.add(ch)
        out.append(ch)
    return "".join(out)


def cache_key(font_id: str, chars: str) -> str:
    # chars 已是稳定去重序；再按码点排序做 key，避免顺序无关的重复缓存
    payload = font_id + "\0" + "".join(sorted(chars))
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:20]


def build_subset(font_path: Path, chars: str, include_latin: bool, out_path: Path) -> tuple[int, str]:
    """生成子集，返回 (文件大小, 缺字字符串)。"""
    text = chars + (ASCII_BASIC if include_latin else "")
    options = Options()
    options.layout_features = ["*"]
    options.hinting = True
    options.desubroutinize = False
    options.drop_tables = []
    options.notdef_outline = True
    options.recalc_bounds = True
    options.canonical_order = True

    tt = TTFont(str(font_path))
    # 记录源字体 cmap 里没有的字
    cmap = tt.getBestCmap() or {}
    missing = "".join(ch for ch in chars if ord(ch) not in cmap and ch not in cmap)

    subsetter = Subsetter(options=options)
    subsetter.populate(text=text)
    subsetter.subset(tt)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tt.save(str(tmp))
    tt.close()
    tmp.replace(out_path)
    return out_path.stat().st_size, missing


class Handler(BaseHTTPRequestHandler):
    server_version = "FontCloud/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        # 收敛噪音，仅在 DEBUG 时打印
        pass

    # ---------- helpers ----------
    def _json(self, obj, status: int = 200, extra_headers: dict | None = None) -> None:
        body = json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data: bytes, content_type: str, extra_headers: dict | None = None) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _parse_subset_request(self, qs: dict, body: bytes, content_type: str) -> dict:
        font_id = ""
        chars = ""
        include_latin = False
        if content_type.startswith("application/json") or (
            body and not qs.get("chars")
        ):
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
                font_id = str(payload.get("font") or payload.get("font_id") or "")
                chars = str(payload.get("chars") or payload.get("text") or "")
                include_latin = bool(payload.get("include_latin"))
            except json.JSONDecodeError:
                pass
        if not font_id:
            font_id = (qs.get("font") or [""])[0]
        if not chars:
            chars = (qs.get("chars") or qs.get("text") or [""])[0]
        if "include_latin" in qs:
            include_latin = (qs.get("include_latin") or [""])[0] in {
                "1",
                "true",
                "yes",
            }
        return {
            "font": font_id.strip().lower(),
            "chars": chars,
            "include_latin": include_latin,
        }

    def handle_subset(self, qs: dict, body: bytes, content_type: str) -> None:
        STATS.record_request()
        req = self._parse_subset_request(qs, body, content_type)
        font_id = req["font"]
        raw_chars = req["chars"]
        include_latin = req["include_latin"]

        if not font_id or not raw_chars:
            STATS.record_error("subset: missing font/chars")
            self._json({"error": "font and chars are required"}, 400)
            return

        meta = REGISTRY.get(font_id)
        if not meta:
            STATS.record_error(f"subset: unknown font {font_id}")
            self._json({"error": f"unknown font: {font_id}", "available": [f["id"] for f in REGISTRY.list()]}, 404)
            return

        chars = unique_chars(raw_chars)
        if not chars:
            STATS.record_error("subset: empty chars after dedupe")
            self._json({"error": "no valid characters"}, 400)
            return

        key = cache_key(font_id, chars + ("|latin" if include_latin else ""))
        cache_path = CACHE_DIR / font_id / f"{key}.ttf"
        t0 = time.perf_counter()
        cache_hit = cache_path.exists()
        missing = ""

        try:
            if cache_hit:
                out_bytes = cache_path.stat().st_size
            else:
                font_path = Path(meta["path"])
                out_bytes, missing = build_subset(
                    font_path, chars, include_latin, cache_path
                )
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            data = cache_path.read_bytes()
            # TTF 魔数校验
            if data[:4] not in (b"\x00\x01\x00\x00", b"OTTO", b"true", b"ttcf"):
                raise ValueError("generated file is not a valid TTF/OTF")

            STATS.record_subset(
                font_id=font_id,
                chars_count=len(raw_chars),
                unique_chars=chars,
                cache_hit=cache_hit,
                out_bytes=out_bytes,
                elapsed_ms=elapsed_ms,
                path=str(cache_path.relative_to(ROOT)),
                missing_chars=missing,
            )
            STATS.persist()

            headers = {
                "X-Font-Id": font_id,
                "X-Subset-Chars": str(len(chars)),
                "X-Subset-Missing": str(len(missing)),
                "X-Cache-Hit": "1" if cache_hit else "0",
                "X-Subset-Bytes": str(out_bytes),
                "X-Subset-Ms": f"{elapsed_ms:.2f}",
                "X-Cache-Key": key,
                "Content-Disposition": f'attachment; filename="{font_id}-{key}.ttf"',
            }
            self._bytes(data, "font/ttf", headers)
        except Exception as e:
            STATS.record_error(f"subset: {e}")
            STATS.persist()
            self._json({"error": str(e)}, 500)

    def handle_api(self, method: str, path: str, qs: dict, body: bytes, ctype: str) -> bool:
        if path == "/health":
            self._json({"ok": True, "proto": PROTO_VERSION})
            return True
        if path == "/api/meta":
            STATS.record_request()
            self._json(
                {
                    "proto": PROTO_VERSION,
                    "name": "font-cloud-server",
                    "docs": {
                        "tool_id": "font-cloud",
                        "canonical_path": "/font-cloud",
                        "tool_html": "/font-cloud",
                        "tool_json": "/font-cloud.json",
                        "index": "/docs/",
                        "llms": "/llms.txt",
                        "llms_full": "/llms-full.txt",
                        "architecture": "/docs/architecture.md",
                        "protocol": "/docs/protocol.md",
                        "hint": "AI/Agent：先读 /font-cloud.json 或 /llms.txt，再抓 /docs/protocol.md 与 /docs/architecture.md",
                    },
                    "subset": {
                        "method": ["POST", "GET"],
                        "path": "/api/subset",
                        "params": ["font", "chars", "include_latin"],
                        "returns": "font/ttf",
                        "note": "chars 按段去重后一次请求；不含 px（字号属设备渲染维度）",
                    },
                    "endpoints": [
                        "GET /health",
                        "GET /api/meta",
                        "GET /api/fonts",
                        "POST|GET /api/subset",
                        "GET /api/stats",
                        "GET /api/stats/history",
                        "POST /api/stats/reset",
                        "GET /llms.txt",
                        "GET /llms-full.txt",
                        "GET /docs/architecture.md",
                        "GET /docs/protocol.md",
                    ],
                    "fonts_count": len(REGISTRY.list()),
                    "cache": cache_info(),
                }
            )
            return True
        if path == "/api/fonts":
            STATS.record_request()
            self._json({"fonts": REGISTRY.list()})
            return True
        if path == "/api/stats":
            STATS.record_request()
            self._json(STATS.snapshot())
            return True
        if path == "/api/stats/history":
            STATS.record_request()
            self._json({"history": STATS.history_list()})
            return True
        if path == "/api/stats/reset" and method == "POST":
            STATS.reset()
            STATS.persist()
            self._json({"ok": True})
            return True
        if path == "/api/fonts/reload" and method == "POST":
            REGISTRY.reload()
            self._json({"fonts": REGISTRY.list()})
            return True
        if path == "/llms-full.txt":
            STATS.record_request()
            parts = [
                "# Font Cloud Server — llms-full\n",
                "Generated bundle for AI/Agent single-fetch learning.\n",
                "Entry point: /llms.txt · Capability: /api/meta\n",
            ]
            for name in ("protocol.md", "architecture.md"):
                p = PUBLIC_DIR / "docs" / name
                if p.exists():
                    parts.append("\n\n" + "=" * 72 + "\n")
                    parts.append(p.read_text(encoding="utf-8"))
            self._bytes("".join(parts).encode("utf-8"), "text/plain; charset=utf-8")
            return True
        if path in ("/api/subset", "/subset"):
            if method not in ("POST", "GET"):
                self._json({"error": "method not allowed"}, 405)
                return True
            self.handle_subset(qs, body, ctype)
            return True
        return False

    def _serve_static(self, path: str) -> None:
        rel = path.lstrip("/") or "index.html"
        # 防目录穿越
        target = (PUBLIC_DIR / rel).resolve()
        if not str(target).startswith(str(PUBLIC_DIR.resolve())):
            self._json({"error": "forbidden"}, 403)
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.exists():
            # 无扩展名时尝试 name.html（如 /font-cloud → font-cloud.html）
            html_try = PUBLIC_DIR / (rel + ".html")
            if html_try.is_file() and str(html_try.resolve()).startswith(
                str(PUBLIC_DIR.resolve())
            ):
                target = html_try
        if not target.exists():
            self._json({"error": f"not found: {rel}"}, 404)
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".md": "text/markdown; charset=utf-8",
            ".txt": "text/plain; charset=utf-8",
            ".svg": "image/svg+xml",
            ".ttf": "font/ttf",
            ".png": "image/png",
        }.get(target.suffix.lower(), "application/octet-stream")
        self._bytes(target.read_bytes(), ctype)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        if self.handle_api("GET", parsed.path, qs, b"", ""):
            return
        self._serve_static(parsed.path)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        body = self._read_body()
        ctype = self.headers.get("Content-Type") or ""
        if self.handle_api("POST", parsed.path, qs, body, ctype):
            return
        self._json({"error": f"not found: {parsed.path}"}, 404)


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY.reload()
    STATS.persist()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"font-cloud-server  http://{args.host}:{args.port}/")
    print(f"  fonts: {len(REGISTRY.list())}  cache: {CACHE_DIR}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        STATS.persist()
        httpd.server_close()


if __name__ == "__main__":
    main()
