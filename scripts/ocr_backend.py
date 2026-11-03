# -*- coding: utf-8 -*-
"""
扫描件 PDF 的 OCR 抽取后端。

背景(实测结论):
  中基协「纪律处分决定书」发布的 PDF 是纯扫描件 —— 每页仅一张位图,
  无文本层,因此 pypdf 提取结果恒为空。要拿到正文必须走 OCR。

本模块提供两级后端,按可用性自动降级:
  1. 腾讯云 OCR(推荐,中文公文识别准确率高)——需设置环境变量:
       TENCENT_SECRET_ID / TENCENT_SECRET_KEY
     调用 GeneralAccurateOCR(通用印刷体高精度版)。
  2. 本地 Tesseract(需自行安装 tesseract 及 chi_sim 语言包)——免费离线。

用法:
  from ocr_backend import ocr_pdf
  text = ocr_pdf(pdf_bytes)          # 自动选择可用后端

依赖:
  图像渲染:pypdfium2(无需额外系统依赖)或 pdf2image+Poppler
"""
import os
import io
import re
import sys
import json
import base64
import hashlib
import subprocess
import urllib.request
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import CACHE_DIR, log


# ---------------------------------------------------------------- PDF 转图片

def pdf_to_images(pdf_bytes, max_pages=8, dpi=200):
    """把 PDF 每页渲染为 PNG 字节列表。"""
    # 优先 pypdfium2:纯 wheel,无系统依赖
    try:
        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(io.BytesIO(pdf_bytes))
        n = min(len(doc), max_pages)
        out = []
        for i in range(n):
            page = doc[i]
            bitmap = page.render(scale=dpi / 72.0)
            pil = bitmap.to_pil()
            buf = io.BytesIO()
            pil.convert("RGB").save(buf, format="PNG")
            out.append(buf.getvalue())
        return out
    except ImportError:
        pass

    # 退回 pdf2image + Poppler
    try:
        from pdf2image import convert_from_bytes
        pages = convert_from_bytes(pdf_bytes, dpi=dpi, first_page=1, last_page=max_pages)
        out = []
        for pil in pages:
            buf = io.BytesIO()
            pil.convert("RGB").save(buf, format="PNG")
            out.append(buf.getvalue())
        return out
    except Exception:
        return []


# ---------------------------------------------------------------- 后端 1:腾讯云 OCR

def _tencent_sign(secret_id, secret_key, payload, endpoint, region, action, version):
    """腾讯云 API 3.0 签名。"""
    import hmac
    import time
    import datetime as _dt

    service = "ocr"
    host = endpoint
    ts = int(time.time())
    date = _dt.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")

    payload_str = json.dumps(payload, ensure_ascii=False)
    hashed = hashlib.sha256(payload_str.encode("utf-8")).hexdigest()

    canonical_headers = "content-type:application/json; charset=utf-8\nhost:%s\n" % host
    signed_headers = "content-type;host"
    canonical_request = "POST\n/\n\n%s\n%s\n%s" % (canonical_headers, signed_headers, hashed)

    algorithm = "TC3-HMAC-SHA256"
    credential_scope = "%s/%s/tc3_request" % (date, service)
    string_to_sign = "%s\n%d\n%s\n%s" % (
        algorithm, ts, credential_scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    )

    def _hmac(key, msg):
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    secret_date = _hmac(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = _hmac(secret_date, service)
    secret_signing = _hmac(secret_service, "tc3_request")
    signature = hmac.new(secret_signing, string_to_sign.encode("utf-8"),
                         hashlib.sha256).hexdigest()

    authorization = ("%s Credential=%s/%s, SignedHeaders=%s, Signature=%s"
                     % (algorithm, secret_id, credential_scope, signed_headers, signature))

    headers = {
        "Authorization": authorization,
        "Content-Type": "application/json; charset=utf-8",
        "Host": host,
        "X-TC-Action": action,
        "X-TC-Timestamp": str(ts),
        "X-TC-Version": version,
        "X-TC-Region": region,
    }
    return headers, payload_str


def _tencent_ocr_image(img_bytes, secret_id, secret_key):
    endpoint = "ocr.tencentcloudapi.com"
    region = "ap-guangzhou"
    action = "GeneralAccurateOCR"
    version = "2018-11-19"

    payload = {"ImageBase64": base64.b64encode(img_bytes).decode("ascii")}
    headers, body = _tencent_sign(secret_id, secret_key, payload, endpoint,
                                  region, action, version)

    req = urllib.request.Request("https://%s" % endpoint,
                                 data=body.encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=45) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    err = data.get("Response", {}).get("Error")
    if err:
        raise RuntimeError("腾讯OCR错误 %s: %s" % (err.get("Code"), err.get("Message")))

    items = data.get("Response", {}).get("TextDetections", [])
    # 按纵向位置排序,尽量还原阅读顺序
    items = sorted(items, key=lambda d: (d.get("Polygon", [{}])[0].get("Y", 0)
                                         if d.get("Polygon") else 0))
    return "\n".join(d.get("DetectedText", "") for d in items)


# ---------------------------------------------------------------- 后端 2:本地 Tesseract

def _tesseract_ocr_image(img_bytes):
    try:
        import pytesseract
        from PIL import Image
        img = Image.open(io.BytesIO(img_bytes))
        return pytesseract.image_to_string(img, lang="chi_sim+eng")
    except Exception:
        return ""


# ---------------------------------------------------------------- 统一入口

def ocr_available():
    """返回可用后端名,None 表示均不可用。"""
    if os.environ.get("TENCENT_SECRET_ID") and os.environ.get("TENCENT_SECRET_KEY"):
        return "tencent"
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
        return "tesseract"
    except Exception:
        pass
    return None


_OCR_CACHE = os.path.join(CACHE_DIR, "ocr")
os.makedirs(_OCR_CACHE, exist_ok=True)


def ocr_pdf(pdf_bytes, key=None, max_pages=8, backend=None):
    """
    对扫描件 PDF 做 OCR,返回纯文本。结果按内容哈希缓存,避免重复计费。
    """
    digest = key or hashlib.md5(pdf_bytes).hexdigest()
    cache_file = os.path.join(_OCR_CACHE, digest + ".txt")
    if os.path.exists(cache_file):
        with open(cache_file, "r", encoding="utf-8") as f:
            return f.read()

    backend = backend or ocr_available()
    if backend is None:
        return ""

    images = pdf_to_images(pdf_bytes, max_pages=max_pages)
    if not images:
        log("      (OCR 跳过:无法渲染 PDF 页面,请安装 pypdfium2)")
        return ""

    chunks = []
    for img in images:
        try:
            if backend == "tencent":
                chunks.append(_tencent_ocr_image(
                    img, os.environ["TENCENT_SECRET_ID"], os.environ["TENCENT_SECRET_KEY"]))
            else:
                chunks.append(_tesseract_ocr_image(img))
        except Exception as e:
            log("      (OCR 单页失败: %s)" % e)

    text = "\n".join(chunks)
    text = re.sub(r"[ \t\u3000]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text).strip()

    if text:
        with open(cache_file, "w", encoding="utf-8") as f:
            f.write(text)
    return text
