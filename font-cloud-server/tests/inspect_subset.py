# -*- coding: utf-8 -*-
"""子集字体可用性体检：结构、cmap、轮廓、metrics、可选渲染。"""
from __future__ import annotations

import io
import json
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"


def fetch_subset(font: str, chars: str, include_latin: bool = False) -> tuple[bytes, dict]:
    body = json.dumps(
        {"font": font, "chars": chars, "include_latin": include_latin}, ensure_ascii=False
    ).encode("utf-8")
    req = urllib.request.Request(
        BASE + "/api/subset",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        meta = {k: r.headers[k] for k in r.headers if k.lower().startswith("x-")}
        return r.read(), meta


def inspect(label: str, data: bytes, text: str) -> None:
    from fontTools.ttLib import TTFont

    print(f"\n== {label} ==")
    print(f"bytes={len(data)} magic={data[:4].hex()}")
    tt = TTFont(io.BytesIO(data))
    print("tables:", ",".join(sorted(tt.keys())))
    cmap = tt.getBestCmap() or {}
    have = "".join(c for c in text if ord(c) in cmap)
    miss = "".join(c for c in text if ord(c) not in cmap)
    print(f"cmap={len(cmap)} numGlyphs={tt['maxp'].numGlyphs}")
    print(f"have({len(have)}): {have}")
    print(f"miss({len(miss)}): {miss or '-'}")

    empty, comp = [], []
    glyf = tt["glyf"] if "glyf" in tt else None
    for cp, gname in cmap.items():
        if glyf is None:
            break
        g = glyf[gname]
        try:
            if getattr(g, "numberOfContours", 0) == 0:
                comps = getattr(g, "components", None)
                if comps:
                    comp.append(chr(cp))
                else:
                    empty.append(chr(cp))
        except Exception as e:
            empty.append(f"{chr(cp)}!{e}")
    print(f"empty_outline({len(empty)}): {''.join(empty) or '-'}")
    print(f"composite({len(comp)}): {''.join(comp[:20]) or '-'}")

    upem = tt["head"].unitsPerEm
    print(f"upem={upem} has_hmtx={'hmtx' in tt} has_name={'name' in tt}")
    for ch in list(text)[:8]:
        if ord(ch) in cmap:
            gn = cmap[ord(ch)]
            aw, lsb = tt["hmtx"][gn]
            print(f"  {ch!r} glyph={gn} advance={aw} ({aw/upem:.3f}em) lsb={lsb}")

    # 尝试 Pillow 渲染（真渲染验证）
    try:
        import tempfile
        from pathlib import Path
        from PIL import Image, ImageDraw, ImageFont

        tmpdir = Path(tempfile.gettempdir())
        path = tmpdir / f"check-{label.replace(' ', '_')}.ttf"
        path.write_bytes(data)
        fnt = ImageFont.truetype(str(path), 48)
        img = Image.new("RGB", (640, 80), "white")
        d = ImageDraw.Draw(img)
        sample = text[:12] if text else "Ag"
        d.text((8, 10), sample, font=fnt, fill="black")
        pixels = img.getdata()
        ink = sum(1 for p in pixels if p[0] < 250)
        status = "OK" if ink > 50 else "WEAK/EMPTY"
        print(f"PIL render sample={sample!r} ink_pixels={ink} -> {status}")
        out = tmpdir / f"check-{label.replace(' ', '_')}.png"
        img.save(out)
        print(f"PIL saved {out}")
    except Exception as e:
        print(f"PIL render: FAIL ({type(e).__name__}: {e})")

    tt.close()


def main() -> int:
    print("BASE", BASE)
    # 1) 仅中文
    data, meta = fetch_subset("misans-regular", "天青色等烟雨而我在等你")
    print("meta", meta)
    inspect("zh-only", data, "天青色等烟雨而我在等你")

    # 2) 中文+拉丁字母（用户要求字母顺带拿到）
    data, meta = fetch_subset("misans-regular", "天青色ABC123，。")
    print("meta", meta)
    inspect("zh+ascii-requested", data, "天青色ABC123，。")

    # 3) include_latin=true
    data, meta = fetch_subset("misans-regular", "你好", include_latin=True)
    print("meta", meta)
    inspect("include-latin", data, "Hello 你好 123 !?")

    # 4) ubuntu 拉丁
    data, meta = fetch_subset("ubuntu-medium", "Hello Font Cloud")
    print("meta", meta)
    inspect("ubuntu", data, "Hello Font Cloud")

    # 5) 空格/标点/数字单独
    data, meta = fetch_subset("misans-regular", "0123456789 .,;:!?")
    print("meta", meta)
    inspect("digits-punct", data, "0123456789 .,;:!?")

    print("\nDONE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
