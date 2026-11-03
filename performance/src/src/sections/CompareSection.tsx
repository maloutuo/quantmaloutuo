import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Info, Trophy, Grid3x3, LineChart as LineIcon, CalendarRange, Download, Scale, RotateCcw } from 'lucide-react';
import { RelativeTable, REL_ROWS } from '@/sections/RelativeTable';
import {
  alignProducts, alignedToPoints, correlationMatrix, computeComparison, computeMetrics,
  computeMonthlyReturns, fmtNum, fmtNumOrDash, fmtPct, fmtPctOrDash, DASH,
  NAV_FIELDS, NAV_FIELD_LABEL,
  type AnnualMode,
} from '@/lib/perf';
import { ADJUST_LABELS } from '@/lib/adjust';
import { dateTickFormatter, tickInterval } from '@/lib/chart';
import type { AdjustMode, Comparison, Metrics, NavField, Product } from '@/types';

interface Props {
  products: Product[];
  rf: number;
  annualMode: AnnualMode;
  /** 当前复权口径，仅用于展示口径说明 */
  adjustMode: AdjustMode;
}

/* ---------------- 指标行定义 ---------------- */

type Better = 1 | -1 | 0;

interface RowDef {
  group: string;
  label: string;
  hint: string;
  better: Better;
  digits?: number;
  /** 取指标值 */
  value: (m: Metrics) => number | null;
  fmt: (m: Metrics) => string;
}

const pct = (x: number | null) => fmtPctOrDash(x);
const pctPlain = (x: number | null) => (x == null ? DASH : fmtPct(x, 2, false));
const num = (x: number | null) => fmtNumOrDash(x, 2);

const METRIC_ROWS: RowDef[] = [
  { group: '收益', label: '区间收益率', hint: '期末累计净值 / 期初累计净值 − 1', better: 1, value: (m) => m.totalReturn, fmt: (m) => pct(m.totalReturn) },
  { group: '收益', label: '年化收益率', hint: '几何年化（口径见导入页设置）', better: 1, value: (m) => m.annualizedReturn, fmt: (m) => pct(m.annualizedReturn) },
  { group: '收益', label: '期末净值', hint: '共轨区间最后一期净值（按当前复权口径）', better: 0, value: (m) => m.endNav, fmt: (m) => fmtNum(m.endNav, 4) },
  { group: '风险', label: '年化波动率', hint: '日收益率标准差 × √252', better: -1, value: (m) => m.annualizedVol, fmt: (m) => pctPlain(m.annualizedVol) },
  { group: '风险', label: '下行波动率', hint: '低于无风险利率的收益偏差年化', better: -1, value: (m) => m.downsideVol, fmt: (m) => pctPlain(m.downsideVol) },
  { group: '风险', label: '最大回撤', hint: '净值创新高后至最低点的最大跌幅（越接近 0 越好）', better: 1, value: (m) => m.maxDrawdown, fmt: (m) => pct(m.maxDrawdown) },
  { group: '风险', label: '年化 VaR95', hint: '标准正态法：1.645 × σ年化 − 年化收益（正数＝潜在损失）', better: -1, value: (m) => m.var95, fmt: (m) => pctPlain(m.var95) },
  { group: '风险调整', label: '夏普比率', hint: '(年化收益 − 无风险利率) / 年化波动率', better: 1, value: (m) => m.sharpe, fmt: (m) => num(m.sharpe) },
  { group: '风险调整', label: '索提诺比率', hint: '(年化收益 − 无风险利率) / 下行波动率', better: 1, value: (m) => m.sortino, fmt: (m) => num(m.sortino) },
  { group: '风险调整', label: '卡玛比率', hint: '年化收益率 / |最大回撤|', better: 1, value: (m) => m.calmar, fmt: (m) => num(m.calmar) },
  { group: '胜率', label: '日胜率', hint: '上涨交易日占比', better: 1, value: (m) => m.winRate, fmt: (m) => pctPlain(m.winRate) },
  { group: '胜率', label: '月度胜率', hint: '上涨月份 / 有数据月份', better: 1, value: (m) => m.monthlyWinRate, fmt: (m) => pctPlain(m.monthlyWinRate) },
  { group: '胜率', label: '盈亏比', hint: '平均上涨幅度 / 平均下跌幅度', better: 1, value: (m) => m.profitLossRatio, fmt: (m) => num(m.profitLossRatio) },
  { group: '胜率', label: '收益偏度', hint: '日收益率分布偏度，>0 右偏', better: 0, value: (m) => m.skewness, fmt: (m) => fmtNumOrDash(m.skewness, 3) },
];

/* ---------------- 组件 ---------------- */

export function CompareSection({ products, rf, annualMode, adjustMode }: Props) {
  const [view, setView] = useState<'metrics' | 'chart' | 'corr' | 'monthly' | 'rel'>('metrics');
  /** 净值口径：单位 / 累计 / 复权 */
  const [field, setField] = useState<NavField>('adj');
  /** 人工区间，空字符串表示不限 */
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');

  const selected = useMemo(() => products.filter((p) => p.visible), [products]);
  const bench = useMemo(() => selected.find((p) => p.isBenchmark) ?? null, [selected]);

  /** 全部所选序列的可用日期范围（供区间控件取边界与快捷按钮计算） */
  const fullRange = useMemo(() => {
    let s = '9999-99-99';
    let e = '0000-00-00';
    for (const p of selected) {
      if (!p.points.length) continue;
      const a = p.points[0].date;
      const b = p.points[p.points.length - 1].date;
      if (a < s) s = a;
      if (b > e) e = b;
    }
    return s <= e ? { start: s, end: e } : null;
  }, [selected]);

  // 产品集合变化后，已有的人工区间若已越界则清空
  useEffect(() => {
    if (!fullRange) return;
    setRangeStart((v) => (v && (v < fullRange.start || v > fullRange.end) ? '' : v));
    setRangeEnd((v) => (v && (v < fullRange.start || v > fullRange.end) ? '' : v));
  }, [fullRange]);

  /** 共轨区间对齐（含基准，保证对比窗口一致）；按所选净值口径与人工区间 */
  const aligned = useMemo(
    () => alignProducts(selected.map((p) => ({ id: p.id, points: p.points })), {
      field,
      start: rangeStart || undefined,
      end: rangeEnd || undefined,
    }),
    [selected, field, rangeStart, rangeEnd],
  );

  const hasRange = !!(rangeStart || rangeEnd);

  const metricsById = useMemo(() => {
    const out: Record<string, Metrics> = {};
    if (!aligned) return out;
    for (const p of selected) {
      const navs = aligned.navs[p.id];
      if (!navs || navs.length < 2) continue;
      out[p.id] = computeMetrics(alignedToPoints(aligned.dates, navs), rf / 100, annualMode);
    }
    return out;
  }, [aligned, selected, rf, annualMode]);

  const relById = useMemo(() => {
    const out: Record<string, Comparison> = {};
    if (!aligned || !bench) return out;
    const benchPts = alignedToPoints(aligned.dates, aligned.navs[bench.id]);
    for (const p of selected) {
      if (p.isBenchmark) continue;
      const pts = alignedToPoints(aligned.dates, aligned.navs[p.id]);
      const c = computeComparison(pts, benchPts, rf / 100, annualMode);
      if (c) out[p.id] = c;
    }
    return out;
  }, [aligned, selected, bench, rf, annualMode]);

  /** 参与排名/最优标记的产品（不含基准） */
  const ranked = useMemo(() => selected.filter((p) => !p.isBenchmark && metricsById[p.id]), [selected, metricsById]);

  const corr = useMemo(() => {
    if (!aligned) return null;
    const ids = selected.filter((p) => aligned.navs[p.id]).map((p) => p.id);
    if (ids.length < 2) return null;
    return { ids, matrix: correlationMatrix(ids, aligned.navs) };
  }, [aligned, selected]);

  const monthly = useMemo(() => {
    if (!aligned) return null;
    const perProduct = new Map<string, Map<string, number>>();
    const months = new Set<string>();
    for (const p of selected) {
      const navs = aligned.navs[p.id];
      if (!navs) continue;
      const g = computeMonthlyReturns(alignedToPoints(aligned.dates, navs));
      const map = new Map<string, number>();
      for (const [year, row] of g.grid) {
        row.forEach((v, mi) => {
          if (v == null) return;
          const key = `${year}-${String(mi + 1).padStart(2, '0')}`;
          map.set(key, v);
          months.add(key);
        });
      }
      perProduct.set(p.id, map);
    }
    return { months: [...months].sort(), perProduct };
  }, [aligned, selected]);

  if (selected.length < 2) {
    return (
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          多产品对比需要至少 2 条参与对比的序列。请在「数据导入」中导入多列宽表或多个文件，并勾选列表中的「对比」列。
        </AlertDescription>
      </Alert>
    );
  }

  if (!aligned) {
    return (
      <Alert variant="destructive">
        <Info className="h-4 w-4" />
        <AlertDescription className="space-y-2">
          <div>
            {hasRange
              ? '所选日期区间内没有足够的共同数据（至少需要 2 个共同日期）。'
              : '所选序列的日期区间没有交集，无法确定共轨区间。请调整产品选择，或检查净值数据的日期范围。'}
          </div>
          {hasRange && (
            <Button variant="outline" size="sm" onClick={() => { setRangeStart(''); setRangeEnd(''); }}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> 恢复全部区间
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  const cols = selected.filter((p) => metricsById[p.id]);
  const hasRel = Object.keys(relById).length > 0;

  /* ---------- 净值曲线数据 ---------- */
  const chartData = useMemo(() => aligned.dates.map((d, i) => {
    const row: Record<string, string | number> = { date: d };
    for (const p of cols) {
      const navs = aligned.navs[p.id];
      row[p.id] = navs[i] / navs[0];
    }
    return row;
  }), [aligned, cols]);

  /** X 轴日期刻度：按跨度缩短显示，最多约 10 个刻度 */
  const fmtTick = useMemo(() => dateTickFormatter(aligned.dates), [aligned.dates]);
  const tickGap = useMemo(() => tickInterval(aligned.dates.length), [aligned.dates.length]);

  /* ---------- 综合排名 ---------- */
  const ranking = useMemo(() => {
    return [...ranked]
      .map((p) => ({ p, m: metricsById[p.id] }))
      .sort((a, b) => b.m.sharpe - a.m.sharpe);
  }, [ranked, metricsById]);

  const exportCsv = () => {
    const header = ['指标', ...cols.map((p) => p.name)];
    const lines = [header.join(',')];
    for (const r of METRIC_ROWS) {
      lines.push([r.label, ...cols.map((p) => r.value(metricsById[p.id]) ?? '')].join(','));
    }
    if (hasRel) {
      lines.push('');
      lines.push([`相对基准：${bench?.name ?? ''}`, ...cols.map((p) => (p.isBenchmark ? '—' : ''))].join(','));
      for (const r of REL_ROWS) {
        lines.push([
          r.label,
          ...cols.map((p) => (p.isBenchmark ? '' : (relById[p.id] ? r.value(relById[p.id]) ?? '' : ''))),
        ].join(','));
      }
    }
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '多产品指标对比.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      {/* ---------- 概览 ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Trophy className="h-4 w-4 text-amber-500" /> 共轨区间对比概览
          </CardTitle>
          <CardDescription>
            共轨区间 {aligned.start} ~ {aligned.end}（{aligned.dates.length} 个共同日期）
            {bench && ` · 基准：${bench.name}`}
            {' '}· 全部指标在该区间内重算，保证横向可比；缺失日期按上一有效净值填充
            {' '}· 净值口径：{NAV_FIELD_LABEL[field]}
            {field === 'adj' && `（${ADJUST_LABELS[adjustMode].label}）`}
            {hasRange && ' · 已应用人工区间'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="py-1.5 pr-3 text-left font-medium">排名</th>
                  <th className="py-1.5 pr-3 text-left font-medium">产品</th>
                  <th className="py-1.5 pr-3 text-right font-medium">年化收益</th>
                  <th className="py-1.5 pr-3 text-right font-medium">最大回撤</th>
                  <th className="py-1.5 pr-3 text-right font-medium">年化波动</th>
                  <th className="py-1.5 pr-3 text-right font-medium">夏普</th>
                  {hasRel && <th className="py-1.5 pr-3 text-right font-medium">年化超额</th>}
                  {hasRel && <th className="py-1.5 text-right font-medium">IR</th>}
                </tr>
              </thead>
              <tbody>
                {ranking.map(({ p, m }, i) => {
                  const rel = relById[p.id];
                  return (
                    <tr key={p.id} className="border-t">
                      <td className="py-1.5 pr-3">
                        <Badge variant={i === 0 ? 'default' : 'outline'} className="text-xs">
                          {i === 0 ? '冠军' : `第 ${i + 1}`}
                        </Badge>
                      </td>
                      <td className="py-1.5 pr-3">
                        <span className="flex items-center gap-2">
                          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: p.color }} />
                          {p.name}
                        </span>
                      </td>
                      <td className={`py-1.5 pr-3 text-right tabular-nums ${tone(m.annualizedReturn)}`}>{fmtPct(m.annualizedReturn)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-emerald-600">{fmtPct(m.maxDrawdown)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{fmtPct(m.annualizedVol, 2, false)}</td>
                      <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">{fmtNum(m.sharpe)}</td>
                      {hasRel && (
                        <td className={`py-1.5 pr-3 text-right tabular-nums ${rel ? tone(rel.excessAnn) : 'text-muted-foreground'}`}>
                          {rel ? fmtPct(rel.excessAnn) : DASH}
                        </td>
                      )}
                      {hasRel && (
                        <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                          {rel ? fmtNum(rel.informationRatio) : DASH}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {bench && metricsById[bench.id] && (
                  <tr className="border-t bg-muted/40">
                    <td className="py-1.5 pr-3"><Badge variant="secondary" className="text-xs">基准</Badge></td>
                    <td className="py-1.5 pr-3">
                      <span className="flex items-center gap-2">
                        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: bench.color }} />
                        {bench.name}
                      </span>
                    </td>
                    <td className={`py-1.5 pr-3 text-right tabular-nums ${tone(metricsById[bench.id].annualizedReturn)}`}>
                      {fmtPct(metricsById[bench.id].annualizedReturn)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-emerald-600">{fmtPct(metricsById[bench.id].maxDrawdown)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{fmtPct(metricsById[bench.id].annualizedVol, 2, false)}</td>
                    <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">{fmtNum(metricsById[bench.id].sharpe)}</td>
                    {hasRel && <td className="py-1.5 pr-3 text-right text-muted-foreground">—</td>}
                    {hasRel && <td className="py-1.5 text-right text-muted-foreground">—</td>}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">按夏普比率降序排列。</p>
        </CardContent>
      </Card>

      {/* ---------- 净值口径 + 日期区间 ---------- */}
      <Card>
        <CardContent className="space-y-3 pt-5">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <Label className="text-xs text-muted-foreground">净值口径</Label>
              <div className="mt-1">
                <Tabs value={field} onValueChange={(v) => setField(v as NavField)}>
                  <TabsList>
                    {NAV_FIELDS.map((f) => (
                      <TabsTrigger key={f.value} value={f.value} title={f.hint}>
                        {f.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>
            </div>

            <div className="flex items-end gap-2">
              <div>
                <Label className="text-xs text-muted-foreground">起始日期</Label>
                <Input
                  type="date" className="mt-1 h-8 w-40 text-xs"
                  value={rangeStart}
                  min={fullRange?.start}
                  max={rangeEnd || fullRange?.end}
                  onChange={(e) => setRangeStart(e.target.value)}
                />
              </div>
              <span className="pb-2 text-xs text-muted-foreground">~</span>
              <div>
                <Label className="text-xs text-muted-foreground">结束日期</Label>
                <Input
                  type="date" className="mt-1 h-8 w-40 text-xs"
                  value={rangeEnd}
                  min={rangeStart || fullRange?.start}
                  max={fullRange?.end}
                  onChange={(e) => setRangeEnd(e.target.value)}
                />
              </div>
              {(hasRange) && (
                <Button
                  variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground"
                  onClick={() => { setRangeStart(''); setRangeEnd(''); }}
                >
                  <RotateCcw className="mr-1 h-3 w-3" /> 全部区间
                </Button>
              )}
            </div>

            {fullRange && (
              <div className="flex flex-wrap items-end gap-1">
                {quickRanges(fullRange.end).map((q) => (
                  <Button
                    key={q.label} variant="outline" size="sm" className="h-8 text-xs"
                    onClick={() => {
                      setRangeStart(q.start > fullRange.start ? q.start : fullRange.start);
                      setRangeEnd(fullRange.end);
                    }}
                  >
                    {q.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {NAV_FIELDS.find((f) => f.value === field)?.hint}
            {field !== 'adj' && '；切到该口径后，共轨区间的收益、风险、相关性等指标全部按这条序列重算'}
            {hasRange && ` 当前区间：${aligned.start} ~ ${aligned.end}（${aligned.dates.length} 个共同日期）`}
            {fullRange && !hasRange && ` 可用范围：${fullRange.start} ~ ${fullRange.end}`}
          </p>
        </CardContent>
      </Card>

      {/* ---------- 视图切换 ---------- */}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
          <TabsList>
            <TabsTrigger value="metrics"><Grid3x3 className="mr-1 h-3.5 w-3.5" />指标对比</TabsTrigger>
            <TabsTrigger value="chart"><LineIcon className="mr-1 h-3.5 w-3.5" />净值曲线</TabsTrigger>
            <TabsTrigger value="corr"><Grid3x3 className="mr-1 h-3.5 w-3.5" />相关性</TabsTrigger>
            <TabsTrigger value="monthly"><CalendarRange className="mr-1 h-3.5 w-3.5" />月度收益</TabsTrigger>
            {hasRel && <TabsTrigger value="rel"><Scale className="mr-1 h-3.5 w-3.5" />相对基准</TabsTrigger>}
          </TabsList>
        </Tabs>
        {view === 'metrics' && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={exportCsv}>
            <Download className="mr-2 h-3.5 w-3.5" /> 导出 CSV
          </Button>
        )}
      </div>

      {/* ---------- 指标对比表 ---------- */}
      {view === 'metrics' && (
        <Card>
          <CardContent className="pt-5">
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="py-2 pr-4 text-left font-medium">指标</th>
                    {cols.map((p) => (
                      <th key={p.id} className="py-2 px-3 text-right font-medium">
                        <span className="flex items-center justify-end gap-1.5">
                          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                          {p.name}
                          {p.isBenchmark && <Badge variant="secondary" className="text-[10px]">基准</Badge>}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groupRows(METRIC_ROWS).map(([group, rows]) => (
                    <Fragment key={group}>
                      <tr>
                        <td colSpan={cols.length + 1} className="pt-4 pb-1 text-xs font-semibold text-muted-foreground">
                          {group}
                        </td>
                      </tr>
                      {rows.map((r) => {
                        const best = bestOf(r, cols, metricsById);
                        return (
                          <tr key={r.label} className="border-t">
                            <td className="py-2 pr-4 text-muted-foreground" title={r.hint}>{r.label}</td>
                            {cols.map((p) => {
                              const m = metricsById[p.id];
                              const v = r.value(m);
                              const isBest = !p.isBenchmark && best != null && v != null && Math.abs(v - best) < 1e-12;
                              return (
                                <td
                                  key={p.id}
                                  className={`py-2 px-3 text-right ${isBest ? 'font-bold text-red-600 bg-red-50' : ''}`}
                                >
                                  {r.fmt(m)}
                                  {isBest && <span className="ml-1 text-[10px] text-red-500">最优</span>}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------- 净值曲线 ---------- */}
      {view === 'chart' && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {NAV_FIELD_LABEL[field]}走势（共轨区间归一化，起点 = 1）
            </CardTitle>
            <CardDescription>
              {aligned.start} ~ {aligned.end} · {aligned.dates.length} 个共同日期
              {field === 'adj' && ` · ${ADJUST_LABELS[adjustMode].label}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-96">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                  <XAxis
                    dataKey="date" tick={{ fontSize: 11 }} minTickGap={16}
                    interval={tickGap} tickFormatter={fmtTick}
                  />
                  <YAxis
                    domain={['auto', 'auto']} tick={{ fontSize: 11 }} width={52}
                    tickFormatter={(v: number) => v.toFixed(2)}
                  />
                  <Tooltip
                    formatter={(v: number, name: string) => [v.toFixed(4), name]}
                    labelFormatter={(l: string) => l}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <ReferenceLine y={1} stroke="#94a3b8" strokeDasharray="4 4" />
                  {cols.map((p) => (
                    <Line
                      key={p.id}
                      type="monotone"
                      dataKey={p.id}
                      name={p.name}
                      stroke={p.color}
                      strokeWidth={p.isBenchmark ? 1.6 : 2}
                      strokeDasharray={p.isBenchmark ? '6 3' : undefined}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------- 相关性矩阵 ---------- */}
      {view === 'corr' && corr && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">日收益率相关性矩阵</CardTitle>
            <CardDescription>
              在共轨区间上按 ρ = Cov(rᵢ, rⱼ) / (σᵢ × σⱼ) 计算；越低说明产品间分散效果越好
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="py-1.5 pr-3 text-left font-medium" />
                    {corr.ids.map((id) => (
                      <th key={id} className="py-1.5 px-2 text-center font-medium">
                        {products.find((p) => p.id === id)?.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {corr.ids.map((rid, i) => (
                    <tr key={rid}>
                      <td className="py-1.5 pr-3 text-xs font-medium">
                        {products.find((p) => p.id === rid)?.name}
                      </td>
                      {corr.ids.map((cid, j) => {
                        const v = corr.matrix[i][j];
                        return (
                          <td
                            key={cid}
                            className="py-1.5 px-2 text-center"
                            style={{ backgroundColor: corrColor(v) }}
                          >
                            {v.toFixed(2)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------- 月度收益 ---------- */}
      {view === 'monthly' && monthly && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">月度收益对比</CardTitle>
            <CardDescription>按自然月聚合累计净值；红涨绿跌，颜色越深幅度越大</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-[32rem] overflow-y-auto">
              <table className="w-full text-xs tabular-nums">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-muted-foreground">
                    <th className="py-1.5 pr-3 text-left font-medium">月份</th>
                    {cols.map((p) => (
                      <th key={p.id} className="py-1.5 px-2 text-center font-medium">
                        <span className="flex items-center justify-center gap-1">
                          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                          {p.name}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {monthly.months.map((mk) => (
                    <tr key={mk} className="border-t">
                      <td className="py-1 pr-3 font-medium">{mk}</td>
                      {cols.map((p) => {
                        const v = monthly.perProduct.get(p.id)?.get(mk);
                        return (
                          <td key={p.id} className="py-1 px-2 text-center" style={cellStyle(v)}>
                            {v == null ? DASH : fmtPct(v, 2)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------- 相对基准 ---------- */}
      {view === 'rel' && hasRel && bench && (
        <RelativeTable
          cols={cols.filter((p) => !p.isBenchmark)}
          relById={relById}
          benchName={bench.name}
          windowText={`共轨区间 ${aligned.start} ~ ${aligned.end}`}
        />
      )}
    </div>
  );
}

/* ---------------- 辅助 ---------------- */

/** 快捷区间：以最后一个共同日期为锚向前推 */
function quickRanges(end: string): { label: string; start: string }[] {
  const base = new Date(`${end}T00:00:00`);
  if (Number.isNaN(base.getTime())) return [];
  const shift = (months: number) => {
    const d = new Date(base);
    d.setMonth(d.getMonth() - months);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  return [
    { label: '近 1 月', start: shift(1) },
    { label: '近 3 月', start: shift(3) },
    { label: '近 6 月', start: shift(6) },
    { label: '近 1 年', start: shift(12) },
    { label: '近 3 年', start: shift(36) },
    { label: '今年以来', start: `${end.slice(0, 4)}-01-01` },
  ];
}

/** 中国习惯：涨红跌绿 */
export function tone(x: number): string {
  if (x > 0) return 'text-red-600';
  if (x < 0) return 'text-emerald-600';
  return 'text-muted-foreground';
}

function bestOf(r: RowDef, cols: Product[], byId: Record<string, Metrics>): number | null {
  if (r.better === 0) return null;
  const vals = cols
    .filter((p) => !p.isBenchmark)
    .map((p) => r.value(byId[p.id]))
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return r.better === 1 ? Math.max(...vals) : Math.min(...vals);
}

function groupRows(rows: RowDef[]): [string, RowDef[]][] {
  const map = new Map<string, RowDef[]>();
  for (const r of rows) {
    if (!map.has(r.group)) map.set(r.group, []);
    map.get(r.group)!.push(r);
  }
  return [...map.entries()];
}

function corrColor(v: number): string {
  // 高相关偏红（分散效果差），负相关偏绿
  const alpha = 0.06 + Math.abs(v) * 0.42;
  return v >= 0 ? `rgba(220, 38, 38, ${alpha})` : `rgba(22, 163, 74, ${alpha})`;
}

/** 月度收益单元格配色：红涨绿跌 */
function cellStyle(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return {};
  const a = Math.min(1, Math.abs(v) / 0.05);
  const alpha = 0.08 + a * 0.45;
  return { backgroundColor: v >= 0 ? `rgba(220, 38, 38, ${alpha})` : `rgba(22, 163, 74, ${alpha})` };
}
