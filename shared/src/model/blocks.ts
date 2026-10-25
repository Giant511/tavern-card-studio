/**
 * 八大板块定义（客户端分块编辑的核心枚举）。
 * 板块 id 是全局稳定标识：平台规则、高亮规则、审计报告中一律使用这些 id 引用板块。
 *
 * ── v0.1.3 / F6 起从六板块扩到八板块 ──────────────────────────────
 *
 * 六板块里有四种是"description 的分段"（靠标题行切分），加上独立的 personality
 * 与结构化的世界书。新增的两块是**字段板块（field-backed）**：它们的内容有自己的
 * ST 字段，不拼进 description，也不需要标题行锚点 —— 这是 `kind` 存在的唯一理由。
 *
 * | 板块 | id | 承载的 ST 字段 |
 * |---|---|---|
 * | 对话示例 | `chat-examples` | `mes_example` |
 * | 初始场景 | `initial-scene` | `first_mes` + `alternate_greetings`（多条用分隔行） |
 *
 * 两条命名约束（都是踩过的坑）：
 *   1. 不用 `dialogue` 当 id —— 高亮方案里已有一个 scope 叫 `dialogue`（对话行配色），
 *      同名会让人分不清 `scope` 与 `block:` 指的是哪个。
 *   2. id 不能带点号 —— 板块 id 会被拼进 CSS 类名，含点号会让选择器永不匹配。
 */

/** 板块形态：决定"内容存在哪儿、怎么序列化" */
export type BlockKind =
  /** description 的一段（靠标题行切分、可带锚点做增量回写） */
  | 'description-segment'
  /** 独占 personality 字段 */
  | 'personality'
  /** 结构化（世界书条目），TXT 只是它的可编辑表示 */
  | 'structured'
  /** 独占（或共享）某个顶层 ST 字段，无标题行锚点 */
  | 'field-backed';

/** 板块承载的 ST 字段 */
export type BlockStField = 'description' | 'personality' | 'character_book' | 'first_mes' | 'mes_example';

export const BLOCK_IDS = [
  'basic',
  'personality',
  'settings',
  'special',
  'user',
  'chat-examples',
  'initial-scene',
  'worldbook',
] as const;

export type BlockId = (typeof BLOCK_IDS)[number];

export interface BlockDefinition {
  id: BlockId;
  /** 中文显示名 */
  label: string;
  /** 该板块承载的内容说明（用于 UI 提示与文档） */
  description: string;
  /** 默认标题文案（TXT 预设格式可覆盖） */
  defaultHeading: string;
  /** 主承载字段 */
  stField: BlockStField;
  /** 除主字段外还写入的字段（初始场景同时写 alternate_greetings） */
  alsoWrites?: readonly string[];
  /** 是否允许为空 */
  allowEmpty: boolean;
  kind: BlockKind;
}

export const BLOCK_DEFINITIONS: readonly BlockDefinition[] = [
  {
    id: 'basic',
    label: '基本信息',
    description: '身高、体重、外貌穿搭、年龄、生日、身份等静态档案信息',
    defaultHeading: '基本信息',
    stField: 'description',
    allowEmpty: false,
    kind: 'description-segment',
  },
  {
    id: 'personality',
    label: '性格',
    description: '性格特质、情绪倾向、说话风格等',
    defaultHeading: '性格',
    stField: 'personality',
    allowEmpty: false,
    kind: 'personality',
  },
  {
    id: 'settings',
    label: '其他设定',
    description: '聊天输出格式、日常行为准则、语气要求等运行期约定',
    defaultHeading: '其他设定',
    stField: 'description',
    allowEmpty: true,
    kind: 'description-segment',
  },
  {
    id: 'special',
    label: '特殊设定',
    description: '剧情钩子、能力/限制、彩蛋、禁忌等特殊规则',
    defaultHeading: '特殊设定',
    stField: 'description',
    allowEmpty: true,
    kind: 'description-segment',
  },
  {
    id: 'user',
    label: '用户相关设定',
    description: '{{user}} 的身份、与角色的关系、称呼等',
    defaultHeading: '用户相关设定',
    stField: 'description',
    allowEmpty: true,
    kind: 'description-segment',
  },
  {
    id: 'chat-examples',
    label: '对话示例',
    description: '示例对话（ST 的 mes_example）：用 <START> 分段示范说话风格与互动节奏',
    defaultHeading: '对话示例',
    stField: 'mes_example',
    allowEmpty: true,
    kind: 'field-backed',
  },
  {
    id: 'initial-scene',
    label: '初始场景',
    description: '开场白（ST 的 first_mes）；多条开场白之间用分隔行切分，导出为 alternate_greetings',
    defaultHeading: '初始场景',
    stField: 'first_mes',
    alsoWrites: ['alternate_greetings'],
    allowEmpty: true,
    kind: 'field-backed',
  },
  {
    id: 'worldbook',
    label: '世界书',
    description: '世界观条目（关键词触发），落盘为 character_book',
    defaultHeading: '世界书',
    stField: 'character_book',
    allowEmpty: true,
    kind: 'structured',
  },
];

export const BLOCK_DEFINITION_MAP: Readonly<Record<BlockId, BlockDefinition>> = Object.fromEntries(
  BLOCK_DEFINITIONS.map((definition) => [definition.id, definition]),
) as Record<BlockId, BlockDefinition>;

export function isBlockId(value: unknown): value is BlockId {
  return typeof value === 'string' && (BLOCK_IDS as readonly string[]).includes(value);
}

/** 写入 description 的板块（顺序即默认拼装顺序） */
export const DESCRIPTION_BLOCK_IDS: readonly BlockId[] = BLOCK_IDS.filter(
  (id) => BLOCK_DEFINITION_MAP[id].kind === 'description-segment',
);

/** 有纯文本编辑器的板块（除世界书 —— 它走结构化编辑器） */
export const TEXT_BLOCK_IDS: readonly BlockId[] = BLOCK_IDS.filter(
  (id) => BLOCK_DEFINITION_MAP[id].kind !== 'structured',
);

/** 字段板块（内容落在独立 ST 字段上，不参与 description 拼装） */
export const FIELD_BLOCK_IDS: readonly BlockId[] = BLOCK_IDS.filter(
  (id) => BLOCK_DEFINITION_MAP[id].kind === 'field-backed',
);

/**
 * 板块 id 的正则交替式，供选择器正则**派生**使用。
 *
 * 为什么要有它：`block:` 选择器在三个文件里各写了一份白名单正则
 * （`rules/scopes.ts`、`rules/platform-rule-parser.ts`、`rules/highlight-rule-parser.ts`），
 * 漏改一处的后果是**规则静默不生效且不报错** —— `parseSelector` 返回 null 后
 * `collectScopedTexts` 直接 `continue`，界面上看不出任何异常。
 * 现在三处都改成 `new RegExp('^block:(' + BLOCK_ID_ALTERNATION + ')$')`，加板块只需要动本文件。
 */
export const BLOCK_ID_ALTERNATION: string = BLOCK_IDS.join('|');
