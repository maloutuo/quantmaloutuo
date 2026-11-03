# -*- coding: utf-8 -*-
"""打开即更新:轻量增量采集 → 重建索引 → 重生成简报与网页。

设计原则:
- **稳**:任一环节失败不阻断后续(采集失败仍用现有台账重建产物)。
- **幂等**:可反复运行;已采过的案例按 UID 去重,不重复入库。
- **自洽**:最后校验产物完整性并打印状态摘要,供 agent 向用户汇报。

耗时提示(2026-09-30 实测):
  默认完整增量 = 采集约 360s + 索引/写回/重建各 1s ≈ **6 分钟**。
  耗时几乎全在采集的列表请求上:36 个源 × 各 3 页 ≈ 104 次请求,
  受 common.REQUEST_INTERVAL(默认 3s)限速约束。
  若需进一步提速,可调低 FETCH_INTERVAL 环境变量(如 1.5),
  或调低 CSRC_PAGES / CSRC_PUNISH_PAGES;但请勿低于 1s 以免被目标站限流。

用法:
  python bootstrap.py              # 标准增量更新(推荐,每工作日/每次打开跑)
  python bootstrap.py --quick      # 只重建产物,不联网采集(离线可用)
  python bootstrap.py --days 30    # 指定简报窗口
"""
import os
import re
import sys
import json
import time
import datetime
import subprocess
import argparse
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

PY = sys.executable
BASE_DIR = os.path.dirname(HERE)
OUTPUT_DIR = os.path.join(BASE_DIR, "output")
DATA_DIR = os.path.join(BASE_DIR, "data")
LEDGER = os.path.join(DATA_DIR, "ledger.json")
KB_INDEX = os.path.join(DATA_DIR, "kb_index.json")
HTML = os.path.join(OUTPUT_DIR, "penalties.html")
# report.py 写出的完整工作台（案例库+锚点解读+制度生成器+问答库）。
# 交付给用户时统一用下面这个中文名；若不在此处同步，用户打开的中文名文件会停留在旧内容。
HTML_DELIVER = os.path.join(
    OUTPUT_DIR, "私募合规工作台·案例库+锚点解读+制度生成器+绩效分析.html")

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def step(n, total, title):
    print("\n[%d/%d] %s" % (n, total, title), flush=True)


def run(args, timeout=900):
    """跑子脚本,返回 (rc, 输出尾部)。"""
    t0 = time.time()
    try:
        r = subprocess.run([PY] + args, capture_output=True, cwd=HERE, timeout=timeout)
        out = (r.stdout.decode("utf-8", "ignore") + r.stderr.decode("utf-8", "ignore")).strip()
        return r.returncode, out, time.time() - t0
    except subprocess.TimeoutExpired:
        return -1, "超时(%ds)" % timeout, time.time() - t0
    except Exception as e:
        return -1, str(e), time.time() - t0


def ledger_stats():
    if not os.path.exists(LEDGER):
        return None
    with open(LEDGER, "r", encoding="utf-8") as f:
        d = json.load(f)
    rs = d.get("records", [])
    from collections import Counter
    st = Counter((r.get("body_status") or "?").split(":")[0] for r in rs)
    dates = [r.get("date") for r in rs if r.get("date")]
    return {
        "total": len(rs),
        "ok": st.get("ok", 0),
        "pending": st.get("pending_ocr", 0),
        "empty": st.get("empty", 0),
        "error": st.get("error", 0),
        "newest": max(dates) if dates else "-",
        "oldest": min(dates) if dates else "-",
    }


def kb_stats():
    if not os.path.exists(KB_INDEX):
        return None
    with open(KB_INDEX, "r", encoding="utf-8") as f:
        d = json.load(f)
    return {"entries": len(d.get("entries", [])),
            "volumes": len(d.get("volumes", [])),
            "built_at": d.get("built_at", "-")}


def write_run_status(payload):
    """把本轮运行状态落到 data/last_run.json。

    为什么要单独落一份:ledger.json 的 last_run 由 ocr_apply.py 无条件刷新,
    连 --quick 离线重建都会改它,不能用来判断"这一轮到底有没有联网采集"。
    本文件只在 bootstrap 跑完时写,且带 mode(steps 含 fetch 与否)与最新快照名,
    自动化巡检直接读它即可分辨"真跑过网"还是"只重建了产物"。
    """
    path = os.path.join(DATA_DIR, "last_run.json")
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        return path
    except Exception as e:
        print("  运行状态写入失败: %s" % e)
        return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30, help="简报窗口天数")
    ap.add_argument("--quick", action="store_true", help="跳过联网采集,只重建产物")
    ap.add_argument("--pages", type=int, default=3,
                    help="各源列表翻页数(默认3,可覆盖约一周的漏跑日)")
    args = ap.parse_args()

    t_start = time.time()
    print("=" * 66)
    print("监管案例爬虫库+锚点解读 · 打开即更新")
    print("时间: %s" % datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    print("=" * 66)

    before = ledger_stats()
    if before:
        print("更新前: 台账 %d 条 | 最新 %s | 待转录 %d"
              % (before["total"], before["newest"], before["pending"]))

    total_steps = 3 if args.quick else 4
    n = 0
    notes = []
    steps = {}

    # 1) 增量采集(各源列表前 N 页,N 由 --pages 控制,默认 3)
    #
    # 2026-09-30 修正:此步原先会先跑一次 `fetch.py --list-only` 作「探测」,
    # 再跑一次完整 `fetch.py`。实测证明 --list-only **并不省钱**:
    # 它照样要走完 36 个源的全部列表页(104 次请求),受 REQUEST_INTERVAL=3s
    # 限速约束,单次耗时 359s,与完整采集 364s 几乎相同。
    # 于是「探测 + 采集」= 同一份列表请求跑两遍,白烧 360s,
    # 使 bootstrap 总耗时从 6 分钟翻倍到 12 分钟(实测 727s)。
    # 现改为只跑一次完整采集;失败情况由 rc 与日志尾部体现,不再预探测。
    #
    # 2026-10-26:--pages 默认由 1 改为 3。原因:只取首页时,一旦某天任务失败漏跑,
    # 次日的首页可能已经滚过那几条,永远补不回来(10-23 江苏元德坤即属此类)。
    # 取 3 页可覆盖约一周的列表深度,漏跑一天不会丢数据。
    if not args.quick:
        n += 1
        step(n, total_steps, "增量采集最新案例(各源列表前 %d 页)" % args.pages)
        os.environ["AMAC_PAGES"] = str(args.pages)
        rc, out, dt = run([os.path.join(HERE, "fetch.py")], timeout=900)
        print("  rc=%s  用时 %.0fs" % (rc, dt))
        tail = "\n".join(out.splitlines()[-14:])
        print("  " + tail.replace("\n", "\n  "))
        notes.append("采集 rc=%s" % rc)
        steps["fetch"] = rc

    # 2) 重建知识库索引
    n += 1
    step(n, total_steps, "重建知识库索引(合规问答 400+ 场景)")
    rc, out, dt = run([os.path.join(HERE, "kb_index.py")], timeout=180)
    print("  rc=%s  用时 %.0fs" % (rc, dt))
    for ln in out.splitlines()[-12:]:
        print("  " + ln)
    notes.append("索引 rc=%s" % rc)
    steps["kb_index"] = rc

    # 3) 扫描件转录稿写回(幂等,有则写)
    n += 1
    step(n, total_steps, "扫描件转录稿写回台账(幂等)")
    rc, out, dt = run([os.path.join(HERE, "ocr_apply.py")], timeout=300)
    print("  rc=%s  用时 %.0fs" % (rc, dt))
    for ln in out.splitlines()[-6:]:
        print("  " + ln)
    notes.append("转录写回 rc=%s" % rc)
    steps["ocr_apply"] = rc

    # 4) 重生成简报与网页
    n += 1
    step(n, total_steps, "重生成简报与案例库网页(含三层锚点)")
    rc, out, dt = run([os.path.join(HERE, "report.py"), "--days", str(args.days)], timeout=900)
    print("  rc=%s  用时 %.0fs" % (rc, dt))
    for ln in out.splitlines()[-8:]:
        print("  " + ln)
    notes.append("报告 rc=%s" % rc)
    steps["report"] = rc

    # 4.5) 同步中文交付名(否则用户打开的中文名文件仍是最旧的)
    if rc == 0 and os.path.exists(HTML):
        try:
            import shutil
            shutil.copyfile(HTML, HTML_DELIVER)
            print("  交付副本: %s" % os.path.basename(HTML_DELIVER))
        except Exception as e:
            print("  交付副本同步失败: %s" % e)

    # 5) 发布到固定位置
    rc, out, dt = run([os.path.join(HERE, "publish.py")], timeout=120)
    steps["publish"] = rc
    if rc == 0:
        for ln in out.splitlines()[-4:]:
            print("  " + ln)

    # 校验
    after = ledger_stats()
    kb = kb_stats()
    print("\n" + "=" * 66)
    print("更新完成 · 总用时 %.0fs" % (time.time() - t_start))
    print("=" * 66)
    if after:
        delta = after["total"] - (before["total"] if before else 0)
        print("台账: %d 条 (新增 %+d) | 正文完整 %d | 待转录 %d | 失败 %d"
              % (after["total"], delta, after["ok"], after["pending"], after["error"]))
        print("覆盖区间: %s ~ %s" % (after["oldest"], after["newest"]))
    if kb:
        print("知识库: %d 条场景 / %d 卷 | 索引建于 %s"
              % (kb["entries"], kb["volumes"], kb["built_at"]))
    html_ok = os.path.exists(HTML)
    print("网页: %s%s" % (HTML, "" if html_ok else "  (缺失!)"))
    print("交付: %s%s" % (HTML_DELIVER, "" if os.path.exists(HTML_DELIVER) else "  (缺失!)"))
    if html_ok:
        print("       %.2f MB,双击即可打开" % (os.path.getsize(HTML) / 1024 / 1024))
    print("环节: " + " | ".join(notes))

    # 6) 落运行状态(供自动化巡检判断"是否真的跑过网")
    snaps = sorted(glob.glob(os.path.join(DATA_DIR, "raw", "penalties_*.json")))
    status = {
        "finished_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "mode": "quick" if args.quick else "full",
        "pages": args.pages,
        "seconds": int(time.time() - t_start),
        "steps": steps,
        "ok": all(v == 0 for v in steps.values()),
        "ledger_total": after["total"] if after else None,
        "ledger_new": (after["total"] - before["total"]) if (after and before) else None,
        "body_ok": after["ok"] if after else None,
        "pending_ocr": after["pending"] if after else None,
        "date_range": [after["oldest"], after["newest"]] if after else None,
        "kb_entries": kb["entries"] if kb else None,
        "latest_snapshot": os.path.basename(snaps[-1]) if snaps else "",
        "html_mb": round(os.path.getsize(HTML) / 1048576, 2) if html_ok else None,
    }
    st_path = write_run_status(status)
    if st_path:
        print("状态: %s (mode=%s, ok=%s)" % (st_path, status["mode"], status["ok"]))


if __name__ == "__main__":
    main()
