"""自验证脚本：对 font-cloud-server 做端到端检查。

用法：
  .venv/Scripts/python.exe tests/verify.py --port 8765
  （服务需已在对应端口监听，或加 --spawn 自动拉起）
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

PASS = 0
FAIL = 0
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        RESULTS.append((name, True, detail))
        print(f"  [PASS] {name}" + (f" — {detail}" if detail else ""))
    else:
        FAIL += 1
        RESULTS.append((name, False, detail))
        print(f"  [FAIL] {name}" + (f" — {detail}" if detail else ""))


def http_json(url: str, data: dict | None = None, method: str = "GET"):
    body = None
    headers = {}
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode("utf-8")), dict(res.headers)


def http_raw(url: str, data: dict | None = None):
    body = None
    headers = {}
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read(), dict(res.headers), res.status


def spawn_server(port: int) -> subprocess.Popen:
    # 用本文件所在解释器（venv）拉起，避免落到系统/MIMO python
    py = Path(sys.executable)
    script = ROOT / "server.py"
    log = open(ROOT / "data" / "server-verify.log", "w", encoding="utf-8")
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    return subprocess.Popen(
        [str(py), str(script), "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(ROOT),
        stdout=log,
        stderr=subprocess.STDOUT,
        env=env,
    )


def wait_ready(base: str, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(base + "/health", timeout=1)
            return True
        except Exception:
            time.sleep(0.2)
    return False


def is_ttf(data: bytes) -> bool:
    return data[:4] in (b"\x00\x01\x00\x00", b"OTTO", b"true", b"ttcf")


def main() -> int:
    global PASS, FAIL
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--spawn", action="store_true", help="自动拉起服务")
    args = ap.parse_args()
    base = f"http://127.0.0.1:{args.port}"

    proc = None
    if args.spawn:
        print(f"· spawning server on {base}")
        proc = spawn_server(args.port)

    try:
        if not wait_ready(base):
            print(f"ERROR: server not ready at {base}")
            return 2

        print("\n== 1. 基础接口 ==")
        meta, _ = http_json(base + "/api/meta")
        check("GET /api/meta 返回协议号", meta.get("proto") == "1.0.0", str(meta.get("proto")))
        check("meta 声明 subset 能力", "subset" in meta)

        health, _ = http_json(base + "/health")
        check("GET /health ok", health.get("ok") is True)

        fonts_doc, _ = http_json(base + "/api/fonts")
        fonts = fonts_doc.get("fonts") or []
        check("GET /api/fonts 非空", len(fonts) >= 2, f"{len(fonts)} fonts")
        ids = [f["id"] for f in fonts]
        check("包含 MiSans", any("misans" in i for i in ids), ",".join(ids))
        misans = next((f for f in fonts if "misans" in f["id"]), None)

        print("\n== 2. 子集化（缓存未命中） ==")
        # 清空统计 + 服务端文件缓存，确保本轮断言 MISS
        http_json(base + "/api/stats/reset", {})
        cache_dir = ROOT / "cache"
        if cache_dir.exists():
            for f in cache_dir.rglob("*.ttf"):
                try:
                    f.unlink()
                except OSError:
                    pass

        lyric = "天青色等烟雨而我在等你"
        t0 = time.time()
        data1, hdr1, status1 = http_raw(
            base + "/api/subset",
            {"font": misans["id"], "chars": lyric},
        )
        wall_ms = (time.time() - t0) * 1000
        check("POST /api/subset 200", status1 == 200, str(status1))
        check("返回 TTF 魔数", is_ttf(data1), data1[:4].hex())
        check("子集显著小于全量", len(data1) < misans["bytes"] / 10, f"{len(data1)} vs {misans['bytes']}")
        check("响应头 X-Cache-Hit=0", hdr1.get("X-Cache-Hit") == "0", str(hdr1.get("X-Cache-Hit")))
        check("响应头含耗时/体积", "X-Subset-Ms" in hdr1 and "X-Subset-Bytes" in hdr1)
        check("默认附带拉丁字母", hdr1.get("X-Latin-Included") == "1", str(hdr1.get("X-Latin-Included")))
        glyphs1 = int(hdr1.get("X-Subset-Glyphs") or 0)
        check("回报字形数", 20 < glyphs1 < 2000, f"glyphs={glyphs1}")

        from fontTools.ttLib import TTFont as _TTF
        import io as _io

        tt_latin = _TTF(_io.BytesIO(data1))
        cmap_latin = tt_latin.getBestCmap() or {}
        check(
            "子集含拉丁 A-Z",
            all(ord(c) in cmap_latin for c in "ABCabc"),
            f"latin_in_cmap={all(ord(c) in cmap_latin for c in 'ABCabc')}",
        )
        tt_latin.close()
        print(f"     全量 {misans['bytes']} B → 子集 {len(data1)} B · 墙钟 {wall_ms:.0f} ms · 服务端 {hdr1.get('X-Subset-Ms')} ms")

        # fontTools 校验子集包含请求字符
        from fontTools.ttLib import TTFont
        import io

        tt = TTFont(io.BytesIO(data1))
        cmap = tt.getBestCmap() or {}
        requested = set(lyric)
        have = {ch for ch in requested if ord(ch) in cmap}
        check("子集含请求汉字", have == requested, f"{len(have)}/{len(requested)}")
        check(
            "子集字形数远小于全量",
            tt["maxp"].numGlyphs < 2000,
            f"glyphs={tt['maxp'].numGlyphs}",
        )
        tt.close()

        print("\n== 3. 缓存命中 ==")
        data2, hdr2, _ = http_raw(
            base + "/api/subset",
            {"font": misans["id"], "chars": lyric},
        )
        check("二次请求 X-Cache-Hit=1", hdr2.get("X-Cache-Hit") == "1", str(hdr2.get("X-Cache-Hit")))
        check("命中时字节一致", data2 == data1)
        check("命中更快或相近", float(hdr2.get("X-Subset-Ms", "0")) < 500)

        print("\n== 4. 顺序无关 / 去重 ==")
        data3, hdr3, _ = http_raw(
            base + "/api/subset",
            {"font": misans["id"], "chars": lyric[::-1]},
        )
        check("字符顺序不同也命中同一缓存", hdr3.get("X-Cache-Hit") == "1", f"key={hdr3.get('X-Cache-Key')}")

        data4, hdr4, _ = http_raw(
            base + "/api/subset",
            {"font": misans["id"], "chars": lyric * 3},
        )
        check("重复文本去重后命中缓存", hdr4.get("X-Cache-Hit") == "1")

        print("\n== 5. 缺字 / 错误处理 ==")
        # 使用一个几乎必然不在字体中的汉字（CJK 扩展区）
        data5, hdr5, _ = http_raw(
            base + "/api/subset",
            {"font": misans["id"], "chars": "𰻝\uE000"},
        )
        check("生僻字仍返回 TTF", is_ttf(data5))
        missing = int(hdr5.get("X-Subset-Missing") or 0)
        check("缺字数上报", missing >= 0, f"missing={missing}")

        try:
            http_raw(base + "/api/subset", {"font": "no-such-font", "chars": "你"})
            check("未知字体 404", False, "expected HTTPError")
        except urllib.error.HTTPError as e:
            check("未知字体 404", e.code == 404, str(e.code))

        try:
            http_raw(base + "/api/subset", {"font": misans["id"], "chars": ""})
            check("空字符 400", False, "expected HTTPError")
        except urllib.error.HTTPError as e:
            check("空字符 400", e.code == 400, str(e.code))

        print("\n== 6. 统计 ==")
        stats, _ = http_json(base + "/api/stats")
        check("subset_requests >= 5", stats["subset_requests"] >= 5, str(stats["subset_requests"]))
        check("cache_hits >= 3", stats["cache_hits"] >= 3, str(stats["cache_hits"]))
        check("cache_hit_rate > 0", stats["cache_hit_rate"] > 0, str(stats["cache_hit_rate"]))
        check("bytes_out > 0", stats["bytes_out"] > 0, str(stats["bytes_out"]))
        check("latency 有样本", stats["latency_ms"]["samples"] > 0, str(stats["latency_ms"]))
        check("per_font 有 misans", any("misans" in k for k in stats["per_font"]), str(list(stats["per_font"])))

        hist_doc, _ = http_json(base + "/api/stats/history")
        hist = hist_doc.get("history") or []
        check("history 非空", len(hist) >= 5, str(len(hist)))
        check("history 含 cache_hit 标记", all("cache_hit" in r for r in hist[:3]))

        # 字体库列表渲染字段（页面依赖）
        check("font 条目含 id/bytes/glyph_count", all(k in fonts[0] for k in ("id", "bytes", "glyph_count", "name")))

        print("\n== 7. 静态测试页 ==")
        html = urllib.request.urlopen(base + "/", timeout=10).read().decode("utf-8", "replace")
        check("首页可访问", "字体子集化测试台" in html)
        css = urllib.request.urlopen(base + "/styles.css", timeout=10).read()
        js = urllib.request.urlopen(base + "/app.js", timeout=10).read()
        check("styles.css / app.js 可访问", len(css) > 500 and len(js) > 500)

        print("\n== 8. 与源字体对比（体积压缩比） ==")
        ratio = misans["bytes"] / max(len(data1), 1)
        check("子集压缩比 > 20x", ratio > 20, f"{ratio:.1f}x")
        # 常用 3500 字规模估算
        sample3500 = "".join(chr(c) for c in range(0x4E00, 0x4E00 + 200))
        data_big, hdr_big, _ = http_raw(
            base + "/api/subset",
            {"font": misans["id"], "chars": sample3500},
        )
        print(f"     200 个连续汉字子集 = {len(data_big)} B（约 {len(data_big)/200:.1f} B/字）")
        check("200 字子集仍小于 300KB", len(data_big) < 300_000, str(len(data_big)))

    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()

    print("\n" + "=" * 52)
    print(f"验证结果:  {PASS} passed, {FAIL} failed")
    print("=" * 52)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
