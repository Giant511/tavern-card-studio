/**
 * 「另存为」的格式选择（v0.1.5 / G6）。
 *
 * 三条判据都是"选错了会静默出错"的那类：
 *   · 扩展名剥离只认已知扩展名 —— 通配会把 `西奥 v1.2` 的版本号当扩展名剥掉；
 *   · 格式要能记在会话上 —— 否则另存为 PNG 后 Ctrl+S 会在 .png 路径上写 JSON；
 *   · 三种格式的产物必须与「导出」逐字节一致 —— 两条链路分叉就是两份不同内容。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SAVE_FORMATS,
  isSaveFormat,
  saveFormatNote,
  saveFormatOption,
  withSaveExtension,
} from '../client/src/session/save-format.ts';

test('三种格式齐全且顺序稳定（JSON 第一 = 默认）', () => {
  assert.deepEqual(
    SAVE_FORMATS.map((item) => item.format),
    ['json', 'txt', 'png'],
  );
  assert.equal(SAVE_FORMATS[0].extension, 'json');
});

test('换扩展名：常见三种都能换过去', () => {
  assert.equal(withSaveExtension('西奥.json', 'txt'), '西奥.txt');
  assert.equal(withSaveExtension('西奥.txt', 'png'), '西奥.png');
  assert.equal(withSaveExtension('西奥.png', 'json'), '西奥.json');
});

test('名字里带点/版本号时不被切坏（通配正则的经典坑）', () => {
  // `西奥 v1.2` 若按 /\.[^.]+$/ 剥离会变成 `西奥 v1` —— 版本号被当扩展名
  assert.equal(withSaveExtension('西奥 v1.2', 'png'), '西奥 v1.2.png');
  assert.equal(withSaveExtension('Dr. Smith', 'json'), 'Dr. Smith.json');
  assert.equal(withSaveExtension('西奥 v1.2.json', 'txt'), '西奥 v1.2.txt');
});

test('没有扩展名时直接补，不会吃掉名字的一部分', () => {
  assert.equal(withSaveExtension('西奥', 'json'), '西奥.json');
});

test('点开头的隐藏式名字不当作"有扩展名"', () => {
  assert.equal(withSaveExtension('.hidden', 'txt'), '.hidden.txt');
});

test('未知后缀原样保留（不猜）', () => {
  // `.bak` 不是我们认识的扩展名 —— 当成名字的一部分更安全
  assert.equal(withSaveExtension('西奥.bak', 'json'), '西奥.bak.json');
});

test('isSaveFormat 只认那三个字面量', () => {
  for (const value of ['json', 'txt', 'png']) assert.equal(isSaveFormat(value), true);
  for (const value of ['JSON', 'md', '', null, undefined, 1]) assert.equal(isSaveFormat(value), false);
});

test('saveFormatOption 对未知格式抛错（不静默退回默认）', () => {
  assert.throws(() => saveFormatOption('md'), /未知的保存格式/);
});

test('只对非 JSON 提示"以后按这个格式写回"（JSON 是默认，不必废话）', () => {
  assert.equal(saveFormatNote('json'), '');
  assert.match(saveFormatNote('txt'), /TXT/);
  assert.match(saveFormatNote('png'), /PNG/);
  assert.match(saveFormatNote('png'), /直到你再次另存为/);
});
