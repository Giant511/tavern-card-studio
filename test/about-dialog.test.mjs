/**
 * 「关于」区块的判据（2026-11-18，合规要求）。
 *
 * ## 守什么
 *
 * 用户要求：
 *
 * ```text
 * 桌面端  设置页最底部一行**蓝色文字**「关于」，点击弹窗，里面有版本号与源码地址
 * 安卓端  「我的」页底部左边一行**蓝色文字**「关于」，**不要收纳结构**，
 *         内容里必须有内置 SillyTavern 的源码地址（AGPL-3.0）
 * ```
 *
 * ## 这个文件最重要的一条：文案必须区分平台
 *
 * 桌面端**不内置** SillyTavern，安卓端内置。第一版我把两端写成同一份，
 * 桌面设置页里出现了「内置引擎源码」——那是**对桌面用户说假话**。
 * 所以下面有一条判据专门守"桌面端文案里不许提内置 ST"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  androidAbout,
  appSourceUrl,
  BUNDLED_SILLYTAVERN_VERSION,
  desktopAbout,
  releasePageUrl,
  sillytavernSourceUrl,
  sillytavernUpstreamTagUrl,
} from '../client/src/settings/about-info.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** 去掉注释再匹配（注释里会提到 SillyTavern，不能算用户可见文案） */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ═══════════════════════════════════════════════════════════
   ① 地址拼装
   ═══════════════════════════════════════════════════════════ */

test('★★★ 源码地址随版本变化（不是写死的某个版本）', () => {
  const a = appSourceUrl('0.2.0');
  const b = appSourceUrl('0.3.0');
  assert.notEqual(a, b, '两个版本的源码地址必须不同 —— 否则会指向别人的源码');
  assert.ok(a.includes('/tags/v0.2.0'), '必须带 v<版本>');
  assert.ok(a.endsWith('.zip'), '要指向可直接下载的 zip');
});

test('★★★ ST 源码地址指向本版 Release 资产（与 APK 同页）', () => {
  const url = sillytavernSourceUrl('0.2.0');
  assert.ok(url.includes('/releases/tag/v0.2.0'), '必须落在本版 Release 页');
  assert.ok(
    url.includes('sillytavern-' + BUNDLED_SILLYTAVERN_VERSION + '-source.zip'),
    '资产名要带 ST 版本号',
  );
});

test('★★★ 内置 ST 版本只声明一处（多处必然分叉）', () => {
  const src = read('client/src/settings/about-info.ts');
  const declared = [...src.matchAll(/BUNDLED_SILLYTAVERN_VERSION\s*=\s*'([^']+)'/g)];
  assert.equal(declared.length, 1, 'ST 版本只应有 1 处声明');
  assert.match(declared[0][1], /^\d+\.\d+\.\d+$/, 'ST 版本号格式不对');
});

test('★★ 兜底地址指向上游 tag', () => {
  const url = sillytavernUpstreamTagUrl('1.19.0');
  assert.ok(url.includes('github.com/SillyTavern/SillyTavern'), '兜底要指上游仓库');
  assert.ok(url.includes('/tree/v1.19.0'), '兜底要指到具体 tag');
});

/* ═══════════════════════════════════════════════════════════
   ② ★★★ 平台文案必须不同
   ═══════════════════════════════════════════════════════════ */

test('★★★ 桌面端文案不许**声称**内置 ST', () => {
  /*
   * 桌面端没有内置 SillyTavern —— 用户自己装、我们连它的 HTTP API，那是互操作。
   * 写成"内置引擎"会让桌面用户以为安装包里打了 ST，也会让人以为
   * 桌面 MSI 有 AGPL 义务（它没有）。
   *
   * ★ 判据不能只是 `/内置/`：桌面端那句「**不**内置 SillyTavern」是**正确**的
   *   （主动澄清反而更好），第一版判据把它判成了违规。
   *   要判的是"有没有**声称**内置"，即"内置"前面不是否定词。
   */
  const info = desktopAbout('0.2.0');
  const all = [info.summary, ...info.notes, ...info.links.map((l) => `${l.label} ${l.text} ${l.url}`)].join(
    '\n',
  );

  const claims = [...all.matchAll(/.{0,6}内置.{0,8}/g)].map((m) => m[0]);
  const claimsBuiltIn = claims.filter((c) => !/不内置|未内置|没有内置/.test(c));
  assert.deepEqual(claimsBuiltIn, [], '桌面端声称了「内置」：' + claimsBuiltIn.join(' / '));

  assert.ok(
    !/SillyTavern/.test(info.links.map((l) => l.url).join(' ')),
    '桌面端不许出现 SillyTavern 的源码链接（那会让人以为我们打包了它）',
  );
  // 但要把"怎么用 ST"说清，否则用户会以为不支持
  assert.match(info.notes.join(' '), /自行安装|自己装/, '桌面端要说明 ST 需要用户自己装');
});

test('★★★ 安卓端必须说明内置 ST 的 AGPL 义务', () => {
  const info = androidAbout('0.2.0');
  const all = [info.summary, ...info.notes].join('\n');

  assert.match(all, /内置/, '安卓端必须说"内置"（这才是实情）');
  assert.match(all, /AGPL-3\.0/, '必须写明 AGPL-3.0');
  assert.match(all, /SillyTavern/, '必须写明是 SillyTavern');
  assert.match(all, /未作修改|原样/, '必须说明未修改（这才只需指上游源码）');

  const urls = info.links.map((l) => l.url);
  assert.ok(
    urls.some((u) => u.includes('sillytavern-') && u.endsWith('.zip')),
    '必须给出 ST 源码 zip 的地址',
  );
  assert.ok(
    urls.some((u) => u.includes('github.com/SillyTavern/SillyTavern')),
    '必须给出上游兜底地址',
  );
});

test('★★ 两端都给出本应用源码与第三方声明', () => {
  for (const [label, info] of [
    ['桌面', desktopAbout('0.2.0')],
    ['安卓', androidAbout('0.2.0')],
  ]) {
    const urls = info.links.map((l) => l.url);
    assert.ok(
      urls.some((u) => u.includes('/archive/refs/tags/v0.2.0')),
      label + '端缺少本版源码地址',
    );
    assert.ok(
      urls.some((u) => u.includes('THIRD-PARTY-NOTICES')),
      label + '端缺少第三方声明链接',
    );
    assert.equal(info.version, '0.2.0');
  }
});

/* ═══════════════════════════════════════════════════════════
   ③ 桌面端接线
   ═══════════════════════════════════════════════════════════ */

test('★★★ 桌面设置页用 desktopAbout，且位于最后一个分区', () => {
  const src = read('client/src/settings/settings-dialog.ts');
  assert.match(src, /desktopAbout\(appVersion\(\)\)/, '桌面设置页必须用 desktopAbout');
  assert.ok(!/androidAbout/.test(stripComments(src)), '桌面设置页不许用 androidAbout');

  const flat = src.replace(/[\s\S]*?panel\.append\(([\s\S]*?)\);/, '$1').replace(/\s+/g, '');
  assert.ok(flat.includes('aboutSection'), 'panel.append 里必须有 aboutSection');
  assert.ok(
    flat.indexOf('aboutSection') > flat.indexOf('diagSection'),
    'aboutSection 要排在 diagSection 之后',
  );
  assert.ok(flat.indexOf('aboutSection') < flat.indexOf('foot'), 'aboutSection 要排在底部按钮之前');
});

test('★★★ 桌面「关于」入口是蓝字、无背景、无边框', () => {
  const css = read('client/src/styles.css');
  const block = /\.about-link\s*\{([^}]*)\}/.exec(css);
  assert.notEqual(block, null, '.about-link 样式必须存在');
  const body = block[1];
  assert.match(body, /color:\s*var\(--accent\)/, '必须是主题蓝');
  assert.match(body, /background:\s*none/, '不要背景（不要气泡）');
  assert.match(body, /border:\s*0/, '不要边框（不要按钮外壳）');
});

/* ═══════════════════════════════════════════════════════════
   ④ 安卓端接线
   ═══════════════════════════════════════════════════════════ */

test('★★★ 安卓「我的」页有关于入口，且用 androidAbout', () => {
  const src = read('client/src/chat/shell.ts');
  assert.match(src, /private renderAboutEntry\(\): ElLike/, 'renderAboutEntry 必须存在');
  assert.match(src, /androidAbout\(appVersion\(\)\)/, '安卓端必须用 androidAbout');
  assert.match(
    src,
    /this\.renderDiagSection\(\),\s*[\s\S]{0,400}this\.renderAboutEntry\(\),/,
    '关于要挂在诊断之后（页面最底部）',
  );
});

test('★★★ 安卓「关于」不许用收纳结构（用户明确要求）', () => {
  /*
   * 用户原话：「不要用收纳结构，直接像桌面端一样使用蓝色文字：关于，
   * 放在底部左边」。收纳项 = `.nb-section`（整宽点击行 + 折叠箭头 +
   * `renderAccordion`），视觉上像"又一个设置分组"，与"页脚"语义不符。
   */
  const src = read('client/src/chat/shell.ts');
  const start = src.indexOf('private renderAboutEntry(): ElLike {');
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf('private openAboutSheet(', start));

  assert.ok(!body.includes('nb-section'), '关于入口不许用 .nb-section（那是收纳项）');
  assert.ok(!body.includes('renderAccordion'), '关于入口不许走 renderAccordion');
  assert.match(body, /'nb-about'/, '要用独立的 .nb-about 容器');
  assert.match(body, /'nb-about-link'/, '要用独立的 .nb-about-link 文字样式');
});

test('★★★ 安卓「关于」是蓝/青色文字、靠左、有触控尺寸', () => {
  const css = read('client/src/chat/chat.css');

  const wrap = /\.nb-about\s*\{([^}]*)\}/.exec(css);
  assert.notEqual(wrap, null, '.nb-about 样式必须存在');
  assert.match(wrap[1], /justify-content:\s*flex-start/, '要靠左（用户要求"底部左边"）');

  const link = /\.nb-about-link\s*\{([^}]*)\}/.exec(css);
  assert.notEqual(link, null, '.nb-about-link 样式必须存在');
  assert.match(link[1], /color:\s*var\(--nb-nebula-b\)/, '要用移动端存在的强调色 token');
  assert.match(link[1], /background:\s*none/, '不要背景');
  assert.match(link[1], /border:\s*0/, '不要边框');
  assert.match(link[1], /min-height/, '触控目标不能太小');
});

test('★★★ 安卓端样式不许引用不存在的 token', () => {
  /*
   * 这个项目已经三次踩到"引用了不存在的 accent token"，CSS 不报错、
   * 只是颜色退化成继承值 —— 靠断言读属性抓不到，只能静态查。
   * 已知不存在：`--nb-accent`、`--nb-text-4`。
   */
  const css = read('client/src/chat/chat.css');
  const ours = css.slice(css.indexOf('「关于」（2026-11-18'));
  const withoutComments = stripComments(ours);
  const used = [...withoutComments.matchAll(/var\((--nb-[a-z0-9-]+)/g)].map((m) => m[1]);
  const tokens = read('client/src/chat/nebula-tokens.css') + css;

  const missing = [...new Set(used)].filter((v) => !new RegExp(v + '\\s*:').test(tokens));
  assert.deepEqual(missing, [], '引用了不存在的 token：' + missing.join(', '));
});

test('★★★ 安卓弹窗用真实存在的 nb-sheet 类（不许自造类名）', () => {
  /*
   * 第一版我凭印象写了 `.nb-modal-overlay` / `.nb-modal-*`，那套类在 CSS 里
   * 根本不存在。CSS 对未知类不报错，于是弹窗没有任何定位/遮罩/圆角 ——
   * 内容以裸流挤在页面底部，看起来像"点了没反应"。
   */
  const src = read('client/src/chat/shell.ts');
  const start = src.indexOf('private openAboutSheet(');
  const body = src.slice(start, start + 3000);
  const classes = [...body.matchAll(/'(nb-[a-z-]+)'/g)].map((m) => m[1]);
  const css = read('client/src/chat/chat.css');

  const unknown = [...new Set(classes)].filter(
    (c) => !new RegExp('\\.' + c + '[\\s,{:.]').test(css),
  );
  assert.deepEqual(unknown, [], '用了 CSS 里不存在的类名：' + unknown.join(', '));
});
