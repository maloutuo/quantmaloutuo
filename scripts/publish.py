# -*- coding: utf-8 -*-
"""
每日发布器:把当日简报 DOCX 复制到固定发布位置 output/daily/私募监管处罚简报_最新.docx,
同时保留带日期的历史副本。

用法:
  python publish.py                # 发布当日简报
  python publish.py --date 20260922   # 发布指定日期
  python publish.py --days 7          # 先生成再发布(调用 report.py)
"""
import os
import sys
import shutil
import argparse
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import ensure_utf8_stdout, log, OUTPUT_DIR

ensure_utf8_stdout()

DAILY_DIR = os.path.join(OUTPUT_DIR, "daily")
LATEST_NAME = "私募监管处罚简报_最新.docx"


# 交付给用户的网页 —— 四栏版(案例库 + 问答库 + 制度生成器 + 绩效分析)。
# 注意:report.py 每次都会重建 output/penalties.html(四栏),publish 必须从本文件复制,
# 否则每次更新都会拿旧版覆盖,绩效分析栏会静默消失。
HTML_ALIAS = "私募合规工作台·案例库+锚点解读+制度生成器+绩效分析.html"


def publish(date_stamp=None):
    date_stamp = date_stamp or datetime.date.today().strftime("%Y%m%d")
    os.makedirs(DAILY_DIR, exist_ok=True)

    src_docx = os.path.join(OUTPUT_DIR, "briefing_%s.docx" % date_stamp)
    latest = os.path.join(DAILY_DIR, LATEST_NAME)

    if not os.path.exists(src_docx):
        log("! 未找到当日简报: %s" % src_docx)
        return None, None

    shutil.copy2(src_docx, latest)

    hist = os.path.join(DAILY_DIR, "私募监管处罚简报_%s.docx" % date_stamp)
    shutil.copy2(src_docx, hist)

    # 确保交付网页存在(优先四栏版;若尚未构建则回退到 penalties.html)
    src_html = os.path.join(OUTPUT_DIR, HTML_ALIAS)
    if not os.path.exists(src_html):
        src_html = os.path.join(OUTPUT_DIR, "penalties.html")
    alias = os.path.join(OUTPUT_DIR, HTML_ALIAS)
    # 2026-10-26 修正:bootstrap 已在第 4.5 步把 penalties.html 同步成 alias,
    # 这里再 copy 一次就是把文件复制到自己身上 —— Windows 下 CopyFile2 会抛
    # PermissionError[Win32 32],整支 publish 以 rc=1 退出(此前一直被 bootstrap
    # 静默吞掉)。改为路径不同才复制,且被浏览器占用时降级为告警。
    if os.path.exists(src_html) and os.path.abspath(src_html) != os.path.abspath(alias):
        try:
            shutil.copy2(src_html, alias)
            log("已发布(网页): %s" % alias)
        except Exception as e:
            log("! 网页同步跳过(文件可能正被浏览器打开): %s" % e)
    elif os.path.exists(alias):
        log("网页已就绪(与构建产物同源,无需复制): %s" % alias)

    log("已发布(最新): %s" % latest)
    log("已归档(历史): %s" % hist)
    return latest, hist


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None, help="日期戳 YYYYMMDD,默认今天")
    args = ap.parse_args()
    latest, hist = publish(args.date)
    if latest:
        log("\n对外推送以下文件:")
        log("  1) %s" % latest)
        log("  2) %s" % os.path.join(OUTPUT_DIR, "penalties.html"))
        log("  3) %s" % os.path.join(OUTPUT_DIR, HTML_ALIAS))


if __name__ == "__main__":
    main()
