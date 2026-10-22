/**
 * T9.14 端到端：未落盘会话的 beforeunload 拦截（浏览器侧断言）。
 *
 * 分工：本脚本只做断言，浏览器与静态服务由外部启动
 *   （本机 Node 无法 spawn 任何子进程，`spawnSync('cmd.exe')` 返回 EBUSY）。
 *   启动方式见 scripts/verify-beforeunload.sh。
 *
 * 判据为什么用「页面内标记是否存活」而不是「有没有弹框」：
 *   · 弹框由浏览器绘制，headless 下可能被自动处理，观测不稳定；
 *   · 我们要证明的是**导航有没有发生**——所以先在页面里写一个
 *     `window.__tcsMarker`，再触发 reload：标记还在 = 没重载（被拦住了），
 *     标记没了 = 真重载了（放行了）。
 *   这与决策 #25 的思路一致：进程/页面死掉时渲染断言根本跑不到，
 *   所以判据要选"事件能否完成"这种更靠前的事实。
 *
 * 用法：node scripts/verify-beforeunload.mjs [CDP 端口] [页面 URL]
 * 退出码：0 全部通过；1 有断言失败
 */

const PORT = process.argv[2] ?? '9333';
const PAGE_URL = process.argv[3] ?? 'http://127.0.0.1:8899/index.html';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
}

// ── 极简 CDP 客户端 ───────────────────────────────────────
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
  if (!page) throw new Error('没找到 8899 的 page target：' + JSON.stringify(targets.map((t) => t.url)));
  return page.webSocketDebuggerUrl;
}

const main = async () => {
  const wsUrl = await findPageTarget();
  const cdp = new Cdp(wsUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // 收集弹框事件（可能被 headless 自动处理，仅作旁证）
  let dialogCount = 0;
  let lastDialog = null;
  cdp.on('Page.javascriptDialogOpening', (p) => {
    dialogCount += 1;
    lastDialog = p;
    // 立刻按「留下」处理，否则页面会被对话框卡住
    cdp.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
  });

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面脚本报错：' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    }
    return r.result.value;
  };

  // ── 0a. 先强制重载一次，保证跑的是最新 client/dist ──────────
  // 否则 Chrome 可能还挂着上一次构建的 bundle，测出"改了代码但结果没变"的假象
  // （与决策 #22 的教训同源：产物是否最新只能靠时间链/强制重载确认）。
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1200);

  // ── 0. 等 app 就绪 ─────────────────────────────────────
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    ready = await evaluate(
      `(() => { const s = document.querySelector('#status'); return !!s && !s.textContent.includes('初始化'); })()`,
    );
    if (ready) break;
    await sleep(250);
  }
  check('应用完成初始化（规则加载完毕）', ready);
  if (!ready) {
    cdp.close();
    process.exit(1);
  }

  // 记录初始标签数（可能是 0，也可能因浏览器的会话恢复不为 0）
  const initialTabs = await evaluate(`document.querySelectorAll('.tab').length`);

  // ── 1. 通过真实 UI 造一张未落盘的卡 ────────────────────
  //
  // 注意：**新建出来的卡此时还不算"脏"**。CardSession 的 dirty 语义是
  // "有未保存到磁盘的修改"，刚创建的空卡没有修改，所以 dirty=false
  // （它是"未落盘"，由标签的虚线边框表达，不是脏标记）。
  // 与此一致：关闭一张没改过的新卡不会弹三选确认。
  // 因此要拦 reload，必须真的改点内容 —— 下面走编辑器输入，不伪造状态。
  await evaluate(`document.querySelector('#btn-new').click()`);
  let dialogOpen = false;
  for (let i = 0; i < 40; i += 1) {
    dialogOpen = await evaluate(
      `(() => [...document.querySelectorAll('.modal-overlay')].some(
         (o) => !o.hasAttribute('hidden') && o.textContent.includes('新建角色卡')))()`,
    );
    if (dialogOpen) break;
    await sleep(100);
  }
  check('F11 新建对话框可打开', dialogOpen);

  const created = await evaluate(`(() => {
    const overlay = [...document.querySelectorAll('.modal-overlay')].find(
      (o) => !o.hasAttribute('hidden') && o.textContent.includes('新建角色卡'));
    if (!overlay) return 'no-overlay';
    const inputs = overlay.querySelectorAll('.input');
    const name = inputs[0];
    if (!name) return 'no-input';
    name.value = 'E2E拦截验证';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const idValue = inputs[1] ? inputs[1].value : '';
    const btn = [...overlay.querySelectorAll('.btn.primary')].pop();
    if (!btn) return 'no-button';
    btn.click();
    return idValue;
  })()`);
  check('新建对话框填表并提交（同时读回自动生成的 cardId）', typeof created === 'string' && created !== 'no-input' && created !== 'no-button' && created !== 'no-overlay', String(created));

  let tabInfo = null;
  for (let i = 0; i < 40; i += 1) {
    tabInfo = await evaluate(`(() => {
      const tab = document.querySelector('.tab.is-active');
      if (!tab) return null;
      return { text: tab.textContent, unpersisted: tab.classList.contains('is-unpersisted') };
    })()`);
    if (tabInfo) break;
    await sleep(100);
  }
  check('新卡挂上标签', !!tabInfo, tabInfo ? JSON.stringify(tabInfo) : 'none');
  check(
    '新建的空卡：未落盘（虚线边框）但尚未变脏（无 ●）——与关闭标签的判据一致',
    !!tabInfo && tabInfo.unpersisted === true && !tabInfo.text.includes('●'),
    tabInfo ? `text=${JSON.stringify(tabInfo.text)} unpersisted=${String(tabInfo.unpersisted)}` : '',
  );

  // ── 1b. 真的改一点内容，让它变脏 ───────────────────────
  // 展开第一个板块 → 把焦点放进 CodeMirror → 用浏览器原生的文本输入事件打字。
  // 走的是真实输入路径（CM6 的 beforeinput/input），不是直接写 session 字段。
  await evaluate(`(() => {
    const head = document.querySelector('.block .block-head');
    if (head) head.click();
  })()`);
  let editorReady = false;
  for (let i = 0; i < 40; i += 1) {
    editorReady = await evaluate(`!!document.querySelector('.cm-content')`);
    if (editorReady) break;
    await sleep(100);
  }
  check('板块展开后出现编辑器', editorReady);

  await evaluate(`(() => {
    const content = document.querySelector('.cm-content');
    if (!content) return false;
    content.focus();
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  })()`);
  await cdp.send('Input.insertText', { text: '这是一段用来制造未保存状态的文字。' });
  await sleep(600);

  const dirtyTab = await evaluate(`(() => {
    const tab = document.querySelector('.tab.is-active');
    return tab ? { text: tab.textContent, unpersisted: tab.classList.contains('is-unpersisted') } : null;
  })()`);
  check(
    '编辑后标签出现脏标记 ●',
    !!dirtyTab && dirtyTab.text.includes('●'),
    dirtyTab ? `text=${JSON.stringify(dirtyTab.text)}` : 'no-tab',
  );

  // ── 2. 有脏会话时 reload 必须被拦住 ────────────────────
  await evaluate(`window.__tcsMarker = 'alive-dirty'`);
  const beforeReload = dialogCount;
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(1800);

  const markerAfterDirtyReload = await evaluate(`window.__tcsMarker ?? null`);
  check(
    '脏会话下 reload 被拦：页面内标记存活（导航未发生）',
    markerAfterDirtyReload === 'alive-dirty',
    `marker=${JSON.stringify(markerAfterDirtyReload)}`,
  );
  console.log(`   · 旁证：期间捕获 unload 对话框事件 ${String(dialogCount - beforeReload)} 次` +
    (lastDialog ? `，message=${JSON.stringify(lastDialog.message)}` : ''));

  const tabsAfterDirtyReload = await evaluate(`document.querySelectorAll('.tab').length`);
  check(
    '脏会话下 reload 被拦：标签没有丢',
    tabsAfterDirtyReload === initialTabs + 1,
    `期望 ${String(initialTabs + 1)} 个，实际 ${String(tabsAfterDirtyReload)} 个`,
  );

  // ── 3. 走「不保存关闭」把会话清干净 ────────────────────
  const closed = await evaluate(`(() => {
    const closer = document.querySelector('.tab.is-active .tab-close');
    if (!closer) return 'no-close';
    closer.click();
    return 'clicked';
  })()`);
  check('点标签关闭按钮', closed === 'clicked', closed);

  let confirmShown = false;
  for (let i = 0; i < 30; i += 1) {
    confirmShown = await evaluate(
      `(() => [...document.querySelectorAll('.modal-overlay')].some((o) => !o.hidden && o.textContent.includes('未保存')))()`,
    );
    if (confirmShown) break;
    await sleep(100);
  }
  check('脏会话关闭时弹出三选确认', confirmShown);

  const discarded = await evaluate(`(() => {
    const overlay = [...document.querySelectorAll('.modal-overlay')].find((o) => !o.hidden && o.textContent.includes('未保存'));
    if (!overlay) return 'no-overlay';
    const btn = [...overlay.querySelectorAll('.btn')].find((b) => b.textContent.trim() === '不保存关闭');
    if (!btn) return 'no-button';
    btn.click();
    return 'ok';
  })()`);
  check('选择「不保存关闭」', discarded === 'ok', discarded);
  await sleep(400);

  const tabsAfterClose = await evaluate(`document.querySelectorAll('.tab').length`);
  check(
    '关闭后回到初始标签数（会话已清空）',
    tabsAfterClose === initialTabs,
    `期望 ${String(initialTabs)} 个，实际 ${String(tabsAfterClose)} 个`,
  );

  // ── 4. 全部干净时 reload 必须放行 ──────────────────────
  await evaluate(`window.__tcsMarker = 'alive-clean'`);
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(2500);

  // 重载后要等 app 重新初始化再读 marker
  let markerAfterCleanReload = 'page-not-loaded';
  for (let i = 0; i < 40; i += 1) {
    try {
      markerAfterCleanReload = await evaluate(`window.__tcsMarker ?? null`);
      break;
    } catch {
      await sleep(200);
    }
  }
  check(
    '全部干净时 reload 放行：页面标记消失（确实重载了）',
    markerAfterCleanReload === null,
    `marker=${JSON.stringify(markerAfterCleanReload)}`,
  );

  // 重载后确实回到空工作台（真实重载的正面证据）
  let emptyAgain = false;
  for (let i = 0; i < 40; i += 1) {
    emptyAgain = await evaluate(
      `(() => { const s = document.querySelector('#status'); return !!s && s.textContent.includes('空白工作台'); })()`,
    );
    if (emptyAgain) break;
    await sleep(200);
  }
  check('重载后回到空白工作台', emptyAgain);

  cdp.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${String(results.length)} 项，失败 ${String(failed.length)} 项`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('✘ 验证中断：' + String(err?.message ?? err));
  process.exit(1);
});
