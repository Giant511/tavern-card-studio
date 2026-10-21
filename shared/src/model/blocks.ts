/**
 * 六大板块定义（客户端分块编辑的核心枚举）。
 * 板块 id 是全局稳定标识：平台规则、高亮规则、审计报告中一律使用这些 id 引用板块。
 */

export const BLOCK_IDS = ['basic', 'personality', 'settings', 'special', 'user', 'worldbook'] as const;

export type BlockId = (typeof BLOCK_IDS)[number];

export interface BlockDefinition {
  id: BlockId;
  /** 中文显示名 */
  label: string;
  /** 该板块承载的内容说明（用于 UI 提示与文档） */
  description: string;
  /** 默认标题文案（TXT 预设格式可覆盖） */
  defaultHeading: string;
  /** 落盘到 SillyTavern JSON 时对应的字段（worldbook 为结构化板块，特殊处理） */
  stField: 'description' | 'personality' | 'character_book';
  /** 是否允许为空 */
  allowEmpty: boolean;
}

export const BLOCK_DEFINITIONS: readonly BlockDefinition[] = [
  {
    id: 'basic',
    label: '基本信息',
    description: '身高、体重、外貌穿搭、年龄、生日、身份等静态档案信息',
    defaultHeading: '基本信息',
    stField: 'description',
    allowEmpty: false,
  },
  {
    id: 'personality',
    label: '性格',
    description: '性格特质、情绪倾向、说话风格等',
    defaultHeading: '性格',
    stField: 'personality',
    allowEmpty: false,
  },
  {
    id: 'settings',
    label: '其他设定',
    description: '聊天输出格式、日常行为准则、语气要求等运行期约定',
    defaultHeading: '其他设定',
    stField: 'description',
    allowEmpty: true,
  },
  {
    id: 'special',
    label: '特殊设定',
    description: '剧情钩子、能力/限制、彩蛋、禁忌等特殊规则',
    defaultHeading: '特殊设定',
    stField: 'description',
    allowEmpty: true,
  },
  {
    id: 'user',
    label: '用户相关设定',
    description: '{{user}} 的身份、与角色的关系、称呼等',
    defaultHeading: '用户相关设定',
    stField: 'description',
    allowEmpty: true,
  },
  {
    id: 'worldbook',
    label: '世界书',
    description: '世界观条目（关键词触发），落盘为 character_book',
    defaultHeading: '世界书',
    stField: 'character_book',
    allowEmpty: true,
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
  (id) => BLOCK_DEFINITION_MAP[id].stField === 'description',
);
