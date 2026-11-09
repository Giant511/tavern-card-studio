/**
 * 「初始场景」复合板块：一个板块承载四段 ST 字段（2026-11-09）。
 *
 * ## 产品形态的来源
 *
 * 用户原话：
 *
 * > 我编辑器里面的初始场景板块其实是包含三个字段的内容，一个就是开场白，
 * > 一个就是情景，还有一个是示例对话。
 *
 * 所以编辑器里「初始场景」**一个板块**，内部按子标题分两段：
 *
 * ```text
 *   @@开场白       first_mes（+ alternate_greetings，多条用分隔行切）
 *   @@情景         scenario
 * ```
 *
 * ★ 板块总数**仍是 8 个**（用户 2026-11-09 用编辑器截图确认）。
 * 「示例对话」不在本模块里 —— 它由独立的 `chat-examples` 板块承载
 * （编辑器里的「对话示例」）。若这里也给一段，同一段内容会有两个
 * 编辑入口，改一处另一处不跟着变。
 *
 * ## 为什么子标记用 `@@`
 *
 * 与项目里已有的 `@@ENTRY`（世界书条目标记）同一套视觉语言 ——
 * 用户已经在世界书里见过 `@@` 意味着"这是一个结构标记，不是正文"。
 * 另起一套（`##` / `---` / `[[ ]]`）会让同一份 TXT 里出现两种标记体系。
 *
 * ## 兼容旧文件：这是本模块最要紧的一条
 *
 * ```text
 *   v0.1.7 之前导出的 TXT         【初始场景】里只有开场白，没有任何 @@ 标记
 *   当时的独立板块                【对话示例】是一个**同级标题**
 * ```
 *
 * 所以解析必须做到：
 *
 * 1. **一个子标记都没有** ⇒ 整段当作「开场白」，再按分隔行切多条
 *    （不能因为"没认到标记"就把它当情景或示例 —— 那会让所有历史 TXT 错位）。
 * 2. 遇到旧版同级标题【对话示例】时，调用方把它作为第三段传进来（见 `legacyExamples`），
 *    不要当成"未识别标题"报 warning —— 用户的历史文件不该突然冒出一堆提示。
 */

import {
  DEFAULT_GREETING_FORMAT,
  parseGreetings,
  renderGreetings,
  type GreetingFormatParams,
} from './greeting-preset.js';

/**
 * 三个子段的标记行。
 *
 * 冻结成常量而不是放进 TXT 预设，理由：用户可以改的是"整体标题样式"
 * （`【初始场景】` 与分隔行），而这三个子段的名字是**解析锚点** ——
 * 允许改名就等于允许"改完自己看不懂"，而收益只是措辞偏好。
 * 真要可配置时，改动点就是这张表（单一来源）。
 */
export const SCENE_SECTION_LABELS = Object.freeze({
  greeting: '@@开场白',
  scenario: '@@情景',
});

/** 子段键 */
export type SceneSectionKey = keyof typeof SCENE_SECTION_LABELS;

/** 三段在文档里的固定顺序（渲染顺序 = 解析认的顺序） */
export const SCENE_SECTION_ORDER: readonly SceneSectionKey[] = ['greeting', 'scenario'];

/** 三段内容 */
export interface SceneSections {
  /** 第一条开场白（ST 的 first_mes） */
  firstMes: string;
  /** 其余开场白（ST 的 alternate_greetings） */
  alternateGreetings: string[];
  /** 情景（ST 的 scenario） */
  scenario: string;
}

/** 把一段原始文本拆成"标记 → 正文"的映射；无标记时返回 null */
function splitSections(text: string): Map<SceneSectionKey, string> | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  /* 标记识别：整行 trim 后等于某个子标记（也接受 `@@情景：` 这种带全角冒号的写法） */
  const labelToKey = new Map<string, SceneSectionKey>();
  for (const key of SCENE_SECTION_ORDER) {
    const label = SCENE_SECTION_LABELS[key];
    labelToKey.set(label, key);
    labelToKey.set(`${label}：`, key);
    labelToKey.set(`${label}:`, key);
  }

  const found: Array<{ key: SceneSectionKey; index: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    const key = labelToKey.get(trimmed);
    if (key !== undefined) found.push({ key, index: i });
  }
  if (found.length === 0) return null;

  const out = new Map<SceneSectionKey, string>();
  for (let n = 0; n < found.length; n += 1) {
    const current = found[n]!;
    const next = found[n + 1];
    const bodyLines = lines.slice(current.index + 1, next === undefined ? lines.length : next.index);
    /*
     * 同一个标记出现两次：**先出现的赢**，后面的内容并进它。
     *
     * 为什么不报错：用户复制粘贴时常把两段情景接在一起（忘了删重复的标记行）。
     * 报错会让整份 TXT 导入失败，而内容其实完好 —— 合并是更符合意图的处置。
     * 想严格的话在这里加一条 warning，但目前没有需求支撑。
     */
    const body = bodyLines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
    const existing = out.get(current.key);
    out.set(current.key, existing === undefined ? body : `${existing}\n\n${body}`.trim());
  }
  return out;
}

/**
 * 渲染：四段 ST 字段 → 一个板块的文本。
 *
 * 三段**标记始终写出来**（即使内容为空）。理由：
 * 用户看到 `@@情景` 才知道"这里可以写情景" —— 这是可发现性。
 * 省掉空段的标记，界面就变成"新卡只有 @@开场白"，剩下两段无处可寻。
 */
export function renderCompositeScene(
  sections: SceneSections,
  format: GreetingFormatParams = DEFAULT_GREETING_FORMAT,
): string {
  const greetingText = renderGreetings(sections.firstMes, sections.alternateGreetings, format);
  const parts = [
    `${SCENE_SECTION_LABELS.greeting}\n${greetingText}`.trimEnd(),
    `${SCENE_SECTION_LABELS.scenario}\n${sections.scenario}`.trimEnd(),
  ];
  return parts.join('\n\n');
}

/** 解析结果附带的信息（供上层决定要不要提示） */
export interface CompositeSceneParseResult extends SceneSections {
  /** 是否认到了任何子标记（false ⇒ 整段按开场白处理，兼容旧文件） */
  hasMarkers: boolean;
}

/**
 * 解析：一个板块的文本 → 三段 ST 字段（first_mes / alternate_greetings / scenario）。
 *
 * **没有 `legacyExamples` 参数**：示例对话从来不属于这个板块，
 * 它一直由 `chat-examples` 承载，所以这里不存在"从旧同级标题迁移"的问题。
 */
export function parseCompositeScene(
  text: string,
  format: GreetingFormatParams = DEFAULT_GREETING_FORMAT,
): CompositeSceneParseResult {
  const split = splitSections(text);

  if (split === null) {
    /*
     * 没有任何子标记 ⇒ 老格式（v0.1.7 之前导出的 TXT）：整段都是开场白。
     * 这是**必须保住**的兼容路径 —— 历史文件里没有 @@ 标记，
     * 若当成"情景"或报错，用户所有旧 TXT 都会错位或导不进来。
     */
    const greetings = parseGreetings(text, format);
    return {
      firstMes: greetings.firstMes,
      alternateGreetings: [...greetings.alternateGreetings],
      scenario: '',
      hasMarkers: false,
    };
  }

  const greetingBody = split.get('greeting') ?? '';
  const greetings = parseGreetings(greetingBody, format);
  return {
    firstMes: greetings.firstMes,
    alternateGreetings: [...greetings.alternateGreetings],
    scenario: split.get('scenario') ?? '',
    hasMarkers: true,
  };
}
