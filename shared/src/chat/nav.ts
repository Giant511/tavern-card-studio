/**
 * 页面层级（2026-11-03，第二十三批）。
 *
 * ## 为什么这个函数在 `shared` 而不是 `shell.ts`
 *
 * 它是**纯逻辑**（输入一个路由名，输出它的上一级），没有任何 DOM/网络依赖。
 * 这个项目的约定是「纯逻辑放 shared，client 是 noEmit」（memory §88）——
 * 放在 `shell.ts` 里就只能靠"读源码找字符串"来测，
 * 而那种判据答的是"代码里有没有这句话"，不是"层级对不对"。
 *
 * ## 用户报的 bug
 *
 * > 正常左上方是返回上一级，但是点了之后直接就退到聊天设置里了
 *
 * 真因：「上一级是谁」这件事被实现了 5 遍（每页的 `onBack` 各自写死目标），
 * 其中 `prompts` 那个写成了 `'menu'` —— 跳了一级。
 *
 * 层级本来是一张图，散在多处就必然对不上。集中到这一个函数后，
 * 界面返回按钮和系统返回手势可以共用同一个答案。
 *
 * ## 层级
 *
 * ```text
 *   聊天（null）
 *     └ 聊天设置菜单（menu）
 *         ├ 聊天操作（actions）── 聊天文件（files）
 *         ├ AI 响应配置（sampling）── 提示词管理（prompts）
 *         ├ AI 回复格式化（formatting）
 *         ├ 世界书管理（worldbook）
 *         ├ 用户设置（persona）
 *         └ 聊天行为（behavior）
 * ```
 */

/**
 * 某个聊天设置页面的**上一级**。
 *
 * 返回 `null` 表示"回到聊天本身"。**不会返回 `undefined`** ——
 * 那会让调用方走进"什么都不做"的分支，用户看到的是"返回键坏了"。
 *
 * @param route 当前路由（`'menu'` = 设置菜单，其余是各页 id）
 */
export function parentRouteOf(route: string): string | null {
  /*
   * 第三级：上一级是它所属的二级页。
   * 这两条正是这个 bug 的现场 —— 之前两个页面各自写死了 `'menu'`。
   */
  if (route === 'files') return 'actions';
  if (route === 'prompts') return 'sampling';
  /*
   * 提示词编辑（2026-11-07）：上一级是**提示词列表**，不是 AI 响应配置。
   *
   * 这一条不能漏 —— 漏了会走到默认的 `'menu'`，也就是
   * "从编辑页返回直接退回设置菜单"，两级一起跳。
   * 那个 bug 在 `prompts` 上已经发生过一次（就是本文件头注释记的那次）。
   */
  if (route === 'promptEdit') return 'prompts';

  /* 菜单的上一级是聊天本身 */
  if (route === 'menu') return null;

  /*
   * 其余（各分组页 id）：上一级是菜单。
   *
   * 这里**不枚举** group id，用"默认回菜单"。理由：
   * 将来新加一个分组页、忘了更新这里时，它只是退到菜单（少退一级，可接受）；
   * 而如果是白名单漏项，返回会**什么都不做** —— 那才是更难查的故障。
   */
  return 'menu';
}

/**
 * 这次换页该往哪个方向滑。
 *
 * ## 为什么在 `shared` 而不是 `shell.ts`
 *
 * 和 `parentRouteOf()` 同一个理由：这是**纯逻辑**（两个字符串进、
 * 一个方向出），没有 DOM 依赖。放在 `shell.ts` 里就只能靠"读源码找字符串"
 * 来测 —— 而那种判据答的是"代码里有没有这句话"，不是"方向对不对"。
 *
 * 这里能真跑：`test/input-width-and-nav-anim.test.mjs` 直接
 * `import { turnDirection }` 喂十组 key 断言方向。
 *
 * ## 三条规则（页面身份路径是全部输入）
 *
 * ```text
 *   段数变多   chat → chat/settings             ⇒ 'push'  新页从右入
 *   段数变少   chat/settings → chat             ⇒ 'back'  新页从左回
 *   段数不变   chat → cards（Tab 之间）          ⇒ 看 Tab 的左右顺序
 * ```
 *
 * ★ **深度就是路径的段数**。不再维护一张独立的"深度表"——
 * 那种表是第二份真值，加新页面忘了改就静默没动画。
 *
 * ## 同级为什么按 Tab 顺序
 *
 * Tab 是一组**有固定左右顺序**的页（聊天 / 卡片 / 仓库 / 我的）。
 * 手指往右点一格，眼睛期待内容也往右翻 —— 与 Android ViewPager 一致。
 *
 * 同级但两个 key 落在同一个 Tab 下（`cards/greeting` → `cards/persona`）
 * 说明是同一 Tab 里两个二级页互跳，既不是进也不是退 —— 按 `push` 处理：
 * 新页从右入，看起来像"换了一页"，不会让人误以为退回去了。
 *
 * @param tabOrder Tab 从左到右的 id 列表（执行顺序即视觉顺序）
 */
export function turnDirection(
  keyBefore: string,
  keyAfter: string,
  tabOrder: readonly string[],
): 'push' | 'back' {
  /* 同一页重绘：调用方会按 key 相同直接跳过，这里给个确定值便于单测 */
  if (keyBefore === keyAfter) return 'push';

  const depthBefore = keyBefore.split('/').length;
  const depthAfter = keyAfter.split('/').length;
  if (depthAfter !== depthBefore) return depthAfter > depthBefore ? 'push' : 'back';

  const indexOfTab = (key: string): number =>
    tabOrder.findIndex((id) => key === id || key.startsWith(`${id}/`));

  const from = indexOfTab(keyBefore);
  const to = indexOfTab(keyAfter);
  if (from < 0 || to < 0 || from === to) return 'push';
  return to > from ? 'push' : 'back';
}
