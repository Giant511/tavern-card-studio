#!/usr/bin/env node
/**
 * 生成高亮渲染预览页（阶段 3 交付佐证）。
 *
 * 用法：npm run preview:highlight
 * 输出：docs/assets/highlight-preview.html（自包含，双击即可打开）
 *
 * 内容：用三套内置范例（default / minimal / dark）渲染同一段示例文本，
 * 并附每套方案的 lineage、scope 数量、规则数量、命中区间数。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadHighlightRules,
  resolveHighlightRule,
  compileHighlightRule,
  computeHighlightSpans,
  renderInlineHtml,
  parseStCard,
} from '../shared/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'docs', 'assets');
const OUT_FILE = join(OUT_DIR, 'highlight-preview.html');

const SAMPLE_TEXT = [
  '【基本信息】',
  '姓名：{{char}}　年龄：24　身高：168cm',
  '',
  '## 其他设定',
  '聊天输出格式：对话使用中文双引号；每次回复不超过 3 段。',
  '',
  '【特殊设定】',
  '书店二楼不对客人开放。若{{user}}执意上楼，{{char}}会先沉默三秒，然后说「上面只是仓库」。',
  '',
  '---',
  '',
  '- 爱好：旧书、雨声',
  '// 备注：这段用来展示注释样式 <BOT> 伪标签',
].join('\n');

async function main() {
  const files = ['default.json', 'minimal.json', 'dark.json'];
  const inputs = [];
  for (const name of files) {
    inputs.push(JSON.parse(await readFile(join(ROOT, 'rules', 'highlight', name), 'utf8')));
  }

  const { rules, errors } = loadHighlightRules(inputs);
  if (errors.length > 0) {
    console.error('规则加载失败：', errors);
    process.exit(1);
  }

  const rawCard = JSON.parse(await readFile(join(ROOT, 'test', 'fixtures', 'sample-card.json'), 'utf8'));
  const { card } = parseStCard(rawCard);

  const sections = [];
  for (const id of ['default', 'minimal', 'dark']) {
    const resolved = resolveHighlightRule(id, rules);
    const compiled = compileHighlightRule(resolved);
    const html = renderInlineHtml(SAMPLE_TEXT, compiled, {}, { breakLines: true });
    const spans = computeHighlightSpans(SAMPLE_TEXT, compiled);
    let cardSpans = 0;
    for (const block of card.blocks) cardSpans += computeHighlightSpans(block.text, compiled, { blockId: block.id }).length;

    sections.push(`    <section class="card">
      <header>
        <h2>${resolved.name} <code>${resolved.id}</code> v${resolved.version}</h2>
        <p class="meta">继承链 ${resolved.lineage.join(' → ')} ｜ scope ${resolved.scopes.length} 个 ｜ 规则 ${resolved.rules.length} 条 ｜ 启用 ${compiled.rules.length} 条</p>
        <p class="meta">示例文本命中 ${spans.length} 个区间；示例卡片六板块合计命中 ${cardSpans} 个区间</p>
      </header>
      <pre class="preview" style="color:${resolved.theme.foreground};background:${resolved.theme.background}">${html}</pre>
    </section>`);
  }

  const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>语法高亮渲染预览 · Tavern Card Studio</title>
<style>
  body { margin: 0; padding: 32px; background: #f6f6f4; color: #222;
         font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.lead { margin: 0 0 24px; color: #666; font-size: 13px; }
  .card { background: #fff; border: 1px solid #e3e3df; border-radius: 8px;
          padding: 16px 20px; margin-bottom: 20px; }
  .card h2 { font-size: 15px; margin: 0 0 6px; }
  .card h2 code { font-size: 12px; color: #8a8a8a; font-weight: normal; }
  .meta { margin: 2px 0; font-size: 12px; color: #777; }
  pre.preview { font-family: "Sarasa Mono SC", Consolas, Menlo, monospace; font-size: 14px;
                line-height: 1.75; padding: 14px 16px; border-radius: 6px; overflow-x: auto;
                white-space: pre-wrap; margin: 12px 0 0; }
</style>
</head>
<body>
  <h1>语法高亮渲染预览</h1>
  <p class="lead">同一段文本，三套内置规则集（default / minimal / dark）。生成命令：<code>npm run preview:highlight</code></p>
${sections.join('\n')}
</body>
</html>
`;

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, page, 'utf8');
  console.log(`✔ 已生成 ${OUT_FILE}`);
}

await main();
