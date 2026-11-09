/**
 * 圆形头像与「导出为 PNG 分享」的判据（2026-11-04）。
 *
 * 用户要求：
 *
 * > 在仓库和角色选择里面支持显示角色缩略图，最好是圆形的，类似于头像的感觉，
 * > 支持将卡导出为PNG分享出来
 *
 * ## 这组判据守什么
 *
 * ```text
 *   只写 border-radius 不写 object-fit  → 竖图被圆角切成椭圆，不像头像
 *   <img src="http://127.0.0.1…">       → 这个壳里加载不出来（已实测）
 *   分享走 file://                      → Android 7+ 直接抛异常
 *   sharePng 接受路径参数               → 变成"往任意位置写文件"的通道
 * ```
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bytesToBase64, shareFileName } from '../client/src/chat/share-card.ts';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/* ═══════════════════════════════════════════════════════════
   一、圆形头像
   ═══════════════════════════════════════════════════════════ */

test('★★★ 头像必须是真圆：圆角 + cover + 裁切，三者缺一不可', () => {
  const css = read('client/src/chat/chat.css');
  const start = css.indexOf('.nb-avatar {');
  const end = css.indexOf('\n}', start);
  const block = css.slice(start, end);

  assert.ok(block.includes('border-radius: 50%'), '要圆角');
  assert.ok(block.includes('overflow: hidden'), '要裁切，否则图溢出圆外');
  /*
   * `width` / `height` + `object-fit: cover` 才是"圆"的关键：
   * 卡面常见 768×1024，只给圆角会切出一个**竖椭圆**。
   */
  assert.ok(block.includes('width: var(--nb-avatar-size'), '要固定宽');

  const imgStart = css.indexOf('.nb-avatar-img {');
  const imgEnd = css.indexOf('\n}', imgStart);
  const imgBlock = css.slice(imgStart, imgEnd);
  assert.ok(imgBlock.includes('object-fit: cover'), '必须 cover（contain 留黑边、默认拉伸变形）');
});

test('★★★ 头像不许用 <img src="http://…"> 直连回环', () => {
  /*
   * 真机实测：这个壳里 `<img>` 直连回环地址与 `fetch` 同一个根因失败
   * （performance 有记录但 transferSize=0）。必须走桥读字节转 data URL。
   */
  const raw = read('client/src/chat/avatar.ts');
  /* 剥注释再判：解释里会写"不许用 http://127.0.0.1"（§93 那个坑） */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');

  assert.doesNotMatch(src, /https?:\/\/127\.0\.0\.1/, '不许直连回环');
  assert.doesNotMatch(src, /createElement\('img'\)[^;]*127\.0\.0\.1/, '不许拼回环 URL');
  /* 取图由 thumbnail.ts 提供 data URL；头像只负责画 */
  assert.match(src, /options\.load/, '要通过注入的取图函数拿 data URL');
});

test('★★ 取不到图时退回首字占位，不画破图', () => {
  const src = read('client/src/chat/avatar.ts');
  assert.match(src, /data-state.*empty|'empty'/, '要标 empty 态');
  const css = read('client/src/chat/chat.css');
  assert.ok(css.includes(".nb-avatar[data-state='empty']"), 'empty 态要有样式');
});

test('★★★ 角色选择与仓库上传列表都用同一个头像组件', () => {
  for (const file of ['client/src/chat/character-picker.ts', 'client/src/chat/repo-page.ts']) {
    const src = read(file);
    assert.ok(src.includes('makeAvatar'), `${file} 要用统一头像组件（各写一份必然分叉）`);
  }
});

/* ═══════════════════════════════════════════════════════════
   二、分享
   ═══════════════════════════════════════════════════════════ */

test('★★★ 文件名要滤掉路径分隔符，保留中文', () => {
  assert.equal(shareFileName('林晚照'), '林晚照.png');
  assert.equal(shareFileName('a/b\\c'), 'abc.png');
  assert.equal(shareFileName('   '), '卡片.png');
  assert.equal(shareFileName('林晚照.png'), '林晚照.png', '已带扩展名不重复加');
});

test('★★ 超长名字要截断', () => {
  const out = shareFileName('晚'.repeat(200));
  assert.ok(out.length <= 70, `实际 ${String(out.length)} 字符`);
});

test('★★★ base64 编码要能处理大数组（分块）', () => {
  /*
   * `String.fromCharCode(...bytes)` 一次铺 79 万个数会超调用栈
   * （V8 约 6 万~12 万）。这里用 30 万字节验证分块真的生效。
   */
  const big = new Uint8Array(300_000);
  for (let i = 0; i < big.length; i += 1) big[i] = i % 256;
  const out = bytesToBase64(big);
  assert.ok(out.length > 300_000, 'base64 长度应大于原始字节');
  assert.doesNotThrow(() => atob(out));
});

test('★★★ 分享必须走 FileProvider + NEW_TASK（Kotlin）', () => {
  const kt = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StBridge.kt',
  );
  const start = kt.indexOf('fun sharePng(');
  assert.ok(start > 0, '找不到 sharePng');
  const block = kt.slice(start, kt.indexOf('fun insecureSocketFactory'));

  assert.match(block, /FileProvider\.getUriForFile/, 'file:// 在 Android 7+ 会抛 FileUriExposedException');
  assert.match(block, /FLAG_ACTIVITY_NEW_TASK/, 'JS 线程没有 Activity');
  assert.match(block, /ACTION_SEND/, '要用系统分享');
  assert.doesNotMatch(block, /fun sharePng\([^)]*\bpath\b/, '不许接受路径参数');
});

test('★★★ 分享前必须预取（onShare 是同步的，读 PNG 是异步的）', () => {
  const shell = read('client/src/chat/shell.ts');
  assert.match(shell, /shareCache/, '要有字节缓存');
  assert.match(shell, /prefetchForShare/, '要有预取');
  /*
   * 没取到时要如实说"正在准备"，不许拿别的卡的字节顶上 ——
   * 那会让用户分享出错误的卡且完全无声。
   */
  const at = shell.indexOf('onShare: (character: CharacterSummary)');
  const block = shell.slice(at, at + 900);
  assert.match(block, /正在准备/, '未命中缓存要说清楚');
});

test('★★★ 一次性失败不许永久缓存（null 不进缓存）', () => {
  /*
   * 真机现象：列表里一张有头像、一张只有首字圆。
   * 而"没有"的那张用桥单独取是 200 + 2868 字节 —— 数据一直在。
   *
   * 真因：`cache.set(key, settled)` 把 null 也缓存了，而 null 的成因
   * 常常是**临时**的（面板刚挂上时引擎还没就绪）。
   */
  const raw = read('client/src/chat/thumbnail.ts');
  /* 剥注释：我在注释里引用了那句旧写法（§93 的老坑，这次提前防住） */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');

  assert.match(src, /if \(settled !== null\) cache\.set/, 'null 不许写进缓存');
  assert.doesNotMatch(src, /(?<!if \(settled !== null\) )cache\.set\(key, settled\);/, '存在无条件写入缓存的旧写法');
});
