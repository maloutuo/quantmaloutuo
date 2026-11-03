# -*- coding: utf-8 -*-
"""
报告生成器:基于台账生成
  1. 每日简报 output/briefing_YYYYMMDD.md(+ .docx,若 python-docx 可用)
  2. 可检索数据源网页 output/penalties.html(单文件,含筛选/搜索/详情展开)

用法:
  python report.py                  # 全量报告
  python report.py --days 7        # 简报只覆盖近 7 天新增
"""
import os
import re
import sys
import json
import datetime
import argparse
import html as html_mod

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (
    ensure_utf8_stdout, log, load_ledger, OUTPUT_DIR, TAG_RULES,
)
from anchor import extract_law_anchors, build_all_doctrine

ensure_utf8_stdout()

STATUS_LABEL = {
    "ok": "正文完整",
    "empty": "无正文",
    "pending_ocr": "待视觉转录",
    "skipped-limit": "未抓取",
    "error": "抓取失败",
}

EXTRACT_LABEL = {
    "agent_vision": "扫描件视觉转录",
    "ocr": "OCR 识别",
    "text_layer": "PDF 文本层",
    "html": "网页全文",
}

# 自查启示规则:违规类型标签 → (子题, 启示建议)
# 启示为 AI 基于该类违规共性生成的解读,输出时必须标注"非监管原文"。
INSIGHT_RULES = {
    "登记备案": ("登记信息真实性",
              "核对中基协登记的控股股东/实际控制人、法定代表人、总经理、基金经理等关键信息与实际任职是否一致;"
              "人员或产品要素变更后按规定时限更新报送,杜绝\"报备一套、实际一套\"。"),
    "募集与适当性": ("募集与投资者适当性",
                 "复核募集全流程留痕:特定对象确定、风险测评与产品风险等级匹配、合格投资者认定、"
                 "风险揭示书签署与冷静期回访执行情况。"),
    "投资运作": ("投资运作边界",
              "严禁将投资管理职责实际让渡给外部人员或无资质第三方;备案的基金经理须与实际履行职责者一致,"
              "杜绝\"挂名基金经理\";未备案产品不得运作。"),
    "信息披露": ("信息披露",
              "按基金合同约定的频率与内容向投资者披露,确保披露信息真实、准确、完整,与产品实际运作一致,"
              "并妥善保管披露记录备查。"),
    "内控与治理": ("内控与治理执行",
                "内控制度重在执行而非成文:办公场地与人员管理、用印与审批流程、信披等资料的保管期限"
                "与保管责任需可验证,制度与实际\"两张皮\"是高发扣分点。"),
    "侵占挪用": ("基金财产安全",
              "基金财产与管理人自有财产、不同基金财产之间严格隔离;不得以财务顾问费等名义向关联方"
              "转移基金财产收益;资金划付全程留痕。"),
    "从业资格": ("从业资格管理",
               "从事私募基金业务的人员按规定完成从业登记,重点核对高管、风控、募集岗位人员的登记状态。"),
    "违规减持": ("交易合规",
               "涉及二级市场投资的,对照证监会减持规则与交易所细则自查交易行为。"),
    "其他": ("综合自查",
            "对照监管文书逐项核查同类问题,举一反三。"),
}

# 个人身份线索:从正文中提取当事人担任的角色
ROLE_PATTERNS = ["合规风控负责人", "基金经理", "法定代表人", "实际控制人",
                 "总经理", "董事长", "董事", "监事", "首席", "投资总监"]


def body_status_label(rec):
    s = rec.get("body_status", "")
    for k, v in STATUS_LABEL.items():
        if s.startswith(k):
            return v
    return s or "未知"


def _tag_keywords(tag):
    for t, kws in TAG_RULES:
        if t == tag:
            return kws
    return []


def _find_anchor(body, tag, max_len=80):
    """在正文中找到含该标签关键词的第一句,作为'本案事实锚点'。"""
    if not body:
        return ""
    kws = _tag_keywords(tag)
    for sent in re.split(r"[。;\n]", body):
        sent = sent.strip()
        if 8 <= len(sent) <= 200 and any(k in sent for k in kws):
            return sent[:max_len]
    return ""


def extract_roles(body):
    """只扫当事人段(正文开头),避免把申辩里其他人的职务也算进来。"""
    text = (body or "")[:200]
    return [r for r in ROLE_PATTERNS if r in text]


def build_insights(rec, max_n=4):
    """生成单案例自查启示:标签共性建议 + 本案事实锚点。AI 解读,非原文。"""
    body = rec.get("body") or ""
    out = []
    for tag in rec.get("tags", []):
        rule = INSIGHT_RULES.get(tag)
        if not rule:
            continue
        label, advice = rule
        anchor = _find_anchor(body, tag)
        out.append({"tag": tag, "label": label, "advice": advice, "anchor": anchor})
        if len(out) >= max_n:
            break
    if not out:
        out.append({"tag": "其他", "label": INSIGHT_RULES["其他"][0],
                    "advice": INSIGHT_RULES["其他"][1],
                    "anchor": _find_anchor(body, "其他")})
    return out


# ---------------------------------------------------------------- 简报(四段式)

def _local_pdf(rec, out_dir):
    """扫描件原件 PDF 已归档的路径(存在才返回)。"""
    if rec.get("extract_method") != "agent_vision":
        return ""
    p = os.path.join(out_dir, "pdfs", "%s_%s.pdf" % (rec.get("date", ""), rec.get("subject", "")))
    return p if os.path.exists(p) else ""


def _case_blocks(rec, out_dir):
    """单个案例的四段式内容:(来源, 机构, 处罚措施, 原文meta, 原文正文, 启示)"""
    src = rec.get("source", "")
    pdf = _local_pdf(rec, out_dir)
    roles = extract_roles(rec.get("body", ""))
    org_line = "%s(%s,辖区:%s%s)" % (
        rec.get("subject", ""), rec.get("status", ""), rec.get("region", ""),
        ";身份:" + "、".join(roles) if roles and rec.get("status") == "个人" else "")
    measures = "、".join(rec.get("measures", [])) or "见原文"
    if rec.get("amount_wan"):
        measures += "(罚款 %s 万元)" % rec["amount_wan"]
    method_label = EXTRACT_LABEL.get(rec.get("extract_method", ""),
                                     rec.get("extract_method", ""))
    insights = build_insights(rec)
    return {
        "source": src, "title": rec.get("title", ""), "url": rec.get("url", ""),
        "pdf": pdf, "org": org_line, "measures": measures,
        "method_label": method_label,
        "body": rec.get("body") or "(正文缺失)",
        "insights": insights,
    }


def build_briefing(records, days=7, out_dir=OUTPUT_DIR):
    today = datetime.date.today()
    since = today - datetime.timedelta(days=days)
    fresh = [r for r in records if r.get("date") and r["date"] >= since.isoformat()]
    fresh.sort(key=lambda r: r["date"], reverse=True)
    cases = [_case_blocks(r, out_dir) for r in fresh]

    # ---------- MD ----------
    lines = []
    lines.append("# 私募基金监管处罚简报")
    lines.append("")
    lines.append("**生成日期**: %s　|　**统计窗口**: 近 %d 天(%s ~ %s)　|　**案例数**: %d"
                 % (today.isoformat(), days, since.isoformat(), today.isoformat(), len(fresh)))
    lines.append("")
    lines.append("> 体例说明:**来源 / 机构 / 处罚措施 / 案例原文**均为监管公开信息原文照搬;"
                 "**自查启示**为基于处罚事实生成的合规解读,非监管原文。"
                 "扫描件原件无法可靠转 Word 的,按 PDF 原件附出。")
    lines.append("")

    # 总览
    by_source = {}
    for r in fresh:
        by_source[r["source"]] = by_source.get(r["source"], 0) + 1
    org = sum(1 for r in fresh if r.get("status") == "机构")
    lines.append("## 一、窗口期总览")
    lines.append("")
    lines.append("| 新增案例 | 机构/个人 | 按来源 |")
    lines.append("|---|---|---|")
    lines.append("| %d | 机构 %d、个人 %d | %s |" % (
        len(fresh), org, len(fresh) - org,
        "、".join("%s %d" % (k, v) for k, v in sorted(by_source.items(), key=lambda x: -x[1]))))
    lines.append("")

    # 案例明细(四段式)
    lines.append("## 二、案例明细")
    lines.append("")
    for i, (r, c) in enumerate(zip(fresh, cases), 1):
        lines.append("### 案例 %d:%s(%s)" % (i, r.get("subject", ""), r.get("date", "")))
        lines.append("")
        lines.append("**【来源】** %s;《%s》;[官方原文](%s)" % (c["source"], c["title"], c["url"]))
        if c["pdf"]:
            lines.append("")
            lines.append("原件为扫描版 PDF,无法可靠转 Word,按 PDF 原件附出:`%s`" % c["pdf"])
        lines.append("")
        lines.append("**【机构】** %s" % c["org"])
        lines.append("")
        lines.append("**【处罚措施】** %s" % c["measures"])
        lines.append("")
        lines.append("**【案例原文】**(%s,原文照搬)" % c["method_label"])
        lines.append("")
        for para in (c["body"] or "").split("\n"):
            para = para.strip()
            if para:
                lines.append(para)
                lines.append("")
        lines.append("**【自查启示】**(AI 基于处罚事实生成的解读,非监管原文)")
        lines.append("")
        for j, ins in enumerate(c["insights"], 1):
            line = "%d. **%s·%s**:%s" % (j, ins["tag"], ins["label"], ins["advice"])
            if ins.get("anchor"):
                line += "(本案锚点:「%s」)" % ins["anchor"]
            lines.append(line)
        lines.append("")
        lines.append("---")
        lines.append("")

    lines.append("*数据来源:中国证监会及派出机构、中国证券投资基金业协会官网公开信息。"
                 "本简报仅为合规研究参考,不构成任何建议。*")

    md = "\n".join(lines)
    md_path = os.path.join(out_dir, "briefing_%s.md" % today.strftime("%Y%m%d"))
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md)

    # ---------- DOCX ----------
    docx_path = None
    try:
        from docx import Document
        from docx.shared import Pt, RGBColor
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.oxml.ns import qn

        GRAY = RGBColor(0x88, 0x88, 0x88)
        RED = RGBColor(0xA3, 0x2D, 0x2D)

        def set_font(run, size=10.5, bold=False, color=None):
            run.font.size = Pt(size)
            run.font.bold = bold
            run.font.name = "Calibri"
            r = run._element.rPr.rFonts
            r.set(qn("w:eastAsia"), "微软雅黑")
            if color is not None:
                run.font.color.rgb = color

        doc = Document()
        h = doc.add_heading("", 0)
        run = h.add_run("私募基金监管处罚简报")
        set_font(run, 18, True)

        p = doc.add_paragraph()
        run = p.add_run("生成日期:%s | 统计窗口:近 %d 天 | 案例数:%d"
                        % (today.isoformat(), days, len(fresh)))
        set_font(run, 9, color=GRAY)

        note = doc.add_paragraph()
        run = note.add_run("体例说明:「来源/机构/处罚措施/案例原文」为监管公开信息原文照搬;"
                           "「自查启示」为基于处罚事实生成的合规解读,非监管原文;"
                           "扫描件原件无法可靠转 Word 的,按 PDF 原件附出。")
        set_font(run, 9, color=GRAY)

        doc.add_heading("一、窗口期总览", 1)
        t = doc.add_table(rows=2, cols=3)
        t.style = "Table Grid"
        for c, txt in zip(t.rows[0].cells, ["新增案例", "机构/个人", "按来源"]):
            run = c.paragraphs[0].add_run(txt)
            set_font(run, 10, True)
        row = t.rows[1].cells
        vals = [str(len(fresh)),
                "机构 %d、个人 %d" % (org, len(fresh) - org),
                "、".join("%s %d" % (k, v) for k, v in
                          sorted(by_source.items(), key=lambda x: -x[1]))]
        for cell, txt in zip(row, vals):
            run = cell.paragraphs[0].add_run(txt)
            set_font(run, 10)

        doc.add_heading("二、案例明细", 1)
        for i, (r, c) in enumerate(zip(fresh, cases), 1):
            doc.add_heading("案例 %d:%s(%s)" % (i, r.get("subject", ""), r.get("date", "")), 2)

            p = doc.add_paragraph()
            run = p.add_run("【来源】")
            set_font(run, 10.5, True)
            run = p.add_run("%s;《%s》;官方原文:%s" % (c["source"], c["title"], c["url"]))
            set_font(run, 10.5)
            if c["pdf"]:
                p = doc.add_paragraph()
                run = p.add_run("原件为扫描版 PDF,无法可靠转 Word,按 PDF 原件附出:%s" % c["pdf"])
                set_font(run, 9, color=GRAY)

            p = doc.add_paragraph()
            run = p.add_run("【机构】")
            set_font(run, 10.5, True)
            run = p.add_run(c["org"])
            set_font(run, 10.5)

            p = doc.add_paragraph()
            run = p.add_run("【处罚措施】")
            set_font(run, 10.5, True)
            run = p.add_run(c["measures"])
            set_font(run, 10.5, True, color=RED)

            p = doc.add_paragraph()
            run = p.add_run("【案例原文】(%s,原文照搬)" % c["method_label"])
            set_font(run, 10.5, True)
            for para in (c["body"] or "").split("\n"):
                para = para.strip()
                if not para:
                    continue
                p = doc.add_paragraph()
                run = p.add_run(para)
                set_font(run, 10.5)
                p.paragraph_format.space_after = Pt(2)

            p = doc.add_paragraph()
            run = p.add_run("【自查启示】(AI 基于处罚事实生成的解读,非监管原文)")
            set_font(run, 10.5, True, color=RED)
            for j, ins in enumerate(c["insights"], 1):
                line = "%d. %s·%s:%s" % (j, ins["tag"], ins["label"], ins["advice"])
                if ins.get("anchor"):
                    line += "(本案锚点:「%s」)" % ins["anchor"]
                p = doc.add_paragraph(style="List Number")
                run = p.add_run(line)
                set_font(run, 10)

        tail = doc.add_paragraph()
        run = tail.add_run("数据来源:中国证监会及派出机构、中国证券投资基金业协会官网公开信息。"
                           "本简报仅为合规研究参考,不构成任何建议。")
        set_font(run, 9, color=GRAY)

        docx_path = os.path.join(out_dir, "briefing_%s.docx" % today.strftime("%Y%m%d"))
        doc.save(docx_path)
    except ImportError:
        pass

    return md_path, docx_path, len(fresh)


# ---------------------------------------------------------------- 数据源网页

def _load_kb():
    """载入知识库索引(合规问答 400+ 场景)。缺失时返回空结构,网页仍可用。"""
    p = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "data", "kb_index.json")
    if not os.path.exists(p):
        return {"volumes": [], "entries": []}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"volumes": [], "entries": []}


# ---------------------------------------------------------------- 制度生成器内嵌

GEN_SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "generator", "output",
                       "私募证券基金管理人内控制度生成器.html")


def _scope_generator_css(css):
    """把生成器 CSS 机械地收进 #pGen 作用域,保证其渲染效果与独立单页完全一致。

    ★ 只做两种机械替换,不增删任何声明:
        :root{...}  →  #pGen{...}   变量改挂在 #pGen 上,靠继承覆盖生成器子树;
                                    工作台自己的 :root 变量不再被同名覆盖
                                    (两边只有 --bg/--line 同名但不同值)。
        body{...}   →  #pGen{...}   生成器的 body 规则原本会改掉整页背景/字体。
        其余每个选择器一律加 "#pGen " 前缀(header/.card/table.dept/…)。
      渲染等价性:生成器全部 DOM 都在 #pGen 内,变量继承与命中范围与独立页一致。
    """
    out = []
    for line in css.split("\n"):
        s = line.strip()
        if not s or s.startswith("/*") or s.startswith("@"):
            out.append(line)
            continue
        if "{" in s:
            head, _, tail = line.partition("{")
            sel = head.strip()
            parts = []
            for one in sel.split(","):
                one = one.strip()
                if one in (":root", "body"):
                    parts.append("#pGen")
                elif one == "*":
                    parts.append("#pGen *")
                else:
                    parts.append("#pGen " + one)
            out.append(", ".join(parts) + "{" + tail)
        else:
            out.append(line)
    text = "\n".join(out)
    # @media 单行规则的内层选择器(@media(max-width:1080px){.wrap{...}})
    text = re.sub(
        r"(@media[^{]+\{)\.wrap\{",
        r"\1#pGen .wrap{",
        text)
    return text


def _load_generator():
    """读取「内控制度生成器」单页,拆成 (CSS, JSON, JS, body) 供内嵌。

    内容零改动原则(详见 _scope_generator_css 与模板注释):
      - CSS :root/body 两个选择器机械换名 + 其余选择器加 #pGen 前缀;
      - JS 仅把 2 处 document.querySelectorAll(".tabs button") 收窄到 #pGen 内
        (否则生成器内部切换标签页会误改工作台顶栏的高亮);
      - body 与 platform-data JSON 完全原样。
    找不到源文件时返回空,工作台仍可正常产出(第三个标签页留空)。
    """
    if not os.path.exists(GEN_SRC):
        return "", "{}", "", ""
    try:
        with open(GEN_SRC, "r", encoding="utf-8") as f:
            raw = f.read()
    except Exception:
        return "", "{}", "", ""

    # ---- 1) 取 CSS,机械收进 #pGen 作用域(见函数文档) ----
    m_style = re.search(r"<style>(.*?)</style>", raw, re.S)
    css = _scope_generator_css(m_style.group(1)) if m_style else ""

    # ---- 2) 原样取 body ----
    m_body = re.search(r"<body[^>]*>(.*)</body>", raw, re.S)
    body = m_body.group(1).strip() if m_body else ""

    # ---- 3) 原样取 platform-data JSON ----
    m_data = re.search(r'<script id="platform-data" type="application/json">(.*?)</script>',
                       raw, re.S)
    gen_data = m_data.group(1).strip() if m_data else "{}"
    if m_data:
        body = body.replace(m_data.group(0), "")

    # ---- 4) 取主逻辑 JS(最后一个普通 <script>),连外层 <script> 标签一起保留 ----
    gen_js, m_js = "", None
    for mm in re.finditer(r"<script(?![^>]*platform-data)[^>]*>.*?</script>", body, re.S):
        m_js = mm
    if m_js:
        gen_js = m_js.group(0)          # 含 <script> … </script>
        body = body[:m_js.start()] + body[m_js.end():]

    # ---- 5) JS 唯一改动:把生成器内部的标签页切换收窄到 #pGen ----
    # 生成器 switchTab 与事件绑定用 document.querySelectorAll(".tabs button"),
    # 会把工作台顶栏的三个标签页按钮也抓进去(它们的 data-tab 为 null → 高亮被清掉)。
    # 收窄到 #pGen 后,在独立单页里命中的元素集合完全相同,行为不变。
    gen_js = gen_js.replace('document.querySelectorAll(".tabs button")',
                            'document.querySelectorAll("#pGen .tabs button")')

    return css, gen_data, gen_js, body.strip()


# ---------------------------------------------------------------- 绩效分析平台内嵌
# 方式:iframe srcdoc 原样内嵌(不是 CSS 作用域收拢)。
# 理由:绩效分析平台是独立的 React + Tailwind SPA,自带成千上万个全局原子类
#       (.flex/.p-4/.text-sm…)与一个 :root 变量体系。若像制度生成器那样用「选择器加
#       #pPerf 前缀」机械收拢,Tailwind 的 @media/伪类内层选择器无法被逐行收拢、会漏成
#       全局类污染工作台;反之工作台自己的 .card/.tab 等类若同名也会进 SPA。iframe 让两边
#       处于「两个独立文档」,样式与脚本天然零交叉 —— 同时满足「原封不动」与「不破坏原有
#       平台页面和数据」两条硬要求。源文件为全内联单页(无 ./assets 外链),离线 srcdoc 可用。

PERF_SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "performance", "output",
                       "绩效分析平台.html")


def _load_performance():
    """读取「绩效分析平台」单页,返回可直接塞进 <iframe srcdoc="..."> 的转义字符串。

    转义原则(属性值以双引号定界,故只需处理两字符):
      - & → &amp;   (否则 JS 里的 &&、URL 里的 & 会被 HTML 解析成实体引用)
      - " → &quot;  (属性定界符,必须转义)
      - 换行在属性值中合法,无需转义;对 </iframe 做防御性改写,避免极少数情况下提前闭合。
    找不到源文件时返回空字符串,工作台仍可正常产出(第四个标签页留空 iframe)。
    """
    if not os.path.exists(PERF_SRC):
        return ""
    try:
        with open(PERF_SRC, "r", encoding="utf-8") as f:
            raw = f.read()
    except Exception:
        return ""
    srcdoc = raw.replace("&", "&amp;").replace('"', "&quot;")
    srcdoc = re.sub(r"(?i)</iframe", "<\\/iframe", srcdoc)
    return srcdoc


def build_html(records, out_path=None):
    out_path = out_path or os.path.join(OUTPUT_DIR, "penalties.html")
    today = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    gen_css, gen_data, gen_js, gen_body = _load_generator()
    perf_src = _load_performance()

    doctrine = build_all_doctrine(records, min_cases=2)

    slim = []
    for r in records:
        slim.append({
            "uid": r["uid"],
            "date": r.get("date", ""),
            "source": r.get("source", ""),
            "title": r.get("title", ""),
            "subject": r.get("subject", ""),
            "region": r.get("region", ""),
            "status": r.get("status", ""),
            "tags": r.get("tags", []),
            "measures": r.get("measures", []),
            "amount": r.get("amount_wan", 0),
            "url": r.get("url", ""),
            "summary": r.get("summary", ""),
            "body": (r.get("body") or "")[:12000],
            "body_status": r.get("body_status", ""),
            "extract_method": r.get("extract_method", ""),
            "insights": build_insights(r),
            "law_anchors": extract_law_anchors(r.get("body")),
            "doctrine": doctrine.get((r.get("subject") or "").strip(), None),
            "is_new": bool(r.get("is_new")),
        })

    kb = _load_kb()
    kb_slim = [{"i": e["id"], "v": e["volName"], "n": e["num"], "c": e.get("cat", ""),
                "t": e["title"], "x": e["text"], "l": e["chars"]}
               for e in kb.get("entries", [])]
    kb_vols = kb.get("volumes", [])

    data_json = json.dumps(slim, ensure_ascii=False).replace("</", "<\\/")
    kb_json = json.dumps(kb_slim, ensure_ascii=False).replace("</", "<\\/")
    kbv_json = json.dumps(kb_vols, ensure_ascii=False).replace("</", "<\\/")
    # 生成器的 JSON 原样来自源文件,同样要防 </script> 提前闭合
    gen_data = gen_data.replace("</", "<\\/")

    page = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>私募基金工作台 · 监管爬虫锚点解读 · 制度生成器 · 绩效分析 · 运管投知识库</title>
<style>
:root{
  --bg:#f6f7f9; --card:#ffffff; --ink:#1f2329; --muted:#6b7280;
  --line:#e5e7eb; --blue:#185fa5; --blue-bg:#e6f1fb;
  --red:#a32d2d; --red-bg:#fcebeb; --amber:#854f0b; --amber-bg:#faeeda;
  --green:#0f6e56; --green-bg:#e1f5ee; --purple:#534ab7; --purple-bg:#eeedfe;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.6}
body>.wrap{max-width:1180px;margin:0 auto;padding:20px}
body>.wrap>h1{font-size:20px;font-weight:600;margin-bottom:4px}
body>.wrap>.sub{color:var(--muted);font-size:12px;margin-bottom:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat .n{font-size:22px;font-weight:600}
.stat .l{font-size:12px;color:var(--muted)}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;align-items:center}
.toolbar input[type=search]{flex:1;min-width:220px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:13px;outline:none}
.toolbar input[type=search]:focus{border-color:var(--blue)}
select{padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;background:var(--card);outline:none}
:where(#pCases,#pKb) table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
:where(#pCases,#pKb) thead th{background:#fafbfc;text-align:left;padding:10px 12px;font-size:12px;color:var(--muted);font-weight:500;border-bottom:1px solid var(--line);white-space:nowrap}
:where(#pCases,#pKb) tbody td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:13px}
:where(#pCases,#pKb) tbody tr:hover{background:#fafbfc}
:where(#pCases,#pKb) tbody tr.main-row{cursor:pointer}
:where(#pCases) .badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;margin:1px 2px 1px 0;white-space:nowrap}
.b-blue{background:var(--blue-bg);color:var(--blue)}
.b-red{background:var(--red-bg);color:var(--red)}
.b-amber{background:var(--amber-bg);color:var(--amber)}
.b-green{background:var(--green-bg);color:var(--green)}
.b-purple{background:var(--purple-bg);color:var(--purple)}
.b-gray{background:#f1efe8;color:#5f5e5a}
.new-dot{color:var(--red);font-weight:600;margin-left:4px}
.detail-row td{background:#fafbfc;padding:0}
.detail-box{padding:14px 18px;display:none}
.detail-box.open{display:block}
.detail-box h3{font-size:14px;margin-bottom:8px}
.detail-box .meta{font-size:12px;color:var(--muted);margin-bottom:8px}
.detail-box pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:13px;max-height:420px;overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
.detail-box a{color:var(--blue);text-decoration:none}
.orig-tag{display:inline-block;font-size:11px;color:var(--green);background:var(--green-bg);border-radius:6px;padding:2px 8px;margin-bottom:6px}
.insights{margin-top:10px;background:var(--amber-bg);border:1px solid #f0dcb8;border-radius:8px;padding:10px 14px}
.insights .ins-title{font-size:12px;font-weight:600;color:var(--amber);margin-bottom:6px}
.insights ol{margin-left:18px;font-size:12.5px}
.insights li{margin-bottom:4px}
.insights .anchor{color:var(--muted);font-size:11.5px;margin-top:2px}
.lawbox{margin-top:10px;background:var(--purple-bg);border:1px solid #d9d6f7;border-radius:8px;padding:10px 14px}
.lawbox .law-title{font-size:12px;font-weight:600;color:var(--purple);margin-bottom:6px}
.lawbox ul{margin-left:16px;font-size:12.5px;list-style:none}
.lawbox li{margin-bottom:6px;padding-left:0}
.lawbox .la{display:inline-block;background:var(--card);border:1px solid #d9d6f7;border-radius:5px;padding:1px 7px;margin-right:6px;font-weight:600;color:var(--purple);font-size:11.5px}
.lawbox .le{color:var(--ink)}
.lawbox .lq{color:var(--muted);font-size:11.5px;margin-top:2px;border-left:2px solid #d9d6f7;padding-left:8px}
.doctrine{margin-top:10px;background:var(--red-bg);border:1px solid #f3c9c9;border-radius:8px;padding:10px 14px}
.doctrine .dc-title{font-size:12px;font-weight:600;color:var(--red);margin-bottom:6px}
.doctrine .dc-body{font-size:12.5px}
.doctrine .dc-path{margin-top:6px;font-size:11.5px;color:var(--muted)}
.doctrine .dc-path span{display:inline-block;background:var(--card);border:1px solid #f3c9c9;border-radius:5px;padding:1px 7px;margin:2px 4px 2px 0}
.legend{font-size:11.5px;color:var(--muted);margin:-6px 0 12px}
body>.wrap>.tabs{display:flex;gap:4px;margin:0 0 14px;border-bottom:1px solid var(--line)}
body>.wrap>.tabs .tab{padding:9px 18px;font-size:13.5px;cursor:pointer;border:none;background:none;color:var(--muted);border-bottom:2px solid transparent;font-family:inherit}
body>.wrap>.tabs .tab:hover{color:var(--ink)}
body>.wrap>.tabs .tab.on{color:var(--blue);border-bottom-color:var(--blue);font-weight:500}
body>.wrap>.tabs .tab .cnt{font-size:11.5px;color:var(--muted);margin-left:4px}
body>.wrap>.pane{display:none}
body>.wrap>.pane.on{display:block}
.kb-row{cursor:pointer}
.kb-detail td{background:#fafbfc;padding:0}
.kb-detail .kbox{padding:14px 18px;display:none}
.kb-detail .kbox.open{display:block}
.kbox pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:13px;max-height:520px;overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin-top:8px}
.kb-cat{display:inline-block;background:var(--blue-bg);color:var(--blue);border-radius:5px;padding:1px 7px;font-size:11px;margin-left:6px}
.kb-meta{font-size:12px;color:var(--muted);margin-top:4px}
.kb-hit{background:#fff6d6;border-radius:3px;padding:0 1px}
.volchips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.volchip{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:3px 11px;font-size:12px;color:var(--muted)}
.empty-tip{padding:40px;text-align:center;color:var(--muted)}
.foot{color:var(--muted);font-size:12px;margin-top:14px;text-align:center}
/* ============================================================================
   工作台自身样式的收窄(双向隔离的另一半):
   生成器内嵌在 #pGen 里,它内部的 .wrap/.pane/.tabs/table/thead/tbody/.badge
   与工作台同名 —— 上面这些宽选择器若保持原样,会污染生成器(例如 .pane{display:none}
   会把生成器左栏整个藏掉、table 边框会画到生成器的表格上)。
   因此全部收窄到工作台自己的结构上;:where() 保持原有优先级,不影响内部级联。
   生成器一侧的隔离见 #pGen 面板注释(其 CSS 已整体收进 #pGen 作用域)。
   ========================================================================== */
</style>
</head>
<body>
<div class="wrap">
<h1>私募基金工作台 · 监管爬虫锚点解读 · 制度生成器 · 绩效分析 · 运管投知识库</h1>
<div class="sub">数据源:证监会及派出机构、中基协官网 · 生成时间 __GEN__ · 案例 __TOTAL__ 条 · 合规问答 __KBTOTAL__ 场景</div>

<div class="tabs">
<button class="tab on" data-pane="pCases">监管案例库<span class="cnt">__TOTAL__</span></button>
<button class="tab" data-pane="pKb">合规问答库<span class="cnt">__KBTOTAL__</span></button>
<button class="tab" data-pane="pGen">制度生成器</button>
<button class="tab" data-pane="pPerf">绩效分析</button>
</div>

<div class="pane on" id="pCases">
<div class="stats" id="stats"></div>
<div class="toolbar">
<input type="search" id="q" placeholder="搜索当事人 / 标题 / 正文关键词 / 法规条款(如 第二十四条)…">
<select id="fSource"><option value="">全部来源</option></select>
<select id="fStatus"><option value="">机构+个人</option><option>机构</option><option>个人</option></select>
<select id="fTag"><option value="">全部违规类型</option></select>
<select id="fMeasure"><option value="">全部处分措施</option></select>
<select id="fLaw"><option value="">全部援引法规</option></select>
<button id="btnRepeat" type="button" style="padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);font-size:13px;cursor:pointer">只看重复受罚主体</button>
</div>
<div class="legend">展开任一案例可看三层解读:【法规条款锚点】本案援引的条文+要点 · 【案例法锚点】该主体历史受罚与处分升级轨迹 · 【自查启示】同类问题自查建议。三层均为 AI 解读,非监管原文。</div>
<table>
<thead><tr><th style="width:86px">日期</th><th>当事人 / 标题</th><th style="width:150px">来源</th><th style="width:170px">违规类型</th><th style="width:170px">处分措施</th><th style="width:80px">状态</th></tr></thead>
<tbody id="tbody"></tbody>
</table>
<div class="foot">点击行展开正文 · 数据仅来自公开渠道,供合规研究参考</div>
</div>

<div class="pane" id="pKb">
<div class="volchips" id="volChips"></div>
<div class="toolbar">
<input type="search" id="kq" placeholder="搜索合规问题 / 关键词 / 法规名称(如 冷静期、双25%、业绩报酬、估值复核、现场检查)…">
<select id="kVol"><option value="">全部主题</option></select>
<select id="kCat"><option value="">全部分类</option></select>
</div>
<div class="legend">合规问答库按七类主题重组,每条含「明确结论 / 法规依据 → 实操步骤 / 举例说明 → 特殊情况 / 踩坑点」。内容为知识库原文,直接可落地。</div>
<table>
<thead><tr><th style="width:74px">编号</th><th>问题</th><th style="width:150px">主题</th><th style="width:80px">篇幅</th></tr></thead>
<tbody id="kbBody"></tbody>
</table>
<div class="foot">点击行展开完整问答 · 场景保留原汇编编号,便于回溯来源</div>
</div>

<div class="pane" id="pGen">
<!-- ===== 内控制度生成器(自 generator/output/ 原样搬入) ===== -->
<!-- CSS:仅把 :root/body 两个选择器机械换名为 #pGen、其余选择器加 #pGen 前缀,
        声明一字未动,渲染效果与独立单页一致;变量挂在 #pGen 上,不再覆盖工作台 -->
<style>__GENCSS__</style>
__GENBODY__
<script id="platform-data" type="application/json">__GENDATA__</script>
</div>

<div class="pane" id="pPerf">
<!-- ===== 绩效分析平台(自 performance/output/ 原样内嵌,iframe srcdoc 零改动、双向隔离) ===== -->
<iframe id="perfFrame" srcdoc="__PERFSRC__" title="绩效分析平台" style="width:100%;min-height:900px;border:0;display:block;background:#fff"></iframe>
</div>
</div>
<script>
const DATA = __DATA__;
const $ = s => document.querySelector(s);
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function measureBadge(m){
  const heavy=["撤销管理人登记","暂停备案","罚款","市场禁入","取消从业资格"];
  return '<span class="badge '+(heavy.includes(m)?'b-red':'b-amber')+'">'+esc(m)+'</span>';
}
function tagBadge(t){
  const map={"募集与适当性":"b-blue","信息披露":"b-purple","投资运作":"b-green","内控与治理":"b-amber","侵占挪用":"b-red","登记备案":"b-blue","从业资格":"b-gray","违规减持":"b-red","其他":"b-gray"};
  return '<span class="badge '+(map[t]||'b-gray')+'">'+esc(t)+'</span>';
}
function statusBadge(r){
  if(r.body_status==='ok') return '<span class="badge b-green">'+(r.extract_method==='agent_vision'?'已转录':(r.extract_method==='ocr'?'OCR':'完整'))+'</span>';
  if(r.body_status==='pending_ocr') return '<span class="badge b-amber">待转录</span>';
  if(r.body_status.startsWith('error')) return '<span class="badge b-red">失败</span>';
  return '<span class="badge b-gray">'+esc(r.body_status||'—')+'</span>';
}
function initFilters(){
  const srcs=[...new Set(DATA.map(d=>d.source))].sort();
  const tags=[...new Set(DATA.flatMap(d=>d.tags))].sort();
  const ms=[...new Set(DATA.flatMap(d=>d.measures))].sort();
  const laws=[...new Set(DATA.flatMap(d=>(d.law_anchors||[]).map(a=>a.law)))].sort();
  srcs.forEach(s=>$('#fSource').insertAdjacentHTML('beforeend','<option>'+esc(s)+'</option>'));
  tags.forEach(s=>$('#fTag').insertAdjacentHTML('beforeend','<option>'+esc(s)+'</option>'));
  ms.forEach(s=>$('#fMeasure').insertAdjacentHTML('beforeend','<option>'+esc(s)+'</option>'));
  laws.forEach(s=>$('#fLaw').insertAdjacentHTML('beforeend','<option>'+esc(s)+'</option>'));
}
let onlyRepeat=false;
function renderStats(rows){
  const total=DATA.length, fresh=rows.length;
  const newToday=DATA.filter(d=>d.is_new).length;
  const okN=DATA.filter(d=>d.body_status==='ok').length;
  const org=rows.filter(d=>d.status==='机构').length;
  const rep=DATA.filter(d=>d.doctrine).length;
  const lawN=DATA.filter(d=>(d.law_anchors||[]).length).length;
  $('#stats').innerHTML=
    '<div class="stat"><div class="n">'+fresh+'</div><div class="l">筛选结果</div></div>'+
    '<div class="stat"><div class="n">'+total+'</div><div class="l">台账总量</div></div>'+
    '<div class="stat"><div class="n" style="color:var(--purple)">'+lawN+'</div><div class="l">含法规锚点</div></div>'+
    '<div class="stat"><div class="n" style="color:var(--red)">'+rep+'</div><div class="l">重复受罚主体</div></div>'+
    '<div class="stat"><div class="n" style="color:var(--green)">'+okN+'</div><div class="l">正文完整</div></div>'+
    '<div class="stat"><div class="n">'+org+'</div><div class="l">涉机构案例</div></div>';
}
function lawHtml(d){
  const a=d.law_anchors||[];
  if(!a.length)return '';
  return '<div class="lawbox"><div class="law-title">法规条款锚点(AI 归纳条文要点,非监管原文)</div><ul>'+
    a.map(x=>'<li><span class="la">'+esc(x.law)+' '+(x.article?esc(x.article):'—')+'</span>'+
      '<span class="le">'+esc(x.essence)+'</span>'+
      (x.quote?'<div class="lq">本案援引:'+esc(x.quote)+'</div>':'')+'</li>').join('')+'</ul></div>';
}
function doctrineHtml(d){
  const t=d.doctrine;
  if(!t)return '';
  const path=(t.path||[]).map(p=>'<span>'+esc(p.date)+' · '+esc(p.measure)+'</span>').join('');
  return '<div class="doctrine"><div class="dc-title">案例法锚点 · 该主体历史受罚(AI 解读,非监管原文)</div>'+
    '<div class="dc-body">'+esc(t.doctrine)+'</div>'+
    (path?'<div class="dc-path">处分轨迹:'+path+'</div>':'')+'</div>';
}
function render(){
  const q=$('#q').value.trim().toLowerCase();
  const fs=$('#fSource').value, fp=$('#fStatus').value, ft=$('#fTag').value,
        fm=$('#fMeasure').value, fl=$('#fLaw').value;
  const rows=DATA.filter(d=>{
    if(onlyRepeat&&!d.doctrine)return false;
    if(fs&&d.source!==fs)return false;
    if(fp&&d.status!==fp)return false;
    if(ft&&!d.tags.includes(ft))return false;
    if(fm&&!d.measures.includes(fm))return false;
    if(fl&&!(d.law_anchors||[]).some(a=>a.law===fl))return false;
    if(q){
      const lawBlob=(d.law_anchors||[]).map(a=>a.law+' '+a.article+' '+a.essence).join(' ');
      const docBlob=d.doctrine?d.doctrine.doctrine:'';
      const blob=(d.subject+' '+d.title+' '+d.summary+' '+d.body+' '+(d.tags||[]).join(' ')+' '+lawBlob+' '+docBlob).toLowerCase();
      if(!blob.includes(q))return false;
    }
    return true;
  }).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  renderStats(rows);
  const tb=$('#tbody'); tb.innerHTML='';
  if(!rows.length){tb.innerHTML='<tr><td colspan="6"><div class="empty-tip">无匹配记录</div></td></tr>';return}
  rows.forEach((d,i)=>{
    const tr=document.createElement('tr');
    tr.className='main-row';
    const warn=d.doctrine?'<span class="badge b-red" title="该主体存在多次受罚记录">重复受罚×'+d.doctrine.cases+'</span>':'';
    tr.innerHTML='<td>'+(d.date||'—')+'</td>'+
      '<td><b>'+esc(d.subject)+'</b>'+(d.is_new?'<span class="new-dot">NEW</span>':'')+warn+
        '<div style="color:var(--muted);font-size:12px">'+esc(d.title)+'</div></td>'+
      '<td style="font-size:12px">'+esc(d.source)+'</td>'+
      '<td>'+(d.tags||[]).map(tagBadge).join('')+'</td>'+
      '<td>'+(d.measures||[]).map(measureBadge).join('')+'</td>'+
      '<td>'+statusBadge(d)+'</td>';
    const dr=document.createElement('tr');
    dr.className='detail-row';
    let insHtml='';
    if(d.insights&&d.insights.length){
      insHtml='<div class="insights"><div class="ins-title">自查启示(AI 基于处罚事实生成的解读,非监管原文)</div><ol>'+
        d.insights.map(i=>'<li><b>'+esc(i.tag)+'·'+esc(i.label)+'</b>:'+esc(i.advice)+
          (i.anchor?'<div class="anchor">本案锚点:'+esc(i.anchor)+'</div>':'')+'</li>').join('')+'</ol></div>';
    }
    dr.innerHTML='<td colspan="6"><div class="detail-box" id="dt'+i+'">'+
      '<h3>'+esc(d.title)+'</h3>'+
      '<div class="meta">当事人: '+esc(d.subject)+' | 辖区: '+esc(d.region)+' | 主体: '+esc(d.status)+
        (d.amount?' | 涉及金额: '+d.amount+' 万元':'')+' | <a href="'+esc(d.url)+'" target="_blank">查看原文 ↗</a></div>'+
      lawHtml(d)+
      '<div class="orig-tag">案例原文(原文照搬)</div>'+
      '<pre>'+esc(d.body|| d.summary || '(暂无正文)')+'</pre>'+
      doctrineHtml(d)+insHtml+'</div></td>';
    tr.addEventListener('click',()=>{
      document.querySelectorAll('.detail-box.open').forEach(x=>{if(x.id!=='dt'+i)x.classList.remove('open')});
      $('#dt'+i).classList.toggle('open');
    });
    tb.appendChild(tr); tb.appendChild(dr);
  });
}
['q','fSource','fStatus','fTag','fMeasure','fLaw'].forEach(id=>{
  $('#'+id).addEventListener(id==='q'?'input':'change',render);
});
$('#btnRepeat').addEventListener('click',()=>{
  onlyRepeat=!onlyRepeat;
  $('#btnRepeat').style.background=onlyRepeat?'var(--red-bg)':'var(--card)';
  $('#btnRepeat').style.borderColor=onlyRepeat?'var(--red)':'var(--line)';
  render();
});
initFilters(); render();

const KB = __KB__;
const KBV = __KBV__;
function kbEsc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function kbHi(s,q){
  const e=kbEsc(s);
  if(!q)return e;
  try{
    const r=new RegExp('('+q.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')+')','gi');
    return e.replace(r,'<span class="kb-hit">$1</span>');
  }catch(err){return e}
}
function initKb(){
  const vs=[...new Set(KB.map(d=>d.v))];
  vs.forEach(s=>$('#kVol').insertAdjacentHTML('beforeend','<option>'+kbEsc(s)+'</option>'));
  const cs=[...new Set(KB.map(d=>d.c).filter(Boolean))].sort();
  cs.forEach(s=>$('#kCat').insertAdjacentHTML('beforeend','<option>'+kbEsc(s)+'</option>'));
  $('#volChips').innerHTML=KBV.map(v=>'<span class="volchip">'+kbEsc(v.name)+' · '+v.count+'</span>').join('')+
    '<span class="volchip" style="border-color:var(--blue);color:var(--blue)">合计 '+KB.length+' 条</span>';
}
function renderKb(){
  const q=$('#kq').value.trim(), fv=$('#kVol').value, fc=$('#kCat').value;
  const ql=q.toLowerCase();
  let rows=KB.filter(d=>{
    if(fv&&d.v!==fv)return false;
    if(fc&&d.c!==fc)return false;
    if(ql){
      const blob=(d.t+' '+d.c+' '+d.x+' '+d.v+' 场景'+d.n).toLowerCase();
      if(!blob.includes(ql))return false;
    }
    return true;
  });
  if(ql) rows.sort((a,b)=>{
    const at=(a.t.toLowerCase().includes(ql)?0:1), bt=(b.t.toLowerCase().includes(ql)?0:1);
    if(at!==bt)return at-bt;
    return a.l-b.l;
  });
  const tb=$('#kbBody'); tb.innerHTML='';
  if(!rows.length){tb.innerHTML='<tr><td colspan="4"><div class="empty-tip">无匹配问答</div></td></tr>';return}
  const cap=rows.slice(0,400);
  cap.forEach((d,i)=>{
    const tr=document.createElement('tr');
    tr.className='main-row kb-row';
    tr.innerHTML='<td style="font-size:12px;color:var(--muted)">场景'+kbEsc(d.n)+'</td>'+
      '<td><b>'+kbHi(d.t,q)+'</b>'+(d.c?'<span class="kb-cat">'+kbEsc(d.c)+'</span>':'')+'</td>'+
      '<td style="font-size:12px">'+kbEsc(d.v)+'</td>'+
      '<td style="font-size:12px;color:var(--muted)">'+d.l+' 字</td>';
    const dr=document.createElement('tr');
    dr.className='kb-detail';
    dr.innerHTML='<td colspan="4"><div class="kbox" id="kbx'+i+'">'+
      '<h3 style="font-size:14px;margin-bottom:4px">'+kbEsc(d.t)+'</h3>'+
      '<div class="kb-meta">'+kbEsc(d.v)+(d.c?' · '+kbEsc(d.c):'')+' · 原编号 场景'+kbEsc(d.n)+'</div>'+
      '<pre>'+kbHi(d.x,q)+'</pre></div></td>';
    tr.addEventListener('click',()=>{
      document.querySelectorAll('.kbox.open').forEach(x=>{if(x.id!=='kbx'+i)x.classList.remove('open')});
      $('#kbx'+i).classList.toggle('open');
    });
    tb.appendChild(tr); tb.appendChild(dr);
  });
  if(rows.length>cap.length){
    tb.insertAdjacentHTML('beforeend','<tr><td colspan="4" style="text-align:center;color:var(--muted);font-size:12px;padding:12px">共 '+rows.length+' 条匹配,已显示前 '+cap.length+' 条,请细化关键词</td></tr>');
  }
}
['kq','kVol','kCat'].forEach(id=>{
  $('#'+id).addEventListener(id==='kq'?'input':'change',renderKb);
});
document.querySelectorAll('.tab').forEach(t=>{
  t.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
    document.querySelectorAll('.pane').forEach(x=>x.classList.remove('on'));
    t.classList.add('on');
    document.getElementById(t.dataset.pane).classList.add('on');
    // 切到制度生成器 / 绩效分析时,把外层滚动位置重置,避免带着案例库的滚动偏移进来
    if(t.dataset.pane==='pGen' || t.dataset.pane==='pPerf'){ window.scrollTo(0,0); }
  });
});
initKb(); renderKb();
</script>
__GENJS__
</body>
</html>"""
    page = page.replace("__DATA__", data_json)
    page = page.replace("__KB__", kb_json)
    page = page.replace("__KBV__", kbv_json)
    page = page.replace("__GEN__", today)
    page = page.replace("__TOTAL__", str(len(records)))
    page = page.replace("__KBTOTAL__", str(len(kb_slim)))
    page = page.replace("__GENDATA__", gen_data)
    page = page.replace("__GENJS__", gen_js)
    page = page.replace("__GENCSS__", gen_css)
    page = page.replace("__GENBODY__", gen_body)
    page = page.replace("__PERFSRC__", perf_src)

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(page)
    return out_path


# ---------------------------------------------------------------- 入口

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    args = ap.parse_args()

    ledger = load_ledger()
    records = ledger.get("records", [])
    log("台账记录: %d 条" % len(records))

    md_path, docx_path, fresh_n = build_briefing(records, days=args.days)
    log("简报(MD): %s(窗口内 %d 条)" % (md_path, fresh_n))
    if docx_path:
        log("简报(DOCX): %s" % docx_path)

    html_path = build_html(records)
    log("数据源网页: %s" % html_path)

    # 汇总正文质量
    from collections import Counter
    st = Counter(body_status_label(r) for r in records)
    log("正文状态分布: %s" % dict(st))


if __name__ == "__main__":
    main()
