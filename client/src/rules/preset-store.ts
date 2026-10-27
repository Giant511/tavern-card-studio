/**
 * 用户预设库的**磁盘格式**（v0.1.5 / G5）。
 *
 * ## 为什么存"原始 JSON 文本"而不是解析后的对象
 *
 * 六类预设（平台 / 高亮 / TXT / 世界书 / 初始场景 / 对话示例）的导入函数
 * 都接受**原始文本**，并且各自带着完整的 schema 校验、同 id 覆盖、改名建议。
 * 所以库只需要原样保存用户导入的那段文本，加载时按顺序重新走一遍导入函数：
 *
 *   · 校验只有一份实现，不会出现"手动导入严格、启动加载宽松"的分叉；
 *   · 用户文件里的未知键、键序、注释性字段都原样保留（对象化会丢）；
 *   · 加载时坏条目被**逐条**跳过，而不是整个库读不出来。
 *
 * 代价是文本被 JSON 转义一遍（体积略大、肉眼看是 `\n`）。预设都是几 KB 的
 * 小文件，这个代价换"单一校验入口"是划算的。
 *
 * ## 与 `preset-library.ts` 的分工
 *
 * · `preset-library.ts`：一次导入 → 合并进内存列表（业务语义）；
 * · 本文件：内存列表里的"用户导入项" → 磁盘（序列化/反序列化）。
 *
 * 两者都不做 IO —— 读写由 `contract.readPresetLibrary` / `writePresetLibrary` 负责，
 * 路径由壳解析。渲染层拿不到路径，也就没有"照着约定拼路径"的机会。
 */

/** 六类预设。字符串值就是落盘时的字面量，**改名字等于改格式** */
export type PresetKind = 'platform' | 'highlight' | 'txt' | 'worldbook' | 'greeting' | 'chat-examples';

export const PRESET_KINDS: readonly PresetKind[] = [
  'platform',
  'highlight',
  'txt',
  'worldbook',
  'greeting',
  'chat-examples',
];

export function isPresetKind(value: unknown): value is PresetKind {
  return typeof value === 'string' && (PRESET_KINDS as readonly string[]).includes(value);
}

/** 落盘的一条用户预设 */
export interface PresetLibraryItem {
  kind: PresetKind;
  /**
   * 预设自己的 id（从导入文本里解析出来的）。
   *
   * 存它是为了**去重**：用户改个参数再导一次，内容变了但 id 没变，语义是
   * "更新这一份"。按内容去重会让库随每次微调线性膨胀。
   *
   * 加载时**不依赖**它（那时会重新解析文本，以文本为准）—— 所以旧版本库
   * 里缺这个字段只是失去去重能力，不影响能否读出来。
   */
  id: string | null;
  /**
   * 导入时的文件名/显示名，**只用于诊断与展示**。
   * 不参与去重、不影响加载 —— 真正的身份是 `id`。
   */
  name: string;
  /** 用户导入时的原始 JSON 文本，逐字节保存 */
  text: string;
}

/** 当前磁盘格式版本。**只在结构不兼容时 +1**，加可选字段不算 */
export const PRESET_LIBRARY_VERSION = 1;

/**
 * 库的容量护栏。
 *
 * 为什么要有：库是启动时**同步**读进来逐条校验的，一条几百 KB 的畸形数据
 * 能让启动卡住好几秒，而用户只会看到"软件打开很慢"。上限取够用又不可能
 * 被单个真实预设撞到的值。
 */
export const PRESET_LIBRARY_LIMITS = {
  /** 最多保存多少条（六类合计） */
  maxItems: 200,
  /** 单条原文的 UTF-8 字节上限 */
  maxItemBytes: 1024 * 1024,
} as const;

export interface PresetLibraryParseResult {
  items: PresetLibraryItem[];
  /** 非致命问题（某条坏了/版本不认/超限），要展示给用户 */
  warnings: string[];
  /** 致命问题（根本不是 JSON / 顶层结构不对）。有它就说明整库没读出来 */
  error: string | null;
}

/**
 * 序列化为磁盘文本。
 *
 * 键序固定（version → savedAt → items，items 内部 kind → name → text）：
 * 让 diff 里只出现真正的变化，而不是键序抖动。结尾补换行，与其它
 * JSON 产物一致（`serializePreset` 也这么做）。
 */
export function serializePresetLibrary(items: readonly PresetLibraryItem[], now = new Date()): string {
  const payload = {
    version: PRESET_LIBRARY_VERSION,
    savedAt: now.toISOString(),
    items: items.map((item) => ({
      kind: item.kind,
      id: item.id,
      name: item.name,
      text: item.text,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * 从磁盘文本还原。
 *
 * ## 宽容度分层（照 "坏数据不能让人丢光所有预设" 来定）
 *
 * · 根本不是 JSON、或顶层不是对象 → `error`，`items` 为空（调用方**不要覆盖**原文件）；
 * · `version` 不认识（比当前新） → 尝试按当前格式读，给一条警告。
 *   将来 v2 加了字段，v1 的客户端至少还能把共用部分读出来，而不是拒绝启动；
 * · 单条不合法（缺 kind / 未知 kind / text 不是字符串 / 超限） → 跳过该条 + 警告，
 *   其余照常。**这是最要紧的一条**：一条坏数据不该让另外 5 个预设一起消失。
 *
 * 语义上重复的条目（同 kind 同 id）不在这里合并 —— 那是 `upsertLibraryItem`
 * 的职责（写入时去重），读取时按顺序全部返回，让导入函数自己决定谁覆盖谁。
 */
export function parsePresetLibrary(text: string): PresetLibraryParseResult {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      items: [],
      warnings,
      error: `预设库不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { items: [], warnings, error: '预设库的顶层必须是对象' };
  }

  const record = parsed as Record<string, unknown>;
  const version = record['version'];
  if (typeof version !== 'number') {
    warnings.push('预设库缺少 version 字段，已按当前格式尝试读取');
  } else if (version !== PRESET_LIBRARY_VERSION) {
    warnings.push(
      `预设库版本为 ${String(version)}，当前程序认识 ${String(PRESET_LIBRARY_VERSION)} —— 已按当前格式尽量读取，可能丢失新版本才有的设置`,
    );
  }

  const rawItems = record['items'];
  if (!Array.isArray(rawItems)) {
    return { items: [], warnings, error: '预设库的 items 必须是数组' };
  }

  const items: PresetLibraryItem[] = [];
  for (const [index, raw] of rawItems.entries()) {
    const where = `第 ${String(index + 1)} 条`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push(`${where}不是对象，已跳过`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const kind = entry['kind'];
    if (!isPresetKind(kind)) {
      warnings.push(`${where}的 kind 无法识别（${String(kind)}），已跳过`);
      continue;
    }
    const body = entry['text'];
    if (typeof body !== 'string' || body.trim() === '') {
      warnings.push(`${where}（${kind}）没有内容，已跳过`);
      continue;
    }
    const bytes = byteLength(body);
    if (bytes > PRESET_LIBRARY_LIMITS.maxItemBytes) {
      warnings.push(
        `${where}（${kind}）有 ${String(bytes)} 字节，超过单条上限 ${String(PRESET_LIBRARY_LIMITS.maxItemBytes)}，已跳过`,
      );
      continue;
    }
    if (items.length >= PRESET_LIBRARY_LIMITS.maxItems) {
      warnings.push(`预设库超过 ${String(PRESET_LIBRARY_LIMITS.maxItems)} 条上限，其余已忽略`);
      break;
    }
    const name = typeof entry['name'] === 'string' ? entry['name'] : '';
    const id = typeof entry['id'] === 'string' && entry['id'] !== '' ? entry['id'] : null;
    items.push({ kind, id, name, text: body });
  }

  return { items, warnings, error: null };
}

/**
 * 把一条刚导入成功的预设并入库（写入前调用）。
 *
 * ## 为什么按 `kind + id` 去重而不是"内容相同才去重"
 *
 * 用户改了预设的某个参数再导一次，内容不同但 id 相同 —— 语义上是"更新这一份"。
 * 若按内容去重，库里会留两份同 id 的记录，加载时后者覆盖前者（结果对），
 * 但文件会随着每次微调线性膨胀，而且用户看不出"到底存了几个"。
 *
 * `id` 由调用方提供（它刚走完对应 import 函数，知道 id 是多少）。
 * 拿不到 id（理论上不该发生）时退回按内容去重，**不会**默默存成重复项。
 */
export function upsertLibraryItem(
  items: readonly PresetLibraryItem[],
  kind: PresetKind,
  name: string,
  text: string,
  id: string | null,
): PresetLibraryItem[] {
  const kept = items.filter((item) => {
    if (item.kind !== kind) return true;
    // 有 id 就按 id 认同一份；没 id（解析不出）才退回内容比较
    if (id !== null) return item.id !== id;
    return item.text !== text;
  });
  return [...kept, { kind, id, name, text }];
}

/** 从库里移除一类（或一类里的某个 id）。没有删除 UI 时供测试与将来的清理用 */
export function removeLibraryItem(
  items: readonly PresetLibraryItem[],
  kind: PresetKind,
  id: string | null,
): PresetLibraryItem[] {
  if (id === null) return items.filter((item) => item.kind !== kind);
  return items.filter((item) => item.kind !== kind || item.id !== id);
}

function byteLength(text: string): number {
  // TextEncoder 在浏览器与 Node 都有；用它而不是 text.length ——
  // 中文一个字符 3 字节，按字符数算会把上限放宽三倍
  return new TextEncoder().encode(text).length;
}
