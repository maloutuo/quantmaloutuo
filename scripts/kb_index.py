# -*- coding: utf-8 -*-
"""知识库索引构建器:把 references/*.md 切分为可检索的场景条目。

原汇编存在两套编号体系(150场景汇编「场景1-150」+ 客户100场景/第四辑100场景另行编号),
同一卷内编号会重复,故**不可用编号作唯一键**。本模块用「行首场景标记出现顺序」作序,
以 (volume, ordinal) 为唯一标识,(volume, 原始编号, 标题) 为展示信息。

输出 data/kb_index.json:
  {
    "volumes": [{id, name, file, count, groups:[...]}],
    "entries": [{id, vol, volName, num, title, cat, text, chars}]
  }
"""
import re
import os
import sys
import json
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ensure_utf8_stdout, log, BASE_DIR, DATA_DIR

ensure_utf8_stdout()

KB_DIR = os.path.join(BASE_DIR, "references")
OUT_PATH = os.path.join(DATA_DIR, "kb_index.json")

# 卷定义:文件 → (卷名, 领域关键词)
VOLUMES = [
    ("01-fund-lifecycle.md", "基金募投管退"),
    ("02-tax.md", "税务"),
    ("03-internal-control.md", "内部控制"),
    ("04-programmatic-trading.md", "程序化交易"),
    ("05-custody.md", "托管与外包"),
    ("06-contract.md", "合同管理"),
    ("07-regulatory-inspection.md", "监管检查与争议解决"),
    ("08-appendix.md", "附录"),
]

# 条目起始:行首「场景N」后接 【分类】 或 :/：/./、/空格 或直接接标题文字
ENTRY_RE = re.compile(r"^场景\s*(\d+)\s*(?:[\.、:：]|【|\s)")

# 分类标签:【XX】形式
CAT_RE = re.compile(r"^场景\s*\d+\s*[\.、:：]?\s*【([^】]{1,12})】")

# 三段式小节标题(用于提取结构标记,便于检索定位)
SECTION_PATS = [
    r"^一、\s*明确结论",
    r"^二、\s*实操步骤",
    r"^三、\s*特殊情况",
    r"^明确结论",
    r"^实操步骤",
    r"^特殊情况",
    r"^法规依据",
    r"^举例说明",
    r"^解决路径",
]


def split_entries(text):
    """把一卷文本切分为 [(num, title, cat, body_text)]。"""
    lines = text.split("\n")
    starts = []
    for i, ln in enumerate(lines):
        m = ENTRY_RE.match(ln)
        if m:
            starts.append((i, int(m.group(1))))

    out = []
    for idx, (ln_i, num) in enumerate(starts):
        end = starts[idx + 1][0] if idx + 1 < len(starts) else len(lines)
        head = lines[ln_i].strip()
        # 标题 = 去掉「场景N」前缀与【分类】
        title = re.sub(r"^场景\s*\d+\s*[\.、:：]?\s*", "", head)
        cat_m = CAT_RE.match(head)
        cat = cat_m.group(1) if cat_m else ""
        title = re.sub(r"^【[^】]{1,12}】\s*", "", title).strip()
        body = "\n".join(lines[ln_i:end]).strip()
        out.append((num, title, cat, body))
    return out


def main():
    volumes, entries = [], []
    for fname, vname in VOLUMES:
        fpath = os.path.join(KB_DIR, fname)
        if not os.path.exists(fpath):
            log("!! 缺少 %s" % fname)
            continue
        with open(fpath, "r", encoding="utf-8") as f:
            text = f.read()
        parsed = split_entries(text)
        vid = fname.split("-")[0]
        volumes.append({"id": vid, "name": vname, "file": fname,
                        "count": len(parsed), "chars": len(text)})
        for ordn, (num, title, cat, body) in enumerate(parsed, 1):
            entries.append({
                "id": "%s-%d" % (vid, ordn),
                "vol": vid,
                "volName": vname,
                "num": num,
                "title": title,
                "cat": cat,
                "text": body,
                "chars": len(body),
            })
        log("%-34s %-18s %3d 条" % (fname, vname, len(parsed)))

    data = {
        "built_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "volumes": volumes,
        "entries": entries,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    log("")
    log("索引条目合计 %d 条,输出 %s (%.1f MB)"
        % (len(entries), OUT_PATH, os.path.getsize(OUT_PATH) / 1024 / 1024))
    # 抽样自检
    log("")
    log("=== 抽样(各卷首条) ===")
    seen = set()
    for e in entries:
        if e["vol"] in seen:
            continue
        seen.add(e["vol"])
        log("[%s·%s] 场景%s %s" % (e["volName"], e["cat"] or "-", e["num"], e["title"][:52]))
        log("    正文 %d 字 | %s" % (e["chars"], e["text"][:70].replace("\n", " ")))


if __name__ == "__main__":
    main()
