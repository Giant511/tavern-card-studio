/**
 * 设置读改写（v0.1.7 / T15.4）—— `shared/src/st-adapter/settings.ts` 的单测。
 *
 * ## 这一组守的是"用户设置被清空"
 *
 * `/api/settings/save` **没有 patch 语义**（服务端直接 `JSON.stringify(body)` 写盘）。
 * 传一个只含一个字段的对象，其它设置当场全清 —— 而不报错。
 * 用户只会在某天发现"我的设置全变默认值了"。
 *
 * 所以判据不是"能不能改成功"，而是"**改失败时有没有拒绝保存**"。
 * 这一点与常见的"尽力而为"相反：宁可这次保存不做，也不能写半份进去。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applySettingsUpdate,
  isSaveOk,
  parseSettingsEnvelope,
} from '@tcs/shared';

/* ───────────── 读：settings 是字符串（陷阱 #5） ───────────── */

test('★ settings 字段是字符串时要二次 parse（陷阱 #5）', () => {
  /*
   * 直接当对象用会得到一堆 undefined —— 表现为"读到了设置但每个字段都空"。
   */
  const envelope = { settings: '{"temperature":0.8,"model":"gpt-4o"}', other: 1 };
  const result = parseSettingsEnvelope(envelope);
  assert.equal(result.ok, true);
  assert.equal(result.settings.temperature, 0.8);
});

test('字符串内容是坏 JSON 时给出可显示的原因，不抛异常', () => {
  const result = parseSettingsEnvelope({ settings: '{坏掉的' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /解析失败/);
});

test('已经是对象也能用（防御未来 ST 改形状）', () => {
  const result = parseSettingsEnvelope({ settings: { a: 1 } });
  assert.equal(result.ok, true);
  assert.equal(result.settings.a, 1);
});

test('缺 settings 字段 / 整体不是对象都要有明确原因', () => {
  assert.equal(parseSettingsEnvelope({}).ok, false);
  assert.equal(parseSettingsEnvelope(null).ok, false);
  assert.equal(parseSettingsEnvelope('字符串').ok, false);
});

/* ───────────── 写：整份覆盖的两道保护 ───────────── */

test('正常修改产出完整对象（不是只有改动字段）', () => {
  const current = { temperature: 0.8, model: 'a', theme: 'dark' };
  const result = applySettingsUpdate(current, (s) => ({ ...s, temperature: 1.2 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.next, { temperature: 1.2, model: 'a', theme: 'dark' });
});

test('★ updater 丢字段时**拒绝保存**（这是防清空的核心）', () => {
  /*
   * 典型错法：`() => ({ temperature: 1.2 })` 忘了展开。
   * 若放行，用户的 model / theme 会被清空，且不报错。
   */
  const current = { temperature: 0.8, model: 'a', theme: 'dark' };
  const result = applySettingsUpdate(current, () => ({ temperature: 1.2 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /少了 2 个字段/);
});

test('★ updater 抛异常时拒绝保存（不"尽力而为"）', () => {
  const current = { a: 1 };
  const result = applySettingsUpdate(current, () => {
    throw new Error('算错了');
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /已取消保存/);
});

test('updater 返回非对象时拒绝', () => {
  assert.equal(applySettingsUpdate({ a: 1 }, () => null).ok, false);
  assert.equal(applySettingsUpdate({ a: 1 }, () => []).ok, false);
});

test('每个成功结果都是新对象，原对象不被改', () => {
  /*
   * 原地改会让"改到一半抛异常"变成半截状态，而它紧接着会被整份写盘 ——
   * 等于把半成品存进用户文件。
   */
  const current = { a: 1 };
  const result = applySettingsUpdate(current, (s) => {
    s.a = 2;
    return s;
  });
  assert.equal(result.ok, true);
  assert.equal(current.a, 1, '原对象被改了');
  assert.equal(result.next.a, 2);
});

/* ───────────── 保存成功的判据（陷阱 #7） ───────────── */

test('★ 保存成功判据是 result==="ok"，不是 HTTP 状态码', () => {
  /*
   * 异常时也返回 200，错误在响应体里。判状态码会以为成功。
   */
  assert.equal(isSaveOk({ result: 'ok' }), true);
  assert.equal(isSaveOk({ result: 'error' }), false);
  assert.equal(isSaveOk({}), false);
  assert.equal(isSaveOk(null), false);
  assert.equal(isSaveOk('ok'), false);
});
