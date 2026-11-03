/**
 * 产品名称识别与简称提取
 *
 * 托管 / 服务机构导出的文件名通常是
 *   SY0001_示例稳健一号私募证券投资基金_20260201新规_纳税申报表_1791448635252.xls
 * 直接拿文件名当产品名会又长又像乱码。这里做三件事：
 *   1. 优先从表内容里读「产品名称 / 基金名称 / 产品代码」等字段，内容比文件名可靠
 *   2. 内容里没有时清洗文件名：剔除产品代码、日期流水、13 位时间戳、文档类型词
 *   3. 由全称推出简称：去掉基金类型后缀与基金管理人字号，得到「稳健一号」这类可显示名
 */

/** 基金类型后缀（全称 → 核心字号时剔除） */
const FUND_SUFFIX = [
  '私募证券投资基金',
  '私募股权投资基金',
  '私募基金',
  '证券投资基金',
  '资产管理计划',
  '资管计划',
  '集合资产管理计划',
  '单一资产管理计划',
  '基金',
];

/** 基金管理人字号（简称里剔除的前缀），命中越长的越优先 */
const MANAGER_PREFIX = [
  '上海示例私募基金管理有限公司',
  '上海示例',
  '示例',
];

/** 文件名里的文档类型词：所在分段整段丢弃 */
const DOC_WORDS = [
  '纳税申报表', '申报表', '增值税', '纳税', '估值表', '净值表', '产品运行表', '运行表',
  '投资者明细表', '明细表', '统计表', '汇总表', '评估表', '测算表', '台账',
  '年度报告', '半年度报告', '年报', '半年报', '月报', '季报', '周报', '日报', '报表',
  '产品结构图', '结构图', '分红公告', '公告', '承诺函', '征询函', '说明函', '合同',
  '私募产品', '数据', '导出', '新规', '历史', '净值', '模板', '样本', '示例',
  'signed', '已压缩', '副本',
];

/** 全称里的基金名：必须以中文开头，避免把产品代码 SY0001 一起吞进去 */
const FUND_NAME_RE =
  /[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9（）()·]{0,38}?(?:私募证券投资基金|私募股权投资基金|证券投资基金|私募基金|集合资产管理计划|单一资产管理计划|资产管理计划|资管计划)/;

/** 「稳健一号 / 兴鑫一号 / 君鑫二号」这类字号 + 序号 */
const SERIAL_RE =
  /[\u4e00-\u9fa5]{2,6}[一二三四五六七八九十百零壹贰叁肆伍陆柒捌玖拾\d]{1,3}号/;

/**
 * 产品代码：SY0001、P12345 等。
 * 两侧只排除字母数字（不排除下划线 / 中文），否则 `SY0001_示例…` 这种下划线分隔的文件名取不到代码。
 */
const CODE_RE = /(?<![A-Za-z0-9])([A-Za-z]{1,4}\d{3,8})(?![A-Za-z0-9])/;

/** 13 位毫秒时间戳 / 长流水号 */
const LONG_NUM_RE = /^\d{9,}$/;

/** 8 位日期开头（20260201新规） */
const DATE8_RE = /^(19|20)\d{6}/;

export interface ProductNameMeta {
  /** 全称，如 示例稳健一号私募证券投资基金 */
  full: string;
  /** 简称，如 稳健一号 */
  short: string;
  /** 产品代码，如 SY0001 */
  code: string;
  /** 名称来源，便于页面上标注 */
  from: 'content' | 'filename' | 'fallback';
}

const EMPTY: ProductNameMeta = { full: '', short: '', code: '', from: 'fallback' };

/**
 * 由工作表内容 + 文件名推导产品名。
 * @param rows 工作表文本矩阵（已归一化）
 * @param fileName 原始文件名
 */
export function deriveProductName(rows: string[][], fileName: string): ProductNameMeta {
  const fromContent = scanContent(rows);
  const fromFile = parseFileName(fileName);
  const manager = managerPrefixFrom(rows);

  const full = fromContent.full || fromFile.full;
  const code = fromContent.code || fromFile.code;
  const core = fromContent.core || stripSuffix(fromFile.core || fromFile.full);

  if (!full && !core) {
    return { ...EMPTY, short: cleanBase(fileName) };
  }

  const short = shorten(core || stripSuffix(full), manager);
  return {
    full: full || core,
    short: short || core || full,
    code,
    from: fromContent.full || fromContent.core ? 'content' : 'filename',
  };
}

/* ---------------------------------------------------------------- 内容扫描 */

/** 在表头区找「产品名称 / 基金名称 / 产品代码」等字段并取首个非空值 */
function scanContent(rows: string[][]): { full: string; core: string; code: string } {
  const out = { full: '', core: '', code: '' };
  const limit = Math.min(rows.length, 20);
  for (let r = 0; r < limit; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const head = rows[r][c] ?? '';
      const key = head.replace(/\s/g, '');
      if (!key) continue;

      const isName = /^(基金)?(产品|计划)?(全称|名称)$|^(基金|产品)(全称|名称)$|^产品名称$|^基金名称$/.test(key);
      const isCode = /^(基金)?(产品)?(代码|编码|编号)$/.test(key);

      if (isName || isCode) {
        const v = firstValueBelow(rows, r, c);
        if (!v) continue;
        if (isName && !out.full) out.full = v;
        if (isCode && !out.code && CODE_RE.test(v)) out.code = v;
      }
    }
  }

  // 表头没找到就直接全表搜一个符合基金命名规则的字符串
  if (!out.full) {
    for (let r = 0; r < rows.length; r++) {
      for (const cell of rows[r]) {
        if (!cell || cell.length > 40) continue;
        const m = cell.match(FUND_NAME_RE);
        if (m) { out.full = m[0]; break; }
      }
      if (out.full) break;
    }
  }
  if (!out.core && !out.full) {
    for (let r = 0; r < rows.length; r++) {
      for (const cell of rows[r]) {
        if (!cell || cell.length > 30) continue;
        const m = cell.match(SERIAL_RE);
        if (m) { out.core = m[0]; break; }
      }
      if (out.core) break;
    }
  }
  return out;
}

/** 取某单元格下方（同列）第一个看起来像值的非空文本 */
function firstValueBelow(rows: string[][], row: number, col: number): string {
  const limit = Math.min(rows.length, row + 15);
  for (let r = row + 1; r < limit; r++) {
    const v = (rows[r]?.[col] ?? '').trim();
    if (!v) continue;
    if (/^[:：]/.test(v)) continue;
    if (v.length > 40) continue;
    if (/^[A-Za-z0-9]{0,4}$/.test(v) && v.length < 4) continue; // 极短字母数字当空
    return v.replace(/\s+/g, ' ').trim();
  }
  return '';
}

/** 从「纳税人名称 / 基金管理人」里反推公司字号（如 示例） */
function managerPrefixFrom(rows: string[][]): string[] {
  const limit = Math.min(rows.length, 12);
  for (let r = 0; r < limit; r++) {
    for (const cell of rows[r]) {
      const m = (cell ?? '').match(
        /(?:纳税人名称|管理人名称|基金管理人|基金管理公司|管理人|公司名称|纳税人)\s*[:：]\s*([^\s，,。;；]{4,40})/,
      );
      if (!m) continue;
      let s = m[1]
        .replace(/(?:私募基金管理有限公司|基金管理有限公司|资产管理有限公司|投资管理有限公司|管理有限公司)$/, '')
        .replace(/^(?:上海|北京|深圳|广州|杭州|宁波|厦门|珠海|苏州|南京|天津|成都|重庆|武汉|西安|青岛|大连|长沙|合肥|福州|济南|郑州|无锡|佛山|东莞)/, '');
      s = s.trim();
      if (s.length >= 2 && s.length <= 8) return [s, ...MANAGER_PREFIX];
    }
  }
  return MANAGER_PREFIX;
}

/* -------------------------------------------------------------- 文件名解析 */

function parseFileName(fileName: string): { full: string; core: string; code: string } {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[（(]\d+[)）]$/, '').trim();
  const codeM = base.match(CODE_RE);
  const code = codeM ? codeM[1] : '';

  const fullM = base.match(FUND_NAME_RE);
  if (fullM) return { full: fullM[0], core: stripSuffix(fullM[0]), code };

  // 没有完整基金名时按分隔符切段，逐段剔除噪声
  const segs = base.split(/[_\-—–\s[\]{}(),，、]+/).filter(Boolean);
  const kept: string[] = [];
  for (const seg of segs) {
    if (!seg) continue;
    if (LONG_NUM_RE.test(seg)) continue;
    if (DATE8_RE.test(seg)) continue;
    if (CODE_RE.test(seg) && seg.length <= 8) continue;
    if (/^\d{4}[年\-/.]\d{1,2}/.test(seg)) continue;
    if (/\d{4}Q\d/i.test(seg)) continue;
    if (DOC_WORDS.some((w) => seg.includes(w))) continue;
    kept.push(seg);
  }
  const cand = kept.sort((a, b) => b.length - a.length)[0] ?? '';
  const serialM = cand.match(SERIAL_RE) || base.match(SERIAL_RE);
  return { full: '', core: serialM ? serialM[0] : stripSuffix(cand), code };
}

/** 去掉基金类型后缀，得到「示例稳健一号」这类核心字号 */
function stripSuffix(name: string): string {
  let s = (name ?? '').trim();
  for (const suf of FUND_SUFFIX) {
    if (s.endsWith(suf) && s.length > suf.length) {
      s = s.slice(0, s.length - suf.length);
      break;
    }
  }
  return s.trim();
}

/** 去掉基金管理人字号，得到可在图表上显示的简称 */
function shorten(core: string, prefixes: string[]): string {
  let s = (core ?? '').trim();
  for (const p of [...prefixes].sort((a, b) => b.length - a.length)) {
    if (p && s.startsWith(p) && s.length > p.length) {
      s = s.slice(p.length);
      break;
    }
  }
  return s.trim() || core.trim();
}

/** 兜底：仅去扩展名与明显噪声 */
function cleanBase(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[（(]\d+[)）]$/, '')
    .replace(/_\d{9,}$/, '')
    .trim() || '未命名产品';
}

/* ---------------------------------------------------------------- 编码兜底 */

/**
 * 修复「UTF-8 字节被按单字节解码」的乱码（如 è·ƒå¨ä¸€å·）。
 * 仅当字符串中不含中文、且 Latin-1 补充区字符占比高时尝试还原，避免误伤正常文本。
 */
export function repairMojibake(text: string): string {
  if (!text) return text;
  if (/[\u4e00-\u9fa5]/.test(text)) return text;
  let latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0xc0 && c <= 0xff) latin++;
  }
  if (latin < 2 || latin / text.length < 0.3) return text;

  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 0xff) bytes.push(c);
    else return text; // 含非 Latin-1 字符，无法按此路径还原
  }
  try {
    const out = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
    return out.includes('\uFFFD') ? text : out;
  } catch {
    return text;
  }
}
