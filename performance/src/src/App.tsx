import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Info } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ImportSection } from '@/sections/ImportSection';
import { ProductList } from '@/sections/ProductList';
import { AdjustPanel } from '@/sections/AdjustPanel';
import { MetricsSection } from '@/sections/MetricsSection';
import { ChartsSection } from '@/sections/ChartsSection';
import { MonthlyHeatmap } from '@/sections/MonthlyHeatmap';
import { CompareSection } from '@/sections/CompareSection';
import { RelativeTable } from '@/sections/RelativeTable';
import { computeMetrics, computeComparison, sampleProducts, sampleWithDividend, fmtNum, type AnnualMode } from '@/lib/perf';
import { buildAdjusted, ADJUST_LABELS } from '@/lib/adjust';
import { makeProduct } from '@/lib/products';
import type { AdjustMode, Product } from '@/types';

type TabKey = 'import' | 'single' | 'compare';

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [activeId, setActiveId] = useState('');
  const [rfPct, setRfPct] = useState(1.5);
  const [annualMode, setAnnualMode] = useState<AnnualMode>('calendar');
  const [adjustMode, setAdjustMode] = useState<AdjustMode>('compound');
  const [tab, setTab] = useState<TabKey>('import');

  /**
   * 按当前复权口径重算各产品的 adjNav。
   * 原始 unitNav / accumNav 始终保留，切换口径只改 adjNav，不会破坏源数据。
   */
  const adjusted = useMemo(
    () => products.map((p) => ({
      ...p,
      points: buildAdjusted(
        p.points,
        adjustMode,
        p.detected.filter((a) => !p.ignored.includes(a.id)),
      ),
    })),
    [products, adjustMode],
  );

  const active = useMemo(
    () => adjusted.find((p) => p.id === activeId) ?? adjusted.find((p) => !p.isBenchmark) ?? null,
    [adjusted, activeId],
  );
  const bench = useMemo(() => adjusted.find((p) => p.isBenchmark) ?? null, [adjusted]);

  const metrics = useMemo(
    () => (active && active.points.length >= 2 ? computeMetrics(active.points, rfPct / 100, annualMode) : null),
    [active, rfPct, annualMode],
  );

  const comparison = useMemo(
    () => (active && bench && bench.id !== active.id && active.points.length >= 2
      ? computeComparison(active.points, bench.points, rfPct / 100, annualMode)
      : null),
    [active, bench, rfPct, annualMode],
  );

  /* ---------------- 产品操作 ---------------- */

  const addProducts = (list: Product[]) => {
    setProducts((prev) => {
      const next = [...prev, ...list];
      if (!prev.some((p) => !p.isBenchmark)) {
        const first = list.find((p) => !p.isBenchmark);
        if (first) setActiveId(first.id);
      }
      return next;
    });
    setTab('compare');
  };

  const updateProduct = (id: string, patch: Partial<Product>) => {
    setProducts((prev) => {
      // 基准唯一：设为基准时取消其它产品的基准标记
      const next = prev.map((p) => {
        if (p.id === id) return { ...p, ...patch };
        if (patch.isBenchmark) return { ...p, isBenchmark: false };
        return p;
      });
      return next;
    });
  };

  /** 忽略 / 恢复某条分红或拆分事件 */
  const toggleAction = (productId: string, actionId: string) => {
    setProducts((prev) => prev.map((p) => {
      if (p.id !== productId) return p;
      const ignored = p.ignored.includes(actionId)
        ? p.ignored.filter((x) => x !== actionId)
        : [...p.ignored, actionId];
      return { ...p, ignored };
    }));
  };

  const removeProduct = (id: string) => {
    setProducts((prev) => prev.filter((p) => p.id !== id));
    setActiveId((cur) => (cur === id ? '' : cur));
  };

  const clearAll = () => {
    setProducts([]);
    setActiveId('');
    setTab('import');
  };

  const loadSample = () => {
    const list = sampleProducts();
    // 追加一只含分红的产品，用于演示复权与不复权的差异
    const div = makeProduct('示例三号（含分红）', sampleWithDividend(), '内置示例', list.length);
    const all = [...list, div];
    setProducts(all);
    setActiveId(all[0]?.id ?? '');
    setTab('compare');
  };

  // 列表变化后保证 activeId 指向有效产品
  useEffect(() => {
    if (products.length === 0) {
      if (activeId) setActiveId('');
      return;
    }
    if (!adjusted.some((p) => p.id === activeId)) {
      setActiveId(adjusted.find((p) => !p.isBenchmark)?.id ?? adjusted[0].id);
    }
  }, [adjusted, activeId]);

  // 数据不够时自动退回导入页，避免停留在不可用的 Tab
  useEffect(() => {
    if (tab === 'compare' && products.length < 2) setTab('import');
    if (tab === 'single' && (!active || !metrics)) setTab('import');
  }, [tab, products.length, active, metrics]);

  const annualLabel = annualMode === 'trading' ? '交易日 252' : '自然日 365';

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto max-w-7xl px-4 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <BarChart3 className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">绩效分析平台</h1>
              <p className="text-xs text-muted-foreground">
                Excel / CSV 净值解析 · 单产品绩效归因 · 多产品共轨区间对比
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{products.length} 条序列</Badge>
              {bench && <Badge variant="secondary">基准：{bench.name}</Badge>}
            </div>
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="mt-4">
            <TabsList>
              <TabsTrigger value="import">数据导入</TabsTrigger>
              <TabsTrigger value="single" disabled={!active || !metrics}>单产品分析</TabsTrigger>
              <TabsTrigger value="compare" disabled={products.length < 2}>多产品对比</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 space-y-6">
        {tab === 'import' && (
          <>
            <ImportSection
              products={products}
              rf={rfPct}
              annualMode={annualMode}
              onRfChange={setRfPct}
              onAnnualModeChange={setAnnualMode}
              onAdd={addProducts}
              onLoadSample={loadSample}
            />
            <AdjustPanel
              products={products}
              mode={adjustMode}
              onModeChange={setAdjustMode}
              onToggleAction={toggleAction}
            />
            <ProductList
              products={products}
              activeId={active?.id ?? ''}
              onActivate={(id) => { setActiveId(id); setTab('single'); }}
              onUpdate={updateProduct}
              onRemove={removeProduct}
              onClearAll={clearAll}
            />
          </>
        )}

        {tab === 'single' && active && metrics && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="w-72">
                <Select value={active.id} onValueChange={setActiveId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {adjusted.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="flex items-center gap-2">
                          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                          {p.name}
                          {p.isBenchmark && '（基准）'}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <span className="text-sm text-muted-foreground">
                {metrics.startDate} ~ {metrics.endDate} · {metrics.tradingDays} 个净值日
              </span>
              <Badge variant="outline" className="ml-auto">
                复权口径：{ADJUST_LABELS[adjustMode].label}
              </Badge>
              <span className="text-xs text-muted-foreground">
                单位净值 {fmtNum(active.points[active.points.length - 1].unitNav, 4)}
                {' · '}累计净值 {fmtNum(active.points[active.points.length - 1].accumNav, 4)}
                {' · '}复权净值 {fmtNum(metrics.latestAdjNav, 4)}
              </span>
            </div>

            <MetricsSection metrics={metrics} />

            {comparison && bench && (
              <RelativeTable
                cols={[active]}
                relById={{ [active.id]: comparison }}
                benchName={bench.name}
                windowText={`共同交易日 ${comparison.commonCount} 个（${comparison.startDate} ~ ${comparison.endDate}）`}
                showBest={false}
              />
            )}

            <Separator />
            <ChartsSection points={active.points} metrics={metrics} bench={bench?.points ?? null} />
            <Separator />
            <MonthlyHeatmap points={active.points} />

            <Alert className="bg-muted/50 border-muted">
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs text-muted-foreground leading-relaxed">
                计算口径：收益率基于{ADJUST_LABELS[adjustMode].label}净值
                （{adjustMode === 'none' ? '直接采用累计净值' : '分红再投资的全收益口径，由单位净值＋累计净值反推分红后还原'}）；
                年化收益率按{annualLabel}天几何年化；
                波动率、夏普、索提诺按交易日 √252 年化；无风险利率当前 {rfPct}%，可在「数据导入」页调整后实时重算。
                指标定义参考 ARGOS 绩效分析体系。
              </AlertDescription>
            </Alert>
          </>
        )}

        {tab === 'compare' && (
          <CompareSection
            products={adjusted}
            rf={rfPct}
            annualMode={annualMode}
            adjustMode={adjustMode}
          />
        )}

        {tab !== 'import' && products.length === 0 && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>还没有数据，请先到「数据导入」上传 Excel / CSV 或载入示例数据。</AlertDescription>
          </Alert>
        )}
      </main>

      <footer className="border-t py-4 text-center text-xs text-muted-foreground">
        指标口径参考 ARGOS 绩效分析体系 · 计算均在浏览器本地完成，数据不会上传
      </footer>
      <Toaster />
    </div>
  );
}
