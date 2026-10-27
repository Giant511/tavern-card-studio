/**
 * 导出（T6.6）——纯逻辑，无 DOM。
 *
 * 两件事：
 *   ① **导出前审计拦截**：`summary.exportable === false` 时必须让用户显式选择
 *      「仍要导出 / 取消」，不能静默放行（阶段 4 定下的语义）；
 *   ② **两种产物**：TXT 按当前预设拼装、JSON 为 SillyTavern 原生结构，
 *      均返回「待写入的文本」，由契约层 `write_file_atomic` 落盘。
 *
 * 这里不碰文件系统：落盘与回执在 app 层调契约完成，
 * 因此本文件可以在 Node 里对"导出文本"做 round-trip 验证。
 */

import {
  BLOCK_DEFINITION_MAP,
  BLOCK_IDS,
  PNG_KEYWORD_FOR_SPEC,
  assembleDescription,
  buildPngCard,
  parsePngCard,
  DEFAULT_WORLDBOOK_FORMAT,
  parseWorldbookTextWith,
  presetAssembleOptions,
  renderWorldbookText,
  serializeStCard,
  summarizePng,
  type AuditReport,
  type BlockId,
  type GreetingFormatParams,
  type PngCardSpec,
  type WorldbookFormatParams,
  type TxtPreset,
  type UnifiedCard,
} from '@tcs/shared';

export type ExportFormat = 'json' | 'txt' | 'png';

export interface ExportBlocked {
  blocked: true;
  /** 错误级问题（必须逐条展示，不能只说"有问题"） */
  errors: AuditReport['issues'];
  message: string;
  /**
   * 硬阻断原因（v0.1.5 / G3-2，红线）。
   *
   * 与审计 error 的区别：审计 error 可以"仍要导出"绕过（用户自己判断），
   * 而这里的问题是**导出会无声丢数据**，绕过等于同意丢内容 —— 所以
   * `hardBlock === true` 时界面**不提供**"仍要导出"。
   */
  hardBlock?: boolean;
  /** 硬阻断的具体说明（逐条，含修复指引） */
  hardReasons?: string[];
}

export interface ExportAllowed {
  blocked: false;
}

export type ExportGate = ExportBlocked | ExportAllowed;

/**
 * 世界书"导出会丢内容"的检查（v0.1.5 / G3-2，红线）。
 *
 * ## 为什么必须有这一层
 *
 * 线上实测链路：用户把别处格式的世界书粘进面板 → 解析器一条都没认出来 →
 * `entries` 变成空数组，而 `text` 仍是那 2300 多字（显示层走文本回退，
 * 编辑器里看着正常）→ 导出 JSON 时 `character_book.entries = []` →
 * **内容消失，且没有任何提示**。
 *
 * 用户的原话是"不得静默导出空世界书 —— 这是无声丢数据红线"。所以这里
 * 不看审计报告（那是"卡好不好"），只看**这条数据会不会被写丢**。
 *
 * ## 两条判据（都是"数据必丢"，不是"格式不规范"）
 *
 * 1. `text` 非空但 `entries` 为空 —— 一个条目都没解析出来，导出必丢；
 * 2. `text` 非空且**重新解析它仍然有 error** —— 说明文本里有解析不了的片段
 *    （缺 `@@END`、缺正文标记、或整段格式不对），此时 `entries` 要么是旧的、
 *    要么是残缺的，导出的都不是用户眼前看到的内容。
 *
 * ## 为什么判据 2 不是"text ≠ renderWorldbookText(entries)"
 *
 * 第一版就是这么写的，截图当场抓出**误拦**：标准格式的卡也被拦了。
 * 原因是规范渲染与用户原文必然字形不同（字段是否写出、顺序、缺省值表达），
 * 于是"不相等"恒成立 —— 把"格式差异"错当成"数据丢失"。
 * 改成"重新解析有没有 error"才是同一个语义：**能不能完整读回来**。
 *
 * 判据刻意不"自动修复"（比如自动把 text 塞进一个条目）：那样会造出一条
 * 用户没写过的条目，比报错更糟。
 */
export function checkWorldbookExportSafety(
  card: UnifiedCard,
  /** 当前世界书格式（v0.1.5 / G4）：必须与编辑器、审计用同一份，否则会误判 */
  worldbookFormat?: WorldbookFormatParams,
): string[] {
  const reasons: string[] = [];
  const text = card.worldbook.text;
  if (text.trim() === '') return reasons;

  const format = worldbookFormat ?? DEFAULT_WORLDBOOK_FORMAT;
  const markHint = format.entryClose.trim() === ''
    ? '条目需以 `【条目0：…】（按当前预设）` 开头、正文标记之后写正文'
    : `条目需以 \`${format.entryOpen.replace('{id}', '0')}\` 开头、\`${format.contentMark}\` 之后写正文、\`${format.entryClose.replace('{id}', '0')}\` 结束`;

  if (card.worldbook.entries.length === 0) {
    reasons.push(
      `世界书有 ${String(text.length)} 字文本，但一个条目都没解析出来（0 条）—— ` +
        '导出会把 character_book.entries 写成空数组，这 ' +
        `${String(text.length)} 字内容会丢失。请先修复世界书格式：` +
        `${markHint}；也可以在「规则与预设 → 世界书预设」里换一个匹配你写法的格式。`,
    );
    return reasons;
  }

  // 判据 2：重新解析当前文本，仍有 error 就说明有内容读不回来
  const reparsed = parseWorldbookTextWith(text, format);
  if (!reparsed.ok) {
    const errors = reparsed.issues.filter((issue) => issue.severity === 'error');
    const first = errors[0];
    const where = first?.line === undefined ? '' : `（第 ${String(first.line)} 行起）`;
    reasons.push(
      `世界书文本里有 ${String(errors.length)} 处无法解析的内容${where}：` +
        `${first?.message ?? '格式不完整'}。` +
        `当前只解析出 ${String(reparsed.entries.length)} 个条目，导出的将不是你在编辑器里看到的内容。`,
    );
  }
  return reasons;
}

/**
 * 导出闸门：审计报告 + 数据完整性 → 是否拦截。
 *
 * 只在 `exportable === false` 时因审计拦截。报告里可能没有 `summary`（构造异常），
 * 此时按"有问题就拦"处理——宁可多拦一次，也不要静默导出坏卡。
 *
 * `card` 是可选的（v0.1.5 / G3-2）：传了才做"世界书会不会丢内容"的硬阻断检查。
 * 保持可选是为了不破坏"只有报告、没有卡"的既有调用（如离线校验脚本）。
 */
export function evaluateExportGate(
  report: AuditReport | null,
  card?: UnifiedCard,
  worldbookFormat?: WorldbookFormatParams,
): ExportGate {
  /*
   * 硬阻断优先于审计：它描述的是"数据必丢"，比"卡可能被平台拒"严重得多。
   * 而且这条**不允许绕过** —— 用户点"仍要导出"等于同意丢内容，
   * 但用户此刻并不知道自己会丢什么（编辑器里看着 2000 多字还在）。
   */
  if (card !== undefined) {
    const hardReasons = checkWorldbookExportSafety(card, worldbookFormat);
    if (hardReasons.length > 0) {
      return {
        blocked: true,
        errors: [],
        hardBlock: true,
        hardReasons,
        message: '世界书条目未能解析，导出将丢失内容，请先修复格式',
      };
    }
  }

  if (!report) {
    return {
      blocked: true,
      errors: [],
      message: '尚未完成审计，无法导出',
    };
  }

  const exportable = report.summary?.exportable;
  if (exportable === true) {
    return { blocked: false };
  }

  const errors = report.issues.filter((issue) => issue.severity === 'error');
  const count = report.summary?.error ?? errors.length;
  return {
    blocked: true,
    errors,
    message:
      count > 0
        ? `存在 ${count} 个错误级问题，导出后可能在目标平台被拒或行为异常。`
        : '审计未通过，导出可能产生不符合平台要求的文件。',
  };
}

export interface ExportArtifactText {
  format: 'json' | 'txt';
  /** 建议文件名（含扩展名） */
  fileName: string;
  /** 将要写入的完整文本 */
  text: string;
  /** 字节数（UTF-8） */
  bytes: number;
  /** 内容 sha256（十六进制），仅 `buildExportAsync` 会填写 */
  sha256: string | null;
  /** 与导出内容相关的说明，展示给用户 */
  notes: string[];
}

/**
 * PNG 产物（v0.1.4 / T12.5）。
 *
 * 刻意做成**判别联合**而不是给文本产物加一个可选 `binary?`：
 * 后者会让"text 是空串"和"这是二进制产物"两种状态同时存在，
 * 调用方迟早会有人读 `artifact.text` 拿到空串并把它写进文件。
 */
export interface ExportArtifactPng {
  format: 'png';
  fileName: string;
  /** 完整 PNG 字节（图像 + 新建的卡数据块） */
  png: Uint8Array;
  bytes: number;
  sha256: string | null;
  notes: string[];
}

export type ExportArtifact = ExportArtifactText | ExportArtifactPng;

/**
 * JSON 导出：SillyTavern 原生结构。
 *
 * 用 2 空格缩进 + 结尾换行，与服务端/既有导出链路一致 ——
 * 这样"导出 → 上传 → 版本 diff"不会因为格式差异产生噪声。
 */
export function buildJsonExport(
  card: UnifiedCard,
  preset: TxtPreset | null,
  greetingFormat?: GreetingFormatParams,
): ExportArtifactText {
  const options = preset ? presetAssembleOptions(preset) : {};
  // v0.1.3 追加项一：初始场景预设决定"多条开场白用哪个分隔行"。
  // 只影响 dirty 板块的回写切分（未编辑的板块用原字段值，不重算）。
  const payload = serializeStCard(card, greetingFormat ? { ...options, greetingFormat } : options);
  const text = `${JSON.stringify(payload, null, 2)}\n`;

  return {
    format: 'json',
    fileName: `${safeName(card)}.json`,
    text,
    bytes: byteLength(text),
    sha256: null,
    notes: [
      `目标规格：${card.meta.spec}${card.meta.specVersion ? ` ${card.meta.specVersion}` : ''}`,
      preset ? `标题与顺序按预设「${preset.name}」拼装` : '按默认标题拼装',
      '缩进 2 空格 + 结尾换行，与服务端存储口径一致',
    ],
  };
}

/**
 * TXT 导出：按当前预设拼装整卡文本。
 *
 * 注意与 JSON 导出的差别：
 *   · TXT 是**给人看/给平台粘贴**的形态，包含标题行与分隔符；
 *   · 性格板块在 TXT 里也占一段（有标题），而 JSON 里它是独立字段。
 * 这正是"同一张卡、两种形态"的预期差异，不是 bug。
 *
 * ── v0.1.3 / 6d：补上字段板块 ────────────────────────────────
 *
 * 这里原来只拼 `assembleDescription` 的结果，而它**只处理 description 分段**。
 * 于是「对话示例」「初始场景」不进 TXT：用户改完这两块、点导出 TXT，
 * 文件里根本没有它们 —— 数据没丢（JSON 有），但 TXT 是主要分享形态，
 * 少两块等于导出残缺，而且**没有任何提示**。
 *
 * 现在按 `preset.blockOrder` 排序"内容单元"：
 *   · description 分段整体算一个单元（`assembleDescription` 的产物无法再切开），
 *     位置取第一个 description 分段在 blockOrder 里的位置；
 *   · 性格、每个字段板块各算一个单元；
 *   · 世界书仍不写入（它是结构化字段，见 docs/04）。
 */
export function buildTxtExport(card: UnifiedCard, preset: TxtPreset): ExportArtifactText {
  const options = presetAssembleOptions(preset);
  const description = assembleDescription(card.blocks, card.description, options);
  const personalityBlock = card.blocks.find((block) => block.id === 'personality');
  const personalityText = personalityBlock?.text ?? '';

  // 性格若已在 description 里（不常见），就不再重复追加
  const personalityHeading = options.heading('personality');
  const alreadyIncluded =
    personalityText.trim() === '' ||
    description.includes(`${personalityHeading}\n${personalityText}`);

  /** 每个"内容单元"在预设顺序里的位置；不存在的板块给 Infinity 以便稳定排在最后 */
  const orderIndex = (id: BlockId): number => {
    const index = preset.blockOrder.indexOf(id);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };

  interface Unit {
    at: number;
    text: string;
  }
  const units: Unit[] = [];

  if (description.trim() !== '') {
    // description 单元的锚点：blockOrder 里第一个 description 分段的位置
    const anchors = BLOCK_IDS.filter(
      (id) => BLOCK_DEFINITION_MAP[id].kind === 'description-segment',
    ).map(orderIndex);
    units.push({ at: Math.min(...anchors), text: description });
  }
  if (!alreadyIncluded) {
    units.push({ at: orderIndex('personality'), text: `${personalityHeading}\n${personalityText}` });
  }
  for (const id of BLOCK_IDS) {
    if (BLOCK_DEFINITION_MAP[id].kind !== 'field-backed') continue;
    const block = card.blocks.find((item) => item.id === id);
    const body = block?.text ?? '';
    // 空板块不输出：TXT 里冒一个只有标题的空段没意义，解析端也会按空块处理
    if (body.trim() === '') continue;
    units.push({ at: orderIndex(id), text: `${options.heading(id)}\n${body}` });
  }

  /*
   * 世界书段（v0.1.5 / G6）。
   *
   * 这里曾经**整段漏掉**：上面那两轮循环只处理 `description-segment` /
   * `personality` / `field-backed` 三类，而世界书是 `structured` ——
   * 于是「导出 TXT」和「另存为 TXT」都不含世界书，用户的世界书在文本里凭空消失。
   * （`shared/format/card-txt.ts` 的 `renderCardText` 一直是对的，但它服务于
   * TXT 卡**导入**，导出面板走的是本函数 —— 两条路径分叉，缺陷只在这一条上。）
   *
   * 内容来源与 renderCardText 一致，优先级也一样：
   *   ① `card.worldbook.text`（编辑器里正在编辑的原文）
   *   ② 从 `entries` 渲染出的 `@@ENTRY` 段
   * ①在前是刻意的：用户改了文本但还没成功解析时，TXT 至少要把他写的东西写出来，
   * 而不是悄悄换成"上一次解析成功的条目"。
   */
  const worldbookBody =
    card.worldbook.text !== ''
      ? card.worldbook.text
      : renderWorldbookText(card.worldbook.entries);
  if (worldbookBody.trim() !== '') {
    // `worldbook.includeHeading === false` 时不带标题（README §4.3 承诺的开关）
    const skipHeading = preset.worldbook?.includeHeading === false;
    units.push({
      at: orderIndex('worldbook'),
      text: skipHeading ? worldbookBody : `${options.heading('worldbook')}\n${worldbookBody}`,
    });
  }

  units.sort((a, b) => a.at - b.at);
  const text = units.map((unit) => unit.text).join(preset.separator);
  const finalText = text.endsWith('\n') ? text : `${text}\n`;

  return {
    format: 'txt',
    fileName: `${safeName(card)}.txt`,
    text: finalText,
    bytes: byteLength(finalText),
    sha256: null,
    notes: [
      `按预设「${preset.name}」拼装（${preset.blockOrder.filter((id) => id !== 'worldbook').length} 个板块）`,
      `分隔符：${describeSeparator(preset.separator)}`,
      '世界书不写入 TXT（它是结构化字段，见 docs/04）',
    ],
  };
}

export function buildExport(
  card: UnifiedCard,
  preset: TxtPreset | null,
  format: ExportFormat,
  greetingFormat?: GreetingFormatParams,
): ExportArtifactText {
  if (format === 'json') return buildJsonExport(card, preset, greetingFormat);
  if (format === 'png') {
    throw new Error('PNG 产物需要卡面字节：请走 buildPngExport');
  }
  if (!preset) {
    throw new Error('TXT 导出需要预设：无法确定标题与分隔符');
  }
  return buildTxtExport(card, preset);
}

/**
 * PNG 卡导出（v0.1.4 / T12.5，决策 #162/#164）。
 *
 * 三步，顺序不能换：
 *   1. 用**与 JSON 导出完全相同**的序列化（`serializeStCard`）得到卡 JSON ——
 *      否则同一次导出，"导出 JSON"和"导出 PNG"里的卡内容会不一样；
 *   2. 记下这份 JSON 文本（不是对象），交给 `buildPngCard` 逐字节写入；
 *   3. `buildPngCard` 负责剥掉图里**既有的** ccv3/chara 块再插新块（D3）。
 *
 * 第 3 步是"换成默认卡面导出"时最关键的一环：那张默认卡面本身是干净的，
 * 但用户可能拿**另一张 PNG 卡**当封面 —— 此时图里带着那张卡的正文，
 * 不剥掉就等于把别人的卡内容塞进了这张卡的 PNG 里。
 *
 * spec 与 keyword 的对应（D2）：V3 → `ccv3`，V2/V1 → `chara`。
 * V1 卡没有 spec 字段，但 ST 读取时认的仍是 `chara`，所以按 V2 写。
 */
export function buildPngExport(
  card: UnifiedCard,
  preset: TxtPreset | null,
  faceBytes: Uint8Array,
  greetingFormat?: GreetingFormatParams,
): ExportArtifactPng {
  const options = preset ? presetAssembleOptions(preset) : {};
  const payload = serializeStCard(card, greetingFormat ? { ...options, greetingFormat } : options);
  const jsonText = `${JSON.stringify(payload, null, 2)}\n`;

  const spec: PngCardSpec = card.meta.spec === 'v3' ? 'v3' : 'v2';
  const keyword = PNG_KEYWORD_FOR_SPEC[spec];
  const png = buildPngCard(faceBytes, jsonText, spec);

  // 自证：写进去的必须能被我们自己读回来（结构对了才有意义）
  const reread = parsePngCard(png);
  if (reread.kind !== 'card') {
    throw new Error('PNG 产物自检失败：写进去的数据块读不回来');
  }
  if (reread.keyword !== keyword) {
    throw new Error(`PNG 产物自检失败：keyword 应为 ${keyword}，实际 ${reread.keyword}`);
  }
  if (reread.jsonText !== jsonText) {
    throw new Error('PNG 产物自检失败：读回的卡 JSON 与写入的不一致');
  }

  const summary = summarizePng(png);
  const faceSize =
    summary === null ? '' : `封面 ${String(summary.width)}×${String(summary.height)}`;

  return {
    format: 'png',
    fileName: `${safeName(card)}.png`,
    png,
    bytes: png.length,
    sha256: null,
    notes: [
      `${spec === 'v3' ? 'V3' : 'V2'} 卡写入 ${keyword} 数据块`,
      `${faceSize}（图像字节未重新编码）`,
      '旧 ccv3/chara 数据块已剥离，导出不会累积重复块',
      '缩进 2 空格 + 结尾换行，与 JSON 导出同一份序列化',
    ],
  };
}

/** 文件名剥离非法字符（Windows/macOS 取交集，保守处理） */
function safeName(card: UnifiedCard): string {
  const raw = (card.meta.name || 'character').trim();
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_');
  return cleaned === '' ? 'character' : cleaned.slice(0, 80);
}

function describeSeparator(separator: string): string {
  const visible = separator
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return visible.length === 0 ? '空行' : visible.join(' ');
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * sha256（十六进制）。
 *
 * 用 WebCrypto：Tauri 渲染层（Chromium）与 Node 20+ 都有 `crypto.subtle`。
 * 浏览器 Crypto API 只有异步版本，所以**导出产物统一走 async 入口**——
 * 不做"同步返回空哈希、之后再补"那种半成品设计，避免 UI 上出现 `sha256: (空)`。
 */
async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 二进制摘要。PNG 产物的 sha256 必须按**落盘字节**算，不能按文本 */
async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes); // 复制一份独立的 ArrayBuffer 视图，喂给 subtle
  const digest = await crypto.subtle.digest('SHA-256', view);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type ExportArtifactReady =
  | (ExportArtifactText & { sha256: string })
  | (ExportArtifactPng & { sha256: string });

/**
 * 导出入口（唯一）：文本 + 真实 sha256。
 *
 * 调用方拿到它就能：
 *   ① 把 `sha256` 传给 `writeFileAtomic(path, text, sha256)`，让壳写后回读校验；
 *   ② 与回执里的 `receipt.sha256` 比对，确认落盘内容与内存一致。
 */
export async function buildExportAsync(
  card: UnifiedCard,
  preset: TxtPreset | null,
  format: ExportFormat,
  greetingFormat?: GreetingFormatParams,
  faceBytes?: Uint8Array,
): Promise<ExportArtifactReady> {
  if (format === 'png') {
    if (faceBytes === undefined) {
      throw new Error('PNG 导出缺少卡面：请先在"卡面"步骤里选一张图');
    }
    const artifact = buildPngExport(card, preset, faceBytes, greetingFormat);
    return { ...artifact, sha256: await sha256Bytes(artifact.png) };
  }
  const artifact = buildExport(card, preset, format, greetingFormat);
  return { ...artifact, sha256: await sha256Hex(artifact.text) };
}
