/**
 * Round-trip 无损测试（T1.2 / T2.4 的 JSON 部分）
 * 运行：npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createEmptyCard,
  parseStCard,
  serializeStCard,
  setBlockText,
  stringifyStCard,
} from '../shared/dist/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample-card.json', import.meta.url));
const original = JSON.parse(readFileSync(FIXTURE, 'utf8'));

test('V2 卡片：preserve 模式导出与原始 JSON 完全一致', () => {
  const { card, issues } = parseStCard(original);
  assert.equal(issues.length, 0, '示例卡片不应产生解析告警');
  const out = serializeStCard(card, { legacyTopLevel: 'preserve' });
  assert.deepStrictEqual(out, original);
});

test('V2 卡片：sync 模式导出后 data 段与原始完全一致', () => {
  const { card } = parseStCard(original);
  const out = serializeStCard(card);
  assert.deepStrictEqual(out.data, original.data);
  assert.equal(out.name, original.data.name);
  assert.equal(out.description, original.data.description);
  assert.equal(out.spec, 'chara_card_v2');
  assert.equal(out.spec_version, '2.0');
});

test('V2 卡片：未知顶层字段与 data 扩展字段不丢失', () => {
  const withExtra = structuredClone(original);
  withExtra.data.custom_vendor = { foo: [1, 2, 3] };
  withExtra.top_unknown = 42;
  const { card } = parseStCard(withExtra);
  const out = serializeStCard(card, { legacyTopLevel: 'preserve' });
  assert.deepStrictEqual(out.data.custom_vendor, { foo: [1, 2, 3] });
  assert.equal(out.top_unknown, 42);
});

test('六个板块解析正确：心理活动/存档信息/用户设定按标题归位', () => {
  const { card } = parseStCard(original);
  const byId = Object.fromEntries(card.blocks.map((block) => [block.id, block.text]));
  assert.ok(byId.basic.includes('身高：168cm'));
  assert.ok(byId.personality.includes('观察力强'));
  assert.ok(byId.settings.includes('聊天输出格式'));
  assert.ok(byId.special.includes('二楼'));
  assert.ok(byId.user.includes('{{user}}'));
  assert.equal(card.description.structured, true);
});

test('修改单个板块：只有该段变化，其余字节保持不变', () => {
  const { card } = parseStCard(original);
  setBlockText(card, 'special', '二楼是她的私人空间，绝不对外开放。');
  const out = serializeStCard(card);

  assert.equal(out.data.personality, original.data.personality);
  assert.ok(out.data.description.includes('二楼是她的私人空间'));
  assert.ok(!out.data.description.includes('上面只是仓库'));
  assert.ok(out.data.description.includes('身高：168cm'));
  assert.ok(out.data.description.includes('聊天输出格式'));
});

test('修改性格板块只影响 personality 字段，不改 description', () => {
  const { card } = parseStCard(original);
  setBlockText(card, 'personality', '外冷内热，话少但可靠。');
  const out = serializeStCard(card);
  assert.equal(out.data.personality, '外冷内热，话少但可靠。');
  assert.equal(out.data.description, original.data.description);
});

test('无标题 description：整体归入基本信息且可无损回写', () => {
  const plain = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '无结构',
      description: '  这是一段没有标题的描述。\n\n第二段，带空行。  ',
      personality: '话少',
      scenario: '',
      first_mes: '你好',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '',
      extensions: {},
    },
    name: '无结构',
  };
  const { card } = parseStCard(plain);
  assert.equal(card.description.structured, false);
  const basic = card.blocks.find((block) => block.id === 'basic');
  assert.equal(basic.text, '这是一段没有标题的描述。\n\n第二段，带空行。');
  const out = serializeStCard(card, { legacyTopLevel: 'preserve' });
  assert.equal(out.data.description, plain.data.description);
});

test('V1 卡片：解析与回写保持一致', () => {
  const v1 = {
    name: '旧卡',
    description: '【基本信息】\n年龄 30',
    personality: '沉稳',
    scenario: '雨夜',
    first_mes: '你来了。',
    mes_example: '',
    creatorcomment: '作者备注',
    tags: ['复古'],
    creator: 'someone',
    character_version: '0.9',
    extensions: { foo: 'bar' },
    talkativeness: '0.4',
  };
  const { card } = parseStCard(v1);
  assert.equal(card.meta.spec, 'v1');
  assert.equal(card.meta.creatorNotes, '作者备注');
  const out = serializeStCard(card, { legacyTopLevel: 'preserve' });
  assert.deepStrictEqual(out, v1);
});

test('新建卡片：按【标题】拼装 description，性格不进 description', () => {
  const card = createEmptyCard('新角色');
  setBlockText(card, 'basic', '年龄 20');
  setBlockText(card, 'personality', '开朗');
  setBlockText(card, 'user', '{{user}} 是同事');
  const out = serializeStCard(card);
  assert.equal(out.data.description, '【基本信息】\n年龄 20\n\n【用户相关设定】\n{{user}} 是同事');
  assert.equal(out.data.personality, '开朗');
});

test('世界书条目完整保留（含未知字段）', () => {
  const { card } = parseStCard(original);
  const out = serializeStCard(card, { legacyTopLevel: 'preserve' });
  assert.deepStrictEqual(out.data.character_book, original.data.character_book);
  assert.equal(out.data.character_book.entries[1].keys[0], '银耳钉');
});

test('新增板块插入到正确位置（按 基本→其他→特殊→用户 顺序）', () => {
  const { card } = parseStCard(original);
  setBlockText(card, 'settings', ''); // 清空其他设定
  const out = serializeStCard(card);
  assert.ok(!out.data.description.includes('【其他设定】') || out.data.description.includes('【其他设定】\n\n'));
  // 重新填入内容，应回到 基本信息 与 特殊设定 之间
  setBlockText(card, 'settings', '新的输出格式');
  const rebuilt = serializeStCard(card);
  const indexBasic = rebuilt.data.description.indexOf('【基本信息】');
  const indexSettings = rebuilt.data.description.indexOf('【其他设定】');
  const indexSpecial = rebuilt.data.description.indexOf('【特殊设定】');
  assert.ok(indexBasic < indexSettings && indexSettings < indexSpecial);
});

test('stringify 输出可被再次解析（幂等）', () => {
  const { card } = parseStCard(original);
  const text = stringifyStCard(card, { legacyTopLevel: 'preserve' });
  const again = parseStCard(text);
  const out = serializeStCard(again.card, { legacyTopLevel: 'preserve' });
  assert.deepStrictEqual(out, original);
});
