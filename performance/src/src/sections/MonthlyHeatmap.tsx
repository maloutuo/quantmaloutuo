import { useMemo, type CSSProperties } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { CalendarRange } from 'lucide-react';
import { computeMonthlyReturns } from '@/lib/perf';
import type { NavPoint } from '@/types';

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

/** 中国习惯：红涨绿跌 */
function cellStyle(v: number | null, scale: number): CSSProperties {
  if (v == null) return {};
  const a = Math.min(1, Math.abs(v) / scale);
  const alpha = 0.08 + a * 0.5;
  return {
    backgroundColor: v >= 0 ? `rgba(220, 38, 38, ${alpha})` : `rgba(22, 163, 74, ${alpha})`,
  };
}

export function MonthlyHeatmap({ points }: { points: NavPoint[] }) {
  const { years, grid, yearReturns, maxAbs } = useMemo(() => {
    const m = computeMonthlyReturns(points);
    let maxAbs = 0.01;
    for (const row of m.grid.values()) {
      for (const v of row) if (v != null && Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
    return { ...m, maxAbs };
  }, [points]);

  const fmt = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarRange className="h-4 w-4 text-red-600" /> 月度收益热力图
        </CardTitle>
        <CardDescription>按自然月聚合累计净值计算月收益，红涨绿跌，颜色越深幅度越大</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-1.5 pr-2 text-left font-medium">年份</th>
                {MONTHS.map((m) => (
                  <th key={m} className="py-1.5 px-1 text-center font-medium min-w-14">{m}</th>
                ))}
                <th className="py-1.5 pl-2 text-center font-medium min-w-16">全年</th>
              </tr>
            </thead>
            <tbody>
              {years.map((y) => {
                const row = grid.get(y)!;
                const yr = yearReturns.get(y);
                return (
                  <tr key={y} className="border-t">
                    <td className="py-1 pr-2 font-semibold">{y}</td>
                    {row.map((v, i) => (
                      <td
                        key={i}
                        className="py-1 px-1 text-center"
                        style={cellStyle(v, maxAbs)}
                      >
                        {fmt(v)}
                      </td>
                    ))}
                    <td
                      className="py-1 pl-2 text-center font-semibold"
                      style={yr != null ? cellStyle(yr, maxAbs) : undefined}
                    >
                      {fmt(yr ?? null)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
