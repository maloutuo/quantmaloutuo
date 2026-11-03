import type { NavPoint, Metrics, Comparison, AlignedSet, Product, NavField } from '@/types';
import { navOf } from '@/lib/adjust';

/* ============================== 常量与工具 ============================== */

export const TRADING_DAYS = 252;
const CALENDAR_DAYS = 365;

/** 年化口径：自然日 365 / 交易日 252（ARGOS「收益率对齐日历」全局参数） */
export type AnnualMode = 'calendar' | 'trading';

/** 可选净值口径（多产品对比 / 单产品分析通用） */
export const NAV_FIELDS: { value: NavField; label: string; hint: string }[] = [
  { value: 'unit', label: '单位净值', hint: '原始单位净值，分红当日会回落，含分红产品会被低估' },
  { value: 'accum', label: '累计净值', hint: '单位净值 + 累计单位分红，未计入分红再投资收益' },
  { value: 'adj', label: '复权净值', hint: '按所选复权口径还原（默认复利复权），分红再投资，指标计算默认用这条' },
];

export const NAV_FIELD_LABEL: Record<NavField, string> = {
  unit: '单位净值',
  accum: '累计净值',
  adj: '复权净值',
};

/** 按口径取某一期的净值 */
export function navFieldOf(p: NavPoint, field: NavField = 'adj'): number {
  if (field === 'unit') return p.unitNav;
  if (field === 'accum') return p.accumNav;
  return navOf(p);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function cov(xs: number[], ys: number[]): number {
  if (xs.length < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  return xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / (xs.length - 1);
}

function corr(xs: number[], ys: number[]): number {
  const sx = std(xs);
  const sy = std(ys);
  return sx > 0 && sy > 0 ? cov(xs, ys) / (sx * sy) : 0;
}

/** 几何年化：mode=calendar 用自然日，mode=trading 用区间交易日数 */
function annualize(totalReturn: number, calendarDays: number, periods: number, mode: AnnualMode): number {
  const base = 1 + totalReturn;
  if (base <= 0) return -1;
  if (mode === 'trading') {
    const t = Math.max(1, periods);
    return Math.pow(base, TRADING_DAYS / t) - 1;
  }
  const years = Math.max(1, calendarDays) / CALENDAR_DAYS;
  return Math.pow(base, 1 / years) - 1;
}

/* ============================== 指标计算 ============================== */

/**
 * 核心计算引擎。基于累计净值计算收益率（等价于分红再投资），
 * 波动率按交易日 √252 年化；年化收益口径由 mode 决定。
 */
export function computeMetrics(
  points: NavPoint[],
  rfAnnual = 0.015,
  mode: AnnualMode = 'calendar',
): Metrics {
  const n = points.length;
  const navs = points.map(navOf);

  const dailyReturns: (number | null)[] = [null];
  for (let i = 1; i < n; i++) dailyReturns.push(navs[i] / navs[i - 1] - 1);
  const rets = dailyReturns.slice(1) as number[];

  // 回撤
  let peak = navs[0];
  let peakIdx = 0;
  const drawdowns: number[] = [];
  let maxDD = 0, ddStartIdx = 0, ddEndIdx = 0;
  navs.forEach((nav, i) => {
    if (nav > peak) {
      peak = nav;
      peakIdx = i;
    }
    const dd = nav / peak - 1;
    drawdowns.push(dd);
    if (dd < maxDD) {
      maxDD = dd;
      ddStartIdx = peakIdx;
      ddEndIdx = i;
    }
  });
  // 最大回撤修复日：谷底之后首次回到前高
  let recover: string | null = null;
  const high = navs[ddStartIdx];
  for (let i = ddEndIdx + 1; i < n; i++) {
    if (navs[i] >= high) {
      recover = points[i].date;
      break;
    }
  }

  const totalReturn = navs[n - 1] / navs[0] - 1;
  const t0 = new Date(points[0].date).getTime();
  const t1 = new Date(points[n - 1].date).getTime();
  const calendarDays = Math.max(1, Math.round((t1 - t0) / 86400000));
  const annualizedReturn = annualize(totalReturn, calendarDays, rets.length, mode);

  const dailyVol = std(rets);
  const annualizedVol = dailyVol * Math.sqrt(TRADING_DAYS);

  const sharpe = annualizedVol > 0 ? (annualizedReturn - rfAnnual) / annualizedVol : 0;

  const rfDaily = rfAnnual / TRADING_DAYS;
  const downside = rets.filter((r) => r < rfDaily);
  const downsideVol = downside.length > 1 && rets.length > 1
    ? Math.sqrt(downside.reduce((s, r) => s + (r - rfDaily) ** 2, 0) / (rets.length - 1)) * Math.sqrt(TRADING_DAYS)
    : 0;
  const sortino = downsideVol > 0 ? (annualizedReturn - rfAnnual) / downsideVol : 0;

  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r < 0);
  const winRate = rets.length ? wins.length / rets.length : 0;
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = losses.length ? Math.abs(mean(losses)) : 0;
  const profitLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

  const m = mean(rets);
  const s = dailyVol;
  const skewness = s > 0 && rets.length > 2
    ? rets.reduce((sum, r) => sum + ((r - m) / s) ** 3, 0) / rets.length
    : 0;

  // 年化 VaR95（标准正态法）：潜在损失 = Zα × σ_year − R_year
  const var95 = 1.645 * annualizedVol - annualizedReturn;

  // 月度胜率
  const monthly = computeMonthlyReturns(points);
  let mWin = 0;
  let mTotal = 0;
  for (const row of monthly.grid.values()) {
    for (const v of row) {
      if (v == null) continue;
      mTotal++;
      if (v > 0) mWin++;
    }
  }
  const monthlyWinRate = mTotal ? mWin / mTotal : 0;

  return {
    startDate: points[0].date,
    endDate: points[n - 1].date,
    tradingDays: n,
    calendarDays,
    startNav: navs[0],
    endNav: navs[n - 1],
    latestUnitNav: points[n - 1].unitNav,
    latestAdjNav: navs[n - 1],
    openingUnitNav: points[0].unitNav,
    totalReturn,
    annualizedReturn,
    annualizedVol,
    sharpe,
    downsideVol,
    sortino,
    maxDrawdown: maxDD,
    maxDrawdownStart: points[ddStartIdx].date,
    maxDrawdownEnd: points[ddEndIdx].date,
    maxDrawdownRecover: recover,
    calmar: maxDD < 0 ? annualizedReturn / Math.abs(maxDD) : 0,
    winRate,
    profitLossRatio,
    skewness,
    monthlyWinRate,
    var95,
    dailyReturns,
    drawdowns,
  };
}

/* ============================== 基准对比 ============================== */

/**
 * 基准对比：按共同交易日对齐组合与基准累计净值（均视为分红再投资），
 * 计算超额收益、跟踪误差、信息比率、Beta / Alpha、上下行捕获率等相对指标。
 */
export function computeComparison(
  points: NavPoint[],
  bench: NavPoint[],
  rfAnnual = 0.015,
  mode: AnnualMode = 'calendar',
): Comparison | null {
  const bMap = new Map(bench.map((p) => [p.date, navOf(p)]));
  const dates: string[] = [];
  const f: number[] = [];
  const b: number[] = [];
  for (const p of points) {
    const bv = bMap.get(p.date);
    if (bv != null) {
      dates.push(p.date);
      f.push(navOf(p));
      b.push(bv);
    }
  }
  if (dates.length < 10) return null;

  const calendarDays = Math.max(
    1,
    Math.round((new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / 86400000),
  );

  const fundTotal = f[f.length - 1] / f[0] - 1;
  const benchTotal = b[b.length - 1] / b[0] - 1;
  const fundAnn = annualize(fundTotal, calendarDays, f.length - 1, mode);
  const benchAnn = annualize(benchTotal, calendarDays, b.length - 1, mode);

  const fRet: number[] = [];
  const bRet: number[] = [];
  for (let i = 1; i < f.length; i++) {
    fRet.push(f[i] / f[i - 1] - 1);
    bRet.push(b[i] / b[i - 1] - 1);
  }
  const active = fRet.map((r, i) => r - bRet[i]);
  const trackingError = std(active) * Math.sqrt(TRADING_DAYS);

  const excessAnn = fundAnn - benchAnn;                                   // 算术
  const excessAnnGeom = (1 + fundAnn) / (1 + benchAnn) - 1;               // 几何
  const informationRatio = trackingError > 0 ? excessAnn / trackingError : 0;

  const vb = std(bRet) ** 2;
  const beta = vb > 0 ? cov(fRet, bRet) / vb : 0;
  const correlation = corr(fRet, bRet);
  const alpha = fundAnn - rfAnnual - beta * (benchAnn - rfAnnual);
  const treynor = Math.abs(beta) > 1e-9 ? (fundAnn - rfAnnual) / beta : 0;

  const relativeWinRate = active.length ? active.filter((r) => r > 0).length / active.length : 0;
  const erWin = active.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const erLoss = Math.abs(active.filter((r) => r < 0).reduce((s, r) => s + r, 0));
  const relativeProfitLoss = erLoss > 0 ? erWin / erLoss : 0;

  // 上行 / 下行捕获率（ARGOS 4.3）
  const { upCapture, downCapture } = captureRatios(fRet, bRet);

  // 基准自身最大回撤
  let peak = b[0], peakIdx = 0, maxDD = 0, ddStartIdx = 0, ddEndIdx = 0;
  b.forEach((nav, i) => {
    if (nav > peak) { peak = nav; peakIdx = i; }
    const dd = nav / peak - 1;
    if (dd < maxDD) { maxDD = dd; ddStartIdx = peakIdx; ddEndIdx = i; }
  });

  return {
    commonCount: dates.length,
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    fundTotal,
    benchTotal,
    fundAnn,
    benchAnn,
    excessAnn,
    excessAnnGeom,
    trackingError,
    informationRatio,
    beta,
    alpha,
    treynor,
    correlation,
    relativeWinRate,
    relativeProfitLoss,
    upCapture,
    downCapture,
    benchMaxDrawdown: maxDD,
    benchMaxDDStart: dates[ddStartIdx],
    benchMaxDDEnd: dates[ddEndIdx],
  };
}

/**
 * 上行 / 下行捕获率：
 * UC = UCR_p / UCR_b，其中 UCR = [∏(1 + r × 1{r_b ≥ 0})]^(1/T1) − 1
 */
function captureRatios(fRet: number[], bRet: number[]): { upCapture: number; downCapture: number } {
  let upProdP = 1, upProdB = 1, upCount = 0;
  let dnProdP = 1, dnProdB = 1, dnCount = 0;
  for (let i = 0; i < bRet.length; i++) {
    if (bRet[i] >= 0) {
      upProdP *= 1 + fRet[i];
      upProdB *= 1 + bRet[i];
      upCount++;
    } else {
      dnProdP *= 1 + fRet[i];
      dnProdB *= 1 + bRet[i];
      dnCount++;
    }
  }
  const geom = (prod: number, t: number) => (t > 0 && prod > 0 ? Math.pow(prod, 1 / t) - 1 : 0);
  const upP = geom(upProdP, upCount);
  const upB = geom(upProdB, upCount);
  const dnP = geom(dnProdP, dnCount);
  const dnB = geom(dnProdB, dnCount);
  return {
    upCapture: Math.abs(upB) > 1e-12 ? upP / upB : 0,
    downCapture: Math.abs(dnB) > 1e-12 ? dnP / dnB : 0,
  };
}

/* ============================== 多产品对齐 ============================== */

/**
 * 多产品共轨区间对齐（ARGOS：共轨区间 = 所选组合真实区间的交集）。
 * 取各产品首日的最大值到末日的最小值作为区间，区间内取日期并集，
 * 缺失日期按上一有效净值向前填充，保证各产品序列等长可比。
 */
export interface AlignOptions {
  /** 取哪条净值序列，默认复权净值 */
  field?: NavField;
  /** 人工指定的区间起点（含），为空则不限制 */
  start?: string;
  /** 人工指定的区间终点（含），为空则不限制 */
  end?: string;
}

/**
 * 共轨区间对齐：各产品日期区间取交集，缺失日期按上一有效净值填充。
 * 传入 start / end 时先按该区间裁剪各序列，再求交集——即对比窗口完全由人工区间决定。
 */
export function alignProducts(
  items: { id: string; points: NavPoint[] }[],
  opts: AlignOptions = {},
): AlignedSet | null {
  const field = opts.field ?? 'adj';
  const lo = opts.start || '0000-00-00';
  const hi = opts.end || '9999-99-99';

  const clipped = items.map((p) => ({
    id: p.id,
    points: p.points.filter((pt) => pt.date >= lo && pt.date <= hi),
  }));
  const usable = clipped.filter((p) => p.points.length >= 2);
  if (usable.length === 0) return null;

  const start = usable.reduce((a, p) => (p.points[0].date > a ? p.points[0].date : a), '0000-00-00');
  const end = usable.reduce(
    (a, p) => (p.points[p.points.length - 1].date < a ? p.points[p.points.length - 1].date : a),
    '9999-99-99',
  );
  if (start > end) return null;

  const set = new Set<string>();
  for (const p of usable) {
    for (const pt of p.points) {
      if (pt.date >= start && pt.date <= end) set.add(pt.date);
    }
  }
  const dates = [...set].sort();
  if (dates.length < 2) return null;

  const navs: Record<string, number[]> = {};
  for (const p of usable) {
    const map = new Map(p.points.map((pt) => [pt.date, navFieldOf(pt, field)]));
    const arr: number[] = [];
    let last = navFieldOf(p.points[0], field);
    for (const d of dates) {
      const v = map.get(d);
      if (v != null) last = v;
      arr.push(last);
    }
    navs[p.id] = arr;
  }
  return { dates, navs, start, end };
}

/** 由对齐后的净值序列反推 NavPoint（用于按共轨区间重算指标） */
export function alignedToPoints(dates: string[], navs: number[]): NavPoint[] {
  return dates.map((d, i) => ({ date: d, unitNav: navs[i], accumNav: navs[i], adjNav: navs[i] }));
}

/** 相关性矩阵：ids 顺序对应矩阵行列 */
export function correlationMatrix(ids: string[], navsById: Record<string, number[]>): number[][] {
  const rets: Record<string, number[]> = {};
  for (const id of ids) {
    const nv = navsById[id] ?? [];
    const r: number[] = [];
    for (let i = 1; i < nv.length; i++) r.push(nv[i] / nv[i - 1] - 1);
    rets[id] = r;
  }
  return ids.map((a) => ids.map((b) => (a === b ? 1 : corr(rets[a] ?? [], rets[b] ?? []))));
}

/* ============================== 月度收益 ============================== */

export interface MonthlyGrid {
  years: number[];
  grid: Map<number, (number | null)[]>;
  yearReturns: Map<number, number>;
}

/**
 * 按自然月聚合累计净值：每月取月末最后一条净值，
 * 月收益 = 本月末净值 / 上月末净值 − 1（首月以期初净值为基准）。
 */
export function computeMonthlyReturns(points: NavPoint[]): MonthlyGrid {
  const monthEnd = new Map<string, number>();
  for (const p of points) monthEnd.set(p.date.slice(0, 7), navOf(p));
  const months = [...monthEnd.keys()].sort();

  const grid = new Map<number, (number | null)[]>();
  const yearReturns = new Map<number, number>();
  let prevNav = navOf(points[0]);
  let yearStartNav: number | null = null;
  let curYear = -1;

  for (const m of months) {
    const year = Number(m.slice(0, 4));
    const mi = Number(m.slice(5, 7)) - 1;
    const nav = monthEnd.get(m)!;
    if (year !== curYear) {
      if (curYear !== -1 && yearStartNav != null && prevNav !== yearStartNav) {
        yearReturns.set(curYear, prevNav / yearStartNav - 1);
      }
      curYear = year;
      yearStartNav = prevNav;
    }
    if (!grid.has(year)) grid.set(year, Array(12).fill(null));
    grid.get(year)![mi] = nav / prevNav - 1;
    prevNav = nav;
  }
  if (curYear !== -1 && yearStartNav != null) {
    yearReturns.set(curYear, prevNav / yearStartNav - 1);
  }

  return { years: [...grid.keys()].sort(), grid, yearReturns };
}

/* ============================== 示例数据 ============================== */

export const PRODUCT_COLORS = [
  '#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5',
];

/**
 * 确定性伪随机（固定种子）生成示例组合：共享市场因子，
 * 保证各产品间日收益相关性 ≈ 0.5~0.8，贴近真实多产品场景。
 */
function generateSample(): { names: string[]; series: NavPoint[][] } {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const gauss = () => {
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  const specs = [
    { name: '示例一号', drift: 0.0011, market: 0.010, idio: 0.006 },
    { name: '示例二号', drift: 0.0007, market: 0.007, idio: 0.009 },
    { name: '示例一号', drift: 0.0005, market: 0.005, idio: 0.004 },
    { name: '沪深300（基准）', drift: 0.00025, market: 0.005, idio: 0.0035 },
  ];

  const series: NavPoint[][] = specs.map(() => []);
  const navs = specs.map(() => 1.0);
  const start = new Date(2024, 0, 2);

  for (let i = 0; i < 620; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const zm = gauss();
    specs.forEach((s, k) => {
      const z = gauss();
      navs[k] *= 1 + s.drift + s.market * zm + s.idio * z;
      const v = Number(navs[k].toFixed(4));
      series[k].push({ date: d.toISOString().slice(0, 10), unitNav: v, accumNav: v, adjNav: v });
    });
  }
  return { names: specs.map((s) => s.name), series };
}

/** 示例数据集：3 只产品 + 1 条基准 */
export function sampleProducts(): Product[] {
  const { names, series } = generateSample();
  return series.map((points, i) => ({
    id: `sample-${i}`,
    name: names[i],
    points,
    color: PRODUCT_COLORS[i % PRODUCT_COLORS.length],
    visible: true,
    source: '内置示例',
    isBenchmark: i === series.length - 1,
    detected: [],
    ignored: [],
  }));
}

/** 构造带分红事件的示例：在第 120 个交易日每份分红 0.15 元，用于演示复权差异 */
export function sampleWithDividend(): NavPoint[] {
  const base = generateSample().series[0];
  const divDate = base[Math.min(119, base.length - 1)].date;
  let cumDiv = 0;
  return base.map((p) => {
    if (p.date === divDate) cumDiv += 0.15;
    return {
      date: p.date,
      unitNav: Number((p.unitNav - cumDiv).toFixed(4)),
      accumNav: p.unitNav,
      adjNav: p.unitNav,
    };
  });
}

/* ============================== 展示格式化 ============================== */

export const fmtPct = (x: number, digits = 2, signed = true) =>
  `${signed && x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`;

export const fmtNum = (x: number, digits = 2) => x.toFixed(digits);

/** 无数据时统一占位 */
export const DASH = '—';

export const fmtPctOrDash = (x: number | null | undefined, digits = 2) =>
  x == null || !Number.isFinite(x) ? DASH : fmtPct(x, digits);

export const fmtNumOrDash = (x: number | null | undefined, digits = 2) =>
  x == null || !Number.isFinite(x) ? DASH : x.toFixed(digits);
