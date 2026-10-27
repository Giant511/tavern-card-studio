#!/usr/bin/env node
/**
 * UI 文案体检：面向用户的界面里不许出现测试性 / 开发性措辞。
 *
 * ## 为什么要单独一条守卫
 *
 * 用户两次指出同一个问题（「导出后这里明显不对」「UI 上不要有测试性或者开发性的文案」）。
 * 这类问题的特点是**功能全对、只有措辞是给开发者看的**：
 * 单元测试抓不到（它不检查文案），功能验收也抓不到（能点、能用）。
 * 只有把"措辞"本身当成判据，才会在下次改代码时立刻红。
 *
 * ## 判据怎么定
 *
 * 只扫**会显示给用户的字符串**：源文件里被引号/反引号包住、且含中文的文本，
 * 并排除注释行 —— 注释里出现这些词是正常的（那里本来就该写内部术语）。
 *
 * 豁免靠**精确文本**而不是行号：行号一改就失效，精确文本能撑住重构。
 * 另有行内豁免 `// ui-copy-allow: 理由`，给"数据不是文案"的情况用
 * （例如示例卡原文常量，必须逐字保留才能做相等比较）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 硬禁词：出现在用户界面里必然是错的。
 *
 * 每条都写上"为什么"，因为下一个人可能会想放宽它 —— 他需要知道当初的代价。
 */
const FORBIDDEN = [
  { re: /示例卡|样例卡|样本卡/, why: '「示例卡」是我们的开发概念，用户只知道自己有一张卡' },
  { re: /round-?trip/i, why: '术语，用户不懂' },
  { re: /序列化/, why: '实现细节（应为「重新生成」）' },
  { re: /落盘/, why: '内部黑话（应为「写入文件」）' },
  { re: /回读/, why: '内部黑话（应为「校验」）' },
  { re: /壳侧|渲染层/, why: '架构分层术语，用户不知道什么叫「壳」' },
  { re: /哨兵/, why: '我们的测试设施名' },
  { re: /mock|fixture|TODO|FIXME/i, why: '开发标记' },
  {
    re: /演示/,
    why:
      '验收入口用词。状态栏走的是同一个 setStatus、用户看到的是同一个界面 —— ' +
      '触发需要 URL 参数不等于可以写开发话，误触或日后放开就是脏的',
  },
  { re: /字段口径|键名|这个键/, why: '数据结构术语' },
  { re: /Electron/i, why: '本项目客户端是 Tauri，写 Electron 属于事实错误' },
  {
    re: /creator_notes|character_book|post_history_instructions|system_prompt|character_version/,
    why: 'JSON 键名，界面应显示中文名',
  },
];

/**
 * 允许出现的（需逐条写理由）。
 *
 * 用**完整字符串**匹配，不是片段 —— 片段豁免会连带放过别的文案。
 */
const ALLOWED = new Set([
  '测试连接',
  '尚未测试',
  '测试中…',
  '测试异常：',
  '在 SillyTavern 中测试',
  '测试',
  'JSON',
  'SQLite 索引库（卡片索引与登录限速依赖它）',
  '请求体不是合法 JSON',
]);

const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/**
 * 行内豁免：`// ui-copy-allow: 理由`。
 *
 * 要求**同一行**写理由，不许写在大老远的注释里：
 * 读代码的人看到这行就知道为什么它能豁免。
 */
const hasInlineAllow = (line) => /\/\/\s*ui-copy-allow:/.test(line);

/** 收集要扫的文件：只有会产出界面的地方 */
function collect(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      collect(full, out);
      continue;
    }
    if (!/\.(ts|html)$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

/** 取出一行里所有含中文的字符串字面量，返回 {可见文本, 原文} */
function quotedChinese(line) {
  const found = [];
  const re = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const rawLit = m[1] ?? m[2] ?? m[3] ?? '';
    /*
     * 两遍都要看，少一遍就会漏：
     *   ① `text`：剥掉 `${...}` 之后的可见文字 —— 防止属性名被当成文案
     *      （`世界书 ${byField.character_book.totalWords}` 里用户只看到「世界书」）；
     *   ② `${...}` **里面**的字符串字面量 —— `${cond ? '已按规范重新序列化' : ''}`
     *      这种内联文案会被渲染出来，只扫 ① 会整条漏掉。
     */
    const text = rawLit.replace(/\$\{[^}]*\}/g, '');
    const inline = [...rawLit.matchAll(/\$\{[^}]*\}/g)]
      .flatMap((seg) => [...seg[0].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2] ?? ''))
      .filter((t) => /[\u4e00-\u9fa5]/.test(t));
    for (const piece of [text, ...inline]) {
      if (/[\u4e00-\u9fa5]/.test(piece)) found.push({ text: piece, raw: rawLit });
    }
  }
  return found;
}

/**
 * 跑一次体检。
 *
 * 导出成函数而不仅是 CLI，是因为项目规矩：标 `offline` 的校验脚本必须能被
 * `test/offline-verifiers.test.mjs` 直接 import 跑同一份断言
 * （subprocess 调 CLI 会变成"测 shell 而不是测逻辑"）。
 *
 * @param {string} root 仓库根
 * @returns {{ok: boolean, scanned: number, problems: Array<{file: string, line: number, literal: string, why: string}>}}
 */
export function runUiCopyCheck(root = '.') {
  const files = [
    ...collect(join(root, 'client/src')),
    ...collect(join(root, 'server/public')),
    join(root, 'client/index.html'),
  ];

  const problems = [];
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    content.split(/\r?\n/).forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (hasInlineAllow(line)) return;
      for (const { text } of quotedChinese(line)) {
        for (const rule of FORBIDDEN) {
          if (!rule.re.test(text)) continue;
          if (ALLOWED.has(text)) continue;
          problems.push({ file: relative(root, file), line: index + 1, literal: text, why: rule.why });
          break;
        }
      }
    });
  }

  return { ok: problems.length === 0, scanned: files.length, problems };
}

/* CLI 入口 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('verify-ui-copy.mjs')) {
  const result = runUiCopyCheck(process.argv[2] ?? '.');
  if (result.ok) {
    process.stdout.write(
      '✔ UI 文案体检通过：扫描 ' + String(result.scanned) + ' 个界面源文件，未发现测试性 / 开发性措辞\n',
    );
    process.exit(0);
  }
  process.stdout.write('✘ UI 文案体检发现 ' + String(result.problems.length) + ' 处问题：\n\n');
  for (const item of result.problems) {
    process.stdout.write('  ' + item.file + ':' + String(item.line) + '\n');
    process.stdout.write('    文案：' + item.literal.slice(0, 90) + '\n');
    process.stdout.write('    原因：' + item.why + '\n\n');
  }
  process.stdout.write('改法：把文案改成用户能懂的说法；确实需要保留的，写进本脚本的 ALLOWED 并说明理由。\n');
  process.exit(1);
}
