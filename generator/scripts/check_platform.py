#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对产出的单文件 HTML 做冒烟校验：JSON 可解析、JS 语法可通过、关键数据到位。"""
import json, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))   # generator/scripts
SKILL = os.path.dirname(HERE)                       # generator
HTML = os.path.join(SKILL, "output", "私募证券基金管理人内控制度生成器.html")

# node 只用于 JS 语法校验，找不到就跳过（不阻断）
NODE = None
for cand in (shutil.which("node"),
             r"C:\Users\admin\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"):
    if cand and os.path.exists(cand):
        NODE = cand
        break

ok = True
print("=" * 60)
print("冒烟校验")
print("-" * 60)

if not os.path.exists(HTML):
    print("✗ 产物不存在"); sys.exit(1)
size = os.path.getsize(HTML)
print(f"  产物大小: {size/1024:.0f} KB")

src = open(HTML, "r", encoding="utf-8").read()

# 1) JSON 载荷
m = re.search(r'<script id="platform-data" type="application/json">(.*?)</script>', src, re.S)
if not m:
    print("✗ 未找到 platform-data"); sys.exit(1)
try:
    data = json.loads(m.group(1))
    print(f"✓ JSON 可解析")
except Exception as e:
    print("✗ JSON 解析失败:", e); sys.exit(1)

laws = data["laws"]; mods = data["modules"]
n_art = sum(len(v) for v in laws.values())
print(f"✓ 法规 {len(laws)} 部 / 条文 {n_art} 条")
print(f"✓ 制度模块 {len(mods)} 个")

miss = data["meta"].get("missing_refs", [])
print(("✓" if not miss else "⚠") + f" 引用缺失 {len(miss)} 处")

# 2) 抽样核对条文内容
checks = [
    ("内控指引", "12", "合规风控"),
    ("运作指引", "12", "25%"),
    ("运作指引", "41", "同一资产"),
    ("私募条例", "17", "自行募集"),
    ("适当性办法", "32", "20年"),
]
for k, no, kw in checks:
    t = laws.get(k, {}).get(no, "")
    good = kw in t
    ok = ok and good
    print(("  ✓" if good else "  ✗") + f" {k} 第{no}条 含『{kw}』 ({len(t)}字)")

# 3) JS 语法
scripts = re.findall(r"<script>(.*?)</script>", src, re.S)
if not NODE:
    print("– 未找到 node，跳过 JS 语法校验")
elif scripts:
    tmp = os.path.join(os.path.dirname(HTML), "_smoke.js")
    open(tmp, "w", encoding="utf-8").write(scripts[-1])
    r = subprocess.run([NODE, "--check", tmp], capture_output=True, text=True, encoding="utf-8")
    if r.returncode == 0:
        print("✓ JS 语法通过 node --check")
    else:
        ok = False
        print("✗ JS 语法错误:\n" + (r.stderr or "")[:900])
    os.remove(tmp)

print("-" * 60)
print("结论: " + ("通过" if ok else "存在问题"))
print("=" * 60)
sys.exit(0 if ok else 1)
