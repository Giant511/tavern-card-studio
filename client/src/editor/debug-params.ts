/**
 * 调试/截图 URL 参数的处理（2026-11-24，从 `app.ts` 的 `boot()` 搬出）。
 *
 * ## 为什么搬出来
 *
 * 这段约 80 行只在带了调试参数的启动里才需要，但它以前躺在 `boot()` 里，
 * 于是每个真实用户下载的包里都带着它（报告 P2-2）。搬出后主 chunk 不再含这段，
 * **调试入口完全保留** —— 18 个截图/验收脚本拼的 URL 一个字都不用改。
 *
 * ## 加载方式
 *
 * `boot()` 用 `hasDebugParams(params)` 判断（清单在 `debug-keys.ts`），
 * 命中才 `await import('./debug-params')`。没命中时这个模块根本不会被下载。
 *
 * ## ★ 这里的顺序就是判据，不要重排
 *
 * 原注释反复记着"位置就是判据"（同一个坑踩过三次以上）：
 *
 * ```text
 *   ?rulesSection=  必须在 ?rules=1 之后 —— 它要面板已经打开
 *   ?export=1       必须在 ?forceError=1 之后 —— 它要问题已注入
 *   ?syncCard=      必须在 connectForDemo 的 await 之后 —— 它要仓库已连上
 * ```
 *
 * 写早了那些 `querySelector` / `?.` 会静默返回 null，截出来的两张图字节相同，
 * 看起来像"两个界面长得一模一样"。搬移时逐行保持原序，不加不减。
 *
 * ## 不在这里的那几段
 *
 * `start()` 内部还有几处调试入口（`?preview=`、`?exportFace=`、`?login=`、
 * `?settings=`、`?expand=`、`?stAddrDemo=`）。它们**没有**搬出来，原因是
 * 与业务逻辑交错：`?expand=` 决定首屏展开几个板块（懒渲染红线的一部分），
 * `?settings=1` 紧跟其后且依赖 `settings` 已构造。硬搬会打乱依赖顺序，
 * 而那正是原注释里"第六次踩同一个坑"的成因。
 */

import type { EditorApp } from './app';
import type { DemoHost } from './demo-actions';

/**
 * 应用所有调试参数。
 *
 * @param app     已 `start()` 完成的实例（方法内部依赖规则、会话、面板都已就绪）
 * @param params  `location.search` 的解析结果
 */
export async function applyDebugParams(app: EditorApp, params: URLSearchParams): Promise<void> {
  /*
   * 两个准备动作，都在最前面（顺序无关，都是同步/懒加载）。
   *
   * `demo` 用动态 import 而不是顶层静态 import：本模块虽然只在调试启动时被
   * 加载，但 demo-actions 又依赖一批对话框与预览代码（约 500 行），
   * 分开加载能让"只开了 ?crashInject=1 的排查"少下载一坨。
   *
   * `host` 是 `EditorApp` 给出的窄接口 —— demo 动作**只能**通过它碰应用状态，
   * 这正是那 20 个方法能从类里搬走的原因。
   */
  const host: DemoHost = app.demoHost();
  const demo = await import('./demo-actions');

  // 调试/截图入口：?demo=lenient 用「只有基本信息」的 TXT 走一次**真实的宽松导入**，
  // 用于验证/展示「原文缺失」标记。走的是 shared 的 applyCardText，不伪造状态。
  if (params.get('demo') === 'lenient') {
    demo.applyDemoLenientText(host);
  }

  // T10.27：三种样本的真实导入（0 命中 / 混合 / 全部标准），用于截图与端到端。
  //   ?import=zero|mixed|clean   走真实导入流程（会确认）
  //   ?importPreview=zero|mixed  只打开导入对话框（截"导入前"）
  const importSample = params.get('import');
  if (importSample !== null) await demo.importSampleForDemo(host, importSample);
  const importPreview = params.get('importPreview');
  if (importPreview !== null) await demo.previewSampleForDemo(host, importPreview);

  // T10.26：注入一个真实渲染层异常（走全局 error 钩子）
  if (params.get('crashInject') === '1') demo.injectCrashForDemo(host);

  /*
   * v0.1.3 追加项二：只展开某一个板块并填入演示文本（三板块高亮截图）。
   *
   * `?highlightDemo=worldbook|initial-scene|chat-examples`
   *
   * 放在这里是因为它只依赖会话与规则（`start()` 尾部已全部就绪），
   * 不依赖任何面板。而 `?rulesSection=` 不在这里 —— 它依赖**面板已打开**，
   * 见下方 `rules=1` 之后的位置（这条错位本仓库已经踩过三次）。
   */
  const highlightDemo = params.get('highlightDemo');
  if (highlightDemo !== null) demo.demoHighlightBlock(host, highlightDemo);

  // T10.29：改名提示的两态（show = 未点过 / hide = 已点过）
  const hintParam = params.get('nameHint');
  if (hintParam === 'show' || hintParam === 'hide') demo.setNameHintForDemo(host, hintParam);

  // 调试/截图入口（T6.2/T6.3）：
  //   ?rules=1&preset=divider     打开规则面板并把预设选为 divider（不重排）
  //   ?rules=1&applyPreset=divider 直接执行「应用预设」（会重排，走同一套 plan→apply）
  //   ?platform=janitorai         切到指定平台规则（触发重检）
  //   ?highlight=dark             切到指定高亮方案
  const presetParam = params.get('preset');
  if (presetParam) demo.selectPresetForDemo(host, presetParam);
  const applyParam = params.get('applyPreset');
  if (applyParam) demo.applyPresetForDemo(host, applyParam);
  const platformParam = params.get('platform');
  if (platformParam) demo.switchPlatformForDemo(host, platformParam);
  const highlightParam = params.get('highlight');
  if (highlightParam) demo.switchHighlightForDemo(host, highlightParam);
  if (params.get('rules') === '1') demo.openRulesDialogForDemo(host);
  /*
   * `?rules=1&rulesSection=greeting|example` —— 打开面板并滚到对应的新预设区块。
   *
   * **必须写在 `openRulesDialogForDemo()` 之后**（v0.1.3 第三次踩同一个坑）：
   * 第一版写在这之前，`querySelector('[data-role="greeting-preset-section"]')`
   * 拿到 null，函数静默 return —— 于是两张截图字节完全相同（204323），
   * 看起来像"两新区长得一模一样"。同类错此前有过两次（`?preview=` 与 `?login=`
   * 都曾写在 `wireSettings()` 里，那时的依赖对象还没构造）。
   */
  const rulesSection = params.get('rulesSection');
  if (rulesSection === 'greeting' || rulesSection === 'example') {
    demo.demoRulesSection(host, rulesSection);
  }
  // T10.34：自定义路径演示（截图用）——custom=rules 开面板，custom=audit 看审计
  const customParam = params.get('custom');
  if (customParam === 'rules' || customParam === 'audit' || customParam === 'warn') {
    demo.applyCustomTrackDemo(host, customParam);
  }
  if (params.get('badImport') === '1') demo.importBadRuleForDemo(host);
  // ?export=1           打开导出面板（正常路径）
  // ?export=1&forceError=1  先注入一个 error 级问题，用于展示拦截弹窗
  if (params.get('forceError') === '1') demo.injectErrorForDemo(host);
  // v0.1.3 / 6c：让两个新板块各出一条真实审计问题（见 injectNewBlockIssuesForDemo）
  if (params.get('newBlockIssues') === '1') demo.injectNewBlockIssuesForDemo(host);
  if (params.get('export') === '1') demo.openExportForDemo(host);
  const syncUrl = params.get('syncUrl');
  const syncToken = params.get('syncToken');
  if (syncUrl && syncToken) {
    void (async () => {
      await demo.connectForDemo(host, syncUrl, syncToken);
      if (params.get('sync') === '1') demo.openSyncForDemo(host);
      // ?syncCard=card-xxxx 预选某张卡，便于截图展示版本历史
      const preselect = params.get('syncCard');
      if (preselect) demo.preselectSyncCardForDemo(host, preselect);
    })();
  }
}
