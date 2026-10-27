/**
 * 世界书 TXT 格式 v1.0（已冻结，规范见 docs/04-worldbook-txt-spec.md）。
 *
 * 冻结决策（三条）：
 * 1. 条目锚点是 `entry.id`；**TXT 中出现重复 id → 报错并给出行号，禁止静默合并**。
 * 2. 正文转义采用「方案 A」：写出时凡匹配 `/^\\*@@/` 的行首加一个 `\`，
 *    解析时凡匹配 `/^\\+@@/` 的行去掉第一个 `\`。因此字面 `\@@END 0` 会被写成 `\\@@END 0`，
 *    round-trip 严格无损（不会出现「字面 \@@ 被吃掉」的边界）。
 * 3. `extensions` 等非人读字段不进 TXT，靠 id 合并保留；**id 冲突时报错，不做猜测性归属**。
 *
 * 合并语义（T2.2 写死）：**导入时 TXT 是世界书的事实源**——
 * TXT 中不存在的条目即视为删除，TXT 中的条目覆盖 11 个可见字段，
 * 其余字段（extensions / 未知键）按 id 从原条目挂回。
 */

import type { StWorldbookEntry } from '../model/sillytavern.js';
import {
  DEFAULT_WORLDBOOK_FORMAT,
  labelForField,
  reverseLabelMap,
  WORLDBOOK_KNOWN_FIELDS,
  type WorldbookFormatParams,
} from './worldbook-preset.js';

/** 会出现在 TXT 头部中的字段（v1.0 写出顺序；实际顺序由格式预设的 fieldOrder 决定） */
export const WORLDBOOK_HEADER_ORDER = [
  'name',
  'keys',
  'secondary_keys',
  'constant',
  'enabled',
  'insertion_order',
  'position',
  'priority',
  'case_sensitive',
  'selective',
  'comment',
] as const;

/** 参与「TXT 覆盖原条目」的可见字段（含正文；id 是锚点不参与覆盖） */
export const WORLDBOOK_VISIBLE_KEYS = [...WORLDBOOK_HEADER_ORDER, 'content'] as const;

const BOOL_FIELDS = new Set<string>(['constant', 'enabled', 'case_sensitive', 'selective']);
const NUMBER_FIELDS = new Set<string>(['insertion_order', 'priority']);
const LIST_FIELDS = new Set<string>(['keys', 'secondary_keys']);
/** 行首可能有 0 个或多个反斜杠，紧跟 `@@`：写出/解析的统一判定式 */
const ESCAPE_TARGET = /^\\*@@/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 标记模板 → 整行正则。`{id}` 处匹配非空白串，其余部分按字面。
 *
 * 空白规则看**模板本身**：
 *   · `@@ENTRY {id}`（占位符前有空格）→ 要求至少一个空白，`@@ENTRY0` 不算条目；
 *   · `条目{id}：`（占位符紧贴文字）→ 允许零个空白，中文格式里"条目4："才是常态。
 *
 * 写死 `[ \t]+` 会让所有中文风格的开标记都必须写成"条目 4："，
 * 而用户的文件从来不是那样写的。
 */
/**
 * 条目标记（`@@ENTRY {id}` / `【条目{id}：`）→ 正则。
 *
 * ## 为什么允许"标记行内还有内容"（v0.1.5 / G4）
 *
 * 用户实测的自定义预设 `entryOpen: "【条目{id}："`，而他的世界书写的是
 * `【条目1：西奥核心关系逻辑】` —— 编号与名称在**同一行**。旧实现要求标记
 * **独占整行**（`$` 锚定），于是这种"最自然的写法"一条都匹配不上，
 * 整份 2300 字解析成 0 条。
 *
 * 现在：`{id}` 之后到行尾的剩余内容会被捕获（第 2 组），由调用方当作条目名。
 * **只在模板带闭合部分时启用**（`suffix` 非空）—— 默认格式 `@@ENTRY {id}`
 * 的 suffix 是空，保持严格整行，避免把 `@@ENTRY 0 keys: a` 这种写错的
 * 行悄悄吞掉。
 */
function markerPattern(template: string): RegExp {
  const at = template.indexOf('{id}');
  const prefixRaw = at < 0 ? template : template.slice(0, at);
  const suffix = at < 0 ? '' : template.slice(at + 4);
  const requiresSpace = /\s$/.test(prefixRaw);
  const prefix = prefixRaw.trimEnd();
  const gap = requiresSpace ? '[ \\t]+' : '[ \\t]*';
  const prefixPattern = `^${escapeRegExp(prefix)}${gap}`;
  const suffixPattern = escapeRegExp(suffix);
  // 模板有闭合部分（如 `：` `】` `>`）⇒ 允许行内剩余；否则严格整行
  if (suffix.trim() !== '') {
    return new RegExp(`${prefixPattern}(\\S+?)${suffixPattern}(.*)$`);
  }
  return new RegExp(`${prefixPattern}(\\S+)${suffixPattern}[ \\t]*$`);
}

/**
 * 条目名清洗：去掉行内剩余里"包裹性"的首尾符号。
 *
 * ## 两类剥离，各自一条规则（v0.1.5 / G7 修正）
 *
 * 1. **整体成对**：`「名字」`、`【名字】`、`《名字》` —— 首尾是同一对符号，
 *    两边一起去；
 * 2. **孤立单侧**：`名字】`（前面没有 `【`）、`「名字`（后面没有 `」`）——
 *    只去孤立的那一侧。
 *
 * ## 旧实现为什么漏（用户实测的样本）
 *
 * 剩余是 `「西奥核心关系逻辑」】` —— 尾部的 `】` 是 entryOpen 模板的收尾符，
 * 名字本身又用 `「」` 包了一层。旧代码的成对分支带了个
 * `!text.includes(close)` 前提（本意是"别碰成对的"），于是：
 * 剥掉孤立 `】` 之后拿到 `「西奥核心关系逻辑」`，但那对引号**首尾成对**，
 * 被这个前提挡住，永远剥不掉 —— 名字里留着两个引号。
 *
 * 现在把两类拆成独立规则，每轮只做一次、循环到稳定（`【【名字】】` 这种
 * 多层包裹也能去干净）。判据仍然是"**边界**上的符号"，所以
 * `设定（草稿）` 里那对括号（不在边界）不会被碰。
 */
const NAME_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['【', '】'],
  ['[', ']'],
  ['（', '）'],
  ['(', ')'],
  ['《', '》'],
  ['「', '」'],
  ['『', '』'],
];

function cleanInlineName(raw: string): string {
  let text = raw.trim();
  const countOf = (haystack: string, needle: string): number => {
    let total = 0;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      total += 1;
    }
    return total;
  };

  /*
   * 上限 6 轮：每次至少去掉一个字符，而真实名字不会这么长地层层包裹。
   * 设上限是为了万一规则之间有来回（去完首符又露出尾符）也不死循环。
   */
  for (let round = 0; round < 6; round += 1) {
    let changed = false;

    // 规则 1：整体被同一对符号包住 → 两边一起去
    for (const [open, close] of NAME_PAIRS) {
      if (
        text.length > open.length + close.length &&
        text.startsWith(open) &&
        text.endsWith(close)
      ) {
        text = text.slice(open.length, text.length - close.length).trim();
        changed = true;
        break;
      }
    }
    if (changed) continue;

    /*
     * 规则 2：尾符比开符多 ⇒ 末尾那个是**孤立**的，去掉一个。
     *
     * 判据用**计数不平衡**而不是"全文不含开符"，因为名字内部可能合法地
     * 含有一对括号：`甲【乙】丙】` 里 `【】` 是名字的一部分，末尾那个 `】`
     * 是标题自己的收尾符 —— "不含开符"会放它过去，计数不平衡才能认出来。
     * 反过来 `前（后）` 计数平衡，括号一个都不动。
     */
    for (const [open, close] of NAME_PAIRS) {
      if (text.endsWith(close) && countOf(text, close) > countOf(text, open)) {
        text = text.slice(0, -close.length).trimEnd();
        changed = true;
        break;
      }
    }
    if (changed) continue;

    // 规则 3：首符比闭符多 ⇒ 开头那个是孤立的，去掉一个
    for (const [open, close] of NAME_PAIRS) {
      if (text.startsWith(open) && countOf(text, open) > countOf(text, close)) {
        text = text.slice(open.length).trimStart();
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return text.trim();
}

/** 无 `{id}` 的标记（正文标记）→ 整行正则 */
/**
 * 正文标记（`@@CONTENT` / `内容：`）→ 正则。
 *
 * ## 为什么捕获行内剩余（v0.1.5 / G4）
 *
 * 用户那份世界书写的是 `内容：{{char}}与{{user}}…` —— 正文**紧跟标记在同一行**。
 * 旧实现要求标记独占整行（`^内容：[ \t]*$`），于是这类行落到"未知字段"
 * 分支（`内容` 不是已知字段）被丢弃，正文一个字都进不来。
 *
 * 现在捕获剩余部分作为正文第一行（第 1 组）。剩下的是常见写法差异，
 * 不是错误。
 */
function contentMarkPattern(mark: string): RegExp {
  return new RegExp(`^${escapeRegExp(mark.trimEnd())}(.*)$`);
}

interface CompiledFormat {
  entryStart: RegExp;
  contentMark: RegExp;
  /**
   * 闭标记正则。**`null` = 隐式闭合模式**（v0.1.5 / G4）。
   *
   * 预设里把 `entryClose` 省略（或写成空串）时进入这个模式：
   * 条目边界由**下一个开标记或文件结束**确定，不要求显式结束行。
   *
   * 为什么需要：`@@ENTRY` / `@@END` 是 ST 生态的成对标记，但"标题式"格式
   * （`【条目1：名字】` + 字段行 + 正文）天然没有结束标记 —— 用户那份预设
   * 声明了 `entryClose: "条目{id}结束"`，而他的 2000 多字里一处都没写这个。
   * 旧实现会因此对**每个条目**报 `missing-end` error ⇒ `ok=false` ⇒ 拒绝写回
   * entries ⇒ 导出丢失。而条目边界其实由开标记唯一确定，闭标记是冗余的。
   */
  entryEnd: RegExp | null;
  labels: Map<string, string>;
  fieldCore: string;
}

/** 预编译一次，避免在逐行循环里反复构造正则与反查表 */
function compileFormat(params: WorldbookFormatParams): CompiledFormat {
  const core = params.fieldSeparator.trim() === '' ? ':' : params.fieldSeparator.trim();
  const closeTemplate = typeof params.entryClose === 'string' ? params.entryClose.trim() : '';
  return {
    entryStart: markerPattern(params.entryOpen),
    contentMark: contentMarkPattern(params.contentMark),
    // 空串 ⇒ 隐式闭合（不生成正则）。`markerPattern('')` 会退化成"任意单词行"，
    // 那会把每一行正文都当闭标记，所以必须显式挡掉。
    entryEnd: closeTemplate === '' ? null : markerPattern(closeTemplate),
    labels: reverseLabelMap(params),
    fieldCore: core,
  };
}


export type WorldbookIssueCode =
  | 'invalid-id'
  | 'duplicate-id'
  | 'missing-content'
  | 'missing-end'
  | 'mismatched-end'
  | 'orphan-marker'
  | 'unknown-field'
  | 'bad-value'
  | 'unexpected-line'
  | 'leading-text'
  /**
   * 文本非空、但全文**一个条目标记都没有**（v0.1.5 / G3-2，红线级）。
   *
   * 这是"整段格式不对"的信号，必须报 error 而不是 warning —— 因为 `ok=false`
   * 才会让 `setBlockText` 拒绝写回 `entries`。否则会出现最糟的静默丢数据：
   * 用户把别处格式的世界书（如 `【条目1：…】` + `内容：…`）粘进面板 →
   * 解析出 0 条、但只有 leading-text 一条 warning → `ok=true` →
   * **原有 entries 被写回成空数组** → 导出 JSON 的 character_book 变空。
   */
  | 'no-entry-marker'
  /**
   * 预设声明了闭标记，但整份文本一次都没用到 → 已按隐式闭合解析（v0.1.5 / G4）。
   *
   * 是 **warning 不是 error**：条目边界由开标记唯一确定，闭标记冗余；
   * 但用户应该知道"我预设里写的结束行其实没生效"，否则下次还以为它在起作用。
   */
  | 'implicit-close'
  // 注意：没有 'no-keys' —— 见 closeDraft 里的注释（语义判据归规则集）
  ;

export interface WorldbookParseIssue {
  severity: 'error' | 'warning';
  code: WorldbookIssueCode;
  message: string;
  /** 1-based 行号 */
  line?: number;
  entryId?: number;
}

export interface ParseWorldbookResult {
  entries: StWorldbookEntry[];
  issues: WorldbookParseIssue[];
  /** 是否存在 error 级问题；存在时禁止调用 mergeWorldbookEntries（残缺条目会被判为删除） */
  ok: boolean;
}

export interface MergeWorldbookOptions {
  /**
   * TXT 中不存在的原条目是否删除；默认 true（TXT 为事实源）。
   * 置 false 时，原表多余条目按原顺序追加到结果末尾。
   */
  dropMissing?: boolean;
}

export interface MergeWorldbookResult {
  entries: StWorldbookEntry[];
  /** TXT 中有、原表中没有的 id（新增条目） */
  added: number[];
  /** 原表有、TXT 中删除的 id（按 TXT 事实源删除，必须让用户可见） */
  removed: number[];
  /** 机器字段（extensions / 未知键）按 id 挂回成功的条目 id */
  preserved: number[];
}

// ---------------------------------------------------------------- 工具

/** 按行拆分但**保留行尾换行符**，用于正文逐字节还原（CRLF 也能原样回来） */
function splitKeepEol(text: string): string[] {
  if (text === '') return [];
  return text.split(/(?<=\n)/);
}

function splitLineEol(line: string): { content: string; eol: string } {
  if (line.endsWith('\r\n')) return { content: line.slice(0, -2), eol: '\r\n' };
  if (line.endsWith('\n')) return { content: line.slice(0, -1), eol: '\n' };
  return { content: line, eol: '' };
}

/** 写出：行首 `@@` / `\@@` / `\\@@` …… 一律再加一个反斜杠 */
export function escapeContentLine(line: string): string {
  return ESCAPE_TARGET.test(line) ? `\\${line}` : line;
}

/** 解析：行首 `\@@` / `\\@@` …… 去掉第一个反斜杠 */
export function unescapeContentLine(line: string): string {
  return ESCAPE_TARGET.test(line) && line.startsWith('\\') ? line.slice(1) : line;
}

/**
 * 列表字段写出。`separator` 允许数组（v0.1.5 / G3-2），但**只用第一个**：
 * 输出格式必须唯一，否则同一份数据每次导出都不一样，diff 里全是噪声。
 *
 * `join` 用的是**原始**分隔符（不 trim）：默认值 `", "` 要写出 `成人, 性`，
 * 而不是 `成人,性`。第一版我在这里用了 normalize 后的（trim 过的）串，
 * 输出悄悄少了一个空格 —— 这属于"看起来无所谓、但会让所有既有卡片的
 * 导出字节变化"，靠 round-trip 测试才抓回来。
 * `needle`（判"值里含分隔符就要加引号"）仍用 trim 后的形式，因为
 * `"a, b"` 里含 `","` 才是需要转义的事实。
 */
function formatCsvList(items: readonly string[], separator: string | readonly string[]): string {
  const first = Array.isArray(separator) ? separator[0] : (separator as string);
  const joinWith = typeof first === 'string' && first !== '' ? first : ', ';
  const needle = joinWith.trim() === '' ? joinWith : joinWith.trim();
  return items
    .map((item) => (item.includes(needle) || item.includes('"') ? `"${item.split('"').join('\\"')}"` : item))
    .join(joinWith);
}

/**
 * 把 `listSeparator` 规范化成"按长度降序"的分隔符数组（v0.1.5 / G3-2）。
 *
 * 为什么要降序：`[", ", ","]` 里如果先试 `","`，`"a, b"` 会被切成 `"a"` 和
 * `" b"`（多一个前导空格）；先试 `", "` 才是对的。长的优先 = 最具体的优先。
 *
 * 空串 **不** 当作分隔符（否则每个字符边界都成了分隔点，见 `parseCsvList` 的
 * `sepLength = Math.max(1, sep.length)` 兜底）：空串会被过滤掉，全空时回退到 `[',']`。
 */
function normalizeListSeparators(separator: string | readonly string[]): string[] {
  const raw = Array.isArray(separator) ? separator : [separator as string];
  const cleaned = raw
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item !== '');
  if (cleaned.length === 0) return [','];
  // 去重后按长度降序（同长度保持原序，保证确定性）
  return [...new Set(cleaned)].sort((left, right) => right.length - left.length);
}

/**
 * 列表字段解析。
 *
 * 分隔符可配置（`listSeparator`，支持多分隔符），但**引号与转义规则固定** ——
 * 那是 CSV 的语法，不是格式偏好：允许用户把分隔符改成 `、` 却又要自己发明转义规则，
 * 只会让文件不可移植。
 *
 * ## 两层容错（v0.1.5 / G4）
 *
 * 用户那份预设声明 `listSeparator: "，"`（全角逗号），但他的关键词行混用了
 * `成人、性、做爱`（顿号）与 `潮吹,射精`（半角逗号）—— 只按 `，` 切，
 * 整行会变成**一个**关键词（`keys` 长度 1 而非 5）。
 *
 * 处理方式是**两阶段**，而不是直接把所有逗号类标点都当分隔符：
 *   1. 先按预设声明切；
 *   2. **只有当结果只有一项**、且这一项里含其它常见分隔符时，才放宽重切。
 *
 * 为什么不直接并集：`"a、b"` 作为**一个**关键词（顿号在词内）时，并集会把它
 * 误切成两个。两阶段只在"按原规则完全切不开"时才放宽，误伤面小得多。
 */
const FALLBACK_LIST_SEPARATORS: readonly string[] = [',', '、', '，'];

/** 按给定分隔符集合切分（引号与转义规则固定） */
function splitCsvList(value: string, separators: readonly string[]): string[] {
  const items: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) {
      if (char === '\\' && value[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      if (char === '"') {
        quoted = false;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    // 长分隔符优先：逐个试，命中即切
    const matched = separators.find((candidate) => value.startsWith(candidate, index));
    if (matched !== undefined) {
      items.push(current.trim());
      current = '';
      index += matched.length - 1;
      continue;
    }
    current += char;
  }
  items.push(current.trim());
  return items;
}

function parseCsvList(
  value: string,
  separator: string | readonly string[],
  lenient: boolean,
): string[] {
  if (value.trim() === '') return [];
  const separators = normalizeListSeparators(separator);
  const items = splitCsvList(value, separators);
  if (items.length > 1) return items;

  /*
   * 阶段 2 只在**自定义预设**下开（v0.1.5 / G4 修正）。
   *
   * 内置格式的 `keys: 成人、性` 是**一个**含顿号的关键词（顿号在词内是合法的，
   * 比如书名、人名并列）。无条件放宽会把它切成两个 —— 于是"导出再导入"
   * 会悄悄改变关键词集合。这正是既有测试 `before.entries[0].keys.length === 1`
   * 守着的行为，不能为了兼容外部格式去动它。
   */
  if (!lenient) return items;

  const extra = FALLBACK_LIST_SEPARATORS.filter((candidate) => !separators.includes(candidate));
  if (extra.length === 0) return items;
  const widened = [...new Set([...separators, ...extra])].sort(
    (left, right) => right.length - left.length,
  );
  const retried = splitCsvList(value, widened);
  return retried.length > items.length ? retried : items;
}


function formatPosition(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 0) return 'before_char';
    if (value === 1) return 'after_char';
    return String(value);
  }
  return null;
}

function parsePosition(value: string): number | string | null {
  const text = value.trim();
  if (text === '') return null;
  if (text === 'before_char') return text;
  if (text === 'after_char') return text;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : text;
}

/**
 * 布尔字段的取值识别。
 *
 * ## 为什么加中文（v0.1.5 / G7）
 *
 * 用户的中文格式预设把字段标签改成了中文（`常驻：是`），解析器却只认
 * `true/1/yes/on` —— 于是"常驻"这条**永远读不进来**，条目一律按 `constant: false`
 * 处理，接着"非常驻却无关键词"这类规则对持续型条目全线误报（实测 29 条）。
 *
 * 新增 `是` / `否`（大小写不敏感对中文无意义，但对混写无害）。
 *
 * ## 刻意**不**认的写法
 *
 * `真/假`、`对/错`、`√/×`、`有/无` 都不认 —— 需求明确了"不得猜"。
 * 猜错的代价比报错大得多：`常驻：假` 若被当成 true，条目会变成常驻，
 * 而用户以为它是关键词条目。认不出就走 `bad-value` warning 并保持字段缺省。
 *
 * `yes/no/on/off` 是早期就支持的英文同义词，保留（删掉会让已写好的文件坏掉）。
 */
function parseBool(value: string): boolean | null {
  const text = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on', '是'].includes(text)) return true;
  if (['false', '0', 'no', 'off', '否'].includes(text)) return false;
  return null;
}

/** 布尔字段的可写值提示（只在报错时用到，不参与解析） */
export const BOOL_VALUE_HINT = '是/否、true/false、1/0';

/** 补 id：缺失或非数字时按「当前已用编号 +1」补齐，返回新数组（不改动入参） */
/**
 * 世界书条目的「显示名」在 ST 里叫 `comment`，我们自己叫 `name` ——
 * 这里放两者的桥，**只在一处实现**。
 *
 * ## 为什么必须有这座桥（2026-10-27 用户报「条目名字反而缺失了」）
 *
 * ST 的前端导入 `character_book` 时是这么读的（`public/scripts/world-info.js`）：
 *
 * ```js
 * comment: entry.comment || '',
 * addMemo: !!entry.comment,
 * ```
 *
 * 也就是说 **ST 只认 `comment`，完全不读 `name`**，连"有备注"的开关
 * `addMemo` 也是按 `comment` 判的。而我们的 TXT 格式把「条目显示名」写成 `name`
 * （docs/04 §3.2 第 1 个字段）—— 于是从我们的 TXT 起手、导出成卡、再导进 ST，
 * 条目标题**整片空白**：数据在，只是写在 ST 不看的那一格。
 *
 * 用户的原话是"我们给的这套自定义的设计里面应该是可以让用户导入的自定义设置
 * 对应上标准 ST 的各个字段"—— 说的就是这件事：自定义字段名必须能落到 ST 的字段上。
 *
 * ## 为什么是单向补齐，而不是两个方向都改
 *
 * - **写出到 ST 时**：`comment` 为空而 `name` 有值 → 用 `name` 补上 `comment`。
 * - **从 ST 读入时**：**不动**。ST 的卡里本来就只有 `comment`；
 *   我们在读入时凭空加一个 `name`，会让「原样再导出」的字节发生变化，
 *   破坏 round-trip 无损这个已有的硬约束（`exportWorldbook` 的 verbatim 分支依赖它）。
 *
 * 补齐后的条目同时带着 `name` 与 `comment`，再导出是稳定的 —— 不会每导一次多一个键。
 */
export function stEntryTitle(entry: StWorldbookEntry): string {
  const comment = typeof entry.comment === 'string' ? entry.comment.trim() : '';
  if (comment !== '') return entry.comment as string;
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  return name === '' ? '' : (entry.name as string);
}

/**
 * 给一条条目补上 ST 认的 `comment`（有值则原样返回同一个对象引用）。
 *
 * 返回原引用是有意的：调用方常常要判断"有没有改过"，
 * 用引用相等比逐字段比对更便宜，也不会因为克隆把 `extensions` 之类的嵌套弄坏。
 */
export function withStEntryComment(entry: StWorldbookEntry): StWorldbookEntry {
  const comment = typeof entry.comment === 'string' ? entry.comment.trim() : '';
  if (comment !== '') return entry;
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (name === '') return entry;
  return { ...entry, comment: entry.name };
}

/** 批量版本（导出到 ST 的每条路径都用它，免得漏一处） */
export function withStEntryComments(entries: readonly StWorldbookEntry[]): StWorldbookEntry[] {
  return entries.map((entry) => withStEntryComment(entry));
}

export function ensureEntryIds(entries: readonly StWorldbookEntry[]): {
  entries: StWorldbookEntry[];
  changed: boolean;
} {
  const used = new Set<number>();
  for (const entry of entries) {
    if (typeof entry.id === 'number' && Number.isFinite(entry.id)) used.add(entry.id);
  }
  let next = 0;
  let changed = false;
  const result = entries.map((entry) => {
    if (typeof entry.id === 'number' && Number.isFinite(entry.id)) return entry;
    while (used.has(next)) next += 1;
    used.add(next);
    changed = true;
    return { ...entry, id: next };
  });
  return { entries: result, changed };
}

// ---------------------------------------------------------------- 写出

/** 头部行：空值时不留尾随空格（`secondary_keys:` 而不是 `secondary_keys: `） */
function header(label: string, value: string, fieldSeparator: string): string {
  // v1.0 的 fieldSeparator 是 ": "，空值时要退化成 ":"（不含尾随空格）。
  // 所以空值取 separator 去掉尾部空白后的形态，而不是直接拼 separator。
  return value === '' ? `${label}${fieldSeparator.trimEnd()}` : `${label}${fieldSeparator}${value}`;
}

function renderEntry(entry: StWorldbookEntry, index: number, params: WorldbookFormatParams): string {
  const id = typeof entry.id === 'number' && Number.isFinite(entry.id) ? entry.id : index;
  const idText = String(id);
  const lines: string[] = [params.entryOpen.split('{id}').join(idText)];

  for (const key of params.fieldOrder) {
    const value = (entry as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    const label = labelForField(params, key);
    if (LIST_FIELDS.has(key)) {
      if (Array.isArray(value)) {
        lines.push(header(label, formatCsvList(value.filter((item): item is string => typeof item === 'string'), params.listSeparator), params.fieldSeparator));
      }
      continue;
    }
    if (BOOL_FIELDS.has(key)) {
      if (typeof value === 'boolean') lines.push(header(label, value ? 'true' : 'false', params.fieldSeparator));
      continue;
    }
    if (NUMBER_FIELDS.has(key)) {
      if (typeof value === 'number' && Number.isFinite(value)) lines.push(header(label, String(value), params.fieldSeparator));
      continue;
    }
    if (key === 'position') {
      const text = formatPosition(value);
      if (text !== null) lines.push(header(label, text, params.fieldSeparator));
      continue;
    }
    if (typeof value === 'string') lines.push(header(label, value, params.fieldSeparator));
  }

  const content = typeof entry.content === 'string' ? entry.content : '';
  const close = params.entryClose.split('{id}').join(idText);
  if (content === '') return `${lines.join('\n')}\n${params.contentMark}\n${close}`;

  let body = '';
  for (const rawLine of splitKeepEol(content)) {
    const { content: text, eol } = splitLineEol(rawLine);
    body += `${escapeContentLine(text)}${eol}`;
  }
  // 正文与闭标记之间固定补一个换行（解析端正好去掉这一个），
  // 因此正文自带尾换行时会写成「空行 + 闭标记」，逐字节可还原。
  return `${lines.join('\n')}\n${params.contentMark}\n${body}\n${close}`;
}

/** entries → 世界书 TXT（按格式预设；空数组返回空串） */
export function renderWorldbookTextWith(
  entries: readonly StWorldbookEntry[],
  params: WorldbookFormatParams,
): string {
  if (entries.length === 0) return '';
  const { entries: normalized } = ensureEntryIds(entries);
  return normalized.map((entry, index) => renderEntry(entry, index, params)).join(params.entrySeparator);
}

/** entries → 世界书 TXT（v1.0 冻结格式）。空数组返回空串。 */
export function renderWorldbookText(entries: readonly StWorldbookEntry[]): string {
  return renderWorldbookTextWith(entries, DEFAULT_WORLDBOOK_FORMAT);
}


// ---------------------------------------------------------------- 解析

interface DraftEntry {
  id: number;
  line: number;
  fields: Record<string, unknown>;
  sawContent: boolean;
  bodyRaw: string[];
}

/**
 * 字段行 → `{ field, value }`。
 *
 * `field` 为 null 表示标签不认识（调用方据此报 unknown-field）。
 * 反解顺序：**先按预设的标签映射**，再按字段名本身 —— 这样自定义预设既可以
 * 把 `keys` 写成「关键词」，也可以不改标签直接沿用字段名。
 */
function parseFieldLine(
  line: string,
  fmt: CompiledFormat,
): { field: string | null; label: string; value: string } | null {
  const at = line.indexOf(fmt.fieldCore);
  if (at <= 0) return null;
  const label = line.slice(0, at).trim();
  if (label === '') return null;
  let value = line.slice(at + fmt.fieldCore.length);
  // 与 v1.0 的 `[ \t]?` 一致：吃掉紧跟的一个空白字符，多的留给值本身
  if (value.startsWith(' ') || value.startsWith('\t')) value = value.slice(1);
  const mapped = fmt.labels.get(label);
  const field =
    mapped ?? ((WORLDBOOK_KNOWN_FIELDS as readonly string[]).includes(label) ? label : null);
  return { field, label, value };
}

/**
 * 是否是**内置默认格式**（本工具自己的规范写法）。
 *
 * ## 为什么需要这个判定（v0.1.5 / G4）
 *
 * 宽容策略分两档，不能一刀切：
 *
 * · **内置默认格式 = 规范**：`@@ENTRY 0` / `@@CONTENT` / `@@END 0` 是本工具
 *   自己写出去的格式。文本不合规就是**用户写漏了**，必须报 error —— 静默容错
 *   会让"漏写 @@END"这种真错误永远发现不了（而且写回时行为会变）。
 * · **自定义预设 = 外部格式兼容**：用户从别处导入的预设（如 `【条目{id}：` +
 *   `内容：`、无结束标记、顿号分隔关键词）本来就不是本工具发明的语法。它的
 *   "不规范"往往只是对方的书写习惯，报 error 只会让整份内容无法写回、进而丢失。
 *
 * 所以宽容只对**自定义预设**开启。判据用标记字面量比较：任一标记与默认不同，
 * 就认为用户有意定义了另一套语法。
 */
function isBuiltinFormat(params: WorldbookFormatParams): boolean {
  const base = DEFAULT_WORLDBOOK_FORMAT;
  return (
    params.entryOpen === base.entryOpen &&
    params.contentMark === base.contentMark &&
    params.entryClose === base.entryClose
  );
}

/**
 * 世界书 TXT → entries（按格式预设）。
 * 所有结构问题都带行号返回；error 级问题意味着「不要拿结果去做合并」。
 */
export function parseWorldbookTextWith(text: string, params: WorldbookFormatParams): ParseWorldbookResult {
  const fmt = compileFormat(params);
  /**
   * 宽容档位（v0.1.5 / G4）：自定义预设才放宽。
   * 影响三处 —— 隐式闭合自适应、重复 id 续号、列表分隔符回退。
   * 三处都读这一个变量，避免"某一处严某一处松"的错位。
   */
  const lenient = !isBuiltinFormat(params);
  const issues: WorldbookParseIssue[] = [];
  const entries: StWorldbookEntry[] = [];
  const seenIds = new Set<number>();
  /** 已出现过的最大 id；重复 id 续号时从它 +1 起（v0.1.5 / G4） */
  let maxSeenId = -1;
  let draft: DraftEntry | null = null;
  let leadingText = false;
  /**
   * 是否见过任何条目标记（v0.1.5 / G3-2）。
   *
   * 与 `entries.length === 0` 不是一回事：可以有标记但每一条都因缺正文被剔除
   * （那时已有 `missing-content` error），也可以是**一个标记都没有**。
   * 后者才是"整段格式不对"，需要单独报 error。
   */
  let sawEntryMarker = false;
  /** 缺正文标记被整块剔除的条目（id + 起始行） */
  const droppedMissingContent: { id: number; line: number }[] = [];
  const contentMarkText = params.contentMark;

  const closeDraft = (endLine: number): void => {
    if (!draft) return;
    // 缺 @@CONTENT 的条目整块不参与解析（保留原条目，避免被覆盖成空内容）
    if (!draft.sawContent) {
      droppedMissingContent.push({ id: draft.id, line: draft.line });
      draft = null;
      return;
    }
    const joined = draft.bodyRaw.join('');
    // 去掉紧邻 @@END 之前的那一个换行（写出时补的）
    const content = joined.endsWith('\r\n') ? joined.slice(0, -2) : joined.endsWith('\n') ? joined.slice(0, -1) : joined;
    const entry: Record<string, unknown> = { ...draft.fields, id: draft.id, content };
    if (!('keys' in entry)) entry['keys'] = [];
    entries.push(entry as unknown as StWorldbookEntry);
    // 「keys 为空且非常驻 → 永不触发」**不在这里报**（T10.33 去重铁律）：
    // 它已由 `rules/worldbook-checks.ts` 的默认规则集 `builtin:worldbook-no-trigger` 判定。
    // 解析器只管"这段文本能不能读成条目"，判语义是规则引擎的职责 ——
    // 两处都报会让同一条违规在审计面板里出现两遍。
    draft = null;
  };

  const lines = splitKeepEol(text);

  /*
   * 闭标记自适应（v0.1.5 / G4）。
   *
   * 用户那份预设声明了 `entryClose: "条目{id}结束"`，但他的 2000 多字里
   * **一处都没写**这个结束行 —— "标题式"世界书天然靠下一个标题分界。
   * 于是旧逻辑对每个条目报 `missing-end` error ⇒ `ok=false` ⇒ 拒绝写回
   * entries ⇒ 导出丢内容。
   *
   * 判据是**全文一次都没出现**闭标记：那说明这份文本的书写习惯就是隐式闭合，
   * 按隐式模式解析并给一条提示。若"有的条目写了、有的没写"，仍按显式模式报
   * `missing-end` —— 那是真的写漏了，不能替用户掩盖。
   */
  let entryEnd = fmt.entryEnd;
  if (entryEnd !== null && lenient) {
    const usedAnyClose = lines.some((rawLine) => entryEnd!.test(splitLineEol(rawLine).content));
    if (!usedAnyClose) {
      const presentOpen = lines.some((rawLine) => fmt.entryStart.test(splitLineEol(rawLine).content));
      if (presentOpen) {
        entryEnd = null;
        issues.push({
          severity: 'warning',
          code: 'implicit-close',
          line: 1,
          message:
            `当前世界书预设声明了闭标记（\`${params.entryClose.replace('{id}', '0')}\`），` +
            '但整份文本一次都没用到 —— 已按「隐式闭合」解析（条目由下一个开标记或文件结束分界）。' +
            '如果你的写法本来就是隐式闭合，把预设里的 entryClose 留空即可不再提示',
        });
      }
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    const lineNumber = index + 1;
    const { content: line } = splitLineEol(rawLine);

    if (fmt.entryStart.test(line)) {
      sawEntryMarker = true;
      if (draft) {
        /*
         * 遇到下一个开标记 ⇒ 上一个条目闭合。
         *
         * 隐式闭合模式（预设没写 `entryClose`）下这是**正常路径**，不是错误；
         * 显式闭合模式（如默认 `@@END`）下才报 `missing-end`。
         */
        if (entryEnd !== null) {
          issues.push({
            severity: 'error',
            code: 'missing-end',
            entryId: draft.id,
            line: lineNumber,
            message: `条目 ${draft.id}（第 ${draft.line} 行开始）缺少闭标记（在第 ${lineNumber} 行遇到下一个开标记）`,
          });
        }
        closeDraft(lineNumber - 1);
      }
      const startMatch = fmt.entryStart.exec(line);
      const raw = startMatch?.[1] ?? '';
      /** 标记行内剩余内容（v0.1.5 / G4）：`【条目1：名字】` 的 `名字】` */
      const inlineTail = (startMatch?.[2] ?? '').trim();
      const id = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isFinite(id)) {
        issues.push({
          severity: 'error',
          code: 'invalid-id',
          line: lineNumber,
          message: `条目开标记的 id 必须是非负整数，实际为 "${raw}"`,
        });
        continue;
      }
      /*
       * id 重复（v0.1.5 / G4 改为自动续号）。
       *
       * 用户那份世界书把"持续世界书"（条目 1–7）与"关键词世界书"（条目 1–12）
       * 拼在一起，两段**各自从 1 编号** —— 这是极常见的写法（分章节写、再合并）。
       * 旧实现报 error ⇒ `ok=false` ⇒ 整份拒绝写回 ⇒ 2300 多字仍然进不去，
       * 与"不许无声丢数据"冲突。
       *
       * 现在：保留两条、按出现顺序给后面那条重新编号，并报 warning。
       * **不静默**：明确告诉用户"你的 1–12 各出现了两次，已重新编号为 13–24"，
       * 且导出后的 id 唯一（符合 ST 的 entries 约定）。
       */
      let finalId = id;
      if (seenIds.has(id)) {
        if (!lenient) {
          /*
           * 内置格式下重复 id 是**真错误**：用户手写了两个 `@@ENTRY 3`，
           * 语义上他可能想改前一个、或想覆盖 —— 两种解释都合理，替他选一种
           * 就是替他改了数据。保持 v0.1.2 起的语义：报 error、拒绝合并
           * （条目仍全部保留在结果里，只是 `ok=false` 不写回）。
           */
          issues.push({
            severity: 'error',
            code: 'duplicate-id',
            entryId: id,
            line: lineNumber,
            message: `条目 id ${id} 重复（首次出现于上文，第 ${lineNumber} 行再次声明）；禁止静默合并，请改为唯一 id`,
          });
        } else {
          /*
           * 自定义预设下重复 id 往往是**外部格式的自然结果**：用户那份世界书
           * 分「持续世界书」「关键词世界书」两节，各自从条目 1 编号 ——
           * 单看每节都合法，合起来就撞了。报 error 会让整份 2000 多字无法写回
           * （→ 又变成"静默丢内容"），所以续号并明确告知。
           *
           * 新编号取"当前最大 id + 1"，而不是"最小空位"：最小空位会让第二段
           * 的重复条目拿到 0（排在最后），编号看起来是乱的；递增则符合
           * "后面的条目排在后面"的直觉。
           */
          maxSeenId += 1;
          finalId = maxSeenId;
          issues.push({
            severity: 'warning',
            code: 'duplicate-id',
            entryId: id,
            line: lineNumber,
            message:
              `条目 id ${id} 重复（第 ${lineNumber} 行再次声明，首次见上文）；` +
              `已按出现顺序重新编号为 ${finalId}，两条内容都保留`,
          });
        }
      }
      seenIds.add(finalId);
      if (finalId > maxSeenId) maxSeenId = finalId;
      draft = { id: finalId, line: lineNumber, fields: {}, sawContent: false, bodyRaw: [] };
      /*
       * 行内剩余当条目名（v0.1.5 / G4）。
       *
       * `【条目1：西奥核心关系逻辑】` 这种"编号与名称同一行"的写法很自然，
       * 旧实现因为要求标记独占整行，整份文本一条都解析不出来。
       *
       * 只作为**兜底**：若后面还有 `名称：` 字段行，那一行会覆盖它
       * （显式字段比行内猜测更可信）。空剩余则不设 name。
       */
      if (inlineTail !== '') {
        const name = cleanInlineName(inlineTail);
        if (name !== '') draft.fields['name'] = name;
      }
      continue;
    }

    /*
     * 正文标记。`sawContent` 之后不再认 —— 它表示"正文从这里开始"，只该出现一次。
     *
     * 加这个条件是为了让**正文里以 `内容：` 开头的行**（用户可能真的这么写）
     * 不会被第二个正文标记吃掉。行内剩余（`内容：正文第一句`）作为正文首行。
     */
    if (!(draft?.sawContent ?? false) && fmt.contentMark.test(line)) {
      if (!draft) {
        issues.push({ severity: 'error', code: 'orphan-marker', line: lineNumber, message: `第 ${lineNumber} 行的正文标记出现在任何条目之前` });
        continue;
      }
      draft.sawContent = true;
      const tail = fmt.contentMark.exec(line)?.[1] ?? '';
      if (tail.trim() !== '') {
        // 保留行尾，正文按行拼接（`closeDraft` 会去掉最后一个换行）
        const { eol } = splitLineEol(rawLine);
        draft.bodyRaw.push(`${unescapeContentLine(tail.trimStart())}${eol}`);
      }
      continue;
    }

    const endMatch = entryEnd === null ? null : entryEnd.exec(line);
    if (endMatch) {
      const rawId = endMatch[1] ?? '';
      const id = /^\d+$/.test(rawId) ? Number(rawId) : Number.NaN;
      if (!draft) {
        issues.push({ severity: 'error', code: 'orphan-marker', line: lineNumber, message: `第 ${lineNumber} 行的闭标记 ${rawId} 没有对应的开标记` });
        continue;
      }
      if (id !== draft.id) {
        // 以开标记配对为准：该行原样留在正文里，继续等待匹配的闭标记
        issues.push({
          severity: 'error',
          code: 'mismatched-end',
          entryId: draft.id,
          line: lineNumber,
          message: `闭标记 ${rawId} 与条目标记 ${draft.id} 的 id 不一致（以开标记为准）`,
        });
        draft.bodyRaw.push(`${line}\n`);
        continue;
      }
      closeDraft(lineNumber);
      continue;
    }

    if (!draft) {
      if (line.trim() !== '' && !leadingText) {
        leadingText = true;
        issues.push({
          severity: 'warning',
          code: 'leading-text',
          line: lineNumber,
          message: `第 ${lineNumber} 行位于第一个条目标记之前，已作为世界书说明文字忽略`,
        });
      }
      continue;
    }

    if (!draft.sawContent) {
      const header = parseFieldLine(line, fmt);
      if (!header) {
        issues.push({
          severity: 'warning',
          code: 'unexpected-line',
          entryId: draft.id,
          line: lineNumber,
          message: `条目 ${draft.id} 在正文标记之前出现非字段行，已忽略：${line.slice(0, 30)}`,
        });
        continue;
      }
      const key = header.field;
      const label = header.label;
      const value = header.value;
      if (key === null) {
        issues.push({
          severity: 'warning',
          code: 'unknown-field',
          entryId: draft.id,
          line: lineNumber,
          message: `条目 ${draft.id} 的字段 "${label}" 不是已知字段，已忽略（如果是标签写法不同，请在当前世界书预设的 labelMap 里登记）`,
        });
        continue;
      }
      if (LIST_FIELDS.has(key)) {
        draft.fields[key] = parseCsvList(value, params.listSeparator, lenient);
        continue;
      }
      if (BOOL_FIELDS.has(key)) {
        const bool = parseBool(value);
        if (bool === null) {
          /*
           * 认不出就**不猜**：字段保持缺省（constant 即 false），只报一条 warning。
           * 文案里给出可写值 —— 只说"不是布尔值"用户不知道能写什么，
           * 尤其在中文字段标签下 `是/否` 根本不是他的第一直觉。
           */
          issues.push({
            severity: 'warning',
            code: 'bad-value',
            entryId: draft.id,
            line: lineNumber,
            message: `条目 ${draft.id} 的 ${label}（${key}）不是布尔值（${value}）—— 已忽略，${key} 保持缺省。可写：${BOOL_VALUE_HINT}`,
          });
          continue;
        }
        draft.fields[key] = bool;
        continue;
      }
      if (NUMBER_FIELDS.has(key)) {
        const numeric = Number(value.trim());
        if (value.trim() === '' || !Number.isFinite(numeric)) {
          issues.push({ severity: 'warning', code: 'bad-value', entryId: draft.id, line: lineNumber, message: `条目 ${draft.id} 的 ${key} 不是数字（${value}），已忽略` });
          continue;
        }
        draft.fields[key] = numeric;
        continue;
      }
      if (key === 'position') {
        const parsed = parsePosition(value);
        if (parsed === null) {
          issues.push({ severity: 'warning', code: 'bad-value', entryId: draft.id, line: lineNumber, message: `条目 ${draft.id} 的 position 无法识别（${value}），已忽略` });
          continue;
        }
        draft.fields[key] = parsed;
        continue;
      }
      draft.fields[key] = value;
      continue;
    }

    const { content: bodyText, eol } = splitLineEol(rawLine);
    draft.bodyRaw.push(`${unescapeContentLine(bodyText)}${eol}`);
  }

  if (draft) {
    /*
     * 读到文件结束仍有未闭合的条目。
     *
     * 隐式闭合模式（预设没写 `entryClose`）下这是**正常收尾** —— 最后一个条目
     * 天然由 EOF 闭合，不报问题。显式闭合模式才报 `missing-end`。
     */
    if (entryEnd !== null) {
      issues.push({
        severity: 'error',
        code: 'missing-end',
        entryId: draft.id,
        line: lines.length,
        /*
         * 同时给出**条目起始行**（v0.1.5 / G3-2）。
         *
         * `line` 是"读到文件尾才发现没闭合"的位置，对定位没帮助 ——
         * 用户看到"第 800 行"只知道末尾有问题，不知道是哪个条目。
         * `draft.line` 是条目开头，那才是他要改的地方。
         */
        message:
          `条目 ${draft.id}（第 ${draft.line} 行开始）缺少闭标记（读到文件结束仍未闭合：` +
          `应为 \`${params.entryClose.replace('{id}', String(draft.id))}\`）`,
      });
    }
    closeDraft(lines.length);
  }

  // 缺正文标记的条目已在 closeDraft 中整块剔除，这里补 error
  for (const dropped of droppedMissingContent) {
    issues.push({
      severity: 'error',
      code: 'missing-content',
      entryId: dropped.id,
      line: dropped.line,
      message: `条目 ${dropped.id} 缺少正文标记（第 ${dropped.line} 行），整块未参与解析，原条目保持不变`,
    });
  }

  /*
   * 全文没有条目标记（v0.1.5 / G3-2，红线）。
   *
   * 判据：文本里有非空白内容，但 `entryStart` 一次都没匹配上。
   * 这不是"空世界书"（空世界书是 text.trim() === ''，走到这里就直接返回 0 条，
   * 属于合法状态），而是**格式完全不匹配**。
   *
   * 为什么必须报 error：`ok` 的定义是"没有 error"。只报 warning 时 `ok=true`，
   * `setBlockText` 会把 `entries: []` 写回卡片，把用户原有的条目清空 ——
   * 而界面上 `text` 还在（显示层走文本回退），看起来一切正常，
   * 直到导出才发现 character_book 是空的。这是"无声丢数据"，必须挡住。
   *
   * 报错文案要给出**怎么改**，而不是只说"格式不对"：用户手里那份
   * `【条目1：…】/顺序：…/内容：…` 与我们要求的 `@@ENTRY`/`@@CONTENT`/`@@END`
   * 是两套完全不同的标记，光说"解析失败"等于没说。
   */
  if (entries.length === 0 && !sawEntryMarker && text.trim() !== '') {
    const firstContentLine = lines.findIndex((line) => splitLineEol(line).content.trim() !== '');
    /*
     * 识别几种常见的"外来格式"，把话说到点子上。
     *
     * 只说"没有条目标记"用户仍然不知道该改什么 —— 他手里那段文字看起来
     * 结构很清晰（`【条目1：…】` / `顺序：` / `内容：`），凭什么说格式不对？
     * 所以要明说：**你这套标记不是本工具的**，并给出对照。
     */
    const looksLike = detectForeignWorldbookFormat(text);
    const hint =
      looksLike === null
        ? ''
        : `（检测到 ${looksLike.name} 写法：${looksLike.sample} —— 本工具要求的是 ` +
          '`@@ENTRY n` / `@@CONTENT` / `@@END n` 三个标记）';
    issues.push({
      severity: 'error',
      code: 'no-entry-marker',
      line: firstContentLine >= 0 ? firstContentLine + 1 : 1,
      message:
        `世界书文本里没有任何条目标记（应为 \`${params.entryOpen.replace('{id}', '0')}\` … ` +
        `\`${params.contentMark}\` … \`${params.entryClose.replace('{id}', '0')}\`）；` +
        `这段文字未被解析成条目，写回会清空原有条目${hint}`,
    });
  }

  return { entries, issues, ok: issues.every((issue) => issue.severity !== 'error') };
}

/**
 * 猜这段文本是哪套世界书写法（仅用于错误提示，不参与解析）。
 *
 * 线上那份样本是 `【条目1：标题】` + `顺序：275` + `内容：…`，
 * 标题里还夹着"顺序/触发概率/内容"这些字段行 —— 看起来非常规整，
 * 所以用户不会怀疑格式，必须由我们指出差异。
 */
function detectForeignWorldbookFormat(text: string): { name: string; sample: string } | null {
  if (/^【条目\s*\d+/m.test(text)) {
    return { name: '「【条目N：…】+ 顺序/内容：」', sample: '【条目1：标题】↑ 顺序：275 ↑ 内容：…' };
  }
  if (/^###\s*条目/m.test(text) || /^##\s*条目/m.test(text)) {
    return { name: 'Markdown 标题式', sample: '## 条目 1' };
  }
  if (/^\s*\{\s*"keys"/m.test(text) || /^\s*\[\s*\{/m.test(text)) {
    return { name: 'JSON 片段', sample: '[{ "keys": [...] }]' };
  }
  return null;
}

/** 世界书 TXT → entries（v1.0 冻结格式）。自定义格式用 `parseWorldbookTextWith`。 */
export function parseWorldbookText(text: string): ParseWorldbookResult {
  return parseWorldbookTextWith(text, DEFAULT_WORLDBOOK_FORMAT);
}

// ---------------------------------------------------------------- 合并

/**
 * 合并：TXT 解析结果为**事实源**。
 * - TXT 中的条目覆盖原条目的 11 个可见字段 + content；
 * - 原条目的其余字段（extensions / 未知键）按 id 挂回；
 * - 原表有、TXT 中没有的 id → 删除（除非 dropMissing=false）；
 * - TXT 有、原表没有的 id → 新增条目。
 *
 * 注意：调用前应确认 `parseWorldbookText().ok === true`，
 * 否则残缺条目会被误判为「用户删除」。
 */
export function mergeWorldbookEntries(
  original: readonly StWorldbookEntry[],
  parsed: readonly StWorldbookEntry[],
  options: MergeWorldbookOptions = {},
): MergeWorldbookResult {
  const dropMissing = options.dropMissing ?? true;
  const visibleKeys = new Set<string>(WORLDBOOK_VISIBLE_KEYS as readonly string[]);

  const originalById = new Map<number, StWorldbookEntry>();
  for (const entry of original) {
    if (typeof entry.id === 'number' && Number.isFinite(entry.id) && !originalById.has(entry.id)) {
      originalById.set(entry.id, entry);
    }
  }

  const result: StWorldbookEntry[] = [];
  const added: number[] = [];
  const removed: number[] = [];
  const preserved: number[] = [];
  const seen = new Set<number>();

  for (const parsedEntry of parsed) {
    const id = parsedEntry.id;
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      result.push({ ...parsedEntry });
      continue;
    }
    seen.add(id);
    const originalEntry = originalById.get(id);
    if (!originalEntry) {
      result.push({ ...parsedEntry });
      added.push(id);
      continue;
    }
    const merged: Record<string, unknown> = { ...originalEntry };
    let carried = false;
    for (const key of Object.keys(originalEntry)) {
      if (key !== 'id' && !visibleKeys.has(key)) carried = true;
    }
    for (const key of WORLDBOOK_VISIBLE_KEYS) {
      const value = (parsedEntry as Record<string, unknown>)[key];
      if (value !== undefined) merged[key] = value;
      else delete merged[key];
    }
    merged['id'] = id;
    if (carried) preserved.push(id);
    result.push(merged as unknown as StWorldbookEntry);
  }

  const leftovers: StWorldbookEntry[] = [];
  for (const [id, entry] of originalById) {
    if (seen.has(id)) continue;
    if (dropMissing) removed.push(id);
    else leftovers.push(entry);
  }
  if (leftovers.length > 0) {
    result.push(
      ...original.filter((entry) => leftovers.includes(entry)),
    );
  }

  return { entries: result, added, removed, preserved };
}
