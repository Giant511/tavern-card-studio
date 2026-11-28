/**
 * 调试/截图 URL 参数的**唯一清单**（2026-11-24）。
 *
 * ## 为什么单独一个文件
 *
 * `boot()` 需要先判断"这次启动要不要加载调试处理逻辑"，才决定是否**动态加载**
 * `debug-params.ts`。判断不能先把那个模块 import 进来 —— 那就白动态了。
 * 所以清单放在一个零依赖的小模块里：只含字符串，进主 chunk 的成本可忽略。
 *
 * ```text
 *   debug-keys.ts    零依赖，主 chunk 静态 import   ← 只用来判断
 *   debug-params.ts  有依赖，只在需要时动态 import   ← 真正的处理
 * ```
 *
 * ## 清单必须与处理逻辑严格一一对应
 *
 * 两种漂移都会出问题，方向相反：
 *
 * ```text
 *   清单多列了某个参数  → 该参数触发一次无用的 1.34 kB 下载（白加载）
 *   清单漏列了某个参数  → 那个调试入口永远不生效（检测不到 ⇒ 不加载 ⇒ 静默失效）
 * ```
 *
 * 后者更危险。`test/debug-params-inventory.test.mjs` 双向校验。
 *
 * ## 哪些调试参数**不在**这里
 *
 * `start()` 内部还有几处（`?preview=`、`?exportFace=`、`?login=`、`?settings=`、
 * `?expand=`、`?stAddrDemo=`）。它们与业务逻辑交错 —— `?expand=` 决定首屏展开
 * 几个板块（懒渲染红线的一部分），`?settings=1` 紧跟其后且依赖 `settings` 已构造。
 * 这些是**无条件执行**的 `params.get()`，不需要任何清单，也搬不动（硬搬会打乱
 * 依赖顺序，原注释里"第六次踩同一个坑"讲的就是这个）。
 */
export const DEBUG_PARAM_KEYS = [
  // 演示与导入样本
  'demo',
  'import',
  'importPreview',
  // 规则 / 预设 / 高亮
  'preset',
  'applyPreset',
  'platform',
  'highlight',
  'rules',
  'rulesSection',
  'custom',
  'badImport',
  'highlightDemo',
  // 提示 / 导出 / 异常注入
  'nameHint',
  'export',
  'forceError',
  'newBlockIssues',
  'crashInject',
  // 同步
  'syncUrl',
  'syncToken',
  'sync',
  'syncCard',
] as const;

export type DebugParamKey = (typeof DEBUG_PARAM_KEYS)[number];

/**
 * 这次启动是否带任何由 `debug-params.ts` 处理的调试参数。
 *
 * ## 为什么逐个 `has` 而不是正则
 *
 * 正则要处理大小写、空值、编码，错一个就漏判 —— 而漏判的症状是
 * "某个调试入口偶尔失效"，不影响主流程，属于最容易被放过的 bug。
 * 21 次 Map 查找（URLSearchParams 内部是索引）成本可忽略。
 *
 * ★ `?sample=1` 不在此列：它要在 `new EditorApp(card)` **之前**决定初始卡，
 *   属于启动参数，留在 `boot()` 里（那里已经把 fixture 改成动态 import，
 *   所以也不进主 chunk）。
 */
export function hasDebugParams(params: URLSearchParams): boolean {
  return DEBUG_PARAM_KEYS.some((key) => params.has(key));
}
