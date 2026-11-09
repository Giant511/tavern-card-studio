/**
 * 识别并清理"内置测试卡"（2026-11-09，A1）。
 *
 * ## 为什么需要这一步
 *
 * v0.1.7 早期包会在首启时把一张测试角色卡播进 `characters/`
 * （`TestCardSeeder`，已删）。但**已经装过早期包的机器上，那张卡还在** ——
 * 删掉播种器只保证"不再播新的"，不会清掉"已经种下去的"。
 *
 * 于是那些用户升级后会一直看到角色列表里有个「测试用-夜航小助手」，
 * 以为那是产品自带内容。
 *
 * ★ 一个教训：**只删播种器、不删已播种的卡，在测试机上看不出来** ——
 * 因为测试机做过 `pm clear`（数据全清）。测试机的干净掩盖了真机的不干净。
 *
 * ## 双判据（缺一不可）
 *
 * ```text
 *   ① 文件名前缀 `测试用-`          —— 我们播的那张就叫「测试用-夜航小助手.png」
 *   ② PNG 内 `character_version` 值 —— 我们播的卡写的是 `test-asset`
 * ```
 *
 * 为什么要两条：只有文件名的话，用户自己建一张叫「测试用-xxx」的卡会被误删；
 * 只有 version 的话，别人分享的卡如果恰好写了 `test-asset` 也会被误删。
 * **两条同时命中才算**，误删概率低到可以忽略。
 *
 * ## 为什么删之前要提示
 *
 * PLAN 的原文要求：「删之前给一句提示，别静默删用户目录里的文件」。
 * 角色卡是用户数据 —— 哪怕它看起来像测试残留，也可能被用户改成了自己的卡。
 * 所以：**删 + 明确告诉用户删了什么**，而不是静默消失。
 */

/** 测试卡的文件名前缀 */
export const TEST_CARD_NAME_PREFIX = '测试用-';

/**
 * 测试卡的 `character_version` 标记。
 *
 * 与已删除的 `TestCardSeeder.kt` 里写进 PNG 的值一致（`test-asset`）。
 * 那个文件删了，但**已经播出去的卡上还带着这个标记** —— 它是识别它们的唯一线索。
 */
export const TEST_CARD_VERSION_MARKER = 'test-asset';

/** 一张卡的两个识别特征 */
export interface CardIdentity {
  /** 文件名（含扩展名），如 `测试用-夜航小助手.png` */
  fileName: string;
  /**
   * PNG 里读到的 `character_version`。
   *
   * 读不到时为 `null` —— **不要传空串**：空串是"读到了但是空的"，
   * 与"根本没读到"是两件事。判据对前者可以下结论，对后者只能靠文件名。
   */
  characterVersion: string | null;
}

/**
 * 这张卡是不是我们播的内置测试卡。
 *
 * @returns 真 = 命中双判据，可以删
 */
export function isBuiltinTestCard(identity: CardIdentity): boolean {
  const name = identity.fileName.trim();
  if (name === '') return false;

  /* 前置：必须是 PNG（角色卡只能是 PNG；别的文件一律不碰） */
  if (!name.toLowerCase().endsWith('.png')) return false;

  /*
   * 判据 ①：文件名前缀。
   * 用 `startsWith` 而不是 `includes` —— 「我的测试用-xxx」这种名字
   * 是用户的卡，不该被当测试残留删掉。
   */
  const hasNamePrefix = name.startsWith(TEST_CARD_NAME_PREFIX);
  if (!hasNamePrefix) return false;

  /*
   * 判据 ②：version 标记。
   * `null`（读不到）**不算命中** —— 宁可留着一张没人用的卡，
   * 也不能因为"读不出内容"就把用户可能改过的卡删掉。
   */
  const version = identity.characterVersion;
  if (version === null) return false;
  if (version.trim() !== TEST_CARD_VERSION_MARKER) return false;

  return true;
}

/**
 * 从一批卡里挑出要删的。
 *
 * 抽成纯函数是为了能单测：Kotlin 侧只负责"读出文件名与 version、
 * 把命中的删掉"，判断统一在这里 —— 免得两份实现漂移。
 */
export function pickBuiltinTestCards(cards: readonly CardIdentity[]): CardIdentity[] {
  return cards.filter((one) => isBuiltinTestCard(one));
}

/** 给用户看的一句话（非打断式提示用） */
export function describeRemovedTestCards(removed: readonly string[]): string {
  if (removed.length === 0) return '';
  if (removed.length === 1) {
    return `已清理内置测试卡「${stripPngSuffix(removed[0] ?? '')}」。它是早期版本的验证素材，不是你的数据。`;
  }
  return `已清理 ${String(removed.length)} 张内置测试卡（${removed
    .map((one) => `「${stripPngSuffix(one)}」`)
    .join('、')}）。它们是早期版本的验证素材，不是你的数据。`;
}

function stripPngSuffix(name: string): string {
  return name.replace(/\.png$/i, '');
}
