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

/**
 * 按**方法边界**切出一段源码。
 *
 * ## 为什么不用 `slice(at, at + 3000)`
 *
 * 固定长度有两个坑，v0.1.8 两个都踩了：
 *
 * ```text
 *   ① 太短  → 方法一长就把断言要的后半段切掉
 *   ② 太长  → 跨进下一个方法，断言会命中"别处"的代码
 *              （实例：查 importRepoVersion 不该有 readDefaultFaceBytes，
 *                结果切到了 writeCardToLibrary，那里正好有）
 * ```
 *
 * 按"下一个 `private ` 出现的位置"切，方法增删都不影响。
 */
function methodBody(source, signature) {
  const at = source.indexOf(signature);
  if (at < 0) return '';
  const next = source.indexOf('\n  private ', at + signature.length);
  return source.slice(at, next < 0 ? source.length : next);
}

/**
 * 剥注释时会误伤字符串里的 `/*`。
 *
 * 实例：`this.pickFileBytes('image/` + 星号 + `')` 里的「斜杠+星号」被块注释正则
 * 当成注释开头，一直吞到下一个「星号+斜杠」—— 于是那行代码在"剥过注释"的
 * 源码里**整段消失**，断言自然找不到它。
 *
 * ★ 这段注释本身就差点踩同一个坑：写成字面量的「星号+斜杠」会把这段
 * 注释提前结束，后半句变成代码，直接语法错误。所以这里用文字说，不写字面量。
 *
 * 所以凡是断言**这行代码本身存在**（而不是断言某段里没有某句话），
 * 一律用原文（`shellRaw`），不要剥。
 */

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
  const body = methodBody(shellSrc, 'private renderCardsTab');
  assert.ok(body !== '', '找不到 private renderCardsTab');

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
  const body = methodBody(shellSrc, 'private renderImportAction');
  assert.ok(body !== '', '找不到 private renderImportAction');

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
    const body = methodBody(shellSrc, fnName);
    assert.ok(body !== '', `找不到 ${fnName}`);
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
  const body = methodBody(shellSrc, 'private async writeCardToLibrary');
  assert.ok(body !== '', '找不到 private async writeCardToLibrary');

  assert.match(
    body,
    /writeCharacterPng\(\s*plan\.avatar,\s*charactersDir,\s*png,\s*!plan\.overwrite\s*\)/,
    '第 4 参必须是 !plan.overwrite',
  );
});

test('★★ 世界书先落地、卡后写（顺序反了会留下指向空书的卡）', () => {
  const body = methodBody(shellSrc, 'private async writeCardToLibrary');
  assert.ok(body !== '', '找不到 private async writeCardToLibrary');

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
  const body = methodBody(shellSrc, 'private async resolveCardPlacement');
  assert.ok(body !== '', '找不到 private async resolveCardPlacement');

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
  const body = methodBody(shellSrc, 'private async confirmOverwriteCard');
  assert.ok(body !== '', '找不到 private async confirmOverwriteCard');

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
  /*
   * v0.1.8 加"换封面"时，选文件那段抽成了 `pickFileBytes(accept)` ——
   * 导入卡与选封面只差一个 accept 字符串，其余（隐藏 input、change/cancel
   * 双保险、60 秒超时、finally remove）完全一样。写两遍必然漏一处。
   */
  const body = methodBody(shellSrc, 'private async pickFileBytes');
  assert.ok(body !== '', '找不到 private async pickFileBytes');

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
  const body = methodBody(shellSrc, 'private async importLocalCard');
  assert.ok(body !== '', '找不到 private async importLocalCard');

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

/* ═══════════════════════════════════════════════════════════
   七、卡面：JSON 卡的封面从哪来
   ═══════════════════════════════════════════════════════════ */

test('★★★★ JSON 卡导入时问封面，PNG 卡不问', () => {
  const body = methodBody(shellSrc, 'private async importLocalCard');
  assert.ok(body !== '', '找不到 private async importLocalCard');

  /*
   * `parsed.base === null` 就是"这个文件里没有图"。
   * 只在那一刻问 —— PNG 卡自带图，问了是骚扰。
   */
  assert.match(body, /if \(base === null\)/, '只在没有图时问');
  assert.match(body, /askCardFace\(\)/, '要问一句');
  /* 三个出口都要能走，不能悄悄替用户决定 */
  assert.match(body, /choice === 'cancel'/, '要能取消导入');
  assert.match(body, /choice === 'pick'/, '要能选图');
  assert.match(body, /pickFaceImage\(\)/, '选图要真的走选图');
});

test('★★★★ 没有封面时按卡名生成，而不是塞统一的默认图', () => {
  /*
   * 用户口径（2026-11-09）：「按卡名生成首字图」。
   *
   * 为什么这条重要：选角色列表**显示头像**。所有没有封面的卡长得一模一样
   * 的话，用户只能靠名字分辨 —— 等于把"有没有封面"变成了"能不能认出自己的卡"。
   */
  const body = methodBody(shellSrc, 'private async writeCardToLibrary');
  assert.ok(body !== '', '找不到 private async writeCardToLibrary');

  assert.match(body, /base: Uint8Array \| null/, 'base 要允许 null（用 null 表示没图）');
  assert.match(body, /faceFromName\(/, '没图时按卡名生成');
  /*
   * 顺序：先生成首字图，失败才退回内置卡面。
   * 反过来的话首字图永远用不上。
   */
  const genAt = body.indexOf('faceFromName(');
  const fallbackAt = body.indexOf('readDefaultFaceBytes(');
  assert.ok(genAt > 0, '要调 faceFromName');
  assert.ok(fallbackAt > genAt, '内置卡面只做兜底，排在生成之后');
});

test('★★★ 仓库下载也走同一条封面逻辑（它也曾经全是同一张图）', () => {
  const body = methodBody(shellSrc, 'private async importRepoVersion');
  assert.ok(body !== '', '找不到 private async importRepoVersion');

  /*
   * 传 `base: null` ⇒ 让 writeCardToLibrary 按卡名生成。
   * 如果这里还自己调 readDefaultFaceBytes，仓库下载的卡就仍是统一默认图，
   * 与本地导入的卡长得不一样 —— 同一件事两套行为。
   */
  assert.match(body, /base: null/, '仓库下载也要走按卡名生成');
  assert.doesNotMatch(
    body,
    /readDefaultFaceBytes\(\)/,
    '仓库下载不该再自己取内置卡面（会与本地导入分叉）',
  );
});

test('★★★ 首字图：同名同色、异名不同色、跳过装饰标点', async () => {
  const { initialOf, hueOf, CARD_FACE_EDGE } = await import('../client/src/chat/card-face.ts');

  assert.equal(CARD_FACE_EDGE, 512, '规格要与桌面端 ST 头像一致');

  /* 取字：中文首字 / 英文首字母 / 跳过【】这类装饰 */
  assert.equal(initialOf('林晚照'), '林');
  assert.equal(initialOf('Alice'), 'A');
  assert.equal(initialOf('【测试】小明'), '测');
  assert.equal(initialOf('  spaced  '), 's');
  assert.equal(initialOf(''), '?', '空名字要有兜底，不能画一张空白图');

  /*
   * 颜色必须**稳定**：同一个名字两次算出同一个色相。
   * 不稳定的后果是用户重导同一张卡时封面突然换色，以为导错了。
   */
  assert.equal(hueOf('林晚照'), hueOf('林晚照'));
  assert.ok(hueOf('林晚照') >= 0 && hueOf('林晚照') < 360);

  /* 不同名字要能落在不同色相上（不要求全不同，但常见的几个得岔开） */
  const hues = new Set(['林晚照', '小明', 'Alice', '夜航小助手', '西奥'].map(hueOf));
  assert.ok(hues.size >= 4, '颜色区分度不够：' + hues.size + '/5');
});

test('★★★ 换封面用 canvas 缩成方形，且不依赖 CompressionStream', async () => {
  /* 剥注释：文件头注释里解释了「为什么不用 CompressionStream」，字面量在那儿 */
  const faceSrc = stripComments(read('client/src/chat/card-face.ts'));

  /* 居中裁方形：竖图不裁的话在圆形头像里会被拉成椭圆（本项目踩过） */
  assert.match(faceSrc, /Math\.min\(bitmap\.width, bitmap\.height\)/, '要居中裁方形');
  assert.match(faceSrc, /drawImage\(/, '要真的重绘');
  /* ImageBitmap 占原生内存，不关会在连续导入时堆起来 */
  assert.match(faceSrc, /bitmap\.close\(\)/, '要释放 ImageBitmap');

  /*
   * 不用 CompressionStream：那是桌面端"压到 250KB"的量化管线要的，
   * 卡面不需要那个限制。硬用会让缺少该 API 的老 WebView 整条走不通。
   */
  assert.doesNotMatch(faceSrc, /CompressionStream/, '卡面不该依赖 CompressionStream');

  /* HEIC 读不出来时要说"换一张"，不能只说"失败" */
  assert.match(faceSrc, /HEIC|PNG 或 JPG/, '要提示换个格式');
});

test('★★ 封面提问框挂在 root（换页不会让 Promise 悬空）', () => {
  const body = methodBody(shellSrc, 'private async askCardFace');
  assert.ok(body !== '', '找不到 private async askCardFace');

  assert.match(body, /const host = this\.root/, '要挂在稳定的外壳上');
  assert.match(body, /data-role', 'card-face-ask'/, '弹层要有 data-role');
  assert.match(body, /data-role', 'card-face-pick'/, '选图按钮');
  assert.match(body, /data-role', 'card-face-default'/, '用默认按钮');
  /* 「不导了」必须有独立按钮：只靠点遮罩的话，用户会以为导入已经开始 */
  assert.match(body, /data-role', 'card-face-cancel'/, '取消按钮');
  assert.match(body, /'不导了'/, '取消文案要说人话');
});

/* ═══════════════════════════════════════════════════════════
   八、选文件只写一份
   ═══════════════════════════════════════════════════════════ */

test('★★ 导入卡与选封面共用同一个选文件实现', () => {
  /*
   * 两处只差 accept 字符串。复制一份的话，将来修超时或修 remove 会漏一处
   * —— 本项目对"写两遍"的后果有过明确结论（见 busy-button 与 runBusy）。
   */
  const importBody = methodBody(shellSrc, 'private async importLocalCard');
  assert.ok(importBody !== '', '找不到 private async importLocalCard');
  assert.match(importBody, /pickFileBytes\('image\/png,application\/json/, '导入卡要传卡片的 accept');

  /*
   * ★ 这一条必须用**原文**（`shellRaw`），不能用剥过注释的 `shellSrc`。
   *
   * 因为 accept 的字面量是 `'image/*'`，其中「斜杠+星号」会被块注释正则
   * 当成注释开头，一直吞到下一个「星号+斜杠」—— 这行代码在剥过注释的
   * 源码里整段消失，断言永远找不到它（而实际上代码是对的）。
   */
  const faceBodyRaw = methodBody(shellRaw, 'private async pickFaceImage');
  assert.ok(faceBodyRaw !== '', '找不到 private async pickFaceImage');
  assert.match(faceBodyRaw, /pickFileBytes\('image\/\*'\)/, '选封面要传图片的 accept');

  /*
   * 精确断言：`pickFileBytes` 只定义一处、被调两处。
   *
   * 不用"数 `type','file'` 出现几次"这种写法 —— 世界书导入里还有一份
   * **老实现**（`onPickFile`，读的是文本不是字节，接口不同），
   * 数下去会把它算进来，然后这条判据就会因为一件与本次无关的事变红。
   *
   * ★ 那份老实现确实也是重复（同一个隐藏 input + change/cancel + 超时），
   *   但改它要动世界书导入，不在本次范围。已记进 PLAN 的待办。
   */
  const defs = (shellSrc.match(/private async pickFileBytes\(/g) ?? []).length;
  assert.equal(defs, 1, 'pickFileBytes 应只定义一次，实际 ' + defs + ' 次');

  const calls = (shellSrc.match(/await this\.pickFileBytes\(/g) ?? []).length;
  assert.equal(calls, 2, '导入卡与选封面各调一次，实际 ' + calls + ' 次');

  /*
   * 允许存在的另一份：世界书导入的老实现。
   * 超过 2 处说明又有人写了一份，该合并了。
   */
  const fileInputs = (shellSrc.match(/setAttribute\('type', 'file'\)/g) ?? []).length;
  assert.ok(
    fileInputs <= 2,
    '选文件实现有 ' + fileInputs + ' 份（pickFileBytes + 世界书老实现 = 2 是上限）',
  );
});
