/**
 * `mutateSettings` 的三道防线（2026-10-31 第三批补的编排层）。
 *
 * ## 为什么要专门测这个函数
 *
 * `/api/settings/save` **没有 patch 语义**：服务端 `JSON.stringify(body)` 直接写盘。
 * 传 `{ openai_model: 'x' }` 就当场清空其它所有设置，**而且不报错**。
 * 用户只会在某天发现"我的设置全变默认值了"。
 *
 * 所以这个函数是"用户设置不被清空"的唯一防线。
 * 三个纯函数（parse / apply / isSaveOk）早就有了并有测试，
 * 但**编排层此前从未实现** —— 文件头注释写着"对外只暴露 mutateSettings"，
 * 而 `grep -rn mutateSettings` 零结果。注释描述的是计划，不是事实。
 *
 * 这里守的是编排层的三条顺序与三处"宁可不写"的分支。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mutateSettings } from '../shared/src/st-adapter/settings.ts';

/** 一个可控的假传输层：记录 save 被调用时传了什么 */
function makeTransport(envelope, saveResponse = '{"result":"ok"}') {
  const calls = { get: 0, save: [] };
  return {
    calls,
    transport: {
      getRaw: async () => {
        calls.get += 1;
        return typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
      },
      save: async (settings) => {
        calls.save.push(settings);
        return typeof saveResponse === 'string' ? saveResponse : JSON.stringify(saveResponse);
      },
    },
  };
}

/** ST 真实的包裹形状：`settings` 是**字符串**（陷阱 #5） */
const stEnvelope = (settings) => ({
  settings: JSON.stringify(settings),
});

const BASE = { theme: 'dark', lang: 'zh-cn', openai_model: 'gpt-4o-mini', amount_gen: 200 };

/* ═══════════════════════════════════════════════════════════
   一、正常路径：读 → 改 → 整份写回
   ═══════════════════════════════════════════════════════════ */

test('改一个字段，其它字段一个不少地写回去', () => {
  const { calls, transport } = makeTransport(stEnvelope(BASE));
  return mutateSettings(transport, (s) => ({ ...s, openai_model: 'gpt-4o' })).then((r) => {
    assert.equal(r.ok, true);
    assert.equal(calls.get, 1, '必须先读一次');
    assert.equal(calls.save.length, 1, '只能写一次');

    const written = calls.save[0];
    assert.equal(written['openai_model'], 'gpt-4o');
    // 关键：其它四个字段原样保留
    for (const key of ['theme', 'lang', 'amount_gen']) {
      assert.equal(written[key], BASE[key], `${key} 被清掉了`);
    }
  });
});

test('updater 拿到的是一份拷贝，改它不会污染传入对象', async () => {
  /*
   * `applySettingsUpdate` 内部 `{...current}` 浅拷贝后交给 updater。
   * 若哪天改成直接传原对象，updater 里 `s.x = 1` 就会在"保存失败"时
   * 也已经把内存里的状态改掉了 —— 那是"保存失败但界面看起来成功了"。
   */
  const original = { ...BASE };
  const { transport } = makeTransport(stEnvelope(original));
  await mutateSettings(transport, (s) => {
    s['theme'] = 'light';
    return s;
  });
  assert.equal(original['theme'], 'dark', '传入对象不该被就地修改');
});

/* ═══════════════════════════════════════════════════════════
   二、三道防线：每一种失败都**不能写**
   ═══════════════════════════════════════════════════════════ */

test('★ 防线一：响应不是 JSON ⇒ 不写', async () => {
  const { calls, transport } = makeTransport('<html>502 Bad Gateway</html>');
  const r = await mutateSettings(transport, (s) => s);

  assert.equal(r.ok, false);
  assert.equal(calls.save.length, 0, '读不懂当前设置时绝不允许写盘');
  if (!r.ok) assert.match(r.reason, /未保存/);
});

test('★ 防线一：settings 字段缺失 ⇒ 不写', async () => {
  const { calls, transport } = makeTransport({ ok: true });
  const r = await mutateSettings(transport, (s) => s);

  assert.equal(r.ok, false);
  assert.equal(calls.save.length, 0);
});

test('★ 防线二：updater 漏展开导致顶层键减少 ⇒ 不写', async () => {
  /*
   * 这是最真实的失误形态：写 `return { openai_model: 'x' }` 而不是
   * `return { ...s, openai_model: 'x' }`。清库就在这一行。
   */
  const { calls, transport } = makeTransport(stEnvelope(BASE));
  const r = await mutateSettings(transport, () => ({ openai_model: 'x' }));

  assert.equal(r.ok, false);
  assert.equal(calls.save.length, 0, '字段变少时必须拦住，绝不写盘');
  if (!r.ok) assert.match(r.reason, /少了/);
});

test('★ 防线二：updater 抛异常 ⇒ 不写，且不冒出未捕获错误', async () => {
  const { calls, transport } = makeTransport(stEnvelope(BASE));
  const r = await mutateSettings(transport, () => {
    throw new Error('boom');
  });

  assert.equal(r.ok, false);
  assert.equal(calls.save.length, 0);
  if (!r.ok) assert.match(r.reason, /boom/);
});

test('★ 防线三：HTTP 200 但 result 不是 ok ⇒ 报失败', async () => {
  /*
   * 陷阱 #7：`/api/settings/save` 异常时也返回 HTTP 200，错误在响应体里。
   * 判据必须是 `result === 'ok'`，不能看状态码。
   */
  const { transport } = makeTransport(stEnvelope(BASE), '{"result":"error","message":"磁盘只读"}');
  const r = await mutateSettings(transport, (s) => ({ ...s, theme: 'light' }));

  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /拒绝/);
    assert.match(r.reason, /磁盘只读/, '要把服务端给的原因带给用户');
  }
});

test('★ 防线三：保存响应读不懂 ⇒ 不许说成功', async () => {
  const { transport } = makeTransport(stEnvelope(BASE), 'not json');
  const r = await mutateSettings(transport, (s) => ({ ...s, theme: 'light' }));

  assert.equal(r.ok, false, '不知道成没成的时候不许报成功');
  if (!r.ok) assert.match(r.reason, /无法识别/);
});

/* ═══════════════════════════════════════════════════════════
   三、形状兼容：settings 是对象时也能用
   ═══════════════════════════════════════════════════════════ */

test('settings 已经是对象（未来 ST 改返回形态）也能读', async () => {
  const { calls, transport } = makeTransport({ settings: { ...BASE } });
  const r = await mutateSettings(transport, (s) => ({ ...s, theme: 'light' }));

  assert.equal(r.ok, true);
  assert.equal(calls.save[0]['theme'], 'light');
});
