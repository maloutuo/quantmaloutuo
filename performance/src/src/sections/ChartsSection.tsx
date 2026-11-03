import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, Brush,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TrendingUp, TrendingDown, Scale } from 'lucide-react';
import { navOf } from '@/lib/adjust';
import { dateTickFormatter, tickInterval } from '@/lib/chart';
import type { NavPoint, Metrics } from '@/types';

type RangeKey = 'all' | '1y' | '6m' | '3m' | 'custom';

const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: 'all', label: '全部', days: Infinity },
  { key: '1y', label: '近1年', days: 365 },
  { key: '6m', label: '近6月', days: 183 },
  { key: '3m', label: '近3月', days: 92 },
];

interface Row {
  date: string;
  accum: number;
  unit: number;
  dd: number;
  label: string;
  fundReb?: number;
  benchReb?: number;
  excess?: number;
}

export function ChartsSection({ points, metrics: m, bench }: { points: NavPoint[]; metrics: Metrics; bench?: NavPoint[] | null }) {
  const [range, setRange] = useState<RangeKey>('all');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  const benchMap = useMemo(
    () => (bench ? new Map(bench.map((p) => [p.date, navOf(p)])) : null),
    [bench],
  );

  const data = useMemo(() => {
    const r = RANGES.find((x) => x.key === range);
    let from = r && Number.isFinite(r.days)
      ? new Date(points[points.length - 1].date).getTime() - r.days * 86400000
      : -Infinity;
    let to = Infinity;
    if (range === 'custom') {
      from = customStart ? new Date(customStart).getTime() : -Infinity;
      to = customEnd ? new Date(customEnd).getTime() + 86399999 : Infinity;
      if (from > to) [from, to] = [to - 86399999, from + 86399999];
    }
    const rows: Row[] = [];
    let fund0 = 0;
    let bench0 = 0;
    points.forEach((p, i) => {
      const t = new Date(p.date).getTime();
      if (t < from || t > to) return;
      const bv = benchMap?.get(p.date);
      if (rows.length === 0) {
        fund0 = navOf(p);
        bench0 = bv ?? 1;
      }
      const row: Row = {
        date: p.date,
        accum: navOf(p),
        unit: p.unitNav,
        dd: m.drawdowns[i] * 100,
        // 保留短标签用于跨度大的区间，X 轴与 tooltip 一律用 date
        label: p.date,
      };
      if (benchMap) {
        row.fundReb = navOf(p) / fund0;
        row.benchReb = (bv ?? bench0) / bench0;
        row.excess = (row.fundReb - row.benchReb) * 100;
      }
      rows.push(row);
    });
    return rows;
  }, [points, m, range, customStart, customEnd, benchMap]);

  /** X 轴：日期（按跨度缩短显示，最多约 10 个刻度） */
  const dates = useMemo(() => data.map((d) => d.date), [data]);
  const fmtTick = useMemo(() => dateTickFormatter(dates), [dates]);
  const tickGap = useMemo(() => tickInterval(dates.length), [dates]);

  const ddBase = data.length ? Math.min(...data.map((d) => d.dd)) : 0;

  const navColor = '#2563eb';
  const unitColor = '#93c5fd';
  const benchColor = '#f59e0b';
  const ddColor = '#dc2626';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Tabs value={range} onValueChange={(v) => setRange(v as RangeKey)}>
          <TabsList>
            {RANGES.map((r) => (
              <TabsTrigger key={r.key} value={r.key}>{r.label}</TabsTrigger>
            ))}
            <TabsTrigger value="custom">自定义</TabsTrigger>
          </TabsList>
        </Tabs>
        {range === 'custom' && (
          <div className="flex items-end gap-2">
            <div>
              <Label htmlFor="cs" className="text-xs text-muted-foreground">起始日</Label>
              <Input
                id="cs" type="date" className="h-8 w-36 text-xs"
                min={points[0]?.date} max={points[points.length - 1]?.date}
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="ce" className="text-xs text-muted-foreground">截止日</Label>
              <Input
                id="ce" type="date" className="h-8 w-36 text-xs"
                min={points[0]?.date} max={points[points.length - 1]?.date}
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4 text-blue-600" />
            {benchMap ? '组合 vs 基准（归一化，起点=1）' : '净值走势（复权净值 / 单位净值）'}
          </CardTitle>
          <CardDescription>区间 {data[0]?.date} ~ {data[data.length - 1]?.date}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                <XAxis
                  dataKey="date" tick={{ fontSize: 11 }} minTickGap={16}
                  interval={tickGap} tickFormatter={fmtTick}
                />
                <YAxis
                  yAxisId="nav" domain={['auto', 'auto']} tick={{ fontSize: 11 }}
                  orientation="left" tickFormatter={(v: number) => v.toFixed(2)} width={52}
                />
                <YAxis yAxisId="unit" orientation="right" hide />
                <Tooltip
                  formatter={(value: number, name: string) => {
                    if (name.includes('归一化')) return [value.toFixed(3), name];
                    return [value.toFixed(4), name];
                  }}
                  labelFormatter={(l: string) => l}
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                />
                {benchMap ? [
                  <Line
                    key="fund"
                    yAxisId="nav" type="monotone" dataKey="fundReb" name="组合（归一化）"
                    stroke={navColor} strokeWidth={2} dot={false}
                  />,
                  <Line
                    key="bench"
                    yAxisId="nav" type="monotone" dataKey="benchReb" name="基准（归一化）"
                    stroke={benchColor} strokeWidth={1.8} dot={false} strokeDasharray="6 3"
                  />,
                ] : (
                  <Line
                    yAxisId="nav" type="monotone" dataKey="accum" name="复权净值"
                    stroke={navColor} strokeWidth={2} dot={false}
                  />
                )}
                <Line
                  yAxisId="unit" type="monotone" dataKey="unit" name="单位净值"
                  stroke={unitColor} strokeWidth={1.2} dot={false} strokeDasharray="4 3"
                />
                <Brush dataKey="date" height={18} travellerWidth={8} stroke={navColor} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {benchMap && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Scale className="h-4 w-4 text-amber-500" /> 超额累计收益
            </CardTitle>
            <CardDescription>归一化组合净值 − 归一化基准净值（百分点），持续上行代表稳定跑赢</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                  <XAxis
                  dataKey="date" tick={{ fontSize: 11 }} minTickGap={16}
                  interval={tickGap} tickFormatter={fmtTick}
                />
                  <YAxis
                    domain={['auto', 'auto']} tick={{ fontSize: 11 }} width={52}
                    tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                  />
                  <Tooltip
                    formatter={(value: number) => [`${value.toFixed(2)}%`, '超额累计']}
                    labelFormatter={(l: string) => l}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <ReferenceLine y={0} stroke="#94a3b8" />
                  <Area
                    type="monotone" dataKey="excess" name="超额累计" stroke="#d97706"
                    fill="#d97706" fillOpacity={0.15} strokeWidth={1.5} isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingDown className="h-4 w-4 text-red-500" /> 回撤曲线
          </CardTitle>
          <CardDescription>
            最大回撤 {m.maxDrawdownStart} → {m.maxDrawdownEnd}
            {m.maxDrawdownRecover ? `，${m.maxDrawdownRecover} 创新高修复` : '，区间内未修复'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                <XAxis
                  dataKey="date" tick={{ fontSize: 11 }} minTickGap={16}
                  interval={tickGap} tickFormatter={fmtTick}
                />
                <YAxis
                  domain={[ddBase * 1.05, 0]} tick={{ fontSize: 11 }} width={52}
                  tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                />
                <Tooltip
                  formatter={(value: number) => [`${value.toFixed(2)}%`, '回撤']}
                  labelFormatter={(l: string) => l}
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                />
                <ReferenceLine y={0} stroke="#94a3b8" />
                <Area
                  type="monotone" dataKey="dd" name="回撤" stroke={ddColor}
                  fill={ddColor} fillOpacity={0.18} strokeWidth={1.5} isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
