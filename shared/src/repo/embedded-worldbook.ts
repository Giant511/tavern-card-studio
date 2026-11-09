/**
 * 把角色卡里**内嵌的** `character_book` 落成 ST 单独的世界书（2026-11-06）。
 *
 * ## 用户报的
 *
 * > 从仓库导入的角色明明是包含角色世界书的，但是世界书编辑里面却没有。
 *
 * ## 真因：写入路径绕过了 ST 的导入流程
 *
 * 三种"带世界书的卡"在 ST 里的落法完全不同：
 *
 * ```text
 *   ST 自己导入卡（设置页 / 拖文件）
 *     ⇒ ST 读 character_book，**自动**抽成 worlds/<name>.json，
 *        并在卡的 extensions.world 里写上那个名字
 *
 *   我们导入（写 PNG 到 characters/）
 *     ⇒ 只放了一个 PNG 文件，character_book 还躺在卡里
 *     ⇒ 世界书列表扫的是 worlds/ 目录 ⇒ 自然看不到
 * ```
 *
 * 也就是说卡里的世界书**没丢**，但它不在 ST 会去读的地方。
 *
 * ## 所以要做两件事，缺一不可
 *
 * ```text
 *   ① 把 character_book.entries 转成 ST world info 格式，写到 worlds/<名字>.json
 *   ② 在卡的 extensions.world 里写上同一个名字
 * ```
 *
 * 只做①：世界书在列表里能看到，但**不会对这个角色自动生效**
 * （ST 靠 `extensions.world` 决定给这个角色挂哪本）。
 * 只做②：卡指向一本不存在的书 —— 更糟，表现为"世界书是空的"。
 *
 * ## 为什么转换要逐字段做，不能只搬 key/content
 *
 * ST 的 world info 与 CCv2 的 character_book 条目**字段名不同**：
 *
 * ```text
 *   character_book        world info
 *   keys            →     key
 *   secondary_keys  →     keysecondary
 *   enabled         →     disable（取反！）
 *   insertion_order →     order
 *   priority        →     order（ST 没有 priority）
 * ```
 *
 * 只搬 `key` 与 `content` 的话，**常驻条目会变成关键词触发的**、
 * 被禁用的条目会变成启用的 —— 那比"没有世界书"更难发现。
 */

/** ST world info 的单个条目（只列我们会写/需要默认的字段） */
interface StWorldInfoEntry {
  uid: number;
  key: string[];
  keysecondary: string[];
  comment: string;
  content: string;
  constant: boolean;
  vectorized: boolean;
  selective: boolean;
  selectiveLogic: number;
  addMemo: boolean;
  order: number;
  position: number;
  disable: boolean;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean;
  probability: number;
  useProbability: boolean;
  depth: number;
  group: string;
  groupOverride: boolean;
  groupWeight: number;
  scanDepth: number | null;
  caseSensitive: number | null;
  matchWholeWords: number | null;
  useGroupScoring: number | null;
  automationId: string;
  role: number | null;
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  displayIndex: number;
}

/** 转出来的结果 */
export interface EmbeddedWorldbookPlan {
  /** ST 世界书名（= `worlds/<name>.json` 的文件名主干） */
  name: string;
  /** 可以直接喂给 `/api/worldinfo/import` 的 entries 对象 */
  entries: Record<string, StWorldInfoEntry>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((one): one is string => typeof one === 'string');
}

/** 从卡 JSON 顶层挖出 worldbook 的对象（v3 在 data 里，v2 也在 data 里，v1 在顶层） */
export function readEmbeddedWorldbook(cardJson: unknown): Record<string, unknown> | null {
  if (!isObject(cardJson)) return null;

  const data = isObject(cardJson['data']) ? cardJson['data'] : null;
  const fromData = data === null ? undefined : data['character_book'];
  const fromRoot = cardJson['character_book'];

  for (const candidate of [fromData, fromRoot]) {
    if (isObject(candidate)) return candidate;
  }
  return null;
}

/**
 * 世界书名。
 *
 * 优先用 `character_book.name`（作者起的名，语义最好），
 * 没有就退到卡名 —— 用户在世界书列表里能用角色名认出它。
 *
 * ★ 名字要过一遍文件系统净化：它最终是文件名。
 */
export function worldbookNameFor(
  book: Record<string, unknown>,
  cardName: string,
): string {
  const own = str(book['name']).trim();
  const base = own !== '' ? own : cardName.trim();
  return sanitizeWorldName(base);
}

/** 文件名净化（与 `sanitizeAvatarBase` 同一套规则，但上限更短） */
export function sanitizeWorldName(name: string): string {
  let out = '';
  for (const ch of Array.from(name)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if ('/\\:*?"<>|'.includes(ch)) continue;
    out += ch;
  }
  out = out.trim().replace(/^\.+/, '').trim();
  const chars = Array.from(out);
  if (chars.length > 48) out = chars.slice(0, 48).join('').trim();
  return out === '' ? '未命名世界书' : out;
}

/**
 * `character_book` → ST world info entries。
 *
 * 空条目（既没有 content 也没有 key）会被**丢掉**：ST 里那样的条目是
 * 一份永远不触发的空壳，只会让用户以为"世界书导入了一半"。
 */
export function convertEmbeddedWorldbook(
  cardJson: unknown,
  options: { cardName: string; forceName?: string },
): EmbeddedWorldbookPlan | null {
  const book = readEmbeddedWorldbook(cardJson);
  if (book === null) return null;

  const rawEntries = book['entries'];
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) return null;

  const entries: Record<string, StWorldInfoEntry> = {};
  let index = 0;

  for (const raw of rawEntries) {
    if (!isObject(raw)) continue;

    const content = str(raw['content']);
    const keys = strArray(raw['keys']);
    const secondary = strArray(raw['secondary_keys']);
    if (content.trim() === '' && keys.length === 0 && secondary.length === 0) continue;

    /*
     * 编号用连续序号而不是源里的 `id`：源 `id` 可能重复、可能缺，
     * 而 ST 的 entries 是"键 = 序号"的字典，键重复会覆盖掉一条。
     */
    const uid = index;
    entries[String(uid)] = {
      uid,
      key: keys,
      keysecondary: secondary,
      comment: str(raw['comment']) || str(raw['name']),
      content,
      constant: bool(raw['constant']),
      vectorized: false,
      selective: bool(raw['selective'], secondary.length > 0),
      selectiveLogic: 0,
      addMemo: true,
      /*
       * `order` 取 `insertion_order`：ST 用它决定注入顺序。
       * 源里没有就给 100（ST 新建条目的默认值），不是 0 ——
       * 0 会让所有条目排在默认值前面，顺序全乱。
       */
      order: num(raw['insertion_order'], 100),
      /*
       * `position`：CCv2 用 0/1（before/after char），也允许字符串
       * （`before_char` / `after_char`）。ST 只认数字。
       */
      position: positionOf(raw['position']),
      /*
       * ★ `disable` 是 `enabled` 的**取反**。
       *
       * 源里 `enabled: false` ⇒ 这里 `disable: true`。
       * 直接搬成 `disable: raw.enabled` 会把启用/禁用整个反过来 ——
       * 作者特意关掉的条目会全部生效。
       */
      disable: !bool(raw['enabled'], true),
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: false,
      probability: 100,
      useProbability: true,
      depth: 4,
      group: '',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      caseSensitive: bool(raw['case_sensitive']) ? 1 : null,
      matchWholeWords: null,
      useGroupScoring: null,
      automationId: '',
      role: null,
      sticky: null,
      cooldown: null,
      delay: null,
      displayIndex: index,
    };
    index += 1;
  }

  if (Object.keys(entries).length === 0) return null;

  return {
    name: options.forceName ?? worldbookNameFor(book, options.cardName),
    entries,
  };
}

function positionOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === 'after_char') return 1;
  /* `before_char` / 缺失 / 奇怪的值 → 0（ST 的默认：角色设定之前） */
  return 0;
}

/**
 * 把世界书名写进卡的 `extensions.world`。
 *
 * 返回**新的** JSON 文本（不改原对象：调用方可能还要用原文本）。
 *
 * ## v2 / v3 都要写
 *
 * ST 读卡时先看 `data.extensions.world`（v2/v3），旧卡才看顶层
 * `extensions.world`。两个都写一份最稳：某些第三方前端只认顶层。
 */
export function attachWorldToCard(
  cardJson: unknown,
  worldName: string,
): unknown {
  if (!isObject(cardJson)) return cardJson;

  const next: Record<string, unknown> = { ...cardJson };

  const writeInto = (holder: Record<string, unknown>): Record<string, unknown> => {
    const ext = isObject(holder['extensions']) ? { ...holder['extensions'] } : {};
    ext['world'] = worldName;
    return { ...holder, extensions: ext };
  };

  const data = isObject(next['data']) ? next['data'] : null;
  if (data !== null) next['data'] = writeInto(data);

  /*
   * 顶层也写（v1 卡只有顶层；v2 卡顶层那份是向后兼容的副本）。
   *
   * ★ 不能只写 `data`：v1 卡没有 `data` 段，只写它等于没写；
   *   而 v2/v3 的顶层副本也有前端在读。
   */
  return writeInto(next);
}
