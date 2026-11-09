/**
 * 兼容旧版导出 + 无缝升级到当前规则（2026-11-05，用户决定 5）。
 *
 * > 需要想办法在手机里兼容旧版本的导出并且无缝升级到现有导出规则。
 *
 * ## 「兼容」拆成两条可验的事
 *
 * ```text
 *   ① 读得进：旧产物能打开，四段内容原样出现，**不改任何字节**
 *   ② 升得上：用户点一次保存，产物就带上当前规则
 * ```
 *
 * 这两条必须分开验。只验 ② 会出现"升级了、但顺手把旧卡内容改了"——
 * 那是最糟的结果：用户没动过的东西被静默改掉。
 *
 * ## 为什么用**构造出来的**旧卡，不用真卡
 *
 * 真卡是用户内容（硬门 3：用户内容不进仓库）。所以这里按
 * 历史版本产物的**已知特征**构造样本：
 *
 * - V1 平铺（没有 `data` 段）—— 2019~2022 年的卡几乎都是这样
 * - V2 但世界书条目只有 `name`、没有 `comment` —— 我们 v0.1.7 之前导出的样子
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseStCardText, stringifyStCard } from '@tcs/shared';

/** V1 平铺卡（最旧的形态：字段全在顶层，没有 data 段） */
function v1Flat() {
  return {
    name: 'V1 旧卡',
    description: '【基本信息】\n姓名：V1',
    personality: '安静',
    scenario: 'V1 场景',
    first_mes: 'V1 开场白',
    mes_example: '{{user}}: 旧写法\n{{char}}: 回应',
    creatorcomment: '',
    avatar: 'none',
    talkativeness: '0.5',
    fav: false,
    tags: [],
  };
}

/** V2，但世界书条目只有 `name`（我们 v0.1.7 之前导出的样子） */
function v2WithoutComment() {
  const data = {
    name: '旧卡',
    description: '【基本信息】\n姓名：旧卡',
    personality: '冷淡',
    scenario: '旧场景',
    first_mes: '旧开场白',
    mes_example: '用户：旧示例\n角色：回应',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: ['备用一', '备用二'],
    character_book: {
      name: '旧世界书',
      entries: [
        {
          name: '条目标题',
          keys: ['关键词'],
          content: '条目内容不能被改',
          enabled: true,
          insertion_order: 1,
        },
      ],
    },
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
  };
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data,
    /* V1 兼容副本 */
    name: data.name,
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
  };
}

const FOUR = ['scenario', 'first_mes', 'mes_example'];

test('★★★ 旧 V1 平铺卡读得进，四段内容一字不差', () => {
  const src = v1Flat();
  const parsed = parseStCardText(JSON.stringify(src));
  assert.deepEqual(parsed.issues, [], 'V1 卡不该报解析问题');

  const r = parsed.card.residual;
  assert.equal(r.scenario, src.scenario);
  assert.equal(r.firstMes, src.first_mes);
  assert.equal(r.mesExample, src.mes_example);
});

test('★★★ 旧 V1 卡未编辑往返：不丢字段（只允许新增默认值）', () => {
  /*
   * V1 → 当前结构的升级本来就要补 `creator` / `character_version` /
   * `extensions` 这些 V2 才有的键。**新增是允许的，丢字段不允许** ——
   * 丢一个就是用户数据没了。
   */
  const src = v1Flat();
  const parsed = parseStCardText(JSON.stringify(src));
  const out = JSON.parse(stringifyStCard(parsed.card, { indent: 2 }));

  const lost = Object.keys(src).filter((key) => !(key in out));
  assert.deepEqual(lost, [], `往返后丢了这些键：${lost.join(',')}`);

  for (const key of FOUR) {
    assert.equal(out[key], src[key], `未编辑往返改了 ${key}`);
  }
});

test('★★★ 旧 V2（条目无 comment）未编辑往返：内容零漂移', () => {
  const src = v2WithoutComment();
  const parsed = parseStCardText(JSON.stringify(src));
  const out = JSON.parse(stringifyStCard(parsed.card, { indent: 2 }));
  const data = out.data ?? out;

  for (const key of [...FOUR, 'name', 'description', 'personality']) {
    assert.equal(data[key], src.data[key], `未编辑往返改了 ${key}`);
  }

  /* 世界书条目：条数、标题、正文都不能变 */
  const entries = data.character_book?.entries ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, '条目标题');
  assert.equal(entries[0].content, '条目内容不能被改');
});

test('★★★ 备用开场白读得进（数组不能拍扁成一条）', () => {
  const parsed = parseStCardText(JSON.stringify(v2WithoutComment()));
  assert.deepEqual(parsed.card.residual.alternateGreetings, ['备用一', '备用二']);
});

test('★★★ 保存 = 升级：世界书条目标题补进 comment（ST 面板读的那个字段）', () => {
  /*
   * 这是"无缝升级"的核心一条。旧版导出的条目只有 `name`，
   * 而 ST 的世界书面板读 `comment` ⇒ 导进 ST 后每条标题都是空白。
   *
   * 用户点一次「保存到卡片」，就补上了 —— 不需要单独的迁移工具。
   */
  const parsed = parseStCardText(JSON.stringify(v2WithoutComment()));
  const out = JSON.parse(
    stringifyStCard(parsed.card, { indent: 2, entryTitleToComment: true }),
  );
  const entry = (out.data ?? out).character_book?.entries?.[0];

  assert.equal(entry?.comment, '条目标题', 'comment 应补成原来的标题');
  assert.equal(entry?.content, '条目内容不能被改', '升级不能动正文');
});

test('★★★ 升级只补字段、不改正文（用户没动过的内容必须原样）', () => {
  /*
   * 最容易写错的升级方式是"重新渲染一遍"。一旦渲染口径和原文有差
   * （多一个空行、少一个换行），用户的 3000 字描述就被静默改了。
   * 这里逐字节比 `description`。
   */
  const src = v2WithoutComment();
  const parsed = parseStCardText(JSON.stringify(src));
  const out = JSON.parse(
    stringifyStCard(parsed.card, { indent: 2, entryTitleToComment: true }),
  );
  assert.equal((out.data ?? out).description, src.data.description);
});

test('★★ 旧卡里本来就有的 comment 不许被 name 覆盖', () => {
  /*
   * 补 comment 时必须"只在没有时补"。无脑覆盖会把用户自己写的
   * 条目标题改掉 —— 而那个标题是他手写的中文说明，name 是英文 id。
   */
  const src = v2WithoutComment();
  src.data.character_book.entries[0].comment = '我自己写的标题';
  src.data.character_book.entries[0].name = 'entry_0';

  const parsed = parseStCardText(JSON.stringify(src));
  const out = JSON.parse(
    stringifyStCard(parsed.card, { indent: 2, entryTitleToComment: true }),
  );
  const entry = (out.data ?? out).character_book?.entries?.[0];
  assert.equal(entry?.comment, '我自己写的标题', '已有的 comment 不能被 name 顶掉');
});

test('★★ 旧卡里"没用 <START>"的示例对话，读取时必须原样保留', () => {
  /*
   * 兼容旧版最重要的一条：**读的时候不解释、不归一**。
   *
   * 官方读卡时会把这种写法整块丢掉（匹配不到说话人前缀），
   * 我们要做到"至少不丢"；而"要不要转成标准写法"是用户点保存时的事，
   * 不在读的时候替他决定。
   */
  const src = v2WithoutComment();
  const parsed = parseStCardText(JSON.stringify(src));
  assert.equal(parsed.card.residual.mesExample, '用户：旧示例\n角色：回应');
  assert.equal(
    parsed.card.residual.mesExample.includes('<START>'),
    false,
    '读取时不该偷偷插入 <START>',
  );
});
