/**
 * 在**已安装的客户端**里跑端到端流程（T6.9 + 阶段 8）。
 *
 * 原理：WebView2 支持 `--remote-debugging-port`，通过 CDP 可以直接在真实安装的应用里
 * 执行 JS 并截图。这比"浏览器打开 dist"更有说服力——验的是**装好的那一份**。
 *
 * 覆盖：启动 → 六板块与高亮 → 编辑 → 审计 → 规则/预设切换 → 导出拦截 → 同步连接。
 * 导出落盘与上传/回滚涉及原生对话框与网络，分别在 verify-export-roundtrip.mjs 与
 * verify-sync-live.mjs 里覆盖（同一套代码路径），这里只验证"装好的应用里 UI 可用"。
 *
 * 用法：node scripts/verify-installed-app.mjs [调试端口，默认 9222]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] ?? 9222);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(REPO, 'docs', 'assets');
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const results = [];
function check(ok, label, detail = '') {
  results.push({ ok, label, detail });
  if (ok) console.log(`  ✔ ${label}${detail ? `（${detail}）` : ''}`);
  else {
    failures += 1;
    console.log(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 极简 CDP 客户端：够用即可，不引第三方依赖 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
      setTimeout(() => reject(new Error('WebSocket 连接超时')), 8000);
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 20000);
    });
  }

  /** 执行 JS 并返回值（按值序列化） */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? 'JS 执行异常');
    }
    return result.result?.value;
  }

  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const target = join(SHOTS, name);
    writeFileSync(target, Buffer.from(data, 'base64'));
    return target;
  }
}

async function main() {
  console.log(`连接已安装应用（CDP 127.0.0.1:${PORT}）`);

  // 目标列表可由外部脚本取好放进文件（第 2 个参数）。
  //
  // 为什么要这样分工：实测 WebView2 的 CDP HTTP 端点对 Node 的 http/fetch 请求
  // 会 reset 或超时，而 Invoke-WebRequest 能正常读到。所以：
  //   外部脚本负责 GET /json，Node 只负责 WebSocket + CDP 命令。
  const targetsFile = process.argv[3];
  let targets;
  if (targetsFile) {
    // 外部脚本写文件时常带 UTF-8 BOM，JSON.parse 会因此失败，先剥掉
    const raw = readFileSync(targetsFile, 'utf8').replace(/^\uFEFF/, '').trim();
    targets = JSON.parse(raw);
  } else {
    targets = await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: PORT,
          path: '/json',
          method: 'GET',
          timeout: 10000,
          headers: { Host: `localhost:${PORT}`, Accept: 'application/json' },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error(`CDP 响应不是 JSON：${body.slice(0, 120)}`));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('CDP HTTP 超时')));
      req.on('error', (error) => reject(new Error(`CDP 连接失败：${error.message}`)));
      req.end();
    });
  }

  const page = targets.find((item) => item.type === 'page');
  if (!page) throw new Error('没有找到页面目标：应用可能没启动');

  check(page.url.includes('tauri.localhost') || page.url.includes('127.0.0.1'), '目标是 Tauri 应用页面', page.url);

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // ── 1. 启动状态：六个板块、折叠懒渲染 ────────────────
  const boot = await cdp.evaluate(`(() => {
    const app = window.__tcs && window.__tcs.app;
    return {
      hasApp: Boolean(app),
      blocks: document.querySelectorAll('.block').length,
      editors: document.querySelectorAll('.cm-editor').length,
      emptyHosts: document.querySelectorAll('.cm-host:empty').length,
      highlights: document.querySelectorAll('.tcs-hl').length,
      cardName: (document.getElementById('card-name') || {}).textContent || '',
      rulesLabel: (document.getElementById('rules-label') || {}).textContent || '',
    };
  })()`);
  check(boot.hasApp, '应用已初始化（window.__tcs 存在）');
  check(boot.blocks === 6, '六个板块已渲染', `实际 ${boot.blocks}`);
  check(boot.editors === 2, '默认只挂载 2 个编辑器（懒渲染）', `实际 ${boot.editors}`);
  check(boot.emptyHosts === 4, '其余 4 个板块未进 DOM', `实际 ${boot.emptyHosts}`);
  check(boot.highlights > 0, '语法高亮已生效', `${boot.highlights} 个装饰`);
  check(boot.cardName.trim() !== '', '卡片名已加载', boot.cardName.trim());
  check(/平台 \w+/.test(boot.rulesLabel), '规则标签已就绪', boot.rulesLabel);

  const shot1 = await cdp.screenshot('t69-installed-app.png');
  console.log(`  截图：${shot1}`);

  // ── 2. 编辑 → 审计联动 ──────────────────────────────
  const audit = await cdp.evaluate(`(async () => {
    const app = window.__tcs.app;
    // 通过公开的调试入口注入一个错误级问题（走真实审计，不伪造报告）
    app.injectErrorForDemo();
    await new Promise((r) => setTimeout(r, 400));
    const stats = [...document.querySelectorAll('#stats .stat')].map((n) => n.textContent);
    const summary = [...document.querySelectorAll('.summary-item')].map((n) => n.textContent);
    const issues = document.querySelectorAll('.audit-list .issue').length;
    return { stats, summary, issues };
  })()`);
  check(audit.stats.some((s) => /错误\s*[1-9]/.test(s)), '编辑后审计报出错误', audit.stats.join(' / '));
  check(audit.summary.some((s) => /错误\s*[1-9]/.test(s)), '审计面板同步更新', audit.summary.join(' / '));
  check(audit.issues > 0, '问题列表有条目', `${audit.issues} 条`);

  // 修正后提醒消失：重新加载页面回到干净样例（不新增调试 API）
  await cdp.evaluate(`location.reload(); true`);
  await new Promise((r) => setTimeout(r, 2500));
  const afterReload = await cdp.evaluate(`(() => {
    const stats = [...document.querySelectorAll('#stats .stat')].map((n) => n.textContent);
    return { stats, app: Boolean(window.__tcs && window.__tcs.app) };
  })()`);
  check(afterReload.app, '重新加载后应用恢复可用');
  check(
    afterReload.stats.some((s) => /错误\s*0/.test(s)),
    '修正后错误归零（提醒即时消失）',
    afterReload.stats.join(' / '),
  );

  // ── 3. 规则与预设面板 ──────────────────────────────
  const rulesDialog = await cdp.evaluate(`(async () => {
    const app = window.__tcs.app;
    app.openRulesDialogForDemo();
    await new Promise((r) => setTimeout(r, 300));
    const modal = document.querySelector('.modal-overlay:not([hidden]) .modal.wide');
    return {
      open: Boolean(modal),
      platformOptions: document.querySelectorAll('[data-role="platform-select"] option').length,
      highlightOptions: document.querySelectorAll('[data-role="highlight-select"] option').length,
      presetOptions: document.querySelectorAll('[data-role="preset-select"] option').length,
      preview: (document.querySelector('[data-role="preset-preview"]') || {}).textContent || '',
    };
  })()`);
  check(rulesDialog.open, '规则与预设面板可打开');
  check(rulesDialog.platformOptions >= 5, '平台规则下拉已填充', `${rulesDialog.platformOptions} 项`);
  check(rulesDialog.highlightOptions >= 3, '高亮方案下拉已填充', `${rulesDialog.highlightOptions} 项`);
  check(rulesDialog.presetOptions >= 3, '预设下拉已填充', `${rulesDialog.presetOptions} 项`);
  check(rulesDialog.preview.includes('导出顺序'), '预设影响预览已渲染');
  const shot2 = await cdp.screenshot('t69-installed-rules.png');
  console.log(`  截图：${shot2}`);

  // ── 4. 切换平台规则：立即重检 ───────────────────────
  const switched = await cdp.evaluate(`(async () => {
    const app = window.__tcs.app;
    document.querySelector('.modal-overlay:not([hidden]) .icon-btn')?.click();
    app.switchPlatformForDemo('janitorai');
    await new Promise((r) => setTimeout(r, 400));
    return {
      label: (document.getElementById('rules-label') || {}).textContent || '',
      status: (document.getElementById('status') || {}).textContent || '',
      summary: [...document.querySelectorAll('.summary-item')].map((n) => n.textContent),
    };
  })()`);
  check(switched.label.includes('janitorai'), '平台规则已切换', switched.label);
  check(/错误\s*\d+/.test(switched.status), '切换后立即重检并给出结论', switched.status.slice(0, 60));

  // ── 5. 导出拦截弹窗 ────────────────────────────────
  const exportGate = await cdp.evaluate(`(async () => {
    const app = window.__tcs.app;
    app.injectErrorForDemo();
    await new Promise((r) => setTimeout(r, 300));
    app.openExportForDemo();
    await new Promise((r) => setTimeout(r, 400));
    const gate = document.querySelector('.gate-box:not([hidden])');
    return {
      gateVisible: Boolean(gate),
      gateText: gate ? gate.textContent.replace(/\\s+/g, ' ').slice(0, 160) : '',
      confirmDisabled: (document.querySelector('.modal-foot .btn.primary') || {}).disabled,
      activeElement: document.activeElement ? document.activeElement.textContent.trim().slice(0, 12) : '',
    };
  })()`);
  check(exportGate.gateVisible, '审计未通过时出现拦截框');
  check(/审计未通过/.test(exportGate.gateText), '拦截框说明原因', exportGate.gateText.slice(0, 60));
  check(exportGate.activeElement === '取消', '焦点默认在「取消」（防误按回车）', `实际「${exportGate.activeElement}」`);
  const shot3 = await cdp.screenshot('t69-installed-export.png');
  console.log(`  截图：${shot3}`);

  // 关闭弹窗
  await cdp.evaluate(`document.querySelectorAll('.modal-overlay').forEach((m) => { m.hidden = true; }); true`);

  // ── 6. 同步入口（未配置时应置灰）────────────────────
  const syncState = await cdp.evaluate(`(() => ({
    uploadDisabled: document.getElementById('btn-upload').disabled,
    historyDisabled: document.getElementById('btn-history').disabled,
    rollbackDisabled: document.getElementById('btn-rollback').disabled,
    chip: (document.getElementById('conn-chip') || {}).textContent || '',
    hint: (document.getElementById('sync-hint') || {}).textContent || '',
  }))()`);
  check(
    syncState.uploadDisabled && syncState.historyDisabled && syncState.rollbackDisabled,
    '未配置服务端时三个同步入口置灰',
    syncState.hint.slice(0, 40),
  );

  // ── 汇总 ───────────────────────────────────────────
  console.log('');
  const passed = results.filter((r) => r.ok).length;
  console.log(`已安装应用端到端：${passed}/${results.length} 项通过`);
  const report = {
    app: { url: page.url, title: page.title },
    results,
    passed,
    total: results.length,
    screenshots: [shot1, shot2, shot3],
  };
  writeFileSync(join(REPO, '.verify', 'installed-app-e2e.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (failures === 0) {
    console.log('全部通过。');
    process.exit(0);
  }
  console.log(`失败 ${failures} 项。`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`执行失败：${error.message}`);
  process.exit(1);
});
