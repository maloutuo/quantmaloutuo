/**
 * 指标引擎自测：校验年化口径、回撤、共轨区间对齐、相关性矩阵与捕获率。
 * 运行：node scripts/test-perf.mjs
 */
import { loadModule } from './_load.mjs';

const P = await loadModule('src/lib/perf.ts', 'perf');
const { computeMetrics, computeComparison, alignProducts, alignedToPoints, correlationMatrix, sampleProducts } = P;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const pts = (arr) => arr.map(([d, v]) => ({ date: d, unitNav: v, accumNav: v }));

/* ---------- 1. 收益与回撤 ---------- */
{
  console.log('\n[1] 收益 / 回撤');
  // 1.0 → 1.2 → 0.9 ：总收益 -10%，最大回撤 = 0.9/1.2 - 1 = -25%
  const m = computeMetrics(pts([['2024-01-01', 1.0], ['2024-01-02', 1.2], ['2024-01-03', 0.9]]), 0, 'calendar');
  ok('区间收益率 -10%', near(m.totalReturn, -0.1), String(m.totalReturn));
  ok('最大回撤 -25%', near(m.maxDrawdown, -0.25), String(m.maxDrawdown));
  ok('回撤起点为峰值日', m.maxDrawdownStart === '2024-01-02', m.maxDrawdownStart);
  ok('回撤终点为谷底日', m.maxDrawdownEnd === '2024-01-03', m.maxDrawdownEnd);
  ok('未修复', m.maxDrawdownRecover === null);
  ok('卡玛 = 年化/|回撤|', near(m.calmar, m.annualizedReturn / 0.25), `${m.calmar}`);
  ok('日胜率 1/2', near(m.winRate, 0.5), String(m.winRate));
}

/* ---------- 2. 年化口径 ---------- */
{
  console.log('\n[2] 年化口径：自然日 365 vs 交易日 252');
  // 恰好 365 个自然日、253 个净值日、总收益 +21%
  const series = [['2024-01-01', 1.0]];
  let nav = 1.0;
  for (let i = 1; i <= 252; i++) {
    nav *= Math.pow(1.21, 1 / 252);
    const d = new Date(2024, 0, 1 + i);
    series.push([`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, nav]);
  }
  const p = pts(series);
  const cal = computeMetrics(p, 0, 'calendar');
  const trd = computeMetrics(p, 0, 'trading');
  // 自然日口径：(1+R)^(365/自然日数) − 1
  ok('自然日口径公式正确',
    near(cal.annualizedReturn, Math.pow(1.21, 365 / cal.calendarDays) - 1, 1e-9),
    `${cal.annualizedReturn} vs ${Math.pow(1.21, 365 / cal.calendarDays) - 1}`);
  // 交易日口径：(1+R)^(252/区间收益个数) − 1
  ok('交易日口径公式正确',
    near(trd.annualizedReturn, Math.pow(1.21, 252 / 252) - 1, 1e-9),
    String(trd.annualizedReturn));
  ok('交易日口径 ≈ 21%', Math.abs(trd.annualizedReturn - 0.21) < 1e-6, String(trd.annualizedReturn));
  ok('两种口径可切换且不同', !near(cal.annualizedReturn, trd.annualizedReturn, 1e-9));
}

/* ---------- 3. 夏普 / 索提诺 / VaR ---------- */
{
  console.log('\n[3] 风险调整指标');
  const series = [['2024-01-01', 1.0]];
  let nav = 1.0;
  // 固定交替 ±1%，252 个交易日
  for (let i = 1; i <= 252; i++) {
    nav *= i % 2 === 0 ? 0.99 : 1.01;
    const d = new Date(2024, 0, 1 + i);
    series.push([`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, nav]);
  }
  const m = computeMetrics(series.map(([d, v]) => ({ date: d, unitNav: v, accumNav: v })), 0.02, 'calendar');
  ok('波动率 > 0', m.annualizedVol > 0, String(m.annualizedVol));
  ok('夏普 = (年化-2%)/波动', near(m.sharpe, (m.annualizedReturn - 0.02) / m.annualizedVol, 1e-9), String(m.sharpe));
  ok('|索提诺| > |夏普|（下行波动更小）', Math.abs(m.sortino) > Math.abs(m.sharpe), `${m.sortino} vs ${m.sharpe}`);
  ok('下行波动 < 总波动', m.downsideVol < m.annualizedVol, `${m.downsideVol} vs ${m.annualizedVol}`);
  ok('VaR95 = 1.645σ - 年化', near(m.var95, 1.645 * m.annualizedVol - m.annualizedReturn, 1e-9), String(m.var95));
  ok('日胜率 = 50%', near(m.winRate, 0.5), String(m.winRate));
}

/* ---------- 4. 共轨区间对齐 ---------- */
{
  console.log('\n[4] 多产品共轨区间');
  const A = pts([['2024-01-01', 1.0], ['2024-01-02', 1.1], ['2024-01-03', 1.2], ['2024-01-04', 1.3]]);
  const B = pts([['2024-01-02', 2.0], ['2024-01-03', 2.2], ['2024-01-05', 2.4]]);
  const al = alignProducts([{ id: 'A', points: A }, { id: 'B', points: B }]);
  ok('起始日取交集最大值', al.start === '2024-01-02', al.start);
  ok('结束日取交集最小值', al.end === '2024-01-04', al.end);
  ok('日期并集 3 个', al.dates.length === 3, al.dates.join('/'));
  ok('B 在缺失日向前填充', al.navs.B[2] === 2.2, String(al.navs.B[2]));
  ok('A 序列长度对齐', al.navs.A.length === 3 && al.navs.B.length === 3);
  ok('对齐结果可回算指标', computeMetrics(alignedToPoints(al.dates, al.navs.A), 0, 'calendar').tradingDays === 3);
}

/* ---------- 5. 相关性矩阵 ---------- */
{
  console.log('\n[5] 相关性矩阵');
  const navs = {
    a: [1, 1.1, 1.2, 1.3],
    b: [1, 1.1, 1.2, 1.3],     // 与 a 完全相同
    c: [1, 0.9, 1.0, 0.8],     // 与 a 弱相关
  };
  const m = correlationMatrix(['a', 'b', 'c'], navs);
  ok('自身相关 = 1', m[0][0] === 1 && m[1][1] === 1 && m[2][2] === 1);
  ok('同序列相关 = 1', near(m[0][1], 1), String(m[0][1]));
  ok('矩阵对称', near(m[0][2], m[2][0]));
  ok('相关系数在 [-1,1]', Math.abs(m[0][2]) <= 1, String(m[0][2]));
}

/* ---------- 6. 基准对比与捕获率 ---------- */
{
  console.log('\n[6] 基准对比 / 捕获率');
  // 组合完全复制基准 → β=1，Alpha=0，相关=1，跟踪误差=0
  const n = 60;
  const fund = [], bench = [];
  let fv = 1, bv = 1;
  for (let i = 0; i < n; i++) {
    // 交替 ±，保证收益序列有方差；组合与基准完全一致
    const r = i % 2 === 0 ? 1.012 : 0.994;
    fv *= r;
    bv *= r;
    const d = new Date(2024, 0, 1 + i);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    fund.push({ date: ds, unitNav: fv, accumNav: fv });
    bench.push({ date: ds, unitNav: bv, accumNav: bv });
  }
  const c = computeComparison(fund, bench, 0.02, 'calendar');
  ok('共同交易日 60', c.commonCount === 60, String(c.commonCount));
  ok('Beta ≈ 1', near(c.beta, 1, 1e-6), String(c.beta));
  ok('相关系数 ≈ 1', near(c.correlation, 1, 1e-6), String(c.correlation));
  ok('跟踪误差 ≈ 0', Math.abs(c.trackingError) < 1e-9, String(c.trackingError));
  ok('超额年化 ≈ 0', Math.abs(c.excessAnn) < 1e-9, String(c.excessAnn));
  ok('上行捕获 ≈ 1', near(c.upCapture, 1, 1e-6), String(c.upCapture));

  // 组合在基准上涨时涨 2 倍、下跌时不动 → 上行捕获 ≈ 2，下行捕获 ≈ 0
  const f2 = [], b2 = [];
  let f = 1, b = 1;
  for (let i = 0; i < 60; i++) {
    const up = i % 2 === 0;
    b *= up ? 1.01 : 0.99;
    f *= up ? 1.02 : 1.0;
    const d = new Date(2024, 0, 1 + i);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    f2.push({ date: ds, unitNav: f, accumNav: f });
    b2.push({ date: ds, unitNav: b, accumNav: b });
  }
  const c2 = computeComparison(f2, b2, 0.02, 'calendar');
  ok('上行捕获 > 1', c2.upCapture > 1.5, String(c2.upCapture));
  ok('下行捕获 ≈ 0', Math.abs(c2.downCapture) < 0.05, String(c2.downCapture));
  ok('相对胜率 > 50%', c2.relativeWinRate > 0.5, String(c2.relativeWinRate));
}

/* ---------- 7. 示例数据 ---------- */
{
  console.log('\n[7] 内置示例数据');
  const list = sampleProducts();
  ok('4 条序列', list.length === 4, String(list.length));
  ok('末条为基准', list[3].isBenchmark === true);
  ok('每条 ≥ 2 点', list.every((p) => p.points.length >= 2));
  ok('颜色互不相同', new Set(list.map((p) => p.color)).size === 4);
  const al = alignProducts(list.map((p) => ({ id: p.id, points: p.points })));
  ok('示例数据可对齐', !!al && al.dates.length > 100, String(al?.dates.length));
  const m0 = computeMetrics(alignedToPoints(al.dates, al.navs[list[0].id]), 0.015, 'calendar');
  ok('示例产品指标可计算', Number.isFinite(m0.annualizedReturn) && Number.isFinite(m0.sharpe));
}

/* ---------- 8. 净值口径选择 ---------- */
{
  console.log('\n[8] 共轨区间：净值口径（单位 / 累计 / 复权）');
  // A 有分红：单位净值 1.10 → 除息后 1.00，累计净值 1.10 → 1.10
  const a = [
    { date: '2024-01-01', unitNav: 1.00, accumNav: 1.00, adjNav: 1.00 },
    { date: '2024-01-02', unitNav: 1.10, accumNav: 1.10, adjNav: 1.10 },
    { date: '2024-01-03', unitNav: 1.00, accumNav: 1.10, adjNav: 1.10 },
    { date: '2024-01-04', unitNav: 1.05, accumNav: 1.15, adjNav: 1.15 },
  ];
  const b = [
    { date: '2024-01-01', unitNav: 2.00, accumNav: 2.00, adjNav: 2.00 },
    { date: '2024-01-02', unitNav: 2.20, accumNav: 2.20, adjNav: 2.20 },
    { date: '2024-01-03', unitNav: 2.10, accumNav: 2.10, adjNav: 2.10 },
    { date: '2024-01-04', unitNav: 2.31, accumNav: 2.31, adjNav: 2.31 },
  ];
  const items = [{ id: 'a', points: a }, { id: 'b', points: b }];

  const byUnit = alignProducts(items, { field: 'unit' });
  const byAccum = alignProducts(items, { field: 'accum' });
  const byAdj = alignProducts(items, { field: 'adj' });

  ok('单位口径取到 unitNav', byUnit.navs.a[2] === 1.00, String(byUnit.navs.a[2]));
  ok('累计口径取到 accumNav', byAccum.navs.a[2] === 1.10, String(byAccum.navs.a[2]));
  ok('复权口径取到 adjNav', byAdj.navs.a[2] === 1.10, String(byAdj.navs.a[2]));
  ok('默认口径 = 复权', alignProducts(items).navs.a[2] === byAdj.navs.a[2]);

  const retOf = (al) => computeMetrics(alignedToPoints(al.dates, al.navs.a), 0, 'calendar').totalReturn;
  ok('单位口径收益 5%（分红未再投资）', near(retOf(byUnit), 0.05, 1e-9), String(retOf(byUnit)));
  ok('累计口径收益 15%', near(retOf(byAccum), 0.15, 1e-9), String(retOf(byAccum)));
  ok('复权口径收益 15%', near(retOf(byAdj), 0.15, 1e-9), String(retOf(byAdj)));
  ok('单位口径 ≤ 复权口径', retOf(byUnit) <= retOf(byAdj) + 1e-12);
}

/* ---------- 9. 日期区间 ---------- */
{
  console.log('\n[9] 共轨区间：人工日期区间');
  const mk = (id, from, to) => {
    const out = [];
    const d0 = new Date(`${from}T00:00:00`);
    const d1 = new Date(`${to}T00:00:00`);
    let v = 1;
    for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
      v *= 1.001;
      out.push({
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        unitNav: v, accumNav: v, adjNav: v,
      });
    }
    return { id, points: out };
  };
  const items = [mk('x', '2024-01-01', '2024-12-31'), mk('y', '2024-03-01', '2024-10-31')];

  const full = alignProducts(items);
  ok('全区间起点 = 各序列起点最大值', full.start === '2024-03-01', full.start);
  ok('全区间终点 = 各序列终点最小值', full.end === '2024-10-31', full.end);

  const win = alignProducts(items, { start: '2024-05-01', end: '2024-06-30' });
  ok('人工区间生效（起点）', win.start === '2024-05-01', win.start);
  ok('人工区间生效（终点）', win.end === '2024-06-30', win.end);
  ok('人工区间天数 = 61', win.dates.length === 61, String(win.dates.length));
  ok('人工区间窄于全区间', win.dates.length < full.dates.length);

  const openStart = alignProducts(items, { end: '2024-04-30' });
  ok('只给终点：起点仍取交集', openStart.start === '2024-03-01', openStart.start);
  ok('只给终点：终点生效', openStart.end === '2024-04-30', openStart.end);

  const bad = alignProducts(items, { start: '2025-01-01', end: '2025-02-01' });
  ok('区间内无数据 → null', bad === null);

  const tooShort = alignProducts(items, { start: '2024-05-01', end: '2024-05-01' });
  ok('区间内仅 1 个共同日期 → null', tooShort === null);

  // 人工区间与净值口径可叠加
  const combo = alignProducts(items, { field: 'unit', start: '2024-05-01', end: '2024-05-31' });
  ok('区间 + 口径可叠加', combo.dates.length === 31 && Number.isFinite(combo.navs.x[0]));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
