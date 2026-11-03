import type { NavPoint, Product } from '@/types';
import { PRODUCT_COLORS } from '@/lib/perf';
import { detectActions } from '@/lib/adjust';
import {
  draftToPoints,
  extractSeries,
  type SheetAnalysis,
  type SeriesDraft,
} from '@/lib/excel';
import { deriveProductName } from '@/lib/naming';

let seq = 0;
const nextId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 新增产品时按现有数量取色，保证多产品配色不重复 */
export function colorForIndex(index: number): string {
  return PRODUCT_COLORS[index % PRODUCT_COLORS.length];
}

export interface ProductNameOption {
  /** 完整产品名 */
  fullName?: string;
  /** 产品代码 */
  code?: string;
}

export function makeProduct(
  name: string,
  points: NavPoint[],
  source: string,
  index: number,
  isBenchmark = false,
  meta: ProductNameOption = {},
): Product {
  return {
    id: nextId(),
    name: name.trim() || `未命名序列 ${index + 1}`,
    fullName: meta.fullName?.trim() || undefined,
    code: meta.code?.trim() || undefined,
    points,
    color: colorForIndex(index),
    visible: true,
    source,
    isBenchmark,
    detected: detectActions(points),
    ignored: [],
  };
}

/** 单位净值 + 累计净值两条序列合并为一条（以累计净值序列的日期为准） */
export function mergeUnitAccum(unit: { date: string; nav: number }[], accum: { date: string; nav: number }[]): NavPoint[] {
  const unitMap = new Map(unit.map((p) => [p.date, p.nav]));
  return accum.map((p) => {
    const unit = unitMap.get(p.date) ?? p.nav;
    return { date: p.date, unitNav: unit, accumNav: p.nav, adjNav: p.nav };
  });
}

/** 单条序列直接作为净值点（单位净值 = 累计净值） */
export function toNavPoints(series: { date: string; nav: number }[]): NavPoint[] {
  return series.map((p) => ({ date: p.date, unitNav: p.nav, accumNav: p.nav, adjNav: p.nav }));
}

export type ImportMode = 'auto' | 'perColumn';

const UNIT_RE = /单位净值|单位净值元|unit\s*nav|^unit$|^nav$/i;
const ACCUM_RE = /累计|累积|accum|cumulative/i;

/** 判断所选数值轴是否为经典的「单位净值 + 累计净值」两列 */
export function detectUnitAccumPair(analysis: SheetAnalysis, axes: number[]): [number, number] | null {
  if (axes.length !== 2) return null;
  const headers = axes.map((i) => analysis.axes[i]?.header ?? '');
  let unit = -1;
  let accum = -1;
  headers.forEach((h, k) => {
    if (ACCUM_RE.test(h)) accum = k;
    else if (UNIT_RE.test(h)) unit = k;
  });
  if (unit >= 0 && accum >= 0 && unit !== accum) return [axes[unit], axes[accum]];
  return null;
}

export interface BuildResult {
  products: Product[];
  /** 提示信息，例如识别为单位+累计并已合并 */
  notes: string[];
}

/**
 * 由解析结果与用户选中的数值轴生成产品列表。
 * auto 模式下若恰好选中「单位净值 + 累计净值」两列则合并为一个产品；
 * 其余情况每个数值轴生成一个产品。
 */
export function buildProducts(
  analysis: SheetAnalysis,
  axes: number[],
  mode: ImportMode,
  startIndex: number,
): BuildResult {
  if (axes.length === 0) return { products: [], notes: [] };

  const source = analysis.fileName === analysis.sheetName
    ? analysis.fileName
    : `${analysis.fileName} · ${analysis.sheetName}`;
  const notes: string[] = [];
  const drafts = extractSeries(analysis, { axes });

  // 先按「表内容 → 文件名」的顺序推产品名，避免把一长串文件名直接当产品名
  const meta = deriveProductName(analysis.rows, analysis.fileName);
  if (meta.short && meta.full && meta.short !== meta.full) {
    notes.push(`识别到产品：${meta.full}${meta.code ? `（${meta.code}）` : ''}，页面按简称「${meta.short}」显示`);
  }
  const pm = { fullName: meta.full || undefined, code: meta.code || undefined };

  if (mode === 'auto') {
    const pair = detectUnitAccumPair(analysis, axes);
    if (pair) {
      const unitDraft = drafts[axes.indexOf(pair[0])];
      const accumDraft = drafts[axes.indexOf(pair[1])];
      const pts = mergeUnitAccum(draftToPoints(unitDraft), draftToPoints(accumDraft));
      if (pts.length >= 2) {
        notes.push('已识别为「单位净值 + 累计净值」，合并为 1 个产品（收益按累计净值口径计算）');
        return {
          products: [makeProduct(meta.short || baseName(analysis.fileName), pts, source, startIndex, false, pm)],
          notes,
        };
      }
      notes.push('单位/累计净值合并后有效数据不足 2 行，已按每列一个产品导入');
    }
  }

  const products: Product[] = [];
  drafts.forEach((d) => {
    const pts = toNavPoints(draftToPoints(d));
    if (pts.length < 2) {
      notes.push(`「${d.name}」有效数据不足 2 行，已跳过`);
      return;
    }
    // 只有一条序列时，识别出的产品简称比「单位净值」这类表头更适合当产品名；
    // 多序列（宽表逐列导入）保留原表头，避免把所有列都冠上同一个产品名
    const name = drafts.length === 1 && meta.short ? meta.short : d.name;
    products.push(makeProduct(name, pts, source, startIndex + products.length, false, pm));
    if ((d as SeriesDraft).kind === 'return') {
      notes.push(`「${d.name}」按收益率序列处理，已自动累乘还原为净值`);
    }
  });
  return { products, notes };
}

/** 兜底：仅去扩展名的文件名 */
function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim() || '未命名产品';
}
