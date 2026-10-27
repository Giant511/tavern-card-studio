/**
 * PNG 角色卡：块级读写（v0.1.4 / T12.2，决策 #162–#164）。
 *
 * ## 为什么是纯 TS 的块操作
 *
 * SillyTavern 的 PNG 卡 = **一张普通 PNG** + 一个 `tEXt` 数据块：
 *
 * ```
 * 文件签名(8) ┌ IHDR ┐ ┌ IDAT… ┐ ┌ tEXt(keyword "ccv3" | "chara") ┐ ┌ IEND ┐
 * ```
 *
 * 那个块里放的是 base64(卡 JSON)。所以整件事**不需要图像编解码**：
 * 既不重压像素（像素逐字节不变），也不引原生依赖（MSI 里少一个坑）。
 * 只需要"按块结构走一遍、找到/删掉/插入一个块"。
 *
 * 这条边界很重要：一旦用 canvas 重新编码，PNG 的调色板、gAMA/iCCP、
 * 交错方式都可能被改写 —— 用户拿回去会发现"图变了一点"，而且没有任何提示。
 * 决策 D1 定的是**零重编码**。
 *
 * ## 三条语义（需求 D1–D3）
 *
 * 1. **读 keyword 优先级 `ccv3` → `chara`**（V3 优先）。同一张图里两个块都在
 *    是可能的（有些工具既写 V3 又写兼容用的 V2），V3 信息更全。
 * 2. **写 keyword 与 spec 一致**：V2 → `chara`，V3 → `ccv3`。
 * 3. **写之前必须删掉既有的 `ccv3`/`chara` 块**。重复块是隐性炸弹：
 *    两个块都合法，ST 读哪个取决于实现细节，用户看到的是"改了没生效"。
 *    这里改成"先全删、再插一个"，所以**二次导出不会累积**。
 *
 * ## CRC：坏块必须报错，不许静默跳过
 *
 * 逐块校验 CRC-32。一个坏块意味着"文件被人手工改过"或"传输截断"，
 * 此时把里面的 base64 当数据用，得到的可能是一张**内容对但来源不明**的卡。
 * 静默跳过更糟：用户会以为这个 PNG 本来就是空图。
 *
 * 例外只有一个：**不认识的关键块**（ancillary，首字母小写）本来就可以忽略，
 * 但它们仍要过 CRC —— 忽略的是"语义"，不是"完整性"。
 */

/** PNG 文件签名 */
const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 卡数据用的两个 keyword。顺序即**读取**优先级（决策 D2） */
export const PNG_CARD_KEYWORDS = ['ccv3', 'chara'] as const;
export type PngCardKeyword = (typeof PNG_CARD_KEYWORDS)[number];

/** 写块时 spec → keyword */
export type PngCardSpec = 'v2' | 'v3';

export const PNG_KEYWORD_FOR_SPEC: Readonly<Record<PngCardSpec, PngCardKeyword>> = {
  v2: 'chara',
  v3: 'ccv3',
};

// ── CRC-32（PNG 规范附录 D 的表驱动实现）────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── 字节/字符串工具 ─────────────────────────────────────────

const ASCII = new TextDecoder('latin1');

/** tEXt 的 text 是 Latin-1；base64 与 keyword 都是 ASCII，所以按字节搬运即可 */
function latin1ToString(bytes: Uint8Array): string {
  return ASCII.decode(bytes);
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0xff) throw new Error(`tEXt 只允许 Latin-1，遇到 U+${code.toString(16)}`);
    out[index] = code;
  }
  return out;
}

function base64ToBytes(base64: string): Uint8Array {
  // 去掉换行与空白：有些工具会折行写入
  const clean = base64.replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  // 一次 join 会撑爆参数上限，按 32 KiB 分段
  const CHUNK = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

// ── 块结构 ──────────────────────────────────────────────────

export interface PngChunk {
  /** 4 字节类型，如 `IHDR` / `tEXt` / `IDAT` */
  type: string;
  /** 块数据（不含长度与 CRC） */
  data: Uint8Array;
  /** 原始整块字节（长度 + 类型 + 数据 + CRC）—— 原样回写时用它 */
  raw: Uint8Array;
}

export class PngCardError extends Error {
  readonly code: 'NOT_PNG' | 'TRUNCATED' | 'BAD_CRC' | 'BAD_KEYWORD' | 'NO_IEND' | 'BAD_BASE64' | 'BAD_JSON';

  constructor(code: PngCardError['code'], message: string) {
    super(message);
    this.name = 'PngCardError';
    this.code = code;
  }
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  );
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/**
 * 扫描全部块并逐块校验 CRC。
 *
 * 长度字段是攻击面：`length` 声明 4 GB 时不能真去 slice。所以每一步都先
 * 确认"声明长度 + 12 字节头尾"没超出剩余字节，否则报 TRUNCATED。
 */
export function readPngChunks(bytes: Uint8Array): PngChunk[] {
  if (bytes.length < SIGNATURE.length || !equalBytes(bytes.subarray(0, 8), SIGNATURE)) {
    throw new PngCardError('NOT_PNG', '不是 PNG 文件（文件签名不匹配）');
  }

  const chunks: PngChunk[] = [];
  let offset = SIGNATURE.length;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new PngCardError('TRUNCATED', `PNG 在偏移 ${String(offset)} 处截断（读不到块头）`);
    }
    const length = readUint32(bytes, offset);
    const type = latin1ToString(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (crcEnd > bytes.length) {
      throw new PngCardError(
        'TRUNCATED',
        `PNG 块 ${type} 声明 ${String(length)} 字节，但文件在偏移 ${String(bytes.length)} 就结束了`,
      );
    }
    const data = bytes.subarray(dataStart, dataEnd);
    const expected = readUint32(bytes, dataEnd);
    const actual = crc32(bytes.subarray(offset + 4, dataEnd));
    if (expected !== actual) {
      throw new PngCardError(
        'BAD_CRC',
        `PNG 块 ${type} 的 CRC 校验失败（文件声明 ${expected.toString(16)}，实算 ${actual.toString(16)}）——` +
          '文件可能被截断或手工改过',
      );
    }
    chunks.push({ type, data, raw: bytes.subarray(offset, crcEnd) });
    offset = crcEnd;
    if (type === 'IEND') {
      // IEND 之后按规范不该再有数据；容忍尾部垃圾但不再解析
      break;
    }
  }

  if (chunks.length === 0 || chunks[chunks.length - 1]!.type !== 'IEND') {
    throw new PngCardError('NO_IEND', 'PNG 缺少 IEND 块 —— 文件不完整');
  }
  return chunks;
}

/** 从 tEXt 的 data 里拆出 keyword 与 text（以第一个 NUL 分隔） */
function splitTextChunk(data: Uint8Array): { keyword: string; text: string } | null {
  const nul = data.indexOf(0);
  if (nul <= 0) return null;
  return {
    keyword: latin1ToString(data.subarray(0, nul)),
    text: latin1ToString(data.subarray(nul + 1)),
  };
}

/** 造一个 tEXt 块（含正确的长度与 CRC） */
function buildTextChunk(keyword: string, text: string): Uint8Array {
  const keywordBytes = asciiBytes(keyword);
  const textBytes = asciiBytes(text);
  const dataLength = keywordBytes.length + 1 + textBytes.length;
  const chunk = new Uint8Array(12 + dataLength);
  writeUint32(chunk, 0, dataLength);
  chunk.set(asciiBytes('tEXt'), 4);
  chunk.set(keywordBytes, 8);
  chunk[8 + keywordBytes.length] = 0;
  chunk.set(textBytes, 8 + keywordBytes.length + 1);
  const crc = crc32(chunk.subarray(4, 8 + dataLength));
  writeUint32(chunk, 8 + dataLength, crc);
  return chunk;
}

// ── 读 ──────────────────────────────────────────────────────

export type PngCardParseResult =
  | {
      kind: 'card';
      /** 解析出来的卡 JSON（未做任何 schema 校验 —— 交给上层 parseStCard） */
      json: unknown;
      /** 命中的 keyword，用来告诉用户"这张是 V2 还是 V3" */
      keyword: PngCardKeyword;
      /** 原始 JSON 文本（逐字节保真，导出时可直接写回） */
      jsonText: string;
      /** 完整图片字节（**含**数据块，就是输入本身） */
      imageBytes: Uint8Array;
    }
  | {
      kind: 'bare';
      /** 无数据块的纯图片 */
      imageBytes: Uint8Array;
      /** 给用户的解释（可能指出"有 iTXt 但我们只支持 tEXt"） */
      note: string;
    };

/**
 * 解析 PNG 卡。
 *
 * 读取顺序 `ccv3` → `chara`（决策 D2）。找到第一个能成功解码的就收工；
 * 若两个块都在但 `ccv3` 坏了（CRC 或 base64 失败），**不回落到 `chara`** ——
 * 那样会让用户以为"读的是 V3"，实际读到的是旧的 V2，比直接报错难查得多。
 */
export function parsePngCard(bytes: Uint8Array): PngCardParseResult {
  const chunks = readPngChunks(bytes);

  const texts = new Map<string, string>();
  const otherTextChunks: string[] = [];
  for (const chunk of chunks) {
    if (chunk.type === 'tEXt') {
      const parsed = splitTextChunk(chunk.data);
      if (parsed === null) continue;
      if ((PNG_CARD_KEYWORDS as readonly string[]).includes(parsed.keyword)) {
        // 同名块重复时**以第一个为准**并保留其余用于诊断
        if (!texts.has(parsed.keyword)) texts.set(parsed.keyword, parsed.text);
      }
      continue;
    }
    // iTXt / zTXt 里也可能塞卡数据（部分工具这么干），我们不支持但要说清楚
    if (chunk.type === 'iTXt' || chunk.type === 'zTXt') {
      const keyword = latin1ToString(chunk.data.subarray(0, Math.max(0, chunk.data.indexOf(0))));
      if ((PNG_CARD_KEYWORDS as readonly string[]).includes(keyword)) {
        otherTextChunks.push(`${chunk.type}:${keyword}`);
      }
    }
  }

  for (const keyword of PNG_CARD_KEYWORDS) {
    const text = texts.get(keyword);
    if (text === undefined) continue;

    let raw: Uint8Array;
    try {
      raw = base64ToBytes(text);
    } catch {
      throw new PngCardError(
        'BAD_BASE64',
        `PNG 里的 ${keyword} 块不是合法的 base64 —— 卡数据已损坏，无法读取`,
      );
    }

    let jsonText: string;
    try {
      jsonText = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new PngCardError('BAD_JSON', `PNG 里的 ${keyword} 块不是合法的 UTF-8 文本`);
    }

    let json: unknown;
    try {
      json = JSON.parse(jsonText);
    } catch {
      throw new PngCardError('BAD_JSON', `PNG 里的 ${keyword} 块不是合法的 JSON`);
    }

    return { kind: 'card', json, keyword, jsonText, imageBytes: bytes };
  }

  const hint =
    otherTextChunks.length === 0
      ? '该 PNG 不含角色卡数据（没有 ccv3 / chara 数据块）'
      : `该 PNG 的卡数据在 ${otherTextChunks.join('、')} 里，但当前只支持 tEXt 块 —— 无法读取`;
  return { kind: 'bare', imageBytes: bytes, note: hint };
}

// ── 写 ──────────────────────────────────────────────────────

/**
 * 把卡写进 PNG。
 *
 * 顺序（决策 D3，不能颠倒）：
 *   1. 扫描并校验原图（坏图不写）；
 *   2. **剥离**所有既有 `ccv3` / `chara` 块；
 *   3. 在 IEND 之前插入一个新块；
 *   4. 其余块**逐字节原样**拼回去（顺序不变）。
 *
 * `imageBytes` 若是 PNG 卡（已带数据块），第 2 步会把旧块去掉 —— 所以
 * "换成默认卡面再导出"不会把上一张卡的正文留在图里，二次导出也不会累积。
 *
 * @param imageBytes 完整 PNG 字节
 * @param json       卡 JSON：传**字符串**可保证内容逐字节原样写入；
 *                   传对象则用 `JSON.stringify` 序列化（键序由调用方决定）
 * @param spec       `v2` → `chara`，`v3` → `ccv3`
 */
export function buildPngCard(
  imageBytes: Uint8Array,
  json: string | Record<string, unknown>,
  spec: PngCardSpec,
): Uint8Array {
  const chunks = readPngChunks(imageBytes);
  const keyword = PNG_KEYWORD_FOR_SPEC[spec];

  const jsonText = typeof json === 'string' ? json : JSON.stringify(json);
  const text = bytesToBase64(new TextEncoder().encode(jsonText));
  const textChunk = buildTextChunk(keyword, text);

  const kept: Uint8Array[] = [];
  let inserted = false;
  for (const chunk of chunks) {
    if (chunk.type === 'tEXt') {
      const parsed = splitTextChunk(chunk.data);
      if (parsed !== null && (PNG_CARD_KEYWORDS as readonly string[]).includes(parsed.keyword)) {
        // D3：旧块一律丢弃（不论 keyword 是新是旧）
        continue;
      }
    }
    if (chunk.type === 'IEND' && !inserted) {
      kept.push(textChunk);
      inserted = true;
    }
    kept.push(chunk.raw);
  }

  const total = SIGNATURE.length + kept.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  out.set(SIGNATURE, 0);
  let offset = SIGNATURE.length;
  for (const part of kept) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * 只取图像部分（去掉卡数据块）。
 *
 * 用途：把「PNG 卡」当卡面用时（D4 的"原图"语义），界面预览不该带着
 * 一张卡的 base64 在里面 —— 那是几百 KB 的无用负载，而且会让
 * "这张图就是那张卡"变成两次不同的东西。
 */
export function stripPngCardData(imageBytes: Uint8Array): Uint8Array {
  const chunks = readPngChunks(imageBytes);
  const kept: Uint8Array[] = [];
  for (const chunk of chunks) {
    if (chunk.type === 'tEXt') {
      const parsed = splitTextChunk(chunk.data);
      if (parsed !== null && (PNG_CARD_KEYWORDS as readonly string[]).includes(parsed.keyword)) continue;
    }
    kept.push(chunk.raw);
  }
  const total = SIGNATURE.length + kept.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  out.set(SIGNATURE, 0);
  let offset = SIGNATURE.length;
  for (const part of kept) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ── 诊断辅助 ────────────────────────────────────────────────

export interface PngCardSummary {
  width: number;
  height: number;
  /** 命中的卡 keyword；`null` = 纯图片 */
  keyword: PngCardKeyword | null;
  /** 文件里共有几个卡数据块（正常应当是 1；>1 说明图被人反复写过） */
  cardChunkCount: number;
  /** 全部块类型（按出现顺序），排查"为什么读不到"时一眼看出 */
  chunkTypes: string[];
}

/** 读元信息，不解析卡内容也不抛错 —— 给"这张图为什么不行"这类诊断用 */
export function summarizePng(bytes: Uint8Array): PngCardSummary | null {
  let chunks: PngChunk[];
  try {
    chunks = readPngChunks(bytes);
  } catch {
    return null;
  }
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');
  const width = ihdr === undefined ? 0 : readUint32(ihdr.data, 0);
  const height = ihdr === undefined ? 0 : readUint32(ihdr.data, 4);

  let keyword: PngCardKeyword | null = null;
  let cardChunkCount = 0;
  for (const chunk of chunks) {
    if (chunk.type !== 'tEXt') continue;
    const parsed = splitTextChunk(chunk.data);
    if (parsed === null) continue;
    if ((PNG_CARD_KEYWORDS as readonly string[]).includes(parsed.keyword)) {
      cardChunkCount += 1;
      if (keyword === null) keyword = parsed.keyword as PngCardKeyword;
    }
  }

  return { width, height, keyword, cardChunkCount, chunkTypes: chunks.map((chunk) => chunk.type) };
}
