import { useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Coins, Info, RotateCcw, Scissors } from 'lucide-react';
import { ADJUST_LABELS, summarize, navOf } from '@/lib/adjust';
import { fmtPct, fmtNum } from '@/lib/perf';
import type { AdjustMode, Product } from '@/types';

interface Props {
  products: Product[];
  mode: AdjustMode;
  onModeChange: (m: AdjustMode) => void;
  /** 切换某条事件的启用状态 */
  onToggleAction: (productId: string, actionId: string) => void;
}

/**
 * 复权设置面板：
 *  - 选择复权口径（不复权 / 向后复权 / 向前复权）
 *  - 列出由「单位净值 + 累计净值」反推出的分红 / 拆分事件，可逐条启用或忽略
 *  - 量化展示不复权口径相对复权口径的低估幅度
 */
export function AdjustPanel({ products, mode, onModeChange, onToggleAction }: Props) {
  const rows = useMemo(
    () => products.map((p) => ({
      product: p,
      actions: p.detected.filter((a) => !p.ignored.includes(a.id)),
      summary: summarize(
        p.points,
        p.detected.filter((a) => !p.ignored.includes(a.id)),
        mode,
      ),
    })),
    [products, mode],
  );

  const hasAny = rows.some((r) => r.summary.dividendCount > 0 || r.summary.splitCount > 0);
  const affected = rows.filter((r) => r.summary.hasDifference);
  const first = rows[0]?.product.points[0];
  const last = rows[0]?.product.points[rows[0]?.product.points.length - 1];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="h-5 w-5" /> 复权净值计算
        </CardTitle>
        <CardDescription>
          依据「累计净值 − 单位净值 = 累计单位分红」反推分红与拆分，按所选口径还原复权净值。
          收益、风险与风险调整指标全部基于复权净值计算。
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-56">
            <label className="text-xs text-muted-foreground">复权口径</label>
            <Select value={mode} onValueChange={(v) => onModeChange(v as AdjustMode)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(['compound', 'backward', 'forward', 'none'] as AdjustMode[]).map((m) => (
                  <SelectItem key={m} value={m}>{ADJUST_LABELS[m].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="max-w-xl text-xs text-muted-foreground leading-relaxed">
            {ADJUST_LABELS[mode].hint}
          </p>
        </div>

        <div className="rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed">
          <div className="mb-1 font-medium text-foreground">复利复权净值公式</div>
          <div className="font-mono text-[11px] text-muted-foreground">
            复权净值(t) = 单位净值(t) × ∏ [ 分红前单位净值(s) ÷ 分红后单位净值(s) ]， s ≤ t
          </div>
          <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
            <li>· 分红前单位基金资产净值 = 除息日前一交易日的单位基金资产净值</li>
            <li>· 分红后单位基金资产净值 = 分红前单位基金资产净值 − 单位分红金额</li>
            <li>· 发生份额拆分时同乘拆分因子 k（1 份拆为 k 份）</li>
            <li>· 单位分红金额由「累计净值 − 单位净值」逐期差分反推</li>
          </ul>
        </div>

        {!hasAny && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              未在任何序列中识别出分红或拆分事件。若导入的数据只有一列净值（单位净值＝累计净值），
              四种复权口径结果一致；若产品确有分红，请在导入时同时选择「单位净值」与「累计净值」两列。
            </AlertDescription>
          </Alert>
        )}

        {affected.length > 0 && (
          <Alert variant="destructive" className="border-amber-300 bg-amber-50 text-amber-900">
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs leading-relaxed">
              <b>注意：</b>以下序列存在分红/拆分，<b>不复权（累计净值）口径会低估收益</b>——
              分红后累计净值被用作收益分母，而分红再投资实际是按当时单位净值买入份额。
              <div className="mt-1.5 space-y-0.5">
                {affected.map((r) => (
                  <div key={r.product.id}>
                    · {r.product.name}：不复权 {fmtPct(r.summary.rawReturn)}
                    {' → '}复利复权 {fmtPct(r.summary.adjustedReturn)}
                    <span className="ml-1 text-red-600">
                      （差 {fmtPct(r.summary.adjustedReturn - r.summary.rawReturn)}）
                    </span>
                    {Math.abs(r.summary.adjustedReturn - r.summary.backwardReturn) > 1e-9 && (
                      <span className="ml-1 text-muted-foreground">
                        ；向后复权 {fmtPct(r.summary.backwardReturn)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </AlertDescription>
          </Alert>
        )}

        {hasAny && (
          <>
            <Separator />
            <div className="space-y-4">
              {rows
                .filter((r) => r.product.detected.length > 0)
                .map((r) => (
                  <div key={r.product.id} className="rounded-lg border">
                    <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: r.product.color }}
                      />
                      <span className="text-sm font-medium">{r.product.name}</span>
                      <Badge variant="outline" className="text-xs">
                        分红 {r.summary.dividendCount} 次
                      </Badge>
                      {r.summary.splitCount > 0 && (
                        <Badge variant="outline" className="text-xs">拆分 {r.summary.splitCount} 次</Badge>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        区间新增分红合计 {fmtNum(r.summary.periodDividend, 4)} 元/份
                        {r.summary.openingDividend > 0 && ` · 期初存量分红 ${fmtNum(r.summary.openingDividend, 4)}`}
                      </span>
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-32">日期</TableHead>
                          <TableHead className="w-24">类型</TableHead>
                          <TableHead className="w-32">数值</TableHead>
                          <TableHead>推断依据</TableHead>
                          <TableHead className="w-24 text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {r.product.detected.map((a) => {
                          const ignored = r.product.ignored.includes(a.id);
                          return (
                            <TableRow key={a.id} className={ignored ? 'opacity-50' : ''}>
                              <TableCell className="tabular-nums">{a.date}</TableCell>
                              <TableCell>
                                <Badge variant={a.type === 'dividend' ? 'default' : 'secondary'} className="text-xs">
                                  {a.type === 'dividend'
                                    ? <><Coins className="mr-1 h-3 w-3" />分红</>
                                    : <><Scissors className="mr-1 h-3 w-3" />拆分</>}
                                </Badge>
                              </TableCell>
                              <TableCell className="tabular-nums">
                                {a.type === 'dividend' ? `${fmtNum(a.value, 4)} 元/份` : `1 → ${fmtNum(a.value, 4)}`}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">{a.note}</TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost" size="sm" className="h-6 px-2 text-xs"
                                  onClick={() => onToggleAction(r.product.id, a.id)}
                                >
                                  <RotateCcw className="mr-1 h-3 w-3" />
                                  {ignored ? '启用' : '忽略'}
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                ))}
            </div>
            <p className="text-xs text-muted-foreground">
              识别规则：分红＝累计单位分红（累计净值 − 单位净值）逐期增加；
              拆分＝单位净值与累计净值同比例跳变（容差 1%）且比例接近常见拆分比（1:2、1:3、1:10…，容差 3%）。
              若某条属于误判（例如极端行情单日大跌），点「忽略」后指标将按剩余事件重算。
            </p>
          </>
        )}

        {mode !== 'none' && hasAny && (
          <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground leading-relaxed">
            <div>
              <b>向后复权 vs 向前复权：</b>两者的<b>收益率序列完全相同</b>，差别只在净值基准——
              向后复权锚定期初单位净值（{fmtNum(first?.unitNav ?? 0, 4)}），
              向前复权锚定期末单位净值（{fmtNum(last?.unitNav ?? 0, 4)}）；
              因此除「期末净值」外的所有指标两者一致。
            </div>
            <div>
              <b>复利复权 vs 向后复权：</b>差异不在"是否复权"，而在<b>分红再投资按什么价格买入</b>。
              复利复权按"除息后、当日涨跌前"的净值再投资，等价于约定除息日先除息、后计当日损益；
              向后复权按当日期末净值再投资。若数据源的除息约定相反，两者高低关系对调。
              含大额分红时差异可达数十个基点，需与估值口径对齐后选用。
            </div>
            {first && last && (
              <div>
                当前口径下首条序列：期初复权净值 {fmtNum(navOf(first), 4)} → 期末 {fmtNum(navOf(last), 4)}。
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
