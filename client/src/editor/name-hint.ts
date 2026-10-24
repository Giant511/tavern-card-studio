/**
 * 「点这里改角色名」提示的显示策略（v0.1.2 反馈项四 / T10.29）。
 *
 * 为什么单独一层：这段逻辑有三个容易做错的地方，而且**都不会报错**——
 * 提示该消失没消失（用户每次启动都看到，变成噪音）、不该出现却出现了
 * （用户已经知道，提示变成干扰）、重置设置后不回来（等于这个功能只对新用户有效）。
 * 塞进 app.ts 里就只能靠手点三次验证，纯函数可以直接断言。
 *
 * 存储键与设置里的「重置」共用：清配置时这个键一起清，提示就回来了。
 */

/** localStorage 键。与 `client/src/settings/*` 的其余键保持同一前缀风格。 */
export const NAME_HINT_KEY = 'tcs.ui.nameHintDismissed';

/** 最小可用的存储接口（测试注入内存实现，浏览器里传 localStorage） */
export interface HintStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/**
 * 现在该不该显示提示。
 *
 * 判据只有一条：**用户还没点过角色名**。存在即已点过（值写 `'1'`）。
 *
 * 注意 `getItem` 可能抛异常（隐私模式下 localStorage 禁用、存储配额满）。
 * 这时**显示**提示而不是隐藏：宁可能多提示一次，也不该因为一个存储异常
 * 让整个功能静默消失 —— 这是"可发现性"功能，消失就等于没做。
 */
export function shouldShowNameHint(store: HintStore | null): boolean {
  if (store === null) return true;
  try {
    return store.getItem(NAME_HINT_KEY) === null;
  } catch {
    return true;
  }
}

/** 标记"已经点过了"。写失败不影响本次会话（内存里也会立刻隐藏）。 */
export function dismissNameHint(store: HintStore | null): void {
  if (store === null) return;
  try {
    store.setItem(NAME_HINT_KEY, '1');
  } catch {
    // 写不进去只意味着"下次启动还会提示一次"，比抛出去让点击链断掉好
  }
}

/** 重置（供设置里的「重置」调用）。 */
export function resetNameHint(store: HintStore | null): void {
  if (store === null) return;
  try {
    store.removeItem(NAME_HINT_KEY);
  } catch {
    // 同上
  }
}

/** 取浏览器 localStorage；不可用时返回 null（不抛） */
export function browserHintStore(): HintStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}
