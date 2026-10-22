/**
 * T9.9 快捷键决策（`client/src/editor/shortcuts.ts`）。
 *
 * 快捷键的 bug 几乎都不是"没绑定"，而是**抢了不该抢的键**或**在错误的状态下生效**：
 * 空工作台按 Ctrl+W、弹窗开着按 Ctrl+N、正在打字按 Ctrl+W。
 * 这里逐条钉住"什么状态下做什么 / 不做什么"。
 *
 * `preventDefault` 也必须一起断言：返回 null 时**绝不能**吞按键，
 * 否则编辑器里的 Ctrl+A 全选、Ctrl+Z 撤销会被无声吃掉 —— 这类 bug 极难被发现。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { EDITOR_TOOK_CTRL_W, decideShortcut } from '../client/src/editor/shortcuts.ts';

/** 默认场景：不在打字、没有弹窗、两张卡 */
function input(patch = {}) {
  return {
    key: 'n',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    editing: false,
    modalOpen: false,
    tabCount: 2,
    ...patch,
  };
}

// ── 不该管的时候一律返回 null（且不吞按键）───────────────────

test('没有 Ctrl/Cmd：返回 null（普通打字不受影响）', () => {
  assert.equal(decideShortcut(input({ ctrlKey: false, key: 'w' })), null);
  assert.equal(decideShortcut(input({ ctrlKey: false, key: 'Tab' })), null);
});

test('带 Alt：返回 null（Alt+Tab / Alt+F4 是系统键，抢了很难受）', () => {
  assert.equal(decideShortcut(input({ altKey: true, key: 'w' })), null);
});

test('弹窗打开时：三个键全部让给弹窗', () => {
  for (const key of ['n', 'w', 'Tab']) {
    assert.equal(
      decideShortcut(input({ key, modalOpen: true })),
      null,
      `弹窗开着时 ${key} 不该被全局处理`,
    );
  }
});

test('无关的键：返回 null（Ctrl+A / Ctrl+Z / Ctrl+F 必须留给编辑器与浏览器）', () => {
  for (const key of ['a', 'z', 'f', 's', 'ArrowLeft', ' ']) {
    assert.equal(decideShortcut(input({ key })), null);
  }
});

// ── Ctrl+N ────────────────────────────────────────────────

test('Ctrl+N：任何状态都能新建（空工作台更是主要入口）', () => {
  for (const tabCount of [0, 1, 5]) {
    const intent = decideShortcut(input({ key: 'n', tabCount }));
    assert.equal(intent?.type, 'new-card', `tabCount=${tabCount} 时 Ctrl+N 应新建`);
    assert.equal(intent.preventDefault, true);
  }
});

test('Ctrl+N：编辑器聚焦时依然生效（新建不会和打字冲突）', () => {
  const intent = decideShortcut(input({ key: 'n', editing: true }));
  assert.equal(intent?.type, 'new-card');
});

test('Ctrl+N：大写 N（Caps Lock）同样识别', () => {
  assert.equal(decideShortcut(input({ key: 'N' }))?.type, 'new-card');
});

test('Ctrl+Shift+N：不是我们定义的，返回 null', () => {
  assert.equal(decideShortcut(input({ key: 'N', shiftKey: true })), null);
});

// ── Ctrl+W ────────────────────────────────────────────────

test('Ctrl+W：不在打字 → 关闭当前标签', () => {
  const intent = decideShortcut(input({ key: 'w', editing: false, tabCount: 3 }));
  assert.equal(intent?.type, 'close-tab');
  assert.equal(intent.preventDefault, true);
});

test('Ctrl+W：只有一张卡时也能关（关完回空工作台）', () => {
  const intent = decideShortcut(input({ key: 'w', editing: false, tabCount: 1 }));
  assert.equal(intent?.type, 'close-tab');
});

test('Ctrl+W：空工作台 → 无行为（不弹提示、不吞按键）', () => {
  assert.equal(decideShortcut(input({ key: 'w', editing: false, tabCount: 0 })), null);
});

test('Ctrl+W：编辑器聚焦 → 不关标签，只解释一句', () => {
  const intent = decideShortcut(input({ key: 'w', editing: true, tabCount: 3 }));
  assert.equal(intent?.type, 'editor-took-key');
  assert.equal(intent.hint, EDITOR_TOOK_CTRL_W);
  // 仍然 preventDefault：wry 的 browser_accelerator_keys 默认 true，
  // 不能给 WebView2 留下"把 Ctrl+W 当成关窗口"的机会
  assert.equal(intent.preventDefault, true);
});

test('Ctrl+W：提示语要说清"怎么才能关"，不能只说不行', () => {
  assert.match(EDITOR_TOOK_CTRL_W, /未关闭/);
  assert.match(EDITOR_TOOK_CTRL_W, /Ctrl\+W/);
  // 要有可执行的下一步
  assert.match(EDITOR_TOOK_CTRL_W, /标签栏|Esc/);
});

test('Ctrl+Shift+W：不是我们定义的，返回 null', () => {
  assert.equal(decideShortcut(input({ key: 'W', shiftKey: true })), null);
});

// ── Ctrl+Tab ──────────────────────────────────────────────

test('Ctrl+Tab：向后切；Ctrl+Shift+Tab：向前切', () => {
  const forward = decideShortcut(input({ key: 'Tab', tabCount: 2 }));
  assert.equal(forward?.type, 'switch-tab');
  assert.equal(forward.delta, 1);
  assert.equal(forward.preventDefault, true);

  const backward = decideShortcut(input({ key: 'Tab', tabCount: 2, shiftKey: true }));
  assert.equal(backward?.type, 'switch-tab');
  assert.equal(backward.delta, -1);
});

test('Ctrl+Tab：只有 0 或 1 张卡时不处理（切换没有意义，也不该吞按键）', () => {
  assert.equal(decideShortcut(input({ key: 'Tab', tabCount: 0 })), null);
  assert.equal(decideShortcut(input({ key: 'Tab', tabCount: 1 })), null);
});

test('Ctrl+Tab：编辑器聚焦时仍然生效（不产生字符，不会和打字冲突）', () => {
  const intent = decideShortcut(input({ key: 'Tab', tabCount: 2, editing: true }));
  assert.equal(intent?.type, 'switch-tab');
});

// ── 跨平台 ────────────────────────────────────────────────

test('macOS 的 Cmd（metaKey）与 Ctrl 等价', () => {
  const intent = decideShortcut(input({ key: 'w', ctrlKey: false, metaKey: true, tabCount: 1 }));
  assert.equal(intent?.type, 'close-tab');
});

// ── 不变量：只有 intent 非空才吞按键 ───────────────────────

test('凡是非 null 的 intent，preventDefault 都必须是 true（否则等于半截处理）', () => {
  const cases = [
    input({ key: 'n' }),
    input({ key: 'w', tabCount: 1 }),
    input({ key: 'w', editing: true }),
    input({ key: 'Tab', tabCount: 2 }),
  ];
  for (const item of cases) {
    const intent = decideShortcut(item);
    assert.ok(intent, '这些输入应当有结论');
    assert.equal(intent.preventDefault, true);
  }
});
