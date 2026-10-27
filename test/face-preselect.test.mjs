/**
 * 卡面选择器的**预选与竞态**（v0.1.4 / T12.5，决策 D4）。
 *
 * ## 为什么需要这个文件（一次真实缺陷）
 *
 * 截图验收时发现「原图态」的图里选中的是**默认卡面** —— 而决策 D4 要求
 * "PNG 导入的卡，记忆缺失时预选原图"。查下来是两个问题叠加：
 *
 *   1. `open('png')` 调一次 `prepare()`（异步读图库目录），紧接着
 *      `refreshFaceChoices()` 又调一次。两次并发，第二次读到的
 *      `encodeCurrent()` 是第一次**还没写回**的初始值 `default`
 *      —— 于是"该选原图"被覆盖成"选默认"，还把这个错误写进记忆。
 *   2. 修竞态时又差点引入同类问题：`refresh()` 在**从未 prepare 过**时
 *      也不能拿 `this.choice`（初始值）当记忆值传。
 *
 * 这两条都属于"界面看起来正常，但默认选项是错的"，截图能抓到、单测抓不到 ——
 * 所以这里用可注入的 `prepare` 时序把它钉死。
 *
 * 测试对象是**决策链路**（`preselectFace` + 竞态守卫的语义），不是 DOM。
 * DOM 渲染由 `capture-v14-faces.sh` 的三态截图负责。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listFaceCandidates, preselectFace } from '../client/src/export/face-library.ts';

/**
 * 模拟 `FacePicker.prepare` 的决策部分（不含 IO / DOM）。
 *
 * 与真实实现的对应关系写在注释里；一旦真实实现的判断顺序变了，
 * 这里的断言会先红，逼人回去看那两处注释。
 */
function decidePrepared(remembered, options) {
  const candidates = listFaceCandidates(options.libraryNames ?? [], options.hasSource === true);
  return preselectFace(remembered, candidates);
}

test('记忆缺失 + 有原图 → 预选原图（决策 D4）', () => {
  const choice = decidePrepared(null, { hasSource: true });
  assert.deepEqual(choice, { kind: 'source' });
});

test('记忆缺失 + 没有原图 → 预选默认卡面', () => {
  const choice = decidePrepared(null, { hasSource: false });
  assert.deepEqual(choice, { kind: 'default' });
});

test('记忆是图库某张且它还在 → 用它（不被原图覆盖）', () => {
  const choice = decidePrepared('lib:封面.png', {
    hasSource: true,
    libraryNames: ['封面.png'],
  });
  assert.deepEqual(choice, { kind: 'library', name: '封面.png' });
});

test('记忆的图已被删 → 回落到原图（不是默认）', () => {
  const choice = decidePrepared('lib:已删除.png', { hasSource: true, libraryNames: [] });
  assert.deepEqual(choice, { kind: 'source' }, '记忆失效时应当回落到原图，而不是默认卡面');
});

test('记忆明确是 default → 真的是 default（用户表达过偏好）', () => {
  const choice = decidePrepared('default', { hasSource: true });
  assert.deepEqual(choice, { kind: 'default' }, '记过 default 就该是 default，不被"有原图"覆盖');
});

/**
 * 竞态：两次 prepare，先发起的那次结果必须被丢弃。
 *
 * 这里用 `token` 的语义做纯逻辑复现 —— 与 `FacePicker.prepareToken` 一致。
 * 断言的是"顺序错了会得到什么"，从而说明为什么必须有这个守卫。
 */
test('竞态：后发起的 prepare 才是最终状态（先发起的结果被丢弃）', async () => {
  let prepared = 0;
  let token = 0;
  let applied = null;

  const prepare = async (remembered, delayMs) => {
    const mine = (token += 1);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (mine !== token) return; // 过期，丢弃
    prepared += 1;
    applied = decidePrepared(remembered, { hasSource: true });
  };

  // 第一次：错误地传了 default（模拟 refresh 拿初始值当记忆值）；第二次：正解
  const first = prepare('default', 30);
  const second = prepare(null, 5);
  await Promise.all([first, second]);

  assert.equal(prepared, 1, '只有最后发起的那次允许落状态');
  assert.deepEqual(applied, { kind: 'source' }, '最终生效的必须是有原图时的原图预选');
});

test('竞态：没有 token 守卫时先发起的结果会覆盖后发起的（说明守卫的必要性）', async () => {
  let applied = null;
  const prepare = async (remembered, delayMs) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    applied = decidePrepared(remembered, { hasSource: true });
  };

  // 故意不给守卫：慢的那次后完成，把正确结果覆盖掉
  await Promise.all([prepare('default', 30), prepare(null, 5)]);

  assert.deepEqual(
    applied,
    { kind: 'default' },
    '这个断言记录的是"没有守卫时会错成什么样"—— 它是上面那条测试的反面证据',
  );
});
