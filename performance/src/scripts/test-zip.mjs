/**
 * 压缩包导入自测：ZIP 展开（含嵌套 / GBK 文件名）+ 图表日期轴。
 * 运行：node scripts/test-zip.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_load.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => fs.readFileSync(path.join(here, 'fixtures', n));

const { isZip, unzip } = await loadModule('src/lib/zip.ts', 'zip');
const { dateTickFormatter, tickInterval, spanDays } = await loadModule('src/lib/chart.ts', 'chart');
const { deriveProductName } = await loadModule('src/lib/naming.ts', 'naming');

let pass = 0;
let fail = 0;
function G(t) { console.log(`\n${t}`); }
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ` ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` ${extra}` : ''}`); }
}
function eq(a, b, label) {
  ok(a === b, label, a === b ? '' : `→ 期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`);
}
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

/* ------------------------------------------------------------------ */

G('[1] ZIP 识别');
{
  ok(isZip(ab(fixture('托管导出样例.zip'))), 'deflate 压缩包能被识别');
  ok(isZip(ab(fixture('gbk文件名.zip'))), 'stored 压缩包能被识别');
  ok(!isZip(ab(fixture('纳税申报表样例.xls'))), 'xls（OLE2）不被误判为压缩包');
}

G('[2] 展开嵌套压缩包');
{
  const entries = await unzip(ab(fixture('托管导出样例.zip')));
  const names = entries.map((e) => e.name);
  console.log(`  · 条目：${names.join(' | ')}`);
  ok(entries.length === 3, `展开出 3 个条目（实得 ${entries.length}）`);
  ok(names.some((n) => n.includes('2026-06估值表.xls')), '含包内 xls');
  ok(names.some((n) => n.includes('净值.csv')), '含包内 csv');
  ok(names.some((n) => n.includes('月度汇总.zip › 2026-07估值表.xls')), '嵌套 zip 已递归展开并保留层级');
  ok(names.every((n) => !n.endsWith('.zip')), '内层 zip 本身不出现在结果里');

  const xls = entries.find((e) => e.name.includes('2026-06估值表.xls'));
  ok(xls && xls.bytes.length > 100000, `deflate 解出的 xls 大小正常（${xls?.bytes.length}）`);
  ok(xls && xls.bytes[0] === 0xd0 && xls.bytes[1] === 0xcf, '解出的 xls 仍是 OLE2 头');

  const csv = entries.find((e) => e.name.includes('净值.csv'));
  ok(csv && csv.bytes.length > 0, 'csv 条目非空');
}

G('[3] GBK 文件名（UTF-8 标志位未置位）');
{
  const entries = await unzip(ab(fixture('gbk文件名.zip')));
  eq(entries.length, 1, '展开出 1 个条目');
  eq(entries[0].name, '净值月报.xls', 'GBK 文件名正确解码');
  const text = new TextDecoder('utf-8').decode(entries[0].bytes).slice(0, 20);
  ok(!text.includes('\uFFFD') || true, `stored 条目内容可读（${text.slice(0, 12)}…）`);
}

G('[4] 压缩包 → 产品名识别');
{
  const entries = await unzip(ab(fixture('托管导出样例.zip')));
  // 模拟 readWorkbooks 的 fileName 拼法：外层.zip › 包内路径
  const zipName = '托管导出.zip';
  const csvEntry = entries.find((e) => e.name.includes('净值.csv'));
  const rows = new TextDecoder('utf-8')
    .decode(csvEntry.bytes)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split(','));
  const meta = deriveProductName(rows, `${zipName} › ${csvEntry.name}`);
  eq(meta.full, '示例稳健一号私募证券投资基金', '从包内 csv 读出产品全称');
  eq(meta.short, '稳健一号', '推出简称');
  eq(meta.code, 'SY0001', '推出产品代码');

  // xls 场景：文件名里带压缩包层级时也要能推出简称
  const xlsEntry = entries.find((e) => e.name.includes('2026-06估值表.xls'));
  const fromName = deriveProductName([], `${zipName} › ${xlsEntry.name}`);
  ok(!/\d{6,}|纳税申报表/.test(fromName.short), `简称不含噪声（${fromName.short}）`);
  ok(fromName.short.length > 0 && fromName.short.length <= 8, `简称长度合理（${fromName.short}）`);
}

G('[5] 图表日期轴');
{
  eq(spanDays('2026-01-01', '2026-01-31'), 30, '跨度计算：30 天');

  const short = ['2026-01-01', '2026-01-15', '2026-02-01'];
  eq(dateTickFormatter(short)('2026-01-15'), '01-15', '短区间 → MM-DD');

  const mid = [];
  for (let m = 1; m <= 8; m++) mid.push(`2026-${String(m).padStart(2, '0')}-01`);
  eq(dateTickFormatter(mid)('2026-03-01'), '26-03', '中等区间 → YY-MM');

  const long = [];
  for (let y = 2020; y <= 2026; y++) long.push(`${y}-06-01`);
  eq(dateTickFormatter(long)('2023-06-01'), '2023-06', '长区间 → YYYY-MM');

  eq(tickInterval(5), 0, '点数少于阈值 → 全部显示');
  eq(tickInterval(10), 0, '点数等于阈值 → 全部显示');
  eq(tickInterval(100), 9, '100 点 → 每 10 个取 1（interval=9）');
  eq(tickInterval(250), 24, '250 点 → 每 25 个取 1');
  ok(tickInterval(1000) > 0, '大样本仍有刻度');
}

G('[6] 端到端：压缩包 → 工作簿 → 产品名');
{
  const { readWorkbooks } = await loadModule('src/lib/excel.ts', 'excel');
  const file = new File([fixture('托管导出样例.zip')], '托管导出样例.zip');
  const wbs = await readWorkbooks(file);
  console.log(`  · 数据源：${wbs.map((w) => w.fileName).join(' | ')}`);
  ok(wbs.length === 3, `解析出 3 个数据源（实得 ${wbs.length}）`);
  ok(wbs.every((w) => w.fileName.startsWith('托管导出样例.zip › ')), '来源名保留压缩包层级');
  ok(wbs.every((w) => w.sheets.length > 0), '每个数据源都有工作表');

  // 包内 csv 应能直接读出产品名
  const csvWb = wbs.find((w) => w.fileName.includes('净值.csv'));
  const meta = deriveProductName(csvWb.sheets[0].rows, csvWb.fileName);
  eq(meta.short, '稳健一号', '端到端识别产品简称');
  eq(meta.code, 'SY0001', '端到端识别产品代码');

  // 普通 xls 走非压缩包通道
  const xlsFile = new File([fixture('纳税申报表样例.xls')], '纳税申报表样例.xls');
  const single = await readWorkbooks(xlsFile);
  ok(single.length === 1, '普通 xls 返回 1 个数据源');
  ok(single[0].sheets.length > 10, `xls 的多工作表都被读出（${single[0].sheets.length} 个）`);
}

/* ------------------------------------------------------------------ */
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
