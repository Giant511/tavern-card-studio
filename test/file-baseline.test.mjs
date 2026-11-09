/**
 * 本地文件基线判定（v0.1.7 增补三）—— `file-baseline.ts` 的单元测试。
 *
 * ## 为什么要单独测这一层
 *
 * "本地这份文件被人在外面改过吗"是**唯一**能从磁盘上问到的事实，
 * 而它的判据链有三处会静默出错：
 *
 *   · 路径归一化两处各写一次 → 基线查不到 → 永远不判脏（判据形同不存在）；
 *   · 拿"当前时间"当基线（而不是回读 mtime）→ `fileMtime < baseline` →
 *     永远不判脏；
 *   · 用 `!==` 而不是 `>` → FAT32 上写完立刻读回来 mtime 相同 →
 *     每次都被判脏 → 用户学会闭眼点"覆盖"。
 *
 * 这三种都不会报错，界面上也看不出区别，只能靠边界用例钉住。
 *
 * ## 最后一组是"场景级"
 *
 * 单测 `isNewerThanBaseline` 只能证明比较对了。用户要的是
 * "手工改文件后取回 → 必须弹三选"，所以那一组把
 * `isNewerThanBaseline` 的结果喂进 `decideFaceDrop`，断言最终的 `kind`。
 * 只测中间值的话，两边接错（比如把 true/false 传反）也发现不了。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  baselineKey,
  dropBaseline,
  getBaseline,
  isNewerThanBaseline,
  recordBaseline,
} from '../client/src/sync/file-baseline.ts';
import { decideFaceDrop } from '../client/src/export/face-drop.ts';

const T0 = 1_700_000_000_000;

/* ───────────── 路径归一化 ───────────── */

test('baselineKey 统一分隔符与大小写（Windows 上同一个文件）', () => {
  assert.equal(baselineKey('C:\\Cards\\西奥.PNG'), baselineKey('c:/cards/西奥.png'));
});

test('baselineKey 折叠重复分隔符', () => {
  assert.equal(baselineKey('C:\\\\Cards\\\\a.png'), baselineKey('C:/Cards/a.png'));
});

test('baselineKey 不该误伤：不同目录不同键', () => {
  assert.notEqual(baselineKey('C:/a/x.png'), baselineKey('C:/b/x.png'));
});

/* ───────────── 比较 ───────────── */

test('mtime 严格晚于基线 → 判脏', () => {
  assert.equal(isNewerThanBaseline(T0 + 1000, T0), true);
});

test('mtime 等于基线 → **不**判脏（FAT32 只有 2 秒精度，写完立刻读回可能相同）', () => {
  assert.equal(isNewerThanBaseline(T0, T0), false);
});

test('mtime 早于基线 → 不判脏（同步盘回滚 / 从备份恢复旧版本，覆盖不丢他新东西）', () => {
  assert.equal(isNewerThanBaseline(T0 - 1000, T0), false);
});

test('没有基线 → 不判脏（否则所有老文件第一次取回都弹窗）', () => {
  assert.equal(isNewerThanBaseline(T0, undefined), false);
});

test('mtime 取不到（0 / NaN）→ 不判脏', () => {
  assert.equal(isNewerThanBaseline(0, T0), false);
  assert.equal(isNewerThanBaseline(Number.NaN, T0), false);
});

test('基线是坏值（0 / NaN）→ 当作没有基线', () => {
  assert.equal(isNewerThanBaseline(T0, 0), false);
  assert.equal(isNewerThanBaseline(T0, Number.NaN), false);
});

/* ───────────── 读写基线表 ───────────── */

test('recordBaseline 返回**新对象**，不改原来那份', () => {
  const before = { 'c:/a.png': T0 };
  const after = recordBaseline(before, 'C:\\B.PNG', T0 + 1);
  assert.equal(before['c:/b.png'], undefined, '原对象被改了');
  assert.equal(after['c:/b.png'], T0 + 1);
});

test('recordBaseline 不写坏值（0 会让这条判据悄悄失效）', () => {
  const after = recordBaseline({}, 'c:/a.png', 0);
  assert.equal(getBaseline(after, 'c:/a.png'), undefined);
});

test('getBaseline 用归一化键查（大小写/分隔符不同也能命中）', () => {
  const map = recordBaseline({}, 'C:\\Cards\\西奥.PNG', T0);
  assert.equal(getBaseline(map, 'c:/cards/西奥.png'), T0);
});

test('dropBaseline 删得掉，且不影响其它项', () => {
  let map = recordBaseline({}, 'c:/a.png', T0);
  map = recordBaseline(map, 'c:/b.png', T0);
  const after = dropBaseline(map, 'C:\\A.PNG');
  assert.equal(getBaseline(after, 'c:/a.png'), undefined);
  assert.equal(getBaseline(after, 'c:/b.png'), T0);
});

test('null / undefined 基线表不会炸', () => {
  assert.equal(getBaseline(null, 'c:/a.png'), undefined);
  assert.equal(getBaseline(undefined, 'c:/a.png'), undefined);
  assert.deepEqual(recordBaseline(null, 'c:/a.png', T0), { 'c:/a.png': T0 });
});

/* ───────────── 场景级：喂进 decideFaceDrop ───────────── */

/** 把基线比较的结果按 app.ts 的方式接进决策 */
function decideWithFs(input) {
  const localNewer = isNewerThanBaseline(input.fileMtime, input.baseline);
  return decideFaceDrop({
    targetExists: true,
    localCardId: input.localCardId ?? 'card-abc',
    incomingCardId: input.incomingCardId ?? 'card-abc',
    openInTab: false,
    localDirty: input.localDirty ?? false,
    localNewer,
  });
}

test('场景：手工改过文件（mtime 变新）后取回 → **必须弹三选**', () => {
  const d = decideWithFs({ fileMtime: T0 + 60_000, baseline: T0 });
  assert.equal(d.kind, 'ask-dirty', '文件被外部改过时不能静默覆盖');
  assert.match(d.reason, /更新/);
});

test('场景：没动过（mtime 等于基线）→ 直接覆盖，不弹窗', () => {
  const d = decideWithFs({ fileMtime: T0, baseline: T0 });
  assert.equal(d.kind, 'overwrite');
});

test('场景：第一次取回（没有基线）→ 直接覆盖，不拿"没历史"当脏', () => {
  const d = decideWithFs({ fileMtime: T0, baseline: undefined });
  assert.equal(d.kind, 'overwrite');
});

test('场景：编辑器脏 + 文件没变 → 仍然三选（脏态不依赖 mtime）', () => {
  const d = decideWithFs({ fileMtime: T0, baseline: T0, localDirty: true });
  assert.equal(d.kind, 'ask-dirty');
});

test('场景：编辑器干净但文件变新 → 三选（两条信息源是"或"的关系）', () => {
  const d = decideWithFs({ fileMtime: T0 + 1, baseline: T0, localDirty: false });
  assert.equal(d.kind, 'ask-dirty');
});

test('场景：异卡撞名时不因为 mtime 变新就去问——那是另存，没得选', () => {
  /*
   * 这条防的是"判据串味"：异卡的正确处理是加序号另存（不能覆盖别人的卡），
   * 与 mtime 无关。如果实现里把 localNewer 判在身份之前，这里会变成 ask-dirty，
   * 于是用户被问"要不要覆盖"——而正确答案是"根本不该覆盖"。
   */
  const d = decideWithFs({ fileMtime: T0 + 60_000, baseline: T0, localCardId: 'card-other' });
  assert.equal(d.kind, 'save-as');
});

test('场景：另存的目标路径不该触发误判（新路径没有基线、也没有同名文件）', () => {
  /*
   * 另存会写到一个**新路径**（`西奥 (2).png`）。那边通常不存在文件，
   * 守卫走 'write'；即便存在，也是另一份独立的历史，不该继承原路径的基线。
   * 这里用 baselineKey 确认两条路径在基线表里是分开的条目。
   */
  const map = recordBaseline({}, 'C:/cards/西奥.png', T0);
  assert.equal(getBaseline(map, 'C:/cards/西奥 (2).png'), undefined);
});
