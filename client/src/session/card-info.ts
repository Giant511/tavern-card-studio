/**
 * 卡片级信息（v0.1.6 / 用户反馈「导出后 creator_notes 还是示例卡的话」）。
 *
 * ## 它修的是什么
 *
 * 八个板块覆盖的是正文，但一张 ST 卡还有**一层元数据**：
 *
 * ```json
 * "creator": "…", "character_version": "…", "creator_notes": "…",
 * "system_prompt": "…", "post_history_instructions": "…", "tags": [...],
 * "character_book": { "name": "…", "description": "…" }
 * ```
 *
 * 这些字段在客户端里**一个编辑入口都没有**（`grep creatorNotes client/src` 零命中）。
 * 后果不是"导不出"，而是**导出的是别的东西**：用户从示例卡起手时，
 * `creator_notes` 一路带着「示例卡片，用于 round-trip 与规则联动测试。」，
 * `character_book.name` 带着示例里的「拾光书店」，而他没有任何办法改掉。
 *
 * 这与 F10 修角色名是同一类问题（当时注释写的是"顶栏只是个只读 div，
 * 用户永远改不到 meta.name"）—— 区别只是这次漏了六个字段而不止一个。
 *
 * ## 为什么是纯函数
 *
 * 这里的每个判断都要能被测试逐条钉住：字段怎么写回去、清空是"删键"还是"留空串"、
 * 标签怎么切、哪些值还在从示例卡继承。把它们放进对话框里就等于不可测。
 */

import type { StCharacterBook, UnifiedCard } from '@tcs/shared';

/**
 * 示例卡（`examples/cards/lin-wanzhao-v3.json`）里的创作说明原文。
 *
 * 只用于一条**提示**：如果当前卡的这个字段还等于它，说明用户是从示例卡起的
 * 且没改过。这不是判据（用户完全可能就是想写这句话），所以只提示、不阻断。
 *
 * ## 它为什么可以带着 "round-trip" 这种词
 *
 * 这是**示例卡文件里的原文**，不是我们写给用户看的界面文案。它的用途是
 * 拿"用户卡里的值"与"示例卡里的值"做相等比较 —— 一旦把常量改成干净的措辞，
 * 就再也对不上示例卡，提示静默失效。所以它必须逐字保留，
 * 并由此得出另一条约束：**提示条只列字段名，不把值贴出来**
 * （见 `card-info-dialog.ts` 的 `renderInheritedHint`）。
 *
 * 它必须与示例文件保持同步 —— `test/card-info.test.mjs` 里拿
 * `examples/cards/*.json` 逐字对拍，改示例卡会立刻红灯。
 */
export const SAMPLE_CREATOR_NOTES =
  '示例卡片，用于 round-trip 与规则联动测试。'; // ui-copy-allow: 数据，不是文案 —— 见下方说明

/** 示例卡里的其余"容易被继承却不该留"的值（同样只用于提示） */
const SAMPLE_VALUES = {
  creator: 'Tavern Card Studio',
  worldbookName: '拾光书店',
  worldbookDescription: '旧城区书店相关设定',
} as const;

/** 对话框里可编辑的那一层（**不含 name** —— 它在标题栏改，见下） */
export interface CardInfo {
  /**
   * 作者。写进 `data.creator`。
   *
   * 它不是"谁做的这张卡"，而是导出 JSON 的一个署名位；
   * ST 的卡片信息面板会显示它，所以留空比留个错的更干净。
   */
  creator: string;
  /** 角色版本。写进 `data.character_version`；与产品版本号无关 */
  characterVersion: string;
  /** 创作说明。写进 `data.creator_notes`，ST 里"作者备注"那一栏 */
  creatorNotes: string;
  /** 标签。写进 `data.tags`；ST 用它做筛选 */
  tags: string[];
  /** 系统提示。写进 `data.system_prompt`（卡级，覆盖预设的系统提示） */
  systemPrompt: string;
  /** 历史后指令。写进 `data.post_history_instructions`（插在历史之后、回复之前） */
  postHistoryInstructions: string;
  /** 世界书名称。写进 `data.character_book.name` */
  worldbookName: string;
  /** 世界书说明。写进 `data.character_book.description` */
  worldbookDescription: string;
}

/**
 * 从卡里读出这一层。
 *
 * **不读 `meta.name`**：名称在标题栏改（那里有重名校验与去重逻辑），
 * 放进这个对话框等于同一个字段有两个编辑器，两套规则迟早分叉。
 */
export function readCardInfo(card: UnifiedCard): CardInfo {
  const book = card.worldbook.raw;
  return {
    creator: card.meta.creator,
    characterVersion: card.meta.characterVersion,
    creatorNotes: card.meta.creatorNotes,
    tags: [...card.meta.tags],
    systemPrompt: card.residual.systemPrompt,
    postHistoryInstructions: card.residual.postHistoryInstructions,
    worldbookName: typeof book?.name === 'string' ? book.name : '',
    worldbookDescription: typeof book?.description === 'string' ? book.description : '',
  };
}

/**
 * 标签输入框的解析。用户会写 `日常, 治愈`、`日常、治愈`、`日常 治愈`（换行）——
 * 这三种都当分隔符。
 *
 * 去空、去重（保序）。**不排序**：标签顺序是用户的意思表示，替他排序属于
 * "自作主张改内容"，与本项目一贯口径一致。
 */
export function parseTagsInput(text: string): string[] {
  const parts = text.split(/[,，、\n\r\t]+/u).map((part) => part.trim());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (part === '') continue;
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out;
}

/** 标签回填到输入框（与 `parseTagsInput` 互为逆运算，用它写测试） */
export function formatTagsInput(tags: string[]): string {
  return tags.join('，');
}

/**
 * 归一化：所有字符串去首尾空白，标签走一遍 `parseTagsInput` 的去重。
 *
 * 为什么必须归一化而不是原样写回：`creator` 写成 `"  "` 会导出一个只有空格的作者名，
 * 在 ST 的卡片信息里显示为一个空白行 —— 看起来像渲染 bug，实际是数据脏。
 */
export function normalizeCardInfo(info: CardInfo): CardInfo {
  return {
    creator: info.creator.trim(),
    characterVersion: info.characterVersion.trim(),
    creatorNotes: info.creatorNotes.trim(),
    tags: parseTagsInput(info.tags.join('，')),
    systemPrompt: info.systemPrompt.trim(),
    postHistoryInstructions: info.postHistoryInstructions.trim(),
    worldbookName: info.worldbookName.trim(),
    worldbookDescription: info.worldbookDescription.trim(),
  };
}

/** 两份卡片信息是否等价（对话框据此判断"有没有改过"） */
export function sameCardInfo(a: CardInfo, b: CardInfo): boolean {
  const x = normalizeCardInfo(a);
  const y = normalizeCardInfo(b);
  return (
    x.creator === y.creator &&
    x.characterVersion === y.characterVersion &&
    x.creatorNotes === y.creatorNotes &&
    x.systemPrompt === y.systemPrompt &&
    x.postHistoryInstructions === y.postHistoryInstructions &&
    x.worldbookName === y.worldbookName &&
    x.worldbookDescription === y.worldbookDescription &&
    x.tags.length === y.tags.length &&
    x.tags.every((tag, index) => tag === y.tags[index])
  );
}

/**
 * 把这一层写回卡（**纯函数**，返回新对象，不改入参）。
 *
 * 两个细节值得单独说：
 *
 * 1. **清空 = 删键，不是留空串**。`character_book.name` 原本没有这个键时，
 *    用户没填就不该凭空多出一个 `"name": ""`（ST 会把它当"世界书有名字但为空"）。
 *    所以世界书那两个字段按"空则 delete"处理。
 * 2. **`character_book` 可能不存在**。世界书条目为空且原卡没有 `character_book` 时
 *    `raw` 是 null；此时只有用户真的填了名字/说明才建这个对象，否则保持 null
 *    （否则导出会多一个空壳 `character_book`，反向导入时又被当成"有世界书"）。
 */
export function applyCardInfo(card: UnifiedCard, rawInfo: CardInfo): UnifiedCard {
  const info = normalizeCardInfo(rawInfo);

  const next: UnifiedCard = {
    ...card,
    meta: {
      ...card.meta,
      creator: info.creator,
      characterVersion: info.characterVersion,
      creatorNotes: info.creatorNotes,
      tags: [...info.tags],
    },
    residual: {
      ...card.residual,
      systemPrompt: info.systemPrompt,
      postHistoryInstructions: info.postHistoryInstructions,
    },
  };

  const source = card.worldbook.raw;
  const blank = info.worldbookName === '' && info.worldbookDescription === '';
  /*
   * 原卡没有 character_book 且用户也没填 → **保持 null**。
   * 造一个 `{"entries": []}` 会让导出多一个空壳，反向导入时又被当成"这张卡有世界书"。
   */
  if (source === null && blank) return next;

  const book = writeBookKeys(source ?? { entries: [] }, info.worldbookName, info.worldbookDescription);
  return { ...next, worldbook: { ...card.worldbook, raw: book } };
}

/**
 * 写世界书那两个键。**空则删键**，不是留空串。
 *
 * 只有一个实现是刻意的：第一版拆成 `setBookKeys` + `clearBookKeys` 两个函数，
 * 结果"清空"那条测试只覆盖到后者，改坏前者测试也不会红（变异验证抓到了这件事）。
 * 两条路合并成一条 —— 空串与"没填"在这里是同一件事，本就不该有两套代码。
 */
function writeBookKeys(book: StCharacterBook, name: string, description: string): StCharacterBook {
  const next: StCharacterBook = { ...book, entries: book.entries };
  if (name === '') delete next.name;
  else next.name = name;
  if (description === '') delete next.description;
  else next.description = description;
  return next;
}

/** 一个字段"还停在示例卡的值上"的说明；空数组 = 没有可疑字段 */
export interface InheritedHint {
  /** 字段的中文名（直接给界面用） */
  label: string;
  /** 示例卡里的原值 */
  value: string;
}

/**
 * 找出"看起来还是从示例卡继承过来的"字段。
 *
 * **这是一条提示，不是判据**：用户完全可能就想用这个值。所以调用方只允许把它
 * 显示成 info 级说明，不许拿它拦保存、拦导出。
 *
 * 为什么值得做：这次现场就是"从示例卡起手 → 六个字段跟着走 → 用户没意识到"。
 * 光给编辑器还不够，得在打开时告诉他哪几个值不是他自己的。
 *
 * `character_version` 不参与——`1.0` 太通用，几乎每张卡都可能是它，提示了只会添噪。
 */
export function detectInheritedFields(info: CardInfo): InheritedHint[] {
  const hints: InheritedHint[] = [];
  if (info.creatorNotes === SAMPLE_CREATOR_NOTES) {
    hints.push({ label: '创作说明', value: SAMPLE_CREATOR_NOTES });
  }
  if (info.creator === SAMPLE_VALUES.creator) {
    hints.push({ label: '作者', value: SAMPLE_VALUES.creator });
  }
  if (info.worldbookName === SAMPLE_VALUES.worldbookName) {
    hints.push({ label: '世界书名称', value: SAMPLE_VALUES.worldbookName });
  }
  if (info.worldbookDescription === SAMPLE_VALUES.worldbookDescription) {
    hints.push({ label: '世界书说明', value: SAMPLE_VALUES.worldbookDescription });
  }
  return hints;
}

/**
 * 新建卡时套用的默认值（"用户可自定义"那一半）。
 *
 * 用户明确要求"最好是用户可以自定义"，两个含义都要满足：
 *   ① 已有的卡能改（上面的对话框）；
 *   ② **以后新建的卡不必每次重填** —— 把作者名这类稳定信息存成默认值。
 *
 * 只收"每张卡都一样的"字段。`worldbookName` / `worldbookDescription` 是内容、
 * 不属于"我的习惯"，收进来会让每张新卡都带着上一张的世界书名。
 */
export interface CardInfoDefaults {
  creator: string;
  characterVersion: string;
  creatorNotes: string;
  tags: string[];
  systemPrompt: string;
  postHistoryInstructions: string;
}

export const EMPTY_CARD_INFO_DEFAULTS: CardInfoDefaults = {
  creator: '',
  characterVersion: '',
  creatorNotes: '',
  tags: [],
  systemPrompt: '',
  postHistoryInstructions: '',
};

/** 从一份卡片信息里摘出可以当默认值的部分 */
export function toDefaults(info: CardInfo): CardInfoDefaults {
  const normalized = normalizeCardInfo(info);
  return {
    creator: normalized.creator,
    characterVersion: normalized.characterVersion,
    creatorNotes: normalized.creatorNotes,
    tags: [...normalized.tags],
    systemPrompt: normalized.systemPrompt,
    postHistoryInstructions: normalized.postHistoryInstructions,
  };
}

/**
 * 把"从磁盘读回来的"默认值清成合法形状。
 *
 * 为什么必须逐字段校验而不是 `as CardInfoDefaults`：这份值来自应用配置，
 * 可能被旧版本写过、也可能被人手工编辑过。一个 `tags: "日常"`（字符串而不是数组）
 * 就足以让"新建卡"直接抛异常 —— 而那条路径是用户最常用的入口，
 * 崩在这里等于整个客户端不能用。所以宁可当它没有，也不要带着它去 apply。
 */
export function sanitizeDefaults(stored: Partial<CardInfoDefaults> | null | undefined): CardInfoDefaults {
  if (stored === null || stored === undefined) return { ...EMPTY_CARD_INFO_DEFAULTS };
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const tags = Array.isArray(stored.tags)
    ? stored.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return {
    creator: str(stored.creator),
    characterVersion: str(stored.characterVersion),
    creatorNotes: str(stored.creatorNotes),
    tags,
    systemPrompt: str(stored.systemPrompt),
    postHistoryInstructions: str(stored.postHistoryInstructions),
  };
}

/**
 * 把默认值套到一张新卡上。`name` 与世界书字段保持新卡自己的值。
 *
 * 传 `null` / 缺字段都按空串处理：配置是从磁盘读的，可能来自旧版本或被人手改过，
 * 读不到不该让新建卡整条失败。
 */
export function applyDefaults(card: UnifiedCard, defaults: Partial<CardInfoDefaults> | null): UnifiedCard {
  if (defaults === null) return card;
  const info = readCardInfo(card);
  return applyCardInfo(card, {
    ...info,
    creator: typeof defaults.creator === 'string' ? defaults.creator : '',
    characterVersion: typeof defaults.characterVersion === 'string' ? defaults.characterVersion : '',
    creatorNotes: typeof defaults.creatorNotes === 'string' ? defaults.creatorNotes : '',
    tags: Array.isArray(defaults.tags) ? defaults.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    systemPrompt: typeof defaults.systemPrompt === 'string' ? defaults.systemPrompt : '',
    postHistoryInstructions:
      typeof defaults.postHistoryInstructions === 'string' ? defaults.postHistoryInstructions : '',
  });
}
