/**
 * 卡片目录相关的**纯逻辑**（T9.8 / F4）—— 无 IO、无 Tauri 依赖，可直接单测。
 *
 * 为什么把这几段逻辑放在 TS 而不是 Rust：
 *   · 「重名追加序号」是**用户可见的命名规则**，出错的表现是"文件被覆盖"或
 *     "名字很奇怪"，必须有单测盯着；Rust 侧这一层没有测试宿主（`cargo test`
 *     只能覆盖不依赖 AppHandle 的部分，而命名规则又不需要任何原生能力）；
 *   · 文件系统那部分（创建目录、探针可写、列文件名）留在 Rust，
 *     因为它才是真正需要系统权限的地方。
 */

import type { DirProbe } from '../contract/types.ts';

/** 文件名里不允许出现的字符（Windows 最严，跨平台统一按它来） */
const ILLEGAL_IN_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Windows 保留设备名：即便带扩展名也不能用（`con.json` 同样打不开） */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/** 文件名主体（不含扩展名）的最大长度。留足空间给 ` (12).json` 这类后缀。 */
export const MAX_FILE_BASE_LENGTH = 80;

/**
 * 拼接目录与文件名。
 *
 * 按目录里出现的分隔符判断平台（`\` → Windows，否则 `/`）。
 * 不用 `path.join`：渲染层没有 Node 的 path，也不该为此引入 polyfill。
 * 结尾多余的分隔符会被吃掉，避免拼出 `dir\\name` 这种双分隔符。
 */
export function joinPath(dir: string, name: string): string {
  const separator = dir.includes('\\') ? '\\' : '/';
  const trimmed = dir.replace(/[\\/]+$/, '');
  return `${trimmed}${separator}${name}`;
}

/** 取路径的目录部分（用于"另存为时默认落点"这类展示，不保证文件存在） */
export function parentPath(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/';
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return index <= 0 ? path : path.slice(0, index);
}

/**
 * 算出实际生效的卡片目录。
 *
 * `configured` 为空（null / 空串 / 全空白）时用壳给的默认值 ——
 * 配置里存 null 表示"用户没改过"，不应该变成"没有卡片目录"。
 */
export function resolveCardsDir(configured: string | null | undefined, fallback: string): string {
  const value = typeof configured === 'string' ? configured.trim() : '';
  return value === '' ? fallback : value;
}

/**
 * 把角色名变成可用的文件名主体。
 *
 * 规则都是**踩过的坑**，不是为了好看：
 *   · 去掉 `\ / : * ? " < > |` 与控制字符 —— 这些在 Windows 上直接写不进去；
 *   · 去掉首尾的空格与点 —— Windows 会**静默**把它们裁掉，于是"我明明存成
 *     `林晚照.`"和磁盘上的 `林晚照` 对不上；
 *   · 保留设备名要加下划线 —— `con.json` 这类名字永远创建失败，且报错很莫明；
 *   · 空名回退 `card` —— 角色名允许为空（审计会报必填），但文件名不能为空。
 *
 * 中文原样保留：不转拼音、不转 ASCII，用户看到的就是自己起的名字。
 */
export function sanitizeFileBase(name: string): string {
  let base = (name ?? '').replace(ILLEGAL_IN_NAME, '').replace(/\s+/g, ' ').trim();
  // 末尾的点与空格（`trim()` 只处理空白，点要单独砍）
  base = base.replace(/[.\s]+$/, '');
  // 开头的点会变成隐藏文件（Unix）或让 Windows 拒绝
  base = base.replace(/^[.\s]+/, '');

  if (base === '') return 'card';

  if (RESERVED_NAMES.has(base.toLowerCase())) base = `_${base}`;

  if (base.length > MAX_FILE_BASE_LENGTH) {
    // 按码点截断：直接 slice 可能把一个 emoji / 代理对切成半个字符
    base = [...base].slice(0, MAX_FILE_BASE_LENGTH).join('').replace(/[.\s]+$/, '');
    if (base === '') return 'card';
  }

  return base;
}

/**
 * 在已有文件名里挑一个不冲突的名字（F4：重名自动追加序号，不静默覆盖）。
 *
 * 比较**忽略大小写**：Windows 文件系统本来就不区分 `A.json` 与 `a.json`，
 * 若按大小写敏感去比，用户会得到两个"看起来不同、实际是同一个"的文件，
 * 后写的那个把先写的覆盖掉——正是这条规则要防的事。
 *
 * 序号从 2 开始（`名字 (2).json` 而不是 `名字 (1).json`）：第一个就叫原名，
 * 第二个才是"多出来的那一个"，这符合资源管理器的习惯。
 */
export function nextAvailableFileName(
  existing: readonly string[],
  base: string,
  extension = 'json',
): string {
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  const ext = extension.replace(/^\./, '');
  const safeBase = base === '' ? 'card' : base;

  const first = `${safeBase}.${ext}`;
  if (!taken.has(first.toLowerCase())) return first;

  for (let index = 2; index <= 10000; index += 1) {
    const candidate = `${safeBase} (${index}).${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }

  // 理论上到不了这里（一万个同名文件）。真到了也不能返回一个已存在的名字 ——
  // 那等于静默覆盖。用条目数兜底，至少保证与现有集合不同。
  return `${safeBase}-${existing.length + 1}.${ext}`;
}

/**
 * 从一段路径里取文件名（不含目录）。
 *
 * 只做字符串切分，不碰文件系统 —— 用于「打开的文件不在 cardsDir 里」时
 * 提示用户"这张卡存在别处"。
 */
export function fileNameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return index < 0 ? path : path.slice(index + 1);
}

// ── 目录判定（把"探测结果"翻译成"该怎么办"）─────────────────
//
// 这段为什么是纯函数：三个分支的处置**完全不同**，而且都属于"错了会很明显"
// 的那类（该拦的没拦 → 存了个用不了的路径；不该拦的拦了 → 用户连先把配置
// 记下来都做不到）。放在 DOM 类里就没法单测，只能靠手点。

/** 判定结果：`blocked` = 不要落盘；`warn` / `info` = 落盘但提示；`ok` = 都好 */
export type DirDecisionState = 'ok' | 'warn' | 'info' | 'blocked';

export interface DirDecision {
  state: DirDecisionState;
  message: string;
}

/**
 * @param mode `save` = 保存设置前（会尝试创建）；`pick` = 刚选完目录（已创建）；
 *             `open` = 打开面板时看现状（**不创建**）
 */
export function decideCardsDir(probe: DirProbe, mode: 'save' | 'pick' | 'open'): DirDecision {
  const reason = probe.reason ?? '未知原因';

  if (!probe.exists) {
    if (mode === 'open') {
      // 打开面板不该在磁盘上动手；"还不存在"是正常状态，提示一句就够
      return { state: 'info', message: '该目录还不存在；保存设置时会自动创建。' };
    }
    // 保存/选完仍不存在 → 建不出来。存了也没用，必须拦住
    return { state: 'blocked', message: `不可用：${reason}` };
  }

  if (!probe.writable) {
    // 不可写**不阻断**：可能是权限正在申请、网络盘临时掉线。
    // 拦下来会让用户连"先把配置记下来待会修"都做不到。
    //
    // 三种场景的措辞必须分开：`pick` 时还没保存，说"已保存"是假话；
    // `open` 时连保存动作都没发生，不该提保存。
    if (mode === 'save') {
      return {
        state: 'warn',
        message: `该目录当前不可写：${reason}。配置已保存，但保存卡片时会失败。`,
      };
    }
    if (mode === 'pick') {
      return {
        state: 'warn',
        message: `该目录当前不可写：${reason}（仍可保存设置，但保存卡片会失败）。`,
      };
    }
    return { state: 'warn', message: `目录不可写：${reason}` };
  }

  if (probe.created) {
    return { state: 'ok', message: '目录之前不存在，已创建。' };
  }

  return { state: 'ok', message: '目录可用。' };
}
