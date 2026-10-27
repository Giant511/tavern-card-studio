/**
 * 用户预设库的读写时序（v0.1.5 / G5）。
 *
 * 格式层（往返、坏条目跳过）在 `preset-store.test.mjs` 里测过了。这里只测
 * **时序与失败路径** —— 那是格式测试覆盖不到、也最容易出事的半边：
 *
 *   · 首次运行（没有文件）不该报错；
 *   · 库文件读不动时**不能写**（否则把用户还能手工修的文件覆盖掉）；
 *   · 连续导入两次不能互相覆盖（read-modify-write 竞态）；
 *   · 写失败要如实返回 `saved:false`（调用方据此提示，静默失败=用户以为存好了）。
 *
 * 这个类**不 import contract**（IO 由构造注入），所以这里不需要壳、
 * 不需要 Tauri IPC 桩 —— 直接给个假文件系统就能跑。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PresetPersistence } from '../client/src/rules/preset-persist.ts';

/**
 * 假 IO：把所有写入攒起来，可注入失败与延迟。
 *
 * @param {{ initial?: string | null, readError?: Error, writeError?: Error, delayMs?: number }} [options]
 */
function makeIo(options = {}) {
  const writes = [];
  let stored = options.initial ?? null;
  return {
    writes,
    get stored() {
      return stored;
    },
    async read() {
      if (options.readError) throw options.readError;
      return stored === null ? null : { text: stored };
    },
    async write(text) {
      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (options.writeError) throw options.writeError;
      writes.push(text);
      stored = text;
      return { verified: true };
    },
  };
}

test('首次运行：没有库文件 → 空库、无警告、不写盘', async () => {
  const io = makeIo();
  const store = new PresetPersistence(io);
  const loaded = await store.load();
  assert.deepEqual(loaded.items, []);
  assert.deepEqual(loaded.warnings, [], '没有文件是正常状态，不该吓用户');
  assert.equal(loaded.present, false);
  assert.equal(io.writes.length, 0);
});

test('读失败 → 之后一律不写（保住用户还能手工修的文件）', async () => {
  const io = makeIo({ readError: new Error('EBUSY') });
  const store = new PresetPersistence(io);
  const loaded = await store.load();
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0], /读取失败/);

  const result = await store.remember('txt', 'a.json', '{"id":"a"}', 'a');
  assert.equal(result.saved, false, '读不动的库不许写');
  assert.match(result.error ?? '', /不可写/);
  assert.equal(io.writes.length, 0, '一个字节都不该写');
});

test('库文件内容坏掉 → 同样不写（不替用户清空）', async () => {
  const io = makeIo({ initial: '{ 这不是 JSON' });
  const store = new PresetPersistence(io);
  const loaded = await store.load();
  assert.equal(loaded.present, true);
  assert.match(loaded.warnings.join(' '), /不是合法 JSON/);
  assert.match(loaded.warnings.join(' '), /不会覆盖/);

  const result = await store.remember('txt', 'a', '{"id":"a"}', 'a');
  assert.equal(result.saved, false);
  assert.equal(io.writes.length, 0);
});

test('导入即落盘：remember 后磁盘内容含这条，重启能读回来', async () => {
  const io = makeIo();
  const first = new PresetPersistence(io);
  await first.load();
  const result = await first.remember('worldbook', '幻梦AI世界书格式预设.json', '{"id":"huanmeng"}', 'huanmeng');
  assert.equal(result.saved, true);
  assert.equal(io.writes.length, 1);

  // 「重启」：新建实例读同一份磁盘内容
  const second = new PresetPersistence(io);
  const loaded = await second.load();
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.items[0].kind, 'worldbook');
  assert.equal(loaded.items[0].id, 'huanmeng');
  assert.equal(loaded.items[0].text, '{"id":"huanmeng"}');
});

test('同 id 再导一次 → 库里仍是一条（不是两条）', async () => {
  const io = makeIo();
  const store = new PresetPersistence(io);
  await store.load();
  await store.remember('worldbook', 'a', '{"id":"w","v":1}', 'w');
  await store.remember('worldbook', 'a', '{"id":"w","v":2}', 'w');

  const reloaded = new PresetPersistence(io);
  const loaded = await reloaded.load();
  assert.equal(loaded.items.length, 1);
  assert.match(loaded.items[0].text, /"v":2/);
});

test('连续导入并发时串行化：两条都在，没有互相覆盖', async () => {
  // 延迟 5ms 放大竞态窗口：去掉队列的话这里会只剩一条
  const io = makeIo({ delayMs: 5 });
  const store = new PresetPersistence(io);
  await store.load();

  await Promise.all([
    store.remember('worldbook', 'a', '{"id":"w"}', 'w'),
    store.remember('greeting', 'b', '{"id":"g"}', 'g'),
    store.remember('txt', 'c', '{"id":"t"}', 't'),
  ]);
  await store.flush();

  const reloaded = new PresetPersistence(io);
  const loaded = await reloaded.load();
  assert.deepEqual(
    loaded.items.map((item) => item.id).sort(),
    ['g', 't', 'w'],
    '三条都要在 —— 少了就是 read-modify-write 竞态',
  );
});

test('写失败 → saved:false 且给出原因（调用方据此提示"重启会丢"）', async () => {
  const io = makeIo({ writeError: new Error('磁盘满了') });
  const store = new PresetPersistence(io);
  await store.load();
  const result = await store.remember('txt', 'a', '{"id":"a"}', 'a');
  assert.equal(result.saved, false);
  assert.match(result.error ?? '', /磁盘满了/);
  // 内存里仍要记住：这次运行内导入的预设必须可用
  assert.equal(store.items.length, 1);
});

test('clear 写空库而不是删文件（"没有文件"与"主动清空"要能区分）', async () => {
  const io = makeIo();
  const store = new PresetPersistence(io);
  await store.load();
  await store.remember('txt', 'a', '{"id":"a"}', 'a');
  await store.clear();
  assert.equal(store.items.length, 0);

  const reloaded = new PresetPersistence(io);
  const loaded = await reloaded.load();
  assert.equal(loaded.present, true, '文件还在（空库），不是"没有文件"');
  assert.deepEqual(loaded.items, []);
});

test('读出坏条目时只丢那一条，其余可用（端到端串一遍）', async () => {
  const io = makeIo({
    initial: JSON.stringify({
      version: 1,
      items: [
        { kind: 'worldbook', id: 'good', name: 'a', text: '{"id":"good"}' },
        { kind: 'not-a-kind', id: 'bad', name: 'b', text: '{}' },
        { kind: 'greeting', id: 'good2', name: 'c', text: '{"id":"good2"}' },
      ],
    }),
  });
  const store = new PresetPersistence(io);
  const loaded = await store.load();
  assert.deepEqual(
    loaded.items.map((item) => item.id),
    ['good', 'good2'],
  );
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0], /无法识别/);
});
