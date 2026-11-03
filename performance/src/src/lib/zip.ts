/**
 * 极简 ZIP 解压（浏览器原生 DecompressionStream，不引入第三方依赖）
 *
 * 只覆盖实际托管 / 服务机构导出会用到的部分：
 *  - 存储（method 0）与 Deflate（method 8）
 *  - 中央目录（EOCD）遍历，支持多级嵌套 zip（如国君托管「外层 zip 含 N 个月度内层 zip」）
 *  - 文件名编码：UTF-8 标志位优先，否则按 GBK 回退（WinRAR / 360压缩 常见）
 *
 * 不支持：加密条目、ZIP64（超大单文件）、分卷包。遇到会明确报错而不是静默给空数据。
 */

export interface ZipEntry {
  /** 包内相对路径（已按 UTF-8 / GBK 正确解码） */
  name: string;
  bytes: Uint8Array;
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const FLAG_UTF8 = 0x800;
const MAX_DEPTH = 3;

/** 是否是 ZIP（看文件头，不依赖扩展名——有些导出会把 zip 命名成 .xls） */
export function isZip(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const v = new Uint8Array(buf, 0, 4);
  return v[0] === 0x50 && v[1] === 0x4b && (v[2] === 0x03 || v[2] === 0x05 || v[2] === 0x07);
}

/**
 * 展开 zip（含嵌套）。返回全部叶节点条目。
 * @param prefix 嵌套层级前缀，用于拼出可读路径
 */
export async function unzip(
  buf: ArrayBuffer,
  prefix = '',
  depth = 0,
): Promise<ZipEntry[]> {
  if (depth > MAX_DEPTH) {
    throw new Error(`压缩包嵌套层级超过 ${MAX_DEPTH} 层，已停止展开`);
  }
  const entries = readCentralDirectory(buf);
  const out: ZipEntry[] = [];
  for (const e of entries) {
    if (/(^|\/)(__MACOSX|\.)/.test(e.name)) continue; // 跳过 macOS 资源叉与隐藏文件
    const raw = await inflateEntry(buf, e);
    const name = prefix ? `${prefix} › ${e.name}` : e.name;
    if (isZip(toArrayBuffer(raw))) {
      out.push(...(await unzip(toArrayBuffer(raw), name, depth + 1)));
      continue;
    }
    out.push({ name, bytes: raw });
  }
  return out;
}

/* ------------------------------------------------------------- 中央目录 */

interface CenEntry {
  name: string;
  method: number;
  compSize: number;
  rawSize: number;
  /** 本地头偏移 */
  offset: number;
  /** 数据区偏移（本地头之后的压缩数据起点） */
  dataOffset: number;
  /** ZIP64 或数据描述符导致大小未知 */
  sizeUnknown: boolean;
}

function readCentralDirectory(buf: ArrayBuffer): CenEntry[] {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const len = buf.byteLength;

  // EOCD 在文件末尾，向后搜最多 64KB + 22
  let eocd = -1;
  const searchFrom = Math.max(0, len - 65558);
  for (let i = len - 22; i >= searchFrom; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP：未找到结束记录（EOCD）');

  let count = dv.getUint16(eocd + 10, true);
  let cenOffset = dv.getUint32(eocd + 16, true);
  // 计数为 0xFFFF 时按 ZIP64 处理：这里只做兜底——从中央目录头开始一直扫到 EOCD
  const zip64 = count === 0xffff || cenOffset === 0xffffffff;

  const out: CenEntry[] = [];
  let p = cenOffset;
  while (p + 46 <= len && dv.getUint32(p, true) === SIG_CEN) {
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const rawSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);

    const nameBytes = u8.subarray(p + 46, p + 46 + nameLen);
    const name = decodeName(nameBytes, (flags & FLAG_UTF8) !== 0);

    // 本地头里再取一次长度，得到真正的压缩数据起点
    let dataOffset = localOff + 30;
    if (localOff + 30 <= len && dv.getUint32(localOff, true) === SIG_LOC) {
      dataOffset = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
    }

    const sizeUnknown = compSize === 0xffffffff || rawSize === 0xffffffff
      || ((flags & 0x08) !== 0 && compSize === 0);
    if (sizeUnknown && !hasDecompressionStream()) {
      throw new Error('包含 ZIP64 / 数据描述符条目，当前浏览器无法解压');
    }

    out.push({
      name, method, compSize, rawSize, offset: localOff, dataOffset, sizeUnknown,
    });

    p += 46 + nameLen + extraLen + commentLen;
    if (!zip64 && out.length >= count) break;
  }

  if (!out.length) throw new Error('ZIP 内未找到任何条目');
  return out;
}

/* ------------------------------------------------------------- 解压 */

async function inflateEntry(buf: ArrayBuffer, e: CenEntry): Promise<Uint8Array> {
  const u8 = new Uint8Array(buf);
  const end = e.sizeUnknown ? buf.byteLength : Math.min(buf.byteLength, e.dataOffset + e.compSize);
  const chunk = u8.subarray(e.dataOffset, Math.max(e.dataOffset, end));

  if (e.method === 0) return new Uint8Array(chunk);
  if (e.method !== 8) {
    throw new Error(`不支持的压缩方式（method=${e.method}），可能使用了加密或分卷`);
  }
  return inflateRaw(chunk, e.sizeUnknown ? undefined : e.rawSize);
}

function hasDecompressionStream(): boolean {
  return typeof (globalThis as { DecompressionStream?: unknown }).DecompressionStream === 'function';
}

async function inflateRaw(chunk: Uint8Array, expected?: number): Promise<Uint8Array> {
  if (!hasDecompressionStream()) {
    throw new Error('当前浏览器不支持原生解压（DecompressionStream），请改用 Chrome / Edge / Safari 最新版');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([toArrayBuffer(chunk)]).stream().pipeThrough(ds);
  const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  // 尾部可能残留下一个条目的字节，按声明的未压缩长度裁剪
  if (expected && expected > 0 && inflated.length > expected) return inflated.subarray(0, expected);
  return inflated;
}

/* ------------------------------------------------------------- 编码 */

/** UTF-8 标志位未置位时，国内压缩软件常写 GBK——出现替换字符就回退 GBK */
function decodeName(bytes: Uint8Array, utf8: boolean): string {
  const utf = new TextDecoder('utf-8').decode(bytes);
  if (utf8 || !utf.includes('\uFFFD')) return utf;
  try {
    const gbk = new TextDecoder('gbk').decode(bytes);
    return gbk.includes('\uFFFD') ? utf : gbk;
  } catch {
    return utf;
  }
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}
