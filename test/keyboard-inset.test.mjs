/**
 * 软键盘避让的算术（v0.1.7 / 第七批问题三）。
 *
 * ## 为什么这些测试值得写
 *
 * 键盘没法在 Node 里弹，所以"真机上有没有让位"只能靠人看。
 * 但**"该让多少"是纯算术**，而算错的后果全是静默的：
 *
 * | 算错的方式 | 真机现象 |
 * |---|---|
 * | 少扣了 `offsetTop` | 输入区被推得比键盘还高，露出一条空白 |
 * | 忘了夹负值 | 旋转/分屏瞬间给出负 padding，CSS 丢弃整条规则 ⇒ "偶尔不生效" |
 * | 没阈值 | 地址栏收缩 8px 也触发重排，用户正在看的消息跳走 |
 * | 双重扣除 | adjustResize 的环境下再扣一次，输入区被顶到屏幕中间 |
 *
 * 这四类错误都**不会抛异常**，只会让界面在某个特定状态下看起来怪。
 * 所以把算术抽成纯函数、在这里钉死。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attachKeyboardInset,
  effectiveKeyboardInset,
  keyboardInset,
  KEYBOARD_INSET_VAR,
  KEYBOARD_MIN_INSET,
} from '../client/src/chat/keyboard-inset.ts';

/* ═══════════════════════════════════════════════════════════
   ① 基本算术
   ═══════════════════════════════════════════════════════════ */

test('★ 键盘弹起：扣掉的高度 = 布局视口与视觉视口之差', () => {
  // 真机实测的一组数（1080x2340 屏，CSS 视口 393x851）
  const inset = keyboardInset({ innerHeight: 851, visualHeight: 851, visualOffsetTop: 0 });
  assert.equal(inset, 0, '键盘没弹时不该扣');

  // 键盘高度约 300px
  const withKeyboard = keyboardInset({ innerHeight: 851, visualHeight: 551, visualOffsetTop: 0 });
  assert.equal(withKeyboard, 300);
});

test('★ 页面被顶起（offsetTop 非零）时要减掉它 —— 否则多扣一条空白', () => {
  /*
   * iOS 上键盘弹起会把整个页面往上推，`offsetTop` 变正。
   * 不减它的后果：算出 `851 - 551 = 300`，但实际键盘只占 200px
   * （另外 100px 是页面被推上去的部分）⇒ 输入区比键盘高出 100px，
   * 中间露出一条背景色空白。
   */
  const inset = keyboardInset({ innerHeight: 851, visualHeight: 651, visualOffsetTop: 100 });
  assert.equal(inset, 100, '(851-100) - 651 = 100，而不是 851-651=200');
});

test('★ adjustResize 环境自动得到 0（不重复扣）', () => {
  /*
   * 如果哪天窗口自己就随键盘缩了，`innerHeight` 会同步变小。
   * 此时公式结果自然为 0 —— **不需要额外判断环境**。
   *
   * 这条断言守的是"同一段代码在两种环境下都对"这个性质：
   * 一旦有人把公式改成 `innerHeight - visualHeight`（不减 offsetTop）
   * 或者加一个 "if (env === android) 不扣"，这条会红。
   */
  const resized = keyboardInset({ innerHeight: 551, visualHeight: 551, visualOffsetTop: 0 });
  assert.equal(resized, 0, '窗口已随键盘缩小时，不该再扣一次');
});

test('★ 视口数据短暂不一致时不许给负值（负 padding 是非法 CSS）', () => {
  /*
   * 旋转、分屏切换、键盘收起动画的中间帧，都可能出现
   * `visualHeight > innerHeight`。算出负数的话：
   *   `padding-bottom: -37px` ⇒ 浏览器**丢弃整条规则** ⇒
   *   表现是"有时候有效、有时候没效果"，且控制台一声不响。
   */
  assert.equal(keyboardInset({ innerHeight: 400, visualHeight: 437, visualOffsetTop: 0 }), 0);
  assert.equal(keyboardInset({ innerHeight: 400, visualHeight: 851, visualOffsetTop: 0 }), 0);
});

test('★ 夹上界：宁可压扁，也不要把输入区推出屏幕', () => {
  /*
   * 怎么才会算出"比整屏还大"？
   * `raw = innerHeight - offsetTop - visualHeight`，只有当 **offsetTop 为负**时
   * 才可能超过 innerHeight。而负的 offsetTop 是真实存在的：
   * iOS 的弹性滚动（rubber-band）会把页面拉下去，offsetTop 变负。
   *
   * 不夹的后果：`padding-bottom: 1100px` 在 800px 高的屏上
   * ⇒ 内容区高度算成负数 ⇒ 输入区被推到屏幕外，**输入框直接消失**。
   */
  const absurd = keyboardInset({ innerHeight: 800, visualHeight: 100, visualOffsetTop: -400 });
  assert.equal(absurd, 800, '最多扣到整屏高度（结果仍然可见），不能更大');

  // 常态（offsetTop 为 0）时上界不该篡改正确结果
  assert.equal(keyboardInset({ innerHeight: 800, visualHeight: 1, visualOffsetTop: 0 }), 799);
});

test('脏数据一律给 0，不抛错（这个函数在每个 resize 帧都会被调）', () => {
  for (const bad of [
    { innerHeight: Number.NaN, visualHeight: 500, visualOffsetTop: 0 },
    { innerHeight: 800, visualHeight: Number.NaN, visualOffsetTop: 0 },
    { innerHeight: 0, visualHeight: 500, visualOffsetTop: 0 },
    { innerHeight: -10, visualHeight: 500, visualOffsetTop: 0 },
    { innerHeight: 800, visualHeight: 500, visualOffsetTop: Number.NaN },
  ]) {
    const inset = keyboardInset(bad);
    assert.equal(Number.isFinite(inset), true, `脏数据 ${JSON.stringify(bad)} 不该产出 NaN`);
    assert.ok(inset >= 0, '不该产出负值');
  }
});

/* ═══════════════════════════════════════════════════════════
   ② 阈值（防"假键盘"导致列表跳动）
   ═══════════════════════════════════════════════════════════ */

test('★ 小抖动当作没有键盘（否则消息列表会莫名跳一下）', () => {
  /*
   * 地址栏收缩、手势条、亚像素抖动都会产生 1~20px 的差值。
   * 只要让位一次，`.nb-msglist` 就会重排、滚动位置跳走 ——
   * 用户正在看的那条消息会跑出视野。
   */
  const tiny = effectiveKeyboardInset({ innerHeight: 851, visualHeight: 843, visualOffsetTop: 0 });
  assert.equal(tiny, 0, '8px 的抖动不算键盘');

  const real = effectiveKeyboardInset({ innerHeight: 851, visualHeight: 551, visualOffsetTop: 0 });
  assert.equal(real, 300, '真键盘要照扣');
});

test('阈值本身是 48px，且必须大于常见"假键盘"、小于最小真键盘', () => {
  assert.equal(KEYBOARD_MIN_INSET, 48);
  // 边界：恰好等于阈值时算键盘（不留模糊地带）
  assert.equal(
    effectiveKeyboardInset({ innerHeight: 851, visualHeight: 851 - 48, visualOffsetTop: 0 }),
    48,
  );
  assert.equal(
    effectiveKeyboardInset({ innerHeight: 851, visualHeight: 851 - 47, visualOffsetTop: 0 }),
    0,
  );
});

/* ═══════════════════════════════════════════════════════════
   ③ 监听：装了什么、算得对不对、能不能拆干净
   ═══════════════════════════════════════════════════════════ */

/** 造一个假的 visualViewport + documentElement，记录写入的值 */
function makeHost(initial = { innerHeight: 851, visualHeight: 851, visualOffsetTop: 0 }) {
  const listeners = new Map();
  const written = [];
  const host = {
    innerHeight: initial.innerHeight,
    style: {
      setProperty(name, value) {
        written.push({ name, value });
      },
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter((one) => one !== listener),
      );
    },
    fire(type) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    countListeners() {
      let total = 0;
      for (const list of listeners.values()) total += list.length;
      return total;
    },
  };

  return {
    host: {
      get innerHeight() {
        return host.innerHeight;
      },
      get visualViewport() {
        return {
          get height() {
            return current.visualHeight;
          },
          get offsetTop() {
            return current.visualOffsetTop;
          },
          addEventListener: host.addEventListener.bind(host),
          removeEventListener: host.removeEventListener.bind(host),
        };
      },
      get documentElement() {
        return { style: host.style };
      },
    },
    written,
    listeners,
    current: { ...initial },
    set(next) {
      Object.assign(current, next);
    },
    fire: host.fire.bind(host),
    countListeners: host.countListeners.bind(host),
  };
}

// `current` 在闭包里，上面那个 getter 需要它 —— 用一个可变引用接住
let current = { innerHeight: 851, visualHeight: 851, visualOffsetTop: 0 };

test('★★ resize 与 scroll 两个事件都要听（只监听 resize 会漏掉"页面被顶起"）', () => {
  /*
   * 键盘弹起有两种表现：
   *   · `visualViewport.height` 变小 → 发 `resize`
   *   · 页面被顶起、`offsetTop` 变大 → 发 `scroll`（**height 可能不变**）
   *
   * 只监听 resize 的后果：某些机型上键盘弹起来了，输入框却原地不动 ——
   * 而 `resize` 也确实发过了，日志看不出问题。
   */
  const fake = makeHost();
  current = { ...fake.current };

  const cleanup = attachKeyboardInset(fake.host);

  assert.ok(fake.listeners.has('resize'), '要监听 resize');
  assert.ok(fake.listeners.has('scroll'), '要监听 scroll');
  assert.equal(fake.countListeners(), 2);

  cleanup();
});

test('★ 挂上就先算一次（从"键盘已弹着"的状态切回聊天页时没有 resize 事件）', () => {
  const fake = makeHost();
  current = { innerHeight: 851, visualHeight: 551, visualOffsetTop: 0 };

  const cleanup = attachKeyboardInset(fake.host);

  const last = fake.written[fake.written.length - 1];
  assert.equal(last.name, KEYBOARD_INSET_VAR);
  assert.equal(last.value, '300px', '初值就要算对，不能等下一次 resize');

  cleanup();
});

test('★ 事件触发后写的是新值（含 scroll 单独变化的情况）', () => {
  const fake = makeHost();
  current = { innerHeight: 851, visualHeight: 851, visualOffsetTop: 0 };
  const cleanup = attachKeyboardInset(fake.host);

  // ① resize：键盘弹起
  current = { innerHeight: 851, visualHeight: 551, visualOffsetTop: 0 };
  fake.fire('resize');
  assert.equal(fake.written[fake.written.length - 1].value, '300px');

  // ② scroll：只有 offsetTop 变（页面被顶起），height 不变
  current = { innerHeight: 851, visualHeight: 651, visualOffsetTop: 100 };
  fake.fire('scroll');
  assert.equal(fake.written[fake.written.length - 1].value, '100px');

  // ③ 收起
  current = { innerHeight: 851, visualHeight: 851, visualOffsetTop: 0 };
  fake.fire('resize');
  assert.equal(fake.written[fake.written.length - 1].value, '0px');

  cleanup();
});

test('★ 清理函数要拆干净并把变量归零（面板会被反复重建）', () => {
  /*
   * 面板每次切 Tab 都重建。不清理的话监听器会累积 ——
   * 数值仍然正确（都写同一个变量），但旧的写向已移除的上下文，
   * 而且数量只增不减。
   */
  const fake = makeHost();
  current = { innerHeight: 851, visualHeight: 551, visualOffsetTop: 0 };
  const cleanup = attachKeyboardInset(fake.host);

  cleanup();

  assert.equal(fake.countListeners(), 0, '监听器要全拆');
  const last = fake.written[fake.written.length - 1];
  assert.equal(last.value, '0px', '拆掉时要把变量归零，否则残留的 padding 一直在');
});

test('★ 没有 visualViewport 时什么都不做（不假装已处理）', () => {
  /*
   * 老 WebView 可能没有这个 API。此时返回一个空清理函数、
   * 不写任何变量 —— CSS 的 `var(--nb-kb-inset, 0px)` 会落到 0px，
   * 行为等同于修之前。**不许假装成功**（那会让人以为已经修好了）。
   */
  let wrote = false;
  const cleanup = attachKeyboardInset({
    innerHeight: 851,
    visualViewport: null,
    documentElement: {
      style: {
        setProperty() {
          wrote = true;
        },
      },
    },
  });

  assert.equal(typeof cleanup, 'function', '要返回可调用的清理函数');
  cleanup();
  assert.equal(wrote, false, '没有 visualViewport 就不该写变量');
});

/* ═══════════════════════════════════════════════════════════
   ④ 接线：算法对了但**没接上**，等于没做
   ═══════════════════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('★★ `boot()` 必须真的调用它（本项目已有两次"函数写了没人调"）', () => {
  /*
   * 这个项目的"页面做完了、链路没接"已经出现过三次：
   *   · `.nb-chat` 零 CSS 定义（浮动）
   *   · 输入框建了但忘了 append 进 DOM
   *   · `setVoiceTransport()` 全库零调用（麦克风永远置灰）
   *
   * 共同的形状：**函数写对了、测试也过了，但没有任何调用方**。
   * 所以判据不能停在"算法有 13 条测试"，必须断言"它在启动路径上"。
   */
  const main = read('client/src/mobile/main.ts');

  assert.match(main, /attachKeyboardInset/, '移动端要引入它');
  /*
   * ★ 2026-11-01 第九批：`boot()` 改成了 `async`（要先跑开屏等引擎），
   * 所以这里不能钉 `function boot()` 这个字面 —— 那会**因为签名变化假红**，
   * 而键盘避让的调用明明还在。
   *
   * 判据的本意是"它在启动路径上、且在 shell 挂载前装好"，不是"签名长什么样"。
   * 所以改成允许 `async` 前缀，同时**把范围收到 shell.mount 之前**
   * （那才是这条判据真正关心的事：装晚了键盘避让会漏掉首次弹起）。
   */
  /*
   * ★★★ 2026-11-06：这段注释里现在也写了 `shell.mount(` —— 于是
   *   `indexOf('shell.mount(')` 命中**注释**，区间被截断在注释处，
   *   `installKeyboardInset()` 恰好落在后面 ⇒ 假红。
   *
   *   同一个坑在本项目已经第三次了（§93 / §122 / 这里）：**注释里写了
   *   被搜的字符串**。所以判据一律先剥注释，且锚点用带分号的完整语句
   *   （注释里通常不会写 `shell.mount(asHost);`）。
   */
  const strip = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  const clean = strip(main);

  const bootStart = clean.indexOf('function boot(');
  assert.ok(bootStart > 0, 'mobile/main.ts 里要有 boot()');
  const mountAt = clean.indexOf('shell.mount(asHost);', bootStart);
  assert.ok(mountAt > bootStart, 'boot() 里要调 shell.mount(asHost)');
  const bootBody = clean.slice(bootStart, mountAt);
  assert.match(
    bootBody,
    /installKeyboardInset\(\)/,
    'boot() 里要真的调用，不能只是定义了 installKeyboardInset（且要在挂 shell 之前）',
  );
});

test('★★ CSS 必须同时吃两个来源，并取 max()', () => {
  /*
   * 真机实测（2026-11-01，本机型）：**`visualViewport` 完全不反映键盘**
   * —— 输入框已聚焦（`focusin` 触发、`active=TEXTAREA`），而
   * `innerHeight` 与 `vv.height` 都是 851 → 851，一点没变。
   *
   * 所以单靠 JS 那条在本机型上是死路，必须由 Android 侧
   * （`WindowInsets.Type.ime()`）补上。两个变量取 `max()`：
   * 任一失效另一个能顶上，都失效时落到 0px（等于没改，不会更差）。
   *
   * 这条断言守的是"别把 native 那条删了" —— 它在本机型上是**唯一**有效的
   * 来源，而删掉之后 JS 那条看起来还在、测试也还是绿的。
   *
   * ## ★ 2026-11-02：判据改成不依赖嵌套层次
   *
   * 原来钉的是完整表达式
   * `max(var(--nb-kb-inset…), var(--nb-kb-inset-native…))`。
   * 后来为了"减去 tabbar 高度"（memory §80.1）在外面多套了一层
   * `max(0px, calc(…))`，**语义没变却整条红掉** —— 这是第 N 次
   * "判据钉字面而不是钉意图"。
   *
   * 现在只要求两件事同时出现在 `padding-bottom` 的值里：
   *   ① 用了 `max(`（两条信号取大，而不是二选一）
   *   ② **出现了 `--nb-kb-inset-native`**（Android 那条没被删）
   * 嵌套多少层、有没有减 tabbar，都不是这条判据该管的
   * （那是 `keyboard-avoidance.test.mjs` 的事）。
   */
  const css = read('client/src/chat/chat.css');
  /*
   * ★ 2026-11-04 换成 `.nb-app`：避让从聊天页上移到最外层。
   *
   * 只修 `.nb-chat` 时仓库页 / 我的页等全被键盘盖住（用户报的正是这个）；
   * 而 `.nb-page` 是 flex 子项、写 padding 无效（真机实测页面底边 778 没动）。
   */
  const body = /\.nb-app\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  const decl = /padding-bottom:\s*([\s\S]*?);/.exec(body)?.[1] ?? '';

  assert.ok(decl !== '', '.nb-app 要有 padding-bottom 声明');
  assert.match(decl, /max\(/, `要用 max() 取两条信号的大值，实际：${decl.trim()}`);
  assert.match(
    decl,
    /var\(--nb-kb-inset-native/,
    `不能删掉 Android 那条来源（本机型唯一有效的），实际：${decl.trim()}`,
  );
  assert.match(
    decl,
    /var\(--nb-kb-inset\b/,
    `JS 那条也要保留（覆盖"键盘参与视口"的机型），实际：${decl.trim()}`,
  );
});

test('★★ Android 侧要用 WindowInsets.Type.ime()，且不许消费 insets', () => {
  /*
   * `systemWindowInsetBottom` 在键盘弹起时是"键盘 + 导航栏"，分不清两者；
   * 用它会把输入区顶得比键盘还高。所以必须是 `Type.ime()`。
   */
  const activity = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt',
  );

  assert.match(activity, /WindowInsets\.Type\.ime\(\)/, '要读 IME 类型的 inset');
  assert.match(activity, /--nb-kb-inset-native/, '要写 native 那个变量');
  // insets 必须往下传：消费掉会让子 view 收不到，状态栏那边算好的 padding 也失效
  assert.match(activity, /\n\s{6,}insets\s*\n/, 'listener 末尾要 return insets（不许 consume）');

  /*
   * ★ 判据要跳过注释行。
   *
   * 这条断言第一版写成 `assert.doesNotMatch(activity, /consumeSystemWindowInsets\(\)/)`，
   * 于是**解释这条规则的那句注释**（"不调 `insets.consumeSystemWindowInsets()`"）
   * 让它红了 —— 判据读到了注释，就以为读到了代码。
   *
   * 这是同一个错误的**第四次**（前三次：§39 扫描范围漏 shared/src、
   * §67.3 把 `{}` 原文当文案、§68.3 门判据只匹配变量名）。
   * 所以这里显式按行过滤，只扫真代码。
   */
  const codeLines = activity
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'));

  assert.equal(
    codeLines.some((line) => line.includes('consumeSystemWindowInsets') || line.includes('consumeStableInsets')),
    false,
    '代码里不许真的消费 insets（注释里提到方法名不算）',
  );
});

test('★ 变量名在 JS 与 CSS 里一致（两边各写一遍必然分叉）', () => {
  /*
   * JS 写 `--nb-kb-inset`、CSS 读 `--nb-kb-inset` —— 拼错一个字符时
   * 两边都"没错"，只是变量永远取不到值，CSS 落到兜底的 0px。
   * 表现是"键盘还是盖住输入框"，而代码看起来完全正确。
   */
  const css = read('client/src/chat/chat.css');
  assert.ok(
    css.includes(KEYBOARD_INSET_VAR),
    `CSS 里要出现 ${KEYBOARD_INSET_VAR}（与 JS 常量同名）`,
  );
});
