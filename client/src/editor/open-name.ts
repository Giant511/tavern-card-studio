/**
 * 从文件名推导角色名（v0.1.2 反馈项三 / T10.28）。
 *
 * 场景：零标签状态下「打开…」选了一个 TXT/JSON，程序要自动建一张卡 ——
 * 而一张卡必须有名字（`meta.name` 会写进导出的 JSON，也是标签栏的显示文本）。
 * 这时唯一现成的信息就是文件名。
 *
 * 纯函数、单独一层：这条规则有四个边界（去扩展名、清非法字符、截断、重名加序号），
 * 每一个都能悄悄产出"看着能用的坏名字"，塞在 `openCard()` 里就只能靠手点验证。
 */

/** `meta.name` 在 DOM 输入框上的上限是 120，这里留一半：标签栏也要放得下 */
export const DERIVED_NAME_MAX = 60;

/** Windows 文件名非法字符 + 控制字符。冒号在 Windows 上非法，在别的平台合法，一并清掉。 */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * 从路径/文件名取角色名。
 *
 * @param fileName 可以带目录（`C:\a\b\卡.txt`、`/home/x/卡.json` 都行）
 * @param existingNames 已打开卡的名字（重名时追加 ` (2)`、` (3)`…）
 */
export function deriveCardNameFromFile(fileName: string, existingNames: readonly string[] = []): string {
  const base = baseNameOf(fileName);
  const withoutExt = stripExtension(base);
  const cleaned = sanitizeName(withoutExt);
  const unique = uniqueAmong(cleaned, existingNames);
  return truncateName(unique);
}

/** 取最后一段（同时处理 `/` 与 `\`：路径可能来自任一侧） */
function baseNameOf(fileName: string): string {
  const cut = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  return cut >= 0 ? fileName.slice(cut + 1) : fileName;
}

/**
 * 只去掉**最后一个**扩展名。
 *
 * 不用 `split('.')[0]`：`林晚照.v2.txt` 会变成 `林晚照`，把用户写在名字里的
 * `.v2` 也吃掉 —— 那是信息，不是后缀。
 */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  // 点在开头（`.txt`）说明这个文件**只有扩展名**，没有名字部分 ——
  // 返回空串让上层走兜底。否则会得到一个叫 "txt" 的角色（实测过）。
  if (dot === 0) return '';
  if (dot < 0) return name;
  return name.slice(0, dot);
}

function sanitizeName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL, '_')
    // 多个连续下划线压成一个：`a:::b` → `a_b` 而不是 `a___b`
    .replace(/_{2,}/g, '_')
    // 首尾空白与结尾的点（Windows 不允许文件名以点结尾，静默去掉比让用户看到怪名字好）
    .replace(/^[\s.]+|[\s.]+$/g, '')
    // 只剩一串下划线（原名全是非法字符，如 `___.txt`）也算没有名字：
    // 留着 `_` 会变成标签栏上一个看不懂的单字符标签
    .replace(/^_+$/, '');
  // 全空（文件名是 `___` 或只有一个扩展名）时给个能认出来的兜底
  return cleaned === '' ? '未命名角色' : cleaned;
}

/**
 * 让角色名在本地已打开的标签里唯一（重名追加 ` (2)`）。
 *
 * 抽成导出函数供**两条**自动建卡路径共用（v0.1.3 追加项三）：
 *   · 零标签「打开…」按文件名建卡（`deriveCardNameFromFile`）；
 *   · 零标签从服务端「取回 / 回滚」建卡（名字来自 `card.meta.name`）。
 * 两处若各写一份，序号规则迟早不一致 —— 一个 ` (2)`、一个 `-2`。
 */
export function uniqueCardName(name: string, existingNames: readonly string[] = []): string {
  return truncateName(uniqueAmong(sanitizeName(name), existingNames));
}

/** 重名时追加 ` (2)`；再重名 ` (3)`…（比 `-2` 更像人起的名字，也不易与文件名冲突） */
function uniqueAmong(name: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map((item) => item.trim().toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${name} (${String(index)})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${name} (${String(Date.now())})`;
}

/** 截断到上限。按**码点**切，避免把 emoji / 中文代理对切成半个字符。 */
function truncateName(name: string): string {
  const chars = Array.from(name);
  if (chars.length <= DERIVED_NAME_MAX) return name;
  return chars.slice(0, DERIVED_NAME_MAX).join('').trimEnd();
}
