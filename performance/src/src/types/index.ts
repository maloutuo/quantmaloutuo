export interface NavPoint {
  /** ISO 日期 yyyy-MM-dd */
  date: string;
  /** 单位净值（原始，分红后会回落） */
  unitNav: number;
  /** 累计净值（原始 = 单位净值 + 累计单位分红） */
  accumNav: number;
  /**
   * 复权净值：按当前复权口径计算出的可比值序列。
   * 收益类、风险类指标一律基于该序列；未启用复权时等于累计净值。
   */
  adjNav: number;
}

/**
 * 复权口径：
 *  compound —— 复利复权（行业通用，默认）：累乘除息调整因子
 *  backward —— 向后复权（ARGOS）：以期初单位净值为锚累乘全收益率
 *  forward  —— 向前复权（ARGOS）：以期末单位净值为锚向前折算
 *  none     —— 不复权：直接用累计净值
 */
export type AdjustMode = 'compound' | 'backward' | 'forward' | 'none';

/**
 * 净值口径：多产品对比时选择用哪条净值序列画图、算指标。
 *  unit  —— 单位净值（分红当日会回落，含分红的产品会被低估）
 *  accum —— 累计净值（单位净值 + 累计单位分红，分红不再回落但仍未再投资）
 *  adj   —— 复权净值（按所选复权口径还原，分红再投资；指标计算默认用这条）
 */
export type NavField = 'unit' | 'accum' | 'adj';

/** 公司行为（分红 / 拆分），由单位净值与累计净值反推 */
export interface CorpAction {
  /** 稳定 id：日期 + 类型 + 序号 */
  id: string;
  date: string;
  type: 'dividend' | 'split';
  /** 分红：每份分红金额（元）；拆分：拆分因子 k（1 份变 k 份，价格 ÷ k） */
  value: number;
  /** 推断依据，用于人工核对 */
  note: string;
}

/** 一条净值序列（产品 / 组合 / 基准） */
export interface Product {
  id: string;
  /** 展示用名称（优先产品简称，如「稳健一号」） */
  name: string;
  /** 完整产品名，如「示例稳健一号私募证券投资基金」 */
  fullName?: string;
  /** 产品代码，如「SY0001」 */
  code?: string;
  points: NavPoint[];
  /** 图表配色 */
  color: string;
  /** 是否参与对比 */
  visible: boolean;
  /** 数据来源（文件名 / 工作表名 / 粘贴） */
  source: string;
  /** 作为对比基准（不参与产品间排名） */
  isBenchmark: boolean;
  /** 自动识别出的分红 / 拆分事件 */
  detected: CorpAction[];
  /** 被人工忽略的事件 id（不参与复权计算） */
  ignored: string[];
}

export interface Metrics {
  startDate: string;
  endDate: string;
  tradingDays: number;
  calendarDays: number;
  startNav: number;
  endNav: number;
  latestUnitNav: number;
  /** 期末复权净值（当前复权口径下的可比值） */
  latestAdjNav: number;
  /** 期初单位净值（向后复权锚点） */
  openingUnitNav: number;
  totalReturn: number;
  annualizedReturn: number;
  annualizedVol: number;
  sharpe: number;
  downsideVol: number;
  sortino: number;
  maxDrawdown: number;
  maxDrawdownStart: string;
  maxDrawdownEnd: string;
  maxDrawdownRecover: string | null;
  calmar: number;
  winRate: number;
  profitLossRatio: number;
  skewness: number;
  /** 月度胜率：上涨月份 / 有数据月份 */
  monthlyWinRate: number;
  /** 年化 VaR95（标准正态法，正数表示潜在损失幅度） */
  var95: number;
  /** 日收益率序列（与 points 对齐，首项为 null） */
  dailyReturns: (number | null)[];
  /** 回撤序列（与 points 对齐） */
  drawdowns: number[];
}

/** 基准对比结果（按共同交易日对齐） */
export interface Comparison {
  commonCount: number;
  startDate: string;
  endDate: string;
  fundTotal: number;
  benchTotal: number;
  fundAnn: number;
  benchAnn: number;
  /** 年化超额（算术差） */
  excessAnn: number;
  /** 年化超额（几何： (1+Rp)/(1+Rb) − 1 后年化） */
  excessAnnGeom: number;
  trackingError: number;
  informationRatio: number;
  beta: number;
  /** 年化 Jensen Alpha */
  alpha: number;
  /** 特雷诺比率 */
  treynor: number;
  correlation: number;
  /** 日度相对胜率：组合日收益高于基准的比例 */
  relativeWinRate: number;
  /** 相对盈亏比 */
  relativeProfitLoss: number;
  /** 上行捕获率 */
  upCapture: number;
  /** 下行捕获率 */
  downCapture: number;
  benchMaxDrawdown: number;
  benchMaxDDStart: string;
  benchMaxDDEnd: string;
}

/** 多产品共轨区间对齐结果 */
export interface AlignedSet {
  /** 共轨区间内的全部日期（升序，取各产品日期并集） */
  dates: string[];
  /** productId → 与 dates 等长的净值序列（缺失日期向前填充） */
  navs: Record<string, number[]>;
  start: string;
  end: string;
}
