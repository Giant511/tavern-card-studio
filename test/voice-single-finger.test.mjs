/**
 * 单指手势能否工作（2026-11-02 用户报「要两个手指才能完成」）。
 *
 * ## 用户的现象
 *
 * > 手势还是不对，我想要的是一个手指操作的，你看录屏，
 * > 现在的操作逻辑要两个手指才能完成（录屏中出现的白点就是我的手指的操作）
 *
 * 录屏里那一帧有两个触点：大圆上一个、左圆上一个 —— 一根按住、另一根去点。
 *
 * ## 两个叠加的缺陷（真机取证 `diag-real-touch.mjs`）
 *
 * ### ① 缺 `touch-action: none` ⇒ 单指滑动被浏览器抢走
 *
 * ```text
 *   手指按住大圆横向移动
 *   → 浏览器把手势解释成页面滚动/侧滑返回
 *   → 派发 pointercancel（实测只收到 1 条 move，横向位移 0px）
 *   → onPointerCancel 释放录音
 *   → 录音作废 + 档位也切不了
 * ```
 *
 * ### ② 事件不区分 `pointerId` ⇒ 第二根手指能"代劳"
 *
 * `onMove` 拿**任何**指针的坐标去算"从大圆滑到哪"。第二根手指在目标圆上
 * 抖一下，就等于"第一根手指滑过去了" —— 于是两根手指居然能成功。
 *
 * **这两条必须一起修**：只修 ① 单指能用但多指会打架（第二根手指抢占
 * `pressStart`）；只修 ② 单指仍然滑不动。
 *
 * ## 为什么之前的验证全绿
 *
 * 全部用 `dispatchEvent(new PointerEvent('pointermove'))` **手动合成**事件。
 * 合成事件绕过了浏览器的触摸判定链 —— 它不可能被 cancel，也不可能带真实的
 * `pointerId`。所以「touch-action 缺失」和「多指混淆」这两类错，
 * **合成事件的判据天生测不出来**。
 *
 * 真正的守法是两条：
 *   ① 静态判据（本文件）：钉住 CSS 与代码里必须有那两件事
 *   ② 真机判据（`verify-real-touch.mjs`）：用 `input motionevent` 注入真实触摸
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const rawCss = readFileSync(join(ROOT, 'client/src/chat/chat.css'), 'utf8');
const rawPanel = readFileSync(join(ROOT, 'client/src/chat/voice-panel.ts'), 'utf8');
/** 剥注释再扫 —— 本项目因"注释被当代码"踩过 7 次 */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
const panel = rawPanel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** 取某条规则体 */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m !== null, `找不到规则 ${selector}`);
  return m[1];
}

/* ═══════════════════════════════════════════════════════════
   一、`touch-action: none`：手势区的触摸必须归我们
   ═══════════════════════════════════════════════════════════ */

test('★★★ 大圆必须 touch-action:none（否则横向滑动被浏览器当滚动抢走）', () => {
  const body = ruleBody('.nb-voice-bigmic');
  assert.match(
    body,
    /touch-action:[ ]*none/,
    '大圆必须 touch-action:none —— 缺它时浏览器会把手势解释成页面滚动并派发 pointercancel，录音直接作废',
  );
});

test('★★★ 三圆行必须 touch-action:none（滑到左右圆的过程也在这块区域里）', () => {
  const body = ruleBody('.nb-voice-chips-slot');
  assert.match(body, /touch-action:[ ]*none/, '三圆行必须 touch-action:none');
});

test('★★★ 语音舞台必须 touch-action:none（上滑取消会滑进这块区域）', () => {
  const body = ruleBody(".nb-voice-stage[data-voice='voice']");
  assert.match(
    body,
    /touch-action:[ ]*none/,
    '舞台必须 touch-action:none —— 否则上滑取消的纵向位移会被当成页面滚动',
  );
});

test('★★ 合法豁免：消息列表仍是 pan-y（它真的需要滚动）', () => {
  /*
   * 反向保护：别为了修语音手势，把整页都设成 `touch-action: none`
   * —— 那会让消息列表不能滚。滚动区必须保留 `pan-y`。
   */
  assert.match(css, /touch-action:[ ]*pan-y/, '消息列表要保留纵向滚动');
});

/* ═══════════════════════════════════════════════════════════
   二、事件按 pointerId 过滤：第二根手指不许参与
   ═══════════════════════════════════════════════════════════ */

test('★★★ 必须记住"发起按压的那根手指"', () => {
  assert.match(
    panel,
    /private activePointerId: number \| null = null/,
    '要有 activePointerId 字段',
  );
  /* onPointerDown 里要记下它 */
  const downStart = panel.indexOf('private async onPointerDown(');
  assert.ok(downStart >= 0, '找不到 onPointerDown');
  const downBody = panel.slice(downStart, downStart + 2600);
  assert.match(
    downBody,
    /this\.activePointerId = ev\.pointerId/,
    'onPointerDown 要记下 pointerId',
  );
});

test('★★★ 已有手指在按时，第二根手指必须被忽略', () => {
  /*
   * 不加这条：第二根手指会把 `pressStart` 覆盖成它自己的落点，
   * 还可能再 `transport.start()` 一次 —— 真机上就是两路麦克风。
   */
  const downStart = panel.indexOf('private async onPointerDown(');
  const downBody = panel.slice(downStart, downStart + 2600);
  assert.match(
    downBody,
    /if \(this\.activePointerId !== null\) return;/,
    '已有一根手指在按时要直接返回',
  );
});

test('★★★ 只有 onMove 过滤 pointerId；onUp / onCancel 故意不过滤', () => {
  /*
   * ## 为什么这个"不对称"是对的
   *
   * | 事件 | 不过滤的代价 | 过滤的代价 |
   * |---|---|---|
   * | `onMove` | 第二根手指能"代劳"切档（用户正是被迫用两指） | 无 |
   * | `onUp` | 第二根手指抬起会提前结束一次录音（重按即可） | **麦克风被占到 60 秒看门狗** |
   * | `onCancel` | 同上 | 同上 |
   *
   * 两边代价差一个量级。真机上 `input motionevent` 注入的 UP 就出现过
   * 与 DOWN 不同 `pointerId` 的情况 —— 那一刻录音卡了 12 秒以上没回 idle，
   * 而"录音停不下来"正是用户上一轮报的症状。
   *
   * ## 为什么这不会让"两指代劳"回来
   *
   * 代劳靠的是 `onMove`（第二根手指的移动被当成第一根在滑）。
   * 那里仍然严格过滤，所以第二根手指滑不动 —— 它抬起只会结束录音。
   */
  const bindStart = panel.indexOf('private bindWindowPointers(');
  assert.ok(bindStart >= 0, '找不到 bindWindowPointers');

  /* onMove 必须过滤 */
  const moveDeclAt = panel.indexOf('const onMove = ', bindStart);
  const moveCallAt = panel.indexOf('this.handlePointerMove(', moveDeclAt);
  assert.ok(moveDeclAt >= 0 && moveCallAt > moveDeclAt, '找不到 onMove');
  assert.ok(
    panel.slice(moveDeclAt, moveCallAt).includes('this.isActivePointer(event)'),
    'onMove 必须按 pointerId 过滤（这是"两指代劳"的唯一入口）',
  );

  /* onUp / onCancel 不许过滤 */
  for (const [name, marker] of [
    ['onUp', 'void this.onPointerUp(event)'],
    ['onCancel', 'void this.onPointerCancel()'],
  ]) {
    const declAt = panel.indexOf(`const ${name} = `, bindStart);
    const callAt = panel.indexOf(marker, declAt);
    assert.ok(declAt >= 0 && callAt > declAt, `找不到 ${name}`);
    assert.equal(
      panel.slice(declAt, callAt).includes('isActivePointer'),
      false,
      `${name} 不许过滤 pointerId —— 拦掉 UP 会让录音停不下来（要占到 60 秒看门狗）`,
    );
  }
});

test('★★★ isActivePointer 的三种边界都要正确', () => {
  const start = panel.indexOf('private isActivePointer(');
  assert.ok(start >= 0, '找不到 isActivePointer');
  const end = panel.indexOf('\n  }', start);
  const body = panel.slice(start, end);

  /*
   * ① 没有按压记录时放行 —— 否则"第一次按压"也可能被挡掉
   * ② 事件没带 pointerId 时放行 —— 单测 stub 没有这个字段，
   *    拦掉会让整条手势链路在测试里跑不起来
   * ③ 有记录时只认同一个 id
   */
  assert.match(body, /if \(this\.activePointerId === null\) return true;/, '无记录时放行');
  assert.match(body, /if \(typeof id !== 'number'\) return true;/, '无 pointerId 时放行');
  assert.match(body, /return id === this\.activePointerId;/, '有记录时只认同一个 id');
});

/* ═══════════════════════════════════════════════════════════
   三、复位：漏清会变成"只能录一次"
   ═══════════════════════════════════════════════════════════ */

test('★★★ activePointerId 必须在所有出口被清（漏一处就"之后再也按不动"）', () => {
  /*
   * 漏清的后果：`onPointerDown` 里的 `if (this.activePointerId !== null) return;`
   * 会永久拦住后续按压 —— 表现为「第一次能用，之后按不动」。
   * 这种"第一次正常"的缺陷最难归因（用户会说"有时候能用"）。
   *
   * ## 为什么要求"在 onPointerUp 开头清"而不是各分支各清
   *
   * 第一版把赋值放在"取消分支"和"正常分支"里，中间那条**早退分支**
   * 漏了：
   *
   * ```text
   *   const recording = this.recording;
   *   this.recording = null;
   *   if (recording === null) { ... return; }   ← 漏清
   * ```
   *
   * 真机表现：连续做几步手势，中间某一步 `not-recording`，
   * 且「有时能过有时过不了」——取决于有没有走到早退分支。
   *
   * 所以判据钉的是**位置**：`onPointerUp` 里第一次出现
   * `this.activePointerId = null` 必须在任何 `return` 之前。
   */
  const upStart = panel.indexOf('private async onPointerUp(');
  assert.ok(upStart >= 0, '找不到 onPointerUp');
  const upBody = panel.slice(upStart, upStart + 3000);

  /*
   * ⚠ 锚点这次定在"**函数第一句**"，比"第一个业务分叉之前"更严。
   *
   * 因为上一版把赋值放在 `if (this.flow.stage !== 'recording') return;`
   * 之后，真机上出现了"连续两次手势、第二次按下完全没反应"：
   *
   * ```text
   *   {flowStage: "idle", hintState: "idle", notices: [], lastVoiceMode: ""}
   *   ⇒ 连错误提示都没有，纯静默
   * ```
   *
   * 真因：UP 到达时 stage 已经不是 recording（第一次 UP 触发转写后 stage
   * 立刻变），那条 guard 直接 return，标记就永远留着。
   *
   * 教训：**输入层的事实（手指抬起了）不该被流程层的条件挡在身后**。
   * 所以判据要求"赋值出现在 stage 判断之前"。
   */
  const clearAt = upBody.indexOf('this.activePointerId = null;');
  const guardAt = upBody.indexOf("if (this.flow.stage !== 'recording') return;");
  assert.ok(clearAt >= 0, 'onPointerUp 必须清 activePointerId');
  assert.ok(guardAt > 0, "找不到 `if (this.flow.stage !== 'recording') return;`");
  assert.ok(
    clearAt < guardAt,
    '清标记必须在 stage 判断**之前** —— 否则 stage 已变的 UP 会漏清，下一次按住静默无反应',
  );

  /* onPointerCancel 同样要在开头清（它也一样会 releaseRecording） */
  const cancelStart = panel.indexOf('private async onPointerCancel(');
  assert.ok(cancelStart >= 0, '找不到 onPointerCancel');
  const cancelBody = panel.slice(cancelStart, cancelStart + 800);
  assert.match(
    cancelBody,
    /this\.activePointerId = null;/,
    'onPointerCancel 也要清（系统抢走按压后，下一次按压必须还能用）',
  );

  /* releaseRecording 里的那一处必须在 `if (stage !== 'idle')` 之外 */
  const releaseStart = panel.indexOf('releaseRecording(reason: string)');
  assert.ok(releaseStart >= 0, '找不到 releaseRecording');
  const releaseBody = panel.slice(releaseStart, releaseStart + 2200);
  const relClearAt = releaseBody.indexOf('this.activePointerId = null;');
  const relIfAt = releaseBody.indexOf("if (this.flow.stage !== 'idle')");
  assert.ok(relClearAt >= 0, 'releaseRecording 必须清 activePointerId');
  assert.ok(
    relIfAt < 0 || relClearAt < relIfAt,
    '复位要写在 `if (stage !== idle)` 之外 —— 那一支不成立时标记同样可能残留',
  );
});

/* ═══════════════════════════════════════════════════════════
   四、释放必须彻底：不许把"手势态"关在 stage 条件里
   ═══════════════════════════════════════════════════════════ */

test('★★★ releaseRecording 的手势复位必须在 stage 条件之外', () => {
  /*
   * ## 真机现象
   *
   * 上滑取消一次之后，提示**永久停在「松开 取消」**，可用户早已松手：
   *
   * ```text
   *   切键盘再切回语音态（本该彻底复位）
   *   → {"hint":"松开 取消","state":"cancel","rec":"false","clock":"0:00"}
   * ```
   *
   * 界面在说谎：显示"松开取消"，而根本没在录音。
   *
   * ## 根因
   *
   * `pressStart` / `cancelling` / `recordStartedAt` 这三行被写在
   * `if (this.flow.stage !== 'idle')` **里面**。而取消走的路径是
   * `onPointerUp 取消分支 → releaseRecording()`，那时 flow 已经被
   * `cancelRecording()` 置成 idle ⇒ 条件不成立 ⇒ 这三行不执行。
   *
   * 这三样描述的是"手指还按着吗"，与"流程走到哪一步"是**两件事**，
   * 放进 stage 的条件里就是把它们混了。
   *
   * ## 判据
   *
   * 在 `releaseRecording` 里，`this.cancelling = false` 必须出现在
   * `if (this.flow.stage !== 'idle')` **之前**。
   */
  const start = panel.indexOf('releaseRecording(reason: string)');
  assert.ok(start >= 0, '找不到 releaseRecording');
  const body = panel.slice(start, start + 2200);

  const clearAt = body.indexOf('this.cancelling = false;');
  const ifAt = body.indexOf("if (this.flow.stage !== 'idle')");
  assert.ok(clearAt >= 0, 'releaseRecording 必须清 cancelling');
  assert.ok(ifAt >= 0, '找不到 stage 判断');
  assert.ok(
    clearAt < ifAt,
    'cancelling 复位必须在 stage 条件之前 —— 否则取消一次后提示永久卡在「松开 取消」',
  );

  /* pressStart 与 recordStartedAt 同理 */
  for (const field of ['this.pressStart = null;', 'this.recordStartedAt = 0;']) {
    const at = body.indexOf(field);
    assert.ok(at >= 0, `releaseRecording 要复${field}`);
    assert.ok(at < ifAt, `${field} 也必须在 stage 条件之前`);
  }

  /* syncAll 也必须无条件（cancelling 变了界面就变了） */
  const syncAt = body.indexOf('this.syncAll();');
  assert.ok(syncAt >= 0, 'releaseRecording 必须刷界面');
  assert.ok(syncAt > clearAt, 'syncAll 要在复位之后');
});

test('★★★ 取消之后必须回 idle（提示不许停在"松开取消"）', () => {
  /*
   * 从行为侧再钉一遍：取消分支要把 hint 送回 idle 态。
   * 读源码里的三态赋值，确认 idle 分支存在且文案是「按住说话」。
   */
  const start = panel.indexOf("if (this.hintEl !== null) {");
  assert.ok(start >= 0, '找不到提示同步逻辑');
  const body = panel.slice(start, start + 900);
  assert.match(body, /this\.hintEl\.textContent = '按住说话'/, '要有回 idle 的文案');
  assert.match(body, /data-state', 'idle'/, '要设 data-state=idle');
});

/* ═══════════════════════════════════════════════════════════
   五、不变量：cancelling 只在录音中有意义
   ═══════════════════════════════════════════════════════════ */

test('★★★ syncAll 必须先把"不在录音"时的 cancelling 归零', () => {
  /*
   * ## 真机现象
   *
   * 上滑取消之后，页面永久停在：
   * ```text
   *   {hint: "松开 取消", state: "cancel", rec: "false", canc: "true"}
   * ```
   * 没在录音，却让用户以为"松手会取消"。
   *
   * ## 为什么改成"不变量"而不是继续逐个分支复位
   *
   * 本轮为这个标志已经改了三处（取消分支、releaseRecording、
   * onPointerUp 的早退分支），每次都能修掉眼前那一条，然后从另一条路径
   * 漏回来。根因不是"漏了一个分支"，而是**这个标志与主状态的耦合
   * 没有被表达出来**：它只对"录音中"有意义。
   *
   * 所以把它钉在唯一的"状态 → 视图"入口（`syncAll`）上：
   * 只要不在录音就归零，任何路径漏复位都会被下一次同步自愈。
   *
   * ## 判据
   *
   * `if (!recording) this.cancelling = false;` 必须出现在
   * `syncAll` 开头，且**早于**任何读取 `this.cancelling` 的三态判断。
   */
  const start = panel.indexOf('private syncAll(): void {');
  assert.ok(start >= 0, '找不到 syncAll');
  const body = panel.slice(start, start + 3000);

  const normAt = body.indexOf('if (!recording) this.cancelling = false;');
  assert.ok(normAt >= 0, 'syncAll 里必须有这条归一');

  /* 必须早于提示三态里的读取 */
  const hintAt = body.indexOf('if (this.cancelling) {');
  assert.ok(hintAt > 0, '找不到提示三态里的 cancelling 判断');
  assert.ok(normAt < hintAt, '归一必须在读取之前 —— 否则界面仍会显示「松开 取消」');
});

/* ═══════════════════════════════════════════════════════════
   六、状态必须可观测（否则"按了没反应"只能靠猜）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 舞台必须暴露真实的 flow.stage', () => {
  /*
   * ## 为什么需要它
   *
   * `data-voice` 是"输入区形态"（keyboard/voice），而语音**流程**阶段是
   * 另一件事（idle / recording / transcribing / confirming）。
   *
   * 提示三态只看 `cancelling` + `recording`：
   * ```text
   *   transcribing / confirming 时 hint 同样显示「按住说话」
   *   ⇒ 看起来"已经空闲"，此时按下去不会开始录音
   * ```
   *
   * 我自己的真机脚本被这一点骗了多次（`waitIdle` 在转写中返回 true，
   * 下一步 DOWN 得到 `not-recording`，看起来像产品缺陷）。
   *
   * 对用户也有价值：他报"按了没反应"时，看一眼这个属性就知道卡在哪一步。
   */
  assert.match(
    panel,
    /this\.stageRoot\.setAttribute\('data-flow-stage',\s*this\.flow\.stage\)/,
    '舞台要把真实阶段写到 data-flow-stage 上',
  );

  /* 它必须与 data-voice 一起同步（同一个 syncAll 内，避免漏刷） */
  const at = panel.indexOf("this.stageRoot.setAttribute('data-voice'");
  const flowAt = panel.indexOf("this.stageRoot.setAttribute('data-flow-stage'");
  assert.ok(at >= 0 && flowAt > at, '两个属性要在同一处同步');
  assert.ok(flowAt - at < 1500, '两处不该隔太远（避免一个刷了另一个忘了）');
});

/* ═══════════════════════════════════════════════════════════
   七、避开系统边缘手势区（2026-11-02 真机抓到的真根因）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 三圆行左右要留够内边距，避开 Android 侧滑返回区', () => {
  /*
   * ## 真机证据（`input swipe` 从大圆滑到右圆）
   *
   * ```text
   *   滑到左圆：pointermove=33  pointercancel=0   ✅
   *   滑到右圆：pointermove=2   pointercancel=1   ❌
   * ```
   *
   * 右圆中心 x=336、屏幕宽 393 ⇒ 右边缘距屏幕边仅 **24px**，
   * 正落在系统手势导航的返回热区（约 20–30dp）。事件在**应用之前**
   * 就被 InputDispatcher 截走并派发 `pointercancel`。
   *
   * **`touch-action: none` 管不到这一层** —— 它约束的是浏览器的滚动判定，
   * 而边缘返回是系统级手势。这正是用户说的「要两个手指」的物理原因：
   * 右手拇指往右滑会触发返回，只能换另一只手绕开。
   *
   * ## 判据
   *
   * `.nb-voice-chips-slot` 的左右 padding 至少要 `--nb-sp-8`（32px），
   * 且**不许**用 `--nb-sp-2`（8px）这种小值。
   *
   * 为什么用"padding 大小"而不用"圆距边的距离"：padding 是这一层能控制的
   * 唯一变量（圆的尺寸固定 66/88px，行宽 100%）。算距离要假设屏宽，
   * 那是真机判据的事。
   */
  const body = ruleBody('.nb-voice-chips-slot');
  /*
   * 用「字符类」写正则，避开 heredoc 吞反斜杠的老坑：
   * `[ ]` 代替 `\s`、`[0-9]` 代替 `\d`。语义等价，可读性也够。
   */
  const m = /padding:[ ]*var\(--nb-sp-([0-9]+)\)[ ]+var\(--nb-sp-([0-9]+)\)/.exec(body);
  assert.ok(m !== null, '三圆行应当用两个间距 token 写 padding（上下 / 左右）');

  const tokenPx = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 };
  const horizontal = tokenPx[m[2]];
  assert.ok(horizontal !== undefined, `未知间距 token --nb-sp-${m[2]}`);
  assert.ok(
    horizontal >= 32,
    `左右内边距只有 ${String(horizontal)}px —— 小于 32px 时右侧圆会落进系统返回手势区，往右滑会被系统抢走`,
  );
});

test('★★ 三圆行必须显式声明 touch-action:none（防浏览器滚动判定）', () => {
  /*
   * 与上一条是**两层防护**，缺一不可：
   *   · `touch-action: none` → 挡浏览器的滚动/侧滑判定
   *   · 足够的内边距     → 挡**系统**边缘返回手势
   *
   * 只做前者，右圆仍然滑不过去（真机就是这种情况：pointercancel=1）。
   */
  const body = ruleBody('.nb-voice-chips-slot');
  assert.match(body, /touch-action:[ ]*none/, '三圆行必须 touch-action:none');
});
