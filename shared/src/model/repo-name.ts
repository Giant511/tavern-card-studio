/**
 * 仓库名校验（v0.1.3 / F1：支持中文）。
 *
 * ## 为什么必须放在 shared
 *
 * 需求原话是「服务端与客户端校验同构（同一套正则来源，禁止两侧各写一份）」。
 * 这不是洁癖：两侧各写一份的典型后果是**客户端放行、服务端拒绝**（或者反过来），
 * 用户看到的永远是"填了但保存不了"，而两边代码都"看起来对"。
 * 所以判定逻辑只在这里存在，`server/src/storage/repos.ts` 与客户端输入框都调它。
 *
 * ## 为什么用黑名单而不是白名单
 *
 * 需求给的是**排除集**（控制字符、`/ \ : * ? " < > |`、首尾空白），不是"只准这些字"。
 * 白名单要穷举 CJK 基本区 / 扩展 A / 扩展 B / 兼容表意文字 / 全角标点 / 假名 / 谚文……
 * 漏一个区段就是"某些中文名建不了仓库"，而且不同 Unicode 版本还会变。
 * 黑名单只挡**确实会坏事**的字符，新字符默认能用。
 *
 * ## 排除集为什么比需求多几类
 *
 * 需求写"控制字符"，实现上按 Unicode 类别取宽了一点，理由是这几类**肉眼看不见但能骗人**：
 *
 *   · `Cf`（格式字符）：`U+202E` 这类双向覆盖能把「abc」显示成「cba」——
 *     治理页要让管理员按名字辨认仓库，被 bidi 覆盖等于给了伪造名字的手段；
 *   · 零宽字符（`U+200B`/`200C`/`200D`）与 BOM（`U+FEFF`）：两个"看起来一样"的名字
 *     可以并存，用户完全无法分辨，而唯一性检查也帮不上（字节不同）；
 *   · `C1` 控制区（`U+0080`–`U+009F`）：需求说的"控制字符"通常只想到 C0，但这区间同样不可见。
 *
 * 这三类都不是正常命名会用到的东西，挡掉不影响任何合法中文名。
 */

/** 路径/文件名保留字符：跨平台都会出问题，且它们在 URL 与命令行里要转义 */
const FORBIDDEN_PUNCTUATION = /[/\\:*?"<>|]/;

/**
 * 单个码点是否不允许出现。
 *
 * 分成几段写而不是一条大正则，是因为每一段都有各自的理由（见文件头），
 * 将来要放宽某一类时能单独改、也能单独测。
 */
function isForbiddenCodePoint(codePoint: number): boolean {
  // C0 控制字符（含 \t \n \r）与 NUL
  if (codePoint <= 0x1f) return true;
  // DEL 与 C1 控制区
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true;
  // 双向覆盖：U+202A–U+202E（LRE/RLE/PDF/LRO/RLO）
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true;
  // 双向隔离：U+2066–U+2069（LRI/RLI/FSI/PDI）
  if (codePoint >= 0x2066 && codePoint <= 0x2069) return true;
  // 零宽连接符/非连接符、零宽空格、BOM
  if (codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d || codePoint === 0xfeff) return true;
  return false;
}

/** 仓库名允许的最大长度（码点，不是 UTF-16 长度） */
export const REPO_NAME_MAX_CODEPOINTS = 64;

export type RepoNameIssue = 'empty' | 'too-long' | 'edge-whitespace' | 'forbidden-char' | 'control-char';

export interface RepoNameCheck {
  ok: boolean;
  /** 通过时的规范名字（未通过时为空串） */
  name: string;
  /** 唯一性键（`name_key`）；未通过时为空串 */
  key: string;
  issue?: RepoNameIssue;
  /** 直接可上屏的错误文案 */
  message?: string;
}

/**
 * 仓库名的唯一性键。
 *
 * 语义与 v0.1.2 完全一致（trim + 小写）—— 需求要求「唯一性语义不变」：
 *   · 中文没有大小写，`toLowerCase` 对 CJK 是恒等变换，所以**中文原样保留**；
 *   · 英文名仍然大小写不敏感（「Default」与「default」视为同一个仓库）。
 *
 * **刻意不做 Unicode 规范化**（NFC/NFD）：需求要求"对中文原样保留"。
 * 代价是"全角 Ａ"与"半角 A"是两个不同的仓库名 —— 这是可预期的行为
 * （用户自己填的两种写法本来就不同），比悄悄改写用户输入更安全。
 */
export function repoNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 校验仓库名。**服务端与客户端唯一入口**。
 *
 * 输入应当是用户**原始输入**（不要先 trim）：本函数会明确拒绝首尾空白，
 * 而不是静默替用户改名字。静默 trim 的问题是"存进去的东西和用户以为的不一样"，
 * 而仓库名是用户之后要用来指定上传目标的东西 —— 差一个空格就找不到。
 */
export function validateRepoName(raw: string): RepoNameCheck {
  if (raw === '') {
    return { ok: false, name: '', key: '', issue: 'empty', message: '仓库名不能为空' };
  }

  // 首尾空白：明确拒绝，不静默 trim（见上方注释）
  if (raw !== raw.trim()) {
    return {
      ok: false,
      name: '',
      key: '',
      issue: 'edge-whitespace',
      message: '仓库名首尾不能有空白（中间可以有）',
    };
  }

  if (raw.trim() === '') {
    return { ok: false, name: '', key: '', issue: 'empty', message: '仓库名不能为空' };
  }

  // 按码点计数：`'😀'.length === 2`，用 length 会把表情符号算成两个字符
  const codePoints = [...raw];
  if (codePoints.length > REPO_NAME_MAX_CODEPOINTS) {
    return {
      ok: false,
      name: '',
      key: '',
      issue: 'too-long',
      message: `仓库名最多 ${String(REPO_NAME_MAX_CODEPOINTS)} 个字符，当前 ${String(codePoints.length)} 个`,
    };
  }

  if (FORBIDDEN_PUNCTUATION.test(raw)) {
    const hit = [...new Set([...raw].filter((ch) => FORBIDDEN_PUNCTUATION.test(ch)))].join(' ');
    return {
      ok: false,
      name: '',
      key: '',
      issue: 'forbidden-char',
      message: `仓库名不能包含 ${hit}（这些是路径与文件名保留字符）`,
    };
  }

  for (const ch of codePoints) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (isForbiddenCodePoint(codePoint)) {
      return {
        ok: false,
        name: '',
        key: '',
        issue: 'control-char',
        message: '仓库名不能包含控制字符或不可见字符（零宽、双向覆盖等）',
      };
    }
  }

  return { ok: true, name: raw, key: repoNameKey(raw) };
}
