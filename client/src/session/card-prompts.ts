/**
 * 角色级提示词在**卡片**里的读写与比较（2026-11-17）。
 *
 * ## 为什么单独一个文件，而不是放在 `prompts-panel.ts` 里
 *
 * `card-session.ts` 的契约是"纯逻辑，无 DOM、无 CodeMirror"，
 * 而 `prompts-panel.ts` 是一个 DOM 组件（`document.createElement`）。
 * 会话层去 import 组件，会让 `test/card-session.test.mjs` 这类
 * **Node 里跑的测试**拖进一个浏览器模块 —— 现在没炸只是因为
 * 组件里的 `document` 调用都在函数体内，将来有人写一句模块级
 * `const TEMPLATE = document.createElement(...)` 就会让所有会话测试挂掉，
 * 而报错信息（`document is not defined`）与真正的原因离得很远。
 *
 * 所以这一层只做纯函数：读卡 → 写卡 → 比较 → 校验。
 * 组件与会话都从**这里**取，各取所需。
 */

import {
  emptyCharacterPrompts,
  parseCharacterPrompts,
  validateCharacterPrompts,
  writeCharacterPrompts,
  type CharacterPromptConfig,
} from '@tcs/shared';

/** 卡的最小形状（只要 passthrough.data，避免依赖整个 UnifiedCard） */
interface CardLike {
  passthrough: { data: Record<string, unknown> };
}

/**
 * 从卡里读角色提示词。
 *
 * ★ 入参取 `passthrough.data['extensions']`，不是 `card.extensions` ——
 *   卡**顶层**也有一个 `extensions`（V1 兼容副本），取错了会读到另一份数据，
 *   而两份看起来都"有值"，症状是"改了这个角色、那个角色也变了"。
 */
export function readCardPrompts(card: CardLike): CharacterPromptConfig {
  return parseCharacterPrompts(card.passthrough.data['extensions']) ?? emptyCharacterPrompts();
}

/**
 * 把配置写进卡（返回新卡，不改入参）。
 *
 * ★ 必须走 `writeCharacterPrompts`：它深合并、空配置时删掉自己那个键，
 *   并保住 `tcs.cardId` 与别的工具的键。手写 `{ tcs: { prompts } }`
 *   会把 `tcs.cardId` 一起抹掉 —— 那会让这张卡在服务端变成另一张卡。
 */
export function writePromptsIntoCard<T extends CardLike>(card: T, config: CharacterPromptConfig): T {
  const raw = card.passthrough.data['extensions'];
  const extensions = writeCharacterPrompts(
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null,
    config,
  );
  return {
    ...card,
    passthrough: {
      ...card.passthrough,
      data: { ...card.passthrough.data, extensions },
    },
  };
}

/** 有没有改动（空配置 = 完全跟随全局） */
export function hasPromptChanges(config: CharacterPromptConfig): boolean {
  return config.own.length > 0 || Object.keys(config.overrideOrder).length > 0;
}

/** 是否在上限内（与安卓端保存校验同一套规则） */
export function promptsWithinLimits(config: CharacterPromptConfig): boolean {
  return validateCharacterPrompts(config).length === 0;
}

/** 超限的文案（界面与日志共用，避免两处各写一份） */
export function promptLimitMessages(config: CharacterPromptConfig): string[] {
  return validateCharacterPrompts(config).map((one) => one.message);
}

/**
 * 两份配置是否等价（决定"要不要置脏"）。
 *
 * ## 为什么不用 JSON.stringify 比
 *
 * 键序不稳定：`overrideOrder` 是普通对象，删一条再加一条会改变键序，
 * 于是 `stringify` 结果不同、判定为"改了"，而内容其实一样。
 * 表现是"点开又收起也被标成未保存"。
 *
 * 所以逐字段比：`own` 按**下标**（顺序有意义 —— 同深度同排序时按数组序发），
 * `overrideOrder` 按**键集合**（无序）。
 */
export function samePrompts(a: CharacterPromptConfig, b: CharacterPromptConfig): boolean {
  if (a.own.length !== b.own.length) return false;

  for (let i = 0; i < a.own.length; i += 1) {
    const left = a.own[i];
    const right = b.own[i];
    /* `noUncheckedIndexedAccess` 下的必要守卫：长度已比过，这里只为类型收窄 */
    if (left === undefined || right === undefined) return false;
    if (left.id !== right.id) return false;
    if (left.name !== right.name) return false;
    if (left.content !== right.content) return false;
    if (left.role !== right.role) return false;
    if (left.enabled !== right.enabled) return false;
    if ((left.comment ?? '') !== (right.comment ?? '')) return false;
    const leftInjection = left.injection ?? { position: 0, depth: 4, order: 100 };
    const rightInjection = right.injection ?? { position: 0, depth: 4, order: 100 };
    if (leftInjection.position !== rightInjection.position) return false;
    if (leftInjection.depth !== rightInjection.depth) return false;
    if (leftInjection.order !== rightInjection.order) return false;
  }

  const leftKeys = Object.keys(a.overrideOrder);
  const rightKeys = Object.keys(b.overrideOrder);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    const left = a.overrideOrder[key];
    const right = b.overrideOrder[key];
    if (left === undefined || right === undefined) return false;
    if (left.enabled !== right.enabled) return false;
    if ((left.content ?? '') !== (right.content ?? '')) return false;
    if ((left.comment ?? '') !== (right.comment ?? '')) return false;
  }

  return true;
}
