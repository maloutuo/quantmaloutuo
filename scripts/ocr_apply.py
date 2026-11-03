# -*- coding: utf-8 -*-
"""把已完成的转录稿写回台账:
pending_ocr 记录 → body=转录文本, extract_method=agent_vision, body_status=ok

转录稿存放位置(两处都读,兼容历史布局):
  1) data/ocr_queue/<uid>/transcript.txt   —— 原始队列目录
  2) data/transcripts/<uid>.txt            —— 扁平化备份(清理页面图后仍可用)

幂等:仅当转录稿比台账现有正文更长时才覆盖,可反复运行。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from common import load_ledger, save_ledger, OCR_QUEUE_DIR, DATA_DIR, ensure_utf8_stdout, log

ensure_utf8_stdout()

FLAT_DIR = os.path.join(DATA_DIR, "transcripts")


def find_transcript(uid):
    """依次在两个位置找转录稿,返回文本或 None。"""
    cands = [
        os.path.join(OCR_QUEUE_DIR, uid, "transcript.txt"),
        os.path.join(FLAT_DIR, uid + ".txt"),
    ]
    for p in cands:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    t = f.read().strip()
                if t:
                    return t
            except Exception:
                continue
    return None


def main():
    ledger = load_ledger()
    applied, short, missing = 0, 0, 0

    for r in ledger["records"]:
        u = r.get("url", "") or ""
        if not u.lower().endswith(".pdf") or r.get("body_status") == "ok":
            continue
        uid = os.path.basename(u).replace(".pdf", "")
        t = find_transcript(uid)
        if t is None:
            missing += 1
            continue
        if len(t) < 50:
            short += 1
            continue
        if len(t) > len(r.get("body", "") or ""):
            r["body"] = t
            r["extract_method"] = "agent_vision"
            r["body_status"] = "ok"
            applied += 1

    save_ledger(ledger)

    from collections import Counter
    st = Counter((r.get("body_status") or "?").split(":")[0] for r in ledger["records"])
    mt = Counter(r.get("extract_method") for r in ledger["records"])
    log("写回 %d 条(过短跳过 %d, 无转录稿 %d),台账累计 %d 条"
        % (applied, short, missing, len(ledger["records"])))
    log("正文状态: %s" % dict(st))
    log("抽取方法: %s" % dict(mt))


if __name__ == "__main__":
    main()
