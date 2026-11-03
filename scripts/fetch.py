# -*- coding: utf-8 -*-
"""
监管处罚案例采集器。

数据源(最小版范围):
  A. 中基协 · 纪律处分 · 受处分机构   https://www.amac.org.cn/zlgl/jlcf/scfjg/
  B. 中基协 · 纪律处分 · 受处分人员   https://www.amac.org.cn/zlgl/jlcf/scfry/
  C. 证监会总会 · 行政处罚决定书
  D. 地方证监局 · 私募监管/信用专栏监管措施(以北京局为样板,可扩展)

用法:
  python fetch.py                 # 采集全部源(列表 + 详情)
  python fetch.py --list-only     # 只采列表,不抓正文(⚠ 不比完整采集快多少:
                                  #   瓶颈是列表请求数 104 次 × 3s 限速 ≈ 312s,
                                  #   详情增量跳过时几乎不额外耗时。仅供排查列表解析)
  python fetch.py --limit 5       # 每个源最多采 5 条详情(这个能真正省时间)
  python fetch.py --source amac   # 只采指定源
"""
import os
import re
import sys
import json
import time
import datetime
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (
    ensure_utf8_stdout, log, fetch_text, fetch_bytes, fix_encoding,
    strip_tags, norm_title, to_iso_date, load_ledger, save_ledger,
    make_uid, infer_region, tag_violations, extract_measures,
    extract_amount, extract_status, extract_subject,
RAW_DIR, DATA_DIR,
    OCR_QUEUE_DIR,
)

ensure_utf8_stdout()

CUR_YEAR = datetime.date.today().year

# 证监会统一搜索接口模板(实测无需 Playwright,直接返回 JSON)
CSRC_API = ("https://www.csrc.gov.cn/searchList/%s"
            "?_isAgg=true&_isJson=true&_pageSize=%d&_template=index&page=1")

# ---------------------------------------------------------------- 数据源定义

SOURCES = {
    "amac_org": {
        "name": "中基协·纪律处分·受处分机构",
        "url": "https://www.amac.org.cn/zlgl/jlcf/scfjg/",
        "list_url": "https://www.amac.org.cn/zlgl/jlcf/scfjg/",
        "kind": "amac_tab",
        "tab": "纪律处分",
        # 只保留机构目录下的 PDF;rel 含 scfry 的是受处分人员,归到另一个源
        "path_include": "/scfjg/",
        "path_exclude": "/scfry/",
    },
    "amac_person": {
        "name": "中基协·纪律处分·受处分人员",
        "url": "https://www.amac.org.cn/zlgl/jlcf/scfry/",
        "list_url": "https://www.amac.org.cn/zlgl/jlcf/scfry/",
        "kind": "amac_tab",
        "tab": "纪律处分",
        "path_include": "/scfry/",
        "path_exclude": "",
    },
    "csrc_main": {
        "name": "证监会·行政处罚决定书",
        "url": "https://www.csrc.gov.cn/csrc/c101971/zfxxgk_zdgk.shtml",
        "list_url": "https://www.csrc.gov.cn/csrc/c101971/zfxxgk_zdgk.shtml",
        # 改用证监会统一 JSON 接口(channelid 自首页 zfxxgk 栏目解出),无需 Playwright。
        # channelName = 「行政处罚决定」,存量约 2041 条。
        "kind": "csrc_api",
        "channel": "17d5ff2fe43e488dba825807ae40d63f",
        # 总会行政处罚多为内幕交易/财务造假(上市公司),私募管理人占比低;
        # 仍需过一遍私募过滤,避免噪音。
        "kw": ["private"],
        # 回填时可设环境变量 CSRC_MAIN_PAGES 加深页数
        "max_pages": int(os.environ.get("CSRC_MAIN_PAGES", "3")),
    },
    "csrc_beijing": {
        "name": "北京证监局·监管措施",
        "url": "https://www.csrc.gov.cn/beijing/c105548/common_list_zt.shtml",
        "list_url": "https://www.csrc.gov.cn/beijing/c105548/common_list_zt.shtml",
        "kind": "csrc_list",
        "kw": ["警示函", "责令改正", "监管措施", "监管谈话", "公开谴责"],
    },
}

# 北京局改走统一 API 后,旧静态源退役(保留 key 会重复采集)
SOURCES.pop("csrc_beijing", None)


# ---------------------------------------------------------------- 证监会系统(csrc.gov.cn)

# 地方证监局「监管措施」与「行政处罚」栏目的 channelid(实测自各局首页)
# API 模式: https://www.csrc.gov.cn/searchList/{channelid}?_isAgg=true&_isJson=true...
# 实测无需 Playwright,直接返回 JSON。
CSRC_OFFICES = {
    "shanghai":  ("上海", "9ebc4198232e496e8bebf1b1bb1778ef", "c8318fc200764e38b30116c2d5f72b4b"),
    "guangdong": ("广东", "29a1328dc824498b89eae8e63c38837f", "02a93424320e46dea2631da827f96174"),
    "zhejiang":  ("浙江", "83e130eb74f74d458c81027715955391", "441d2ae10ef240cbbcfca758a73356f2"),
    "shenzhen":  ("深圳", "58959eb1bd68458088cac63f46a5fa40", "a3d847e5be4d40a5baaf387be4a56e9b"),
    "jiangsu":   ("江苏", "9d6dfc15aa6144c8aea00f9878bdb1ce", "b335834574a34e43874ef3dba68d5be5"),
    "shandong":  ("山东", "f8979e6c0b544e1992fea51d3c8739e3", "3a1acab4996548faa7532b957ebf4f8e"),
    "sichuan":   ("四川", "c8ec4969173148c19b6d52afc6500b49", "6cd6f0ccbd2f49c6af32878d34c54ae6"),
    "hubei":     ("湖北", "5a4e3e893a5f45d3a3f450cb8f96c635", "f0a7388893fa4c15a2d6482510e2fb31"),
    "fujian":    ("福建", "e0d6aa56b3564735930b1cc078646d49", "3df69151384a46cf8c8d11584cff5e94"),
    "tianjin":   ("天津", "f374ea9e12af484691ef888847fb6615", "8dce98784326429e9c97515b634723fe"),
    "chongqing": ("重庆", "55dbc14f9bea476bb09743d5f1c8c842", "febe5cf9074b4ce6a52fd3d34d7a5cba"),
    "henan":     ("河南", "92dfd6c412c2470bb93ed753c3404bc4", "9724ed53f22a4333b91c65c349edaf48"),
    "hunan":     ("湖南", "2f087f7010fb43788a9015f21448447a", "9182876b7fe841d3a2990998f5b756f3"),
    "anhui":     ("安徽", "5efe954d7f8049128e04a5141fc23da6", "83fb5344bde849ea8973f3715a680a15"),
    "shaanxi":   ("陕西", "f6c680055f9e43e7addf9493680a6112", "f0dad1ecc157416ea412e4a0608e04bd"),
    "liaoning":  ("辽宁", "58df751f822a42a0acb1abd7471c71f8", "94cc260b27d2430b8c39c21e4627cf2e"),
    "beijing":   ("北京", "53be9cf2273744cda5c5780e0dded972", None),
}

# 地方局「行政处罚」栏也含私募罚款案例(如未按规披露被罚),默认启用;
# 设 CSRC_PUNISH=0 可关闭以提速。
CSRC_INCLUDE_PUNISH = os.environ.get("CSRC_PUNISH", "1") == "1"

# 私募关键词过滤:地方局栏目混有大量上市公司/券商/期货案例。
# 策略:必须命中「强信号」词,或在「主体词 + 私募业务语义词」组合下才算命中。
PRIVATE_FUND_STRONG = ["私募", "私募基金", "私募证券", "私募股权", "创业投资",
                       "创投基金", "基金销售", "基金托管"]
# 这些词太宽泛(大量上市公司也叫"XX投资管理"),只作辅助
PRIVATE_FUND_WEAK_ORG = ["基金管理", "资产管理", "投资管理", "资本管理"]
# 排除信号:命中则直接丢弃(明确非私募主体)
NON_PRIVATE_EXCLUDE = ["期货", "证券股份有限公司", "上市公司", "银行", "保险",
                       "会计师事务所", "律师事务所", "保荐", "评级"]


def is_private_fund_case(title):
    """判断一条监管文书是否与私募基金相关。"""
    t = title or ""
    # 明确非私募主体(期货/银行/会计师事务所等),除非标题点名"私募"
    if any(x in t for x in NON_PRIVATE_EXCLUDE) and "私募" not in t:
        return False
    if any(k in t for k in PRIVATE_FUND_STRONG):
        return True
    # 私募管理人常见名称:「XX资产管理有限公司」「XX基金管理有限公司」等
    m = re.search(r"([\u4e00-\u9fa5（）()]{2,30}"
                  r"(?:基金管理|资产管理|投资管理|资本管理|股权投资管理)"
                  r"(?:有限公司|合伙企业|管理中心|有限责任公司|有限合伙))", t)
    if m:
        return True
    if any(k in t for k in PRIVATE_FUND_WEAK_ORG):
        biz = ["基金", "私募", "备案", "适当性", "投资者", "投资运作",
               "基金经理", "份额", "募集"]
        return any(b in t for b in biz)
    return False


def _build_csrc_sources():
    """程序化生成各地方证监局的源配置。分页深度可用环境变量覆盖(回填用)。"""
    mp_mon = int(os.environ.get("CSRC_PAGES", "3"))
    mp_pun = int(os.environ.get("CSRC_PUNISH_PAGES", "3"))
    srcs = {}
    for code, (cn, mon_ch, pun_ch) in CSRC_OFFICES.items():
        srcs["csrc_%s_mon" % code] = {
            "name": "%s证监局·监管措施" % cn,
            "url": "https://www.csrc.gov.cn/%s/" % code,
            "list_url": CSRC_API % (mon_ch, 20),
            "kind": "csrc_api",
            "channel": mon_ch,
            "max_pages": mp_mon,
            "kw": ["private"],  # 非空即启用 is_private_fund_case 过滤
        }
        if pun_ch and CSRC_INCLUDE_PUNISH:
            srcs["csrc_%s_pun" % code] = {
                "name": "%s证监局·行政处罚" % cn,
                "url": "https://www.csrc.gov.cn/%s/" % code,
                "list_url": CSRC_API % (pun_ch, 20),
                "kind": "csrc_api",
                "channel": pun_ch,
                "max_pages": mp_pun,
                "kw": ["private"],
            }
    return srcs


SOURCES.update(_build_csrc_sources())


# ---------------------------------------------------------------- 列表解析:中基协

def parse_amac_list(html, base_url, tab_name, path_include="", path_exclude=""):
    """
    中基协页面把「党建动态/协会要闻/纪律处分/自律措施」等多个 tab 塞进同一页面,
    必须先按 tab 隔离,再解析其中的 PDF 链接。
    列表项结构:
      <a href="./202609/P02026....pdf">标题<i>09-11</i></a>

    注意:「受处分机构」与「受处分人员」两个页面的 tab 结构完全相同,
    因此必须再用 PDF 路径区分:
      机构 /zlgl/jlcf/scfjg/202609/xxx.pdf
      人员 /zlgl/jlcf/scfry/202609/xxx.pdf
    """
    results = []

    # 定位目标 tab:从 tab 注释向后,截到下一个 tab 注释为止
    marks = [(m.start(), m.group(1).strip())
             for m in re.finditer(r"<!--\s*([^\->]{2,24})\s*-->", html)]
    seg = html
    for i, (pos, name) in enumerate(marks):
        if name == tab_name:
            seg = html[pos:marks[i + 1][0] if i + 1 < len(marks) else len(html)]
            break

    for m in re.finditer(
        r'<a[^>]+href="([^"]+\.(?:pdf|shtml))"[^>]*>\s*(.*?)<i>\s*([\d\-]+)\s*</i>',
        seg, re.S
    ):
        href, title, md = m.group(1), m.group(2), m.group(3)
        title = norm_title(title)
        if not title or len(title) < 6:
            continue

        url = _abs_url(base_url, href)
        if path_exclude and path_exclude in url:
            continue
        if path_include and path_include not in url:
            continue

        results.append({
            "title": title,
            "url": url,
            "date": to_iso_date(md, CUR_YEAR),
        })

    # 去重(同页可能重复渲染)
    seen, uniq = set(), []
    for r in results:
        if r["url"] in seen:
            continue
        seen.add(r["url"])
        uniq.append(r)
    return uniq


# 中基协真实分页列表区条目(区别于页首 tab widget 区,每页约 18 条):
#   <li><span></span><a href="./202609/P02026....pdf">纪律处分决定书（XXX）</a>
#       <i> 2026-09-11 </i></li>
# 特征:日期为完整 YYYY-MM-DD 且位于 </a> 之后;href 以 ./YYYYMM/ 开头。
# href 限定是为了排除页面上其它栏目(如 ../../../hydj/djdt/ 新闻附件)的 PDF 误配;
# widget 区日期无年份(<i>09-11</i>),不会命中本正则,仍由 parse_amac_list 负责。
AMAC_LIST_PAT = re.compile(
    r'<a[^>]+href="((?:\./)?\d{6}/P\d+[^"]*?\.pdf)"[^>]*>(.*?)</a>'
    r'((?:(?!<a[\s>]).){0,150}?)<i>\s*(\d{4}-\d{2}-\d{2})\s*</i>',
    re.S,
)


def parse_amac_full_list(html, base_url, path_include="", path_exclude=""):
    """解析中基协页面尾部的真实分页列表区(含 index_N 历史页)。"""
    results = []
    for m in AMAC_LIST_PAT.finditer(html):
        href, title, date = m.group(1), norm_title(m.group(2)), m.group(4)
        if not title or len(title) < 6:
            continue
        url = _abs_url(base_url, href)
        if path_exclude and path_exclude in url:
            continue
        if path_include and path_include not in url:
            continue
        results.append({
            "title": title,
            "url": url,
            "date": to_iso_date(date, CUR_YEAR),
        })

    seen, uniq = set(), []
    for r in results:
        if r["url"] in seen:
            continue
        seen.add(r["url"])
        uniq.append(r)
    return uniq


# ---------------------------------------------------------------- 列表解析:证监会

def parse_csrc_list(html, base_url, keywords):
    """
    证监会栏目页条目多为 <a href="/xx/cXXXXXX/cXXXXXXX/content.shtml">标题</a>,
    日期常在同级 <span> 或紧随文本中。
    """
    results = []
    for m in re.finditer(
        r'<a[^>]+href="([^"]*(?:content\.shtml|/c\d+/[^"]*\.shtml))"[^>]*>(.*?)</a>',
        html, re.S
    ):
        href, title = m.group(1), norm_title(m.group(2))
        if not title or len(title) < 6:
            continue
        if keywords and not any(k in title for k in keywords):
            continue

        # 在该 <a> 之后 400 字符内找日期
        tail = html[m.end():m.end() + 400]
        dm = re.search(r"(\d{4}-\d{2}-\d{2})", tail) or re.search(r"(\d{1,2}-\d{1,2})", tail)
        date = to_iso_date(dm.group(1), CUR_YEAR) if dm else ""

        results.append({
            "title": title,
            "url": _abs_url(base_url, href),
            "date": date,
        })

    # 去重
    seen, uniq = set(), []
    for r in results:
        if r["url"] in seen:
            continue
        seen.add(r["url"])
        uniq.append(r)
    return uniq


# ---------------------------------------------------------------- 列表解析:证监会统一 JSON API

def _norm_csrc_url(u):
    """规范化证监会详情页 URL。
    部分局(如上海)返回的 url 字段已含绝对域名,
    直接拼 https://www.csrc.gov.cn 会得到 .../www.csrc.gov.cn/... 的重复前缀。
    """
    if not u:
        return ""
    u = u.strip()
    # 去掉重复的域名前缀
    u = u.replace("https://www.csrc.gov.cn//www.csrc.gov.cn", "https://www.csrc.gov.cn")
    u = u.replace("http://www.csrc.gov.cn//www.csrc.gov.cn", "https://www.csrc.gov.cn")
    if u.startswith("http"):
        return u
    if u.startswith("//www.csrc.gov.cn"):
        return "https:" + u
    if u.startswith("/"):
        return "https://www.csrc.gov.cn" + u
    return "https://www.csrc.gov.cn/" + u


def _filepath_to_url(fp):
    """把 filePath 转成可访问的栏目详情页 URL。
    filePath 形如 /guangdong/c104560/c7659631/7659631/files/xxx.docx
    → 详情页 https://www.csrc.gov.cn/guangdong/c104560/c7659631/content.shtml
    """
    if not fp:
        return ""
    m = re.match(r"(/[a-z]+/c\d+/c\d+)/", fp)
    if m:
        return "https://www.csrc.gov.cn%s/content.shtml" % m.group(1)
    if fp.startswith("http"):
        return fp
    return ""


def fetch_csrc_api(channel_id, page_size=20, max_pages=1):
    """
    调用证监会统一搜索接口,返回列表项 [{title, url, date}, ...]。

    实测该接口无需 Playwright:
      https://www.csrc.gov.cn/searchList/{channelid}
        ?_isAgg=true&_isJson=true&_pageSize=40&_template=index&page=1
    返回 JSON:{data:{total, results:[{resList:[{fileName,filePath,...}],
    domainMetaList:[{resultList:[{name,value,url}]}]}]}}
    标题来源优先级:resList.fileName(带扩展名,含正文文件) > domainMetaList 里的标题字段。

    注意:接口**硬顶每页 20 条**,_pageSize 传 40 也只返回 20,
    因此 page_size 必须是 20,否则「len(rows) < page_size」的停止判断
    会在第 1 页就提前终止,翻页形同虚设(2026-09-22 踩坑)。
    """
    import json as _json

    results = []
    for page in range(1, max_pages + 1):
        url = (CSRC_API % (channel_id, page_size)).replace("page=1", "page=%d" % page)
        try:
            txt = fetch_text(url, use_cache=False)
            j = _json.loads(txt)
        except Exception:
            break

        data = j.get("data", {}) or {}
        rows = data.get("results", []) or []
        if not rows:
            break

        total = 0
        try:
            total = int(data.get("total") or 0)
        except (TypeError, ValueError):
            total = 0

        for row in rows:
            title, url_, date = "", "", ""

            # 优先 ①:顶层字段(上海局等用此结构:title/url/publishedTime)
            if row.get("title"):
                title = str(row["title"]).strip()
            if row.get("url"):
                url_ = str(row["url"]).strip()
            if row.get("publishedTimeStr"):
                date = to_iso_date(str(row["publishedTimeStr"])[:10], CUR_YEAR)

            # 优先 ②:domainMetaList 中的结构化字段(文号/发文日期)
            for dm in row.get("domainMetaList", []) or []:
                for rl in dm.get("resultList", []) or []:
                    nm = (rl.get("name") or "").strip()
                    val = (rl.get("value") or "").strip()
                    if nm in ("标题", "名称", "信息名称") and val and not title:
                        title = val
                    elif nm in ("发文日期", "发布日期", "成文日期") and val and not date:
                        date = to_iso_date(val[:10], CUR_YEAR)
                    elif not url_ and rl.get("url"):
                        url_ = rl["url"]

            # 兜底 ③:resList.fileName 作标题,filePath 推详情页(广东/河南局)
            for rl in row.get("resList", []) or []:
                fn = (rl.get("fileName") or "").strip()
                if fn and not title:
                    title = re.sub(r"\.(?:docx?|pdf|xlsx?|wps)$", "", fn, flags=re.I)
                if not url_:
                    url_ = _filepath_to_url(rl.get("filePath", ""))

            if not title:
                continue
            title = norm_title(title)
            url_ = _norm_csrc_url(url_)

            results.append({"title": title, "url": url_, "date": date, "channel": row.get("channelId")})

        # 已取满 total 或本页不足一页则停止
        if total and len(results) >= total:
            break
        if len(rows) < page_size:
            break

    # 去重
    seen, uniq = set(), []
    for r in results:
        key = r["url"] or r["title"]
        if key in seen:
            continue
        seen.add(key)
        uniq.append(r)
    return uniq


def _abs_url(base, href):
    if href.startswith("http"):
        return href
    if href.startswith("//"):
        return "https:" + href
    import posixpath
    from urllib.parse import urlparse
    p = urlparse(base)
    root = "%s://%s" % (p.scheme, p.netloc)
    if href.startswith("/"):
        return root + href
    # base 可能是页面文件(如 index_1.html):先取其所在目录,否则 join 会把
    # 文件名当目录拼出 .../index_1.html/202608/P....pdf 的坏链接
    path = p.path if p.path.endswith("/") else p.path.rsplit("/", 1)[0] + "/"
    return root + posixpath.normpath(posixpath.join(path, href)).replace("\\", "/")


def _find_attachment_pdf(html, page_url):
    """
    在证监会详情页里找附件链接（PDF / Word / WPS）。
    两处结构都要找：
      1) <div id="files"><a href="7658435/files/xxx.pdf">…</a></div>
      2) <div class="detail-news"><p><img src="…/doc.gif"><a href="7627929/files/xxx.docx">…</a></p></div>
         —— 广东局等把决定书正文放在 detail-news 内的 docx/doc 附件里。
    返回绝对 URL（中文路径已 percent-encode）；没有则返回 ""。
    """
    if not html:
        return ""
    # [1] 优先 id="files" 容器，其次 detail-news 正文容器，最后全文
    scope = ""
    m = re.search(r'<div[^>]+id="files"[^>]*>(.*?)</div>', html, re.S | re.I)
    if m:
        scope = m.group(1)
    if not re.search(r'href="[^"]+\.(?:pdf|docx?|wps)"', scope, re.I):
        m2 = re.search(r'<div[^>]+class="[^"]*detail-news[^"]*"[^>]*>(.*?)'
                       r'<div[^>]+class="[^"]*xxgk-down-box', html, re.S | re.I)
        if m2:
            scope = m2.group(1)
    if not re.search(r'href="[^"]+\.(?:pdf|docx?|wps)"', scope, re.I):
        scope = html

    for am in re.finditer(r'href="([^"]+\.(?:pdf|docx?|wps))"', scope, re.I):
        href = am.group(1)
        if href.startswith("http"):
            furl = href
        else:
            # 相对 URL:基于详情页所在目录拼接
            furl = page_url.rsplit("/", 1)[0] + "/" + href.lstrip("./")
        # 关键:附件名常含中文/〔〕，含非 ASCII 的 URL 直接传给 urllib 会报
        # UnicodeEncodeError；此处统一百分号编码，保留已有 %XX。
        try:
            from urllib.parse import urlsplit, urlunsplit, quote
            sp = urlsplit(furl)
            furl = urlunsplit((sp.scheme, sp.netloc, quote(sp.path, safe="/%"),
                               sp.query, sp.fragment))
        except Exception:
            pass
        return furl
    return ""


# ---------------------------------------------------------------- 正文提取

_TAIL_MARKS = ["底部", "相关链接", "链接：", "打印本页", "【关闭】", "关闭窗口",
               "主办单位", "网站地图", "版权所有", "扫一扫", "分享到"]


def _trim_tail(txt):
    """截掉正文之后的站点导航/页脚(从首个页脚标记起全部舍弃)。"""
    cut = len(txt)
    for mk in _TAIL_MARKS:
        i = txt.find(mk)
        if i >= 0:
            cut = min(cut, i)
    txt = txt[:cut]
    txt = txt.replace("&ensp;", " ").replace("&nbsp;", " ")
    return txt.rstrip("　 \n-—:：,")


def extract_body(html, source_kind):
    """按源类型定位正文容器并抽取纯文本。"""
    # 证监会地方局:页面主体是「索引号/发布机构/发文日期」元数据表,
    # 真实正文要么在附件 PDF,要么根本没有。此时返回空串,交由调用方走附件。
    if source_kind == "csrc_api":
        txt = _extract_csrc_detail_text(html)
        return _trim_tail(txt)

    # 证监会:正文在 div.detail-news
    m = re.search(r'<div[^>]+class="[^"]*detail-news[^"]*"[^>]*>(.*?)</div>\s*<div',
                  html, re.S)
    if m:
        txt = strip_tags(m.group(1))
        if len(txt) > 80:
            return _trim_tail(txt)

    # 通用:class 含 content/article/zoom/TRS_Editor 的容器
    for pat in [r'<div[^>]+class="[^"]*(?:content|article|zoom|TRS_Editor|detail)[^"]*"[^>]*>(.*?)</div>',
                r'<div[^>]+id="(?:content|zoom|article)"[^>]*>(.*?)</div>']:
        for m in re.finditer(pat, html, re.S | re.I):
            txt = strip_tags(m.group(1))
            if len(txt) > 150:
                return _trim_tail(txt)

    # 兜底:去掉导航后取最长文本块
    body = strip_tags(html)
    return _trim_tail(body)


_META_NOISE = ["索 引 号", "索引号", "分 类", "发布机构", "发文日期", "名 称",
               "文 号", "主 题 词", "【打印】", "【关闭窗口】", "链接：",
               "主办单位", "版权所有", "网站识别码", "无障碍", "当前位置"]


def _extract_csrc_detail_text(html):
    """
    证监会地方局详情页的正文本体抽取。
    该页面结构是「元数据表 + 附件区」,真正的决定书正文往往不在 HTML 里。
    策略:先在 detail-news 内找带「经查/你公司/当事人/我局决定」的段落;
    找到则返回,否则返回空串(触发附件 PDF 回退)。
    """
    if not html:
        return ""
    # 取 detail-news 容器(有则限定范围,无则全文)
    m = re.search(r'<div[^>]+class="[^"]*detail-news[^"]*"[^>]*>(.*?)</div>\s*(?:<div|</div>)',
                  html, re.S)
    scope = m.group(1) if m else html
    txt = strip_tags(scope)
    txt = re.sub(r"[ \t\u3000]+", " ", txt)

    # 若含决定书正文特征词,剔除元数据行后返回
    anchors = ["经查", "经核查", "你公司", "当事人：", "当事人:", "我局决定", "经查明"]
    if any(a in txt for a in anchors):
        lines = [ln.strip() for ln in txt.split("\n")]
        keep = []
        for ln in lines:
            if not ln:
                continue
            if any(nz.replace(" ", "") in ln.replace(" ", "") for nz in _META_NOISE):
                continue
            keep.append(ln)
        return "\n".join(keep).strip()

    # 无正文特征 → 返回空,交由附件 PDF 处理
    return ""


# ---------------------------------------------------------------- 渲染器(可选)

_RENDERER = [None]
_RENDERER_CHECKED = [False]


def _get_renderer():
    """返回一个 render(url, wait_selector) -> html 的可调用对象,不可用则返回 None。"""
    if _RENDERER_CHECKED[0]:
        return _RENDERER[0]
    _RENDERER_CHECKED[0] = True
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None

    def render(url, wait_selector=None, timeout=30000):
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(user_agent=UA)
            page.goto(url, timeout=timeout, wait_until="networkidle")
            if wait_selector:
                try:
                    page.wait_for_selector(wait_selector, timeout=8000)
                except Exception:
                    pass
            html = page.content()
            browser.close()
        return html

    _RENDERER[0] = render
    return render


# ---------------------------------------------------------------- 采集主流程

def collect(source_key, cfg, list_only=False, limit=None, ledger=None):
    log("\n=== [%s] %s" % (source_key, cfg["name"]))

    # 台账中已有正文的 uid 集合:这些条目本轮不再重抓详情(增量省流)
    prev_bodied = set()
    if ledger:
        for _r in ledger.get("records", []) or []:
            if _r.get("body"):
                prev_bodied.add(_r.get("uid"))

    # 需要浏览器渲染的源:检查渲染器可用性,不可用则明确跳过
    if cfg.get("needs_render"):
        renderer = _get_renderer()
        if renderer is None:
            log("  ⚠ 该栏目为前端异步渲染,需 Playwright 渲染器;当前未安装,已跳过。")
            log("    安装: %s -m pip install playwright && %s -m playwright install chromium"
                % (sys.executable, sys.executable))
            return []
        try:
            html = renderer(cfg["list_url"], wait_selector="table, .list, ul")
        except Exception as e:
            log("  ! 渲染失败: %s" % e)
            return []
    elif cfg["kind"] == "csrc_api":
        # 统一 JSON 接口,无需 HTML
        html = ""
    else:
        try:
            html = fetch_text(cfg["list_url"], use_cache=False)
        except Exception as e:
            log("  ! 列表页抓取失败: %s" % e)
            return []

    if cfg["kind"] == "amac_tab":
        tab_name = cfg.get("tab", "纪律处分")
        pin, pex = cfg.get("path_include", ""), cfg.get("path_exclude", "")
        # 每页跑两个解析器后按 URL 去重合并:
        #   parse_amac_list      → 页首 tab widget 区(约4条,日期在<a>内、无年份)
        #   parse_amac_full_list → 页尾真实分页列表区(每页约18条,完整日期)
        page_pairs = [(cfg["list_url"], html)]
        # 中基协静态分页:页面内 createPageHTML(N, 0, "index","html") 声明总页数 N,
        # 第 2..N 页是同目录 index_1.html .. index_{N-1}.html。AMAC_PAGES 控制回填深度。
        amac_pages = int(os.environ.get("AMAC_PAGES", "1"))
        if amac_pages > 1:
            mp = re.search(r"createPageHTML\((\d+),", html)
            total_pages = int(mp.group(1)) if mp else 1
            root = cfg["list_url"] if cfg["list_url"].endswith("/") \
                else cfg["list_url"].rsplit("/", 1)[0] + "/"
            for p in range(1, min(total_pages, amac_pages)):
                purl = root + ("index_%d.html" % p)
                try:
                    page_pairs.append((purl, fetch_text(purl, use_cache=False)))
                except Exception:
                    log("  中基协第 %d 页抓取失败,停止翻页" % (p + 1))
                    break
        items, seen_urls = [], set()
        for purl, phtml in page_pairs:
            for it in (parse_amac_list(phtml, purl, tab_name, pin, pex)
                       + parse_amac_full_list(phtml, purl, pin, pex)):
                if it["url"] in seen_urls:
                    continue
                seen_urls.add(it["url"])
                items.append(it)
        log("  中基协采集: %d 页,去重后列表 %d 条" % (len(page_pairs), len(items)))
    elif cfg["kind"] == "csrc_api":
        try:
            # 分页深度:源配置 max_pages 优先(由环境变量注入,日常 3 页,回填可加深)
            mp = cfg.get("max_pages") or 3
            items = fetch_csrc_api(cfg["channel"], page_size=20, max_pages=mp)
        except Exception as e:
            log("  ! 接口抓取失败: %s" % e)
            items = []
        # 私募关键词过滤(地方局栏目混有大量上市公司案例)
        kw = cfg.get("kw") or []
        if kw:
            before = len(items)
            items = [it for it in items if is_private_fund_case(it["title"])]
            log("  私募相关过滤: %d → %d 条" % (before, len(items)))
    else:
        items = parse_csrc_list(html, cfg["list_url"], cfg.get("kw"))

    log("  列表条目: %d" % len(items))

    out = []
    new_count = 0
    for idx, it in enumerate(items):
        uid = make_uid(source_key, it["url"], it["title"])
        known = bool(ledger) and uid in ledger.get("seen", {})

        rec = {
            "uid": uid,
            "source_key": source_key,
            "source": cfg["name"],
            "title": it["title"],
            "date": it["date"],
            "url": it["url"],
            "is_new": not known,
        }

        # 抓正文:仅当未超限时才抓;已入库且已有正文的跳过以省流量
        need_body = not list_only
        if need_body and limit is not None and idx >= limit:
            rec["body"] = ""
            rec["body_status"] = "skipped-limit"
        elif need_body and uid in prev_bodied:
            # 台账中该条已有正文:本次沿用,不重复下载(正文在合并时保留旧记录)
            rec["body"] = ""
            rec["body_status"] = "known-ok"

        if not list_only and rec.get("body_status") not in ("skipped-limit", "known-ok"):
            try:
                if re.search(r"\.(?:pdf|docx?|wps)$", it["url"], re.I):
                    body, method = extract_attachment_text(it["url"])
                else:
                    detail = fetch_text(it["url"], referer=cfg["list_url"])
                    body = extract_body(detail, cfg["kind"])
                    method = "html"
                    # 证监会地方局:正文常放在附件里,页面只有元数据表。
                    # 网页正文过短(<120字)时,取附件走格式自识别抽取。
                    # 注:附件后缀可能是 .pdf 而实际是 .docx/.doc(广东局),故不看后缀。
                    if len(body or "") < 120:
                        att = _find_attachment_pdf(detail, it["url"])
                        if att:
                            pbody, pmethod = extract_attachment_text(att)
                            if len(pbody or "") > len(body or ""):
                                body, method = pbody, pmethod
                                rec["attachment"] = att
                rec["body"] = body
                rec["extract_method"] = method
                if body:
                    rec["body_status"] = "ok"
                elif method == "pending_ocr":
                    rec["body_status"] = "pending_ocr"
                else:
                    rec["body_status"] = "empty"
            except Exception as e:
                rec["body"] = ""
                rec["body_status"] = "error: %s" % e
                log("    ! 详情失败 %s" % it["url"][-60:])

        # 视觉转录管道:若该 PDF 的转录文本已存在,直接采用
        # 覆盖两种情形:① 列表 URL 本身是 PDF;② 正文来自附件 PDF
        _pdf_candidates = []
        if it["url"].lower().endswith(".pdf"):
            _pdf_candidates.append(os.path.basename(it["url"]).replace(".pdf", ""))
        if rec.get("attachment", "").lower().endswith(".pdf"):
            _pdf_candidates.append(os.path.basename(rec["attachment"]).replace(".pdf", ""))
        for uid_pdf in _pdf_candidates:
            tp = os.path.join(OCR_QUEUE_DIR, uid_pdf, "transcript.txt")
            if os.path.exists(tp):
                with open(tp, "r", encoding="utf-8") as f:
                    _t = f.read().strip()
                if len(_t) > len(rec.get("body", "") or ""):
                    rec["body"] = _t
                    rec["extract_method"] = "agent_vision"
                    rec["body_status"] = "ok"
                break

        # 结构化字段
        full = (rec.get("body", "") or "") + " " + it["title"]
        rec["subject"] = extract_subject(it["title"], rec.get("body", ""))
        rec["region"] = infer_region(cfg["name"], it["title"],
                                     (rec.get("subject", "") or "") + " " +
                                     (rec.get("body", "") or "")[:300])
        rec["status"] = extract_status(rec.get("body", ""), it["title"])
        if source_key == "amac_person":
            rec["status"] = "个人"
        rec["tags"] = tag_violations(full)
        rec["measures"] = extract_measures(full)
        rec["amount_wan"] = extract_amount(full)
        rec["summary"] = _summarize(rec.get("body", ""))

        if rec["is_new"]:
            new_count += 1

        out.append(rec)

        if not list_only:
            total = min(len(items), limit) if limit is not None else len(items)
            log("    [%d/%d] %s%s" % (idx + 1, total,
                                      "NEW " if rec["is_new"] else "old ",
                                      it["title"][:44]))

    log("  完成: %d 条,其中新增 %d 条" % (len(out), new_count))
    return out


# ---------------------------------------------------------------- 附件正文分派

def _sniff_kind(data):
    """
    按文件头判定附件真实格式。地方局附件后缀常与内容不符
    (广东局把 .docx/.doc 挂在 .pdf 链接下),必须看魔数而非后缀。
    """
    if not data or len(data) < 8:
        return "unknown"
    if data[:4] == b"%PDF":
        return "pdf"
    if data[:4] == b"PK\x03\x04":          # zip → docx/xlsx/pptx
        return "zip"
    if data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":   # OLE2 → doc/xls/ppt
        return "ole"
    if data[:5].lower() == b"<html" or b"<html" in data[:512].lower():
        return "html"
    return "unknown"


def _extract_docx_text(data):
    """从 .docx 字节流抽正文:解 zip → word/document.xml → 去标签。"""
    import io
    import zipfile
    from xml.etree import ElementTree as ET

    W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except Exception as e:
        log("      (docx 解压失败: %s)" % e)
        return ""

    # 主文档 + 页眉页脚(有些局把文号放页眉)
    parts = ["word/document.xml"]
    for nm in zf.namelist():
        if re.match(r"word/(header|footer)\d*\.xml$", nm) and nm not in parts:
            parts.append(nm)

    chunks = []
    for part in parts:
        if part not in zf.namelist():
            continue
        try:
            root = ET.fromstring(zf.read(part))
        except Exception:
            continue
        is_hf = part.startswith("word/header") or part.startswith("word/footer")
        buf = []
        for para in root.iter(W + "p"):
            seg = "".join(t.text or "" for t in para.iter(W + "t"))
            seg = seg.strip()
            if not seg:
                continue
            # 页眉页脚只留「有信息量」的内容(文号等),丢弃纯页码残片。
            # 实测 docx 页脚会产生 "- 1 -"、"- 1 -- 1 -" 这类噪音。
            if is_hf and _is_page_furniture(seg):
                continue
            buf.append(seg)
        if buf:
            chunks.append("\n".join(buf))

    txt = "\n".join(chunks)
    txt = re.sub(r"[ \t\u3000]+", " ", txt)
    txt = re.sub(r"\n\s*\n+", "\n", txt).strip()
    return txt


def _is_page_furniture(seg):
    """
    判断一段文字是否为无意义的页码/装饰性残片。
    形如: "- 1 -"、"- 1 -- 1 -"、"1"、"第1页"、"Page 1"。
    """
    s = re.sub(r"[\s\u3000]", "", seg)
    if not s:
        return True
    # 纯数字 / 纯符号
    if re.fullmatch(r"[\-—–_=~·.\d]+", s):
        return True
    # 页码样式
    if re.fullmatch(r"第?\d{1,4}页(共\d{1,4}页)?", s):
        return True
    if re.fullmatch(r"(?i)page\d{1,4}(of\d{1,4})?", s):
        return True
    return False


def _extract_doc_text(data):
    """
    从 .doc(OLE2 二进制)抽正文。无 antiword 时退化为可打印字符扫描:
    中文以 UTF-16LE 存储,按双字节序列还原。
    """
    # --- 优先尝试 antiword
    try:
        import subprocess
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".doc", delete=False) as tf:
            tf.write(data)
            tmp = tf.name
        try:
            out = subprocess.run(["antiword", "-m", "UTF-8.txt", tmp],
                                 capture_output=True, timeout=30)
            if out.returncode == 0 and len(out.stdout) > 100:
                t = out.stdout.decode("utf-8", "ignore")
                return re.sub(r"\n\s*\n+", "\n", t).strip()
        finally:
            try:
                os.remove(tmp)
            except Exception:
                pass
    except Exception:
        pass

    # --- 退化:扫描 UTF-16LE 文本片段
    try:
        s = data.decode("utf-16-le", "ignore")
    except Exception:
        return ""
    # 只保留中文/常用标点/数字字母构成的长串
    frags = re.findall(r"[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef0-9A-Za-z，。、；：（）〔〕《》%,.\-]{8,}", s)
    seen = set()
    keep = []
    for f in frags:
        f = f.strip()
        if len(f) < 8 or f in seen:
            continue
        seen.add(f)
        keep.append(f)
    return "\n".join(keep)


def extract_attachment_text(url):
    """
    抽取附件正文(自动识别 PDF / DOCX / DOC / HTML)。
    PDF 走三级策略(text_layer → OCR → 视觉转录入队);
    Office 文档直接解压/解码抽取文本层。
    返回 (text, method);method ∈ text_layer|docx|doc|ocr|pending_ocr|none
    """
    data = fetch_bytes(url, use_cache=True)
    kind = _sniff_kind(data)

    if kind == "zip":
        txt = _extract_docx_text(data)
        if txt:
            return txt, "docx"
        return "", "none"

    if kind == "ole":
        txt = _extract_doc_text(data)
        if txt:
            return txt, "doc"
        return "", "none"

    if kind == "html":
        # 少数附件其实是跳转页
        txt = strip_tags(data.decode("utf-8", "ignore"))
        return _trim_tail(txt) if txt else "", "html"

    # 默认按 PDF 处理(含 kind == "pdf" 与 unknown)
    return _extract_pdf_body(data, url)


def extract_pdf_text(url):
    """兼容旧调用点:按 URL 抽取附件正文(内部已自动识别真实格式)。"""
    return extract_attachment_text(url)


def _extract_pdf_body(data, url):
    """
    抽取 PDF 正文。三级策略:
      1. pypdf 直接抽文本层(适用于电子版 PDF)
      2. 文本层为空 → 判定为扫描件,走 OCR
      3. OCR 后端不可用 → 渲染入队,由 agent 视觉转录
    返回 (text, method) 元组;method ∈ text_layer / ocr / pending_ocr / none
    """
    import io

    # --- 1) 文本层
    txt = ""
    try:
        from pypdf import PdfReader
    except ImportError:
        try:
            from PyPDF2 import PdfReader
        except ImportError:
            PdfReader = None

    if PdfReader is not None:
        try:
            reader = PdfReader(io.BytesIO(data))
            chunks = []
            for page in reader.pages[:12]:
                try:
                    chunks.append(page.extract_text() or "")
                except Exception:
                    continue
            txt = "\n".join(chunks)
            txt = re.sub(r"[ \t\u3000]+", " ", txt)
            txt = re.sub(r"\n\s*\n+", "\n", txt).strip()
        except Exception:
            txt = ""

    if len(txt) >= 100:
        return txt, "text_layer"

    # --- 2) 扫描件 → OCR
    try:
        from ocr_backend import ocr_pdf, ocr_available
        if ocr_available():
            ocr_txt = ocr_pdf(data, key=os.path.basename(url).replace(".pdf", ""))
            if len(ocr_txt) > len(txt):
                return ocr_txt, "ocr"
    except Exception as e:
        log("      (OCR 失败: %s)" % e)

    # --- 3) 无 OCR 后端 → 渲染页面入队,由 agent 视觉转录
    try:
        from ocr_backend import pdf_to_images
        uid = os.path.basename(url).replace(".pdf", "")
        queue_dir = os.path.join(OCR_QUEUE_DIR, uid)
        os.makedirs(queue_dir, exist_ok=True)
        marker = os.path.join(queue_dir, ".queued")
        if not os.path.exists(marker):
            images = pdf_to_images(data, max_pages=10, dpi=170)
            for i, img in enumerate(images, 1):
                with open(os.path.join(queue_dir, "page_%d.png" % i), "wb") as f:
                    f.write(img)
            with open(marker, "w", encoding="utf-8") as f:
                f.write(url)
            log("      (扫描件已渲染 %d 页入队,待视觉转录: data/ocr_queue/%s/)" % (len(images), uid))
        return txt, "pending_ocr"
    except Exception as e:
        log("      (渲染入队失败: %s)" % e)

    return txt, "none"


def _summarize(body, maxlen=180):
    """生成一句话摘要:优先取'基本事实'/'经查'之后的正文。"""
    if not body:
        return ""
    t = re.sub(r"\s+", " ", body)
    for anchor in ["经查", "经查明", "经核查", "我局发现", "存在以下"]:
        i = t.find(anchor)
        if i >= 0 and i < len(t) - 40:
            t = t[i:]
            break
    t = re.sub(r"^(经查[明]?|经核查)[,，]?\s*", "", t)
    return t[:maxlen].strip()


def _sweep_empty_ocr_dirs():
    """
    清除 ocr_queue 下的空目录。
    历史遗留:早期版本对 .doc/.docx 附件误走 PDFium,渲染入队时先建目录再失败,
    留下 0 文件空壳(名字是附件名而非 PDF 名)。这些目录无任何内容,直接清掉。
    """
    if not os.path.isdir(OCR_QUEUE_DIR):
        return
    try:
        for d in os.listdir(OCR_QUEUE_DIR):
            dp = os.path.join(OCR_QUEUE_DIR, d)
            if os.path.isdir(dp) and not os.listdir(dp):
                os.rmdir(dp)
    except Exception:
        pass


# ---------------------------------------------------------------- 入口

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list-only", action="store_true",
                    help="只采列表不抓正文(注意:瓶颈是列表请求数,此模式并不可观提速)")
    ap.add_argument("--limit", type=int, default=None, help="每个源最多抓 N 条详情")
    ap.add_argument("--source", default=None, help="只采指定源 key")
    ap.add_argument("--no-ledger", action="store_true", help="不读写去重台账")
    args = ap.parse_args()

    _sweep_empty_ocr_dirs()

    ledger = {"records": [], "seen": {}, "last_run": ""} if args.no_ledger else load_ledger()

    keys = [args.source] if args.source else list(SOURCES.keys())
    all_records = []
    for k in keys:
        if k not in SOURCES:
            log("未知源: %s" % k)
            continue
        recs = collect(k, SOURCES[k], list_only=args.list_only,
                       limit=args.limit, ledger=ledger)
        all_records.extend(recs)

    # 合并进台账
    if not args.no_ledger:
        known = {r["uid"]: r for r in ledger["records"]}
        for r in all_records:
            prev = known.get(r["uid"])
            if prev:
                # 保留首次发现时间,更新正文
                r["first_seen"] = prev.get("first_seen", r.get("date", ""))
                if r.get("body"):
                    known[r["uid"]] = r
            else:
                r["first_seen"] = r.get("date") or datetime.date.today().isoformat()
                known[r["uid"]] = r
                ledger["seen"][r["uid"]] = r["first_seen"]
        ledger["records"] = list(known.values())
        save_ledger(ledger)

    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M")
    raw_path = os.path.join(RAW_DIR, "penalties_%s.json" % stamp)
    with open(raw_path, "w", encoding="utf-8") as f:
        json.dump(all_records, f, ensure_ascii=False, indent=1)

    log("\n总计 %d 条 → %s" % (len(all_records), raw_path))
    if not args.no_ledger:
        log("台账累计 %d 条 → data/ledger.json" % len(ledger["records"]))

    ok = sum(1 for r in all_records if r.get("body_status") == "ok")
    log("正文抓取成功 %d / %d" % (ok, len(all_records)))


if __name__ == "__main__":
    main()
