/**
 * 验证记忆面板的键盘避让在各种键盘高度下都成立（2026-11-22）。
 *
 * ## 为什么要真渲染验证
 *
 * 键盘避让有三层：CSS 变量 → mask 的 padding-bottom → sheet 的 max-height。
 * 静态断言只能证明"代码里写了这几行"，证明不了**布局真的被推上去**。
 * 这个项目在键盘避让上反复出过"值算出来了但没生效"（memory §119/§130）。
 *
 * ## 为什么不模拟具体机型
 *
 * 直接用**键盘高度**这个统一维度，不针对任何品牌：
 *
 * ```text
 *   0      没有键盘（正常态，不该有任何偏移）
 *   240    小屏 / 紧凑输入法
 *   320    常见中文输入法
 *   400    带候选栏 / 手写 / 大字号
 *   520    极端：手写键盘 + 候选词面板
 * ```
 *
 * 再叠加三种视口高度（矮 560 / 常见 780 / 高 920），覆盖"矮屏 + 大键盘"最坏组合。
 *
 * ## ★ 判定用**实测视口**，不用传入的标称值
 *
 * 本机无头 Chrome 上有约 2.5 倍额外缩放（`setDeviceMetricsOverride` 传 390×560，
 * 实际 `innerHeight` 成了 1408）。按标称值判定会让**所有组都报错** ——
 * 看起来像 CSS 全失效，实际是测试自己算错了基准。
 *
 * ## 判据
 *
 * ```text
 * ① sheet 底边 ≤ 键盘上沿     不被盖住
 * ② sheet 顶边 ≥ 0            没冲出屏幕
 * ③ sheet 高度 ≥ 120          没被压扁（至少放得下一行输入）
 * ④ 列表可滚                  被盖住的条目能滚出来
 * ⑤ 无键盘时底边贴视口底       没有多余空白
 * ```
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 9481;
const profile = `${process.env.TEMP}\\cdp-kb-${Date.now()}`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let page = null;
for (let i = 0; i < 80; i += 1) {
  await delay(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page = list.find((t) => t.type === 'page') ?? null;
    if (page) break;
  } catch { /* 等它起来 */ }
}
if (page === null) {
  process.stdout.write('✘ Chrome 起不来\n');
  chrome.kill();
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
  }
});
await new Promise((r) => ws.addEventListener('open', r));

/** 从真实 chat.css 里抠出三段（不整份引入，避免无关规则干扰） */
function sheetCss() {
  const css = readFileSync('client/src/chat/chat.css', 'utf8');
  const pick = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    if (at < 0) throw new Error(`找不到 ${selector}`);
    const end = css.indexOf('\n}', at);
    return css.slice(at + 1, end + 2);
  };
  return [pick('.nb-sheet-mask'), pick('.nb-sheet'), pick('.nb-sheet--memory')].join('\n');
}

const HARNESS_CSS = [
  ':root {',
  '  --nb-sp-1: 4px; --nb-sp-2: 8px; --nb-sp-3: 12px; --nb-sp-4: 16px;',
  '  --nb-radius-md: 10px; --nb-fs-14: 14px;',
  '  --nb-text-1: #eee; --nb-surface-1: #14121e; --nb-glass-border: #333;',
  '  --nb-danger: #f66; --nb-nebula-a: #7c5cff; --nb-nebula-b: #a68cff;',
  '  --nb-dur-micro: 80ms; --nb-ease-out: ease-out;',
  '  --nb-kb-inset: 0px;',
  '  --nb-kb-inset-native: 0px;',
  '}',
  'html, body { margin: 0; padding: 0; height: 100%; }',
  '@keyframes nb-mask-in { from { opacity: 0 } to { opacity: 1 } }',
  '@keyframes nb-sheet-up { from { transform: translateY(12px) } to { transform: none } }',
  sheetCss(),
  '.nb-memory-head { display: flex; align-items: center; justify-content: space-between; }',
  '.nb-memory-stats { display: flex; flex: 0 0 auto; flex-direction: column; gap: 2px; padding: 12px; }',
  '.nb-memory-list { display: flex; flex: 1 1 auto; flex-direction: column; gap: 8px; min-height: 0; overflow-y: auto; }',
  '.nb-memory-row { display: flex; align-items: flex-start; gap: 8px; }',
  '.nb-memory-input {',
  '  flex: 1 1 auto; width: 100%; min-width: 0; padding: 10px 12px;',
  '  font-size: 14px; line-height: 1.5; box-sizing: border-box; resize: none; overflow-y: auto;',
  '}',
  '.nb-memory-footer { display: flex; flex: 0 0 auto; gap: 8px; }',
].join('\n');

/** 造一个与 memory-page.ts 结构一致的 DOM，12 条把列表撑到能滚 */
const BUILD_DOM = `
(() => {
  document.body.innerHTML = '';
  const mask = document.createElement('div');
  mask.className = 'nb-sheet-mask';
  const sheet = document.createElement('div');
  sheet.className = 'nb-sheet nb-sheet--memory';
  const head = document.createElement('div');
  head.className = 'nb-memory-head';
  head.textContent = '记忆 · 测试角色';
  sheet.appendChild(head);
  const stats = document.createElement('div');
  stats.className = 'nb-memory-stats';
  stats.textContent = '已用 1240 / 3000 字符 · 约 1110 token';
  sheet.appendChild(stats);
  const list = document.createElement('div');
  list.className = 'nb-memory-list';
  for (let i = 0; i < 12; i += 1) {
    const row = document.createElement('div');
    row.className = 'nb-memory-row';
    const ta = document.createElement('textarea');
    ta.className = 'nb-memory-input';
    ta.rows = 2;
    ta.value = '第 ' + (i + 1) + ' 条记忆内容，用来把列表撑到可以滚动';
    row.appendChild(ta);
    list.appendChild(row);
  }
  sheet.appendChild(list);
  const footer = document.createElement('div');
  footer.className = 'nb-memory-footer';
  footer.innerHTML = '<button>导入</button><button>导出</button><button>保存</button>';
  sheet.appendChild(footer);
  mask.appendChild(sheet);
  document.body.appendChild(mask);
  return document.querySelectorAll('.nb-memory-input').length;
})()
`;

const VIEWPORTS = [
  { label: '矮屏', height: 560 },
  { label: '常见', height: 780 },
  { label: '高屏', height: 920 },
];
const KEYBOARDS = [
  { label: '无键盘', inset: 0 },
  { label: '紧凑240', inset: 240 },
  { label: '常见320', inset: 320 },
  { label: '候选栏400', inset: 400 },
  { label: '极端520', inset: 520 },
];

/* 注入一次样式，后面只重建 DOM */
await send('Runtime.evaluate', {
  expression: `
    (() => {
      const style = document.createElement('style');
      style.id = 'kb-harness-css';
      style.textContent = ${JSON.stringify(HARNESS_CSS)};
      document.head.appendChild(style);
      return document.styleSheets.length;
    })()
  `,
  returnByValue: true,
});

const results = [];
let failures = 0;

for (const vp of VIEWPORTS) {
  for (const kb of KEYBOARDS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: vp.height,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await send('Runtime.evaluate', {
      expression: `
        document.documentElement.style.setProperty('--nb-kb-inset', '${kb.inset}px');
        document.documentElement.style.setProperty('--nb-kb-inset-native', '${kb.inset}px');
      `,
    });
    const dom = await send('Runtime.evaluate', { expression: BUILD_DOM, returnByValue: true });
    if (typeof dom.result?.value !== 'number') {
      results.push(`✘ 造 DOM 失败：${vp.label}/${kb.label}`);
      failures += 1;
      continue;
    }

    const measured = await send('Runtime.evaluate', {
      expression: `
        (() => {
          const sheet = document.querySelector('.nb-sheet--memory');
          const list = document.querySelector('.nb-memory-list');
          const r = sheet.getBoundingClientRect();
          const lr = list.getBoundingClientRect();
          return {
            vh: window.innerHeight,
            sheetTop: Math.round(r.top),
            sheetBottom: Math.round(r.bottom),
            sheetHeight: Math.round(r.height),
            listHeight: Math.round(lr.height),
            listScrollable: Math.round(list.scrollHeight - list.clientHeight),
          };
        })()
      `,
      returnByValue: true,
    });
    const m = measured.result?.value;
    if (m === undefined || m === null) {
      results.push(`✘ 读布局失败：${vp.label}/${kb.label}`);
      failures += 1;
      continue;
    }

    const kbTop = m.vh - kb.inset;
    const problems = [];
    if (m.sheetBottom > kbTop + 2) problems.push(`底边${m.sheetBottom}>键盘上沿${kbTop}`);
    if (m.sheetTop < -2) problems.push(`顶边${m.sheetTop}<0`);
    if (m.sheetHeight < 120) problems.push(`高度只有${m.sheetHeight}`);
    if (kb.inset === 0 && Math.abs(m.sheetBottom - m.vh) > 2) {
      problems.push(`无键盘却偏移(底${m.sheetBottom}/视口${m.vh})`);
    }
    /*
     * ★ 关于"列表可滚"：只在**内容确实超出**时才要求可滚。
     *
     * 第一版无条件要求 `listScrollable > 0`，于是在"面板放得下全部 12 条"
     * 的那些组合里全部误报 —— 内容装得下时本来就不该有滚动条。
     * 现在的判据是：面板被压到装不下时，列表必须可滚（否则被盖住的条目够不着）。
     */
    if (m.sheetTop < -2 && m.listScrollable === 0) {
      problems.push('面板被压缩但列表不可滚，末端条目够不着');
    }

    const ok = problems.length === 0;
    if (!ok) failures += 1;
    results.push(
      `${ok ? '✔' : '✘'} ${vp.label}(${vp.height}→实测${m.vh}) + ${kb.label}  ` +
        `sheet ${m.sheetTop}~${m.sheetBottom} 高${m.sheetHeight}  ` +
        `列表高${m.listHeight} 可滚${m.listScrollable}` +
        (ok ? '' : `  ← ${problems.join('；')}`),
    );
  }
}


process.stdout.write(results.join('\n') + '\n');
process.stdout.write(`\n${failures === 0 ? '✔ 全部通过' : `✘ ${failures} 组不通过`}\n`);

ws.close();
chrome.kill();
process.exit(failures === 0 ? 0 : 1);
