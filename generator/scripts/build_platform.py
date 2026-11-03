#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
构建单文件网页平台：把法规原文库 + 制度条款库编译进一个 HTML。

数据源（唯一事实来源，不在此脚本内重写任何原文）：
    references/01-法规原文库.md      → 内控指引 / 登记备案办法 / 登记指引1号
    references/05-运作指引全文.md    → 运作指引
    references/06-适当性办法全文.md  → 适当性办法
    references/07-私募条例全文.md    → 私募条例
    references/09-制度条款库.json    → 制度模块与条款

产物：
    output/私募证券基金管理人内控制度生成器.html   （双击即开，无需联网/服务器）

用法：
    python scripts/build_platform.py
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
REF = os.path.join(SKILL, "references")
OUT = os.path.join(SKILL, "output")

CN = {"零": 0, "〇": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
      "六": 6, "七": 7, "八": 8, "九": 9}


def cn2num(s):
    """中文数字 → int，支持一到九十九、以及'第X十Y'"""
    s = s.strip()
    if s.isdigit():
        return int(s)
    total, section = 0, 0
    for ch in s:
        if ch in CN:
            section = CN[ch]
        elif ch == "十":
            section = (section or 1) * 10
            total += section
            section = 0
        elif ch == "百":
            section = (section or 1) * 100
            total += section
            section = 0
    return total + section


# 法规全名 → 短键（归一化后匹配）
LAW_KEYS = {
    "私募投资基金管理人内部控制指引": "内控指引",
    "私募投资基金监督管理条例": "私募条例",
    "私募投资基金登记备案办法": "登记备案办法",
    "私募基金管理人登记指引第1号——基本经营要求": "登记指引1号",
    "私募基金管理人登记指引第1号-基本经营要求": "登记指引1号",
    "私募证券投资基金运作指引": "运作指引",
    "证券期货投资者适当性管理办法": "适当性办法",
}

LAW_META = {
    "内控指引": {"name": "《私募投资基金管理人内部控制指引》",
                 "org": "中国证券投资基金业协会", "doc": "—", "date": "2016-02-01",
                 "level": "自律规则"},
    "运作指引": {"name": "《私募证券投资基金运作指引》",
                 "org": "中国证券投资基金业协会", "doc": "—", "date": "2024-08-01",
                 "level": "自律规则"},
    "适当性办法": {"name": "《证券期货投资者适当性管理办法》",
                  "org": "中国证券监督管理委员会", "doc": "证监会令第130号（2022年8月12日第二次修正）",
                  "date": "2017-07-01", "level": "部门规章"},
    "私募条例": {"name": "《私募投资基金监督管理条例》",
                 "org": "国务院", "doc": "国务院令第762号", "date": "2023-09-01",
                 "level": "行政法规"},
    "登记备案办法": {"name": "《私募投资基金登记备案办法》",
                    "org": "中国证券投资基金业协会", "doc": "—", "date": "2023-02-24",
                    "level": "自律规则"},
    "登记指引1号": {"name": "《私募基金管理人登记指引第1号——基本经营要求》",
                    "org": "中国证券投资基金业协会", "doc": "—", "date": "2023-02-24",
                    "level": "自律规则"},
}

ART_RE = re.compile(r"^\*\*第([零〇一二三四五六七八九十百\d]+)条\*\*\s*(.*)$")
HEAD_RE = re.compile(r"^#{1,3}\s*(.*)$")


def parse_file(path, default_law=None):
    """解析一个 markdown 法规文件，返回 {law_key: {条号: 原文}}"""
    with open(path, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()

    result = {}
    cur_law = default_law
    cur_no = None
    buf = []

    def flush():
        if cur_law and cur_no is not None:
            text = " ".join(x.strip() for x in buf if x.strip())
            text = re.sub(r"\s+", "", text)          # 中文正文去多余空白
            if text:
                result.setdefault(cur_law, {})[cur_no] = text
        buf.clear()

    for ln in lines:
        hm = HEAD_RE.match(ln)
        if hm:
            head = hm.group(1).replace(" ", "").replace("　", "")
            for full, key in LAW_KEYS.items():
                if full.replace(" ", "") in head:
                    flush()
                    cur_law = key
                    cur_no = None
                    break
            else:
                # 遇到新章节但非法规标题：结束当前条文
                if cur_no is not None and not ln.startswith("**第"):
                    flush()
                    cur_no = None
            continue

        am = ART_RE.match(ln)
        if am:
            flush()
            cur_no = cn2num(am.group(1))
            rest = am.group(2).strip()
            if rest:
                buf.append(rest)
            continue

        if cur_no is not None:
            s = ln.strip()
            if s.startswith("---") or s.startswith("|"):
                continue
            if s:
                buf.append(s)

    flush()
    return result


def main():
    laws = {}

    sources = [
        ("01-法规原文库.md", None),
        ("05-运作指引全文.md", "运作指引"),
        ("06-适当性办法全文.md", "适当性办法"),
        ("07-私募条例全文.md", "私募条例"),
    ]
    report = []
    for fn, default in sources:
        p = os.path.join(REF, fn)
        if not os.path.exists(p):
            print("!! 缺失源文件: " + fn)
            continue
        parsed = parse_file(p, default)
        for k, arts in parsed.items():
            laws.setdefault(k, {})
            laws[k].update(arts)          # 后处理的文件覆盖（如条例全文覆盖 01 的节选）
            report.append((fn, k, len(arts)))

    with open(os.path.join(REF, "09-制度条款库.json"), "r", encoding="utf-8") as f:
        clause_lib = json.load(f)

    # ---- 引用完整性校验：任何条款引用必须能取到原文 ----
    missing = []
    def check_refs(refs, where):
        for r in refs or []:
            k, no = r[0], r[1]
            if k not in LAW_META:
                missing.append((where, k, no, "未登记该法规"))
            elif not laws.get(k, {}).get(no) and not laws.get(k, {}).get(str(no)):
                missing.append((where, k, no, "原文缺失"))

    for m in clause_lib["modules"]:
        for c in m.get("clauses", []):
            check_refs(c.get("r"), m["id"] + " " + m["name"])

    if missing:
        print("\n⚠️ 引用缺失（平台将标注『原文待核实』）：")
        for w, k, no, why in missing:
            print(f"   [{w}] {k} 第{no}条 —— {why}")
        print(f"   合计 {len(missing)} 处\n")
    else:
        print("\n✓ 引用完整性校验通过：全部条款引用均可取到法规原文\n")

    payload = {
        "meta": {
            "built": "2026-09-28",
            "law_meta": LAW_META,
            "missing_refs": [{"where": w, "law": k, "no": no, "why": why}
                             for w, k, no, why in missing],
        },
        "laws": laws,
        "modules": clause_lib["modules"],
    }

    tpl_path = os.path.join(SKILL, "templates", "platform.html")
    with open(tpl_path, "r", encoding="utf-8") as f:
        html = f.read()

    # 占位符已位于 <script id="platform-data"> 内部，此处只注入 JSON 本体
    injected = json.dumps(payload, ensure_ascii=False)
    if "__PLATFORM_DATA__" not in html:
        print("!! 模板缺少 __PLATFORM_DATA__ 占位符")
        sys.exit(1)
    html = html.replace("__PLATFORM_DATA__", injected)

    os.makedirs(OUT, exist_ok=True)
    out_path = os.path.join(OUT, "私募证券基金管理人内控制度生成器.html")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)

    print("=" * 64)
    print("构建完成")
    print("-" * 64)
    for fn, k, n in report:
        print(f"  {fn:28s} → {k:8s} {n:3d} 条")
    print("-" * 64)
    total = sum(len(v) for v in laws.values())
    print(f"  法规条文合计: {total} 条 / {len(laws)} 部")
    print(f"  制度模块: {len(clause_lib['modules'])} 个")
    print(f"  产物: {out_path}")
    print("=" * 64)


if __name__ == "__main__":
    main()
