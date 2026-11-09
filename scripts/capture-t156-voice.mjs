/**
 * T15.6 语音全链路录屏（v0.1.7）。
 *
 * ## 录什么（2026-10-31 用户明确的三条路径）
 *
 * 1. **默认不二次确认** → 按住 → 松手 → **直接发出**，
 *    发出的消息本身是「语音气泡（音频条）+ 下面识别出来的文字」；
 * 2. **下滑取消** → 按住 → 下滑 → 松手 → 本次作废（不发、不转写）；
 * 3. **打开二次确认** → 按住 → 松手 → 停在草稿卡（音频条 + 文字 + 确认/取消）
 *    → 可就地编辑 → 确认后变成和路径 1 一样的那条消息。
 *
 * ## 为什么路径 1 要单独录
 *
 * 它是**默认路径**，但 2026-10-30 那一版把它画成了"纯文字 + 🎤 小徽标"，
 * 用户当场指出「语音气泡下是识别出来的文字」。默认路径最容易做错，
 * 因为它不像草稿卡那样"有一个明显的界面要看"。
 *
 * ## 为什么录"逐帧"而不是真正的视频
 *
 * 真 mp4 要 ffmpeg（本机没有），CDP 的 `Page.startScreencast` 也是
 * 一串 base64 帧、仍然要编码。所以用逐帧 PNG 序列，
 * 判据是"帧与帧之间画面确实变了"（帧文件字节哈希去重）。
 * 时间维度的事实（波形在动、打字机）反而逐帧更好核验。
 *
 * 用法（由 capture-t156-voice.sh 调用）：
 *   node scripts/capture-t156-voice.mjs --port 20881 --out assets
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const PORT = Number(arg('--port', '20881'));
const OUT = arg('--out', 'assets');
const WORK = arg('--work', '.verify/chat-demo');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── CDP ── */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data);
      const p = this.pending.get(m.id);
      if (p === undefined) return;
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

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(new Cdp(ws)));
    ws.addEventListener('error', () => reject(new Error('WS 连接失败')));
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `页面执行出错：${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`,
    );
  }
  return result.result.value;
}

async function shot(cdp, path) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(data, 'base64'));
  return createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex').slice(0, 12);
}

/* ── 主流程 ── */

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (page === undefined) {
  console.error('找不到可调试页面');
  process.exit(2);
}

const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
/*
 * 视口必须与 demo 的 #phone 一致（360×800）。
 *
 * `--window-size` 是**外框**不是视口：360×800 的窗口实测视口是 504×704，
 * 底部 96px 被裁掉。我第一版就是拿裁过的截图去改本来正确的布局。
 * 只有 `Emulation.setDeviceMetricsOverride` 能让视口等于这个数。
 */
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 360,
  height: 800,
  deviceScaleFactor: 2,
  mobile: true,
});

const waitReady = async () => {
  for (let i = 0; i < 80; i += 1) {
    if ((await evaluate(cdp, "document.body.dataset.demoReady === 'true'")) === true) return true;
    await sleep(100);
  }
  return false;
};

if ((await waitReady()) !== true) {
  console.error('demo 未就绪');
  process.exit(2);
}
await sleep(400);

const framesDir = join(OUT, 't15.6-voice');
mkdirSync(framesDir, { recursive: true });
const results = [];
const hashes = [];

async function frame(name) {
  const path = join(framesDir, `${name}.png`);
  const hash = await shot(cdp, path);
  hashes.push(hash);
  return path;
}

/** 读页面上的语音相关事实（所有路径共用一份探针，避免各写一套） */
const PROBE = `(() => {
  const ids = window.tcsDemo.voiceMounts;
  const list = document.getElementById('msglist');
  const card = document.getElementById(ids.confirm);
  const q = (sel, root) => (root || document).querySelector(sel);
  const box = (el) => (el ? (() => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; })() : null);

  const msgs = list ? [...list.querySelectorAll('.nb-msg')] : [];
  const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
  const lastBar = last ? last.querySelector('[data-role="voice-bubble"]') : null;
  const lastBubble = last ? last.querySelector('.nb-bubble') : null;

  /* 顺序：语音气泡必须在文字气泡之前 */
  const order = last
    ? (() => {
        const kids = [...(last.firstElementChild ? last.firstElementChild.children : [])];
        return kids.map((k) => k.className);
      })()
    : null;

  return {
    stage: window.__v ? window.__v.state().stage : null,
    msgCount: msgs.length,
    lastMsgIsVoice: last ? last.querySelector('[data-role="voice-bubble"]') !== null : null,
    lastVoiceBarBox: box(lastBar),
    lastVoiceBarAria: lastBar ? lastBar.getAttribute('aria-label') : null,
    lastVoiceBarDur: lastBar ? (lastBar.querySelector('.nb-voice-bubble-dur') || {}).textContent : null,
    lastVoiceBarButtons: lastBar ? lastBar.querySelectorAll('button').length : null,
    /* ★ 关键：音频条必须在文字气泡之前（"语音气泡下是识别文字"） */
    lastMsgChildOrder: order,
    lastMsgText: last ? (last.querySelector('.nb-bubble') || {}).textContent : null,
    cardHidden: card ? card.hidden : null,
    /* 取消态是否反映在按钮与提示上 */
    bigmicCancelling: (() => {
      const b = document.getElementById(ids.bigmic);
      return b ? b.getAttribute('data-cancelling') : null;
    })(),
    hint: (() => {
      const h = q('[data-role="voice-stage-hint"]');
      return h ? { text: h.textContent, state: h.getAttribute('data-state') } : null;
    })(),
    overflow: card
      ? [...card.querySelectorAll('*')]
          .filter((el) => getComputedStyle(el).display !== 'none')
          .map((el) => {
            const b = el.getBoundingClientRect();
            return { cls: el.className || el.tagName, left: Math.round(b.left), right: Math.round(b.right) };
          })
          .filter((r) => r.left < -0.5 || r.right > window.innerWidth + 0.5)
      : null,
  };
})()`;

const probe = () => evaluate(cdp, PROBE);

await evaluate(cdp, 'window.__v = window.tcsDemo.voice()');

/* ═══════════════════════════════════════════════════════════
   路径 1：默认（二次确认关）→ 按住 → 松手 → 直接发出
   ═══════════════════════════════════════════════════════════ */

await evaluate(cdp, 'window.__v.enter()');
await sleep(200);
await frame('00-voice-idle');

const idleFacts = await probe();
results.push(`语音态 → ${JSON.stringify({ hint: idleFacts.hint, bigmicCancelling: idleFacts.bigmicCancelling })}`);

const before = await probe();
await evaluate(cdp, 'window.__v.press()');
await sleep(120);

// 连抓几帧证明波形在动
for (let i = 0; i < 4; i += 1) {
  await frame(`01-recording-${i}`);
  await sleep(130);
}

const recordingFacts = await probe();
results.push(`录音中 → ${JSON.stringify({ stage: recordingFacts.stage, hint: recordingFacts.hint })}`);

await evaluate(cdp, 'window.__v.release()');
await sleep(600);
await frame('02-sent-direct');

const afterDirect = await probe();
results.push(`默认直发后 → ${JSON.stringify(afterDirect)}`);

results.push(
  afterDirect.msgCount === before.msgCount + 1
    ? `✔ 默认路径确实直接发出了（消息 ${before.msgCount} → ${afterDirect.msgCount}）`
    : `✘ 默认路径没有发出消息（${before.msgCount} → ${afterDirect.msgCount}）`,
);
results.push(
  afterDirect.cardHidden === true
    ? '✔ 默认路径不该出现草稿卡（它就是直接发）'
    : `✘ 默认路径出现了草稿卡：cardHidden=${afterDirect.cardHidden}`,
);
results.push(
  afterDirect.lastMsgIsVoice === true
    ? '✔ 发出的消息带语音气泡'
    : `✘ 发出的消息没有语音气泡：${JSON.stringify(afterDirect.lastMsgChildOrder)}`,
);

/* ═══════════════════════════════════════════════════════════
   路径 2：下滑取消 → 不发、不转写
   ═══════════════════════════════════════════════════════════ */

const beforeCancel = await probe();
await evaluate(cdp, 'window.__v.press()');
await sleep(150);
await evaluate(cdp, 'window.__v.slideDown()');
await sleep(200);
await frame('03-cancel-armed');

const armed = await probe();
results.push(`下滑到取消区 → ${JSON.stringify({ hint: armed.hint, bigmic: armed.bigmicCancelling })}`);
results.push(
  armed.bigmicCancelling === 'true' && armed.hint?.state === 'cancel'
    ? '✔ 取消态反映在按钮与提示上（用户看得见"松手就取消"）'
    : `✘ 取消态没反映出来：bigmic=${armed.bigmicCancelling} hint=${JSON.stringify(armed.hint)}`,
);

await evaluate(cdp, 'window.__v.release()');
await sleep(500);
await frame('04-cancelled');

const afterCancel = await probe();
results.push(`取消后 → ${JSON.stringify({ stage: afterCancel.stage, msgCount: afterCancel.msgCount, hint: afterCancel.hint })}`);
results.push(
  afterCancel.msgCount === beforeCancel.msgCount
    ? `✔ 取消没有产生消息（仍是 ${afterCancel.msgCount} 条）`
    : `✘ 取消竟然发出了消息（${beforeCancel.msgCount} → ${afterCancel.msgCount}）`,
);
results.push(
  afterCancel.stage === 'idle' && afterCancel.bigmicCancelling === 'false'
    ? '✔ 取消后回到 idle，按钮退出取消态'
    : `✘ 取消后状态没复位：stage=${afterCancel.stage} bigmic=${afterCancel.bigmicCancelling}`,
);

/* ── 滑回来再松手 → 应当正常发送（不是取消） ── */

const beforeBack = await probe();
await evaluate(cdp, 'window.__v.press()');
await sleep(150);
await evaluate(cdp, 'window.__v.slideDown()');
await sleep(150);
const midArmed = await probe();
await evaluate(cdp, 'window.__v.slideBack()');
await sleep(150);
const backArmed = await probe();
await frame('05-slide-back');

results.push(
  midArmed.bigmicCancelling === 'true' && backArmed.bigmicCancelling === 'false'
    ? '✔ 滑回起点后退出取消态（可以反悔）'
    : `✘ 滑回后仍停在取消态：${midArmed.bigmicCancelling} → ${backArmed.bigmicCancelling}`,
);

await evaluate(cdp, 'window.__v.release()');
await sleep(600);
const afterBack = await probe();
results.push(
  afterBack.msgCount === beforeBack.msgCount + 1
    ? `✔ 滑回后松手正常发送（${beforeBack.msgCount} → ${afterBack.msgCount}）`
    : `✘ 滑回后没有发送（${beforeBack.msgCount} → ${afterBack.msgCount}）`,
);

/* ═══════════════════════════════════════════════════════════
   路径 3：打开二次确认 → 草稿卡 → 就地编辑 → 确认
   ═══════════════════════════════════════════════════════════ */

await evaluate(cdp, 'window.__v.setConfirm(true)');
await evaluate(cdp, 'window.__v.press()');
await sleep(150);
await evaluate(cdp, 'window.__v.moveTo(1)'); // 上滑到「内心/动作」
await sleep(160);
await frame('06-mode-inner');
await evaluate(cdp, 'window.__v.release()');
await sleep(600);
await frame('07-draft-card');

const cardFacts = await probe();
results.push(`确认开 → 草稿卡 → ${JSON.stringify(cardFacts)}`);
results.push(
  cardFacts.cardHidden === false
    ? '✔ 确认开时停在草稿卡（没有直接发出去）'
    : `✘ 确认开时草稿卡没出现：cardHidden=${cardFacts.cardHidden}`,
);
{
  const bad = cardFacts.overflow ?? [];
  results.push(
    bad.length === 0
      ? '✔ 草稿卡内无元素溢出视口'
      : `✘ 这些元素溢出了视口 → ${JSON.stringify(bad)}`,
  );
}

await evaluate(cdp, 'window.__v.edit()');
await sleep(200);
await frame('08-editing');
await evaluate(cdp, "window.__v.type('我改成了这句')");
await sleep(150);
await frame('09-edited');

const beforeConfirm = await probe();
await evaluate(cdp, 'window.__v.confirm()');
await sleep(600);
await frame('10-after-confirm');

const afterConfirm = await probe();
results.push(`确认后 → ${JSON.stringify(afterConfirm)}`);
results.push(
  afterConfirm.cardHidden === true && afterConfirm.msgCount === beforeConfirm.msgCount + 1
    ? '✔ 确认后草稿消失、消息流多一条'
    : `✘ 确认后不对：cardHidden=${afterConfirm.cardHidden} msg=${beforeConfirm.msgCount}→${afterConfirm.msgCount}`,
);
results.push(
  afterConfirm.lastMsgIsVoice === true
    ? '✔ 确认后那条消息同样是「语音气泡 + 下方文字」'
    : `✘ 确认后那条消息没有语音气泡：${JSON.stringify(afterConfirm.lastMsgChildOrder)}`,
);

/* ═══════════════════════════════════════════════════════════
   通用判据
   ═══════════════════════════════════════════════════════════ */

const unique = new Set(hashes).size;
results.push(
  unique >= 6
    ? `✔ 画面在变：${hashes.length} 帧里有 ${unique} 个不同画面`
    : `✘ 画面没变：${hashes.length} 帧只有 ${unique} 个不同画面`,
);

/* 语音气泡的结构自证：音频条在文字之前、▶ 不是按钮 */
if (afterDirect.lastMsgChildOrder !== null) {
  const order = afterDirect.lastMsgChildOrder;
  const barIdx = order.indexOf('nb-voice-bubble');
  const bubbleIdx = order.indexOf('nb-bubble');
  results.push(
    barIdx >= 0 && bubbleIdx >= 0 && barIdx < bubbleIdx
      ? `✔ 语音气泡排在文字之前（child order: ${order.join(' / ')}）`
      : `✘ 顺序不对（child order: ${order.join(' / ')}）`,
  );
}
results.push(
  afterDirect.lastVoiceBarButtons === 0
    ? '✔ 语音气泡里没有按钮（不可播放，不暗示可点）'
    : `✘ 语音气泡里有 ${afterDirect.lastVoiceBarButtons} 个按钮`,
);

/* ── 写报告 ── */

const report = [
  '# T15.6 语音全链路录屏（headless Chrome 逐帧）',
  '',
  `生成时间：${new Date().toISOString()}`,
  '',
  '## 三条路径（2026-10-31 用户明确）',
  '',
  '1. **默认不二次确认** → 按住 → 松手 → **直接发送**，消息本身是「语音气泡 + 下方识别文字」',
  '2. **下滑取消** → 按住 → 下滑 → 松手 → 本次作废（不发、不转写、录音丢弃）',
  '3. **打开二次确认** → 按住 → 松手 → 草稿卡 → 就地编辑 → 确认后变成与路径 1 相同的消息',
  '',
  '## 判据',
  '',
  ...results.map((r) => `- ${r}`),
  '',
  '## 帧序列',
  '',
  `目录：\`${framesDir}\``,
  '',
  '- `00-voice-idle` —— 语音态（输入框与发送消失，80px 大圆居中，提示含"下滑取消"）',
  '- `01-recording-0..3` —— 按住后的波形（每帧 130ms）',
  '- `02-sent-direct` —— **默认路径松手后直接发出的消息**（语音气泡 + 文字）',
  '- `03-cancel-armed` —— 下滑超过阈值，按钮变暗、提示变成「松开 取消」',
  '- `04-cancelled` —— 松手后回到 idle，没有新消息',
  '- `05-slide-back` —— 滑回起点，退出取消态（可以反悔）',
  '- `06-mode-inner` —— 上滑到「内心/动作」，chips 高亮',
  '- `07-draft-card` —— 二次确认开时的草稿卡',
  '- `08-editing` —— 点文字就地变 textarea',
  '- `09-edited` —— 改完的文字',
  '- `10-after-confirm` —— 确认后草稿消失，消息流多一条语音消息',
  '',
  '## 这份证据能证明什么、不能证明什么',
  '',
  '**能**：三条路径的分岔点正确、消息形态是「语音气泡 + 文字」、下滑取消真的不发送不转写、',
  '取消态在界面上可见、滑回能反悔、草稿卡无元素溢出视口。',
  '',
  '**不能**：真麦克风的录音质量、真实 ASR 的识别准确度、系统级手势冲突（尤其"下滑"与',
  'Android 通知栏下拉、iOS 主屏手势的争抢）—— 这三样都需要真机。',
  '另外语音气泡**不可播放**（消息里没有音频数据），它只是"这是语音"的视觉标识。',
].join('\n');

writeFileSync(join(WORK, 'voice-report.md'), report);
console.log(report);

/*
 * ★ 必须显式退出：CDP 的 WebSocket 一直开着会把事件循环钉住，
 * 进程已跑完却不退出 ⇒ 外层超时杀掉 ⇒ stdout 有缓冲拿不到 ⇒
 * 看起来像"一句话都没输出就失败了"。
 */
try {
  cdp.ws.close();
} catch {
  /* 关不掉也无所谓，下面照样退出 */
}
process.exit(0);
