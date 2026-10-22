/**
 * T9.14 端到端：v0.1.1 的多卡链路（浏览器侧）。
 *
 * 覆盖清单里的前六项（第 7–8 项走 verify-sync-live，第 9 项见
 * scripts/verify-beforeunload.mjs，第 10–12 项是打包与真机）：
 *   1. 空白启动
 *   2. F11 新建卡（命名 + ID）
 *   3. F10 就地改名 → 标签 / 导出文件名 / JSON 角色名联动
 *   4. 双卡并行编辑 → 内容隔离
 *   5. 导出 JSON 角色名 = 用户设定值
 *   6. 切换标签后各自的脏标记互不串
 *
 * 分工：本脚本只做交互与断言，浏览器由外部启动（本机 Node 无法 spawn 子进程）。
 *   启动方式见 scripts/run-t914.sh。
 *
 * 判据取向：F10 的核心是「导出的 JSON 角色名要对」，所以不看界面文案好看不好看，
 * 而是把导出回执里的**文件名**与**在 Node 侧用真实导出函数重算出的 name 字段**
 * 一起断言 —— 界面显示对、数据不对，仍然算失败。
 *
 * 用法：node scripts/verify-t914.mjs [CDP 端口] [页面 URL]
 * 退出码：0 全部通过；1 有失败项
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExportAsync } from '../client/src/export/export-card.ts';
import { loadPresets, parseStCard } from '../shared/dist/index.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, '.verify', 't914');
const PORT = process.argv[2] ?? '9333';
const PAGE_URL = process.argv[3] ?? 'http://127.0.0.1:8899/index.html';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => reject(new Error('CDP 连接失败：' + String(e.message ?? e))));
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id !== undefined) {
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.method + ' 失败：' + JSON.stringify(msg.error)));
          else entry.resolve(msg.result);
          return;
        }
        const list = this.handlers.get(msg.method);
        if (list) for (const fn of list) fn(msg.params);
      });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(method + ' 超时'));
        }
      }, 20000);
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  close() {
    this.ws?.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('8899'));
  if (!page) throw new Error('没找到目标页面：' + JSON.stringify(targets.map((t) => t.url)));
  return page.webSocketDebuggerUrl;
}

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const cdp = new Cdp(await findPageTarget());
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // 原生对话框的处理策略：
  //   · 导出闸门的二次确认（文案含「仍要导出」）→ 接受，否则测不到导出主路径；
  //   · 其余（beforeunload 之类）→ 一律「留下」，避免页面被卡住。
  cdp.on('Page.javascriptDialogOpening', (p) => {
    const accept = typeof p.message === 'string' && p.message.includes('仍要导出');
    cdp.send('Page.handleJavaScriptDialog', { accept }).catch(() => {});
  });

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面脚本报错：' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    }
    return r.result.value;
  };

  const waitFor = async (expression, label, tries = 60) => {
    for (let i = 0; i < tries; i += 1) {
      if (await evaluate(expression)) return true;
      await sleep(150);
    }
    throw new Error('等待超时：' + label);
  };

  // 清场 + 强制重载。
  //
  // 两件事都要做，而且顺序不能反：
  //   1. 先把所有会话标记为已保存 —— 否则上一轮留下的脏会话会让新加的
  //      beforeunload 拦截器把这次 reload 拦下来，页面根本不重载，
  //      于是「上一轮残留的两张卡」被当成本轮的新建结果（第一次跑就撞上了：
  //      期望 2 个标签、实际 4 个）。这不是伪造被测状态，只是清夹具：
  //      清完仍然 reload，一切会话都重新开始。
  //   2. 再 reload，确保跑的是最新 client/dist，不是上一轮构建的 bundle
  //      （与决策 #22 的教训同源：产物是否最新只能靠时间戳/强制重载确认）。
  await evaluate(`(() => {
    const app = window.__tcs?.app;
    if (!app || !Array.isArray(app.sessions)) return 0;
    for (const session of app.sessions) session.markSaved(null);
    return app.sessions.length;
  })()`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1200);
  await waitFor(`(() => { const s = document.querySelector('#status'); return !!s && !s.textContent.includes('初始化'); })()`, 'app 初始化');

  // ── 1. 空白启动 ────────────────────────────────────────
  const boot = await evaluate(`(() => ({
    tabs: document.querySelectorAll('.tab').length,
    status: document.querySelector('#status').textContent,
    blocks: document.querySelectorAll('section.block').length,
    name: document.querySelector('#card-name').textContent,
  }))()`);
  check('空白启动：零标签', boot.tabs === 0, `${String(boot.tabs)} 个标签`);
  check('空白启动：状态栏提示空白工作台', /空白工作台/.test(boot.status), JSON.stringify(boot.status));
  check('空白启动：不挂载任何板块（不自动载入卡片）', boot.blocks === 0, `${String(boot.blocks)} 个板块`);

  // ── 2. F11 新建卡 A ────────────────────────────────────
  const newCard = async (name, cardId) => {
    await evaluate(`document.querySelector('#btn-new').click()`);
    await waitFor(
      `(() => [...document.querySelectorAll('.modal-overlay')].some((o) => !o.hasAttribute('hidden') && o.textContent.includes('新建角色卡')))()`,
      '新建对话框',
    );
    const id = await evaluate(`(() => {
      const overlay = [...document.querySelectorAll('.modal-overlay')].find(
        (o) => !o.hasAttribute('hidden') && o.textContent.includes('新建角色卡'));
      const inputs = overlay.querySelectorAll('.input');
      inputs[0].value = ${JSON.stringify(name)};
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[1].value = ${JSON.stringify(cardId)};
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      const autoId = inputs[1].value;
      [...overlay.querySelectorAll('.btn.primary')].pop().click();
      return autoId;
    })()`);
    await sleep(400);
    return id;
  };

  const idA = await newCard('甲卡', 'e2e-alpha-001');
  check('F11 新建卡 A：用户填写的 ID 被采用', idA === 'e2e-alpha-001', `input 回读 ${String(idA)}`);

  const afterA = await evaluate(`(() => {
    const tab = document.querySelector('.tab.is-active');
    const app = window.__tcs?.app;
    const session = app ? app.sessions[0] : null;
    return {
      tabs: document.querySelectorAll('.tab').length,
      tabText: tab ? tab.textContent : '',
      name: document.querySelector('#card-name').textContent.trim(),
      cardId: session ? session.cardId : null,
      dirty: session ? session.dirty : null,
      persisted: session ? session.persisted : null,
    };
  })()`);
  check('新建后挂上一个标签', afterA.tabs === 1, `${String(afterA.tabs)} 个`);
  check('顶栏显示角色名「甲卡」', afterA.name === '甲卡', JSON.stringify(afterA.name));
  check('会话记录的 cardId 与输入一致', afterA.cardId === 'e2e-alpha-001', String(afterA.cardId));
  check('新卡未落盘但尚未变脏（与关闭标签判据一致）', afterA.persisted === false && afterA.dirty === false,
    `persisted=${String(afterA.persisted)} dirty=${String(afterA.dirty)}`);

  // ── 3. F10 就地改名 → 标签联动 ─────────────────────────
  await evaluate(`document.querySelector('#card-name').click()`);
  await waitFor(`(() => { const i = document.querySelector('#card-name-input'); return !!i && !i.hasAttribute('hidden'); })()`, '就地改名输入框');
  const renamed = await evaluate(`(() => {
    const input = document.querySelector('#card-name-input');
    input.focus();
    input.value = '甲卡改名';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // 走 Enter 提交（与用户按回车同一个提交路径）
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(500);

  const afterRename = await evaluate(`(() => {
    const tab = document.querySelector('.tab.is-active');
    const app = window.__tcs?.app;
    const session = app ? app.sessions[0] : null;
    return {
      name: document.querySelector('#card-name').textContent.trim(),
      inputHidden: document.querySelector('#card-name-input').hasAttribute('hidden'),
      tabText: tab ? tab.textContent : '',
      metaName: session ? session.card.meta.name : null,
      dirty: session ? session.dirty : null,
    };
  })()`);
  check('就地改名：顶栏文本更新', afterRename.name === '甲卡改名', JSON.stringify(afterRename.name));
  check('就地改名：输入框收起', afterRename.inputHidden === true);
  check('就地改名：标签文字同步（联动）', afterRename.tabText.includes('甲卡改名'), JSON.stringify(afterRename.tabText));
  check('就地改名：直写 meta.name（唯一数据源）', afterRename.metaName === '甲卡改名', String(afterRename.metaName));
  check('就地改名：会话因此变脏', afterRename.dirty === true, String(afterRename.dirty));

  // ── 4. 双卡并行 + 隔离 ─────────────────────────────────
  const idB = await newCard('乙卡', 'e2e-beta-001');
  check('F11 新建卡 B', idB === 'e2e-beta-001', String(idB));

  // 在 B 的第一块里打字
  const typeInto = async (text) => {
    await evaluate(`(() => {
      const head = document.querySelector('.block .block-head');
      if (head) head.click();
    })()`);
    await waitFor(`!!document.querySelector('.cm-content')`, '编辑器出现');
    await evaluate(`(() => {
      const content = document.querySelector('.cm-content');
      content.focus();
      const range = document.createRange();
      range.selectNodeContents(content);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    })()`);
    await cdp.send('Input.insertText', { text });
    await sleep(500);
  };

  await typeInto('这是乙卡独有的内容 BBBB');
  const bState = await evaluate(`(() => {
    const app = window.__tcs?.app;
    const active = app ? app.sessions.find((s) => s.id === app.activeId) : null;
    return {
      tabs: document.querySelectorAll('.tab').length,
      activeName: document.querySelector('#card-name').textContent.trim(),
      activeText: active ? JSON.stringify(active.card) : '',
    };
  })()`);
  check('两张卡各占一个标签', bState.tabs === 2, `${String(bState.tabs)} 个`);

  // 切回 A（第一个标签），断言 A 的内容里没有 B 的文本
  await evaluate(`(() => { document.querySelectorAll('.tab')[0].click(); return true; })()`);
  await sleep(700);
  const aIsolation = await evaluate(`(() => {
    const app = window.__tcs?.app;
    const session = app ? app.sessions[0] : null;
    const cardJson = session ? JSON.stringify(session.card) : '';
    const lines = [...document.querySelectorAll('.cm-line')].map((n) => n.textContent).join('\\n');
    return {
      name: document.querySelector('#card-name').textContent.trim(),
      cardJson,
      lines,
    };
  })()`);
  check('切回 A：顶栏与内容都是 A 的', aIsolation.name === '甲卡改名', JSON.stringify(aIsolation.name));
  check('隔离：A 的数据里不含 B 的内容', !aIsolation.cardJson.includes('BBBB'));
  check('隔离：A 的编辑器里不含 B 的内容', !aIsolation.lines.includes('BBBB'));

  // 在 A 里打字，再切到 B 验证反向隔离
  await typeInto('这是甲卡独有的内容 AAAA');
  await evaluate(`(() => { document.querySelectorAll('.tab')[1].click(); return true; })()`);
  await sleep(700);
  const bIsolation = await evaluate(`(() => {
    const lines = [...document.querySelectorAll('.cm-line')].map((n) => n.textContent).join('\\n');
    const app = window.__tcs?.app;
    const session = app ? app.sessions[1] : null;
    return { lines, cardJson: session ? JSON.stringify(session.card) : '' };
  })()`);
  check('隔离：B 的数据里不含 A 的内容（反向）',
    !bIsolation.cardJson.includes('AAAA') && !bIsolation.lines.includes('AAAA'));
  check('隔离：B 自己的内容还在', bIsolation.lines.includes('BBBB') || bIsolation.cardJson.includes('BBBB'));

  // ── 5. 导出 JSON：角色名 = 用户设定值 ──────────────────
  await evaluate(`(() => { document.querySelectorAll('.tab')[0].click(); return true; })()`);
  await sleep(600);
  await evaluate(`document.querySelector('#btn-export').click()`);
  await waitFor(
    `(() => [...document.querySelectorAll('.modal-overlay')].some((o) => !o.hasAttribute('hidden') && o.textContent.includes('导出格式')))()`,
    '导出对话框',
  );
  const receipt = await evaluate(`(async () => {
    const overlay = [...document.querySelectorAll('.modal-overlay')].find(
      (o) => !o.hasAttribute('hidden') && o.textContent.includes('导出格式'));
    if (!overlay) return { rows: {}, gateVisible: false, noOverlay: true };

    const confirm = () => [...overlay.querySelectorAll('.btn.primary')].pop();
    overlay.querySelector('.format-option[data-format="json"]').click();
    confirm().click();
    await new Promise((r) => setTimeout(r, 900));

    const gate = overlay.querySelector('.gate-box');
    const gateVisible = !!gate && !gate.hasAttribute('hidden');
    // 闸门的二次确认走 window.confirm（原生对话框），由上面的 dialog 监听器接受，
    // 所以这里只需要点一次「导出…」，然后等回执出现即可。
    const gateText = gateVisible ? gate.textContent.trim().slice(0, 120) : '';
    for (let i = 0; i < 20; i += 1) {
      if (overlay.querySelectorAll('.receipt-row').length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const rows = {};
    for (const row of overlay.querySelectorAll('.receipt-row')) {
      const key = row.querySelector('.receipt-key');
      const value = row.querySelector('.receipt-value');
      if (key && value) rows[key.textContent.trim()] = value.textContent.trim();
    }
    const receiptBox = overlay.querySelector('.receipt-box');
    return {
      rows,
      gateVisible,
      gateText,
      receiptHidden: receiptBox ? receiptBox.hasAttribute('hidden') : null,
      receiptRows: overlay.querySelectorAll('.receipt-row').length,
      confirmLabel: confirm().textContent.trim(),
      tail: overlay.innerText.replace(/\\s+/g, ' ').slice(-160),
    };
  })()`);

  check('导出流程可完成（有 error 时经闸门确认后导出）', Object.keys(receipt.rows).length > 0,
    receipt.noOverlay
      ? '导出对话框未出现'
      : `rows=${String(receipt.receiptRows)} hidden=${String(receipt.receiptHidden)} button=${JSON.stringify(receipt.confirmLabel)} tail=${JSON.stringify(receipt.tail)}`);
  if (receipt.gateVisible) {
    console.log(`   · 审计闸门拦下并说明原因：${receipt.gateText}`);
  }
  const fileName = receipt.rows['文件名'] ?? '';
  check('导出回执：文件名带改名后的角色名', fileName.includes('甲卡改名'), JSON.stringify(fileName));

  // 数据层复核：拿页面里的卡，用真实导出函数重算，断言 JSON 的 name
  const cardJson = await evaluate(`(() => {
    const app = window.__tcs?.app;
    const session = app ? app.sessions[0] : null;
    return session ? JSON.stringify(session.card) : '';
  })()`);
  writeFileSync(join(OUT, 'alpha-card.json'), cardJson + '\n', 'utf8');

  // loadPresets 吃的是「已解析的预设 JSON 数组」，不是目录路径 ——
  // 传路径/不传参数都会在内部 inputs.forEach 上炸掉。
  const presetFile = JSON.parse(readFileSync(join(REPO, 'rules', 'presets', 'default.json'), 'utf8'));
  const { presets } = loadPresets([presetFile]);
  const preset = presets[0];
  if (!preset) throw new Error('预设 default.json 解析失败');
  // 页面里 `session.card` 已经是 UnifiedCard（内部模型），不用再过 parseStCard ——
  // 那是给 ST JSON 用的。喂错会静默得到一份空 meta（角色名变「character.json」），
  // 而不是报错，第一次跑就是这么错的。
  const card = JSON.parse(cardJson);
  const artifact = await buildExportAsync(card, preset, 'json');
  const exported = JSON.parse(artifact.text);
  check('导出 JSON 的 name 字段 = 用户设定的角色名',
    exported.name === '甲卡改名' || exported.data?.name === '甲卡改名',
    JSON.stringify({ top: exported.name ?? null, data: exported.data?.name ?? null }));
  check(
    '导出 JSON 的 cardId 仍在 extensions.tcs.cardId（未被导出流程丢掉）',
    exported.data?.extensions?.tcs?.cardId === 'e2e-alpha-001',
    JSON.stringify(exported.data?.extensions?.tcs?.cardId ?? null),
  );
  check('导出产物 sha256 与回执一致（同一份字节）', artifact.sha256 === receipt.rows['sha256'],
    `${String(artifact.sha256).slice(0, 12)}… vs ${String(receipt.rows['sha256']).slice(0, 12)}…`);
  check('导出文件名由角色名生成', artifact.fileName.includes('甲卡改名'), artifact.fileName);

  // ── 6. 脏标记互不串 ────────────────────────────────────
  const tabsDirty = await evaluate(`[...document.querySelectorAll('.tab')].map((t) => ({
    text: t.textContent, dirty: t.textContent.includes('●'),
  }))`);
  check('两张卡都带脏标记（各自改过内容）', tabsDirty.every((t) => t.dirty),
    JSON.stringify(tabsDirty.map((t) => t.text)));

  // 关掉导出对话框，避免污染后续
  await evaluate(`(() => {
    const overlay = [...document.querySelectorAll('.modal-overlay')].find((o) => !o.hasAttribute('hidden'));
    if (overlay) { const btn = [...overlay.querySelectorAll('.btn')].find((b) => b.textContent.trim() === '取消'); if (btn) btn.click(); }
    return true;
  })()`);

  writeFileSync(
    join(OUT, 'report.json'),
    `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`,
    'utf8',
  );

  cdp.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${String(results.length)} 项，失败 ${String(failed.length)} 项`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('✘ 验证中断：' + String(err?.message ?? err));
  process.exit(1);
});
