/**
 * 聊天记录导出 TXT 的判据（2026-11-14，v0.1.9）。
 *
 * 五条需求口径来自 `PLAN.md` v0.1.9 §二（2026-11-09 用户确认）：
 *
 * ```text
 * ① is_user 判说话人，不按顺序猜
 * ② send_date 是字符串 —— 能解析就转本地格式，解析不了原样输出
 * ③ swipes 候选不导出，但末尾要注明数量
 * ④ 空聊天要能导出并说明"还没有聊天记录"，不许生成空文件
 * ⑤ 群聊要带角色名
 * ```
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatExportFileName, chatToText } from '../shared/dist/chat/chat-export.js';

const NOW = new Date('2026-11-14T20:30:00+08:00');

/** 造一条消息 */
function msg(over = {}) {
  return { name: '镜中旅人', is_user: false, mes: '正文', send_date: '2026-11-08T21:03:00+08:00', ...over };
}

/* ═══════════════════════════════════════════════════════════
   ① 说话人由 is_user 决定
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 说话人按 is_user 判，不按顺序猜', () => {
  /*
   * 按顺序猜（"单数是我、双数是角色"）在**重新生成**和**删消息**之后
   * 就会错位 —— 而错位后整份记录读起来是"角色在自问自答"。
   */
  const out = chatToText(
    [
      msg({ is_user: true, mes: '这里还有位置吗？' }),
      msg({ is_user: false, mes: '靠窗那个位置一直空着。' }),
      /* 故意连续两条非用户消息：按顺序猜会把它判成用户 */
      msg({ is_user: false, mes: '（他把杯子推过来）' }),
    ],
    { characterName: '镜中旅人', userName: '旅人', now: NOW },
  );

  assert.equal(out.count, 3);
  assert.match(out.text, /旅人：\n这里还有位置吗？/, '用户消息归给 userName');
  assert.match(out.text, /镜中旅人：\n靠窗那个位置一直空着。/, '角色消息归给卡名');
  /* 第三条仍必须是角色，不能因为相邻就翻面 */
  assert.equal(out.text.match(/镜中旅人：/g).length, 2, '连续两条角色消息都要归角色');
});

test('★★★★ 没给 userName 时退回「我」', () => {
  const out = chatToText([msg({ is_user: true, mes: '嗯' })], { characterName: 'A', now: NOW });
  assert.match(out.text, /我：\n嗯/);
});

/* ═══════════════════════════════════════════════════════════
   ② 时间：能解析就转格式，不能就原样
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 时间的两种形态都要认（ISO 与英文人读格式）', () => {
  /*
   * ST 存的是 `"November 8, 2026 9:03pm"` 这类英文格式，
   * 而有些路径给 ISO。只认一种的话另一半记录时间全空白。
   */
  const iso = chatToText([msg({ send_date: '2026-11-08T21:03:00+08:00' })], {
    characterName: 'A',
    now: NOW,
  });
  assert.match(iso.text, /\[2026-11-08 21:03\]/, 'ISO 要转成本地格式');

  const human = chatToText([msg({ send_date: 'November 8, 2026 9:03pm' })], {
    characterName: 'A',
    now: NOW,
  });
  assert.match(human.text, /\[2026-11-08 21:03\]/, '英文格式也要解析得出');
});

test('★★★★★ 解析不了的时间要原样输出，绝不许出现 Invalid Date', () => {
  /*
   * `Invalid Date` 对用户毫无信息量，还显得程序坏了。
   * 原样输出至少让他知道"记录里存的就是这个字符串"。
   */
  const out = chatToText([msg({ send_date: '昨天下午' })], { characterName: 'A', now: NOW });
  assert.match(out.text, /\[昨天下午\]/, '原样保留');
  assert.doesNotMatch(out.text, /Invalid Date|NaN|undefined/, '不许漏出程序内部字眼');
});

test('★★★★ 没有 send_date 时不写方括号（不制造噪音）', () => {
  const out = chatToText([msg({ send_date: undefined })], { characterName: 'A', now: NOW });
  assert.match(out.text, /\n镜中旅人：\n正文/, '直接写说话人');
  assert.doesNotMatch(out.text, /\[\]/, '不许出现空方括号');
});

/* ═══════════════════════════════════════════════════════════
   ③ 候选回复：不导出但要点数
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 候选回复不导出，但末尾要注明数量', () => {
  /*
   * 用户的心智模型是"我的聊天记录全在这"。候选回复突然消失而无人提起，
   * 他会以为导出丢内容。说一句"另有 N 条未采用"就把这件事关掉了。
   */
  const out = chatToText(
    [
      msg({ mes: '第一条回复', swipes: ['第一条回复', '备选 A', '备选 B'] }),
      msg({ is_user: true, mes: '嗯' }),
    ],
    { characterName: 'A', now: NOW },
  );

  assert.equal(out.skippedSwipes, 2, '3 个候选 - 当前 1 个 = 2 条未采用');
  assert.doesNotMatch(out.text, /备选 A|备选 B/, '候选正文不许出现在文件里');
  assert.match(out.text, /另有 2 条未采用的候选回复未导出/, '末尾要说明');
});

test('★★★★ 没有候选时不许出现那行说明', () => {
  const out = chatToText([msg({ swipes: ['只有一条'] })], { characterName: 'A', now: NOW });
  assert.equal(out.skippedSwipes, 0);
  assert.doesNotMatch(out.text, /未采用的候选回复/, '没有就不提，否则是噪音');
});

/* ═══════════════════════════════════════════════════════════
   ④ 空聊天
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 空聊天要导出一段说明，不是空文件', () => {
  /*
   * 0 字节文件会让用户以为"导出坏了"或"记录丢了" ——
   * 而事实是这个角色还没开始聊。说一句就清楚了。
   */
  const out = chatToText([], { characterName: '镜中旅人', now: NOW });

  assert.equal(out.empty, true);
  assert.equal(out.count, 0);
  assert.ok(out.text.length > 0, '不许是空串');
  assert.match(out.text, /还没有聊天记录/, '要说清');
  assert.match(out.text, /镜中旅人/, '标题仍要有卡名');
});

test('★★★★ 全是 is_system 或空正文也算空', () => {
  /*
   * 只有系统提示、没有真实对话 —— 导出成空文件同样是坑。
   */
  const out = chatToText(
    [
      msg({ is_system: true, mes: '系统提示' }),
      msg({ mes: '   ' }),
    ],
    { characterName: 'A', now: NOW },
  );
  assert.equal(out.empty, true);
  assert.match(out.text, /还没有聊天记录/);
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 群聊 / 多角色
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 群聊按 message.name 区分角色，不写死卡名', () => {
  /*
   * 写死成卡名的话，群聊里三个角色的话全归到一个人头上 ——
   * 那份记录读起来像"一个角色在自言自语"。
   */
  const out = chatToText(
    [
      msg({ name: '威廉', mes: '训练结束了。' }),
      msg({ name: '格兹', mes: '饿。' }),
      msg({ is_user: true, mes: '去吃饭吧' }),
    ],
    { characterName: '群聊', userName: '旅人', now: NOW },
  );

  assert.match(out.text, /威廉：\n训练结束了。/);
  assert.match(out.text, /格兹：\n饿。/);
  assert.match(out.text, /旅人：\n去吃饭吧/);
});

test('★★★★ 名字为空时给占位，不许出现空的说话人', () => {
  const out = chatToText([msg({ name: '  ' })], { characterName: 'A', now: NOW });
  assert.match(out.text, /角色：\n正文/, '空名字要落到「角色」');
});

/* ═══════════════════════════════════════════════════════════
   头部与文件名
   ═══════════════════════════════════════════════════════════ */

test('★★★ 头部要含卡名、导出时间、条数', () => {
  const out = chatToText([msg(), msg()], { characterName: '镜中旅人', now: NOW });
  assert.match(out.text, /^镜中旅人 · 聊天记录\n/, '标题');
  assert.match(out.text, /导出时间：2026-11-14 20:30/, '导出时间');
  assert.match(out.text, /共 2 条/, '条数');
});

test('★★★ 文件名要安全且带「聊天记录」后缀', () => {
  assert.equal(chatExportFileName('镜中旅人'), '镜中旅人 · 聊天记录.txt');
  /* 非法字符要滤掉，不许造出无法创建的文件名 */
  assert.doesNotMatch(chatExportFileName('a/b:c*?"<>|'), /[/\\:*?"<>|]/);
  assert.equal(chatExportFileName('   '), '聊天记录 · 聊天记录.txt', '空名要有兜底');
  assert.equal(chatExportFileName('x.txt'), 'x · 聊天记录.txt', '重复扩展名要去掉');
});
