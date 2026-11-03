/**
 * 产品名称识别 / 简称提取 / 乱码还原 自测
 * 运行：node scripts/test-naming.mjs
 */
import XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_load.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { deriveProductName, repairMojibake } = await loadModule('src/lib/naming.ts', 'naming');

let pass = 0;
let fail = 0;
let group = '';

function G(title) {
  group = title;
  console.log(`\n${title}`);
}
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ` ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` ${extra}` : ''}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, actual === expected ? '' : `→ 期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ */

G('[1] 从真实纳税申报表内容里读出产品全称 / 简称 / 代码');
{
  const buf = fs.readFileSync(path.join(here, 'fixtures/纳税申报表样例.xls'));
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets['增值税及附加统计表'];
  const rows = XLSX.utils
    .sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false })
    .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '').replace(/\s+/g, ' ').trim()) : []));

  const meta = deriveProductName(rows, 'SY0001_示例稳健一号私募证券投资基金_20260201新规_纳税申报表_1791448635252.xls');
  eq(meta.full, '示例稳健一号私募证券投资基金', '全称 = 产品名称列的值');
  eq(meta.short, '稳健一号', '简称 = 去掉管理人字号与基金类型后缀');
  eq(meta.code, 'SY0001', '产品代码');
  eq(meta.from, 'content', '来源 = 表内容');
}

G('[2] 仅凭文件名（无表内容）也能推出简称');
{
  const cases = [
    ['SY0001_示例稳健一号私募证券投资基金_20260201新规_纳税申报表_1791448635252.xls', '稳健一号', 'SY0001'],
    ['SY0001示例稳健一号私募证券投资基金估值表20260626.xlsx', '稳健一号', 'SY0001'],
    ['SY0001_月报_2026年6月_示例稳健一号私募证券投资基金.xlsx', '稳健一号', 'SY0001'],
    ['SY0001_年报_2025年_示例稳健一号私募证券投资基金-1.pdf', '稳健一号', 'SY0001'],
    ['示例稳健一号私募证券投资基金_投资者明细表_2025Q4.xlsx', '稳健一号', ''],
    ['10.示例兴鑫一号风险评价等级评估表2021-2024.xlsx', '兴鑫一号', ''],
  ];
  for (const [file, short, code] of cases) {
    const m = deriveProductName([], file);
    eq(m.short, short, `${file.slice(0, 28)}… → ${short}`);
    eq(m.code, code, `  代码 = ${code || '（无）'}`);
  }
}

G('[3] 识别不出基金名时的兜底');
{
  const a = deriveProductName([], '净值数据.xlsx');
  eq(a.short, '净值数据', '普通文件名原样保留');
  eq(a.full, '', '不臆造全称');
  const b = deriveProductName([], '沪深300指数.xlsx');
  eq(b.short, '沪深300指数', '指数文件名原样保留');
}

G('[4] 简称不会把整串文件名带进来');
{
  const m = deriveProductName([], 'SY0001_示例稳健一号私募证券投资基金_20260201新规_纳税申报表_1791448635252.xls');
  ok(!/\d{6,}/.test(m.short), '简称不含长数字串');
  ok(!/纳税申报表|新规|申报表/.test(m.short), '简称不含文档类型词');
  ok(!/^SB\d+/i.test(m.short), '简称不含产品代码');
  ok(m.short.length <= 8, `简称长度 ≤ 8（实得 ${m.short.length}）`);
}

G('[5] 乱码还原：UTF-8 字节被按单字节解码');
{
  const src = '示例稳健一号';
  const bytes = Buffer.from(src, 'utf8');
  const broken = Array.from(bytes).map((b) => String.fromCharCode(b)).join('');
  ok(/[À-ÿ]/.test(broken), '构造出的乱码含 Latin-1 补充区字符');
  eq(repairMojibake(broken), src, '还原回中文');
  eq(repairMojibake('正常中文 123'), '正常中文 123', '正常文本不被改动');
  eq(repairMojibake('NAV 1.052'), 'NAV 1.052', '纯 ASCII 不被改动');
}

/* ------------------------------------------------------------------ */

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
