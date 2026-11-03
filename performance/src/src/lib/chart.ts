/**
 * 图表日期轴工具
 *
 * 之前 X 轴用的是「每隔 N 个点才填一次日期、其余留空」的做法，
 * 悬停 tooltip 拿到的 label 常常是空字符串——曲线上看不到日期。
 * 现在统一：X 轴直接用完整日期，靠 tickFormatter 缩短显示、靠 interval 控制密度，
 * tooltip 的 label 始终是真实日期。
 */

/** 计算两个 ISO 日期之间相差的天数（非法输入返回 0） */
export function spanDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/**
 * 依据区间跨度选择刻度格式：
 *  跨度 > 2 年 → YYYY-MM；> 4 个月 → YY-MM；否则 → MM-DD
 */
export function dateTickFormatter(dates: string[]): (v: string) => string {
  const days = dates.length ? spanDays(dates[0], dates[dates.length - 1]) : 0;
  if (days > 730) return (v: string) => (v ? v.slice(0, 7) : '');
  if (days > 120) return (v: string) => (v ? v.slice(2, 7) : '');
  return (v: string) => (v ? v.slice(5) : '');
}

/**
 * recharts 的 interval 表示「两个刻度之间跳过几个」，
 * 所以要在 n 个点里最多显示 maxTicks 个时取 ceil(n / maxTicks) − 1。
 */
export function tickInterval(n: number, maxTicks = 10): number {
  if (n <= maxTicks) return 0;
  return Math.max(1, Math.ceil(n / maxTicks) - 1);
}
