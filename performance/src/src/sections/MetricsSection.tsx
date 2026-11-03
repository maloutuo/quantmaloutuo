import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtNum, fmtPct } from '@/lib/perf';
import type { Metrics } from '@/types';

interface Item {
  label: string;
  value: string;
  sub?: string;
  hint: string;
  tone?: 'up' | 'down' | 'plain';
}

/** 中国习惯：涨红跌绿 */
function toneClass(tone?: 'up' | 'down' | 'plain') {
  if (tone === 'up') return 'text-red-600';
  if (tone === 'down') return 'text-emerald-600';
  return '';
}

export function MetricsSection({ metrics: m }: { metrics: Metrics }) {
  const groups: { title: string; items: Item[] }[] = [
    {
      title: '收益指标',
      items: [
        { label: '区间收益率', value: fmtPct(m.totalReturn), hint: 'R = 期末累计净值 / 期初累计净值 − 1' },
        {
          label: '年化收益率', value: fmtPct(m.annualizedReturn),
          hint: '几何年化：(1+R)^(365/自然天数) − 1', tone: m.annualizedReturn >= 0 ? 'up' : 'down',
        },
        {
          label: '期末复权净值', value: m.latestAdjNav.toFixed(4),
          sub: `单位 ${m.latestUnitNav.toFixed(4)} · 期初 ${m.openingUnitNav.toFixed(4)}`,
          hint: '按当前复权口径还原的期末净值，收益与风险指标全部基于该序列；括号内为原始单位净值与期初单位净值',
        },
      ],
    },
    {
      title: '风险指标',
      items: [
        { label: '年化波动率', value: fmtPct(m.annualizedVol, 2, false), hint: '日收益率标准差 × √252', tone: 'down' },
        { label: '下行波动率', value: fmtPct(m.downsideVol, 2, false), hint: '仅低于无风险利率的日收益偏差年化', tone: 'down' },
        {
          label: '最大回撤', value: fmtPct(m.maxDrawdown),
          sub: `${m.maxDrawdownStart} → ${m.maxDrawdownEnd}${m.maxDrawdownRecover ? `，${m.maxDrawdownRecover} 修复` : '，未修复'}`,
          hint: '净值创新高后至最低点的最大跌幅', tone: 'down',
        },
        {
          label: '年化 VaR95', value: fmtPct(m.var95, 2, false),
          hint: '标准正态法：1.645 × 年化波动率 − 年化收益，正数代表置信度 95% 下的年化潜在损失', tone: 'down',
        },
        { label: '收益偏度', value: fmtNum(m.skewness, 3), hint: '日收益率分布偏度，>0 右偏' },
      ],
    },
    {
      title: '风险调整收益',
      items: [
        {
          label: '夏普比率', value: fmtNum(m.sharpe),
          hint: '(年化收益 − 无风险利率) / 年化波动率', tone: m.sharpe >= 0 ? 'up' : 'down',
        },
        {
          label: '索提诺比率', value: fmtNum(m.sortino),
          hint: '(年化收益 − 无风险利率) / 下行波动率', tone: m.sortino >= 0 ? 'up' : 'down',
        },
        {
          label: '卡玛比率', value: fmtNum(m.calmar),
          hint: '年化收益率 / |最大回撤|', tone: m.calmar >= 0 ? 'up' : 'down',
        },
      ],
    },
    {
      title: '胜率统计',
      items: [
        { label: '日胜率', value: fmtPct(m.winRate, 1, false), hint: '上涨交易日占全部交易日的比例' },
        { label: '月度胜率', value: fmtPct(m.monthlyWinRate, 1, false), hint: '上涨月份占全部有数据月份的比例' },
        { label: '盈亏比', value: fmtNum(m.profitLossRatio), hint: '平均上涨幅度 / 平均下跌幅度' },
        { label: '交易日 / 自然日', value: `${m.tradingDays} / ${m.calendarDays}`, hint: `区间 ${m.startDate} ~ ${m.endDate}` },
      ],
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {groups.map((g) => (
        <Card key={g.title}>
          <CardContent className="pt-5">
            <Badge variant="secondary" className="mb-3">{g.title}</Badge>
            <div className="divide-y">
              {g.items.map((it) => (
                <TooltipProvider key={it.label} delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-baseline justify-between py-2.5 cursor-default">
                        <span className="text-sm text-muted-foreground">{it.label}</span>
                        <span className="text-right">
                          <span className={`text-lg font-semibold tabular-nums ${toneClass(it.tone)}`}>
                            {it.value}
                          </span>
                          {it.sub && (
                            <span className="block text-xs text-muted-foreground tabular-nums">{it.sub}</span>
                          )}
                        </span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-64 text-xs">
                      <p className="font-medium mb-0.5">{it.label}</p>
                      <p className="text-muted-foreground">{it.hint}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
