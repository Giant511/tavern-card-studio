/**
 * 第三方许可声明的判据（2026-11-18）。
 *
 * ## 为什么需要它
 *
 * 合规文件最容易"悄悄失效"：`THIRD-PARTY-NOTICES.md` 被改名、`LICENSES/` 里少一份、
 * AGPL 全文被换成摘要 —— 这些都不会让程序报错，只会在某天被问到时才发现
 * "我们声称有，其实没有"。所以必须有判据盯着。
 *
 * ## 守四件事
 *
 * ```text
 * ① 文件存在：两份声明 + LICENSES/ 里的 16 份全文
 * ② 内容真实：AGPL 全文必须是完整正文（不是摘要、不是网页），体积与特征串双判
 * ③ 事实一致：声明里写的"APK 含 SillyTavern + 版本 + 上游地址"与代码/产物对得上
 * ④ 链接有效：声明里的相对链接都能落到真实文件
 * ```
 *
 * 第 ③ 条最重要：文档说"内置 ST 1.19.0"而实际打下的是别的版本，是最难发现的谎。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/* ═══════════════════════════════════════════════════════════
   ① 文件存在
   ═══════════════════════════════════════════════════════════ */

test('★★★ 第三方声明三件套都在', () => {
  for (const f of ['THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES-APPENDIX.md', 'LICENSES']) {
    assert.ok(existsSync(join(ROOT, f)), '缺少 ' + f);
  }
  assert.ok(statSync(join(ROOT, 'LICENSES')).isDirectory(), 'LICENSES 必须是目录');
});

test('★★★ LICENSES/ 覆盖所有实际用到的协议', () => {
  /*
   * 这 16 个是依赖树里真实出现过的协议标识符（见附录的分布统计）。
   * 少一份就意味着"声称附了全文但没附"。
   */
  const required = [
    'AGPL-3.0',
    'MIT',
    'Apache-2.0',
    'LLVM-exception',
    'MPL-2.0',
    'MS-RL',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    '0BSD',
    'Zlib',
    'Unlicense',
    'CC0-1.0',
    'BSL-1.0',
    'Unicode-3.0',
    'WTFPL',
  ];
  const present = new Set(readdirSync(join(ROOT, 'LICENSES')).map((f) => f.replace(/\.txt$/, '')));
  const missing = required.filter((r) => !present.has(r));
  assert.deepEqual(missing, [], '缺少许可全文：' + missing.join(', '));
});

/* ═══════════════════════════════════════════════════════════
   ② AGPL 全文必须是真正文
   ═══════════════════════════════════════════════════════════ */

test('★★★ AGPL-3.0 是完整正文，不是摘要或网页', () => {
  const text = read('LICENSES/AGPL-3.0.txt');
  // 完整 AGPL 约 34 KB；摘要/链接页会明显更小
  assert.ok(text.length > 30000, 'AGPL 全文过短（' + text.length + ' 字节），疑似摘要');
  for (const marker of [
    'GNU AFFERO GENERAL PUBLIC LICENSE',
    'Version 3, 19 November 2007',
    'TERMS AND CONDITIONS',
    'Remote Network Interaction',
  ]) {
    assert.ok(text.includes(marker), 'AGPL 全文缺少关键段落：' + marker);
  }
  // 网页残留：这些出现在协议正文里的概率极低
  assert.ok(
    !/Skip to content|&#?\w+;|Cookie Policy/i.test(text),
    'AGPL 全文里混进了网页残留',
  );
});

test('★★ 其它许可全文都不含网页残留', () => {
  /*
   * 这件事真的发生过：从 opensource.org 取 MIT 得到 8948 字节的导航栏 HTML，
   * 而 `includes('MIT License')` 依然通过 —— "含关键词"证明不了"是正文"。
   */
  const junk = /Skip to content|Open Source Initiative|About us|Contact us|Cookie|Newsletter|&#?\w+;/;
  for (const f of readdirSync(join(ROOT, 'LICENSES')).filter((x) => x.endsWith('.txt'))) {
    const text = read('LICENSES/' + f);
    assert.ok(!junk.test(text), f + ' 里有网页残留');
    assert.ok(text.length > 500, f + ' 体积异常（' + text.length + ' 字节）');
  }
});

/* ═══════════════════════════════════════════════════════════
   ③ 声明与代码/产物一致
   ═══════════════════════════════════════════════════════════ */

test('★★★ 声明里的 ST 版本与打包脚本的实际来源一致', () => {
  const notices = read('THIRD-PARTY-NOTICES.md');
  const packer = read('scripts/pack-st-assets.mjs');

  // 声明里承诺了这些事实
  assert.ok(notices.includes('SillyTavern'), '声明里没提 SillyTavern —— 那是唯一的 AGPL 组件');
  assert.ok(notices.includes('AGPL-3.0'), '声明里没写 AGPL-3.0');

  /*
   * ★ 只断一处 `includes` 是坏判据。
   *
   * 变异验证抓到的：文档里同一个源码地址出现两次（§0 的清单表 + §1.1 的表格）。
   * 只改其中一处，`includes('…/tree/1.19.0')` 依然成立 —— 文档自相矛盾却全绿。
   *
   * 正确做法：把**所有** SillyTavern 源码地址里的版本号抽出来，要求它们同一。
   * 同时要求至少出现一次（不能一个都没有）。
   */
  const refs = [...notices.matchAll(/SillyTavern\/SillyTavern\/tree\/([^\s)`|]+)/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, '必须给出对应源码的确切位置（AGPL §6 要求可获取）');
  const uniq = [...new Set(refs)];
  assert.equal(
    uniq.length,
    1,
    '声明里出现了多个不同的 ST 源码版本：' + uniq.join(' / ') + ' —— 必须统一到实际打包的那个',
  );

  // 打包脚本确实把 ST 打进 APK 的 assets
  assert.ok(
    packer.includes('assets/st.zip'),
    '打包脚本的输出位置变了 —— 声明里的"出现位置"要跟着改',
  );
});

test('★★★ 声明必须说清"仓库 MIT / APK 含 AGPL"这层区别', () => {
  const notices = read('THIRD-PARTY-NOTICES.md');
  /*
   * ★ 这条曾经写成"只要文件里出现过 APK 和 AGPL 就算通过" —— 那是坏判据。
   *
   * 变异验证抓到了它：把「安卓 APK 一行里的 AGPL-3.0」改成「安卓 APK 也是 MIT」，
   * 测试**依然全绿** —— 因为文件别处还有 AGPL-3.0、"未修改"、"对应源码"，
   * 三个 `includes` 各自都成立，而它们之间的**关联**已经被抹掉了。
   *
   * 正确的判据是"同一行里同时出现 APK 与 AGPL"，而不是"全文分别出现过"。
   */
  const linesWithApkAndAgpl = notices
    .split('\n')
    .filter((line) => /APK/.test(line) && /AGPL/.test(line));

  assert.ok(
    linesWithApkAndAgpl.length > 0,
    '必须有一行同时说明「APK 内含 AGPL」—— 分开两处各提一次等于没说清',
  );

  assert.match(
    notices,
    /未修改|原样分发|verbatim/,
    '必须说明是否修改过 ST —— 未修改才可以只指向上游源码',
  );
  assert.match(
    notices,
    /对应源码|Corresponding Source/i,
    '必须满足 AGPL 的源码提供义务（给出获取方式）',
  );
});

test('★★ 打包脚本确实没有修改 ST 源码（只做打包与排除）', () => {
  const packer = read('scripts/pack-st-assets.mjs');
  /*
   * 若哪天脚本开始"打补丁"或写文件回 ST 目录，就不算原样分发了，
   * 声明里的"未修改"立刻变成假话，且必须公开修改后的源码。
   */
  assert.ok(
    !/writeFileSync\([^)]*sillytavern/i.test(packer),
    '打包脚本似乎在往 ST 目录写文件 —— 那就不是原样分发了',
  );
  assert.match(packer, /EXCLUDE_ROOTS/, '排除清单不见了，需确认是否开始裁剪 ST');
  // 必须排除用户数据
  assert.ok(packer.includes("'data'"), '打包必须排除 data/（否则会把别人的聊天记录打进包）');
});

/* ═══════════════════════════════════════════════════════════
   ③·2 运行时注入必须披露（2026-11-18 评估后补）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 声明必须披露运行时日志钩子（本项目唯一的进程内注入）', () => {
  /*
   * `StLauncher.kt` 设了 `NODE_OPTIONS=--require tcs-log-hook.cjs`，
   * 让**我们的代码**在 ST 进程里执行。这是事实，且它削弱了"纯独立进程"的说法。
   *
   * 不写出来，"未修改、原样分发"就成了含糊表述 —— 那才是实质风险。
   * 披露之后性质清楚：ST 源码一字未改，注入的是一份可单独审查的日志工具。
   */
  const notices = read('THIRD-PARTY-NOTICES.md');
  assert.match(notices, /tcs-log-hook\.cjs/, '必须点名那个钩子文件');
  assert.match(notices, /--require/, '必须说明是通过 --require 注入的');
  assert.match(
    notices,
    /不读改写|不修改.*源文件|不改变.*业务逻辑/,
    '必须说明它不修改 ST 的源码与业务逻辑',
  );
});

test('★★★ 代码里若还有注入，声明里就必须还有披露（两边不许脱节）', () => {
  /*
   * 反向守护：将来若新增了别的注入点（比如又加一个 --import / --loader），
   * 声明里只有 tcs-log-hook 就会漏。这里把"代码里的注入点"数一遍。
   */
  const launcher = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLauncher.kt',
  );
  const injections = [...launcher.matchAll(/NODE_OPTIONS|--require|--import|--loader/g)].map(
    (m) => m[0],
  );
  assert.ok(injections.length > 0, 'StLauncher 里应当有注入点（--require）');
  // 目前只允许 require 一种；新增别的方式时这条会红，逼作者回来更新声明
  const kinds = new Set(injections.filter((one) => one.startsWith('--')));
  assert.deepEqual(
    [...kinds],
    ['--require'],
    '注入方式变了（' + [...kinds].join(', ') + '），必须同步更新 THIRD-PARTY-NOTICES 的披露段落',
  );
});

/* ═══════════════════════════════════════════════════════════
   ④ 链接有效
   ═══════════════════════════════════════════════════════════ */

test('★★ 声明里的相对链接都能落到真实文件', () => {
  for (const doc of ['THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES-APPENDIX.md']) {
    const text = read(doc);
    const links = [...text.matchAll(/\]\(([^)#][^)]*)\)/g)]
      .map((m) => m[1])
      .filter((x) => !/^https?:/.test(x));
    for (const link of links) {
      const target = link.split('#')[0];
      if (target === '') continue;
      assert.ok(
        existsSync(join(ROOT, decodeURIComponent(target))),
        doc + ' 里的链接失效：' + link,
      );
    }
  }
});

test('★★ 三个子包都声明了 license', () => {
  /*
   * 缺了不会影响运行，但会让"本项目是 MIT"这句话在子包粒度上不成立，
   * 也害得依赖清单里出现一堆"(未声明)"。
   */
  for (const p of ['client/package.json', 'server/package.json', 'shared/package.json']) {
    const j = JSON.parse(read(p));
    assert.equal(j.license, 'MIT', p + ' 的 license 不是 MIT');
  }
});

test('★★ README 指向第三方声明（否则用户找不到）', () => {
  const readme = read('README.md');
  assert.ok(
    readme.includes('THIRD-PARTY-NOTICES.md'),
    'README 的许可证章节必须链到第三方声明',
  );
});
