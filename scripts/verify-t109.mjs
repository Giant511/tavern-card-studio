/**
 * T10.9 端到端：TXT 角色卡导入 / 世界书双向导入导出 / 三路综合审计分组。
 *
 * 为什么必须进浏览器：这一轮的四条要求里有三条是**界面行为**——
 *   · 严格模式失败后能就地切到宽松（不是报错结束）；
 *   · 世界书导入前要显示"将替换"和条目数；
 *   · 审计面板要出现「世界书」这个新类别并可按它筛选。
 * 纯函数单测只能证明"决定"对，证明不了"界面照做"。
 *
 * 用法：node scripts/verify-t109.mjs
 * 前置：npm run build:ui
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, '.verify', 't109');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9333;
const WEB_PORT = 8899;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
}

function assertFreshBuild() {
  const assets = join(REPO, 'client', 'dist', 'assets');
  const latestDist = Math.max(
    ...readdirSync(assets)
      .filter((name) => name.startsWith('main-') && name.endsWith('.js'))
      .map((name) => statSync(join(assets, name)).mtimeMs),
  );
  const newestSource = Math.max(
    ...['client/src/editor/import-dialog.ts', 'client/src/editor/import-flow.ts', 'client/src/editor/app.ts'].map(
      (rel) => statSync(join(REPO, rel)).mtimeMs,
    ),
  );
  check('client/dist 比源码新（测的是本次构建）', latestDist >= newestSource,
    `dist=${new Date(latestDist).toISOString()}`);
  if (latestDist < newestSource) throw new Error('请先 npm run build:ui');
}

// ── 测试素材 ──────────────────────────────────────────────
// 严格模式缺板块的 TXT（只有基本信息一段）
const PARTIAL_TXT = '【基本信息】\n她叫林晚照，开了家咖啡馆。\n';

// 完整 TXT：标题必须用默认预设的别名（settings = 「其他设定」）
const FULL_TXT = `【基本信息】
她叫林晚照，开了家咖啡馆。

【性格】
安静，话少。

【其他设定】
对话以第三人称叙述。

【特殊设定】
无。

【用户设定】
{{user}} 是常客。

【世界书】
@@ENTRY 0
name: 咖啡馆
keys: 咖啡馆
@@CONTENT
二楼是仓库。
@@END 0`;

// 世界书 JSON：故意用非规范缩进，用于验"逐字节写回"
const WORLDBOOK_JSON = '{"entries":[{"keys":["银座"],"content":"一楼是店面","id":0},{"keys":["耳钉"],"content":"母亲的遗物","id":1}],"name":"测试书","scan_depth":3}';

// 坏 JSON：尾随逗号，用于验错误定位
const BROKEN_JSON = `{
  "entries": [
    { "id": 0, "keys": [], "content": "x" },
  ]
}`;

const work = mkdtempSync(join(tmpdir(), 'tcs-t109-'));
const children = [];

async function waitHttp(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return true;
    } catch {
      /* 还没起 */
    }
    await delay(200);
  }
  return false;
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }
  connect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => res());
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id !== undefined) {
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
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
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`${method} 超时`));
        }
      }, 25000);
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  assertFreshBuild();

  const staticServer = spawn('python', ['-m', 'http.server', String(WEB_PORT), '--bind', '127.0.0.1', '--directory', 'client/dist'], {
    cwd: REPO,
    stdio: 'ignore',
  });
  children.push(staticServer);
  check('静态站点就绪', await waitHttp(`http://127.0.0.1:${String(WEB_PORT)}/index.html`), `:${String(WEB_PORT)}`);

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--remote-debugging-port=${String(CDP_PORT)}`,
      `--user-data-dir=${join(work, 'chrome')}`,
      '--window-size=1440,1000',
      // 刻意不加 ?sample=1：从一个**空白工作台**开始，先新建一张卡再导入，
      // 否则"导入替换了当前卡"这件事验不到位
      `http://127.0.0.1:${String(WEB_PORT)}/index.html`,
    ],
    { stdio: 'ignore' },
  );
  children.push(chrome);
  check('Chrome 调试端口就绪', await waitHttp(`http://127.0.0.1:${String(CDP_PORT)}/json/list`), `:${String(CDP_PORT)}`);

  const targets = await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes(String(WEB_PORT)));
  if (!page) throw new Error('没找到页面目标');

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 300));
  });
  cdp.on('Page.javascriptDialogOpening', () => {
    cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面脚本报错：' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    }
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  };
  const waitFor = async (expression, label, timeoutMs = 12000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return true;
      await delay(150);
    }
    throw new Error(`等待超时：${label}`);
  };

  // 等应用就绪（等 DOM 元素不够：wireImport 之前点了没反应）
  await waitFor(
    `(() => { const app = window.__tcs?.app; const s = document.querySelector('#status'); return !!app && !!s && !s.textContent.includes('初始化'); })()`,
    '应用启动完成',
  );
  check('应用启动完成', true, '');


  // ── 先建一张卡（导入要替换它的内容）────────────────────
  await evaluate(`(async () => {
    document.querySelector('#btn-new').click();
    await new Promise((r) => setTimeout(r, 350));
    const overlay = [...document.querySelectorAll('.modal-overlay')].find(
      (o) => !o.hidden && o.textContent.includes('新建角色卡'));
    const inputs = overlay.querySelectorAll('.input');
    inputs[0].value = '导入测试卡';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].value = 't109-card';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    [...overlay.querySelectorAll('.btn.primary')].pop().click();
    await new Promise((r) => setTimeout(r, 600));
    return true;
  })()`);
  check('已新建一张空卡（导入的目标）',
    (await evaluate(`window.__tcs.app.sessions.length === 1`)) === true, '');

  // ── 世界书块内的「导入 / 导出」入口确实渲染出来了 ──────
  //
  // 这三条按钮挂在世界书块的 body 里（`buildWorldbookActions`）。块是**懒渲染**的，
  // 但按钮不是编辑器实例，所以在块折叠时也该在 DOM 里 —— 这条同时守住了
  // 「别把按钮塞进 lazy 分支」这个容易犯的错。
  const wbButtons = await evaluate(`(() => {
    const block = document.querySelector('.block[data-block-id="worldbook"]');
    if (!block) return { found: false, blocks: [...document.querySelectorAll('.block')].map((b) => b.dataset.blockId) };
    const roles = [...block.querySelectorAll('[data-role^="worldbook-"]')].map((n) => n.dataset.role);
    return { found: true, roles };
  })()`);
  check('世界书块内渲染了导入/导出入口（3 个）',
    wbButtons.found === true &&
      ['worldbook-import', 'worldbook-export-json', 'worldbook-export-txt'].every((role) =>
        wbButtons.roles?.includes(role),
      ),
    JSON.stringify(wbButtons.roles ?? wbButtons.blocks));

  // ── ① TXT 严格模式：失败 → 就地切宽松 ──────────────────
  // 界面上的"选文件"走原生对话框，无头环境无法驱动；这里直接把文本交给对话框，
  // 走的是**同一条** openCardText → previewCardText → applyCardText 路径。
  const strict = await evaluate(`(async () => {
    // 走 **App 的真实入口**（不是直接调对话框）：导入的写回发生在
    // importCardTextFile 的 await 之后。只调对话框会得到"界面走完了但卡没变"，
    // 那验的是空壳。
    const pending = window.__tcs.app.importCardTextFile('partial.txt', ${JSON.stringify(PARTIAL_TXT)});
    await new Promise((r) => setTimeout(r, 300));
    // 切到严格模式：应拒绝
    document.querySelector('[data-role="import-mode-strict"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const overlay = document.querySelector('[data-role="import-dialog"]');
    const issues = [...overlay.querySelectorAll('[data-role="import-issues-list"] li')].map((li) => ({
      severity: li.dataset.severity,
      text: li.textContent.trim(),
    }));
    const confirm = document.querySelector('[data-role="import-confirm"]');
    return {
      mode: document.querySelector('[data-role="import-mode-strict"]').checked,
      confirmText: confirm.textContent.trim(),
      confirmDisabled: confirm.disabled,
      errors: issues.filter((i) => i.severity === 'error').length,
      issueCount: issues.length,
      summary: [...overlay.querySelectorAll('.import-summary-line')].map((n) => n.textContent.trim()),
      _pending: true,
    };
  })()`);
  check('① 严格模式：缺板块被判为 error', strict.errors > 0, `${String(strict.errors)} 条 error / 共 ${String(strict.issueCount)} 条`);
  check('① 严格模式：主按钮变成「改用宽松模式重试」而不是死路',
    /宽松/.test(strict.confirmText) && strict.confirmDisabled === false, strict.confirmText);
  await shot('a-strict-rejected');

  // 点它 → 切到宽松 → 可导入
  const lenient = await evaluate(`(async () => {
    document.querySelector('[data-role="import-confirm"][data-intent="retry-lenient"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const overlay = document.querySelector('[data-role="import-dialog"]');
    const issues = [...overlay.querySelectorAll('[data-role="import-issues-list"] li')].map((li) => ({
      severity: li.dataset.severity,
      text: li.textContent.trim(),
    }));
    return {
      lenientChecked: document.querySelector('[data-role="import-mode-lenient"]').checked,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      errors: issues.filter((i) => i.severity === 'error').length,
      summary: [...overlay.querySelectorAll('.import-summary-line')].map((n) => n.textContent.trim()),
      confirmText: document.querySelector('[data-role="import-confirm"]')?.textContent.trim() ?? '',
      confirmDisabled: document.querySelector('[data-role="import-confirm"]')?.disabled ?? true,
    };
  })()`);
  check('① 切到宽松模式后：error 变 warning，可导入',
    lenient.lenientChecked === true && lenient.errors === 0 && lenient.warnings > 0 && lenient.confirmDisabled === false,
    `warn=${String(lenient.warnings)} err=${String(lenient.errors)} btn=${lenient.confirmText}`);
  check('① 宽松模式点名了将被按空处理的板块',
    lenient.summary.some((line) => line.includes('将按空块处理')), JSON.stringify(lenient.summary));
  await shot('b-lenient-ready');

  // 确认导入 → 卡内容变化 + 状态栏提示
  const afterLenient = await evaluate(`(async () => {
    document.querySelector('[data-role="import-confirm"]').click();
    await new Promise((r) => setTimeout(r, 700));
    const app = window.__tcs.app;
    const card = app.sessions[0].card;
    return {
      basic: card.blocks.find((b) => b.id === 'basic').text,
      missingFlags: card.blocks.filter((b) => b.missing === true).map((b) => b.id),
      status: document.querySelector('#status').textContent.trim(),
      dialogHidden: document.querySelector('[data-role="import-dialog"]').hidden,
    };
  })()`);
  check('① 导入后基本信息板块写入内容', afterLenient.basic.includes('林晚照'), afterLenient.basic.slice(0, 40));
  check('① 缺失板块带 missing 标记（与"用户清空"可区分）',
    afterLenient.missingFlags.length >= 4, JSON.stringify(afterLenient.missingFlags));
  check('① 状态栏说明是宽松模式且点名了缺失板块',
    /宽松/.test(afterLenient.status) && /缺失/.test(afterLenient.status), afterLenient.status.slice(0, 80));
  check('① 导入完成后对话框关闭', afterLenient.dialogHidden === true, '');
  await shot('c-after-lenient-import');

  // ── ② TXT 完整导入（含世界书段）───────────────────────
  const full = await evaluate(`(async () => {
    const pending = window.__tcs.app.importCardTextFile('full.txt', ${JSON.stringify(FULL_TXT)});
    await new Promise((r) => setTimeout(r, 400));
    const overlay = document.querySelector('[data-role="import-dialog"]');
    const summary = [...overlay.querySelectorAll('.import-summary-line')].map((n) => n.textContent.trim());
    const confirm = document.querySelector('[data-role="import-confirm"]');
    const canImport = !confirm.disabled;
    confirm.click();
    await new Promise((r) => setTimeout(r, 700));
    const card = window.__tcs.app.sessions[0].card;
    return {
      summary,
      canImport,
      worldbookEntries: card.worldbook.entries.length,
      worldbookText: card.worldbook.text,
      missingFlags: card.blocks.filter((b) => b.missing === true).length,
    };
  })()`);
  check('② 完整 TXT：宽松模式下可直接导入', full.canImport === true, JSON.stringify(full.summary));
  check('② TXT 里的世界书段被解析出来（1 条）', full.worldbookEntries === 1, `entries=${String(full.worldbookEntries)}`);
  check('② 世界书 TXT 已渲染进编辑器（能看到 @@ENTRY）',
    /@@ENTRY 0/.test(full.worldbookText), full.worldbookText.slice(0, 40));
  check('② 完整导入后没有缺失板块', full.missingFlags === 0, `missing=${String(full.missingFlags)}`);

  // ── ③ 世界书 JSON 导入：显示"将替换" + 条目数 ──────────
  const wbImport = await evaluate(`(async () => {
    const pending = window.__tcs.app.importWorldbookFile('book.json', ${JSON.stringify(WORLDBOOK_JSON)});
    await new Promise((r) => setTimeout(r, 400));
    const overlay = document.querySelector('[data-role="import-dialog"]');
    const summary = [...overlay.querySelectorAll('.import-summary-line')].map((n) => ({
      text: n.textContent.trim(),
      warn: n.classList.contains('warn'),
    }));
    const before = window.__tcs.app.sessions[0].card.worldbook.entries.length;
    document.querySelector('[data-role="import-confirm"]').click();
    await new Promise((r) => setTimeout(r, 700));
    const card = window.__tcs.app.sessions[0].card;
    const source = window.__tcs.app.sessions[0].worldbookSource;
    return {
      summary,
      before,
      after: card.worldbook.entries.length,
      contents: card.worldbook.entries.map((e) => e.content),
      sourceFormat: source?.format ?? null,
      sourceRaw: source?.rawText ?? '',
      modeRowHidden: document.querySelector('.import-mode').hidden,
    };
  })()`);
  check('③ 识别格式 = JSON', wbImport.sourceFormat === 'json', String(wbImport.sourceFormat));
  check('③ 摘要报出条目数并警告"将替换"',
    wbImport.summary.some((line) => line.text.includes('2 个条目')) &&
      wbImport.summary.some((line) => line.warn && line.text.includes('替换')),
    JSON.stringify(wbImport.summary.map((l) => l.text)));
  check('③ 导入后世界书条目被替换为 2 条', wbImport.after === 2, `${String(wbImport.before)} → ${String(wbImport.after)}`);
  check('③ 条目内容正确', wbImport.contents.includes('一楼是店面'), JSON.stringify(wbImport.contents));
  check('③ 世界书导入没有模式切换（本就没有严格/宽松）', wbImport.modeRowHidden === true, '');
  await shot('d-worldbook-imported');

  // ── ④ JSON 往返逐字节一致（未改动）────────────────────
  //
  // 这一条**不能在页面里直接调导出函数**：导出要过 pickSavePath（原生对话框），
  // 无头环境驱动不了。所以分层验证：
  //   · 页面侧证明「导入保留了原文」（session.worldbookSource.rawText 逐字节等于输入）；
  //   · 逐字节写回本身由单测 `test/import-flow.test.mjs` 与
  //     `test/worldbook-io.test.mjs` 断言（那两层没有原生依赖）。
  const exported = await evaluate(`(async () => {
    const session = window.__tcs.app.sessions[0];
    const source = session.worldbookSource;
    return { rawText: source.rawText, format: source.format, entriesLen: session.card.worldbook.entries.length };
  })()`);
  check('④ 导入保留了原文（供逐字节写回）', exported.rawText === WORLDBOOK_JSON,
    `len=${String(exported.rawText.length)} vs ${String(WORLDBOOK_JSON.length)}`);

  // ── ⑤ 坏 JSON：错误定位到行 ───────────────────────────
  const broken = await evaluate(`(async () => {
    const pending = window.__tcs.app.importWorldbookFile('broken.json', ${JSON.stringify(BROKEN_JSON)});
    await new Promise((r) => setTimeout(r, 400));
    const overlay = document.querySelector('[data-role="import-dialog"]');
    const issues = [...overlay.querySelectorAll('[data-role="import-issues-list"] li')].map((li) => li.textContent.trim());
    const confirm = document.querySelector('[data-role="import-confirm"]');
    return {
      issues,
      confirmDisabled: confirm?.disabled ?? true,
      summary: [...overlay.querySelectorAll('.import-summary-line')].map((n) => n.textContent.trim()),
    };
  })()`);
  check('⑤ 坏 JSON：报出错误并带行号', broken.issues.some((text) => /第 \d+ 行/.test(text)), JSON.stringify(broken.issues.slice(0, 2)));
  check('⑤ 坏 JSON：导入按钮被禁用（不能导入残缺结果）', broken.confirmDisabled === true, '');
  check('⑤ 坏 JSON：摘要说明无法导入', broken.summary.some((line) => line.includes('无法导入')), JSON.stringify(broken.summary));
  await shot('e-broken-json');
  await evaluate(`document.querySelector('[data-role="import-dialog"] .icon-btn').click(), true`);
  await delay(300);

  // ── ⑥ 三路综合审计：世界书类别出现且可筛选 ──────────────
  const audit = await evaluate(`(async () => {
    const app = window.__tcs.app;
    // 造一个"永不触发"的世界书条目：keys 空且非常驻
    const card = structuredClone(app.sessions[0].card);
    card.worldbook.entries.push({ id: 99, keys: [], content: '这段永远不会出现', constant: false });
    app.sessions[0].replaceCard(card);
    app.reloadBlocksFromCard();
    app.validate();
    await new Promise((r) => setTimeout(r, 800));

    const panel = document.querySelector('#audit-panel');
    const chips = [...document.querySelectorAll('.chip-category')].map((c) => ({
      category: c.dataset.category,
      text: c.textContent.trim(),
    }));
    const wbIssues = app.report.issues.filter((i) => i.category === 'worldbook');
    const byCategory = app.report.byCategory;
    return {
      chips,
      worldbookIssueCount: wbIssues.length,
      worldbookMessages: wbIssues.map((i) => i.message),
      byCategory,
      panelChildren: panel.childElementCount,
    };
  })()`);
  check('⑥ 审计面板出现「世界书」类别筛选',
    audit.chips.some((chip) => chip.category === 'worldbook' && chip.text.startsWith('世界书')),
    JSON.stringify(audit.chips.map((c) => c.text)));
  check('⑥ 报告按来源分组：byCategory 含 worldbook',
    typeof audit.byCategory.worldbook === 'number' && audit.byCategory.worldbook > 0,
    JSON.stringify(audit.byCategory));
  check('⑥ 永不触发的条目被检出（无 keys 且非常驻）',
    audit.worldbookMessages.some((msg) => msg.includes('永远不会被触发')),
    JSON.stringify(audit.worldbookMessages.slice(0, 2)));
  check('⑥ 审计面板正文非空（F6 回归守卫）', audit.panelChildren > 0, `children=${String(audit.panelChildren)}`);

  // 按 worldbook 类别筛选后，列表只剩世界书条目
  const filtered = await evaluate(`(async () => {
    const chip = [...document.querySelectorAll('.chip-category')].find((c) => c.dataset.category === 'worldbook');
    chip.click();
    await new Promise((r) => setTimeout(r, 400));
    const rows = [...document.querySelectorAll('#audit-panel .issue')].map((n) => n.textContent.trim());
    const count = document.querySelector('.audit-count')?.textContent ?? '';
    chip.click(); // 取消筛选，恢复全量
    await new Promise((r) => setTimeout(r, 300));
    return { rows, count };
  })()`);
  check('⑥ 按世界书筛选后列表只剩世界书问题',
    filtered.rows.length > 0 && filtered.rows.every((text) => /世界书/.test(text)),
    `${String(filtered.rows.length)} 条：${filtered.rows.slice(0, 2).join(' | ').slice(0, 100)}`);
  await shot('f-audit-worldbook-category');

  check('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));

  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(OUT, 'result.json'), `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`, 'utf8');
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} 通过`);
  if (failed.length > 0) process.exitCode = 1;
  cdp.close();
}

try {
  await main();
} finally {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }
  await delay(400);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* 占用时留给系统 */
  }
}
