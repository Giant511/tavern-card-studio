/**
 * 秘钥输入框的「已配置」显示（2026-11-02 用户要求）。
 *
 * ## 用户原话
 *
 * > 秘钥也改一下，改成可见的一串星号（**给一个变量专门指示是否填写了秘钥**，
 * > 如果填了秘钥就显示一串星号，没有就显示为空），这样用户才知道自己有没有配置。
 *
 * ## 为什么不能直接把真 key 回显
 *
 * 这是**契约层面的约束**，不是懒：key 写进 SillyTavern 之后就读不回来了
 * （`docs/11` §3.5 掩码契约，`writeSecret` 只写不读）。所以输入框里能显示的
 * 只可能是一个**占位符**，不可能是真值。
 *
 * 那为什么不干脆像以前那样留空 + 写一句"已保存过就留空"？
 * 因为用户看到的是一片空白 —— 空白既可能表示"没配过"，也可能表示
 * "配过但为了安全不回显"。**这两种状态在界面上无法区分**，而它们的
 * 后续行为完全不同（一个是"必须填才能用"，一个是"留空表示不改"）。
 * 用户明确说"这样用户才知道自己有没有配置"，说的就是消除这个歧义。
 *
 * ## 为什么星号长度固定
 *
 * 若按真实 key 长度生成，等于把"你的 key 有 51 位"这类信息泄露给旁观者。
 * 固定 12 个就够了：它的语义是"有"，不是"多长"。
 *
 * ## 编辑时怎么办
 *
 * 掩码串是**展示态**，不是值。用户一聚焦就要清空并切回 `password`，
 * 否则他会在 12 个点后面继续输入，拼出 `••••••••••••sk-xxx` 这种东西。
 * 这三种状态（`masked` / `editing` / `empty`）由 `KeyFieldState` 表达，
 * 两个配置页共用同一套判定 —— 同一件事写两遍只有一遍被改，
 * 是本项目反复出现的缺陷形状。
 */

/** 展示态的掩码串。固定长度，不透露真实长度。 */
export const KEY_MASK = '••••••••••••';

/**
 * 秘钥框的三种状态。
 *
 * - `empty`：没配置过，框是空的
 * - `masked`：配置过，框里显示掩码（用户没在编辑）
 * - `editing`：用户正在输入新 key（框是 password 类型、内容为空）
 */
export type KeyFieldState = 'empty' | 'masked' | 'editing';

/** 初次渲染时该用哪个状态 */
export function initialKeyState(hasKey: boolean): KeyFieldState {
  return hasKey ? 'masked' : 'empty';
}

/**
 * 输入框该显示什么。
 *
 * `editing` 恒为空 —— 用户正在输入，显示任何东西都会干扰他。
 */
export function keyFieldValue(state: KeyFieldState): string {
  return state === 'masked' ? KEY_MASK : '';
}

/**
 * 输入框该用哪种 `type`。
 *
 * `masked` 用 `text`：掩码串要**肉眼可见是一串星号**。
 * 用 `password` 的话浏览器会再掩一层，用户看到的是圆点，
 * 也就分不清"这是占位"还是"我真有一个 12 位的 key"。
 *
 * `editing` / `empty` 用 `password`：真的要输入时不能明文显示。
 */
export function keyFieldType(state: KeyFieldState): 'text' | 'password' {
  return state === 'masked' ? 'text' : 'password';
}

/**
 * 输入框的提示语。
 *
 * `editing` 时要说清"留空 = 不改" —— 否则用户清空后保存，
 * 以为自己把 key 删了。
 */
export function keyFieldPlaceholder(state: KeyFieldState): string {
  if (state === 'editing') return '粘贴新 key（留空表示不改）';
  return '粘贴 key';
}

/**
 * 保存时该把什么当作新 key 交给上层。`null` = 不改。
 *
 * ## ★ 判据是「值本身」而不是「状态标记」
 *
 * 第一版写的是 `if (state !== 'editing') return null`，靠状态标记决定。
 * 但那要求**每次输入前都先收到 `focus` 事件** —— 只要有一次事件没派发
 * （自动化脚本直接设 `value`、某些 WebView 的怪癖、测试桩），
 * 状态就滞后成 `empty`，用户真填的 key 会被当成"没改"丢掉。
 *
 * 改成认**哨兵值**：`KEY_MASK` 是唯一的展示值，也是唯一不能当 key 的值。
 * 它极其罕见（要用户手动粘贴 12 个 `•` 才会撞上），所以直接比对是安全的，
 * 而且不依赖任何事件时序。
 *
 * ## 为什么这段必须存在
 *
 * 掩码串会被 `input.value` 原样读出来。不拦的话，保存时就把
 * `'••••••••••••'` 当成新 key **写进 SillyTavern**，把用户真实的 key
 * 覆盖成一串圆点 —— 之后所有请求 401，而错误信息只会说"鉴权失败"，
 * 没人会想到是掩码被当成了 key。
 *
 * `editing` / `masked` 的区分只影响**界面显示**，不影响这里。
 */
export function keyToSave(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (trimmed === '') return null;
  if (trimmed === KEY_MASK) return null;
  return trimmed;
}

/**
 * 用户聚焦输入框后该进入哪个状态。
 *
 * `masked` → `editing`（清空，让用户输入新 key）
 * 其余不变。
 */
export function keyStateOnFocus(state: KeyFieldState): KeyFieldState {
  return state === 'masked' ? 'editing' : state;
}

/**
 * 用户离开输入框后该进入哪个状态。
 *
 * - 正在编辑但什么都没输入 → 退回 `masked`（如果他原本配置过）或 `empty`
 * - 输入了内容 → 保持 `editing`（保存时要读它）
 *
 * @param hadKey 聚焦之前是否已配置过
 */
export function keyStateOnBlur(state: KeyFieldState, rawInput: string, hadKey: boolean): KeyFieldState {
  if (state !== 'editing') return state;
  if (rawInput.trim() !== '') return 'editing';
  return hadKey ? 'masked' : 'empty';
}
