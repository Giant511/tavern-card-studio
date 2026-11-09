/**
 * 「仓库某个版本 → 导入成一张本地角色卡」的纯逻辑（2026-11-04，T15.2 阶段 A 续）。
 *
 * ## 用户要求
 *
 * > 点击仓库里的对应卡片，点击对应版本卡片的下载即可将卡片导入到 ST 内
 * > （注意此处还是不能出现 ST 的字样）
 *
 * ## 为什么这块必须抽成纯函数
 *
 * 三个点全都"错了不报错，只是结果不对"：
 *
 * 1. **块类型（`chara` / `ccv3`）要跟着原卡的 `spec` 走**。
 *    v3 的正文在 `data` 里；把 v3 的 JSON 塞进 `chara` 块，读取方按 v2
 *    解析顶层，字段全空 —— 卡能导入、能看见名字、但设定一个字都没有。
 * 2. **文件名（avatar）要能识别"同一张卡"**。见下面 `existing` 的注释：
 *    第一版把所有重名都当新卡，于是同一个角色每导入一次就多一份。
 * 3. **文件名要过滤非法字符**。卡名里有 `/` `\` `:` 或换行时，
 *    写文件要么失败、要么写到别的目录去。
 *
 * 所以这里只做决策，不读文件、不发请求。`test/card-import.test.mjs` 钉死。
 */

/** 文件名长度上限（不含 `.png`）。留足余量，中文名按码点算 */
const AVATAR_BASE_MAX = 48;

export interface ImportPlanInput {
  /** 仓库里那一版的原始 JSON 文本（`/versions/:rev/raw` 的内容） */
  jsonText: string;
  /** 服务端的 cardId（卡名取不到时的兜底，也让用户认得出是哪张） */
  cardId: string;
  /** 本地角色库里**已存在的文件名**（含 `.png`），用于去重 */
  existingAvatars: readonly string[];
  /**
   * 本地已存在的角色名（2026-11-06）。
   *
   * ## 为什么光有 `existingAvatars` 不够
   *
   * 用户报：
   *
   * > 已存在角色的时候从仓库中再次导入同一个角色的时候会出现多个角色
   *
   * 真机复现：角色列表里出现两个「西奥」——`西奥.png` 与 `西奥 (2).png`。
   * 因为第一版把"同名"当成"两张不同的卡"，无脑加序号。
   *
   * 从**文件名**也判断不出来：`西奥 (2).png` 与 `西奥.png` 是两个不同的
   * 字符串，但它们是同一个角色。
   *
   * 所以必须知道**卡名**：本地角色的显示名与要导入的卡名相同 ⇒ 同一个角色。
   *
   * ★ 判据是"名字完全相同"，不做模糊匹配 —— `西奥` 与 `西奥2` 是两个角色，
   *   而"宁多一份也不要覆盖用户的卡"比"少一份"更安全。
   *   名字相同但内容不同（用户真的想要两份）时，覆盖也符合直觉：
   *   用户看到的就是同一个名字，天然会认为它们是同一张。
   */
  existingNames?: readonly string[];
}

export interface ImportPlan {
  /** 要写进 PNG 的数据块类型 */
  spec: 'v2' | 'v3';
  /** 新文件名，形如 `林晚照.png` */
  avatar: string;
  /** 给用户看的名字（提示里用） */
  displayName: string;
  /**
   * 是否**覆盖已有卡**（true）而不是新建（false）。
   *
   * 调用方据此决定 `writeCharacterPng` 的 `allowCreate`：
   *
   * ```text
   *   overwrite=true   ⇒ allowCreate=false（要求文件已存在，语义是"改现有卡"）
   *   overwrite=false  ⇒ allowCreate=true （新卡，要求同名不存在）
   * ```
   *
   * 两者反着传会直接报错 —— Rust 侧两个方向都做了校验，正是为了
   * 让"该新建却去覆盖""该覆盖却去新建"立刻暴露，而不是静默走错。
   */
  overwrite: boolean;
}

export type ImportPlanResult =
  | { ok: true; plan: ImportPlan }
  | { ok: false; reason: string };

/** 从卡 JSON 里读名字与格式版本；读不懂就退化成 v2 */
function readCardIdentity(jsonText: string, cardId: string): {
  name: string;
  spec: 'v2' | 'v3';
} {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = null;
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { name: fallbackName(cardId), spec: 'v2' };
  }

  const top = parsed as Record<string, unknown>;
  const data =
    typeof top['data'] === 'object' && top['data'] !== null
      ? (top['data'] as Record<string, unknown>)
      : null;

  /*
   * 判定版本：**认 `spec` 字段**，不认"有没有 data"。
   *
   * 某些工具导出的 v2 卡也带一个空的 `data`，只看 `data` 存在会把 v2
   * 误判成 v3 —— 而误判的后果是写进 `ccv3` 块，读取方按 v3 解析
   * （去 `data` 里找正文），拿到的是空对象。
   */
  const specField = top['spec'];
  const spec: 'v2' | 'v3' = specField === 'chara_card_v3' ? 'v3' : 'v2';

  /* 名字：v3 在 data.name，v2 在顶层 name。两处都试，别只认一处 */
  const nameCandidates = [data?.['name'], top['name'], data?.['char_name']];
  for (const candidate of nameCandidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return { name: candidate.trim(), spec };
  }

  return { name: fallbackName(cardId), spec };
}

function fallbackName(cardId: string): string {
  const trimmed = cardId.trim();
  return trimmed === '' ? '未命名卡片' : trimmed;
}

/**
 * 卡名 → 安全的文件名主干。
 *
 * 除了路径分隔符，还要滤掉这些：
 * - 控制字符（`\n` `\t` 等）：能进文件名但会让列表显示成两行
 * - Windows 保留字符 `: * ? " < > |`：桌面端与安卓共用同一套命名，
 *   只按安卓放行的话，桌面端导出的卡在手机上是好的、反过来就写不了
 * - 首尾的点与空格：`..` 是目录穿越，尾部空格在部分文件系统上被静默吃掉
 */
export function sanitizeAvatarBase(name: string): string {
  let out = '';
  for (const ch of Array.from(name)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if ('/\\:*?"<>|'.includes(ch)) continue;
    out += ch;
  }

  out = out.trim().replace(/^\.+/, '').trim();
  if (out === '') return '未命名卡片';

  const chars = Array.from(out);
  if (chars.length > AVATAR_BASE_MAX) out = chars.slice(0, AVATAR_BASE_MAX).join('').trim();
  return out === '' ? '未命名卡片' : out;
}

/** 文件名比较用：大小写不敏感（安卓的文件系统区分，但列表里两个只差大小写会混淆） */
function normalizeAvatar(filename: string): string {
  return filename.trim().toLowerCase();
}

/**
 * 在已存在的文件名之间挑一个不冲突的。
 *
 * 与 `editor/open-name.ts` 的 `uniqueCardName` 规则一致（` (2)` 而不是 `-2`）：
 * 两处各写一份，序号规则迟早分叉。
 */
function uniqueAvatar(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(normalizeAvatar(`${base}.png`))) return `${base}.png`;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} (${String(index)})`;
    if (!taken.has(normalizeAvatar(`${candidate}.png`))) return `${candidate}.png`;
  }
  return `${base} (${String(Date.now())}).png`;
}

/** 算出该怎么导入；`ok: false` 时调用方应把 `reason` 直接提示给用户 */
export function planCardImport(input: ImportPlanInput): ImportPlanResult {
  const jsonText = input.jsonText;

  /* 空内容不能当卡导进来：写出来的会是一张只有图没有设定的卡 */
  if (jsonText.trim() === '') {
    return { ok: false, reason: '这一版的内容是空的，没法导入' };
  }

  const identity = readCardIdentity(jsonText, input.cardId);
  const base = sanitizeAvatarBase(identity.name);
  const taken = new Set(input.existingAvatars.map(normalizeAvatar));

  /*
   * ★★★ 先判断"这是不是已经存在的那张卡"（2026-11-06）。
   *
   * ## 为什么必须按**名字**判，不能只看文件名
   *
   * 真机上同一个角色导入两次，列表里出现：
   *
   * ```text
   *   西奥.png        ← 第一次导入
   *   西奥 (2).png    ← 第二次导入（第一版"去重"的产物）
   * ```
   *
   * 两个文件名不同，但它们是同一个角色。从文件名推不出来，
   * 只能拿**卡名**与本地已有角色的名字比。
   *
   * ## 为什么覆盖而不是保留两份
   *
   * 用户的诉求就是"同一个角色不要出现多个"。而且从仓库下载一版
   * 本质上是"把这一版取到手机上"，同名覆盖正是那个语义。
   *
   * ★ 如果用户真的想要两份，改个卡名再导入即可 —— 而"莫名其妙多出
   *   一个重名角色"是用户无法理解、也无法自行修复的状态。
   */
  const wantedName = normalizeAvatar(identity.name);
  /*
   * ★ 按**下标**配对，不要拿文件名去反推名字。
   *
   * `existingNames[i]` 与 `existingAvatars[i]` 来自同一条角色记录
   * （调用方是 `listed.items.map(...)`，两次 map 同序），所以下标是对齐的。
   *
   * 而"文件名去掉 .png 就是卡名"这个假设**不成立**：用户可能手改过
   * 文件名（`西奥-旧.png`，卡里的 name 仍是 `西奥`）。按文件名回推
   * 会认不出来，于是又新建一份 —— 正是用户报的那个问题。
   */
  const matchedIndex =
    input.existingNames === undefined
      ? -1
      : input.existingNames.findIndex((one) => normalizeAvatar(one) === wantedName);

  if (matchedIndex >= 0) {
    /*
     * 找到同名角色 ⇒ 复用**它对应的文件名**，覆盖写入。
     *
     * 取不到对应文件名（两个数组长度不一致，调用方传错）时退回 `base.png`：
     * 宁可覆盖一张名字和文件名都对得上的卡，也不要再生成 ` (2)`。
     */
    const reused = input.existingAvatars[matchedIndex];
    const avatar = reused === undefined ? `${base}.png` : reused;

    return {
      ok: true,
      plan: {
        spec: identity.spec,
        avatar,
        displayName: avatar.replace(/\.png$/i, ''),
        overwrite: true,
      },
    };
  }

  const avatar = uniqueAvatar(base, taken);

  return {
    ok: true,
    plan: {
      spec: identity.spec,
      avatar,
      /*
       * 显示名取**最终文件名**去掉 `.png`（即含 ` (2)` 这类去重后缀）。
       *
       * 否则重名时提示会说"已导入 林晚照"，而列表里多出来的是
       * "林晚照 (2)" —— 用户会以为导入的是原来那张、没新增。
       */
      displayName: avatar.replace(/\.png$/i, ''),
      overwrite: false,
    },
  };
}
