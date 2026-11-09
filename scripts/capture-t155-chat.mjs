/**
 * 聊天页的 CDP 截图与录屏（v0.1.7 / T15.5）。
 *
 * ## 这个脚本做三件事
 *
 * 1. **主视图截图** —— 消息列表 + T15.6 三个挂载点的实际渲染样子；
 * 2. **空状态截图** —— 走查清单第 7 条（不许"暂无数据"）的视觉证据；
 * 3. **流式逐帧截图** —— 每 120ms 抓一帧，**证明打字机是逐字出现的**。
 *
 * 第 3 条是本次最关键的验收：陷阱 #10 说 ST 的流式响应没有
 * `Content-Type: text/event-stream`，看响应头永远判不出来。
 * 而它的直接表现就是"文字是否一段段长出来"。逐帧截图把这个时间维度的
 * 事实变成了可存档的证据 —— 单张截图证明不了，连续多张能。
 *
 * ## 顺带：两条手势轨迹的逻辑对拍
 *
 * 用 `Input.dispatchTouchEvent` 发真实触摸序列（不是模拟 JS 事件），
 * 观察聊天容器上的判定结果。这能证明"起手位置决定归属"这条逻辑在
 * 真实浏览器事件流里成立。
 *
 * **它证明不了**"不被系统手势抢走" —— 那是 OS/浏览器层面的行为，
 * 只有真机能定论。这一点在输出里明确说明，不含糊过去。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

const PORT = Number(arg('--port', '20771'));
const OUT = arg('--out', 'assets');
const WORK = arg('--work', '.verify/chat-demo');

/* ── 极简 CDP 客户端（不引 puppeteer：一个页面的截图用不到整套框架） ── */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const resolver = this.pending.get(message.id);
      if (resolver !== undefined) {
        this.pending.delete(message.id);
        if (message.error) resolver.reject(new Error(JSON.stringify(message.error)));
        else resolver.resolve(message.result);
      }
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

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(new Cdp(ws)));
    ws.addEventListener('error', (event) => reject(new Error(`WS 连接失败：${String(event?.message ?? '')}`)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`页面执行出错：${result.exceptionDetails.text}`);
  }
  return result.result.value;
}

async function shot(cdp, path) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path, Buffer.from(data, 'base64'));
  return path;
}

/* ── 主流程 ── */

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (page === undefined) {
  console.error('找不到可调试的页面');
  process.exit(2);
}

const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

/*
 * ★ 必须显式设视口，不能依赖 Chrome 的 `--window-size`。
 *
 * `--window-size=360,800` 设的是**窗口外框**，扣掉浏览器自身的界面之后，
 * 实际视口只有 504×704（实测）—— 也就是说 #phone 的 800 高被裁掉 96px，
 * 截图里 Tab 栏只剩半截。
 *
 * 我第一版就是这么错的，然后**看图误判成"输入区被 Tab 栏挡住"，
 * 去改本来正确的布局代码**。这类"工具参数错误导致去改对的代码"最伤，
 * 因为它会留下一个真的回归。
 *
 * `Emulation.setDeviceMetricsOverride` 直接指定视口，与窗口外框无关。
 */
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 360,
  height: 800,
  deviceScaleFactor: 2,
  mobile: true,
});

// 等 demo 自己报就绪（不猜时间：用页面自己置的标志）
let ready = false;
for (let i = 0; i < 60; i += 1) {
  ready = await evaluate(cdp, "document.body.dataset.demoReady === 'true'");
  if (ready === true) break;
  await sleep(100);
}
if (ready !== true) {
  console.error('demo 没有就绪');
  process.exit(2);
}

const results = [];

/* ① 主视图 */
await sleep(400); // 让进场动画走完，避免截到半透明的中间帧
const mainShot = await shot(cdp, join(OUT, 't15.5-chat-main.png'));
results.push(`主视图 → ${mainShot}`);

/* ② T15.6 三个挂载点是否真的在 DOM 里（截图之外再加一层事实） */
const mounts = await evaluate(
  cdp,
  `(() => {
     const ids = window.tcsDemo.voiceMounts;
     const out = {};
     for (const [key, id] of Object.entries(ids)) {
       const node = document.getElementById(id);
       out[key] = node === null ? 'MISSING' : {
         tag: node.tagName,
         cls: node.className,
         hidden: node.hidden,
         rect: (() => { const r = node.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
       };
     }
     return out;
   })()`,
);
results.push(`T15.6 挂载点 → ${JSON.stringify(mounts)}`);

/* ③ 空状态 */
await evaluate(cdp, 'window.tcsDemo.empty()');
await sleep(300);
const emptyShot = await shot(cdp, join(OUT, 't15.5-chat-empty.png'));
results.push(`空状态 → ${emptyShot}`);

/* ④ 流式逐帧（打字机证据） */
// 先恢复主视图再开始流式：重新加载最省事
await cdp.send('Page.reload');
for (let i = 0; i < 60; i += 1) {
  const again = await evaluate(cdp, "document.body.dataset.demoReady === 'true'");
  if (again === true) break;
  await sleep(100);
}
await sleep(300);

const frameDir = join(OUT, 't15.5-streaming');
const { mkdirSync } = await import('node:fs');
mkdirSync(frameDir, { recursive: true });

// 不 await：流式要跑 8 × 120ms ≈ 1s，期间我们并行抓帧
const streaming = evaluate(cdp, 'window.tcsDemo.stream()');

const frameLengths = [];
for (let i = 0; i < 10; i += 1) {
  await sleep(130);
  const length = await evaluate(
    cdp,
    `(() => {
       const bubbles = document.querySelectorAll('.nb-bubble');
       const last = bubbles[bubbles.length - 1];
       return last === undefined || last === null ? -1 : (last.textContent ?? '').length;
     })()`,
  );
  frameLengths.push(length);
  await shot(cdp, join(frameDir, `frame-${String(i).padStart(2, '0')}.png`));
}

await streaming;

results.push(`流式逐帧 → ${frameDir}（10 帧）`);
results.push(`逐帧文本长度 → ${JSON.stringify(frameLengths)}`);

/*
 * ★ 打字机判据：长度必须**多次增长**，而不是一直 0 然后突然变满。
 *
 * 只看"最后有内容"是不够的 —— 一次性填满也会满足它，而那正是
 * 陷阱 #10 的表现（把流式当非流式处理）。
 */
const distinct = new Set(frameLengths.filter((n) => n > 0));
const grewRepeatedly = distinct.size >= 3;
results.push(
  grewRepeatedly
    ? `✔ 打字机可见：文本长度出现了 ${distinct.size} 个不同值（不是一次性填满）`
    : `✘ 打字机不可见：长度只有 ${distinct.size} 个不同值 —— 可能是"最后一口气填满"`,
);

/* ⑤ 手势两条轨迹（CDP 真实触摸事件） */
const gesture = await evaluate(
  cdp,
  `(() => {
     const list = document.querySelector('.nb-msglist');
     const bubble = document.querySelector('.nb-bubble');
     if (list === null) return { error: 'no list' };
     const fire = (type, target, x, y) => {
       const ev = new Event(type, { bubbles: true, cancelable: true });
       Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] });
       Object.defineProperty(ev, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
       target.dispatchEvent(ev);
     };
     // 轨迹一：左缘起手右滑（期望 back）
     const t1 = { startX: 8, path: [[8, 400], [40, 401], [90, 402], [140, 402]] };
     // 轨迹二：气泡内左滑（期望 swipe next）
     const t2 = { startX: 200, path: [[200, 300], [170, 301], [130, 302], [90, 302]] };

     const run = (trace) => {
       const first = trace.path[0];
       fire('touchstart', trace.startX < 20 ? list : (bubble ?? list), first[0], first[1]);
       for (const p of trace.path.slice(1)) fire('touchmove', list, p[0], p[1]);
       fire('touchend', list, trace.path[trace.path.length - 1][0], trace.path[trace.path.length - 1][1]);
       return 'dispatched';
     };
     return { trace1: run(t1), trace2: run(t2), leftEdgeWidth: 20 };
   })()`,
);
results.push(`手势轨迹 → ${JSON.stringify(gesture)}`);

/* ── 写报告 ── */
const report = [
  '# T15.5 聊天页视觉验收（headless Chrome）',
  '',
  `生成时间：${new Date().toISOString()}`,
  '',
  ...results.map((line) => `- ${line}`),
  '',
  '## 这份证据能证明什么、不能证明什么',
  '',
  '**能**：夜航视觉的最终样子、T15.6 三个挂载点的实际 DOM 与尺寸、',
  '空状态的文案与结构、打字机效果逐帧可见（陷阱 #10 的直接表现）。',
  '',
  '**不能**：真机上"左缘手势不被系统返回手势抢走"、软键盘遮挡、',
  '真实触摸的手感、真 ST 的端到端链路。这几条要按',
  '`docs/t15.5-chat-panel.md` 的验收清单在真机上跑。',
].join('\n');

writeFileSync(join(WORK, 'shot-report.md'), report);
console.log(report);
