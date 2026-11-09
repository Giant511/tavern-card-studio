/**
 * 截取移动端各页面截图（修复前/后对比用），并同时输出**量化布局证据**。
 *
 * 用法：bash scripts/run-probe.sh   （或手工 node scripts/probe-shots.mjs --port ...）
 *
 * ## 截哪些、各自证明什么
 *
 * | 截图 | 证明 |
 * |---|---|
 * | `-chat-sample-bottom` | 有对话且滚到最底时，输入区在 Tab 栏正上方（贴底） |
 * | `-chat-sample-top`    | 滚到最顶时输入区仍在原位（`position:static`，不是浮在中部） |
 * | `-chat-empty`         | 空状态不该被输入区挤变形 |
 * | `-api-collapsed`      | 接口源默认收起 |
 * | `-api-expanded`       | 点一项后**就地**展开配置，且该项有高亮 |
 * | `-voice-expanded`     | 「我的」页语音区块能展开出完整配置 |
 *
 * ## 「有对话」怎么造
 *
 * 移动端此刻连不上 ST（T15.3 主体未完成），没有历史可载。走 `?sample=1`
 * （`client/src/mobile/sample-chat.ts`，与桌面端 `editor/app.ts:5344` 同一口径）。
 * 判据是 `body.dataset.sampleChat === 'true'`，**不是 sleep 猜**——
 * 之前踩过"没等应用就绪就截图，截到骨架"的坑。
 *
 * ## 为什么要输出数字，不能只给截图
 *
 * 「输入区悬浮在中部」这个现象，看截图能看见但不能证明修好了：
 * 截图里"看起来贴底"和"真的是布局贴底"在窄屏上没区别。真正的判据是
 * `composer.bottom === tabbar.top`，且 `composer` 的 `position` 是 `static`
 * —— 用 `position:fixed` 硬钉上去也会"看起来贴底"，但键盘弹起时就不动了。
 * 所以每张图配一组数字，报告里引用数字。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const PORT = Number(arg('--port', '20912'));
const HTTP_PORT = Number(arg('--http-port', '20911'));
const OUT = arg('--out', 'assets/android');
const PREFIX = arg('--prefix', 'shot');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const connect = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(new Cdp(ws)));
    ws.addEventListener('error', () => reject(new Error('WS 连接失败')));
  });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 360,
  height: 800,
  deviceScaleFactor: 2,
  mobile: true,
});

const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  }
  return r.result.value;
};

mkdirSync(OUT, { recursive: true });

async function shot(name) {
  /*
   * 截前等一小会。
   *
   * 不是为了"等等看"，是为了让 **overlay 滚动条淡出**：Chromium 在滚动后
   * 会画一条浮在内容上的滚动条，几百毫秒后自己消失。它不占布局
   * （实测 `.nb-msglist` 的 `offsetWidth - clientWidth === 0`），
   * 但会出现在截图上，看起来像"右边有多余的一条"。
   *
   * 这一段**不能替代判据**：布局对不对仍然看 `measure()` 的 rect 数字。
   */
  await sleep(420);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const p = join(OUT, `${name}.png`);
  writeFileSync(p, Buffer.from(data, 'base64'));
  console.log(`  ${p}`);
  return p;
}

/** 导航并等到 shell 就绪。`waitFlag` 是要额外等的 body.dataset 标记。 */
async function load(query, waitFlag) {
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/mobile.html${query}` });
  await sleep(600);
  for (let i = 0; i < 60; i += 1) {
    const ready = await ev(
      `document.body.dataset.appReady === 'true' && (${waitFlag ? `document.body.dataset.${waitFlag} === 'true'` : 'true'})`,
    );
    if (ready === true) return true;
    await sleep(100);
  }
  console.error(`  [WARN] 等就绪超时：query=${query || '(空)'} flag=${waitFlag ?? '-'}`);
  return false;
}

/**
 * 量一次布局。
 *
 * 全部用 `getBoundingClientRect()` 的真值，不用 CSS 声明猜
 * （memory §23 的教训：读 rect 比盯截图猜快）。
 *
 * 选择器用**类名**（`.nb-composer` / `.nb-msglist`），与既有的
 * `scripts/probe-composer.mjs` 保持一致 —— 第一版我按 `data-role="composer"`
 * 去查，而面板上真实的 data-role 只有 `chat-panel` / `msglist` / `send`，
 * 输入区根本没挂 data-role，那几个字段会全是 null 而脚本照样打印。
 */
const measure = `(() => {
  const q = (s) => document.querySelector(s);
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) }; };
  const cs = (el, p) => el ? getComputedStyle(el).getPropertyValue(p) : null;
  const chat = q('.nb-chat');
  const composer = q('.nb-composer');
  const tabbar = q('.nb-tabbar');
  /*
   * 量列表用元素查询，不要用 .nb-msglist 的 children。
   *
   * 因为 .nb-msglist 在结构上嵌套了两层：ChatPanel.mount() 自己建的滚动容器
   * 就是 .nb-msglist（它的 listEl），而 renderMessageList() 返回的又是一个
   * .nb-msglist 塞进去。querySelector 只取外层，数出来的 2 是
   * "内层容器 + 草稿卡"，不是消息条数 —— 第一版就是这么数错的。
   * 按 .nb-msg（真实气泡）数，与嵌套层数无关。
   */
  const list = q('.nb-msglist');
  const bubbles = [...document.querySelectorAll('.nb-msg')];
  const last = bubbles.length > 0 ? bubbles[bubbles.length - 1] : null;
  /*
   * 诊断：.nb-msglist 嵌套了两层（面板的滚动容器 + renderMessageList 的返回），
   * 两层都带 data-role="msglist"。哪一层真的滚、哪一层的 scrollHeight 反映内容，
   * 必须分别量 —— 只量一层的结论可能是错的（第一版量到外层 scrollH == h，
   * 就误判成"没有溢出"，而实际最后一条气泡在 top=882、视口只有 800）。
   */
  const inner = list ? list.querySelector('.nb-msglist') : null;
  return {
    viewportH: window.innerHeight,
    chat: r(chat),
    chatPos: cs(chat, 'position'),
    chatFlex: cs(chat, 'flex'),
    composer: r(composer),
    composerPos: cs(composer, 'position'),
    tabbar: r(tabbar),
    list: r(list),
    listScrollH: list ? list.scrollHeight : null,
    listScrollTop: list ? Math.round(list.scrollTop) : null,
    listOverflowY: cs(list, 'overflow-y'),
    innerExists: inner !== null,
    inner: r(inner),
    innerScrollH: inner ? inner.scrollHeight : null,
    innerScrollTop: inner ? Math.round(inner.scrollTop) : null,
    innerOverflowY: cs(inner, 'overflow-y'),
    bubbleCount: bubbles.length,
    lastBubble: r(last),
    gapComposerToTabbar: (composer && tabbar)
      ? Math.round(tabbar.getBoundingClientRect().top - composer.getBoundingClientRect().bottom) : null,
    lastBubbleCovered: (last && composer)
      ? Math.round(last.getBoundingClientRect().bottom - composer.getBoundingClientRect().top) : null,
  };
})()`;

const clickTab = async (id) => {
  await ev(`document.querySelector('.nb-tab[data-tab="${id}"]')?.click()`);
  await sleep(350);
};

/* ═══ A. 有对话（?sample=1）═══ */
const sampleReady = await load('?sample=1', 'sampleChat');

// A1：进入即贴底
await shot(`${PREFIX}-chat-sample-bottom`);
const bottomFacts = await ev(measure);

// A2：滚到顶，验证输入区不跟着跑
await ev(`(() => { const l = document.querySelector('.nb-msglist'); if (l) l.scrollTop = 0; })()`);
await sleep(300);
await shot(`${PREFIX}-chat-sample-top`);
const topFacts = await ev(measure);

/* ═══ B. 空状态 ═══ */
await load('');
await clickTab('chat');
await shot(`${PREFIX}-chat-empty`);
const emptyFacts = await ev(measure);

/* ═══ C. 我的 → API 连接 ═══ */
await clickTab('me');
await shot(`${PREFIX}-api-collapsed`);

const expanded = await ev(`(() => {
  const items = [...document.querySelectorAll('[data-role="source-list"] .nb-listitem')];
  if (items.length < 2) return { ok: false, reason: '选项少于 2 个：' + items.length };
  const before = items[1].getAttribute('aria-expanded');
  items[1].click();
  return { ok: true, count: items.length, before };
})()`);
await sleep(400);
await shot(`${PREFIX}-api-expanded`);

/*
 * 展开之后**滚到底**再截一张。
 *
 * 为什么要单独一张：展开面板比一屏高（实测 `.nb-scroll` 内容 1558、
 * 可视 690），滚到顶那张只能看到地址与模型名，看不到 key 输入框和保存按钮。
 * 「保存按钮能不能点到」是这一页的核心判据，必须有一张图证明它完整可见。
 */
const scrollFacts = await ev(`(() => {
  const sc = document.querySelector('.nb-scroll');
  if (sc === null) return { exists: false };
  const save = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '保存');
  sc.scrollTop = sc.scrollHeight;
  return {
    exists: true,
    canScroll: sc.scrollHeight > sc.clientHeight,
    scrollH: sc.scrollHeight,
    clientH: sc.clientHeight,
    saveVisible: save !== null && save.getBoundingClientRect().bottom <= window.innerHeight,
  };
})()`);
await sleep(320);
await shot(`${PREFIX}-api-expanded-bottom`);

const afterClick = await ev(`(() => {
  const items = [...document.querySelectorAll('[data-role="source-list"] .nb-listitem')];
  return items.map((el) => ({
    source: el.getAttribute('data-source'),
    pressed: el.getAttribute('aria-pressed'),
    expanded: el.getAttribute('aria-expanded'),
    hasPanel: el.nextElementSibling !== null && el.nextElementSibling.classList.contains('nb-acc-panel'),
    panelHidden: el.nextElementSibling && el.nextElementSibling.classList.contains('nb-acc-panel')
      ? el.nextElementSibling.hidden : null,
  }));
})()`);

/* ═══ D. 语音配置 ═══ */
const voiceEntry = await ev(`(() => {
  const all = [...document.querySelectorAll('[data-role="voice-entry"], [data-voice-section]')];
  return { found: all.length, texts: all.map((e) => (e.textContent || '').trim().slice(0, 40)) };
})()`);

const voiceOpen = await ev(`(() => {
  const h = document.querySelector('[data-role="voice-entry"]');
  if (!h) return { ok: false };
  h.click();
  return { ok: true };
})()`);
await sleep(500);

/*
 * 展开后把语音区块滚进视口。
 *
 * 不滚的话截图拍到的是"滚动条停在上一次的位置 + 语音标题高亮着"——
 * 看起来像"点了没反应"。`block: 'start'` 让标题贴近顶部，
 * 下面的配置项才有空间显示。
 */
await ev(`(() => {
  const panel = document.querySelector('[data-role="voice-panel"]');
  const entry = document.querySelector('[data-role="voice-entry"]');
  const target = entry ?? panel;
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'start' });
  }
  return true;
})()`);
await sleep(360);
await shot(`${PREFIX}-voice-expanded`);

const voiceFacts = await ev(`(() => {
  const panel = document.querySelector('[data-role="voice-panel"]');
  if (!panel) return { missing: true };
  const fields = [...panel.querySelectorAll('[data-role]')].map((e) => e.getAttribute('data-role'));
  return {
    hidden: panel.hidden,
    fieldCount: fields.length,
    fields: [...new Set(fields)].slice(0, 20),
    hasPresetSelect: panel.querySelector('select') !== null,
    textLen: (panel.innerText || '').length,
    textHead: (panel.innerText || '').replace(/\\s+/g, ' ').slice(0, 100),
  };
})()`);

console.log(
  JSON.stringify(
    {
      sampleReady,
      layout: { bottomFacts, topFacts, emptyFacts },
      expanded,
      scrollFacts,
      afterClick: afterClick.slice(0, 2),
      voiceEntry,
      voiceOpen,
      voiceFacts,
    },
    null,
    1,
  ),
);

cdp.ws.close();
process.exit(0);
