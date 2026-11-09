/**
 * 八大板块定义（客户端分块编辑的核心枚举）。
 * 板块 id 是全局稳定标识：平台规则、高亮规则、审计报告中一律使用这些 id 引用板块。
 *
 * ── 板块演进：六 → 八（v0.1.3）；v0.1.7 收尾：情景并入初始场景，**仍是八板块** ──
 *
 * ```text
 *   ✅ 板块总数仍是 8 个（用户 2026-11-09 用编辑器截图确认）
 *   ✅ scenario 不单独成板块，并入 initial-scene 的「@@情景」段
 *   ✅ chat-examples 保持独立（示例对话不重复出现在两处）
 * ```
 *
 * 用户原话「我编辑器里面的初始场景板块其实是包含三个字段的内容，一个就是开场白，
 * 一个就是情景，还有一个是示例对话」—— 其中"示例对话"由**独立的
 * `chat-examples` 板块**承载（编辑器里就是「对话示例」那一项）。
 * 所以「初始场景」内部实为**两段**：开场白、情景。
 *
 * 为什么不让示例对话也进初始场景：同一段内容两个编辑入口，
 * 改一处另一处不跟着变，是最难向用户解释的一类不一致。
 *
 * 复合段的序列化与解析在 `format/composite-scene.ts`（单一来源）。──
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
export type BlockStField =
  | 'description'
  | 'personality'
  | 'character_book'
  /* 初始场景是**复合板块**：主字段是 first_mes，另两个见 alsoWrites */
  | 'first_mes'
  /* 对话示例独占 mes_example */
  | 'mes_example';

/*
 * 顺序即 UI 展示顺序（也是 description 的默认拼装顺序，只对
 * `description-segment` 生效）。
 *
 * ★★★ 新板块只能追加在**前两位之后**（2026-11-08 新增 scenario 时确认）。
 *
 * `client/src/editor/block-doc.ts` 有一条红线：首屏默认展开的板块数恒为 2，
 * 而"哪些板块默认展开"是按本数组下标算的（`index < 2`）。前两位固定是
 * `basic` 与 `personality` —— 这是**结构保证**，不是运气。把新板块插到
 * 前两位会凭空多建两个 CodeMirror 实例（折叠即销毁，展开即实例）。
 *
 * `scenario` 放在 `initial-scene` 与 `worldbook` 之间：它与"场景/开场"
 * 同属叙事前置信息，索引 7，天然在懒渲染边界之外。
 */
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
    /*
     * ★★★ 复合板块（v0.1.7 收尾，2026-11-09 用户澄清）。
     *
     * 一个板块、两段内容、三个 ST 字段：
     *
     * ```text
     *   @@开场白      first_mes + alternate_greetings（多条用分隔行切）
     *   @@情景        scenario
     * ```
     *
     * 「示例对话」**不在这里** —— 它是独立的 `chat-examples` 板块。
     * 两处都给入口会让同一段内容有两个编辑点，改一处另一处不跟着变。
     *
     * 序列化/解析全部在 `format/composite-scene.ts`，本文件只管声明。
     *
     * ## 为什么 `alsoWrites` 里有两项
     *
     * `stField` 只能写一个（first_mes），但实际要写三个。
     * `alsoWrites` 的作用是**给"这个板块会碰哪些字段"一个可查的清单** ——
     * 导出、审计、迁移脚本据此判断"用户改了这块要回写什么"。
     */
    id: 'initial-scene',
    label: '初始场景',
    description:
      '两段合一：开场白（多条用分隔行切）· 情景。写进 ST 的 first_mes / alternate_greetings / scenario',
    defaultHeading: '初始场景',
    stField: 'first_mes',
    alsoWrites: ['alternate_greetings', 'scenario'],
    allowEmpty: true,
    kind: 'field-backed',
  },
  {
    id: 'worldbook',
    label: '世界书',
    description: '世界观条目（关键词触发），保存时写入角色卡的世界书字段',
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
