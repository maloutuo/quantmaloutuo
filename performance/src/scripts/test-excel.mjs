/**

 * 解析引擎自测：构造 5 种真实场景的工作簿，验证版面识别与序列抽取。

 * 运行：node scripts/test-excel.mjs

 */

import * as XLSX from 'xlsx';

import { loadModule } from './_load.mjs';



const L = await loadModule('src/lib/excel.ts', 'excel');

const { analyzeSheet, extractSeries, draftToPoints, normalizeDate, parseNumber, readWorkbooks } = L;



/* ---------- 断言工具 ---------- */

let pass = 0, fail = 0;

const ok = (name, cond, extra = '') => {

  if (cond) { pass++; console.log(`  ✓ ${name}`); }

  else { fail++; console.log(`  ✗ ${name} ${extra}`); }

};



/* ---------- 场景 1：纵向三列（日期/单位净值/累计净值），带标题行 ---------- */

{

  console.log('\n[1] 纵向三列 + 文件标题行');

  const rows = [

    ['某某私募基金净值表'],

    [],

    ['日期', '单位净值', '累计净值'],

    ['2024-01-02', 1.012, 1.052],

    ['2024-01-03', 1.0155, 1.0558],

    ['2024-01-04', 1.0098, 1.0499],

    ['2024-01-05', 1.021, 1.0611],

  ];

  const a = analyzeSheet({ name: 'Sheet1', rows }, 'f.xlsx');

  ok('识别为纵向', a.orientation === 'vertical', a.orientation);

  ok('表头行 = 2', a.headerIndex === 2, String(a.headerIndex));

  ok('日期列 = 0', a.dateIndex === 0, String(a.dateIndex));

  ok('数值轴 = 2 个', a.valueAxes.length === 2, String(a.valueAxes.length));

  const drafts = extractSeries(a);

  const pts = draftToPoints(drafts[0]);

  ok('抽取 4 个点', pts.length === 4, String(pts.length));

  ok('首点日期正确', pts[0].date === '2024-01-02', pts[0]?.date);

  ok('末点净值正确', pts[3].nav === 1.021, String(pts[3]?.nav));

}



/* ---------- 场景 2：纵向宽表（日期 + 4 个产品列）---------- */

{

  console.log('\n[2] 纵向宽表：日期 + 多产品');

  const rows = [

    ['净值日期', '示例一号', '示例二号', '示例一号', '佳成一号'],

    ['2024/1/2', 1.0, 1.0, 1.0, 1.0],

    ['2024/1/3', 1.003, 0.998, 1.012, 0.995],

    ['2024/1/4', 1.008, 1.004, 1.02, 0.99],

    ['2024/1/5', 1.005, 1.011, 1.018, 1.002],

  ];

  const a = analyzeSheet({ name: '净值', rows }, 'f.xlsx');

  ok('日期列命中关键字', a.dateIndex === 0, String(a.dateIndex));

  ok('4 条产品序列', a.valueAxes.length === 4, String(a.valueAxes.length));

  const drafts = extractSeries(a);

  ok('产品名取自表头', drafts[0].name === '示例一号', drafts[0].name);

  ok('斜杠日期归一化', draftToPoints(drafts[0])[0].date === '2024-01-02', draftToPoints(drafts[0])[0].date);

}



/* ---------- 场景 3：横向（日期在行，产品名在首列）---------- */

{

  console.log('\n[3] 横向版面：产品名在首列');

  const rows = [

    ['产品名称', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'],

    ['示例一号', 1.0, 1.003, 1.008, 1.005],

    ['示例二号', 1.0, 0.998, 1.004, 1.011],

    ['示例一号', 1.0, 1.012, 1.02, 1.018],

  ];

  const a = analyzeSheet({ name: 'S', rows }, 'f.xlsx');

  ok('识别为横向', a.orientation === 'horizontal', a.orientation);

  ok('日期行 = 0', a.dateIndex === 0, String(a.dateIndex));

  ok('3 条产品序列', a.valueAxes.length === 3, String(a.valueAxes.length));

  const drafts = extractSeries(a);

  ok('序列名 = 示例一号', drafts[0].name === '示例一号', drafts[0].name);

  ok('4 个日期点', draftToPoints(drafts[0]).length === 4, String(draftToPoints(drafts[0]).length));

}



/* ---------- 场景 4：收益率序列（百分比）自动累乘为净值 ---------- */

{

  console.log('\n[4] 收益率序列（%）→ 净值');

  const rows = [

    ['日期', '日收益率'],

    ['2024-01-02', '0.30%'],

    ['2024-01-03', '-0.15%'],

    ['2024-01-04', '0.52%'],

  ];

  const a = analyzeSheet({ name: 'S', rows }, 'f.xlsx');

  const drafts = extractSeries(a);

  ok('标记为 return', drafts[0].kind === 'return', drafts[0].kind);

  const pts = draftToPoints(drafts[0]);

  ok('起点净值 = 1.003', Math.abs(pts[0].nav - 1.003) < 1e-6, String(pts[0].nav));

  ok('累计复合正确', Math.abs(pts[2].nav - 1.003 * 0.9985 * 1.0052) < 1e-8, String(pts[2].nav));

}



/* ---------- 场景 5：真实 xlsx（Excel 日期序列号 + 千分位 + 空值）---------- */

{

  console.log('\n[5] 真实 xlsx：日期单元格 / 千分位 / 空值');

  const aoa = [

    ['估值日期', '资产净值(元)', '累计净值'],

    [new Date(2024, 0, 2), '1,234,567.89', 1.052],

    [new Date(2024, 0, 3), '', 1.0558],

    [new Date(2024, 0, 4), '1,240,000.00', 1.0499],

    [new Date(2024, 0, 5), '-', 1.0611],

  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });



  // 复刻 readWorkbook 的读法

  const wb2 = XLSX.read(buf, { type: 'array', cellDates: true });

  const raw = XLSX.utils.sheet_to_json(wb2.Sheets['Sheet1'], {

    header: 1, raw: false, defval: '', blankrows: false,

  });

  const cellToText = (v) => {

    if (v == null) return '';

    if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;

    if (typeof v === 'number') return String(v);

    return String(v).replace(/\s+/g, ' ').trim();

  };

  const rows = raw.map((r) => (Array.isArray(r) ? r.map(cellToText) : []))

    .filter((r) => r.some((c) => c !== ''));



  const a = analyzeSheet({ name: 'Sheet1', rows }, 'f.xlsx');

  ok('表头行 = 0', a.headerIndex === 0, String(a.headerIndex));

  ok('日期列 = 0', a.dateIndex === 0, String(a.dateIndex));

  const drafts = extractSeries(a);

  const navPts = draftToPoints(drafts[1]);

  ok('累计净值 4 点', navPts.length === 4, String(navPts.length));

  ok('资产净值千分位解析', parseNumber('1,234,567.89') === 1234567.89, String(parseNumber('1,234,567.89')));

  ok('"-" 视为空', parseNumber('-') === null);

  const assetPts = draftToPoints(drafts[0]);

  ok('资产净值跳过空值 → 2 点', assetPts.length === 2, String(assetPts.length));

}



/* ---------- 场景 6：日期格式兼容 ---------- */

{

  console.log('\n[6] 日期格式兼容');

  ok('yyyy年m月d日', normalizeDate('2024年1月2日') === '2024-01-02', String(normalizeDate('2024年1月2日')));

  ok('yyyymmdd', normalizeDate('20240102') === '2024-01-02', String(normalizeDate('20240102')));

  ok('m/d/yy', normalizeDate('1/2/24') === '2024-01-02', String(normalizeDate('1/2/24')));

  ok('Excel 序列号 45292', normalizeDate('45292') === '2024-01-01', String(normalizeDate('45292')));

  ok('带时间戳', normalizeDate('2024-01-02 00:00:00') === '2024-01-02', String(normalizeDate('2024-01-02 00:00:00')));

  ok('非法日期 2024-02-31', normalizeDate('2024-02-31') === null);

  ok('净值 1.052 不当作日期', normalizeDate('1.052') === null);

}



/* ---------- 场景 7：.xlsx 本身就是 ZIP 归档，必须能直接导入（回归）---------- */

{

  console.log('\n[7] .xlsx 直接导入（本质是 ZIP，不能误判为压缩包容器）');

  const aoa = [

    ['日期', '单位净值', '累计净值'],

    ['2024-01-02', 1.012, 1.052],

    ['2024-01-03', 1.0155, 1.0558],

    ['2024-01-04', 1.0098, 1.0499],

  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const file = new File([buf], '测试产品.xlsx');

  const wbs = await readWorkbooks(file);

  ok('返回 1 个数据源', wbs.length === 1, String(wbs.length));

  ok('首表读出表头 + 3 行 = 4 行', wbs[0].sheets[0].rows.length === 4, String(wbs[0]?.sheets?.[0]?.rows?.length));

  ok('表头含「单位净值」', wbs[0].sheets[0].rows[0].includes('单位净值'), JSON.stringify(wbs[0].sheets[0].rows[0]));

}



console.log(`\n结果：${pass} 通过 / ${fail} 失败`);

process.exit(fail ? 1 : 0);

