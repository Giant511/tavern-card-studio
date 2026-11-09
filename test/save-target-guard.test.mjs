/**
 * 落盘守卫（v0.1.7 增补三）—— `saveTargetWithGuard` 的单元测试。
 *
 * ## 这一层测的是"执行"，不是"决策"
 *
 * 决策（该覆盖还是该问）在 `face-drop.ts` 已经穷举过了。这里要钉的是执行细节：
 *
 *   · 标签占用时**真的没写盘**（返回了对象不等于写了文件）；
 *   · 「查看差异」也**没写盘**（它是查看动作，最容易顺手写进去）；
 *   · 另存时**重新扫目录**（用旧快照会覆盖掉期间新出现的文件）；
 *   · 覆盖走的是 `writeAtomic` 而不是随便一个写函数（原子性与回读校验）。
 *
 * 这些都不会抛异常、界面上也看不出，只能靠"记下调用序列"来断言。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { saveTargetWithGuard } from '../client/src/sync/save-target-guard.ts';

const CID = 'card-abc123';
const TARGET = 'C:/cards/西奥.png';

/** 一个记录调用的内存版 deps */
function makeDeps(overrides = {}) {
  const files = new Map();
  const writes = [];
  const notes = [];
  const deps = {
    files,
    writes,
    notes,
    readFile: async (path) => files.get(path) ?? null,
    readCardId: (bytes) => bytes.cardId ?? null,
    isOpenInTab: () => false,
    isDirty: () => false,
    isNewer: async () => false,
    writeAtomic: async (path, bytes) => {
      writes.push(path);
      files.set(path, bytes);
      return { sha256: `sha-of-${String(bytes.marker ?? 'x')}` };
    },
    listDir: async () => [...files.keys()].map((p) => p.slice(p.lastIndexOf('/') + 1)),
    joinPath: (dir, name) => `${dir}/${name}`,
    askDirty: async () => 'save-as',
    askUnknown: async () => 'save-as',
    note: (m) => { notes.push(m); },
    ...overrides,
  };
  return deps;
}

const INCOMING = new Uint8Array([1, 2, 3]);
INCOMING.marker = 'incoming';

test('目标不存在 → 直接原子写，不问任何问题', async () => {
  const deps = makeDeps();
  const result = await saveTargetWithGuard(TARGET, INCOMING, CID, deps);
  assert.equal(result.path, TARGET);
  assert.equal(result.decision.kind, 'write');
  assert.deepEqual(deps.writes, [TARGET]);
  assert.equal(result.sha256, 'sha-of-incoming');
});

test('同卡 + 干净 → 覆盖，且走的是 writeAtomic（不是普通写）', async () => {
  const existing = new Uint8Array([9]);
  existing.cardId = CID;
  const deps = makeDeps({ readFile: async () => existing });
  deps.files.set(TARGET, existing);

  const result = await saveTargetWithGuard(TARGET, INCOMING, CID, deps);
  assert.equal(result.decision.kind, 'overwrite');
  assert.deepEqual(deps.writes, [TARGET]);
  // 覆盖后文件内容必须是要落盘的那份
  assert.equal(deps.files.get(TARGET), INCOMING);
});

test('同卡 + 脏 → 弹三选；选"覆盖"才写', async () => {
  const existing = new Uint8Array([9]);
  existing.cardId = CID;
  const asked = [];
  const deps = makeDeps({
    readFile: async () => existing,
    isDirty: () => true,
    askDirty: async (options) => {
      asked.push(options);
      return 'overwrite';
    },
  });

  const result = await saveTargetWithGuard(TARGET, INCOMING, CID, deps);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].choices.map((c) => c.id), ['overwrite', 'save-as', 'diff']);
  assert.equal(result.decision.kind, 'overwrite');
  assert.deepEqual(deps.writes, [TARGET]);
});

test('三选里选"查看差异" → **不写盘**（查看不是写动作）', async () => {
  const existing = new Uint8Array([9]);
  existing.cardId = CID;
  const deps = makeDeps({
    readFile: async () => existing,
    isDirty: () => true,
    askDirty: async () => 'diff',
  });

  const result = await saveTargetWithGuard(TARGET, INCOMING, CID, deps);
  assert.deepEqual(deps.writes, [], '查看差异不该产生任何写入');
  assert.equal(result.sha256, '', '没写盘时摘要必须为空，调用方据此知道没落盘');
});

test('三选里取消（null）→ 返回 null，不写盘', async () => {
  const existing = new Uint8Array([9]);
  existing.cardId = CID;
  const deps = makeDeps({
    readFile: async () => existing,
    isDirty: () => true,
    askDirty: async () => null,
  });

  assert.equal(await saveTargetWithGuard(TARGET, INCOMING, CID, deps), null);
  assert.deepEqual(deps.writes, []);
});

test('本地无 cardId → 询问；选覆盖就覆盖', async () => {
  const existing = new Uint8Array([9]);
  existing.cardId = null;
  const deps = makeDeps({
    readFile: async () => existing,
    askUnknown: async () => 'overwrite',
  });

  const result = await saveTargetWithGuard(TARGET, INCOMING, CID, deps);
  assert.equal(result.decision.kind, 'overwrite');
  assert.deepEqual(deps.writes, [TARGET]);
});

test('本地无 cardId + 用户选另存 → 序号另存，原文件不动', async () => {
  const existing = new Uint8Array([9]);
  existing.cardId = null;
  const deps = makeDeps({
    readFile: async () => existing,
    askUnknown: async () => 'save-as',
  });
  deps.files.set(TARGET, existing);

  const result = await saveTargetWithGuard(TARGET, INCOMING, CID, deps);
  assert.equal(result.path, 'C:/cards/西奥 (2).png');
  assert.deepEqual(deps.writes, ['C:/cards/西奥 (2).png']);
  // 原文件必须还是原来那份
  assert.equal(deps.files.get(TARGET), existing);
});

test('异卡撞名 → 直接另存，并在状态栏说明"本地已有同名不同卡"', async () => {
  const existing = new Uint8Array([9]);
  existing.cardId = 'card-other';
  const deps = makeDeps({ readFile: async () => existing });
  deps.files.set(TARGET, existing);

  const result = await saveTargetWithGuard(TARGET, INCOMING, CID, deps);
  assert.equal(result.path, 'C:/cards/西奥 (2).png');
  assert.match(result.note, /另一张卡/);
  assert.ok(deps.notes.some((n) => /另一张卡/.test(n)), '状态栏必须收到一句说明');
});

test('标签占用 → **一个字节都不写**，交给导入替换流程', async () => {
  const existing = new Uint8Array([9]);
  existing.cardId = CID;
  const deps = makeDeps({
    readFile: async () => existing,
    isOpenInTab: () => true,
  });

  const result = await saveTargetWithGuard(TARGET, INCOMING, CID, deps);
  assert.equal(result.decision.kind, 'defer-to-open-tab');
  assert.deepEqual(deps.writes, [], '标签占用时写盘会让内存与磁盘不一致');
  assert.equal(result.sha256, '');
});

test('另存取序号时**重新扫目录**（不用进入时的快照）', async () => {
  /*
   * 模拟"进入时目录里只有 西奥.png，期间另一张卡落了 西奥 (2).png"。
   * 用旧快照会算出 (2) 并覆盖掉那个刚出现的文件 —— 这正是要防的。
   */
  const existing = new Uint8Array([9]);
  existing.cardId = 'card-other';
  const deps = makeDeps({
    readFile: async () => existing,
    listDir: async () => ['西奥.png', '西奥 (2).png'],
  });
  deps.files.set(TARGET, existing);

  const result = await saveTargetWithGuard(TARGET, INCOMING, CID, deps);
  assert.equal(result.path, 'C:/cards/西奥 (3).png', '必须跳到 (3)，不能覆盖期间出现的 (2)');
});

test('另存的扩展名沿用原文件的（不能把 .PNG 写成 .png 后又撞一次）', async () => {
  const existing = new Uint8Array([9]);
  existing.cardId = 'card-other';
  const deps = makeDeps({
    readFile: async () => existing,
    listDir: async () => ['西奥.PNG'],
  });

  const result = await saveTargetWithGuard('C:/cards/西奥.PNG', INCOMING, CID, deps);
  assert.ok(result.path.endsWith(' (2).PNG'), `实际：${result.path}`);
});

test('覆盖时返回的摘要是"磁盘上那份"的，不是入参的', async () => {
  const existing = new Uint8Array([9]);
  existing.cardId = CID;
  const deps = makeDeps({
    readFile: async () => existing,
    // 模拟壳侧改写：真实磁盘摘要与入参不同
    writeAtomic: async (path, bytes) => {
      deps.writes.push(path);
      deps.files.set(path, bytes);
      return { sha256: 'sha-from-disk-readback' };
    },
  });

  const result = await saveTargetWithGuard(TARGET, INCOMING, CID, deps);
  assert.equal(result.sha256, 'sha-from-disk-readback');
});
