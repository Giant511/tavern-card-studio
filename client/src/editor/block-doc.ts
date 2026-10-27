/**
 * 八板块文档模型（纯逻辑，无 DOM / 无 CodeMirror 依赖）。
 *
 * 这一层是可单测的：编辑 → 拼装 → 解析 → 再编辑 的 round-trip 就在这里验证。
 * UI 层（app.ts）只负责把这里的快照渲染成编辑器，不自己拼字符串。
 *
 * 与 shared 的分工：
 *   · 板块拆分/拼装、世界书 TXT 解析、ST 序列化 —— 全部复用 shared，本文件不重复实现；
 *   · 本文件只做「板块视图」到「UnifiedCard」的投影与回写。
 */

import {
  applyCardText,
  BLOCK_DEFINITIONS,
  BLOCK_DEFINITION_MAP,
  BLOCK_IDS,
  DEFAULT_WORLDBOOK_FORMAT,
  FIELD_BLOCK_IDS,
  isBlockId,
  parseWorldbookTextWith,
  renderWorldbookText,
  serializeStCard,
  setFieldBlockText,
  TEXT_BLOCK_IDS as SHARED_TEXT_BLOCK_IDS,
  type BlockId,
  type CardBlock,
  type GreetingFormatParams,
  type PreservedInfo,
  type TxtPreset,
  type UnifiedCard,
  type WorldbookFormatParams,
} from '@tcs/shared';

/**
 * 有纯文本编辑器的板块（除世界书 —— 它走结构化编辑器）。
 *
 * **从 shared 派生，不在客户端持有清单副本**（v0.1.3 / F6b 的教训）：
 * 加板块时若客户端还有一份副本，表现是"新板块在编辑器里根本不出现"，
 * 而且不报错 —— 只有对比 BLOCK_IDS 才发现少了两项。
 */
export const TEXT_BLOCK_IDS: readonly BlockId[] = SHARED_TEXT_BLOCK_IDS;

/** 文本板块的 id 类型（供内部窄化用） */
export type TextBlockId = Exclude<BlockId, 'worldbook'>;

/** 全部板块（含 worldbook），顺序即 UI 展示顺序 —— 直接就是 BLOCK_IDS */
export const EDITOR_BLOCK_IDS: readonly BlockId[] = BLOCK_IDS;

/**
 * 首屏默认展开的板块数（懒渲染红线）。
 *
 * **这个数必须保持 2，不能随板块总数变大**（v0.1.3 六→八板块时刻意不变）。
 * 理由：折叠即销毁编辑器（`collapse()` 会 `editor.destroy()` + 清空 host），
 * 所以这个数就是**常驻 CodeMirror 实例数**。从 2 涨到 4，长文本卡的首屏
 * 要多建两个 CM6 实例（每个都带 DOM 树、状态字段与扩展）—— 那是"加板块"
 * 顺手把启动成本翻倍，用户不会理解为什么升级后变卡。
 *
 * 新增的两个板块（对话示例 / 初始场景）落在 `BLOCK_IDS` 的第 6、7 位，
 * 于是天然在 `index < 2` 之外，默认折叠 —— 这是**结构保证**，不是运气：
 * 新板块只可能追加在中后部，`BLOCK_IDS` 的前两位固定是 basic 与 personality。
 */
export const DEFAULT_EXPANDED_COUNT = 2;

/**
 * 首屏应当展开的板块 id（纯函数，供 `reloadBlocksFromCard` 消费，也供单测钉死）。
 *
 * 抽成函数而不是内联 `index < 2` 的唯一原因：让"常驻实例数"这条红线
 * 能在 `npm test` 里被断言。写在 UI 方法里就只能靠浏览器端到端，
 * 而那条链路在 CI 上不一定跑。
 */
export function defaultExpandedBlockIds(blocks: readonly EditorBlockSnapshot[]): BlockId[] {
  return blocks.slice(0, DEFAULT_EXPANDED_COUNT).map((block) => block.id);
}

export interface EditorBlockSnapshot {
  id: BlockId;
  label: string;
  description: string;
  /** 编辑器里的文本（不含标题行） */
  text: string;
  /** 字符数（码点），用于卡片头部统计 */
  length: number;
  /** 空块：UI 需要显式提示，而不是看起来像坏了 */
  empty: boolean;
  /** 该块是否被标记为「原文缺失、按空处理」 */
  missing: boolean;
}

const DEFINITION_MAP = new Map(BLOCK_DEFINITIONS.map((def) => [def.id, def]));

function labelOf(id: BlockId): string {
  return DEFINITION_MAP.get(id)?.label ?? id;
}

function descriptionOf(id: BlockId): string {
  return DEFINITION_MAP.get(id)?.description ?? '';
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function findBlock(card: UnifiedCard, id: TextBlockId): CardBlock | undefined {
  return card.blocks.find((block) => block.id === id);
}

/** 把卡片投影成八板块快照（UI 的唯一数据源） */
export function collectBlocks(card: UnifiedCard): EditorBlockSnapshot[] {
  return EDITOR_BLOCK_IDS.map((id) => {
    const definition = BLOCK_DEFINITION_MAP[id];

    // 结构化板块（世界书）：走自己的路径，**不与文本块合并**。
    // 优先用 text；若为空但 entries 非空，按 entries 现场渲染（导入的卡可能是这种情况）。
    if (definition.kind === 'structured') {
      const section = card.worldbook;
      const text = section.text !== '' ? section.text : renderWorldbookText(section.entries ?? []);
      return {
        id,
        label: labelOf(id),
        description: descriptionOf(id),
        text,
        length: codePointLength(text),
        empty: text.trim() === '',
        missing: false,
      };
    }

    // 文本板块：description 分段、性格、以及两个字段板块（对话示例 / 初始场景）。
    // 它们都从 `card.blocks` 读文本 —— 字段板块的 text 是 residual 的视图
    // （权威在 residual，由 shared 的 field-blocks 维护同步）。
    const block = findBlock(card, id as TextBlockId);
    return {
      id,
      label: labelOf(id),
      description: descriptionOf(id),
      text: block?.text ?? '',
      length: codePointLength(block?.text ?? ''),
      empty: (block?.text ?? '').trim() === '',
      missing: block?.missing === true,
    };
  });
}

export interface SetBlockResult {
  card: UnifiedCard;
  /** 该块文本是否真的变化（UI 用它决定要不要重跑校验） */
  changed: boolean;
  /** 世界书解析出的问题（仅 worldbook 块可能非空） */
  worldbookIssues: Array<{ severity: 'error' | 'warning'; message: string; line?: number }>;
}

/**
 * 世界书文本 → 条目（唯一入口，v0.1.5 / G4）。
 *
 * `setBlockText`（用户编辑）与 `reparseWorldbook`（切换预设后重解析）都走这里，
 * 保证两条路对"解析失败要不要写回"的判断完全一致。
 *
 * @param markDirty 用户编辑为 true（置脏）；切换预设重解析为 false
 *   —— 文本没变，只是解析器换了，不该让标签出现"未保存修改"
 */
function applyWorldbookText(
  card: UnifiedCard,
  text: string,
  format: WorldbookFormatParams,
  markDirty: boolean,
): SetBlockResult {
  const parsed = parseWorldbookTextWith(text, format);
  const issues = parsed.issues.map((issue) => ({
    severity: issue.severity,
    message: issue.message,
    ...(issue.line === undefined ? {} : { line: issue.line }),
  }));

  const dirty = markDirty ? true : card.worldbook.dirty;

  if (!parsed.ok) {
    // 拒绝写回：entries 保持原样，仅记录文本（供 UI 显示用户正在编辑什么）
    return {
      card: { ...card, worldbook: { ...card.worldbook, text, dirty } },
      changed: true,
      worldbookIssues: issues,
    };
  }

  return {
    card: {
      ...card,
      worldbook: { ...card.worldbook, text, entries: parsed.entries, dirty },
    },
    changed: true,
    worldbookIssues: issues,
  };
}

/**
 * 切换世界书预设后重解析现有文本（v0.1.5 / G4）。
 *
 * 为什么必须做：文本没变但**解析器变了**。不重解析的话，用户在「世界书预设」
 * 里选中自己那份格式后，审计（按新预设）会说"没问题"，而 entries 还是旧的
 * 空数组 —— 正是"面板正常、导出丢内容"的错位来源。
 *
 * 文本为空时什么都不做（空世界书合法）。
 */
export function reparseWorldbook(card: UnifiedCard, format: WorldbookFormatParams): SetBlockResult {
  const text = card.worldbook.text;
  if (text.trim() === '') return { card, changed: false, worldbookIssues: [] };
  return applyWorldbookText(card, text, format, false);
}

/**
 * 把某个板块的文本写回卡片，返回**新卡片**（不就地改，便于撤销/对比）。
 *
 * 文本板块：设置 text + dirty，由 serializeStCard 在拼装时写回 description / personality。
 * 世界书块：解析 TXT → entries。**解析出 error 时拒绝写回**（保留上一次的 entries），
 *           避免「半截世界书」被当成删除全部条目。
 */
export function setBlockText(
  card: UnifiedCard,
  id: BlockId,
  text: string,
  /**
   * 世界书格式（v0.1.5 / G4，**必须传**）。
   *
   * 不传就退回默认 `@@ENTRY` 格式 —— 那正是线上缺陷：用户导入了
   * 「幻梦AI世界书格式」预设，审计也按它跑（面板不报错），但**这里的解析
   * 一直走默认格式**，于是 `【条目1：…】` 一条都认不出、entries 变空、
   * 导出丢内容。两处口径不一致，症状还互相掩盖。
   *
   * 参数可选只为兼容单测里的纯文本板块调用；世界书分支缺省时会用默认格式。
   */
  worldbookFormat?: WorldbookFormatParams,
): SetBlockResult {
  if (id === 'worldbook') {
    const previous = card.worldbook.text;
    if (previous === text) {
      return { card, changed: false, worldbookIssues: [] };
    }
    // 用**当前选中的世界书预设**解析，与审计、导入、导出同一份口径。
    // 缺省（未传）时退回冻结默认格式。
    return applyWorldbookText(card, text, worldbookFormat ?? DEFAULT_WORLDBOOK_FORMAT, true);
  }

  const blockId = id as TextBlockId;
  const existing = findBlock(card, blockId);
  if (!existing) {
    // 卡片里没有该块的登记项（理论上不会发生：parseStCard 会补齐空块）
    return { card, changed: false, worldbookIssues: [] };
  }
  if (existing.text === text) {
    return { card, changed: false, worldbookIssues: [] };
  }

  // 字段板块（对话示例 / 初始场景）走 shared 的实现：那里定义了"改过的板块要 dirty
  // 才回写 residual"这条语义。客户端自己再写一遍 setBlockText 等于两套口径 ——
  // 只要有一处忘了置 dirty，用户的编辑在导出时就会静默丢失。
  if (BLOCK_DEFINITION_MAP[blockId].kind === 'field-backed') {
    const result = setFieldBlockText(card, blockId, text);
    return { card: result.card, changed: result.changed, worldbookIssues: [] };
  }

  const blocks = card.blocks.map((block) =>
    block.id === blockId ? { ...block, text, dirty: true } : block,
  );
  return { card: { ...card, blocks }, changed: true, worldbookIssues: [] };
}

/**
 * 序列化为 SillyTavern JSON 文本。
 * 缩进固定 2 空格 + 结尾换行：与服务端/导出链路保持一致，避免 diff 噪声。
 *
 * T6.2 接入预设后，这里改为传 `presetAssembleOptions(preset)` 得到的 heading/order，
 * 让「编辑期视图」与「导出格式」共用同一套标题与顺序。
 */
export function serializeCard(card: UnifiedCard): string {
  const result = serializeStCard(card);
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** 全板块合计字数（按码点，给 UI 显示用；正式统计走审计报告） */
export function totalLength(blocks: readonly EditorBlockSnapshot[]): number {
  return blocks.reduce((sum, block) => sum + block.length, 0);
}

/**
 * 整卡 TXT 导入（复用 shared 的 applyCardText）。
 *
 * 放在这一层而不是 UI 里，原因有两个：
 *   · 导入结果会影响 worldbook 的 entries 合并，属于文档模型变更，必须可单测；
 *   · 宽松模式会产出 `missing` 标记，这个语义是面板要显示的，不能在上层临时拼。
 *
 * **全量保全默认开启**（v0.1.2 反馈项二，docs/06 §7）：无论认出几个板块，
 * 原文零丢失 —— 未识别部分整体进【其他设定】。因此这里不再有"被拒绝"的
 * 因缺板块路径；`card` 为 null 只剩世界书结构错误这一类。
 */
export function importCardText(
  card: UnifiedCard,
  text: string,
  preset: TxtPreset,
  mode: 'strict' | 'lenient' = 'lenient',
  greetingFormat?: GreetingFormatParams,
  /** 世界书格式（v0.1.5 / G4）：TXT 卡里的世界书段要按当前预设解析 */
  worldbookFormat?: WorldbookFormatParams,
): {
  card: UnifiedCard | null;
  issues: Array<{ code: string; message: string; line?: number }>;
  preserved: PreservedInfo | null;
} {
  const result = applyCardText(card, text, preset, {
    mode,
    preserveUnrecognized: true,
    ...(greetingFormat === undefined ? {} : { greetingFormat }),
    ...(worldbookFormat === undefined ? {} : { worldbookFormat }),
  });
  const issues = result.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    ...(issue.line === undefined ? {} : { line: issue.line }),
  }));
  if (!result.ok || !result.card) {
    return { card: null, issues, preserved: result.preserved };
  }
  return { card: result.card, issues, preserved: result.preserved };
}
