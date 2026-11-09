/**
 * 安卓端本地卡导入的判据（v0.1.8）。
 *
 * ## 用户要求
 *
 * > v0.1.8 待办增加本地卡导入功能
 *
 * 口径（用户 2026-11-09 拍板）：
 *
 * ```text
 *   只做 PNG 与 JSON，TXT 明确不做
 *   导入后不自动上传仓库
 *   同名覆盖前必须弹确认
 * ```
 *
 * ## 这组判据守什么
 *
 * 六类错误都不会报错，只会"结果不对"或"用户被误导"：
 *
 * ```text
 *   ① 把裸 PNG（没有卡数据）当成卡导进去  → 引擎里多一张空卡
 *   ② 用 readAsText 读 PNG                → 写进去的是坏文件，但看起来"导入成功"
 *   ③ 自己另写一套落盘                    → 与仓库下载分叉，两处迟早不一致
 *   ④ allowCreate 与 overwrite 传反       → 该新建却覆盖别人的卡
 *   ⑤ 静默覆盖同名卡                      → 不可逆，且没有服务端兜底
 *   ⑥ 空角色库还说"会自动补进来"          → 用户等一个永远不来的角色
 * ```
 *
 * 前五条读代码与纯函数钉，第六条钉文案。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  localCardId,
  readLocalCardFile,
} from '../client/src/chat/card-import-local.ts';

const ROOT = join(import.meta.dirname, '..');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** 去掉注释再断言 —— 注释里刻意写着错误写法来解释历史，不剥就会"注释骗判据" */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

const FIXTURES = join(ROOT, 'test', 'fixtures', 'png');
function fixture(name) {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

const shellSrc = stripComments(read('client/src/chat/shell.ts'));
const shellRaw = read('client/src/chat/shell.ts');

/* ═══════════════════════════════════════════════════════════
   一、文件解析：PNG 卡 / 裸 PNG / JSON / 垃圾
   ═══════════════════════════════════════════════════════════ */

test('★★★ 真 PNG 卡解析出 jsonText，且用原图当底图（封面不丢）', () => {
  const bytes = fixture('fixture-v3.png');
  const parsed = readLocalCardFile('示例角色.png', bytes);

  assert.equal(parsed.kind, 'card');
  assert.ok(parsed.jsonText.length > 0, '得拿到卡 JSON 原文');
  /*
   * 底图必须是**用户那张图本身**。
   * 用内置兜底卡面会把用户卡的封面换掉 —— 那不是"导入"，是"改卡"。
   */
  assert.equal(parsed.base, bytes, '底图必须就是用户选的那份字节');
  assert.match(parsed.note, /PNG/);
});

test('★★★ 裸 PNG（没有卡数据）必须拒收，不能说"导入成功"', () => {
  const parsed = readLocalCardFile('截图.png', fixture('fixture-bare.png'));

  assert.equal(parsed.kind, 'reject');
  assert.match(parsed.reason, /没有卡片数据/);
});

test('★★★ PNG 结构损坏时报具体原因，不包成"导入失败"', () => {
  /* 截断：砍掉一半，CRC / IEND 必然对不上 */
  const broken = fixture('fixture-v2.png').slice(0, 400);
  const parsed = readLocalCardFile('坏卡.png', broken);

  assert.equal(parsed.kind, 'reject');
  /*
   * 提示里要有 PNG 层面的具体原因（截断 / CRC / 缺 IEND 之一）。
   * 只说"导入失败"用户不知道该重下一张还是换文件。
   */
  assert.match(parsed.reason, /PNG/);
  assert.doesNotMatch(parsed.reason, /^导入失败$/);
});

test('★★ JSON 卡能导入，但没有图（base 为 null 交给调用方补兜底卡面）', () => {
  const json = JSON.stringify({
    spec: 'chara_card_v2',
    data: { name: '林晚照', description: 'd' },
  });
  const parsed = readLocalCardFile('林晚照.json', new Uint8Array(Buffer.from(json, 'utf8')));

  assert.equal(parsed.kind, 'card');
  /*
   * 用 `null` 而不是空数组：空数组是合法值，混用会让调用方分不清
   * "没图"和"图是空的"（项目踩过 `null` ≠ `[]`）。
   */
  assert.equal(parsed.base, null, 'JSON 卡没有底图，必须是 null');
  assert.match(parsed.note, /JSON/);
});

test('★★ 坏 JSON 拒收；TXT 要说清"去桌面端"', () => {
  const bad = readLocalCardFile('x.json', new Uint8Array(Buffer.from('{不是 json', 'utf8')));
  assert.equal(bad.kind, 'reject');
  assert.match(bad.reason, /JSON/);

  /*
   * TXT 明确不做（用户口径）。但撞上 TXT 时不能只说"不是 JSON"——
   * 得告诉他出路在哪，否则他会以为是自己文件坏了。
   */
  const txt = readLocalCardFile('卡.txt', new Uint8Array(Buffer.from('随便一段文字', 'utf8')));
  assert.equal(txt.kind, 'reject');
  assert.match(txt.reason, /桌面/);
});

test('JSON 顶层不是对象（数组 / 数字）拒收', () => {
  const arr = readLocalCardFile('a.json', new Uint8Array(Buffer.from('[1,2,3]', 'utf8')));
  assert.equal(arr.kind, 'reject');

  const num = readLocalCardFile('a.json', new Uint8Array(Buffer.from('42', 'utf8')));
  assert.equal(num.kind, 'reject');
});

test('空文件拒收（不是"空卡"）', () => {
  const parsed = readLocalCardFile('empty.png', new Uint8Array(0));
  assert.equal(parsed.kind, 'reject');
  assert.match(parsed.reason, /空文件/);
});

test('带 BOM 的 JSON 能读（Windows 记事本存出来的都带）', () => {
  const json = JSON.stringify({ spec: 'chara_card_v2', data: { name: '小明' } });
  const bytes = new Uint8Array(Buffer.from(`\uFEFF${json}`, 'utf8'));
  const parsed = readLocalCardFile('小明.json', bytes);

  assert.equal(parsed.kind, 'card');
});

/* ═══════════════════════════════════════════════════════════
   二、卡片 ID 兜底
   ═══════════════════════════════════════════════════════════ */

test('★ 优先用卡内自带 cardId，没有再退回文件名', () => {
  const withId = JSON.stringify({
    spec: 'chara_card_v3',
    data: { name: '小明', extensions: { tcs: { cardId: 'Card-abc-001' } } },
  });
  assert.equal(localCardId(withId, '随意的文件名.json'), 'Card-abc-001');

  const noId = JSON.stringify({ spec: 'chara_card_v2', data: { name: '小明' } });
  assert.equal(localCardId(noId, '小明.png'), '小明');
});

/* ═══════════════════════════════════════════════════════════
   三、入口与页面接线：摆了入口必须真的能点
   ═══════════════════════════════════════════════════════════ */

test('★★★ 卡片 Tab 有导入入口，且它是动作不是 accordion', () => {
  const at = shellSrc.indexOf('private renderCardsTab');
  assert.ok(at > 0, '找不到 renderCardsTab');
  const body = shellSrc.slice(at, at + 2400);

  assert.match(body, /this\.renderImportAction\(\)/, '卡片 Tab 要渲染导入入口');
  /*
   * 排在最前：没有卡的时候，下面三条入口都无从下手。
   * 判据用 indexOf 比位置，不靠肉眼。
   */
  const importAt = body.indexOf('renderImportAction()');
  const greetingAt = body.indexOf("entryRole: 'greeting-entry'");
  assert.ok(importAt >= 0 && greetingAt >= 0, '两个入口都要在');
  assert.ok(importAt < greetingAt, '导入入口必须排在「开场与示例」之前');
});

test('★★★ 入口是按钮、有 data-state，且点下去真的调导入', () => {
  const at = shellSrc.indexOf('private renderImportAction');
  assert.ok(at > 0, '找不到 renderImportAction');
  const body = shellSrc.slice(at, at + 1600);

  assert.match(body, /data-role', 'card-import-entry'/, '入口要有稳定的 data-role');
  assert.match(body, /data-state', 'idle'/, '初始状态要标出来（三态判据靠它）');
  assert.match(body, /this\.importLocalCard\(button\)/, '点了必须真的走导入');
  /* accordion 才有 onToggle；动作行不该有 —— 有的话就成了"点开一个空面板" */
  assert.doesNotMatch(body, /onToggle/, '它不是 accordion，不该有 onToggle');
});

/* ═══════════════════════════════════════════════════════════
   四、不许另写一套落盘（与仓库下载同一条管线）
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 本地导入与仓库下载共用同一套落盘，不另写', () => {
  /*
   * 判据形态是"两处都必须调到这三个函数"。
   * 复制一份实现的后果不是多几十行，而是两处迟早分叉
   * —— 这个项目已经栽过好几次"零件都对、装配错了"。
   */
  for (const fnName of [
    'private async importRepoVersion',
    'private async importLocalCard',
  ]) {
    const at = shellSrc.indexOf(fnName);
    assert.ok(at > 0, `找不到 ${fnName}`);
    const body = shellSrc.slice(at, at + 3000);
    assert.match(
      body,
      /resolveCardPlacement\(/,
      `${fnName} 必须调 resolveCardPlacement（落名与确认只有一处实现）`,
    );
    assert.match(
      body,
      /writeCardToLibrary\(/,
      `${fnName} 必须调 writeCardToLibrary（写盘只有一处实现）`,
    );
  }
});

test('★★★★ allowCreate 与 overwrite 必须成对反传', () => {
  /*
   * Rust 侧两个方向都校验：
   *   allowCreate=false + 不存在 → 报错
   *   allowCreate=true  + 存在   → 报错
   * 传反会立刻暴露，但前提是这里真的写成 `!overwrite`。
   * 写成 `overwrite` 就是"该新建时去覆盖上一张同名卡" —— 不可逆。
   */
  const at = shellSrc.indexOf('private async writeCardToLibrary');
  const body = shellSrc.slice(at, at + 3000);

  assert.match(
    body,
    /writeCharacterPng\(\s*plan\.avatar,\s*charactersDir,\s*png,\s*!plan\.overwrite\s*\)/,
    '第 4 参必须是 !plan.overwrite',
  );
});

test('★★ 世界书先落地、卡后写（顺序反了会留下指向空书的卡）', () => {
  const at = shellSrc.indexOf('private async writeCardToLibrary');
  const body = shellSrc.slice(at, at + 3000);

  const worldAt = body.indexOf('persistEmbeddedWorldbook(');
  const buildAt = body.indexOf('buildPngCard(');
  const writeAt = body.indexOf('writeCharacterPng(');

  assert.ok(worldAt >= 0 && buildAt >= 0 && writeAt >= 0, '三步都要在');
  assert.ok(worldAt < buildAt, '世界书要在建 PNG 之前（卡里要写书名）');
  assert.ok(buildAt < writeAt, '先建出 PNG 再落盘');
});

/* ═══════════════════════════════════════════════════════════
   五、覆盖确认：不可逆的动作必须先问
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 本地导入会覆盖时先弹确认，仓库下载不弹', () => {
  const at = shellSrc.indexOf('private async resolveCardPlacement');
  const body = shellSrc.slice(at, at + 2600);

  /* 确认要以 overwrite 为条件，不是每次都弹 */
  assert.match(body, /planned\.plan\.overwrite && input\.confirmOverwrite/, '只有会覆盖且要求确认时才弹');
  assert.match(body, /confirmOverwriteCard\(/, '要调确认框');
  assert.match(body, /if \(!go\) return null/, '取消要能中止（返回 null）');

  /* 两个调用点参数相反 */
  const localAt = shellSrc.indexOf('private async importLocalCard');
  const localBody = shellSrc.slice(localAt, localAt + 3000);
  assert.match(localBody, /confirmOverwrite: true/, '本地导入要确认');

  const repoAt = shellSrc.indexOf('private async importRepoVersion');
  const repoBody = shellSrc.slice(repoAt, repoAt + 2000);
  assert.match(repoBody, /confirmOverwrite: false/, '仓库下载是权威版本，不确认');
});

test('★★★ 确认框挂在 root，不挂 pageHost（否则换页时 Promise 永不 resolve）', () => {
  const at = shellSrc.indexOf('private async confirmOverwriteCard');
  const body = shellSrc.slice(at, at + 2400);

  assert.match(body, /const host = this\.root/, '要挂在稳定的外壳上');
  assert.match(body, /data-role', 'card-import-confirm'/, '弹层要有 data-role');
  assert.match(body, /data-role', 'card-import-confirm-ok'/, '覆盖按钮');
  assert.match(body, /data-role', 'card-import-confirm-cancel'/, '取消按钮');
  /*
   * 点遮罩必须等于取消。覆盖是不可逆的，误触不该前进。
   */
  assert.match(body, /resolve\(false\)/, '点遮罩要 resolve(false)');
});

test('★★ 选文件读的是 ArrayBuffer，不是文本', () => {
  const at = shellSrc.indexOf('private async pickLocalCardFile');
  const body = shellSrc.slice(at, at + 2600);

  /*
   * `readAsText` 读 PNG 会把二进制掰成文本，写进角色目录就是一个坏文件，
   * 而且表面上"导入成功" —— 用户要到启动引擎后才发现卡是废的。
   */
  assert.match(body, /readAsArrayBuffer\(/, 'PNG 必须按字节读');
  assert.doesNotMatch(body, /readAsText\(/, '这里不许用 readAsText');
  assert.match(body, /new Uint8Array\(result\)/, '要转成 Uint8Array');
  /* WebView 要求 click 在用户手势里，中间不能有 await */
  assert.match(body, /\)\.click\(\)/, '要真的触发选择器');
});

/* ═══════════════════════════════════════════════════════════
   六、按钮三态 + 空态文案不再开空头支票
   ═══════════════════════════════════════════════════════════ */

test('★★★ 导入按钮有三态与四条文案', () => {
  const at = shellSrc.indexOf('private async importLocalCard');
  const body = shellSrc.slice(at, at + 3600);

  assert.match(body, /runBusy\(/, '复用三态按钮，不另写一份');
  for (const word of ['从手机导入卡片', '导入中…', '已导入 ✓', '重试']) {
    assert.ok(body.includes(word), `缺少文案「${word}」`);
  }
});

test('★★★★ 空角色库文案不许再承诺"自动补进来"', () => {
  /*
   * 内置测试卡在 v0.1.7 的 A1 任务里已经连同播种器一起删了。
   * 原来的「内置的测试角色会在引擎启动后自动补进来 —— 下拉刷新试试」
   * 让用户等一个永远不会来的角色，刷一百次也还是空。
   *
   * ★ 必须剥注释再查：注释里刻意留着原句解释历史。
   */
  const pickerSrc = stripComments(read('client/src/chat/character-picker.ts'));

  assert.doesNotMatch(pickerSrc, /自动补进来/, '不许再承诺自动补卡');
  assert.doesNotMatch(pickerSrc, /内置的测试角色/, '内置测试角色已经不存在了');
  /* 光删不够 —— 得指向那个真的存在的入口，否则用户还是不知道下一步 */
  assert.match(pickerSrc, /导入/, '要告诉用户去导入');
});

test('★★ 开场页的空态也指向具体入口（原来指的是不存在的路）', () => {
  const greetingSrc = stripComments(read('client/src/chat/greeting-page.ts'));

  assert.doesNotMatch(greetingSrc, /还角色库里还没有角色/, '原文开头多一个"还"，是笔误');
  assert.match(greetingSrc, /从手机导入卡片/, '要指到具体入口');
});
