import { Fragment } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Scale } from 'lucide-react';
import { fmtNumOrDash, fmtPctOrDash, fmtPct, DASH } from '@/lib/perf';
import type { Comparison, Product } from '@/types';

export type Better = 1 | -1 | 0;

export interface RelRowDef {
  label: string;
  hint: string;
  better: Better;
  value: (c: Comparison) => number | null;
  fmt: (c: Comparison) => string;
}

const pct = (x: number | null) => fmtPctOrDash(x);
const pctPlain = (x: number | null) => (x == null ? DASH : fmtPct(x, 2, false));
const num = (x: number | null) => fmtNumOrDash(x, 2);

export const REL_ROWS: RelRowDef[] = [
  { label: '年化超额（算术）', hint: '组合年化 − 基准年化', better: 1, value: (c) => c.excessAnn, fmt: (c) => pct(c.excessAnn) },
  { label: '年化超额（几何）', hint: '(1+Rp)/(1+Rb) − 1', better: 1, value: (c) => c.excessAnnGeom, fmt: (c) => pct(c.excessAnnGeom) },
  { label: '跟踪误差', hint: '日主动收益标准差 × √252', better: -1, value: (c) => c.trackingError, fmt: (c) => pctPlain(c.trackingError) },
  { label: '信息比率 IR', hint: '年化超额 / 跟踪误差', better: 1, value: (c) => c.informationRatio, fmt: (c) => num(c.informationRatio) },
  { label: 'Beta（β）', hint: 'Cov(Rp,Rb) / Var(Rb)', better: 0, value: (c) => c.beta, fmt: (c) => num(c.beta) },
  { label: 'Jensen Alpha（年化）', hint: 'Rp − [Rf + β × (Rb − Rf)]', better: 1, value: (c) => c.alpha, fmt: (c) => pct(c.alpha) },
  { label: '特雷诺比率', hint: '(年化收益 − Rf) / β', better: 1, value: (c) => c.treynor, fmt: (c) => num(c.treynor) },
  { label: '相关系数', hint: '与基准日收益的 Pearson 相关系数', better: 0, value: (c) => c.correlation, fmt: (c) => num(c.correlation) },
  { label: '日度相对胜率', hint: '跑赢基准的交易日占比', better: 1, value: (c) => c.relativeWinRate, fmt: (c) => pctPlain(c.relativeWinRate) },
  { label: '相对盈亏比', hint: '超额正收益之和 / |超额负收益之和|', better: 1, value: (c) => c.relativeProfitLoss, fmt: (c) => num(c.relativeProfitLoss) },
  { label: '上行捕获率', hint: '基准上涨期：组合几何收益 / 基准几何收益', better: 1, value: (c) => c.upCapture, fmt: (c) => num(c.upCapture) },
  { label: '下行捕获率', hint: '基准下跌期：组合几何收益 / 基准几何收益（越低越好）', better: -1, value: (c) => c.downCapture, fmt: (c) => num(c.downCapture) },
];

interface Props {
  /** 参与对比的产品（已剔除基准） */
  cols: Product[];
  /** productId → 相对基准指标 */
  relById: Record<string, Comparison>;
  benchName: string;
  /** 对比窗口说明 */
  windowText: string;
  /** 单产品模式下隐藏「最优」标记 */
  showBest?: boolean;
}

/** 相对基准指标表：单产品与多产品对比共用 */
export function RelativeTable({ cols, relById, benchName, windowText, showBest = true }: Props) {
  const withRel = cols.filter((p) => relById[p.id]);
  if (withRel.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Scale className="h-4 w-4 text-amber-500" /> 相对基准：{benchName}
        </CardTitle>
        <CardDescription>{windowText} · 相对指标按日收益率序列回归计算</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="py-2 pr-4 text-left font-medium">相对指标</th>
                {withRel.map((p) => (
                  <th key={p.id} className="py-2 px-3 text-right font-medium">
                    <span className="flex items-center justify-end gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                      {p.name}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {REL_ROWS.map((r) => {
                let best: number | null = null;
                if (showBest && r.better !== 0) {
                  const vals = withRel
                    .map((p) => r.value(relById[p.id]))
                    .filter((v): v is number => v != null && Number.isFinite(v));
                  if (vals.length) best = r.better === 1 ? Math.max(...vals) : Math.min(...vals);
                }
                return (
                  <Fragment key={r.label}>
                    <tr className="border-t">
                      <td className="py-2 pr-4 text-muted-foreground" title={r.hint}>{r.label}</td>
                      {withRel.map((p) => {
                        const c = relById[p.id];
                        const v = r.value(c);
                        const isBest = best != null && v != null && Math.abs(v - best) < 1e-12;
                        return (
                          <td
                            key={p.id}
                            className={`py-2 px-3 text-right ${isBest ? 'font-bold text-red-600 bg-red-50' : ''}`}
                          >
                            {r.fmt(c)}
                            {isBest && <span className="ml-1 text-[10px] text-red-500">最优</span>}
                          </td>
                        );
                      })}
                    </tr>
                  </Fragment>
                );
              })}
              <tr className="border-t">
                <td className="py-2 pr-4 text-muted-foreground">共同交易日</td>
                {withRel.map((p) => (
                  <td key={p.id} className="py-2 px-3 text-right text-muted-foreground">
                    {relById[p.id].commonCount} 个
                  </td>
                ))}
              </tr>
              <tr className="border-t">
                <td className="py-2 pr-4 text-muted-foreground">基准最大回撤</td>
                {withRel.map((p) => (
                  <td key={p.id} className="py-2 px-3 text-right text-emerald-600">
                    {fmtPct(relById[p.id].benchMaxDrawdown)}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {relById[p.id].benchMaxDDStart} → {relById[p.id].benchMaxDDEnd}
                    </span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        {withRel.length > 1 && (
          <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <Badge variant="outline" className="text-[10px]">最优</Badge>
            标记为该行指标最优的产品（基准不参与）
          </p>
        )}
      </CardContent>
    </Card>
  );
}
