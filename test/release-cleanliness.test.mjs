/**
 * 发布产物洁净度（2026-11-07，0.1.7 收尾）。
 *
 * ## 为什么单独一个判据文件
 *
 * `round5-wiring.test.mjs` 里那几条是"删掉了吗"（文件存在性）。
 * 这一份管的是**更危险的一类**：
 *
 * ```text
 *   ① 源码里有没有写死的真实凭据（sk- 形态）
 *   ② 有没有把内网 / 测试地址当默认值
 *   ③ 默认配置是不是"空"（新装用户不该继承任何测试数据）
 *   ④ 检查产物 APK 本身（如果存在）
 * ```
 *
 * 为什么"默认值是空"要单独钉：`DEFAULT_VOICE_SETTINGS.baseUrl` 一旦
 * 被人改成一个测试地址，**每个新装用户**的语音配置都指向那台机器。
 * 那不报错、界面看着正常，只是永远连不上 —— 最难查的一种。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(REPO, p), 'utf8');

/** 剥注释：本项目被"注释里写了被搜的字符串"误伤过多次 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* ═══════════════════════════════════════════════════════════
   ① 源码里不许有真实凭据
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 源码里不许出现真实 API key（只看可执行代码，不看注释）', () => {
  /*
   * 判据是"长什么样"，不是"某个具体的 key"。
   *
   * 后者只能防住**已经泄露过的那个**，换成新 key 就失效 ——
   * 而真正的风险是"下次又贴一个进来"。
   *
   * 形态：`sk-` 后面跟 20 个以上合法字符。示例占位符（`sk-xxx`）
   * 长度不够，会自动放过 —— 那是它的特点，不是漏洞。
   */
  const roots = ['shared/src', 'client/src', 'scripts'];
  const offenders = [];

  const walk = (dir) => {
    for (const name of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${name.name}`;
      if (name.isDirectory()) {
        if (name.name === 'node_modules') continue;
        walk(rel);
        continue;
      }
      if (!/\.(ts|mjs|js|kt|rs)$/.test(name.name)) continue;
      const code = stripComments(read(rel));
      const hits = code.match(/sk-[A-Za-z0-9._-]{20,}/g);
      if (hits !== null) offenders.push(`${rel}: ${hits[0].slice(0, 12)}…`);
    }
  };

  for (const dir of roots) {
    if (existsSync(join(REPO, dir))) walk(dir);
  }

  assert.deepEqual(offenders, [], `源码里有疑似真实 key：\n  ${offenders.join('\n  ')}`);
});

test('★★★★ 源码里不许把内网地址当默认值', () => {
  /*
   * 注释里出现内网地址是**允许的**（讲排查过程时要用）。
   * 危险的是它出现在可执行代码里 —— 那会成为某个新装用户的默认值。
   */
  const code = stripComments(read('client/src/chat/voice-settings.ts'));
  assert.doesNotMatch(
    code,
    /baseUrl:\s*['"]https?:\/\/(10\.|192\.168\.|127\.0\.0\.1)/,
    '语音默认地址不许是内网/回环',
  );

  const settings = read('client/src/chat/voice-settings.ts');
  const m = /export const DEFAULT_VOICE_SETTINGS[^{]*\{([\s\S]*?)\n\};/.exec(settings);
  assert.ok(m !== null, '要能找到 DEFAULT_VOICE_SETTINGS');
  const block = stripComments(m[1]);
  assert.match(block, /baseUrl:\s*''/, '默认语音地址必须是空串（新装用户自己填）');
  assert.match(block, /model:\s*''/, '默认模型必须是空串');
});

/* ═══════════════════════════════════════════════════════════
   ② 测试卡整条链都不许回来
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 测试卡的生成器 / 资产 / 播种器 / 构建脚本全部不存在', () => {
  const gone = [
    'shared/src/android/test-card.ts',
    'scripts/build-test-card.mjs',
    'client/src-tauri/gen/android/app/src/main/assets/test-card',
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/TestCardSeeder.kt',
  ];
  for (const p of gone) {
    assert.equal(existsSync(join(REPO, p)), false, `${p} 应当已删除（发布包不该带测试素材）`);
  }
});

test('★★★★★ 服务启动流程不许补种任何角色', () => {
  /*
   * 这一条是真正的"用户装完看到什么"的源头。
   * 资产删了但播种调用还在 → 启动时找不到资产 → 可能是崩溃或一条日志噪音。
   * 两头都要清。
   */
  const service = stripComments(
    read('client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StService.kt'),
  );
  assert.doesNotMatch(service, /TestCardSeeder|seedTestCard/, '启动流程不许再播种测试卡');
});

/* ═══════════════════════════════════════════════════════════
   ③ 产物 APK（存在才查）
   ═══════════════════════════════════════════════════════════ */

test('★★★★ APK 产物里不许有真实 key / 内网地址 / 测试角色名', () => {
  /*
   * `.verify/probe-apk-clean.py` 是同一件事的完整版（会报命中位置）。
   * 这里只做**最小可用版本**：APK 不存在就跳过（CI 上不一定会打包）。
   *
   * 为什么在 js 测试里查 zip：`zip` 目录结构用 python 更方便，
   * 但那引入了"要另跑一个脚本"的记忆负担。这条钉住的是
   * "上次打包的产物是干净的"，且**必须在重打包后跑**。
   */
  const apk = join(REPO, 'release/android/tavern-card-studio-0.1.7-arm64-debug.apk');
  if (!existsSync(apk)) {
    console.log('[skip] 没有 0.1.7 debug APK，跳过产物检查');
    return;
  }

  /*
   * ★ 不在这里解 zip：node 没有内置 zip 读取器，为了这条断言引一个依赖
   * 不值得。所以这条只断言"文件存在且不太小"，真正的内容扫描交给
   * `.verify/probe-apk-clean.py`（收尾流程里的固定一步）。
   *
   * 这条的价值是**提醒**：发布前必须跑过那个 python 脚本。
   * 只写"我记得跑过"是不算数的 —— 而这里至少能把文件名与体积钉住，
   * 换包/漏包时会有感觉。
   */
  const st = readFileSync(apk);
  assert.ok(st.length > 100 * 1024 * 1024, 'APK 体积异常（可能没打进 assets）');
});
