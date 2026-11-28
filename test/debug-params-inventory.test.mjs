/**
 * 调试参数清单与处理逻辑的双向一致性（2026-11-24 / 报告 P2-2）。
 *
 * ## 为什么需要一条判据
 *
 * 调度关系是：`hasDebugParams()` 查清单 → 命中才 `import('./debug-params')`。
 * 于是清单与处理逻辑之间有两种漂移，都没有编译错误：
 *
 * ```text
 *   清单漏列了某个参数  → 那个调试入口永远不生效（静默失效）★ 更危险
 *   清单多列了某个参数  → 白下载 1.34 kB（浪费，但不影响功能）
 * ```
 *
 * 前者的症状是"某个截图脚本偶尔拍出普通页面"，而截图脚本本身不会报错 ——
 * 这种洞只能靠静态判据盯。
 *
 * ## 判据方向
 *
 * ```text
 *   ① 处理逻辑读的每个参数，清单里必须有
 *   ② 清单里的每个参数，处理逻辑里必须读（否则是死清单项）
 *   ③ 主 chunk 的源文件（app.ts）里不许再出现这些参数的处理代码
 * ```
 *
 * 第 ③ 条防的是"有人嫌动态加载麻烦，把逻辑塞回 boot()" —— 那会静默退回
 * 老状态，而产物体积的变化没人天天看。
 *
 * ## 只读源码，不读产物
 *
 * 产物判据（主 chunk 里有没有那 1.34 kB）依赖 `client/dist` 存在，而测试
 * 可能在没构建过的机器上跑。源码级判据在两种环境下都能工作。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const KEYS_FILE = join(ROOT, 'client/src/editor/debug-keys.ts');
const PARAMS_FILE = join(ROOT, 'client/src/editor/debug-params.ts');
const APP_FILE = join(ROOT, 'client/src/editor/app.ts');

/** 从 `DEBUG_PARAM_KEYS = [ ... ]` 里取出全部字符串字面量 */
function listInKeys() {
  const source = readFileSync(KEYS_FILE, 'utf8');
  const start = source.indexOf('export const DEBUG_PARAM_KEYS');
  assert.ok(start >= 0, '找不到 DEBUG_PARAM_KEYS —— 判据需要同步更新');
  const open = source.indexOf('[', start);
  const close = source.indexOf(']', open);
  assert.ok(open > 0 && close > open, 'DEBUG_PARAM_KEYS 的数组字面量没闭合');
  const body = source.slice(open, close);
  return [...body.matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)].map((m) => m[1]);
}

/** 从源码里抓 `params.get('xxx')` / `params.has('xxx')` 的参数名 */
function readInParams(source) {
  const found = new Set();
  for (const m of source.matchAll(/params\.(?:get|has)\('([a-zA-Z][a-zA-Z0-9]*)'\)/g)) {
    found.add(m[1]);
  }
  return [...found];
}

test('★★★★★ 处理逻辑读的每个参数，清单里必须有', () => {
  const keys = new Set(listInKeys());
  const used = readInParams(readFileSync(PARAMS_FILE, 'utf8'));
  assert.ok(used.length >= 15, `只扫到 ${String(used.length)} 个参数 —— 判据的正则可能失效了`);

  const missing = used.filter((key) => !keys.has(key));
  assert.deepEqual(
    missing,
    [],
    `这些参数在 debug-params.ts 里被读，但清单里没有 ⇒ 带了它们也不会加载调试模块（静默失效）：\n${missing.join('\n')}`,
  );
});

test('★★★★ 清单里每个参数，处理逻辑里必须读（否则是死清单项）', () => {
  const keys = listInKeys();
  const used = new Set(readInParams(readFileSync(PARAMS_FILE, 'utf8')));

  const dead = keys.filter((key) => !used.has(key));
  assert.deepEqual(
    dead,
    [],
    `这些参数在清单里，但 debug-params.ts 从不读它们 ⇒ 白触发一次 1.34 kB 下载：\n${dead.join('\n')}`,
  );
});

test('★★★★★ app.ts 里不许再出现调试参数的处理代码', () => {
  /*
   * 第 ③ 条：防"把逻辑塞回 boot()"。
   *
   * 允许保留的只有两处：
   *   · `hasDebugParams(params)` —— 判断
   *   · `params.get('sample')`   —— 启动参数，决定初始卡，不能搬
   *
   * 其它 `params.get('xxx')` 若出现在 boot() 里，说明这段又被搬回来了。
   *
   * ★ 只查 boot() 那一段（`async function boot`），不查整个文件 ——
   *   `start()` 内部本来就有几处调试入口（见 debug-keys.ts 注释），
   *   那些是有意保留的，查全文会把它们也算进去。
   */
  const source = readFileSync(APP_FILE, 'utf8');
  const bootStart = source.indexOf('async function boot()');
  assert.ok(bootStart > 0, '找不到 boot() —— 判据需要同步更新');
  const bootEnd = source.indexOf('void boot();', bootStart);
  assert.ok(bootEnd > bootStart, '找不到 boot() 的结尾');
  const boot = source.slice(bootStart, bootEnd);

  const handledInBoot = readInParams(boot);
  const allowed = new Set(['sample']);
  const leaked = handledInBoot.filter((key) => !allowed.has(key));

  assert.deepEqual(
    leaked,
    [],
    `boot() 里又出现了调试参数处理 —— 这段应当只在 debug-params.ts 里（否则主 chunk 又变大了）：\n${leaked.join('\n')}`,
  );

  // 判断入口必须还在，否则整个调试链路断了
  assert.ok(boot.includes('hasDebugParams(params)'), 'boot() 里没有 hasDebugParams 判断');
  assert.ok(boot.includes("await import('./debug-params')"), 'boot() 里没有动态 import debug-params');
});

test('★★★★ 样例卡 fixture 必须是动态 import（不许静态打进主 chunk）', () => {
  /*
   * `test/fixtures/sample-card.json` 属于测试夹具。静态 import 会让它进主 chunk，
   * 于是每个用户下载的包里都有这份"别人的角色卡"（报告 P2-2）。
   *
   * 动态 import 后它成为独立 chunk（实测 3.51 kB），不带 `?sample=1` 不下载。
   */
  const source = readFileSync(APP_FILE, 'utf8');

  const staticImport = /^import\s+\w+\s+from\s+'[^']*sample-card\.json'/m.test(source);
  assert.equal(
    staticImport,
    false,
    'sample-card.json 又被静态 import 了 —— 它会回到主 chunk，每个用户都会下载这份测试夹具',
  );

  assert.ok(
    /await import\('\.\.\/\.\.\/\.\.\/test\/fixtures\/sample-card\.json'\)/.test(source),
    '找不到 sample-card.json 的动态 import —— 是不是路径改了？',
  );
});
