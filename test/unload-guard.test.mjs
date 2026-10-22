/**
 * 未落盘会话的离开拦截（`client/src/session/unload-guard.ts`，T9.14）。
 *
 * 为什么单独测这一层：F5 / Ctrl+R 会重载整个 webview，一次干掉**所有**标签的
 * 未落盘内容。这种故障的判据不是"渲染对不对"，而是"导航能不能发生"——
 * 纯函数这层钉住"该不该拦"，浏览器侧再由端到端确认"拦得住"。
 *
 * 重点断言两件事：
 *   1. 全部干净时必须**完全不碰 event**（碰了就可能误拦一次正常刷新）；
 *   2. 拦截状态必须**现取**，不能缓存 —— 保存后忘记清缓存是这类功能的经典 bug。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectDirtyNames,
  describeBlockedUnload,
  installUnloadGuard,
  shouldBlockUnload,
} from '../client/src/session/unload-guard.ts';

/** 造一个假的 beforeunload 事件，记录是否被拦 */
function makeEvent() {
  const event = {
    prevented: false,
    returnValue: '',
    preventDefault() {
      event.prevented = true;
    },
  };
  return event;
}

/** 假 window：只实现 add/removeEventListener，并能手动派发 */
function makeTarget() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(type, listener) {
      assert.equal(type, 'beforeunload');
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'beforeunload');
      listeners.delete(listener);
    },
    dispatch(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

const dirty = (name) => ({ displayName: name, dirty: true });
const clean = (name) => ({ displayName: name, dirty: false });

// ── collectDirtyNames ────────────────────────────────────
test('collectDirtyNames：只挑脏会话，保持标签顺序', () => {
  const names = collectDirtyNames([dirty('甲'), clean('乙'), dirty('丙')]);
  assert.deepEqual(names, ['甲', '丙']);
});

test('collectDirtyNames：全干净时为空', () => {
  assert.deepEqual(collectDirtyNames([clean('甲'), clean('乙')]), []);
});

test('collectDirtyNames：零标签时为空（空工作台不该被拦）', () => {
  assert.deepEqual(collectDirtyNames([]), []);
});

test('collectDirtyNames：同名卡只报一次（避免文案里出现「甲、甲」）', () => {
  assert.deepEqual(collectDirtyNames([dirty('未命名'), dirty('未命名')]), ['未命名']);
});

// ── shouldBlockUnload ───────────────────────────────────
test('shouldBlockUnload：有脏会话才拦', () => {
  assert.equal(shouldBlockUnload([]), false);
  assert.equal(shouldBlockUnload(['甲']), true);
  assert.equal(shouldBlockUnload(['甲', '乙']), true);
});

// ── describeBlockedUnload ───────────────────────────────
test('describeBlockedUnload：没有脏会话时返回空串', () => {
  assert.equal(describeBlockedUnload([]), '');
});

test('describeBlockedUnload：三张以内全列出来', () => {
  const text = describeBlockedUnload(['甲', '乙']);
  assert.match(text, /甲、乙/);
  assert.match(text, /尚未保存/);
  assert.doesNotMatch(text, /等 \d+ 张/);
});

test('describeBlockedUnload：超过三张时折叠成「等 N 张」，且数字是总数', () => {
  const text = describeBlockedUnload(['甲', '乙', '丙', '丁', '戊']);
  assert.match(text, /甲、乙、丙/);
  assert.match(text, /等 5 张/);
  assert.doesNotMatch(text, /丁/);
});

// ── installUnloadGuard ──────────────────────────────────
test('installUnloadGuard：全部干净时完全不碰 event（不误拦正常刷新）', () => {
  const target = makeTarget();
  installUnloadGuard(target, () => []);
  const event = makeEvent();
  target.dispatch(event);
  assert.equal(event.prevented, false);
  assert.equal(event.returnValue, '');
});

test('installUnloadGuard：有脏会话时 preventDefault 且写入 returnValue', () => {
  const target = makeTarget();
  installUnloadGuard(target, () => ['甲']);
  const event = makeEvent();
  target.dispatch(event);
  assert.equal(event.prevented, true);
  // 两条路径都要走：只做一条在部分 WebView2 版本上会被静默忽略
  assert.match(String(event.returnValue), /甲/);
});

test('installUnloadGuard：状态是现取的，保存后同一个监听器立刻放行', () => {
  const target = makeTarget();
  let names = ['甲'];
  installUnloadGuard(target, () => names);

  const blocked = makeEvent();
  target.dispatch(blocked);
  assert.equal(blocked.prevented, true);

  names = []; // 等价于用户点了保存
  const allowed = makeEvent();
  target.dispatch(allowed);
  assert.equal(allowed.prevented, false);
});

test('installUnloadGuard：返回的函数能解绑，之后不再拦', () => {
  const target = makeTarget();
  const dispose = installUnloadGuard(target, () => ['甲']);
  assert.equal(target.listeners.size, 1);
  dispose();
  assert.equal(target.listeners.size, 0);
  const event = makeEvent();
  target.dispatch(event);
  assert.equal(event.prevented, false);
});
