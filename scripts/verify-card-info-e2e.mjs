#!/usr/bin/env node
/**
 * 卡片信息端到端验收（v0.1.6）。
 *
 * 用户报的是「导出后这里明显不对」，所以判据只能是**导出 JSON 里的字段**，
 * 不能是内存对象、也不能是对话框里显示的值。本脚本：
 *
 *   1. 用示例卡打开界面（`?sample=1`）；
 *   2. 通过真实入口 `__tcs.app.openCardInfo()` 打开对话框；
 *   3. 填八个字段里最容易错的几个，点**真实的「保存」按钮**；
 *   4. 走**真实的导出链路**（`buildExportForTest` → `buildExportAsync`）取 JSON；
 *   5. 断言"改之前是示例卡的值、改之后是用户的值"。
 *
 * 任何一步绕开真实入口，验的就是脚本本身 —— 那种脚本永远绿。
 *
 * 前提：本地静态服务指向 client/dist（默认 8892），Chrome 可用。
 * 用法：node scripts/verify-card-info-e2e.mjs [--port 8892]
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// 端到端：打开示例卡 → 走真实入口改卡片信息 → 读导出 JSON
// 判据必须是导出结果，因为用户看到的唯一东西就是那个 JSON。
const argPort = (() => {
  const index = process.argv.indexOf('--port');
  return index === -1 ? null : Number(process.argv[index + 1]);
})();
const PAGE_PORT = argPort ?? 8892;
const PORT = 9475 + Math.floor(Math.random() * 15);
const profile = `${process.env.TEMP}\\cdp-e2e-${String(Date.now())}`;
const chrome = spawn(
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
   '--window-size=1280,800', `--remote-debugging-port=${String(PORT)}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
);
let page = null;
for (let i = 0; i < 60; i += 1) {
  await delay(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)).json();
    page = list.find((t) => t.type === 'page') ?? null;
    if (page) break;
  } catch { /* wait */ }
}
if (!page) { process.stdout.write('no cdp\n'); chrome.kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (m, p = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method: m, params: p })); });
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? msg.error); pending.delete(msg.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PAGE_PORT}/index.html?sample=1` });
await delay(5000);

const script = `(async () => {
  const results = {};
  const app = window.__tcs && window.__tcs.app;
  if (!app) return { error: '__tcs.app 不存在' };
  /*
   * 取导出结果走**真实的导出链路**（buildExportAsync），不自己拼 JSON ——
   * 用户看到的就是这条链路产出的东西，绕开它就等于没验。
   * 结果写到剪贴板是副作用，所以这里直接读它的返回值。
   */
  const exportJson = async () => {
    const artifact = await app.buildExportForTest('json');
    return JSON.parse(typeof artifact === 'string' ? artifact : artifact.text);
  };

  // 改之前：导出一次，确认字段确实是示例卡的值
  const before = await exportJson();
  results.before = {
    creator: before.data.creator,
    character_version: before.data.character_version,
    creator_notes: before.data.creator_notes,
    bookName: before.data.character_book && before.data.character_book.name,
    tags: before.data.tags,
  };

  // 走真实入口改
  app.openCardInfo();
  await new Promise((r) => setTimeout(r, 400));
  const dialog = document.querySelector('[data-role="card-info-dialog"]');
  if (!dialog || dialog.hidden) return { error: '对话框没打开' };
  const set = (key, value) => {
    const node = dialog.querySelector('#card-info-' + key);
    if (!node) throw new Error('找不到输入框 ' + key);
    node.value = value;
  };
  set('creator', '我的笔名');
  set('characterVersion', '3.1');
  set('creatorNotes', '这是我自己写的创作说明。');
  set('tags', '赛博朋克、悬疑');
  set('worldbookName', '临海城');
  set('worldbookDescription', '我自己的世界书说明');
  // 点「保存」——走真实按钮，不是直接调 applyCardInfo
  const saveBtn = [...dialog.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '保存');
  if (!saveBtn) return { error: '找不到保存按钮' };
  saveBtn.click();
  await new Promise((r) => setTimeout(r, 500));
  results.dialogClosed = document.querySelector('[data-role="card-info-dialog"]').hidden;

  // 改之后：再导出一次
  const after = await exportJson();
  results.after = {
    creator: after.data.creator,
    character_version: after.data.character_version,
    creator_notes: after.data.creator_notes,
    bookName: after.data.character_book && after.data.character_book.name,
    bookDescription: after.data.character_book && after.data.character_book.description,
    tags: after.data.tags,
  };
  return results;
})()`;

const res = await send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
const out = res.result?.value ?? res;
ws.close();
chrome.kill();

process.stdout.write(JSON.stringify(out, null, 2) + '\n');

/*
 * 断言。判据是**导出 JSON 的值**，不是"界面上看起来改了"。
 * 每一条都写成"示例卡的值 → 用户的值"，两个方向都要成立：
 * 只验后半句的话，一个"永远返回空串"的实现也能通过。
 */
const fail = (message) => {
  process.stdout.write(`✘ ${message}\n`);
  process.exit(1);
};

if (out === null || typeof out !== 'object') fail('脚本没拿到结果');
if (out.error !== undefined) fail(`页面侧失败：${out.error}`);

// 键名与页面侧返回的形状一致（before 用 JSON 的键名，after 也用 JSON 的键名）
const BEFORE = {
  creator: 'Tavern Card Studio',
  character_version: '1.0',
  creator_notes: '示例卡片，用于 round-trip 与规则联动测试。',
  bookName: '拾光书店',
  tags: ['日常', '治愈', '书店'],
};
for (const [key, expected] of Object.entries(BEFORE)) {
  const actual = out.before[key];
  const same = Array.isArray(expected) ? JSON.stringify(actual) === JSON.stringify(expected) : actual === expected;
  if (!same) fail(`改之前 ${key} 应当是示例卡的值 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const AFTER = {
  creator: '我的笔名',
  character_version: '3.1',
  creator_notes: '这是我自己写的创作说明。',
  bookName: '临海城',
  bookDescription: '我自己的世界书说明',
  tags: ['赛博朋克', '悬疑'],
};
for (const [key, expected] of Object.entries(AFTER)) {
  const actual = out.after[key];
  const same = Array.isArray(expected) ? JSON.stringify(actual) === JSON.stringify(expected) : actual === expected;
  if (!same) fail(`改之后 ${key} 应当是 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
if (out.dialogClosed !== true) fail('保存后对话框应当关闭');

process.stdout.write('✔ 卡片信息端到端通过：六个字段从示例卡的值变成了用户的值（判据取自导出 JSON）\n');

