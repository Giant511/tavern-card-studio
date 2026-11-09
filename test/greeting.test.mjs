/**
 * 开场白插入 + 「开场与示例」页的判据（2026-11-05）。
 *
 * 对应两个用户决定：
 *
 * > 1、在卡片栏单独加一个 tap 卡片放置开场白和对话示例。
 * > 2、做开场白插入。
 * > 5、需要想办法在手机里兼容旧版本的导出并且无缝升级到现有导出规则。
 *
 * ## 为什么这两件事放一个文件
 *
 * 它们守的是同一个链条：**编辑（页）→ 存卡（residual）→ 建新聊天时用上**。
 * 分两个文件会出现"页面的判据绿了、但插进聊天的是空数组"这种断裂 ——
 * 而这个项目已经栽过好几次"零件都对、装配错了"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildOpeningMessages } from '@tcs/shared';
import {
  emptyGreetingDraft,
  emptyGreetingPageState,
  greetingFingerprint,
  hasGreetingChanges,
  renderGreetingPage,
} from '../client/src/chat/greeting-page.ts';

/* ── 极简 DOM stub（与 api-page-dom 测试同一套最小能力） ── */

function makeDoc() {
  const createElement = (tag) => {
    const attributes = new Map();
    return {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      innerHTML: '',
      hidden: false,
      value: '',
      disabled: false,
      dataset: {},
      children: [],
      listeners: {},
      append(...nodes) {
        for (const one of nodes) {
          this.children.push(typeof one === 'string' ? { textContent: one, children: [], isText: true } : one);
        }
      },
      replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
      },
      getAttribute(name) {
        return attributes.has(name) ? attributes.get(name) : null;
      },
      removeAttribute(name) {
        attributes.delete(name);
      },
      addEventListener(type, handler) {
        (this.listeners[type] ??= []).push(handler);
      },
      fire(type) {
        for (const handler of this.listeners[type] ?? []) handler({ type, target: this });
      },
    };
  };
  return { createElement };
}

function findAll(root, predicate) {
  const found = [];
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (node.isText !== true && predicate(node)) found.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return found;
}
const byRole = (root, role) => findAll(root, (n) => n.getAttribute('data-role') === role);

/* ═══════════════════════════════════════════════════════════
   ① 开场白 → 新聊天第一条消息（用户决定 2）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 有 first_mes → 建新聊天时它是第一条 assistant 消息', () => {
  /*
   * 改之前 `newChat()` 是 `this.messages = []` —— 导入一张卡开始聊天，
   * 界面一片空白，而那张卡的开场白有 367 字。
   */
  const messages = buildOpeningMessages({ name: '西奥', first_mes: '你还没走？' });

  assert.equal(messages.length, 1, '开场白只有一条时就要一条消息');
  assert.equal(messages[0].mes, '你还没走？');
  assert.equal(messages[0].is_user, false, '开场白是角色说的，不能标成用户');
  assert.equal(messages[0].name, '西奥', '名字要带卡里的角色名');
});

test('★★★ 没有 first_mes → 返回空数组（保留空状态，不造假消息）', () => {
  /*
   * 造一条空消息会让界面显示一个空气泡 + 时间戳，用户会以为渲染坏了。
   * 空数组让面板照旧显示「还没有对话」。
   */
  assert.deepEqual(buildOpeningMessages({ name: '西奥', first_mes: '' }), []);
  assert.deepEqual(buildOpeningMessages({ name: '西奥' }), []);
  /* 纯空白也算空 */
  assert.deepEqual(buildOpeningMessages({ first_mes: '   \n\t  ' }), []);
});

test('★★★ 只有一条开场白时**不许**建 swipes（否则界面显示 1 / 1 噪音）', () => {
  const messages = buildOpeningMessages({ name: '西奥', first_mes: '只有一条' });
  assert.equal(messages[0].swipes, undefined, '没有备用开场白时不该出现 swipes 字段');
  assert.equal(messages[0].swipe_id, undefined);
});

test('★★★ 有备用开场白 → 全部进 swipes，当前停在第一条', () => {
  /*
   * 与 ST 一致：开场白是候选的第 0 个，备用的是第 1..N 个，用户左滑换。
   * 这样 `swipeNext` / 候选指示器那一整套现成逻辑直接能用。
   */
  const messages = buildOpeningMessages({
    name: '西奥',
    first_mes: '默认开局',
    alternate_greetings: ['另一个开局', '第三个开局'],
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].swipes, ['默认开局', '另一个开局', '第三个开局']);
  assert.equal(messages[0].swipe_id, 0);
  assert.equal(messages[0].mes, '默认开局', 'mes 必须与 swipes[swipe_id] 一致');
  assert.equal(messages[0].swipe_info?.length, 3, 'swipe_info 要与 swipes 等长（每条候选各有时间）');
});

test('★★ 备用开场白里的空串要丢掉（点「加一条」没写就走会留下空串）', () => {
  const messages = buildOpeningMessages({
    first_mes: '默认',
    alternate_greetings: ['', '   ', '真的备用'],
  });
  assert.deepEqual(messages[0].swipes, ['默认', '真的备用']);
});

test('★★ 不替换 {{char}} / {{user}}（落盘要存原文，ST 按人设替换）', () => {
  /*
   * 替换过的文本存回聊天文件，下次换人设就错了 —— 而 ST 的聊天记录里
   * 存的也是带宏的原文。界面上渲染成名字是渲染层的事（`renderMessageHtml`）。
   */
  const messages = buildOpeningMessages({ first_mes: '{{char}} 看了 {{user}} 一眼' });
  assert.equal(messages[0].mes, '{{char}} 看了 {{user}} 一眼');
});

/* ═══════════════════════════════════════════════════════════
   ② 「开场与示例」页（用户决定 1）
   ═══════════════════════════════════════════════════════════ */

function makePage(stateOverrides = {}, callbacks = {}) {
  const doc = makeDoc();
  const calls = { save: 0, select: [], change: [], addAlt: 0, removeAlt: [], back: 0 };
  const state = { ...emptyGreetingPageState(), ...stateOverrides };
  const page = renderGreetingPage(doc, state, {
    onBack: () => {
      calls.back += 1;
    },
    onSelect: (avatar) => calls.select.push(avatar),
    onChange: (patch) => calls.change.push(patch),
    onAddAlternate: () => {
      calls.addAlt += 1;
    },
    onRemoveAlternate: (index) => calls.removeAlt.push(index),
    onSave: () => {
      calls.save += 1;
    },
    ...callbacks,
  });
  return { page, calls };
}

const CHAR = { avatar: 'xiao.png', name: '西奥' };

test('★★★ 没选角色时先列角色，点了才进编辑', () => {
  const { page, calls } = makePage({ characters: [CHAR] });
  const rows = byRole(page, 'greeting-character');
  assert.equal(rows.length, 1, '应有一条角色行');
  assert.equal(rows[0].getAttribute('data-avatar'), 'xiao.png');

  rows[0].fire('click');
  assert.deepEqual(calls.select, ['xiao.png'], '点角色要回调 onSelect');
});

test('★★★ 四段字段都要在（缺一个用户就改不了那个）', () => {
  const { page } = makePage({ characters: [CHAR], selected: 'xiao.png' });
  for (const role of [
    'greeting-scenario',
    'greeting-first-mes',
    'greeting-mes-example',
    'greeting-save',
  ]) {
    assert.equal(byRole(page, role).length, 1, `缺少 ${role}`);
  }
});

test('★★★ 改字段会回调，且只带改的那一段（不是整份替换）', () => {
  /*
   * `onChange` 每次只带改动的字段。若回调方按"整份替换"处理，
   * 用户打一个字另外三段就全被清空 —— 这是最容易写错的一处。
   */
  const { page, calls } = makePage({ characters: [CHAR], selected: 'xiao.png' });
  const first = byRole(page, 'greeting-first-mes')[0];
  first.value = '新的开场白';
  first.fire('input');

  assert.equal(calls.change.length, 1);
  assert.deepEqual(calls.change[0], { firstMes: '新的开场白' }, '只该带 firstMes 一个键');
});

test('★★★ 没有改动时保存按钮禁用（点了没反应用户以为存失败）', () => {
  const draft = { scenario: 'a', firstMes: 'b', alternateGreetings: [], mesExample: 'c' };
  const { page } = makePage({
    characters: [CHAR],
    selected: 'xiao.png',
    draft,
    baseline: greetingFingerprint(draft),
  });

  const save = byRole(page, 'greeting-save')[0];
  assert.equal(save.getAttribute('data-changed'), 'false');
  assert.notEqual(save.getAttribute('disabled'), null, '没改动时按钮应禁用');
  assert.equal(save.textContent, '没有改动');
});

test('★★★ 有改动时保存可点，且回调 onSave', () => {
  const draft = { scenario: 'a', firstMes: 'b', alternateGreetings: [], mesExample: 'c' };
  const { page, calls } = makePage({
    characters: [CHAR],
    selected: 'xiao.png',
    draft,
    baseline: greetingFingerprint(emptyGreetingDraft()),
  });

  const save = byRole(page, 'greeting-save')[0];
  assert.equal(save.getAttribute('data-changed'), 'true');
  assert.equal(save.getAttribute('disabled'), null, '有改动时不该禁用');
  save.fire('click');
  assert.equal(calls.save, 1);
});

test('★★★ 「打开看一眼就返回」绝不能算改动（兼容旧版导出的前提）', () => {
  /*
   * 用户决定 5 的核心：旧卡能原样打开、不看不动就不变。
   * 判据落在指纹上：载入时拿到的内容算出的指纹 == baseline ⇒ 无改动。
   */
  const draft = {
    scenario: '旧卡里的场景',
    firstMes: '旧卡里的开场白',
    alternateGreetings: ['备用一'],
    mesExample: '旧卡里的示例',
  };
  const state = {
    ...emptyGreetingPageState(),
    characters: [CHAR],
    selected: 'xiao.png',
    draft,
    baseline: greetingFingerprint(draft),
  };
  assert.equal(hasGreetingChanges(state), false, '刚载入时必须判定为"没有改动"');
});

test('★★★ 指纹要把四段全算进去（漏一段就会"改了说没改"）', () => {
  const base = { scenario: 's', firstMes: 'f', alternateGreetings: ['a'], mesExample: 'm' };
  const variants = [
    { ...base, scenario: 's2' },
    { ...base, firstMes: 'f2' },
    { ...base, alternateGreetings: ['a', 'b'] },
    { ...base, mesExample: 'm2' },
  ];
  for (const one of variants) {
    assert.notEqual(
      greetingFingerprint(one),
      greetingFingerprint(base),
      `改了字段却没影响指纹：${JSON.stringify(one)}`,
    );
  }
});

test('★★ 指纹分隔符不能用普通字符（用户正文里有竖线/逗号）', () => {
  /*
   * 用 `|` 或 `,` 当分隔符时，("a|b","c") 与 ("a","b|c") 会算出同一个指纹 ——
   * 于是"改了却说没改"，保存按钮一直是灰的。用控制字符避开。
   */
  const a = { scenario: 'a|b', firstMes: 'c', alternateGreetings: [], mesExample: '' };
  const b = { scenario: 'a', firstMes: 'b|c', alternateGreetings: [], mesExample: '' };
  assert.notEqual(greetingFingerprint(a), greetingFingerprint(b));
});

test('★★ 备用开场白逐条可编辑 + 可新增', () => {
  const draft = { scenario: '', firstMes: '', alternateGreetings: ['第一', '第二'], mesExample: '' };
  const { page, calls } = makePage({
    characters: [CHAR],
    selected: 'xiao.png',
    draft,
    baseline: greetingFingerprint(draft),
  });

  assert.equal(byRole(page, 'greeting-alternate-0').length, 1);
  assert.equal(byRole(page, 'greeting-alternate-1').length, 1);

  const second = byRole(page, 'greeting-alternate-1')[0];
  second.value = '改过的第二';
  second.fire('input');
  assert.deepEqual(calls.change[0], { alternateGreetings: ['第一', '改过的第二'] }, '要整组回传');

  byRole(page, 'greeting-add-alternate')[0].fire('click');
  assert.equal(calls.addAlt, 1);
});

test('★★ 载入中 / 载入失败都要有可见状态（不留空白页）', () => {
  const loading = makePage({ loading: true }).page;
  assert.equal(byRole(loading, 'greeting-loading').length, 1);

  const failed = makePage({ error: '读不到角色列表' }).page;
  assert.equal(byRole(failed, 'greeting-error').length, 1);
});

test('★★ 一个角色都没有时给空状态，不是一片空白', () => {
  const { page } = makePage({ characters: [] });
  assert.equal(byRole(page, 'greeting-empty').length, 1);
});

test('★★★ 页面里要写出「怎么才算合规」的示例（对齐 ST 的落点）', () => {
  /*
   * 用户决定 4「不多开文档」—— 所以这条约定必须**在界面上**说清。
   * 只写"请遵守格式"没用，要给出 `<START>` 与半角冒号的具体样子。
   */
  const { page } = makePage({ characters: [CHAR], selected: 'xiao.png' });
  const text = findAll(page, () => true)
    .map((one) => String(one.textContent ?? ''))
    .join('\n');
  assert.match(text, /<START>/, '要提到 <START>');
  assert.match(text, /半角/, '要说明冒号用半角');
  assert.match(text, /\{\{user\}\}|\{\{char\}\}/, '要给出说话人的写法');
});

/* ═══════════════════════════════════════════════════════════
   ③ 外壳接线（防"写了函数没调用"）
   ═══════════════════════════════════════════════════════════ */

const shellSrc = readFileSync(
  new URL('../client/src/chat/shell.ts', import.meta.url),
  'utf8',
);

test('★★★ 卡片栏要有「开场与示例」入口，且真的渲染那一页', () => {
  assert.match(shellSrc, /entryRole: 'greeting-entry'/, '卡片栏要有入口');
  assert.match(shellSrc, /this\.greetingOpen = true;/, '点入口要打开二级页');
  assert.match(shellSrc, /this\.renderGreeting\(\);/, 'renderPage 里要真的渲染它');
});

test('★★★ 交互式重绘必须先清空 pageHost（否则每打一个字叠一页）', () => {
  /*
   * 真机抓到的：改一个字，保存按钮还是「没有改动」。
   *
   * 根因不是状态没更新，而是 `onChange` 调的 `renderGreeting()` 只 append
   * 不清空 —— `pageHost.replaceChildren()` 只在 `renderPage()` 里有。
   * 于是 DOM 里叠了两页，`querySelector` 拿到的是第一页那个旧按钮。
   *
   * 这条缺陷单测抓不到（单测直接调渲染函数、没有 pageHost），
   * 所以只能静态钉住"渲染方法自己清"。
   */
  const fn = shellSrc.slice(
    shellSrc.indexOf('private renderGreeting(): void {'),
    shellSrc.indexOf('private greetingChangeFlag'),
  );
  assert.ok(fn.includes('pageHost.replaceChildren()'), 'renderGreeting 里要先清空 pageHost');
});

test('★★★ 保存必须走 stringifyStCard（这一步才是"无缝升级到现有导出规则"）', () => {
  /*
   * 用户决定 5 的落点：用户点一次保存，卡就带上当前这份代码的序列化规则
   * （世界书标题落 comment、顶层 V1 副本同步…），不需要单独的迁移工具。
   *
   * 而"没点保存的卡一个字节都不变"—— 升级是用户主动触发的。
   */
  assert.match(shellSrc, /stringifyStCard\(next,/, '保存要重新序列化');
  assert.match(shellSrc, /entryTitleToComment: true/, '要打开写 comment 那个选项（否则导进 ST 标题空白）');
});

test('★★★ 写回要用**原 PNG** 当容器（卡面不能被换掉）', () => {
  assert.match(shellSrc, /buildPngCard\(this\.greetingPng,/, '要用原 PNG 字节当容器');
});

test('★★★ 选角色后要真的把卡读进 loadedCard（否则开场白读不到）', () => {
  /*
   * 移动端入口一直传 `card: {}`，于是 `ctx.card` 里没有 `first_mes` ——
   * `buildOpeningMessages` 永远返回空数组，开场白插了个寂寞。
   */
  assert.match(shellSrc, /private async loadCharacterCard\(/, '要有读卡的方法');
  assert.match(
    shellSrc,
    /await this\.loadCharacterCard\(character\.avatar\)/,
    '选角色时要调用它',
  );
  assert.match(
    shellSrc,
    /card: Object\.keys\(this\.loadedCard\)\.length > 0 \? this\.loadedCard : this\.options\.card/,
    '面板的 ctx.card 要用读到的卡',
  );
});
