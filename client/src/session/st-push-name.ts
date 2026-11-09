/**
 * 决定"这次推送该落到哪个文件名" —— **更新式推送的核心决策**（v0.1.7 修订一）。
 *
 * ## 它解决的是什么
 *
 * 旧实现只有一步：`stPushFileName(角色名, 目录现有文件)` → 冲突就加序号。
 * 于是**每次推送都被当成一张新卡**：
 *
 *   第 1 次推「西奥」→ `西奥.png`
 *   第 2 次推「西奥」→ `西奥 (2).png`   ← 这里已经错了
 *
 * ST 的角色身份就是**文件名**（`avatar` 字段直接是它），所以第 2 次推送在 ST 里
 * 等于凭空多了一个角色「西奥 (2)」，而用户跟「西奥」聊的历史全留在旧文件上。
 * 用户看到的是"改了个设定，聊天记录全没了"。
 *
 * ## 正确语义
 *
 * 客户端记一份 `cardId → 文件名` 的映射：
 *
 * | 情形 | 落点 | 为什么 |
 * |---|---|---|
 * | 首次推（无映射） | 按名字占名，并登记映射 | — |
 * | 同 cardId 再推（文件还在） | **覆盖原文件** | 这才是"更新" |
 * | 改名后再推 | **仍用映射里的文件名** | ST 身份＝文件名，改名不动它就白送"聊天记录保留" |
 * | 映射指向的文件被用户删了 | 视为首次，重新占名 | 用户主动删＝他不想要这个身份了 |
 * | 目标名被**另一个 cardId** 占用 | 才加序号 | 防误覆盖别人的卡 |
 *
 * ## 为什么 key 是 cardId 而不是名字
 *
 * 名字会变。拿名字做 key 的话，"改个角色名"就等于"换一张卡"，而改名是这个
 * 编辑器里最常见的操作之一。cardId 是 F11 的跨端稳定标识，正好承担这件事。
 *
 * ## 但 cardId 可能没有
 *
 * 没登录服务端、或卡还没上传过，就没有 cardId。这时退化用 `name:<角色名>` 作 key ——
 * 至少同名重复推送会覆盖而不是加序号。
 *
 * **由此带来一个真实场景**：用户先没登录（key = `name:西奥`），推了一次；
 * 后来登录、上传，有了 cardId（key = `card-xxx`），再推 —— 按 key 查是查不到的，
 * 会重新占名，于是 ST 里又出现第二张卡。
 *
 * 所以本函数接受一个 `adoptFrom` 备用 key：主 key 查不到映射时，去看备用 key 有没有，
 * 有就**认领**过来（把映射迁到主 key 下）。这就是 `adopted` 字段的含义。
 */

import { nextAvailableFileName, sanitizeFileBase } from './cards-path.ts';
import { ST_PUSH_EXTENSION } from './st-install.ts';

/** `cardId → 落盘文件名（含 .png）` */
export type StPushNameRegistry = Readonly<Record<string, string>>;

/**
 * 无 cardId 时的退化 key 前缀。
 *
 * 必须带前缀：cardId 是用户可自定义的（F11 允许 `lin-wanzhao-0001` 这种），
 * 万一有人把 cardId 起成 `name:西奥`，裸名 key 就会跟它撞。前缀把两个命名空间分开。
 */
export const NAME_KEY_PREFIX = 'name:';

/** 常量折叠一次，避免调用方各拼各的（拼错一个大小写就静默不命中） */
export function nameKeyFor(cardName: string): string {
  return `${NAME_KEY_PREFIX}${sanitizeFileBase(cardName)}`;
}

export interface StPushNameInput {
  /** 主 key：有 cardId 用 cardId，否则用 `nameKeyFor(角色名)` */
  key: string;
  /** 备用 key（通常是 `nameKeyFor(角色名)`）：主 key 无映射时尝试认领 */
  adoptFrom?: string | null;
  /** 当前角色名（只在需要新占名时用到） */
  cardName: string;
  /** 目录里现有的 `.png` 文件名 */
  existing: readonly string[];
  /** 客户端记的映射表 */
  registry: StPushNameRegistry;
}

export interface StPushNameDecision {
  /** 落盘文件名（含 `.png`） */
  fileName: string;
  /** 这是"更新已有卡"（true）还是"首次占名"（false） */
  isUpdate: boolean;
  /**
   * 映射需要写回的内容：
   *   `null` = 不用改（已经是这个值）
   *   字符串 = 应登记/改成这个文件名
   *
   * 为什么不在这个纯函数里直接写：它必须能在 Node 里跑测试（不碰壳能力），
   * 写盘由调用方做。返回"该写什么"，而不是"我写好了"。
   */
  register: string | null;
  /** 需要清理的陈旧 key（认领时把备用 key 删掉，避免两份映射指向不同文件） */
  dropKeys: string[];
  /** 给用户看的一句话；空串 = 无需说明 */
  note: string;
}

/**
 * 解析落盘文件名。**纯函数**：同样的输入永远同样的输出，不读盘不写盘。
 *
 * 不抛异常 —— 所有异常输入（映射指向非法名、映射互相冲突）都折成"重新占名"，
 * 因为推送这件事宁可多一个文件，也不能因为状态脏了就推不出去。
 */
export function resolveStPushName(input: StPushNameInput): StPushNameDecision {
  const { key, adoptFrom, cardName, existing, registry } = input;

  /*
   * 备用 key 的处置统一在开头定：**只要它存在且不等于主 key，最后都要被清掉**。
   *
   * 为什么四种出口都清：无论认领成功（映射迁到主 key 下）还是认领失败
   * （备用 key 指向的文件已不在，是脏数据），最终这份卡的状态都归主 key 管。
   * 留着它只会在下一次占名时**挡住自己** —— 实测踩到过：备用 key 登记着
   * `西奥.png` 而文件已被删，新卡占名时避开它，于是得到 `西奥 (2).png`，
   * 凭空多一个文件。
   */
  const staleAdoptKey = adoptFrom !== null && adoptFrom !== undefined && adoptFrom !== key ? adoptFrom : null;
  const dropKeys = staleAdoptKey === null ? [] : [staleAdoptKey];
  /** 占新名时要忽略的 key：自己和即将被清掉的备用 key */
  const ignoreKeys = staleAdoptKey === null ? [key] : [key, staleAdoptKey];

  /*
   * 1) 先看主 key 有没有映射。
   *
   * 只在**文件真的还在**目录里时才认这条映射：文件不在了说明用户在 ST 侧
   * 主动删了这个角色，此时应当视为首次推送重新占名 —— 否则我们会把卡推到一个
   * 用户已经清掉的名字上，而他还以为自己删干净了。
   */
  const direct = usableMapping(registry[key], existing);
  if (direct !== null) {
    const conflict = occupantOf(direct, registry, key);
    if (conflict === null) {
      return {
        fileName: direct,
        isUpdate: true,
        register: null,
        dropKeys,
        note: '',
      };
    }
    /*
     * 映射指向的文件被**另一个 key** 占用了。这不该发生（登记时已防），
     * 但配置可能被手改、或从别的机器同步过来。此时不能覆盖 —— 覆盖等于
     * 把别人（另一张卡）的角色顶掉，且对方再也找不回自己的聊天记录。
     */
    const fallback = claimFresh(cardName, existing, registry, ignoreKeys);
    return {
      fileName: fallback,
      isUpdate: false,
      register: fallback,
      dropKeys,
      note:
        `原来的文件名 ${direct} 已被另一张卡占用，这次另存为 ${fallback}。` +
        'ST 里这张卡会被当成新角色（旧聊天记录在原来那个角色上）。',
    };
  }

  /*
   * 2) 主 key 没映射 —— 看看备用 key 能不能认领。
   *
   * 这是"先没登录推过、后来登录有了 cardId"的场景。认领之后 NAME 映射要被删掉
   * （见上面的 `dropKeys`），否则两份映射会各自漂移。
   */
  if (staleAdoptKey !== null) {
    const adopted = usableMapping(registry[staleAdoptKey], existing);
    if (adopted !== null && occupantOf(adopted, registry, staleAdoptKey) === null) {
      return {
        fileName: adopted,
        isUpdate: true,
        register: adopted,
        dropKeys,
        note: '',
      };
    }
  }

  /*
   * 3) 首次占名。
   *
   * 用 `nextAvailableFileName(existing, base, ext)` —— 与旧实现同一个函数，
   * 语义没变：**空目录时就是"角色名.png"，有冲突才加序号**。改的只是
   * "什么时候走到这里"（以前每次都走，现在只有真首次才走）。
   */
  const fresh = claimFresh(cardName, existing, registry, ignoreKeys);
  return {
    fileName: fresh,
    isUpdate: false,
    register: fresh,
    dropKeys,
    note: '',
  };
}

/**
 * 映射值是否可用：必须是 `.png` 且**当前确实在目录里**。
 *
 * 只信映射表而不看目录，会在"用户删了文件"时把卡推到一个能成功写入、
 * 但在 ST 里等于新角色的名字上 —— 而用户刚才是想清掉它。
 */
function usableMapping(value: string | undefined, existing: readonly string[]): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!trimmed.toLowerCase().endsWith(ST_PUSH_EXTENSION)) return null;
  // ST 的文件名大小写敏感性与平台有关，这里按"完全一致"判断：宁可不复用，
  // 也不要因为大小写不同而在某些文件系统上变成两个文件
  return existing.includes(trimmed) ? trimmed : null;
}

/**
 * 这个文件名是不是被**别的 key** 登记了？
 *
 * `selfKey` 是调用方自己的 key（查询时排除自己，否则永远"冲突"）。
 */
function occupantOf(
  fileName: string,
  registry: StPushNameRegistry,
  selfKey: string,
): string | null {
  for (const [key, value] of Object.entries(registry)) {
    if (key === selfKey) continue;
    if (typeof value !== 'string') continue;
    if (value.trim() === fileName) return key;
  }
  return null;
}

/**
 * 按角色名占一个新名字。
 *
 * 除了目录里已有的文件，还要把**映射表里别人占着的名字**算进"已占用" ——
 * 否则会出现：目录里 `西奥.png` 被用户删了，但另一张卡还登记着它，
 * 此时新卡推上来会抢走这个已被登记的名字，而那张卡下次推送就会覆盖掉它。
 *
 * `ignoreKeys` 是**不该算作占用者**的 key（自己 + 马上要被清理的备用 key）。
 * 不排除它们的话，陈旧映射会挡住这张卡自己 —— 那是实测踩到的 bug。
 */
function claimFresh(
  cardName: string,
  existing: readonly string[],
  registry: StPushNameRegistry,
  ignoreKeys: readonly string[],
): string {
  const skip = new Set(ignoreKeys);
  const reserved = new Set(existing);
  for (const [key, value] of Object.entries(registry)) {
    if (skip.has(key)) continue;
    if (typeof value === 'string' && value.trim() !== '') reserved.add(value.trim());
  }
  return nextAvailableFileName([...reserved], sanitizeFileBase(cardName), ST_PUSH_EXTENSION);
}
