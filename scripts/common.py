# -*- coding: utf-8 -*-
"""
公共工具:HTTP 请求、编码修复、文本清洗、增量去重、限速。
所有采集脚本共用。
"""
import os
import re
import sys
import json
import time
import hashlib
import datetime
import urllib.request
import urllib.error

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
CACHE_DIR = os.path.join(DATA_DIR, "cache")
OUTPUT_DIR = os.path.join(BASE_DIR, "output")
RAW_DIR = os.path.join(DATA_DIR, "raw")
LEDGER_PATH = os.path.join(DATA_DIR, "ledger.json")
# Agent 视觉转录队列:扫描件 PDF 渲染的页面图与转录文本存放于此
OCR_QUEUE_DIR = os.path.join(DATA_DIR, "ocr_queue")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# 限速:两次请求最小间隔。日常 3 秒;一次性深度回填可设 FETCH_INTERVAL=2
REQUEST_INTERVAL = float(os.environ.get("FETCH_INTERVAL", "3.0"))
_last_request_ts = [0.0]

for d in (DATA_DIR, CACHE_DIR, OUTPUT_DIR, RAW_DIR, OCR_QUEUE_DIR):
    os.makedirs(d, exist_ok=True)


# ---------------------------------------------------------------- 输出

def log(msg):
    print(msg, flush=True)


def ensure_utf8_stdout():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


# ---------------------------------------------------------------- HTTP

def _irify(url):
    """把 URL 中的非 ASCII 字符(中文文件名等)做百分号编码。
    urllib 直接处理含中文的 URL 会抛 'ascii' codec can't encode。"""
    try:
        url.encode("ascii")
        return url
    except UnicodeEncodeError:
        from urllib.parse import quote, urlsplit, urlunsplit
        p = urlsplit(url)
        return urlunsplit((
            p.scheme,
            p.netloc,
            quote(p.path, safe="/%"),
            quote(p.query, safe="=&?%"),
            p.fragment,
        ))


def fetch_bytes(url, referer=None, retries=3, timeout=45, use_cache=False):
    """下载二进制内容。use_cache=True 时同一 URL 24 小时内复用本地缓存。"""
    url = _irify(url)
    cache_key = hashlib.md5(url.encode("utf-8")).hexdigest()
    cache_path = os.path.join(CACHE_DIR, cache_key + ".bin")

    if use_cache and os.path.exists(cache_path):
        age = time.time() - os.path.getmtime(cache_path)
        if age < 86400:
            with open(cache_path, "rb") as f:
                return f.read()

    last_err = None
    for attempt in range(retries):
        # 限速:两次请求之间至少间隔 REQUEST_INTERVAL 秒
        gap = time.time() - _last_request_ts[0]
        if gap < REQUEST_INTERVAL:
            time.sleep(REQUEST_INTERVAL - gap)

        req = urllib.request.Request(url)
        req.add_header("User-Agent", UA)
        req.add_header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        req.add_header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        if referer:
            req.add_header("Referer", referer)

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            _last_request_ts[0] = time.time()
            if use_cache:
                with open(cache_path, "wb") as f:
                    f.write(data)
            return data
        except Exception as e:
            last_err = e
            _last_request_ts[0] = time.time()
            time.sleep(2 * (attempt + 1))

    raise RuntimeError("下载失败 %s: %s" % (url, last_err))


def fetch_text(url, referer=None, use_cache=False):
    """下载并修复编码后返回文本。"""
    return fix_encoding(fetch_bytes(url, referer=referer, use_cache=use_cache))


# ---------------------------------------------------------------- 编码修复

def fix_encoding(raw):
    """
    修复中文政务网站常见的三类编码问题:
      1. 标准 UTF-8
      2. GBK / GB18030
      3. 双重编码 —— 字节被当作 latin-1 再编码为 UTF-8 (页面出现 å/ç/è 乱码)
    """
    if raw[:3] == b"\xef\xbb\xbf":
        raw = raw[3:]

    text = None
    for enc in ("utf-8", "gb18030"):
        try:
            text = raw.decode(enc)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if text is None:
        text = raw.decode("utf-8", errors="replace")

    # 双重编码判定:开头出现连续的高位 latin-1 特征字符
    probe = text[:4000]
    if probe.count("å") + probe.count("ç") + probe.count("è") + probe.count("é") > 12:
        try:
            repaired = raw.decode("utf-8").encode("latin-1").decode("utf-8")
            if repaired.count("å") < probe.count("å"):
                text = repaired
        except (UnicodeDecodeError, UnicodeEncodeError):
            pass

    return text


# ---------------------------------------------------------------- 文本清洗

def strip_tags(html):
    html = re.sub(r"<script\b.*?</script>", " ", html, flags=re.S | re.I)
    html = re.sub(r"<style\b.*?</style>", " ", html, flags=re.S | re.I)
    html = re.sub(r"<!--.*?-->", " ", html, flags=re.S)
    html = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
    html = re.sub(r"</(p|div|li|tr|h[1-6])>", "\n", html, flags=re.I)
    html = re.sub(r"<[^>]+>", "", html)
    html = html.replace("&nbsp;", " ").replace("&amp;", "&")
    html = html.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    html = html.replace("&#39;", "'").replace("&ldquo;", "\u201c").replace("&rdquo;", "\u201d")
    text = re.sub(r"[ \t\u3000]+", " ", html)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def norm_title(t):
    """标题规范化:去掉 html 残留与多余空白,统一括号。"""
    t = strip_tags(t)
    t = re.sub(r"\s+", "", t)
    t = t.replace("(", "（").replace(")", "）")
    t = t.replace("[", "〔").replace("]", "〕")
    return t.strip()


def to_iso_date(md, ref_year=None):
    """'09-11' -> '2026-09-11'。需传入参考年份(公告列表只给月日)。"""
    if not md:
        return ""
    md = md.strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}$", md):
        return md
    m = re.match(r"^(\d{1,2})-(\d{1,2})$", md)
    if m:
        year = ref_year or datetime.date.today().year
        return "%04d-%02d-%02d" % (year, int(m.group(1)), int(m.group(2)))
    return md


# ---------------------------------------------------------------- 增量去重

def load_ledger():
    if os.path.exists(LEDGER_PATH):
        try:
            with open(LEDGER_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"records": [], "seen": {}, "last_run": ""}


def save_ledger(ledger):
    ledger["last_run"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    tmp = LEDGER_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(ledger, f, ensure_ascii=False, indent=1)
    os.replace(tmp, LEDGER_PATH)


def make_uid(source, url, title):
    """
    稳定唯一 ID。
    中基协 PDF 文件名本身即全局唯一,直接用它;
    其余用「来源 + 正文页 URL」的哈希,避免标题微调导致重复入库。
    """
    m = re.search(r"(P\d{18,})\.pdf", url or "")
    if m:
        return m.group(1)
    raw = "%s|%s" % (source, url or title)
    return hashlib.md5(raw.encode("utf-8")).hexdigest()[:16]


def infer_region(source, title, text=""):
    """从来源、标题与正文片段推断辖区。"""
    regions = ["北京", "上海", "深圳", "广东", "浙江", "江苏", "福建", "山东", "四川",
               "湖北", "湖南", "河南", "河北", "安徽", "陕西", "天津", "重庆", "辽宁",
               "吉林", "黑龙江", "江西", "广西", "云南", "贵州", "山西", "内蒙古",
               "新疆", "甘肃", "宁夏", "青海", "海南", "西藏", "厦门", "宁波", "青岛", "大连"]
    for r in regions:
        if r in (source or "") or r in (title or ""):
            return r
    # 中基协案例:来源/标题无地域词,从主体名称或正文开头的注册城市识别
    city_province = {
        "台州": "浙江", "杭州": "浙江", "温州": "浙江", "金华": "浙江",
        "绍兴": "浙江", "嘉兴": "浙江", "湖州": "浙江", "义乌": "浙江",
        "广州": "广东", "珠海": "广东", "佛山": "广东", "东莞": "广东",
        "南京": "江苏", "苏州": "江苏", "无锡": "江苏", "常州": "江苏", "南通": "江苏",
        "成都": "四川", "武汉": "湖北", "长沙": "湖南", "郑州": "河南", "济南": "山东",
        "西安": "陕西", "福州": "福建", "沈阳": "辽宁", "长春": "吉林",
        "哈尔滨": "黑龙江", "合肥": "安徽", "南昌": "江西", "昆明": "云南",
        "贵阳": "贵州", "南宁": "广西", "海口": "海南", "太原": "山西",
        "石家庄": "河北", "呼和浩特": "内蒙古", "银川": "宁夏", "西宁": "青海",
        "兰州": "甘肃", "乌鲁木齐": "新疆", "拉萨": "西藏",
    }
    for city, prov in city_province.items():
        if city in (text or ""):
            return prov
    if "中基协" in (source or ""):
        return "全国"
    return "全国"


# ---------------------------------------------------------------- 违规类型标签

TAG_RULES = [
    ("登记备案", ["登记备案", "未备案", "备案信息", "登记信息", "实际控制人", "关联方信息",
                  "虚假报送", "信息报送", "虚假记载", "基金经理与实际"]),
    ("募集与适当性", ["募集", "适当性", "合格投资者", "风险测评", "冷静期", "回访", "代持", "宣传推介", "公开宣传", "保本", "保收益", "承诺收益", "差额补足", "回购"]),
    ("投资运作", ["投资比例", "集中度", "超限", "让渡", "委托他人", "投资管理职责",
                  "投资决策", "投资运作", "未按合同约定", "未按照基金合同约定",
                  "违反基金合同约定", "交易价格", "明股实债",
                  "变相借贷", "通道", "不公平对待"]),
    ("信息披露", ["信息披露", "未披露", "未按照规定披露", "未按照", "未及时披露",
                  "向投资者披露", "定期报告", "季报", "年报", "中期报告", "重大信息", "披露义务",
                  "预警线", "止损线", "预警信息"]),
    ("内控与治理", ["内部控制", "内控", "风控负责人", "兼职", "岗位", "制度执行", "关联交易", "印章", "档案", "保存"]),
    ("侵占挪用", ["挪用", "侵占", "利益输送", "自融", "混同", "固有财产"]),
    ("从业资格", ["从业资格", "基金从业", "取消资格", "黑名单", "市场禁入"]),
    ("违规减持", ["减持", "短线交易", "内幕交易", "操纵市场", "编造", "虚假信息"]),
]


def tag_violations(text):
    """按关键词给案例打违规类型标签,返回标签列表。"""
    text = text or ""
    tags = []
    for tag, kws in TAG_RULES:
        if any(kw in text for kw in kws):
            tags.append(tag)
    return tags or ["其他"]


def extract_measures(text):
    """抽取处罚措施类型。"""
    text = text or ""
    found = []
    for m, kws in [
        ("撤销管理人登记", ["撤销", "注销管理人登记", "撤销管理人登记"]),
        ("暂停备案", ["暂停受理", "暂停备案", "暂停产品备案"]),
        ("公开谴责", ["公开谴责"]),
        ("警告", ["警告", "警示函", "出具警示函"]),
        ("责令改正", ["责令改正"]),
        ("罚款", ["罚款", "罚没", "处罚金额", "没收"]),
        ("市场禁入", ["市场禁入", "禁止交易", "证券市场禁入"]),
        ("取消从业资格", ["取消基金从业资格", "取消从业资格"]),
        ("列入黑名单", ["黑名单"]),
        ("监管谈话", ["监管谈话"]),
        ("出具警示函", ["警示函"]),
    ]:
        if any(kw in text for kw in kws):
            found.append(m)
    return found


def extract_amount(text):
    """抽取罚款金额(万元),取文中出现的最大值。"""
    text = text or ""
    vals = []
    for m in re.finditer(r"([\d,]+(?:\.\d+)?)\s*万元", text):
        try:
            vals.append(float(m.group(1).replace(",", "")))
        except ValueError:
            pass
    for m in re.finditer(r"罚(?:款|没)[^\d]{0,12}([\d,]+(?:\.\d+)?)", text):
        try:
            vals.append(float(m.group(1).replace(",", "")))
        except ValueError:
            pass
    return max(vals) if vals else 0.0


def extract_subject(title, text):
    """
    从标题/正文抽取当事人名称。
    注意:地方证监局标题形如「关于对XX公司采取出具警示函措施的决定」,
    括号内是公司名;中基协标题形如「纪律处分决定书(XX有限公司)」。
    必须先匹配标题中的当事人,再退回正文。
    """
    t = norm_title(title)

    # 0) 中基协标题:「纪律处分决定书(XX)」「纪律处分复核决定书(XX)」
    #    必须先剥掉文书名前缀,否则把「纪律处分决定书」整串当成人名。
    m = re.search(r"(?:纪律处分复核决定书|纪律处分决定书|自律管理措施决定书|复核决定书)"
                  r"[（(\[【]\s*([^）)\]】]{2,60})\s*[）)\]】]", t)
    if m:
        cand = m.group(1).strip()
        if cand:
            return cand

    # 1) 「关于对 XXX 采取/出具 ... 措施的决定」
    m = re.search(r"关于对(.+?)(?:采取|出具|予以|作出)", t)
    if m:
        raw = m.group(1).strip()
        # 多当事人时取第一个主体(以、或,分隔),并去掉括号里的补充说明
        raw = re.split(r"[、,，]", raw)[0].strip()
        cand = re.sub(r"^[（(]|[）)]$", "", raw)
        # 括号内是补充说明时剔除(如「上海中路（集团）有限公司」保留全称)
        if 2 <= len(cand) <= 40:
            return cand

    # 2) 标题括号内当事人:决定书(XX)、决定书〔XX〕
    for pat in [r"决定书[（(]([^）)]{2,40})[）)]", r"决定书[〔【]([^〕】]{2,40})[〕】]",
                r"[（(]([^）)]{2,40})[）)]"]:
        m = re.search(pat, t)
        if m:
            cand = m.group(1).strip()
            # 排除纯补充说明碎片(如「集团」「有限责任公司」单字)
            if (len(cand) >= 4
                    and not re.fullmatch(r"[\d\-年月日]+", cand)
                    and not re.fullmatch(r"[（(]?(?:集团|公司|有限|合伙|中心)[）)]?", cand)):
                return cand

    # 3) 正文「当事人:XXX」
    if text:
        head = text[:600]
        m = re.search(r"当事人[:：]\s*([^\n,，。;；]{2,40})", head)
        if m:
            return m.group(1).strip()
        # 4) 正文首行「XXX公司:」——地方局决定书的抬头
        m = re.search(r"^\s*([\u4e00-\u9fa5A-Za-z0-9（）()]{4,40}"
                      r"(?:有限公司|合伙企业|管理中心|投资管理|基金管理|资产管理))\s*[:：]",
                      head, re.M)
        if m:
            return m.group(1).strip()
        m = re.search(r"^\s*([\u4e00-\u9fa5]{2,4})\s*[:：]", head, re.M)
        if m:
            return m.group(1).strip()

    return re.sub(r"^关于对|的决定$", "", t)[:40]


def extract_status(text, title=""):
    """
    判定主体类型:机构 / 个人。
    判据顺序:标题机构词 > 正文个人身份描述 > 标题「关于对XX(2-4字)采取」>
    正文强机构后缀 > 默认机构。
    注意「私募基金」「证券」等泛词不可作为机构判据——所有处罚正文都会出现。
    """
    blob = (title or "") + " " + (text or "")
    org_kw = ["有限公司", "合伙企业", "管理中心", "资产管理", "投资管理",
              "基金管理", "责任公司", "集团", "事务所"]

    # 1) 标题有明确机构特征 → 机构
    if any(k in (title or "") for k in org_kw):
        return "机构"

    # 2) 正文个人身份描述 → 个人
    if re.search(r"（(?:男|女)[,，]\s*\d{4}\s*年", text or "") or \
       re.search(r"(?:男|女)[,，]\s*(?:19|20)\d{2}\s*年\s*\d{1,2}\s*月", text or "") or \
       re.search(r"(?:男|女)[,，]\s*(?:现任|时任)", text or ""):
        return "个人"

    # 3) 「关于对张守军采取…」——短姓名且无机构后缀 → 个人
    m = re.search(r"关于对([\u4e00-\u9fa5]{2,4})采取", title or "")
    if m and not re.search(r"(?:公司|企业|中心|合伙|管理)", m.group(1)):
        return "个人"

    # 4) 正文强机构后缀 → 机构
    if any(k in blob for k in org_kw):
        return "机构"

    return "机构"
