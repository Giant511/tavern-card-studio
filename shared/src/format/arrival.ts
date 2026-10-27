/**
 * 到达规范化（v0.1.6 生产缺陷一 / 决策 #235–#237）。
 *
 * ## 现场
 *
 * 从**服务器取回**一张标准格式的卡，世界书块显示 3326 字、内容是标准的
 * `@@ENTRY 1 … @@CONTENT …`，而审计报：
 *
 * > 世界书文本里没有任何条目标记（应为 `@@ENTRY 0` … `@@CONTENT` … `@@END 0`）；
 * > 这段文字未被解析成条目，写回会清空原有条目
 *
 * 文本里明明有 `@@ENTRY 1`。**根因是"视图"和"判据"用了两套格式**：
 * `parseStCard` 用**默认格式**渲染 `worldbook.text`（写死 `renderWorldbookText`），
 * 而审计与「切换预设后重解析」用**当前激活预设**。用户把世界书预设换成
 * 自己那份（`【条目N：…】` 写法）之后，两套格式分叉 ⇒ 默认写法认不出来 ⇒
 * 一个"格式不匹配"，被报成了"解析不出"。
 *
 * 同一件事写两遍是缺陷温床 —— 这次写两遍的是**格式参数**。
 *
 * ## 修法：到达时做一次规范化，让"数据 → 视图"只走当前预设
 *
 * 三步（与用户拍板的设计一一对应）：
 *
 * 1. **结构化优先**：`character_book.entries` 本来就是结构化的，
 *    直接以**条目**为中间态，用当前预设渲染成文本 —— 不经过"文本 → 文本"。
 *    这条覆盖绝大多数到达（ST JSON 卡、服务器取回、回滚）。
 * 2. **文本到达才解析**：TXT 卡或只有世界书文本的情形，先用**当前预设**解析；
 *    一条标记都认不出时，用**标准预设**（内置冻结格式）兜底解析一次 ——
 *    能解析出来就说明"数据其实是标准格式、只是当前预设不同"，
 *    于是用当前预设重新渲染（提示「已按当前预设重新排版」）。
 * 3. **真解析不出才报错**：两套格式都认不出，才是"解析不出"，
 *    原样返回错误（导出闸门照旧硬挡，绝不静默丢数据）。
 *
 * ## 为什么"解析不出"与"格式不匹配"必须分开
 *
 * 合并成一个错误的代价是双向的：
 *   · 把"格式不匹配"报成错误 ⇒ 用户拿到的是一张**看起来坏掉**的正常卡（本次现场）；
 *   · 把"解析不出"当格式不匹配自动转换 ⇒ 会把**真正的乱码**当成"换了个格式"
 *     静默重排，写回时条目被清空 —— 那正是 G3-2 那条红线。
 *
 * 判据因此必须落在"用标准格式**能不能**解析出来"，而不是"文本长得像不像"：
 * 前者是二值的、可复现的；后者是猜。
 */

import type { UnifiedCard } from '../model/unified-card.js';
import {
  DEFAULT_GREETING_FORMAT,
  renderGreetings,
  type GreetingFormatParams,
} from './greeting-preset.js';
import { isFieldBlock, refreshFieldBlockViews } from './field-blocks.js';
import {
  DEFAULT_WORLDBOOK_FORMAT,
  type WorldbookFormatParams,
} from './worldbook-preset.js';
import { parseWorldbookTextWith, renderWorldbookTextWith } from './worldbook.js';

/** 到达时"当前激活"的两套格式 */
export interface ArrivalFormats {
  worldbook: WorldbookFormatParams;
  greeting: GreetingFormatParams;
}

export interface ArrivalFailure {
  /** 固定几个码，供上层决定要不要硬闸门 */
  code: 'worldbook-unparsable';
  message: string;
}

export interface ArrivalResult {
  card: UnifiedCard;
  /**
   * 发生了"格式不匹配 → 已按当前预设重排"的自动转换。
   *
   * 上层应给一条 **info**（不是 error）：用户没做错任何事，只是他的预设与
   * 数据原本的写法不同。
   */
  converted: boolean;
  /** 给用户看的提示（`converted` 为真时非空） */
  notes: string[];
  /** 真正的解析失败（非空时上层必须报错并挡住导出） */
  failures: ArrivalFailure[];
}

/**
 * 把"到达的卡"规范成"当前预设下能正确显示与导出"的卡。
 *
 * 三条到达路径都要调它（服务器取回/回滚、打开本地文件、导入 TXT）。
 * 纯函数：不改入参，返回新卡片。
 */
export function normalizeOnArrival(
  card: UnifiedCard,
  active: ArrivalFormats,
  fallback: ArrivalFormats = {
    worldbook: DEFAULT_WORLDBOOK_FORMAT,
    greeting: DEFAULT_GREETING_FORMAT,
  },
): ArrivalResult {
  const notes: string[] = [];
  const failures: ArrivalFailure[] = [];
  let converted = false;
  let next = card;

  // ── 1. 世界书：结构化条目优先 ──────────────────────────
  const worldbook = next.worldbook;
  const entries = worldbook.entries ?? [];

  if (entries.length > 0) {
    /*
     * 有结构化条目 ⇒ 它就是权威，文本只是视图。
     * 用**当前预设**重新渲染：这一步同时修好两个方向 ——
     *   · 标准格式卡 + 自定义预设（现场）：文本从 `@@ENTRY` 变成当前预设的写法；
     *   · 自定义格式卡 + 标准预设（反向）：同理。
     */
    const rendered = renderWorldbookTextWith(entries, active.worldbook);
    if (rendered !== worldbook.text) {
      converted = true;
      next = {
        ...next,
        worldbook: { ...worldbook, text: rendered, dirty: false },
      };
    }
  } else if (worldbook.text.trim() !== '') {
    /*
     * 只有文本（TXT 卡的世界书段、或只有文本的手工卡）。
     * 先按当前预设解析 —— 解析得出来就什么都不用做。
     */
    const withActive = parseWorldbookTextWith(worldbook.text, active.worldbook);
    if (withActive.ok && withActive.entries.length > 0) {
      // 已经是当前预设的写法，落一次结构化结果（视图与判据同源）
      next = {
        ...next,
        worldbook: { ...worldbook, entries: withActive.entries, dirty: false },
      };
    } else {
      /*
       * 当前预设解析不出来 —— 用标准预设兜底一次。
       *
       * 这是"格式不匹配"与"解析不出"的分水岭：标准预设能解析出来，
       * 说明数据本身是好的、只是写法不同；两侧都失败才是真的坏了。
       */
      const withFallback = parseWorldbookTextWith(worldbook.text, fallback.worldbook);
      if (withFallback.ok && withFallback.entries.length > 0) {
        const rendered = renderWorldbookTextWith(withFallback.entries, active.worldbook);
        converted = true;
        notes.push(
          `世界书原为${describeFormat(fallback.worldbook)}，已按当前预设` +
            `${describeFormat(active.worldbook)}重新排版（${String(withFallback.entries.length)} 条）`,
        );
        next = {
          ...next,
          worldbook: { ...worldbook, entries: withFallback.entries, text: rendered, dirty: false },
        };
      } else {
        /*
         * 两套都认不出 ⇒ 真·解析不出。
         * 报**当前预设**的问题（用户看到的解析器就是它），并带上兜底也失败的事实，
         * 免得用户以为"换个预设就能好"。
         */
        const issue = withActive.issues.find((item) => item.severity === 'error');
        failures.push({
          code: 'worldbook-unparsable',
          message:
            (issue?.message ?? '世界书文本无法解析成条目') +
            `（已尝试用标准预设兜底，同样解析不出：${String(withFallback.entries.length)} 条）`,
        });
      }
    }
  }

  // ── 2. 初始场景 / 对话示例：从结构化字段按当前分隔行重新生成 ──
  /*
   * `residual.firstMes` / `alternateGreetings` / `mesExample` 也是结构化的
   * （开场白是数组），分隔行只影响**视图**。所以这一块与"切换预设后重解析"
   * 是同一件事，直接复用那个函数，避免第二份实现。
   *
   * 只覆盖 `dirty === false` 的板块：用户改过的内容不会被到达流程覆盖。
   */
  const beforeFieldTexts = new Map(
    next.blocks.filter((block) => isFieldBlock(block.id)).map((block) => [block.id, block.text]),
  );
  next = refreshFieldBlockViews(next, active.greeting);
  for (const block of next.blocks) {
    if (!isFieldBlock(block.id)) continue;
    if (beforeFieldTexts.get(block.id) !== block.text) converted = true;
  }

  /*
   * ── 3. description 五板块：不需要"转换"，需要"不被覆盖" ──
   *
   * 与上面两块不同，这五个板块**没有格式参数**：文本就是文本，切分依据是
   * `residual.description` 里的标题行，而标题别名在到达那一刻（`parseStCard`）
   * 就已经定好了。所以"规范化"在这里只有一个含义 ——
   * **保证它们的视图仍然是到达时从 residual 切出来的那一份**，
   * 不被这次转换顺手改动。
   *
   * 这不是空话：`refreshFieldBlockViews` 是按 `isFieldBlock()` 过滤的，
   * 世界书重排也只动 `worldbook` 字段。两条路径都不碰 description 板块，
   * `test/arrival.test.mjs` 用"逐字节相同"把这条钉住 —— 上一轮的教训是
   * "顺手一起重排"会把用户正文里恰好长得像标题的行吃掉。
   */

  return { card: next, converted, notes, failures };
}

/**
 * 人话描述一套世界书格式（用于"已按 X 重新排版"这类提示）。
 *
 * 不暴露参数细节（`entryOpen` 那种带 `{id}` 的模板对用户没有意义），
 * 只说"内置标准写法"还是"自定义写法"。判据是对象身份 + 关键标记，
 * 不比较整个对象：用户可能只改了一个分隔符。
 */
function describeFormat(format: WorldbookFormatParams): string {
  const isDefault =
    format.entryOpen === DEFAULT_WORLDBOOK_FORMAT.entryOpen &&
    format.contentMark === DEFAULT_WORLDBOOK_FORMAT.contentMark;
  return isDefault ? '标准写法' : `「${format.entryOpen.replace('{id}', 'N')}」写法`;
}

/**
 * 开场白分隔行的规范化（单独导出，便于"只换了初始场景预设"的场景复用）。
 *
 * 与 `refreshFieldBlockViews` 是**同一实现**：这里只是把"当前格式"固定成参数，
 * 免得调用方（三条到达路径）各传一次、某一条忘了传就退回默认。
 */
export function normalizeGreetings(card: UnifiedCard, greeting: GreetingFormatParams): UnifiedCard {
  return refreshFieldBlockViews(card, greeting);
}

/** 供测试与诊断：某张卡在当前预设下"渲染出来的世界书文本" */
export function renderWorldbookFor(card: UnifiedCard, format: WorldbookFormatParams): string {
  const entries = card.worldbook.entries ?? [];
  if (entries.length > 0) return renderWorldbookTextWith(entries, format);
  return card.worldbook.text;
}

/** 供测试与诊断：某张卡在当前格式下"渲染出来的初始场景" */
export function renderGreetingsFor(card: UnifiedCard, format: GreetingFormatParams): string {
  return renderGreetings(card.residual.firstMes, card.residual.alternateGreetings, format);
}
