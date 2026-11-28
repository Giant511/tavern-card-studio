/**
 * 上帝类的拆分成果必须保持（2026-11-24 / 报告 P2-1、P2-2）。
 *
 * ## 这两条判据防什么
 *
 * 报告的两条主要指控都能用"把东西搬回去"的方式悄悄撤销：
 *
 * ```text
 *   P2-1  AppShell 10,209 行，对外契约（22 字段 ShellOptions）混在文件中部
 *         ⇒ 已搬进 shell-contract.ts。若有人图省事把它搬回去，行数又涨回 1 万
 *   P2-2  生产包含调试调度逻辑与测试夹具
 *         ⇒ 已改成动态 import。若把 fixture 改回静态 import，每个用户又下载 3.5 kB
 * ```
 *
 * 两种回退都不会让任何功能报错，也不会有人天天空体积 —— 所以需要判据。
 *
 * ## 为什么不判"行数上限"
 *
 * 上限会阻碍正常开发：加一个功能就可能超，然后有人为了消红去改那个数字，
 * 判据就变成了摆设。这里判的是**结构**（东西在哪个文件），
 * 那是不会被"合理的功能开发"破坏的。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const SHELL = join(ROOT, 'client/src/chat/shell.ts');
const CONTRACT = join(ROOT, 'client/src/chat/shell-contract.ts');
const APP = join(ROOT, 'client/src/editor/app.ts');
const DEBUG_KEYS = join(ROOT, 'client/src/editor/debug-keys.ts');
const DEBUG_PARAMS = join(ROOT, 'client/src/editor/debug-params.ts');

test('★★★★★ 契约面必须独立成文件，不许搬回 shell.ts', () => {
  assert.ok(existsSync(CONTRACT), 'shell-contract.ts 不见了 —— 契约面被搬回去了？');
  const contract = readFileSync(CONTRACT, 'utf8');
  for (const decl of [
    'export interface ShellOptions',
    'export interface SavedChatSession',
    'export type TabId',
    'export const TABS',
  ]) {
    assert.ok(contract.includes(decl), `契约面里缺 ${decl}`);
  }

  /*
   * shell.ts 里**不许再出现定义**，只许 re-export。
   *
   * 判据用"定义形态"而不是"是否出现过这个词"：re-export 那行里必然有
   * `ShellOptions`，所以只能盯 `export interface ShellOptions {` 这种定义形态。
   */
  const shell = readFileSync(SHELL, 'utf8');
  for (const def of [
    'export interface ShellOptions {',
    'export interface SavedChatSession {',
    "export type TabId = 'chat'",
    'const TABS: readonly TabDef[] = [',
    'interface TabDef {',
  ]) {
    assert.equal(
      shell.includes(def),
      false,
      `shell.ts 里又出现了定义「${def}」—— 契约面应当只在 shell-contract.ts 里`,
    );
  }

  // re-export 必须还在，否则 mobile/main.ts 的 import 会断
  assert.ok(
    /export type \{[^}]*SavedChatSession[^}]*\} from '\.\/shell-contract/.test(shell),
    'shell.ts 没有把 SavedChatSession 转出 —— mobile/main.ts 会 import 失败',
  );
});

test('★★★★★ 调试调度逻辑不许搬回 boot()', () => {
  assert.ok(existsSync(DEBUG_KEYS), 'debug-keys.ts 不见了');
  assert.ok(existsSync(DEBUG_PARAMS), 'debug-params.ts 不见了');

  const app = readFileSync(APP, 'utf8');
  // 只查 boot() 那一段：start() 内部本来就有几处调试入口（有意保留）
  const bootStart = app.indexOf('async function boot()');
  assert.ok(bootStart > 0, '找不到 boot()');
  const bootEnd = app.indexOf('void boot();', bootStart);
  const boot = app.slice(bootStart, bootEnd);

  assert.ok(boot.includes('await import(\'./debug-params\')'), 'boot() 里没有动态 import debug-params');
  assert.ok(boot.includes('hasDebugParams(params)'), 'boot() 里没有 hasDebugParams 判断');
});

test('★★★★★ shell-contract.ts 里不许有运行时逻辑', () => {
  /*
   * 契约面一旦开始放函数，它就会长成第二个 shell.ts。
   * 唯一的运行时值是 TABS（顺序即 UI 的数据），其余必须是 type / interface。
   *
   * ## 判据要能区分"回调类型"与"箭头函数实现"
   *
   * 第一版这里写了一条 `/=>/` 就判红，结果 `readEngineStatus?: () => EngineStatus | null`
   * 这种**类型签名**被当成箭头函数了 —— 而 ShellOptions 里全是这种回调字段。
   * 判据把合法的契约判成违规，比没有判据更糟（有人会去删那条判据）。
   *
   * 所以只盯**顶层赋值形态**：
   *
   * ```text
   *   const x = (...) => …          ← 实现，禁止
   *   readEngineStatus?: () => …    ← 类型签名，允许
   * ```
   */
  const raw = readFileSync(CONTRACT, 'utf8');
  // 剥注释（块注释 + 行注释）
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  for (const [pattern, why] of [
    [/^function /m, '不许有函数声明'],
    [/^(export )?(const|let|var)\s+\w+\s*[:=][^=\n]*=>/m, '不许有顶层箭头函数赋值'],
    [/^class /m, '不许有类'],
    [/^\s*(if|for|while)\s*\(/m, '不许有控制流语句'],
    [/^\s*return\b/m, '不许有 return'],
  ]) {
    assert.equal(pattern.test(stripped), false, `shell-contract.ts 里出现了运行时逻辑：${why}`);
  }

  // TABS 必须仍然是唯一的运行时导出，且是纯数据
  assert.ok(/export const TABS: readonly TabDef\[\] = \[/.test(stripped), 'TABS 的形态变了');
});

test('★★★★★ demo 方法必须都在 demo-actions.ts，app.ts 里只留 demoHost', () => {
  /*
   * ## 演变（2026-11-24）
   *
   * 原先这条判据盯的是"demo 区块里不许混着生产方法"—— 那时 20 个 `*ForDemo`
   * 方法还在 `app.ts` 的类里，夹在业务方法中间。当时靠它抓到 `commitPresetApply`
   * （"应用预设"的真实逻辑）被夹在两个 demo 方法之间。
   *
   * 现在 20 个方法已经搬到 `demo-actions.ts`，**判据要跟着升级**：
   * 从"区块内不许混生产方法"变成"app.ts 里不许再有 demo 方法体"。
   * 否则它会因为找不到区块起点注释而红，而那种红会让人把整条删掉。
   *
   * ## 现在盯什么
   *
   * ```text
   *   app.ts            demoHost() 一个方法，31 行转发         ← 允许
   *   demo-actions.ts   20 个 export function xxx(host, ...)   ← 规定位置
   * ```
   *
   * 两条方向都查：
   *   ① app.ts 里出现 `*ForDemo(` 的**定义**（不是调用）⇒ 有人搬回去了
   *   ② demo-actions.ts 里的函数数少于 18 ⇒ 有方法消失（被删或被改名后没跟上）
   */
  const app = readFileSync(APP, 'utf8');
  const actions = readFileSync(join(ROOT, 'client/src/editor/demo-actions.ts'), 'utf8');

  /*
   * ## 已知例外：4 个与 `start()` 启动时序强耦合的方法
   *
   * 它们由 `start()` 内部的调试分支调用（`?wbDemo=` / `?auditDemo=` /
   * `?arrivalDemo=` / `?exportFace=1`），而那些分支的**位置本身就是判据** ——
   * 原注释反复写着"位置必须在 start() 尾部：依赖 exportDialog 已构造 / 会话已挂载"。
   * 把它们连同调用点一起搬走会打乱启动时序，属于另一类改动（需要真机验截图）。
   *
   * 所以这里用"已知清单 + 禁止新增"，而不是"一个都不许有"：
   *
   * ```text
   *   不写成清空白名单  那会因找不到区块而红，然后有人把整条判据删掉
   *   写成清单        仍然能挡住"以后又往类里塞 demo 方法"
   * ```
   */
  const KNOWN_COUPLED = ['applyDemoWorldbook', 'runArrivalDemo', 'runAuditDemo', 'loadDemoFaceBytes'];

  const defsInApp = [...app.matchAll(/^ {2}(?:(?:private|public) )?(?:async )?(\w*(?:ForDemo|Demo\w*))\((?:[^)]*)\)[^;{]*\{$/gm)].map(
    (m) => m[1],
  );
  const unexpected = defsInApp.filter((name) => !KNOWN_COUPLED.includes(name));
  assert.deepEqual(
    unexpected,
    [],
    `app.ts 里出现了新的 demo 方法定义（应当写在 demo-actions.ts）：\n${unexpected.join('\n')}`,
  );
  // 已知的那几个也不能再变多（复制粘贴会撞这条）
  assert.ok(
    defsInApp.length <= KNOWN_COUPLED.length,
    `app.ts 里的 demo 方法定义有 ${String(defsInApp.length)} 个，超过已知的 ${String(KNOWN_COUPLED.length)} 个`,
  );

  // 但接入点必须在
  assert.ok(app.includes('demoHost(): DemoHost'), 'app.ts 里没有 demoHost() 接入点');
  assert.ok(
    /import type \{ DemoHost \} from '\.\/demo-actions'/.test(app),
    'app.ts 没有以 **type only** 方式引用 DemoHost —— 值 import 会把 demo 代码拉回主 chunk',
  );

  // ② demo-actions.ts 里的函数数量
  const funcs = [...actions.matchAll(/^export (?:async )?function (\w+)\(host: DemoHost/gm)].map((m) => m[1]);
  assert.ok(
    funcs.length >= 18,
    `demo-actions.ts 里只有 ${String(funcs.length)} 个 demo 函数（预期 20）—— 有方法消失或被改名`,
  );
});

test('★★★★★ 页面回调必须留在各自的 *-callbacks.ts', () => {
  /*
   * `AppShell` 里最大的几个方法都是"给渲染层造回调对象"：
   *
   * ```text
   *   makeFilesCallbacks     306 行 → files-callbacks.ts     （2026-11-24）
   *   makeActionsCallbacks   206 行 → actions-callbacks.ts   （2026-11-24）
   * ```
   *
   * ## 为什么钉这条
   *
   * 拆出来的成果很容易被"顺手改回来"抹掉：有人在 `shell.ts` 里想改一段回调逻辑，
   * 发现要跨文件，就把方法搬回去 —— 没有任何测试会红，而 1 万行的类又长回去了。
   *
   * ## 表驱动的三个方向
   *
   * ```text
   *   ① shell.ts 里不许再有那个方法的定义（只许调用 + 一个 XxxHost 接入点）
   *   ② 目标文件里必须有 export function 与 Host 接口
   *   ③ Host 成员数有上限 —— 加成员就是耦合变紧
   * ```
   *
   * ③ 是这条判据里最有价值的部分：它挡住的是"以后往里塞依赖"，而不是"搬回去"。
   */
  const shell = readFileSync(SHELL, 'utf8');

  const CASES = [
    {
      method: 'makeFilesCallbacks',
      file: 'client/src/chat/files-callbacks.ts',
      host: 'FilesHost',
      call: /makeFilesCallbacks\(this\.filesHost\(\)\)/,
      accessor: /private filesHost\(\): FilesHost/,
      maxMembers: 10,
    },
    {
      method: 'makeActionsCallbacks',
      file: 'client/src/chat/actions-callbacks.ts',
      host: 'ActionsHost',
      call: /makeActionsCallbacks\(this\.actionsHost\(\)\)/,
      accessor: /private actionsHost\(\): ActionsHost/,
      maxMembers: 10,
    },
  ];

  for (const one of CASES) {
    const src = readFileSync(join(ROOT, one.file), 'utf8');

    // ① shell.ts 里只许调用
    assert.equal(
      new RegExp(`^ {2}(?:private )?${one.method}\\(`, 'm').test(shell),
      false,
      `shell.ts 里又出现了 ${one.method} 的定义 —— 它应当只在 ${one.file}`,
    );
    assert.ok(one.call.test(shell), `shell.ts 里没有 ${one.method}(this.${one.host === 'FilesHost' ? 'filesHost' : 'actionsHost'}()) 的调用`);
    assert.ok(one.accessor.test(shell), `shell.ts 里没有 ${one.host} 的接入点`);

    // ② 新文件里必须有函数与接口
    assert.ok(
      new RegExp(`export function ${one.method}\\(host: ${one.host}\\)`).test(src),
      `${one.file} 里没有 export function ${one.method}(host: ${one.host})`,
    );
    assert.ok(new RegExp(`export interface ${one.host} `).test(src), `${one.file} 里没有 ${one.host}`);

    // ③ 成员数上限（`extends ChatSessionState` 的 5 个字段不算在内）
    const iface = src.slice(src.indexOf(`export interface ${one.host} `));
    const body = iface.slice(0, iface.indexOf('\n}\n') + 2);
    const members = body.split('\n').filter((l) => /^ {2}\w/.test(l) && !l.trim().startsWith('*')).length;
    assert.ok(
      members <= one.maxMembers,
      `${one.host} 有 ${String(members)} 个成员（上限 ${String(one.maxMembers)}）—— 新增依赖要想清楚是否该拆更小的接口`,
    );
  }
});
