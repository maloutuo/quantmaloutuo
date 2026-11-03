#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成压缩包导入的测试夹具（需在本目录下执行，依赖 纳税申报表样例.xls）

  python scripts/fixtures/make-fixtures.py

产物：
  托管导出样例.zip   deflate 压缩，含 xls + csv + 嵌套 zip（模拟国君托管「月度 zip 套 zip」）
  gbk文件名.zip      stored，文件名按 GBK 写入且未置 UTF-8 标志位（WinRAR / 360压缩 常见）
"""
import io
import os
import struct
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_XLS = os.path.join(HERE, '纳税申报表样例.xls')

CSV_TEXT = (
    '产品名称,产品代码,净值日期,单位净值,累计净值\n'
    '示例稳健一号私募证券投资基金,SY0001,2026-01-02,1.0120,1.0520\n'
    '示例稳健一号私募证券投资基金,SY0001,2026-01-03,1.0155,1.0558\n'
    '示例稳健一号私募证券投资基金,SY0001,2026-01-04,1.0098,1.0499\n'
    '示例稳健一号私募证券投资基金,SY0001,2026-01-05,1.0201,1.0602\n'
)


def build_nested():
    if not os.path.exists(SRC_XLS):
        raise SystemExit(f'缺少源样例：{SRC_XLS}')
    out = os.path.join(HERE, '托管导出样例.zip')
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(SRC_XLS, '示例稳健一号/2026-06估值表.xls')
        z.writestr('示例稳健一号/净值.csv', CSV_TEXT)
        inner = io.BytesIO()
        with zipfile.ZipFile(inner, 'w', zipfile.ZIP_DEFLATED) as iz:
            iz.write(SRC_XLS, '2026-07估值表.xls')
        z.writestr('示例稳健一号/月度汇总.zip', inner.getvalue())
    print('生成', out, os.path.getsize(out), '字节')


def build_gbk_name():
    """手工拼一个 stored 条目：文件名用 GBK 字节，且 UTF-8 标志位（bit 11）不置位"""
    name = '净值月报.xls'.encode('gbk')
    content = CSV_TEXT.encode('gbk')
    crc = zlib.crc32(content) & 0xFFFFFFFF
    loc = struct.pack(
        '<IHHHHHIIIHH', 0x04034B50, 20, 0, 0, 0, 0,
        crc, len(content), len(content), len(name), 0,
    )
    cen = struct.pack(
        '<IHHHHHHIIIHHHHHII', 0x02014B50, 20, 20, 0, 0, 0, 0,
        crc, len(content), len(content), len(name), 0, 0, 0, 0, 0, 0,
    )
    cen_offset = len(loc) + len(name) + len(content)
    eocd = struct.pack(
        '<IHHHHIIH', 0x06054B50, 0, 0, 1, 1,
        len(cen), cen_offset, 0,
    )
    out = os.path.join(HERE, 'gbk文件名.zip')
    with open(out, 'wb') as f:
        f.write(loc + name + content + cen + name + eocd)
    print('生成', out, os.path.getsize(out), '字节')


if __name__ == '__main__':
    build_nested()
    build_gbk_name()
