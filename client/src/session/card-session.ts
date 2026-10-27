/**
 * 编辑会话模型（T9.1）——纯逻辑，无 DOM、无 CodeMirror、无 Tauri 依赖。
 *
 * 为什么单独抽一层：多标签并行编辑的本质难点不是 UI，而是**状态隔离**。
 * 只要有一处状态是共享的（哪怕只是共用了一个 card 子对象），
 * A 卡的编辑就会渗到 B 卡，而且这种 bug 极难复现、极难定位。
 * 所以这里把「一张打开着的卡的全部可变状态」收拢成一个对象，
 * 并且用两道机制保证隔离：
 *   1. 构造与替换时**深拷贝**，两个会话不可能共享同一个子对象；
 *   2. 内容更新走**不可变**路径（每次产出新对象），旧引用自然失效。
 *
 * 这一层可以在 Node 里直接单测（见 test/card-session.test.mjs），
 * 不需要浏览器，也不需要起服务端。
 */

import {
  createEmptyCard,
  type AuditReport,
  type BlockId,
  type UnifiedCard,
  type WorldbookImportResult,
} from '@tcs/shared';

import { serializeCard, setBlockText } from '../editor/block-doc.ts';
import { generateCardId, readCardIdFromCard, validateCardId } from './card-id.ts';
import type { PngSource } from './png-source.ts';

/** 未命名卡在标签栏与标题上的占位文本 */
export const UNNAMED_CARD_LABEL = '未命名';

/** 未落盘卡在标签栏上的脏标记字符（需求 F2.2） */
export const DIRTY_MARK = '●';

/** 会话内的审计缓存 */
export interface SessionAudit {
  report: AuditReport;
  /** 生成这份报告时的内容指纹；用于判断缓存是否已过期 */
  fingerprint: string;
}

export interface CardSessionOptions {
  /** 卡数据。会被深拷贝，调用方后续修改原对象不会影响会话 */
  card: UnifiedCard;
  /** 会话 id；不传则自动生成。测试里注入固定值便于断言 */
  id?: string;
  /** 关联的磁盘文件路径；未落盘为 null（需求 F1.1「未落盘状态」） */
  filePath?: string | null;
  /** 平台规则 id */
  platformId?: string;
  /** 高亮方案 id */
  highlightId?: string;
  /** TXT 预设 id；null 表示未选择预设 */
  presetId?: string | null;
  /**
   * 角色卡 ID（F11）。**创建时给定、之后不可变**。
   * 不传时：先从卡数据的 extensions.tcs.cardId 读；再没有就按角色名自动生成。
   */
  cardId?: string;
  /**
   * 服务端主键（现有同步接口用）。
   *
   * 与 cardId 的区别：这是**服务端在自己那边生成的**主键，上传后才存在；
   * 而 cardId 是创建卡片时就定下的稳定标识。
   * T9.7（按 ID 归档）落地后两者会收敛 —— 服务端直接用 cardId 作主键，
   * 届时这个字段应当删除，不要留两份真相。
   */
  syncCardId?: string | null;
}

/**
 * 会话 id 生成。
 *
 * 用 `crypto.randomUUID` 而不是自增计数器：多标签场景下会话可能被关闭后重建，
 * 计数器会重复，而 id 重复会让「切回某个标签」这类逻辑静默命中错误的会话。
 */
function createSessionId(): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  // 极老环境兜底：时间戳 + 随机；只要求进程内唯一即可
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 深拷贝卡数据。
 *
 * 用 `structuredClone` 而不是 JSON round-trip：后者会丢掉 `undefined` 与
 * 特殊数值（NaN/Infinity），而卡片模型里 passthrough 可能带着这类值。
 * 卡片本身是纯 JSON 结构，structuredClone 完全够用且语义更准。
 */
function cloneCard(card: UnifiedCard): UnifiedCard {
  if (typeof structuredClone === 'function') {
    return structuredClone(card);
  }
  return JSON.parse(JSON.stringify(card)) as UnifiedCard;
}

/**
 * 一张卡的一次「打开着的编辑会话」。
 *
 * 关键语义：
 *   · `dirty` 是**会话级**标记（卡有未落盘修改），与 `CardBlock.dirty`
 *     （板块正文是否需要回写）不是一回事，别混用；
 *   · `presetId` 变化**会**置脏——预设决定导出时的标题与板块顺序，
 *     换预设等于换了导出产物（见 docs/15 §1）；
 *   · `platformId` / `highlightId` 变化**不**置脏——它们只影响校验与着色，
 *     不改变导出的 JSON 内容；
 *   · 内容一变，审计缓存立即标记过期（UI 有防抖重算，但判断"过期"必须即时）。
 */
export class CardSession {
  readonly id: string;

  #card: UnifiedCard;
  #filePath: string | null;
  #dirty: boolean;
  #audit: SessionAudit | null = null;
  #auditStale = false;
  #platformId: string;
  #highlightId: string;
  #presetId: string | null;
  #syncCardId: string | null;
  #lastUploadedSeq: number | null = null;
  /**
   * 世界书的导入来源（T10.9）。
   *
   * 存在**会话**里而不是 App 上：它描述"这张卡的世界书是从哪个文件导入的"，
   * 和 filePath / syncCardId 一样属于卡的身份。放在 App 上会在切标签时串卡 ——
   * 拿 A 卡的原文去写回 B 卡，是那种"导出后才发现内容不对"的错误。
   */
  #worldbookSource: WorldbookImportResult | null = null;
  /**
   * PNG 卡的原图来源（v0.1.4 / T12.4，决策 #165/#168）。
   *
   * 与 `#worldbookSource` 同一条理由：那张图是"这张卡的来源"，
   * 挂在 App 上会在切标签时串卡 —— 用户导出 B 卡却拿到 A 卡的封面，
   * 而且看起来完全正常。
   *
   * 存**完整 PNG 字节**（不是 ImageData）：导出时直接
   * `buildPngCard(原图, 新 JSON)`，像素逐字节不变（D1）。
   */
  #pngSource: PngSource | null = null;
  readonly #cardId: string;

  constructor(options: CardSessionOptions) {
    this.id = options.id ?? createSessionId();
    this.#card = cloneCard(options.card);
    this.#filePath = options.filePath ?? null;
    // 已落盘的卡初始为干净；未落盘的新建卡也先当干净——
    // 「新建但没动过」不该显示为「已修改未落盘」，否则标签一打开就是脏的。
    this.#dirty = false;
    this.#platformId = options.platformId ?? 'sillytavern';
    this.#highlightId = options.highlightId ?? 'default';
    this.#presetId = options.presetId ?? null;
    this.#cardId = resolveCardId(options);
    this.#syncCardId = options.syncCardId ?? null;
  }

  // ── 读：基本身份 ────────────────────────────────────────

  /** 卡数据（只读视图）。请勿原地修改：改内容请走 setBlockText / replaceCard */
  get card(): UnifiedCard {
    return this.#card;
  }

  get filePath(): string | null {
    return this.#filePath;
  }

  /** 是否已关联磁盘文件（false = 未落盘，见需求 F1.1） */
  get persisted(): boolean {
    return this.#filePath !== null;
  }

  /** 世界书导入来源（T10.9）：未改动时导出走逐字节写回 */
  get worldbookSource(): WorldbookImportResult | null {
    return this.#worldbookSource;
  }

  setWorldbookSource(source: WorldbookImportResult | null): void {
    this.#worldbookSource = source;
  }

  /**
   * 这张卡的原图（PNG 导入才有；导出 PNG 时作为"原图"候选，D4）。
   *
   * 换卡内容（`replaceCard`）**不清空它** —— 内容与封面是两件事，
   * 用户改完正文仍然该用自己的封面导出。只有明确换了图才覆盖。
   */
  get pngSource(): PngSource | null {
    return this.#pngSource;
  }

  setPngSource(source: PngSource | null): void {
    this.#pngSource = source;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  /** 标签栏 / 标题栏显示名：meta.name 为空则「未命名」 */
  get displayName(): string {
    const name = this.#card.meta.name.trim();
    return name === '' ? UNNAMED_CARD_LABEL : name;
  }

  /** 标签栏文本：卡名 + 脏标记（需求 F2.2） */
  get label(): string {
    return this.#dirty ? `${this.displayName} ${DIRTY_MARK}` : this.displayName;
  }

  // ── 读：规则选择 ────────────────────────────────────────

  get platformId(): string {
    return this.#platformId;
  }

  get highlightId(): string {
    return this.#highlightId;
  }

  get presetId(): string | null {
    return this.#presetId;
  }

  // ── 读：服务端关联 ──────────────────────────────────────

  /**
   * 角色卡 ID（F11）。创建后不可变 —— 这里只有 getter，没有 setter。
   *
   * 刻意不提供 `setCardId`：服务端靠这个 ID 认卡，改了等于换一张卡，
   * 会让同一个 ID 下的历史版本混进两个不同角色的内容，回滚时回滚到别人身上。
   */
  get cardId(): string {
    return this.#cardId;
  }

  get syncCardId(): string | null {
    return this.#syncCardId;
  }

  // ── 读：审计缓存 ────────────────────────────────────────

  /** 当前有效的审计报告；过期时返回 null（UI 应重算） */
  get audit(): AuditReport | null {
    return this.#auditStale ? null : (this.#audit?.report ?? null);
  }

  /** 是否有缓存但因内容变化而失效 */
  get auditStale(): boolean {
    return this.#auditStale;
  }

  // ── 写：内容 ────────────────────────────────────────────

  /**
   * 更新某个板块的正文。
   * 返回是否**实际**发生变化（内容相同则不动，也不置脏）。
   *
   * worldbookIssues 来自 shared 的解析结果，UI 需要展示，所以一并返回。
   */
  setBlockText(
    blockId: BlockId,
    text: string,
  ): {
    changed: boolean;
    worldbookIssues: Array<{ severity: 'error' | 'warning'; message: string; line?: number }>;
  } {
    const result = setBlockText(this.#card, blockId, text);
    if (!result.changed) {
      return { changed: false, worldbookIssues: [] };
    }
    this.#card = result.card;
    this.#onContentChanged();
    return { changed: true, worldbookIssues: result.worldbookIssues };
  }

  /** 整卡替换（打开文件 / 导入 TXT / 应用预设后重排）。会深拷贝，不共享引用 */
  replaceCard(card: UnifiedCard): void {
    this.#card = cloneCard(card);
    this.#onContentChanged();
  }

  /** 改名。名字属于导出内容，因此置脏 */
  setName(name: string): void {
    if (this.#card.meta.name === name) return;
    this.#card = { ...this.#card, meta: { ...this.#card.meta, name } };
    this.#onContentChanged();
  }

  // ── 写：落盘状态 ────────────────────────────────────────

  /**
   * 标记为已保存。
   * @param filePath 保存到的路径；不传则沿用当前路径（另存为时传新路径）
   */
  markSaved(filePath?: string | null): void {
    if (filePath !== undefined) {
      this.#filePath = filePath;
    }
    this.#dirty = false;
  }

  /** 显式置脏（用于"另存为后仍与原文件不同"这类需要手控的场景） */
  markDirty(): void {
    this.#dirty = true;
  }

  // ── 写：审计缓存 ────────────────────────────────────────

  /** 存入审计结果，并记录当时的指纹 */
  setAudit(report: AuditReport): void {
    this.#audit = { report, fingerprint: this.fingerprint() };
    this.#auditStale = false;
  }

  /** 手动使审计缓存失效（例如切换平台规则后需要按新规则重算） */
  invalidateAudit(): void {
    if (this.#audit === null) return;
    this.#auditStale = true;
  }

  // ── 写：规则选择 ────────────────────────────────────────

  /** 切平台规则：只影响校验，不改变导出内容，因此不置脏 */
  setPlatformId(id: string): void {
    if (this.#platformId === id) return;
    this.#platformId = id;
    // 换了规则，之前的审计结论不再适用
    this.invalidateAudit();
  }

  /** 切高亮方案：只影响编辑器着色，不置脏，不影响审计 */
  setHighlightId(id: string): void {
    if (this.#highlightId === id) return;
    this.#highlightId = id;
  }

  /**
   * 切 TXT 预设。
   *
   * **会置脏**：预设决定导出时的板块标题与顺序，换预设等于换了导出产物。
   * 这一点容易漏判——预设看起来像"显示设置"，实际是产出的一部分。
   */
  setPresetId(id: string | null): void {
    if (this.#presetId === id) return;
    this.#presetId = id;
    this.#dirty = true;
  }

  // ── 写：服务端关联 ──────────────────────────────────────

  /**
   * 记录「本会话的内容对应远端哪个版本」—— 上传成功、取回某版、回滚之后都调它。
   *
   * 为什么 cardId 与 seq 必须一起记：分叉判定的条件是
   * 「远端最新 seq ≠ 我上次上传的 seq」，而这个比较**只对同一个远端 ID 成立**。
   * 只记 ID 不记 seq，就永远判不出分叉；只记 seq 不记 ID，换卡后基线会串到别人身上。
   */
  noteRemoteVersion(cardId: string, seq: number): void {
    this.#syncCardId = cardId;
    this.#lastUploadedSeq = seq;
  }

  /** 上次上传（或取回/回滚）对应的远端 seq；null = 本会话还没和远端对齐过 */
  get lastUploadedSeq(): number | null {
    return this.#lastUploadedSeq;
  }

  /**
   * 只设远端关联 ID、不知道 seq 时用（老调用点）。
   *
   * 会把基线清空 —— 因为"换了一张远端卡"后，之前记的 seq 属于另一张卡，
   * 拿它做分叉比较会给出错误结论。
   */
  setSyncCardId(id: string | null): void {
    this.#syncCardId = id;
    this.#lastUploadedSeq = null;
  }

  // ── 派生：指纹 ──────────────────────────────────────────

  /**
   * 内容指纹。
   *
   * 用途有二：
   *   1. 判断审计缓存是否对应"当前内容"；
   *   2. 隔离性测试里断言「B 卡内容未被 A 卡的操作影响」。
   *
   * 这里直接用与落盘一致的序列化结果（serializeCard），
   * 所以"指纹相同"等价于"存到磁盘的字节相同"，语义比另做一套摘要更可靠。
   */
  fingerprint(): string {
    return serializeCard(this.#card);
  }

  // ── 内部 ────────────────────────────────────────────────

  #onContentChanged(): void {
    this.#dirty = true;
    this.invalidateAudit();
  }
}

/**
 * 决定这张会话的 cardId。
 *
 * 优先级（F11.2）：
 *   1. 调用方显式传入 → 校验后使用（非法直接抛，不能带着坏 ID 进会话）；
 *   2. 卡数据里已有（`extensions.tcs.cardId`）→ 用它的，保证「再次打开同一张卡」ID 不变；
 *   3. 都没有 → 按角色名自动生成（导入的外部 JSON 走这条路）。
 *
 * 第 3 步是"生成"而不是"报错"，因为导入一张没有 ID 的卡是完全正常的使用场景；
 * 但生成后要**回填进卡数据**（由调用方在保存/上传时做，见 F11.2），
 * 否则关掉再打开又会得到一个新 ID，同一个角色会散成多张卡。
 */
function resolveCardId(options: CardSessionOptions): string {
  if (options.cardId !== undefined) {
    const checked = validateCardId(options.cardId);
    if (!checked.ok) {
      throw new Error(`角色卡 ID 不合法：${checked.message ?? options.cardId}`);
    }
    return checked.id;
  }

  const existing = readCardIdFromCard(options.card);
  if (existing !== null) return existing;

  return generateCardId(options.card.meta.name);
}

/** 新建一张空白会话（需求 F1：客户端内新建，无需导入文件） */
export function createBlankSession(
  options: Omit<CardSessionOptions, 'card'> & { name?: string } = {},
): CardSession {
  const card = createEmptyCard(options.name ?? '');
  return new CardSession({ ...options, card });
}
