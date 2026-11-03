import type { NavPoint, CorpAction, AdjustMode } from '@/types';

/* ==========================================================================
 * 单位净值 / 累计净值 → 复权净值
 *
 * 四种口径：
 *   compound（复利复权，默认）—— 行业通用口径，累乘除息调整因子：
 *       复权净值_t = 单位净值_t × ∏( 分红前单位净值 ÷ 分红后单位净值 )
 *       分红前单位净值 = 除息日前一交易日的单位净值
 *       分红后单位净值 = 分红前单位净值 − 单位分红金额
 *       份额拆分时同乘拆分因子 k。
 *
 *   backward（向后复权，ARGOS）—— 以期初单位净值为锚向后累乘全收益率：
 *       r_t = [ (单位_t + 单位分红_t) × 拆分因子_t ] / 单位_{t−1} − 1
 *
 *   forward（向前复权，ARGOS）—— 以期末单位净值为锚向前折算，用同一组 r_t。
 *
 *   none（不复权）—— 直接采用累计净值，收益 = 累计_t / 累计_{t−1} − 1。
 *
 * ── 两种复权口径的差异（重要）────────────────────────────────
 * 差异不在"是否复权"，而在**分红再投资按什么价格买入**：
 *   · compound 假设分红按"除息后、当日涨跌前"的净值 (U_{t−1} − d) 再投资，
 *     等价于约定除息日先除息、后计当日损益：U_t = (U_{t−1} − d)(1+g)
 *     → 复权净值的日收益率 = g（除息后资产的价格收益率）
 *   · backward 假设分红按当日期末净值 U_t 再投资，r_t = (U_t + d)/U_{t−1} − 1
 *     → 在上述约定下 r_t = g·(1 − d/U_{t−1})，会低于 g
 * 若数据源的除息约定相反（先计损益、后除息：U_t = U_{t−1}(1+g) − d），
 * 则两者的高低关系对调。含大额分红时两者相差可达数十个基点，需与估值口径对齐后选用。
 * ────────────────────────────────────────────────────────────
 * 无分红、无拆分时四种口径的收益序列完全一致，仅净值基准不同。
 * ========================================================================== */

/** 取用于收益计算的净值：优先复权净值 */
export function navOf(p: NavPoint): number {
  return Number.isFinite(p.adjNav) ? p.adjNav : p.accumNav;
}

/* ---------------- 公司行为识别 ---------------- */

/** 单位分红相对阈值：低于期初单位净值的 0.01% 视为数值噪声 */
const DIV_REL_TOL = 1e-4;
/**
 * 拆分判定的两个条件（缺一不可）：
 *  1) 单位净值与累计净值同比例跳变（容差 1%）——拆分时两者同乘 g/k，必然精确成立
 *  2) 该比例落在常见拆分比例附近（容差 3%）
 *
 * 注意：只用条件 1 是不够的。存在存量分红时，普通涨跌下两列比例之差约为
 * g·D/(单位+D)，会随涨跌幅 g 变小而趋近于 0，因而小涨小跌也会"看起来同比例"。
 * 份额拆分几乎总是整数比或简单比，用条件 2 才能把真实涨跌排除掉。
 */
const SPLIT_MATCH = 0.01;
/** 常见拆分比例对应的日净值比（1 份拆为 k 份，价格 ×1/k） */
const CLEAN_RATIOS = [1 / 10, 1 / 8, 1 / 6, 1 / 5, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 4 / 5, 5 / 6, 3 / 2, 2, 3, 4, 5, 10];

/** 找最接近的常见拆分比例；ok 表示偏差在 3% 内（足以覆盖拆分当日的真实涨跌） */
function nearestCleanRatio(r: number): { value: number; ok: boolean } {
  let best = 0;
  let bestErr = Infinity;
  for (const c of CLEAN_RATIOS) {
    const err = Math.abs(r - c) / c;
    if (err < bestErr) {
      bestErr = err;
      best = c;
    }
  }
  return { value: best, ok: bestErr < 0.03 };
}

/**
 * 由「累计净值 − 单位净值 = 累计单位分红」这一恒等式反推公司行为：
 *  - 分红：累计分红额增加（累计净值不跳变，单位净值跳降）
 *  - 拆分：单位净值与累计净值同比例跳变（份额变化，分红额同比缩放）
 */
export function detectActions(points: NavPoint[]): CorpAction[] {
  const out: CorpAction[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (!(prev.unitNav > 0) || !(cur.unitNav > 0) || !(prev.accumNav > 0) || !(cur.accumNav > 0)) continue;

    const ratioU = cur.unitNav / prev.unitNav;
    const ratioA = cur.accumNav / prev.accumNav;

    // 拆分 / 缩份额：两个净值同步同比例跳变
    const sameRatio = Math.abs(ratioU - ratioA) / Math.max(ratioU, 1e-9) < SPLIT_MATCH;
    const prevDividend = Math.max(0, prev.accumNav - prev.unitNav);
    const hasOpeningDividend = prevDividend > prev.unitNav * DIV_REL_TOL;
    const clean = nearestCleanRatio(ratioA);

    if (sameRatio && clean.ok) {
      // 比例中混有当日真实涨跌，还原为最接近的常见拆分比例，避免把涨跌并入份额变化
      const k = 1 / clean.value;
      out.push({
        id: `${cur.date}#split#${i}`,
        date: cur.date,
        type: 'split',
        value: k,
        note: `单位净值与累计净值同步${ratioU < 1 ? '下降' : '上升'}至 ${(ratioU * 100).toFixed(2)}%`
          + `，接近 1:${clean.value.toFixed(4)}，按 1 份拆为 ${k.toFixed(4)} 份处理`
          + (hasOpeningDividend ? '（该日之前已有累计分红）' : ''),
      });
      continue;
    }

    // 分红：累计单位分红增加
    const d = (cur.accumNav - cur.unitNav) - (prev.accumNav - prev.unitNav);
    if (d > prev.unitNav * DIV_REL_TOL) {
      out.push({
        id: `${cur.date}#dividend#${i}`,
        date: cur.date,
        type: 'dividend',
        value: d,
        note: `每份分红 ${d.toFixed(4)} 元（占期初单位净值 ${((d / prev.unitNav) * 100).toFixed(2)}%）`,
      });
    }
  }
  return out;
}

/* ---------------- 复权净值构造 ---------------- */

/** 全收益率序列（首项为 null），修正分红与拆分 */
export function totalReturns(points: NavPoint[], actions: CorpAction[]): (number | null)[] {
  const divMap = new Map<string, number>();
  const splitMap = new Map<string, number>();
  for (const a of actions) {
    if (a.type === 'dividend') divMap.set(a.date, (divMap.get(a.date) ?? 0) + a.value);
    else splitMap.set(a.date, (splitMap.get(a.date) ?? 1) * a.value);
  }

  const out: (number | null)[] = [null];
  for (let i = 1; i < points.length; i++) {
    const prevUnit = points[i - 1].unitNav;
    const div = divMap.get(points[i].date) ?? 0;
    const split = splitMap.get(points[i].date) ?? 1;
    out.push(prevUnit > 0 ? ((points[i].unitNav + div) * split) / prevUnit - 1 : 0);
  }
  return out;
}

/**
 * 复利复权（行业口径）的逐日累计调整因子。
 *
 *   因子_t = ∏( 分红前单位净值 ÷ 分红后单位净值 ) × ∏( 拆分因子 )
 *   分红前单位净值 = 除息日前一交易日单位净值 U_{t−1}
 *   分红后单位净值 = U_{t−1} − 单位分红金额
 *
 * 拆分时投资者份额按 k 倍增加、单位净值按 1/k 下降，总资产不变，
 * 因此同样乘 k 还原到可比口径。
 */
export function compoundFactors(points: NavPoint[], actions: CorpAction[]): number[] {
  const n = points.length;
  const factors = new Array<number>(n).fill(1);
  if (n === 0) return factors;

  // 同一天可能既有分红又有拆分，按日期聚合
  const byDate = new Map<string, CorpAction[]>();
  for (const a of actions) {
    if (!byDate.has(a.date)) byDate.set(a.date, []);
    byDate.get(a.date)!.push(a);
  }

  let cum = 1;
  for (let i = 1; i < n; i++) {
    const acts = byDate.get(points[i].date);
    if (acts) {
      for (const a of acts) {
        if (a.type === 'split') {
          if (a.value > 0) cum *= a.value;
          continue;
        }
        // 分红：分红前取除息日前一交易日单位净值
        const before = points[i - 1].unitNav;
        const after = before - a.value;
        // 保护：分红后净值须为正且非极小值，否则该笔分红不参与复权
        cum *= after > before * 1e-6 ? before / after : 1;
      }
    }
    factors[i] = cum;
  }
  return factors;
}

/**
 * 按指定口径生成复权净值序列（写入 adjNav，保留原始 unitNav / accumNav）。
 * 复利复权与向后复权锚定期初单位净值，向前复权锚定期末单位净值。
 */
export function buildAdjusted(
  points: NavPoint[],
  mode: AdjustMode,
  actions: CorpAction[] = [],
): NavPoint[] {
  const n = points.length;
  if (n === 0) return [];

  if (mode === 'none') {
    return points.map((p) => ({ ...p, adjNav: p.accumNav }));
  }

  if (mode === 'compound') {
    const f = compoundFactors(points, actions);
    return points.map((p, i) => ({ ...p, adjNav: p.unitNav * f[i] }));
  }

  const r = totalReturns(points, actions);
  const adj = new Array<number>(n);

  if (mode === 'backward') {
    adj[0] = points[0].unitNav;
    for (let i = 1; i < n; i++) adj[i] = adj[i - 1] * (1 + (r[i] ?? 0));
  } else {
    adj[n - 1] = points[n - 1].unitNav;
    for (let i = n - 1; i > 0; i--) {
      const rr = r[i] ?? 0;
      adj[i - 1] = Math.abs(1 + rr) < 1e-12 ? adj[i] : adj[i] / (1 + rr);
    }
  }

  return points.map((p, i) => ({ ...p, adjNav: adj[i] }));
}

/* ---------------- 摘要信息 ---------------- */

export interface AdjustSummary {
  /** 期初已累计的单位分红（区间之前的存量分红） */
  openingDividend: number;
  /** 区间内新增分红合计 */
  periodDividend: number;
  dividendCount: number;
  splitCount: number;
  /** 复权口径下的区间收益率 */
  adjustedReturn: number;
  /** 不复权（累计净值）口径下的区间收益率 */
  rawReturn: number;
  /** 向后复权口径下的区间收益率，用于与复利复权对照 */
  backwardReturn: number;
  /** 两种口径的年化差（复权 − 不复权），用于量化低估幅度 */
  hasDifference: boolean;
}

/** 汇总分红/拆分情况，并对比不复权与复权两种口径的结果差异 */
export function summarize(
  points: NavPoint[],
  actions: CorpAction[],
  mode: AdjustMode = 'compound',
): AdjustSummary {
  const openingDividend = points.length ? Math.max(0, points[0].accumNav - points[0].unitNav) : 0;
  const periodDividend = actions
    .filter((a) => a.type === 'dividend')
    .reduce((s, a) => s + a.value, 0);
  const dividendCount = actions.filter((a) => a.type === 'dividend').length;
  const splitCount = actions.filter((a) => a.type === 'split').length;

  const raw = points.length >= 2 && points[0].accumNav > 0
    ? points[points.length - 1].accumNav / points[0].accumNav - 1
    : 0;
  const adjSeries = buildAdjusted(points, mode, actions);
  const adjusted = adjSeries.length >= 2 && adjSeries[0].adjNav > 0
    ? adjSeries[adjSeries.length - 1].adjNav / adjSeries[0].adjNav - 1
    : 0;

  const bw = buildAdjusted(points, 'backward', actions);
  const backward = bw.length >= 2 && bw[0].adjNav > 0
    ? bw[bw.length - 1].adjNav / bw[0].adjNav - 1
    : 0;

  return {
    openingDividend,
    periodDividend,
    dividendCount,
    splitCount,
    adjustedReturn: adjusted,
    rawReturn: raw,
    backwardReturn: backward,
    hasDifference: Math.abs(adjusted - raw) > 1e-9,
  };
}

export const ADJUST_LABELS: Record<AdjustMode, { label: string; hint: string }> = {
  compound: {
    label: '复利复权',
    hint: '复权净值 = 当日单位净值 × ∏(分红前单位净值 ÷ 分红后单位净值)，'
      + '分红前取除息日前一交易日单位净值、分红后 = 分红前 − 单位分红金额；'
      + '份额拆分同乘拆分因子。行业通用口径',
  },
  backward: {
    label: '向后复权',
    hint: '以成立日单位净值为基准向后累乘全收益率 r_t = (单位_t + 单位分红_t) × 拆分因子 / 单位_{t−1} − 1（ARGOS 口径）',
  },
  forward: {
    label: '向前复权',
    hint: '以最后一日单位净值为基准向前折算，历史净值被压缩到当前份额口径（ARGOS 口径）',
  },
  none: {
    label: '不复权',
    hint: '直接采用累计净值。分红后累计净值分母偏大，会低估分红再投资收益',
  },
};
