/**
 * F5 新建角色卡对话框：尺寸测量 + 截图（1920 宽屏）。
 *
 * 判据用**实测数值**而不是"看起来舒服"：对话框宽度、输入框高度、
 * 说明文字行高、内容区内边距，四个数值都来自 getComputedStyle /
 * getBoundingClientRect，比截图更能说明问题（截图只作交付证据）。
 *
 * 用法：node scripts/shot-newcard.mjs <输出前缀> [宽度]
 *   例：node scripts/shot-newcard.mjs before 1920
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, '.verify', 'f5');
const PREFIX = process.argv[2] ?? 'shot';
const WIDTH = Number(process.argv[3] ?? 1920);
const PORT = 9333;

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }
  connect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => res());
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(String(e.data));
        if (m.id !== undefined && this.pending.has(m.id)) {
          const { resolve: r, reject: j } = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) j(new Error(JSON.stringify(m.error)));
          else r(m.result);
        }
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
          rej(new Error(method + ' 超时'));
        }
      }, 20000);
    });
  }
  close() {
    this.ws?.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('8899'));
  if (!page) throw new Error('没找到 8899 页面');

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // 1920 宽屏 + 2x 缩放（1x 看不清细线）
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: 1080,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1600);

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面脚本报错：' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    return r.result.value;
  };

  for (let i = 0; i < 60; i += 1) {
    if (await evaluate(`(() => { const s = document.querySelector('#status'); return !!s && !s.textContent.includes('初始化'); })()`)) break;
    await sleep(200);
  }

  // 关掉可能残留的弹窗，再打开新建卡对话框
  await evaluate(`(() => {
    for (const o of document.querySelectorAll('.modal-overlay')) o.hidden = true;
    document.querySelector('#btn-new').click();
    return true;
  })()`);
  for (let i = 0; i < 40; i += 1) {
    if (await evaluate(`(() => [...document.querySelectorAll('.modal-overlay')].some((o) => !o.hasAttribute('hidden') && o.textContent.includes('新建角色卡')))()`)) break;
    await sleep(100);
  }
  await sleep(400);

  const metrics = await evaluate(`(() => {
    const modal = document.querySelector('.new-card-modal');
    if (!modal) return { error: 'no-modal' };
    const body = modal.querySelector('.modal-body');
    const input = modal.querySelector('.input');
    const hint = modal.querySelector('.field-hint');
    const label = modal.querySelector('.field-label');
    const cs = (n) => n ? getComputedStyle(n) : null;
    const rect = (n) => n ? n.getBoundingClientRect() : null;
    const px = (v) => Math.round(parseFloat(v) * 100) / 100;
    const mr = rect(modal);
    return {
      viewport: { w: innerWidth, h: innerHeight },
      modal: { width: px(mr.width), height: px(mr.height) },
      bodyPadding: body ? {
        top: px(cs(body).paddingTop), right: px(cs(body).paddingRight),
        bottom: px(cs(body).paddingBottom), left: px(cs(body).paddingLeft),
      } : null,
      input: input ? { height: px(rect(input).height), fontSize: cs(input).fontSize, padding: cs(input).padding } : null,
      hint: hint ? { lineHeight: cs(hint).lineHeight, fontSize: cs(hint).fontSize } : null,
      label: label ? { fontSize: cs(label).fontSize } : null,
      // 说明文字有多少行（行高 × 行数 ≈ 实际高度）
      hintRect: rect(hint) ? { h: px(rect(hint).height), w: px(rect(hint).width) } : null,
    };
  })()`);

  const clip = await evaluate(`(() => {
    const m = document.querySelector('.new-card-modal');
    const r = m.getBoundingClientRect();
    return { x: Math.round(r.x) - 12, y: Math.round(r.y) - 12, width: Math.round(r.width) + 24, height: Math.round(r.height) + 24 };
  })()`);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 2 } });
  writeFileSync(join(OUT, `${PREFIX}-1920.png`), Buffer.from(shot.data, 'base64'));

  // 整页也留一张，便于看对话框在页面里的比例
  const full = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${PREFIX}-1920-full.png`), Buffer.from(full.data, 'base64'));

  writeFileSync(join(OUT, `${PREFIX}-metrics.json`), `${JSON.stringify({ at: new Date().toISOString(), ...metrics }, null, 2)}\n`, 'utf8');

  console.log(`=== ${PREFIX} @ ${WIDTH}×1080 ===`);
  console.log(`对话框宽 ${metrics.modal.width}px × 高 ${metrics.modal.height}px`);
  console.log(`内容区内边距 ${JSON.stringify(metrics.bodyPadding)}`);
  console.log(`输入框高 ${metrics.input.height}px（字号 ${metrics.input.fontSize}）`);
  console.log(`说明文字行高 ${metrics.hint.lineHeight}（字号 ${metrics.hint.fontSize}，占 ${metrics.hintRect.h}px）`);

  cdp.close();
};

main().catch((err) => {
  console.error('✘ 截图失败：' + String(err?.message ?? err));
  process.exit(1);
});
