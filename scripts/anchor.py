# -*- coding: utf-8 -*-
"""锚点解读引擎。

在既有 report.py 的"标签共性建议 + 本案事实锚点"之上，新增两层：

1. 法规条款锚点(anchor)
   从处罚原文中抽取被援引的法律/法规/自律规则条款，按条款号排序去重，
   给出该条"精要"（AI 归纳，非监管原文）与"本案援引语境"（原文句子照搬）。

2. 案例法锚点(doctrine)
   按当事人(机构名/人名)聚合其全部历史处罚案例，输出：
     - 累犯标记：同一主体被不同监管机构(或同机构多次)处分 ≥2 次的次数与机关
     - 升级轨迹：处分措施由轻到重的演进(如 警告 → 公开谴责 → 暂停备案 → 撤销管理人登记)
     - 常踩红线：该主体反复出现的违规类型标签
   "同类问题被反复处罚"是合规风险最强的信号，单独成块呈现。

两者均为 AI 解读，输出时必须标注"非监管原文"。
"""
import re
import datetime

# ---------------------------------------------------------------- 法规条款库
# 键为法规简称的正则,值 = (规范名称, {条款号正则: 精要})
# 精要为 AI 归纳的条文要点,引用时须标注非原文。
LAW_CATALOG = [
    (r"《中华人民共和国证券投资基金法》|《基金法》",
     "《证券投资基金法》", {
         r"第(?:一|1)百(?:二|二十)?[一-十]*条": "基金管理人应当履行受托职责,不得将管理职责让渡他人",
         r"第八十三条|第八十四": "基金管理人、托管人等违反规定的,处责令改正、警告、罚款等处罚",
         r"第一百[二三]十[一二三]?条": "违反基金法规定的行政处罚措施与幅度",
     }),
    (r"《私募投资基金监督管理暂行办法》|《私募基金监管办法》",
     "《私募投资基金监督管理暂行办法》", {
         r"^第[三四五六七八九十]+条$": "私募基金不得公开宣传推介,不得向不特定对象募集,不得向投资者承诺保本保收益",
         r"^第十[一二]条$": "合格投资者标准:净资产不低于1000万元的单位;金融资产不低于300万元或最近三年年均收入不低于50万元的个人",
         r"^第十[五六]七条$": "募集机构应履行特定对象确定、投资者适当性与风险揭示程序,不得拆分转让规避合格投资者要求",
         r"^第二十[一二]条$": "私募基金管理人应当遵守合同约定,履行诚实信用、谨慎勤勉义务",
         r"^第二十三条$": "私募基金管理人禁止行为:将投资管理职责让渡他人、不公平对待所管理的基金财产、以基金财产为关联方牟利等",
         r"^第二十四条$": "私募基金管理人应当按规定向投资者如实披露基金投资、资产负债、投资收益分配、可能存在的利益冲突等信息",
         r"^第二十五条$": "私募基金管理人应当按规定向基金业协会报送信息,并保证所报送信息的真实、准确、完整",
         r"^第二十六条$": "私募基金管理人应当妥善保存基金投资决策、交易与投资者适当性管理等业务资料",
         r"^第二十七条$": "协会对私募基金管理人实行自律管理,可采取自律管理措施与纪律处分",
         r"^第三十[三四五六七八]条$": "违反规定的监管措施与行政处罚",
     }),
    (r"《证券期货经营机构私募资产管理业务运作管理暂行规定》",
     "《证券期货经营机构私募资产管理业务运作管理暂行规定》", {
         r"第[一二三四五六七八九十]+条": "资管业务的结构化杠杆、投顾资质与通道业务禁止要求",
     }),
    (r"《关于加强私募投资基金监管的若干规定》",
     "《关于加强私募投资基金监管的若干规定》", {
         r"第[一二三四五六七八九十]+条": "私募基金登记备案、募集、投资运作的管理要求与禁止行为",
     }),
    (r"《中国证券投资基金业协会自律管理和纪律处分措施实施办法》|《实施办法》",
     "《中国证券投资基金业协会自律管理和纪律处分措施实施办法》", {
         r"第[一二三四五六七八九十]+条": "协会自律管理措施与纪律处分的种类、适用与程序",
     }),
    (r"《中国证券投资基金业协会会员管理办法》",
     "《中国证券投资基金业协会会员管理办法》", {
         r"第[一二三四五六七八九十]+条": "会员资格取得、终止与相关自律要求",
     }),
    (r"《私募投资基金管理人登记和基金备案办法(?:\(试行\))》|《登记备案办法》",
     "《私募投资基金管理人登记和基金备案办法》", {
         r"第[一二三四五六七八九十]+条": "管理人登记、重大事项变更与产品备案的报送要求与时限",
     }),
    (r"《证券期货投资者适当性管理办法》",
     "《证券期货投资者适当性管理办法》", {
         r"第[一二三四五六七八九十]+条": "投资者分类、产品分级与适当性匹配要求",
     }),
    (r"《私募投资基金募集行为管理办法》|《募集行为管理办法》",
     "《私募投资基金募集行为管理办法》", {
         r"第[一二三四五六七八九十]+条": "募集流程:特定对象确定、风险揭示、合格投资者确认、冷静期与回访",
     }),
    (r"《中华人民共和国证券法》",
     "《证券法》", {
         r"第[一二三四五六七八九十百]+条": "证券市场信息披露、交易行为与相应法律责任",
     }),
]

# 处分措施严重度排序(用于生成升级轨迹)
MEASURE_SEVERITY = [
    "监管谈话", "出具警示函", "警告", "责令改正", "罚款", "公开谴责",
    "列入黑名单", "取消从业资格", "暂停备案", "市场禁入", "撤销管理人登记",
]

# 法规名 → 条款精要表(供按名查用)
LAW_CATALOG_BY_NAME = {name: art for _, name, art in LAW_CATALOG}


def _sev(m):
    try:
        return MEASURE_SEVERITY.index(m)
    except ValueError:
        return -1


# 句中条款写法兼容:第X条 / 第X条第一款 / 第X、Y条 / 第X条至第Y条
CITE_RE = r"第\s*[一二三四五六七八九十百零〇\d]+\s*条(?:\s*第[一二三四五六七八九十\d]+款)?"


def extract_law_anchors(body, max_n=8):
    """从处罚原文抽取被援引的法规与条款锚点。

    返回 [{law, article, essence, quote}] 列表:
      law     规范名称
      article 条款号(如"第二十四条")
      essence 该条精要(AI 归纳,非原文)
      quote   本案援引该条的原文句子(照搬)
    """
    text = (body or "").strip()
    if not text:
        return []

    out, seen = [], set()
    sents = [s.strip() for s in re.split(r"[。\n]", text) if len(s.strip()) >= 6]

    # 记录每个法规名在全文中出现的所有位置
    hits = []   # (pos, law_name, law_re)
    for law_re, law_name, _ in LAW_CATALOG:
        for m in re.finditer(law_re, text):
            hits.append((m.start(), law_name, law_re))
    hits.sort()

    if not hits:
        return []

    # 对每个法规名出现点,取"从该点到下一个法规名"之间的文本作为其归属区间,
    # 区间内的条款号即归属该法规。这正对应原文
    # 「《若干规定》第十二条、《备案登记办法》第四条、《私募基金监管办法》第二十四条」
    # 的顿号串联写法。
    for idx, (pos, law_name, law_re) in enumerate(hits):
        end = hits[idx + 1][0] if idx + 1 < len(hits) else min(len(text), pos + 200)
        seg = text[pos:end]
        # 区间内只保留到第一个句号/分号为止,防止跨句吸收
        seg = re.split(r"[。；;]", seg)[0]
        # 引用语:该法规名所在整句
        sent_start = text.rfind("。", 0, pos) + 1
        sent_end = text.find("。", pos)
        if sent_end == -1:
            sent_end = min(len(text), pos + 260)
        sent = text[sent_start:sent_end].strip()[:240]

        articles = dict(LAW_CATALOG_BY_NAME).get(law_name, {})
        got = False
        for m in re.finditer(CITE_RE, seg):
            art = re.sub(r"\s+", "", m.group(0))
            key = (law_name, art)
            if key in seen:
                continue
            seen.add(key)
            essence = ""
            for pat, val in articles.items():
                if re.search(pat, art):
                    essence = val
                    break
            if not essence:
                essence = "该条规定了本领域的合规义务与违反后的责任"
            out.append({"law": law_name, "article": art,
                        "essence": essence, "quote": sent})
            got = True
        if not got:
            # 该法规名出现但未带条款号(独立成条)
            key = (law_name, "")
            if key not in seen:
                seen.add(key)
                out.append({"law": law_name, "article": "",
                            "essence": "本案援引该规范作为处分依据",
                            "quote": sent})

    # 按条款号数字排序
    def art_num(a):
        m = re.search(r"第([一二三四五六七八九十百零〇\d]+)条", a["article"])
        if not m:
            return 9999
        s, num = m.group(1), 0
        mp = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7,
              "八": 8, "九": 9, "〇": 0, "零": 0}
        if s.isdigit():
            return int(s)
        unit, cur = 1, 0
        for ch in reversed(s):
            if ch in mp:
                cur += mp[ch] * unit
            elif ch == "十":
                unit = 10 if unit == 1 else unit * 10
            elif ch == "百":
                unit = 100
        return cur or 9999

    out.sort(key=art_num)
    return out[:max_n]


def build_case_law(records, min_cases=2, max_n=6):
    """按当事人聚合历史处分,识别累犯与处分升级轨迹。

    records 为全量台账记录。返回列表(按案例数降序):
      {subject, cases, authorities, first_date, last_date, escalations,
       tags, doctrine}
    """
    from collections import defaultdict
    grp = defaultdict(list)
    for r in records:
        subj = (r.get("subject") or "").strip()
        if not subj or len(subj) < 2:
            continue
        grp[subj].append(r)

    out = []
    for subj, rs in grp.items():
        if len(rs) < min_cases:
            continue
        rs = sorted(rs, key=lambda x: x.get("date") or "")
        authorities = []
        for r in rs:
            src = (r.get("source") or "").replace("·纪律处分", "").replace("·监管措施", "")
            src = src.replace("中基协", "中基协")
            if src and src not in authorities:
                authorities.append(src)
        # 升级轨迹:各次处分的最高严重度措施
        path = []
        for r in rs:
            ms = r.get("measures") or []
            if not ms:
                continue
            top = max(ms, key=_sev)
            path.append({"date": r.get("date", ""), "measure": top,
                         "source": r.get("source", ""), "title": r.get("title", ""),
                         "url": r.get("url", "")})
        escalations = []
        for i in range(1, len(path)):
            if _sev(path[i]["measure"]) > _sev(path[i - 1]["measure"]):
                escalations.append("%s→%s" % (path[i - 1]["measure"], path[i]["measure"]))
        tags = []
        for r in rs:
            for t in (r.get("tags") or []):
                if t != "其他" and t not in tags:
                    tags.append(t)
        out.append({
            "subject": subj,
            "cases": len(rs),
            "authorities": authorities,
            "first_date": rs[0].get("date", ""),
            "last_date": rs[-1].get("date", ""),
            "path": path,
            "escalations": escalations,
            "tags": tags[:5],
        })

    for c in out:
        # 解读文案(AI,非原文)
        bits = []
        if c["cases"] >= 3:
            bits.append("该主体累计被处分 %d 次,属重点监控对象" % c["cases"])
        else:
            bits.append("该主体被处分 %d 次" % c["cases"])
        if len(c["authorities"]) > 1:
            bits.append("涉及 %d 家监管机关(%s),存在跨辖区叠加风险"
                        % (len(c["authorities"]), "、".join(c["authorities"][:3])))
        if c["escalations"]:
            bits.append("处分呈升级态势:" + ";".join(c["escalations"][:3]))
        else:
            bits.append("处分力度尚未出现升级,但同类问题重复发生")
        if c["tags"]:
            bits.append("反复出现的违规类型:" + "、".join(c["tags"]))
        c["doctrine"] = "。".join(bits) + "。"

    out.sort(key=lambda x: (-x["cases"], x["last_date"]), reverse=False)
    out.sort(key=lambda x: (-x["cases"], x["last_date"]))
    return out[:max_n]


def build_all_doctrine(records, min_cases=2):
    """返回全量案例法索引,供网页按当事人名快速命中。"""
    from collections import defaultdict
    grp = defaultdict(list)
    for r in records:
        subj = (r.get("subject") or "").strip()
        if subj and len(subj) >= 2:
            grp[subj].append(r)
    index = {}
    for subj, rs in grp.items():
        if len(rs) < min_cases:
            continue
        rs = sorted(rs, key=lambda x: x.get("date") or "")
        authorities = []
        for r in rs:
            src = (r.get("source") or "").replace("·纪律处分", "").replace("·监管措施", "")
            if src and src not in authorities:
                authorities.append(src)
        path = []
        for r in rs:
            ms = r.get("measures") or []
            if ms:
                path.append({"date": r.get("date", ""), "measure": max(ms, key=_sev),
                             "title": r.get("title", ""), "url": r.get("url", "")})
        escal = []
        for i in range(1, len(path)):
            if _sev(path[i]["measure"]) > _sev(path[i - 1]["measure"]):
                escal.append("%s→%s" % (path[i - 1]["measure"], path[i]["measure"]))
        tags = []
        for r in rs:
            for t in (r.get("tags") or []):
                if t != "其他" and t not in tags:
                    tags.append(t)
        bits = ["该主体被处分 %d 次" % len(rs)]
        if len(authorities) > 1:
            bits.append("涉及 %d 家监管机关(%s)" % (len(authorities), "、".join(authorities[:3])))
        if escal:
            bits.append("处分升级:" + ";".join(escal[:3]))
        if tags:
            bits.append("反复违规类型:" + "、".join(tags))
        index[subj] = {
            "cases": len(rs),
            "authorities": authorities,
            "path": path,
            "escalations": escal,
            "tags": tags[:5],
            "doctrine": "。".join(bits) + "。",
        }
    return index


if __name__ == "__main__":
    import sys, os, json
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from common import load_ledger, ensure_utf8_stdout
    ensure_utf8_stdout()
    led = load_ledger()
    rs = led["records"]
    print("=== 锚点解读自检 ===")
    n_law = sum(1 for r in rs if extract_law_anchors(r.get("body")))
    print("含法规条款锚点的案例: %d / %d" % (n_law, len(rs)))
    for r in rs:
        a = extract_law_anchors(r.get("body"))
        if a and len(a) >= 2:
            print("\n样例:", r["subject"], r["date"])
            for x in a[:4]:
                print("   -", x["law"], x["article"], "|", x["essence"][:44])
            break
    doc = build_case_law(rs, min_cases=2, max_n=8)
    print("\n累犯案例(被处分≥2次的主体): %d" % len(doc))
    for d in doc[:8]:
        print("  %s: %d次 | %s | %s" % (d["subject"][:22], d["cases"],
                                        "、".join(d["authorities"][:2]), d["doctrine"][:70]))
