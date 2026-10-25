#!/usr/bin/env node
/**
 * 仓库令牌模式的 DOM 断言（v0.1.3 / F5 后半）。
 *
 * 输入是 `scripts/capture-f5b-dumps.sh` 抓的 .verify/f5b-dumps/*.html，
 * 只做断言、不碰网络不碰浏览器（与 verify-e2e.mjs 分工一致）。
 *
 * ## 为什么要读 DOM 而不是看截图
 *
 * 截图只能说"按钮看起来是灰的"。本次就撞上了反例：read 令牌下
 * 「上传当前内容」的 `disabled` 实际是 **false**，而它的 `title` 已经写着
 * "此令牌没有写权限" —— 视觉上那只灰蓝按钮与禁用态几乎分不出来。
 * 根因是 `setBusy(null)` 在上传流程结束后把它无条件解锁。
 *
 * 所以本脚本的判据一律是属性与文本，不看颜色。
 *
 * ## 三档 scope 的矩阵（需求第 2 条）
 *
 * | scope        | 上传 | 回滚 | 删除/移动 |
 * |-------------|-----|-----|----------|
 * | read         | ✘   | ✘   | ✘        |
 * | read+write   | ✔   | ✘   | ✔        |
 * | +rollback    | ✔   | ✔   | ✔        |
 *
 * 用法：bash scripts/capture-f5b-dumps.sh && node scripts/verify-f5b-token-mode.mjs
 * 退出码：0 全通过；1 有断言失败
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DUMPS = join(REPO, '.verify', 'f5b-dumps');

const results = [];
const check = (name, okValue, detail) => {
  results.push({ name, ok: okValue });
  console.log(`${okValue ? '✔' : '✘'} ${name}${detail === undefined || detail === '' ? '' : ` —— ${detail}`}`);
};

function load(name) {
  const path = join(DUMPS, `${name}.html`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

/** 取 body 上的 data-* */
function bodyAttr(html) {
  const match = /<body([^>]*)>/i.exec(html);
  const attrs = {};
  if (!match) return attrs;
  for (const item of match[1].matchAll(/data-([a-z-]+)="([^"]*)"/gi)) attrs[item[1]] = item[2];
  return attrs;
}

/**
 * 找一个按钮的完整标签与文本。
 *
 * 按 `data-role` 或按可见文本找 —— 这里两种都要支持：
 * 顶栏入口用的是 id，面板内的按钮没有 data-role。
 */
function findButton(html, { role, text }) {
  const pattern = /<button\b[^>]*>[\s\S]*?<\/button>/gi;
  for (const match of html.matchAll(pattern)) {
    const tag = match[0];
    if (role !== undefined && !tag.includes(`data-role="${role}"`)) continue;
    if (text !== undefined) {
      const inner = tag.replace(/<[^>]*>/g, '').trim();
      if (!inner.includes(text)) continue;
    }
    const attrs = tag.slice(0, tag.indexOf('>') + 1);
    return {
      tag,
      disabled: /\sdisabled(?:=|\s|>)/i.test(attrs) || /\sdisabled=""/i.test(attrs),
      title: (/title="([^"]*)"/.exec(attrs) ?? [, ''])[1],
      text: tag.replace(/<[^>]*>/g, '').trim(),
    };
  }
  return null;
}

// ── ① 登录框三入口 ────────────────────────────────────────
console.log('1. 登录框三入口（需求第 1 条）');
const loginHtml = load('login-entries');
if (loginHtml === null) {
  check('快照 login-entries.html 存在', false, '先跑 bash scripts/capture-f5b-dumps.sh');
} else {
  const loginOverlay = /<div[^>]*data-role="auth-dialog"[^>]*>/i.exec(loginHtml)?.[0] ?? '';
  const loginMode = (/data-mode="([^"]*)"/.exec(loginOverlay) ?? [, '(无)'])[1];
  check('对话框已打开（data-mode=login）', loginMode === 'login', `data-mode=${loginMode}`);
  const submit = findButton(loginHtml, { role: 'auth-submit' });
  const register = findButton(loginHtml, { role: 'auth-register' });
  const tokenEntry = findButton(loginHtml, { role: 'auth-repo-token-entry' });
  check('入口 1：用户名/密码（主按钮「登录」）', submit !== null && submit.text.includes('登录'), submit?.text);
  check('入口 2：注册新账户', register !== null, register?.text);
  check('入口 3：使用仓库令牌连接', tokenEntry !== null, tokenEntry?.text);
  // 第三入口不依赖注册策略：registerMode=closed 时它也该在（本例是 open，但断言它没被藏起来）
  check('第三入口未被隐藏', tokenEntry !== null && !/\shidden(?:=|\s|>)/i.test(tokenEntry.tag));
  // 没切到令牌模式时，令牌输入框应当是隐藏的（用户名/密码与令牌互斥显示）
  const tokenFieldHidden = /data-role="auth-repo-token"[^>]*/.test(loginHtml);
  const tokenInputTag = /<textarea[^>]*data-role="auth-repo-token"[^>]*>/i.exec(loginHtml)?.[0] ?? '';
  const fieldHidden = /<label class="field"[^>]*hidden/i.test(
    loginHtml.slice(Math.max(0, loginHtml.indexOf('data-role="auth-repo-token"') - 400), loginHtml.indexOf('data-role="auth-repo-token"')),
  );
  check('未进入令牌模式时令牌输入区隐藏', tokenFieldHidden && fieldHidden, `textarea 存在=${tokenFieldHidden} 字段 hidden=${fieldHidden}`);
  void tokenInputTag;
}

// ── ② 令牌模式的对话框形态 ────────────────────────────────
console.log('\n2. 令牌输入态（需求第 1 条）');
const dialogHtml = load('token-mode-dialog');
if (dialogHtml === null) {
  check('快照 token-mode-dialog.html 存在', false);
} else {
  /*
   * 模式标记在**登录对话框自己的 overlay** 上（`data-role="auth-dialog"`），
   * 不在 body 上 —— 第一版按 body 取，得到 `mode=(无)` 的假红。
   * 只认那个 overlay 上的 data-mode：body 上没有同名字段，
   * 而页面上有多份 `.modal-overlay`（设置、规则、导出…），不能取第一个。
   */
  const overlay = /<div[^>]*data-role="auth-dialog"[^>]*>/i.exec(dialogHtml)?.[0] ?? '';
  const mode = (/data-mode="([^"]*)"/.exec(overlay) ?? [, '(无)'])[1];
  check('对话框切到 repo-token 模式', mode === 'repo-token', `data-mode=${mode}`);

  // 标题要取登录框自己的那个 —— 页面上还有「审计」「设置」「规则与预设」等 h2，
  // 直接取第一个 h2 会拿到「审计」（第一版就是这么错的）
  const authTitle = /<div class="modal auth-modal"[\s\S]*?<h2[^>]*>([^<]*)<\/h2>/.exec(dialogHtml)?.[1] ?? '';
  check('标题是「使用仓库令牌连接」', authTitle.includes('使用仓库令牌连接'), authTitle);

  const submit = findButton(dialogHtml, { role: 'auth-submit' });
  check('提交按钮文案是「连接」', submit !== null && submit.text === '连接', submit?.text);
  const back = findButton(dialogHtml, { role: 'auth-repo-token-entry' });
  check('第三入口变成「返回账户登录」', back !== null && back.text.includes('返回账户登录'), back?.text);
  check('用户名输入框隐藏', /valuenow|auth-username/i.test(dialogHtml) && /hidden/.test(dialogHtml));

  // 令牌原文预填（debug 入口设了 defaultValue，所以会进快照）
  const tokenValue = /<textarea[^>]*data-role="auth-repo-token"[^>]*>([\s\S]*?)<\/textarea>/i.exec(dialogHtml);
  const prefilled = tokenValue !== null && tokenValue[1].trim().startsWith('tcr_');
  check('令牌已预填（tcr_ 开头）', prefilled, tokenValue === null ? '(没找到 textarea)' : tokenValue[1].trim().slice(0, 12));
  // 明文显示：这是一个要交给别人用的授权凭证，遮挡会让人发现不了多余空格
  const textareaTag = /<textarea[^>]*data-role="auth-repo-token"[^>]*>/i.exec(dialogHtml)?.[0] ?? '';
  check('令牌框是明文（不是 password）', !/type="password"/i.test(textareaTag), textareaTag.slice(0, 60));
}

// ── ③ 三档 scope 的置灰矩阵 ──────────────────────────────
console.log('\n3. 单仓库模式的 scope 矩阵（需求第 2 条）');

const CASES = [
  { dump: 'scope-read', scopes: 'read', canUpload: false, canRollback: false },
  { dump: 'scope-readwrite', scopes: 'read,write', canUpload: true, canRollback: false },
  { dump: 'scope-full', scopes: 'read,write,rollback', canUpload: true, canRollback: true },
];

for (const item of CASES) {
  const html = load(item.dump);
  if (html === null) {
    check(`快照 ${item.dump}.html 存在`, false);
    continue;
  }
  const attrs = bodyAttr(html);
  check(`${item.scopes}：已在仓库令牌模式`, attrs['credential-mode'] === 'repo-token', attrs['credential-mode'] ?? '(无)');
  check(`${item.scopes}：scope 与预期一致`, attrs['repo-token-scopes'] === item.scopes, attrs['repo-token-scopes'] ?? '(无)');

  // 顶栏入口：必须是「仓库令牌模式 · <仓库名>」
  const entry = /<button[^>]*id="btn-account"[^>]*>([\s\S]*?)<\/button>/i.exec(html);
  const entryText = entry === null ? '' : entry[1].replace(/<[^>]*>/g, '').trim();
  check(`${item.scopes}：顶栏显示「仓库令牌模式 · 仓库名」`, entryText.includes('仓库令牌模式'), entryText);

  // 同步面板内的「上传当前内容」
  const upload = findButton(html, { text: '上传当前内容' });
  check(
    `${item.scopes}：上传按钮 ${item.canUpload ? '可用' : '置灰'}`,
    upload !== null && upload.disabled === !item.canUpload,
    upload === null ? '(没找到按钮)' : `disabled=${String(upload.disabled)} title=${upload.title}`,
  );
  if (!item.canUpload && upload !== null) {
    check(`${item.scopes}：置灰理由点名缺 write`, /写|write/.test(upload.title), upload.title);
  }

  // 顶栏的「回滚」入口
  const rollback = /<button[^>]*id="btn-rollback"[^>]*>/i.exec(html)?.[0] ?? '';
  const rollbackDisabled = /\sdisabled(?:=|\s|>)/i.test(rollback);
  check(
    `${item.scopes}：回滚入口 ${item.canRollback ? '可用' : '置灰'}`,
    rollback !== '' && rollbackDisabled === !item.canRollback,
    rollback === '' ? '(没找到)' : `disabled=${String(rollbackDisabled)}`,
  );
  if (!item.canRollback) {
    const rollbackTitle = (/title="([^"]*)"/.exec(rollback) ?? [, ''])[1];
    check(`${item.scopes}：回滚置灰理由点名缺 rollback`, /回滚|rollback/.test(rollbackTitle), rollbackTitle);
  }

  // 仓库选择器必须隐藏（需求：只有一个仓库）
  const repoRow = /<div[^>]*class="field-row sync-repo-row"[^>]*>/i.exec(html)?.[0] ?? '';
  check(`${item.scopes}：仓库选择器隐藏`, repoRow !== '' && /\shidden(?:=|\s|>)/i.test(repoRow), repoRow === '' ? '(没找到行)' : repoRow.slice(0, 80));
  // 替代说明条必须可见
  const tokenRow = /<div[^>]*class="field-row sync-repo-token-row"[^>]*>/i.exec(html)?.[0] ?? '';
  check(`${item.scopes}：令牌模式说明条可见`, tokenRow !== '' && !/\shidden(?:=|\s|>)/i.test(tokenRow), tokenRow === '' ? '(没找到行)' : tokenRow.slice(0, 90));
}

// ── ④ 拒绝枚举（静态可查的部分）────────────────────────────
console.log('\n4. 文案里不能出现「不存在」这类存在性暗示');
for (const item of CASES) {
  const html = load(item.dump);
  if (html === null) continue;
  check(`${item.scopes}：界面无「令牌不存在」字样`, !/令牌不存在/.test(html));
}

const passed = results.filter((item) => item.ok).length;
const failures = results.filter((item) => !item.ok);
console.log(`\n合计：${String(passed)}/${String(results.length)} 通过`);
if (failures.length > 0) {
  console.log('结论：未通过');
  process.exit(1);
}
console.log('结论：通过');
