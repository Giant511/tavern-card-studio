/**
 * 开场白（初始场景板块）的 TXT 表达格式（v0.1.3 / F6b）。
 *
 * ## 要解决什么
 *
 * ST 用两个字段装开场白：`first_mes`（单条，必有）与 `alternate_greetings`（数组，可空）。
 * 而"初始场景"是一个**板块**、一段可编辑文本。所以必须定义"一段文本 ↔ 一个字符串 + 一个数组"
 * 的可逆映射。这里用**分隔行切分**：
 *
 * ```
 * 第一段（回 first_mes）
 *
 * ---
 *
 * 第二段（回 alternate_greetings[0]）
 * ```
 *
 * ## 三条语义（需求已拍板，别改）
 *
 * 1. **没有分隔行 = 单条 `first_mes`**。现网存量卡只填了 `first_mes`，
 *    导入后板块里就是那一整段，导出逐字节不变 —— 这是"历史卡片永远可用"的具体含义。
 * 2. **有分隔行才切分**。第 1 段回 `first_mes`，其余按序回 `alternate_greetings`。
 * 3. **未改动不重算**（在 `field-blocks.ts` 实现）：板块没被编辑时，序列化直接用原 `residual`，
 *    不经过"渲染 → 再解析"。否则 `first_mes` 正文里天然含一行 `---`（剧情分隔线，卡里很常见）
 *    会被切走 —— 那属于**静默改数据**，比"少一个功能"严重得多。
 *
 * ## 为什么分隔格式要参数化
 *
 * 与 TXT 预设 / 世界书预设同构：`DEFAULT_GREETING_FORMAT` 冻结（`test/greeting-preset.test.mjs`
 * 第一条铁律守它），用户想换 `===` 或 `--- 下一段 ---` 时可以导入自己的预设，
 * 不用改代码。冻结的是**默认值**，不是"格式不可参数化"这件事。
 */

/** 开场白 TXT 的可参数化部分 */
export interface GreetingFormatParams {
  /**
   * 多条开场白之间的分隔串，必须含换行。
   * 分隔串里"唯一的非空行"（如 `\n\n---\n\n` 里的 `---`）才是识别标记；
   * 纯空白分隔串无法作为标记，会被拒绝。
   */
  separator: string;
  /**
   * 段标签映射（v0.1.3 / 追加项一，可选）。
   *
   *   · `first`：第一条开场白前面的标签行；
   *   · `alternate`：备用开场白的标签行，支持 `{n}` 占位符（渲染时替换成序号）。
   *
   * **缺省 / 空对象 = 不写标签、不认标签**，即 v0.1.3 已发布的逐字节行为。
   * 开了标签的预设会在导出的 TXT 里多出标签行，解析时按同一张表剥掉 ——
   * 渲染与解析必须成对使用同一份参数，否则往返会多/少一行。
   */
  labelMap?: Record<string, string>;
}

/**
 * 冻结的默认值：`\n\n---\n\n`（空行 + `---` + 空行）。
 *
 * 选它而不是花哨的定制行的理由：这一行会**真的出现在导出的 TXT 里**，
 * 用户拿去看/改的时候应当一眼认得出是分隔，而不是像某种内部标记。
 * `---` 同时是 `divider` 预设的板块分隔符，视觉上一致。
 */
export const DEFAULT_GREETING_FORMAT: GreetingFormatParams = Object.freeze({
  separator: '\n\n---\n\n',
});

/** 分隔串里唯一的非空行（识别用）；纯空白返回 null */
export function greetingDividerToken(separator: string): string | null {
  const lines = separator
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length === 1 ? lines[0]! : null;
}

/** 把 `{ separator }` 这样的可选配置解析成完整参数（缺项用冻结默认值） */
export function resolveGreetingFormat(input?: Partial<GreetingFormatParams> | null): GreetingFormatParams {
  const separator = typeof input?.separator === 'string' && input.separator !== ''
    ? input.separator
    : DEFAULT_GREETING_FORMAT.separator;
  return { separator };
}

export interface GreetingParseResult {
  /** 第一条开场白（ST 的 first_mes） */
  firstMes: string;
  /** 其余开场白（ST 的 alternate_greetings） */
  alternateGreetings: string[];
  /** 切出来的所有段（含第一段）；未切分时只有一段 */
  items: string[];
  /** 是否真的发生了切分（false = 全文即 first_mes） */
  split: boolean;
}

/** 去掉段首尾的空白（含空行）。切分时两侧的换行属于分隔串，不属于内容。 */
function trimEdges(text: string): string {
  return text.replace(/^\s+|\s+$/g, '');
}

/** `{n}` 换成序号（只在备用开场白的标签里用得上） */
function expandLabel(template: string, index: number): string {
  return template.split('{n}').join(String(index));
}

/**
 * 标签表里全部可识别的标签行（含 `{n}` 展开成数字的形态），用于解析时剥离。
 *
 * 返回空数组 = 这份格式没有标签，解析与渲染都按"纯文本"走。
 */
function labelPatterns(format: GreetingFormatParams): RegExp[] {
  const map = format.labelMap ?? {};
  const patterns: RegExp[] = [];
  for (const template of Object.values(map)) {
    if (typeof template !== 'string' || template.trim() === '') continue;
    // `{n}` 只匹配数字；其余字符按字面量转义 —— 标签里出现正则元字符（如 `【`) 不该被当语法
    const source = template
      .split('{n}')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\d+');
    patterns.push(new RegExp(`^\\s*${source}\\s*$`));
  }
  return patterns;
}

/**
 * 剥掉段首的标签行（若存在）。
 *
 * 只剥**第一行**，且必须整行匹配标签 —— 正文里提到「开场白」这三个字不该被吃掉。
 */
function stripLabelLine(text: string, patterns: readonly RegExp[]): string {
  if (patterns.length === 0) return text;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') start += 1;
  if (start >= lines.length) return text;
  const first = lines[start]!;
  if (!patterns.some((pattern) => pattern.test(first))) return text;
  return lines.slice(start + 1).join('\n');
}

/**
 * 一段文本 → `first_mes` + `alternate_greetings`。
 *
 * 不切分时**逐字节返回原文本**（连首尾空白都不动）：这是存量卡兼容的落点，
 * 任何 trim 都会让"导出再导入"产生 diff。
 */
export function parseGreetings(
  text: string,
  format: GreetingFormatParams = DEFAULT_GREETING_FORMAT,
): GreetingParseResult {
  const token = greetingDividerToken(format.separator);
  if (token === null) {
    const stripped = stripLabelLine(text, labelPatterns(format));
    // 没有分隔行时也允许剥标签：单条开场白 + 标签行的写法同样存在
    return stripped === text
      ? { firstMes: text, alternateGreetings: [], items: [text], split: false }
      : { firstMes: trimEdges(stripped), alternateGreetings: [], items: [trimEdges(stripped)], split: false };
  }

  // 按"整行等于标记"切分，不做子串匹配：正文里提到这几个字符不该被当成分隔
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const segments: string[] = [];
  let current: string[] = [];
  let split = false;
  for (const line of lines) {
    if (line.trim() === token) {
      segments.push(current.join('\n'));
      current = [];
      split = true;
      continue;
    }
    current.push(line);
  }
  segments.push(current.join('\n'));

  if (!split) {
    const stripped = stripLabelLine(text, labelPatterns(format));
    return stripped === text
      ? { firstMes: text, alternateGreetings: [], items: [text], split: false }
      : { firstMes: trimEdges(stripped), alternateGreetings: [], items: [trimEdges(stripped)], split: false };
  }

  const patterns = labelPatterns(format);
  const items = segments.map((segment) => stripLabelLine(trimEdges(segment), patterns)).map(trimEdges);
  return {
    firstMes: items[0] ?? '',
    alternateGreetings: items.slice(1),
    items,
    split: true,
  };
}

/**
 * `first_mes` + `alternate_greetings` → 一段文本。
 *
 * 数组为空时**原样返回 `firstMes`**（不加分隔串、不 trim）——
 * 与 `parseGreetings` 的不切分分支严格对称，保证存量卡 round-trip 逐字节相等。
 */
export function renderGreetings(
  firstMes: string,
  alternateGreetings: readonly string[],
  format: GreetingFormatParams = DEFAULT_GREETING_FORMAT,
): string {
  const map = format.labelMap ?? {};
  const firstLabel = typeof map['first'] === 'string' && map['first'] !== '' ? map['first'] : null;
  const altLabel = typeof map['alternate'] === 'string' && map['alternate'] !== '' ? map['alternate'] : null;

  /*
   * 无标签时**原样返回**（含 firstMes 的原始空白）—— 这是存量卡 round-trip
   * 逐字节相等的落点，任何 trim 都会让"导出再导入"产生 diff。
   */
  if (alternateGreetings.length === 0) {
    return firstLabel === null ? firstMes : `${firstLabel}\n${firstMes}`;
  }
  const parts: string[] = [firstLabel === null ? firstMes : `${firstLabel}\n${firstMes}`];
  alternateGreetings.forEach((text, index) => {
    parts.push(altLabel === null ? text : `${expandLabel(altLabel, index + 1)}\n${text}`);
  });
  return parts.join(format.separator);
}

/** 开场白条数（1 + 备用量）；空文本按 0 条计 */
export function countGreetings(
  firstMes: string,
  alternateGreetings: readonly string[],
): number {
  if (firstMes.trim() === '' && alternateGreetings.length === 0) return 0;
  return 1 + alternateGreetings.length;
}
