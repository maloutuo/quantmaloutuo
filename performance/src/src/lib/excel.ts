import * as XLSX from 'xlsx';
import { repairMojibake } from '@/lib/naming';
import { isZip, unzip } from '@/lib/zip';

/* ==========================================================================
 * 通用单元格解析
 * ========================================================================== */

const NULL_TOKENS = new Set([
  '', '-', '--', '—', '－', '/', 'n/a', 'na', 'null', 'none', '#n/a', '#value!',
  '#div/0!', 'nan', '空', '无', '暂无',
]);

/** 日期：支持多种 Excel 与中文常见格式，统一输出 yyyy-MM-dd */
export function normalizeDate(raw: unknown): string | null {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return toISO(raw.getFullYear(), raw.getMonth() + 1, raw.getDate());
  }
  const s = String(raw ?? '').trim();
  if (!s || NULL_TOKENS.has(s.toLowerCase())) return null;

  // 纯数字：Excel 日期序列号
  if (/^\d+(\.\d+)?$/.test(s)) {
    const num = Number(s);
    if (num >= 20000 && num <= 80000) return serialToISO(num); // 1954-10 ~ 2119-02
    if (/^\d{8}$/.test(s)) {
      const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8);
      return valid(y, m, d) ? toISO(y, m, d) : null;
    }
    return null;
  }

  // yyyy-mm-dd / yyyy.mm.dd / yyyy年m月d日 / yyyy/m/d
  let m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);
  if (m) return valid(+m[1], +m[2], +m[3]) ? toISO(+m[1], +m[2], +m[3]) : null;

  // m/d/yyyy 或 m/d/yy（美式 / Excel 短日期）
  m = s.match(/^(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{2,4})$/);
  if (m) {
    let y = +m[3];
    if (m[3].length === 2) y = y <= 49 ? 2000 + y : 1900 + y;
    return valid(y, +m[1], +m[2]) ? toISO(y, +m[1], +m[2]) : null;
  }

  // 带时间的日期：取日期部分
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T\s]/);
  if (m) return valid(+m[1], +m[2], +m[3]) ? toISO(+m[1], +m[2], +m[3]) : null;

  return null;
}

/** 数值：支持千分位、全角字符、百分号、货币符号、括号负数 */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s0 = String(raw ?? '').trim();
  if (!s0 || NULL_TOKENS.has(s0.toLowerCase())) return null;
  const isPct = /[%％]$/.test(s0);
  let s = s0
    .replace(/[%％]/g, '')
    .replace(/[¥$￥,，\s]/g, '')
    .replace(/[（）()]/g, '')
    .replace(/[０-９．－]/g, (c) => '0123456789.-'['０１２３４５６７８９．－'.indexOf(c)]);
  const neg = /^-/.test(s);
  s = s.replace(/^-/, '');
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  const out = isPct ? v / 100 : v;
  return neg ? -out : out;
}

function serialToISO(serial: number): string {
  const days = Math.floor(serial);
  const ms = Date.UTC(1899, 11, 30) + days * 86400000;
  const d = new Date(ms);
  return toISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
function toISO(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function valid(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/* ==========================================================================
 * 文件 → 工作表矩阵
 * ========================================================================== */

export interface SheetMatrix {
  name: string;
  /** 全部行（含表头与可能的标题行） */
  rows: string[][];
}

export interface WorkbookData {
  fileName: string;
  sheets: SheetMatrix[];
}

function cellToText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return toISO(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  // 少数老导出会把 UTF-8 字节按单字节解码，这里做一次兜底还原
  return repairMojibake(String(v)).replace(/\s+/g, ' ').trim();
}

/** 读取单个文件（压缩包取包内第一个表格）。批量场景请用 readWorkbooks */
export async function readWorkbook(file: File): Promise<WorkbookData> {
  const list = await readWorkbooks(file);
  return list[0];
}

/** 表格类文件扩展名（在压缩包里筛选用） */
const SPREADSHEET_RE = /\.(xlsx|xls|xlsm|csv)$/i;

/** 字节 → 工作簿。CSV / 文本走字符串通道（含 GBK 回退），Excel 走二进制通道 */
function parseBytes(bytes: Uint8Array, fileName: string): XLSX.WorkBook {
  const isCsv = /\.csv$/i.test(fileName);
  if (isCsv) {
    return XLSX.read(decodeText(toArrayBuffer(bytes)), { type: 'string', raw: false, cellDates: true });
  }
  return XLSX.read(bytes, { type: 'array', cellDates: true });
}

/**
 * 读取一个文件，压缩包会自动展开并逐个解析里面的表格（支持嵌套 zip）。
 * 返回 1~N 个工作簿：普通文件 1 个，压缩包按包内表格数量返回多个。
 * fileName 形如「月度.zip › 2026-06 › 估值表.xls」，保留层级便于溯源。
 */
export async function readWorkbooks(file: File): Promise<WorkbookData[]> {
  const buf = await file.arrayBuffer();

  if (isZip(buf)) {
    const entries = await unzip(buf);
    const targets = entries
      .filter((e) => SPREADSHEET_RE.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    if (targets.length) {
      const out: WorkbookData[] = [];
      for (const e of targets) {
        try {
          out.push({ fileName: `${file.name} › ${e.name}`, sheets: toSheets(parseBytes(e.bytes, e.name)) });
        } catch {
          // 单个坏条目不影响其余文件
        }
      }
      if (out.length) return out;
    }
    // 包内没有可识别的表格文件：.xlsx/.xlsm 本身就是 ZIP 归档，或与 .xls/.csv 被错误命名成
    // .zip —— 直接把整包当工作簿解析一次兜底，避免把真正的 Excel 误判为「空压缩包」而报错。
    try {
      return [{ fileName: file.name, sheets: toSheets(parseBytes(new Uint8Array(buf), file.name)) }];
    } catch {
      if (!targets.length) {
        throw new Error(`压缩包内共 ${entries.length} 个条目，但没有找到 Excel / CSV 文件`);
      }
      throw new Error('压缩包内的 Excel / CSV 全部解析失败');
    }
  }

  return [{ fileName: file.name, sheets: toSheets(parseBytes(new Uint8Array(buf), file.name)) }];
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function toSheets(wb: XLSX.WorkBook): SheetMatrix[] {
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws) return { name, rows: [] };
    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });
    const rows = raw
      .map((r) => (Array.isArray(r) ? r.map(cellToText) : []))
      .filter((r) => r.some((c) => c !== ''));
    return { name, rows };
  });
}

/**
 * 解析粘贴的文本（CSV / TSV / 分号分隔），走与文件一致的解析链路。
 * 用 SheetJS 读取可正确处理引号包裹、字段内含分隔符等手写 CSV 的边界情况。
 */
export function readWorkbookFromText(text: string, fileName = '粘贴数据'): WorkbookData {
  const wb = XLSX.read(text, { type: 'string', raw: false, cellDates: true });
  return { fileName, sheets: toSheets(wb) };
}

/** UTF-8 失败时回退 GBK（国内券商/托管导出的 CSV 常见） */
function decodeText(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8;
  }
}

/* ==========================================================================
 * 版面识别
 * ========================================================================== */

export type Orientation = 'vertical' | 'horizontal';

export interface AxisStat {
  /** 列索引（vertical）或行索引（horizontal） */
  index: number;
  header: string;
  dateRatio: number;
  numRatio: number;
  emptyRatio: number;
  samples: string[];
  /** 是否疑似收益率序列（含 % 或表头含收益率关键字） */
  looksLikeReturn: boolean;
  /** 有效（非空且可解析）样本数 */
  validCount: number;
}

export interface SheetAnalysis {
  sheetName: string;
  fileName: string;
  /** 归一化后的文本矩阵 */
  rows: string[][];
  orientation: Orientation;
  /** vertical：表头行索引；horizontal：表头列索引 */
  headerIndex: number;
  /** vertical：日期列索引；horizontal：日期所在行索引 */
  dateIndex: number;
  /** 可作为序列的数值轴 */
  valueAxes: AxisStat[];
  /** 全部轴统计 */
  axes: AxisStat[];
  dataCount: number;
  /** 识别置信度 0~1 */
  confidence: number;
}

export interface AnalyzeOverrides {
  orientation?: Orientation;
  headerIndex?: number;
  dateIndex?: number;
}

const DATE_KEYWORDS = /日期|时间|估值日|净值日|交易日|截止日|统计日|date|day|period/i;
const RETURN_KEYWORDS = /[%％]|收益率|涨跌幅|日回报|回报率/i;

/** 统计某一轴（列或行）在给定表头/日期位置下的类型占比 */
function statFor(get: (i: number, j: number) => string, dataLen: number, headerText: string, index: number): AxisStat {
  let dateCount = 0;
  let numCount = 0;
  let emptyCount = 0;
  let pctCount = 0;
  const samples: string[] = [];
  for (let j = 0; j < dataLen; j++) {
    const v = get(index, j);
    if (!v) {
      emptyCount++;
      continue;
    }
    if (normalizeDate(v)) dateCount++;
    const n = parseNumber(v);
    if (n != null) {
      numCount++;
      if (/[%％]/.test(v)) pctCount++;
    }
    if (samples.length < 4) samples.push(v);
  }
  const nonEmpty = Math.max(1, dataLen - emptyCount);
  return {
    index,
    header: headerText,
    dateRatio: dateCount / Math.max(1, dataLen),
    numRatio: numCount / nonEmpty,
    emptyRatio: emptyCount / Math.max(1, dataLen),
    samples,
    looksLikeReturn: pctCount > 0 || RETURN_KEYWORDS.test(headerText),
    validCount: numCount,
  };
}

/**
 * 数值轴判定：非日期轴、非日期关键字列、非空单元格中数字占比 ≥ 60%
 * （阈值取 0.6 以容纳真实数据里常见的零星空值 / "—" 占位）
 */
function isValueAxis(dateIndex: number) {
  return (a: AxisStat) =>
    a.index !== dateIndex &&
    a.numRatio >= 0.6 &&
    a.validCount >= 2 &&
    !DATE_KEYWORDS.test(a.header);
}

function axisCount(rows: string[][], orientation: Orientation): number {
  return orientation === 'vertical'
    ? rows.reduce((mx, r) => Math.max(mx, r.length), 0)
    : rows.length;
}

/** 在给定版面参数下计算完整统计（供自动识别与人工调整共用） */
function buildAnalysis(
  rows: string[][],
  fileName: string,
  orientation: Orientation,
  headerIndex: number,
  dateIndex: number,
): SheetAnalysis {
  const rowCount = rows.length;
  const colCount = rows.reduce((mx, r) => Math.max(mx, r.length), 0);
  const nAxes = axisCount(rows, orientation);
  const dataLen = orientation === 'vertical'
    ? Math.max(0, rowCount - headerIndex - 1)
    : Math.max(0, colCount - headerIndex - 1);

  const get = orientation === 'vertical'
    ? (i: number, j: number) => rows[headerIndex + 1 + j]?.[i] ?? ''
    : (i: number, j: number) => rows[i]?.[headerIndex + 1 + j] ?? '';
  const headerOf = (i: number) =>
    String(
      (orientation === 'vertical' ? rows[headerIndex]?.[i] : rows[i]?.[headerIndex]) ??
        (orientation === 'vertical' ? `第${i + 1}列` : `第${i + 1}行`),
    ).trim();

  const axes: AxisStat[] = [];
  for (let i = 0; i < nAxes; i++) axes.push(statFor(get, dataLen, headerOf(i), i));

  const dateAxis = axes[dateIndex];
  const valueAxes = axes.filter(isValueAxis(dateIndex));

  return {
    sheetName: '',
    fileName,
    rows,
    orientation,
    headerIndex,
    dateIndex,
    valueAxes,
    axes,
    dataCount: dataLen,
    confidence: Math.min(1, dateAxis?.dateRatio ?? 0),
  };
}

type Candidate = SheetAnalysis & { score: number };

function detectVertical(rows: string[][], fileName: string): Candidate | null {
  const rowCount = rows.length;
  let best: Candidate | null = null;
  const maxHeader = Math.min(12, Math.max(0, rowCount - 2));

  for (let h = 0; h <= maxHeader; h++) {
    const probe = buildAnalysis(rows, fileName, 'vertical', h, 0);
    const dateCandidates = probe.axes
      .filter((a) => a.dateRatio >= 0.7)
      .sort((a, b) => {
        const ka = DATE_KEYWORDS.test(a.header) ? 1 : 0;
        const kb = DATE_KEYWORDS.test(b.header) ? 1 : 0;
        if (ka !== kb) return kb - ka;
        return b.dateRatio - a.dateRatio;
      });
    const dateAxis = dateCandidates[0];
    if (!dateAxis) continue;

    const cand = buildAnalysis(rows, fileName, 'vertical', h, dateAxis.index);
    if (cand.valueAxes.length === 0) continue;

    const score = cand.confidence * 100 + cand.valueAxes.length * 5 - h;
    const full: Candidate = { ...cand, score };
    if (!best || score > best.score) best = full;
  }
  return best;
}

function detectHorizontal(rows: string[][], fileName: string): Candidate | null {
  const colCount = rows.reduce((mx, r) => Math.max(mx, r.length), 0);
  let best: Candidate | null = null;
  const maxHeader = Math.min(6, Math.max(0, colCount - 3));

  for (let h = 0; h <= maxHeader; h++) {
    const probe = buildAnalysis(rows, fileName, 'horizontal', h, 0);
    const dateAxis = probe.axes
      .filter((a) => a.dateRatio >= 0.7)
      .sort((a, b) => b.dateRatio - a.dateRatio)[0];
    if (!dateAxis) continue;

    const cand = buildAnalysis(rows, fileName, 'horizontal', h, dateAxis.index);
    if (cand.valueAxes.length === 0) continue;

    let score = cand.confidence * 100 + cand.valueAxes.length * 5 - h * 2;
    // 横向版面：日期轴的表头通常是"日期"，命中则加分
    if (DATE_KEYWORDS.test(dateAxis.header)) score += 30;
    const full: Candidate = { ...cand, score };
    if (!best || score > best.score) best = full;
  }
  return best;
}

/**
 * 分析工作表版面：自动定位表头行、日期轴与数值轴。
 * 支持两种常见版面：
 *  - vertical   ：日期在某一列、每列一条序列（国内导出最常见）
 *  - horizontal ：日期在某一行、每行一条序列（产品清单式）
 * 传入 overrides 可人工指定版面参数（识别不准时在界面上调整）。
 */
export function analyzeSheet(
  sheet: SheetMatrix,
  fileName: string,
  overrides: AnalyzeOverrides = {},
): SheetAnalysis {
  // 统一文本化：调用方可能直接传入含 Date / number 的原始矩阵
  const rows = sheet.rows.map((r) => (Array.isArray(r) ? r.map(cellToText) : []));

  if (overrides.orientation || overrides.headerIndex != null || overrides.dateIndex != null) {
    const orientation = overrides.orientation ?? 'vertical';
    let headerIndex = overrides.headerIndex ?? 0;
    let dateIndex = overrides.dateIndex ?? 0;
    // 未指定的部分沿用自动识别结果
    const auto = analyzeSheet({ name: sheet.name, rows }, fileName);
    if (overrides.headerIndex == null) headerIndex = auto.headerIndex;
    if (overrides.dateIndex == null) dateIndex = auto.dateIndex;
    const res = buildAnalysis(rows, fileName, orientation, headerIndex, dateIndex);
    return { ...res, sheetName: sheet.name, fileName };
  }

  const rowCount = rows.length;
  const vertical = rowCount >= 2 ? detectVertical(rows, fileName) : null;
  const horizontal = detectHorizontal(rows, fileName);

  let chosen: Candidate | null;
  if (vertical && horizontal) chosen = vertical.score >= horizontal.score ? vertical : horizontal;
  else chosen = vertical ?? horizontal;

  const fallbackRes = buildAnalysis(rows, fileName, 'vertical', 0, 0);
  const final = chosen ?? { ...fallbackRes, score: -1, confidence: 0 };
  return { ...final, sheetName: sheet.name, fileName, rows };
}

/* ==========================================================================
 * 版面 → 净值序列
 * ========================================================================== */

export interface SeriesDraft {
  name: string;
  /** 原始数值序列，与 dates 等长（缺失为 null） */
  values: (number | null)[];
  dates: string[];
  /** 该序列原始形态：净值 or 收益率 */
  kind: 'nav' | 'return';
  axisIndex: number;
}

export interface ExtractOptions {
  /** 只抽取指定轴索引；缺省为全部数值轴 */
  axes?: number[];
  /** 强制按收益率序列处理（自动累乘成净值） */
  forceReturn?: boolean;
}

/** 从分析结果中抽取序列（未做日期排序与去空） */
export function extractSeries(
  analysis: SheetAnalysis,
  opts: ExtractOptions = {},
): SeriesDraft[] {
  const { rows, orientation, headerIndex, dateIndex } = analysis;
  const picked = opts.axes?.length ? opts.axes : analysis.valueAxes.map((a) => a.index);

  if (orientation === 'vertical') {
    const dates: string[] = [];
    for (let r = headerIndex + 1; r < rows.length; r++) {
      dates.push(normalizeDate(rows[r]?.[dateIndex] ?? '') ?? '');
    }
    return picked.map((c) => buildDraft(rows, dates, c, headerIndex, orientation, opts));
  }

  // horizontal：日期在某一行，序列在行
  const dates: string[] = [];
  for (let c = headerIndex + 1; c < (rows[dateIndex]?.length ?? 0); c++) {
    dates.push(normalizeDate(rows[dateIndex]?.[c] ?? '') ?? '');
  }
  return picked.map((r) => buildDraft(rows, dates, r, headerIndex, orientation, opts));
}

function buildDraft(
  rows: string[][],
  dates: string[],
  axis: number,
  headerIndex: number,
  orientation: Orientation,
  opts: ExtractOptions,
): SeriesDraft {
  const values: (number | null)[] = [];
  for (let i = 0; i < dates.length; i++) {
    const cell = orientation === 'vertical' ? rows[headerIndex + 1 + i]?.[axis] : rows[axis]?.[headerIndex + 1 + i];
    values.push(parseNumber(cell));
  }
  const header = orientation === 'vertical'
    ? (rows[headerIndex]?.[axis] ?? '')
    : (rows[axis]?.[headerIndex] ?? '');

  let pct = 0;
  for (let i = 0; i < dates.length; i++) {
    const cell = orientation === 'vertical' ? rows[headerIndex + 1 + i]?.[axis] : rows[axis]?.[headerIndex + 1 + i];
    if (typeof cell === 'string' && /[%％]/.test(cell)) pct++;
  }
  const kind: 'nav' | 'return' = opts.forceReturn || pct > values.length * 0.5 ? 'return' : 'nav';

  return {
    name: String(header || `序列${axis + 1}`).trim().replace(/\s+/g, ''),
    values,
    dates,
    kind,
    axisIndex: axis,
  };
}

/* ==========================================================================
 * 序列 → 净值点
 * ========================================================================== */

/** 把序列整理为按日期升序、去重、去空的净值点。收益率序列自动累乘为净值（起点 1）。 */
export function draftToPoints(draft: SeriesDraft): { date: string; nav: number }[] {
  const out: { date: string; nav: number }[] = [];
  let cum = 1;
  for (let i = 0; i < draft.dates.length; i++) {
    const d = draft.dates[i];
    const v = draft.values[i];
    if (!d || v == null) continue;
    if (draft.kind === 'return') {
      cum *= 1 + v;
      out.push({ date: d, nav: Number(cum.toFixed(8)) });
    } else {
      out.push({ date: d, nav: v });
    }
  }
  const map = new Map<string, number>();
  for (const p of out) map.set(p.date, p.nav); // 重复日期保留最后一条
  return [...map.entries()]
    .map(([date, nav]) => ({ date, nav }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export { DATE_KEYWORDS, RETURN_KEYWORDS };
