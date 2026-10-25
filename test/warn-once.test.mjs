/**
 * 「同一配置状态只警告一次」（v0.1.3 真机反馈）。
 *
 * 症状：err.log 里同一条 SecurityWarning 出现 4 次（PID 各不相同）——
 * worker 每次重启都打一遍。看起来像"服务一直在出问题"，实际是同一件事被念了 4 遍，
 * 真正的新警告会淹没在噪声里。
 *
 * 判据：
 *   · 同一签名只发一次（跨进程也要去重 → 靠落盘，不是内存）；
 *   · 配置一变（签名变）立刻重新提示；
 *   · **写不进状态文件时照常警告** —— 宁可多念一遍，也不能把安全警告吞掉。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { warnOnce } from '../server/dist/warn-once.js';

let workDir;
let seq = 0;
before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-warn-'));
});
after(() => {
  rmSync(workDir, { recursive: true, force: true });
});
function freshDir() {
  seq += 1;
  const dir = join(workDir, `case-${String(seq)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 收集 emit 的调用，代替 process.emitWarning */
function collector() {
  const messages = [];
  return { messages, emit: (message) => messages.push(message) };
}

test('warn-once 同一签名的第二次调用不再发警告', () => {
  const dir = freshDir();
  const sink = collector();
  const base = {
    dataDir: dir,
    key: 'security:open-register-non-loopback',
    signature: 'open|0.0.0.0',
    message: '危险配置',
    emit: sink.emit,
  };

  assert.equal(warnOnce(base), true, '第一次应发出');
  assert.equal(warnOnce(base), false, '同一签名第二次不该再发');
  assert.deepEqual(sink.messages, ['危险配置']);
});

test('warn-once 配置变更（签名变化）后重新提示', () => {
  const dir = freshDir();
  const sink = collector();
  const base = { dataDir: dir, key: 'k', message: 'm', emit: sink.emit };

  assert.equal(warnOnce({ ...base, signature: 'open|0.0.0.0' }), true);
  assert.equal(warnOnce({ ...base, signature: 'open|0.0.0.0' }), false);
  // 改成另一个非回环地址：仍然是危险状态，但**配置变了**，要再提示一次
  assert.equal(warnOnce({ ...base, signature: 'open|10.9.0.2' }), true);
  // 改回原来的状态也算"变了"（上次记录是 10.9.0.2）
  assert.equal(warnOnce({ ...base, signature: 'open|0.0.0.0' }), true);
  assert.equal(sink.messages.length, 3);
});

test('warn-once 状态落盘：换一个"进程"（重新调用）仍然去重', () => {
  const dir = freshDir();
  const first = collector();
  const base = { dataDir: dir, key: 'k', signature: 's', message: 'm' };

  assert.equal(warnOnce({ ...base, emit: first.emit }), true);
  assert.equal(existsSync(join(dir, '.warned.json')), true, '状态必须落盘，否则跨重启无效');

  // 模拟服务重启：新的"进程"读同一份状态，应判断为"已警告过"
  const second = collector();
  assert.equal(warnOnce({ ...base, emit: second.emit }), false);
  assert.deepEqual(second.messages, [], '重启后不该重复打印');
});

test('warn-once 写不进状态文件时照常警告（宁可多念一遍）', () => {
  // dataDir 指向一个**文件**：mkdirSync 必然失败
  const blocked = join(freshDir(), 'not-a-dir');
  writeFileSync(blocked, 'x', 'utf8');
  const sink = collector();

  assert.equal(
    warnOnce({ dataDir: blocked, key: 'k', signature: 's', message: '必须被看见', emit: sink.emit }),
    true,
  );
  assert.deepEqual(sink.messages, ['必须被看见']);
});

test('warn-once 状态文件损坏时按"没警告过"处理，不静默失败', () => {
  const dir = freshDir();
  writeFileSync(join(dir, '.warned.json'), '{不是 JSON', 'utf8');
  const sink = collector();

  assert.equal(warnOnce({ dataDir: dir, key: 'k', signature: 's', message: 'm', emit: sink.emit }), true);
  assert.deepEqual(sink.messages, ['m']);
});
