#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""制度生成器 · 本地服务。

唤醒词「制度生成器」被触发时起本服务,然后把这一行交付给用户:

    http://127.0.0.1:8733/

它只做一件事:把单文件网页挂到本机地址上。不采集、不联网、不写文件、不调外部脚本。

只监听 127.0.0.1,不对外暴露,不提供目录遍历。

用法:
    python generator/scripts/serve.py                # 默认 8733,自动打开浏览器
    python generator/scripts/serve.py --port 9000
    python generator/scripts/serve.py --no-open
"""

import argparse
import os
import socket
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))      # generator/scripts
GEN = os.path.dirname(HERE)                            # generator
HTML = os.path.join(GEN, "output", "私募证券基金管理人内控制度生成器.html")


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="text/plain; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p not in ("/", "/index.html"):
            self._send(404, "not found")
            return
        if not os.path.exists(HTML):
            self._send(404, "产物不存在，请先运行：python generator/scripts/build_platform.py")
            return
        with open(HTML, "rb") as f:
            data = f.read()
        self._send(200, data, "text/html; charset=utf-8")

    def log_message(self, fmt, *a):
        pass


def _in_use(port):
    """先主动探一次：Windows 下 allow_reuse_address 会让 bind 假成功，只靠 OSError 判断不出占用。"""
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def bind(port, tries=20):
    """端口被占用（例如别的 skill 的旧服务还挂着）就顺势往后找，避免崩掉。"""
    for p in range(port, port + tries):
        if _in_use(p):
            if p == port:
                print("  ! 端口 %d 已被占用，自动改用下一个可用端口" % p)
            continue
        try:
            return ThreadingHTTPServer(("127.0.0.1", p), H), p
        except OSError:
            continue
    raise SystemExit("!! %d-%d 均不可用，请用 --port 指定其它端口" % (port, port + tries - 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8733)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.exists(HTML):
        print("!! 产物不存在，请先运行：python generator/scripts/build_platform.py")
        sys.exit(1)

    srv, port = bind(a.port)
    url = "http://127.0.0.1:%d/" % port
    print("=" * 62)
    print("制度生成器 · 本地服务")
    print("=" * 62)
    print("  地址: " + url)
    print("  页面: " + HTML)
    print("  停止: Ctrl+C")
    print("=" * 62)
    if not a.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
