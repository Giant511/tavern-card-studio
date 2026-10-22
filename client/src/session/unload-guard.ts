/**
 * 未落盘会话的离开拦截（T9.14 提前项，原定 v0.1.2）。
 *
 * 要解决的问题：`wry` 的 `browser_accelerator_keys` 默认开启，WebView2 认
 * F5 / Ctrl+R 这类浏览器加速键。误按一次就把整个 webview 重载，**所有标签页
 * 的未落盘会话一次性消失**——比逐个关标签严重得多（关标签还有三选确认）。
 *
 * 语义对齐（与关闭标签的「三选」）：
 *   关闭标签：保存并关闭 / 不保存关闭 / 取消
 *   beforeunload：浏览器只给两选（留下 / 离开），页面**不能**在事件里异步保存
 *   再自行放行，所以映射只能是：
 *     有任一脏会话 → 拦（等价「取消」：留在原地，什么都没发生）
 *     全部干净     → 放行（等价无需确认）
 *   「保存并关闭」没有对应物：用户被拦下后可以自己保存，再重载即可。
 *   这是刻意的取舍——假装能替用户保存，等于在拦截路径上又写一遍保存逻辑，
 *   那条路径本身没人测得到（原生对话框会阻塞页面）。
 *
 * 已知边界：**点窗口关闭按钮（X）不走 beforeunload**，那要在 Rust 侧拦
 * `WindowEvent::CloseRequested`。当前版本不处理，记在 PLAN.md 待办里。
 *
 * 为什么把决策抽成纯函数：拦截与否是"在错误状态下显示对话框"的高发区
 * （比如零标签时误拦、或者编辑器有未提交内容但会话不脏时误拦）。
 * 纯函数可以直接单测，不用起浏览器。
 */

/** 只依赖最少的形状，便于单测喂普通对象 */
export interface SessionDirtyView {
  readonly displayName: string;
  readonly dirty: boolean;
}

/** 从会话列表里挑出未落盘的那些名字（按列表顺序，去重） */
export function collectDirtyNames(sessions: readonly SessionDirtyView[]): string[] {
  const names: string[] = [];
  for (const session of sessions) {
    if (!session.dirty) continue;
    if (names.includes(session.displayName)) continue;
    names.push(session.displayName);
  }
  return names;
}

/** 只要还有一张卡没落盘，就不许离开 */
export function shouldBlockUnload(dirtyNames: readonly string[]): boolean {
  return dirtyNames.length > 0;
}

/**
 * 拦截时返回给 `event.returnValue` 的文案。
 *
 * 现代浏览器（Chrome 119+ / Edge）**不再显示**这段自定义文字，只显示标准提示；
 * 但赋值仍是触发拦截的必要条件（空字符串也算），所以这里返回一句人话而不是空串，
 * 让旧版 webview 上至少能说清是哪些卡没保存。
 */
export function describeBlockedUnload(dirtyNames: readonly string[]): string {
  if (dirtyNames.length === 0) return '';
  const preview = dirtyNames.slice(0, 3).join('、');
  const more = dirtyNames.length > 3 ? ` 等 ${String(dirtyNames.length)} 张` : '';
  return `「${preview}」${more}有尚未保存的修改，重载会丢失。`;
}

type UnloadTarget = {
  addEventListener: (type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void) => void;
  removeEventListener: (type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void) => void;
};

/**
 * 装上拦截器，返回卸载函数。
 *
 * `getDirtyNames` 每次事件现取，所以不需要在编辑/保存时维护一份镜像状态——
 * 镜像状态正是这类功能最容易出错的地方（保存后忘了清、新建后忘了加）。
 */
export function installUnloadGuard(
  target: UnloadTarget,
  getDirtyNames: () => string[],
): () => void {
  const listener = (event: BeforeUnloadEvent): void => {
    const names = getDirtyNames();
    if (!shouldBlockUnload(names)) return; // 干净就放行，不碰 event
    // 两件事都要做：preventDefault 是标准路径，returnValue 是兼容路径。
    // 只做其中一个，在部分 WebView2 版本上会被静默忽略。
    event.preventDefault();
    event.returnValue = describeBlockedUnload(names);
  };

  target.addEventListener('beforeunload', listener);
  return () => target.removeEventListener('beforeunload', listener);
}
