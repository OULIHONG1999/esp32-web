# -*- coding: utf-8 -*-
"""对比子集参数：体积 / 字形数 / 耗时 / 表占用。"""
from __future__ import annotations

import io
import time

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

P = r"D:\WORK\treaWork\lvgl\lv_port_pc_vscode\assets\MiSans-Regular.ttf"
TEXT = "天青色等烟雨而我在等你"
ASCII_BASIC = "".join(chr(c) for c in range(0x20, 0x7F))
# 用户要的常用字符：字母大小写 + 数字 + 常用中英文标点
CORE = string_core = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
    "，。、；：？！“”‘’（）【】《》—…·￥"
)


def run(tag: str, text: str, **kw) -> None:
    o = Options()
    for k, v in kw.items():
        setattr(o, k, v)
    t0 = time.perf_counter()
    tt = TTFont(P)
    s = Subsetter(options=o)
    s.populate(text=text)
    s.subset(tt)
    buf = io.BytesIO()
    tt.save(buf)
    tt2 = TTFont(io.BytesIO(buf.getvalue()))
    tables = {}
    reader = getattr(tt2, "reader", None)
    if reader:
        for t in tt2.keys():
            try:
                tables[t] = reader[t].length
            except Exception:
                pass
    top = sorted(tables.items(), key=lambda x: -x[1])[:5]
    n = tt2["maxp"].numGlyphs
    ms = int((time.perf_counter() - t0) * 1000)
    print(f"{tag:32} {buf.tell():6d}B  glyphs={n:4d}  {ms:4d}ms  top={top}")
    tt.close()


def main() -> None:
    base = TEXT + ASCII_BASIC
    print("=== 全量 ASCII 0x20-0x7E ===")
    run("star drop=[]", base, layout_features=["*"], drop_tables=[], hinting=True)
    run("star drop=[DSIG]", base, layout_features=["*"], drop_tables=["DSIG"], hinting=True)
    run("min-feats drop=[DSIG]", base, layout_features=["kern", "ccmp", "locl", "liga", "clig", "calt"], drop_tables=["DSIG"])
    run("no-feats drop=[DSIG]", base, layout_features=[], drop_tables=["DSIG"])
    run("no-feats no-hint drop=[DSIG]", base, layout_features=[], drop_tables=["DSIG"], hinting=False)
    run("kern only drop=[DSIG]", base, layout_features=["kern"], drop_tables=["DSIG"])

    print("\n=== 精简核心字符（字母+数字+常用标点）===")
    core = TEXT + CORE
    run("core star drop=[DSIG]", core, layout_features=["*"], drop_tables=["DSIG"])
    run("core no-feats drop=[DSIG]", core, layout_features=[], drop_tables=["DSIG"])
    run("core min-feats drop=[DSIG]", core, layout_features=["kern", "ccmp", "locl"], drop_tables=["DSIG"], hinting=False)

    print("\n=== 仅汉字（对照）===")
    run("zh star drop=[DSIG]", TEXT, layout_features=["*"], drop_tables=["DSIG"])


if __name__ == "__main__":
    main()
