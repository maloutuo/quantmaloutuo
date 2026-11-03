/**
 * 冒烟测试：把各页面渲染为字符串，验证组件树在挂载期不抛错。
 * 运行：node scripts/.smoke.cjs（由 package.json 的 smoke 脚本生成）
 */
import { renderToString } from 'react-dom/server';
import App from '@/App';
import { CompareSection } from '@/sections/CompareSection';
import { MetricsSection } from '@/sections/MetricsSection';
import { ChartsSection } from '@/sections/ChartsSection';
import { MonthlyHeatmap } from '@/sections/MonthlyHeatmap';
import { ProductList } from '@/sections/ProductList';
import { AdjustPanel } from '@/sections/AdjustPanel';
import { RelativeTable } from '@/sections/RelativeTable';
import { sampleProducts, sampleWithDividend, computeMetrics, computeComparison, alignedToPoints, alignProducts } from '@/lib/perf';
import { buildAdjusted, detectActions } from '@/lib/adjust';
import { makeProduct } from '@/lib/products';
import { deriveProductName } from '@/lib/naming';

let failed = 0;

function check(name: string, fn: () => string, mustInclude: string[] = []) {
  try {
    const html = renderToString(fn());
    if (!html || html.length < 50) throw new Error(`渲染过短：${html.length}`);
    const missing = mustInclude.filter((k) => !html.includes(k));
    if (missing.length) throw new Error(`缺少关键文案：${missing.join(' / ')}`);
    console.log(`  ✓ ${name}（${html.length} 字符）`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}：${err instanceof Error ? err.message : String(err)}`);
  }
}

const products = sampleProducts();
const fund = products[0];
const bench = products[products.length - 1];
const metrics = computeMetrics(fund.points, 0.015, 'calendar');
const comparison = computeComparison(fund.points, bench.points, 0.015, 'calendar');
const aligned = alignProducts(products.map((p) => ({ id: p.id, points: p.points })))!;

console.log('冒烟测试：SSR 渲染');

check('App（导入页）', () => <App />, ['绩效分析平台', '数据导入', '多产品对比']);
check('产品列表', () => (
  <ProductList products={products} activeId={fund.id} onActivate={() => {}} onUpdate={() => {}} onRemove={() => {}} onClearAll={() => {}} />
), [fund.name]);
check('多产品对比（净值口径 + 日期区间）', () => (
  <CompareSection products={products} rf={1.5} annualMode="calendar" adjustMode="compound" />
), ['共轨区间', '夏普', '净值口径', '单位净值', '累计净值', '复权净值', '起始日期', '结束日期', '近 1 月', '今年以来']);
check('指标卡片', () => <MetricsSection metrics={metrics} />, ['年化收益率', '最大回撤']);
check('净值 / 回撤图表', () => <ChartsSection points={fund.points} metrics={metrics} bench={bench.points} />, ['回撤曲线']);
check('月度热力图', () => <MonthlyHeatmap points={fund.points} />, ['月度收益热力图']);

if (comparison) {
  check('相对基准表', () => (
    <RelativeTable cols={[fund]} relById={{ [fund.id]: comparison }} benchName={bench.name} windowText="测试" showBest={false} />
  ), ['Jensen Alpha', '上行捕获率']);
}

// 共轨区间下重算指标（多产品对比的实际路径）
const alignedMetrics = computeMetrics(alignedToPoints(aligned.dates, aligned.navs[fund.id]), 0.015, 'trading');
check('共轨区间指标卡片', () => <MetricsSection metrics={alignedMetrics} />, ['年化 VaR95', '月度胜率']);

// 含分红产品：复权面板 + 复权后的指标
const divPts = sampleWithDividend();
const divProduct = makeProduct('示例三号（含分红）', divPts, '内置示例', 0);
const divAdjusted = { ...divProduct, points: buildAdjusted(divPts, 'backward', divProduct.detected) };
console.log(`  · 示例含分红产品识别出 ${divProduct.detected.length} 条事件（${detectActions(divPts).length}）`);
check('复权面板（复利复权口径）', () => (
  <AdjustPanel products={[divProduct]} mode="compound" onModeChange={() => {}} onToggleAction={() => {}} />
), ['复权净值计算', '分红', '复利复权净值公式']);

// 产品简称 / 全称 / 代码：模拟托管导出的纳税申报表版式
const taxRows = [
  ['增值税及附加统计表'],
  ['纳税人名称：上海示例私募基金管理有限公司'],
  ['产品名称', '产品代码', '税款所属时间', '销售额', '应纳税额'],
  ['', '', '', 'A', 'B'],
  ['示例稳健一号私募证券投资基金', 'SY0001', '2026-01-01至2026-01-31', '565271', '16958.13'],
  ['示例稳健一号私募证券投资基金', 'SY0001', '2026-02-01至2026-02-28', '0', '0'],
];
const named = deriveProductName(
  taxRows,
  'SY0001_示例稳健一号私募证券投资基金_20260201新规_纳税申报表_1791448635252.xls',
);
console.log(`  · 识别产品：${named.full}（${named.code}）→ 简称「${named.short}」`);
if (named.short !== '稳健一号' || named.code !== 'SY0001') {
  failed++;
  console.error(`  ✗ 产品简称识别：期望 稳健一号 / SY0001，实得 ${named.short} / ${named.code}`);
}
const namedProduct = makeProduct(
  named.short, fund.points, '纳税申报表样例.xls', 0, false,
  { fullName: named.full, code: named.code },
);
check('产品列表（简称 + 全称 + 代码）', () => (
  <ProductList products={[namedProduct]} activeId={namedProduct.id} onActivate={() => {}} onUpdate={() => {}} onRemove={() => {}} onClearAll={() => {}} />
), ['稳健一号', '示例稳健一号私募证券投资基金', 'SY0001']);
check('含分红产品指标', () => (
  <MetricsSection metrics={computeMetrics(divAdjusted.points, 0.015, 'calendar')} />
), ['期末复权净值']);

if (failed) {
  console.error(`\n冒烟失败：${failed} 项`);
  process.exit(1);
}
console.log('\n全部冒烟通过');
