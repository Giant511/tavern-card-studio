#!/usr/bin/env node
/**
 * 未知字段巡检（T10.10 补 F4 的配套工具）。
 *
 * 为什么需要它：未知字段只是 warning，不会让导入失败。这意味着
 * **内置规则库里悄悄混进一个拼错的键时，界面只会闪过一行黄字**，
 * 很容易被忽略到下一个版本。这个脚本把同一套检查搬到命令行，
 * 让提交前就能发现"白名单与 schema / 内置规则已经漂了"。
 *
 * 只把**未知字段**算失败；"scope 需由父规则集提供"这类继承提示
 * 是正常信息，单独打印但不判错（它不是拼写问题，也不该阻断）。
 *
 * 用法：npm run check:unknown-keys
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadHighlightRules, loadPlatformRules } from '../shared/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** unknown-keys.ts 产出的消息统一以「未知字段」开头，用它区分 */
const UNKNOWN_MARK = '未知字段';

function readJsonDir(dir) {
  const items = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    items.push({ file: relative(ROOT, path), json: JSON.parse(readFileSync(path, 'utf8')) });
  }
  return items;
}

let unknownCount = 0;
let errorCount = 0;
let noteCount = 0;

function report(label, items, result) {
  for (const item of result.errors) {
    errorCount += 1;
    const file = items[item.index]?.file ?? `#${String(item.index)}`;
    console.error(`✘ ${file} 校验失败：${item.errors.join('；')}`);
  }
  for (const item of result.warnings) {
    const file = items[item.index]?.file ?? `#${String(item.index)}`;
    for (const text of item.warnings) {
      if (text.includes(UNKNOWN_MARK)) {
        unknownCount += 1;
        console.error(`✘ ${file}：${text}`);
      } else {
        noteCount += 1;
        console.log(`· ${file}：${text}`);
      }
    }
  }
  console.log(`${label}：${String(items.length)} 个文件`);
}

const groups = [
  { label: '内置平台规则', dir: join(ROOT, 'rules', 'platforms'), load: loadPlatformRules },
  { label: '内置高亮方案', dir: join(ROOT, 'rules', 'highlight'), load: loadHighlightRules },
  // examples/ 里的示例是"会被用户照着抄"的范本，一起查
  { label: '示例规则', dir: join(ROOT, 'examples', 'rules'), load: null },
];

for (const group of groups) {
  let items;
  try {
    items = readJsonDir(group.dir);
  } catch (error) {
    console.error(`✘ 读取 ${group.dir} 失败：${error.message}`);
    process.exitCode = 1;
    continue;
  }
  if (items.length === 0) continue;

  if (group.load === null) {
    // `broken-*.json` 是**故意写错**的示例（给用户看错误提示长什么样），
    // 结构错误是它的用途，不能算巡检失败。
    const usable = items.filter((item) => !/[/\\]broken-[^/\\]*$/.test(item.file));
    // 混装了两类文件，按顶层形状分流：有 target 的是平台规则
    const platforms = usable.filter((item) => typeof item.json['target'] === 'object');
    const highlights = usable.filter((item) => Array.isArray(item.json['scopes']));
    report('示例（平台规则）', platforms, loadPlatformRules(platforms.map((item) => item.json)));
    report('示例（高亮方案）', highlights, loadHighlightRules(highlights.map((item) => item.json)));
    continue;
  }
  report(group.label, items, group.load(items.map((item) => item.json)));
}

if (errorCount > 0 || unknownCount > 0) {
  console.error(`\n合计：校验错误 ${String(errorCount)}，未知字段 ${String(unknownCount)}`);
  process.exit(1);
}
console.log(`\nOK 没有未知字段（${String(noteCount)} 条非拼写类提示）`);
