/**
 * 性能粗测（T6.1 交付项之一）。
 *
 * 目的：给出「万字段落」在真实浏览器内核里的渲染耗时基线，而不是空口说"CM6 很快"。
 * 分四段计时，便于定位瓶颈：
 *   1. 规则装配（buildRuleset）——只在启动时一次
 *   2. 高亮区间计算（computeHighlightSpans）——每次文档变化都会跑
 *   3. 装饰集构建（toDecorationSet）
 *   4. 编辑器挂载（new EditorView，含首次 DOM 渲染）——展开板块时一次
 *
 * 结果同时写入 #perf-out 与 window.__PERF__，供 --dump-dom / 自动化读取。
 */

import { computeHighlightSpans } from '@tcs/shared';

import { BlockEditor } from './editor/block-editor';
import { toDecorationSet, buildHighlightRanges } from './editor/highlight';
import { buildRuleset } from './editor/rules';

/** 构造一段约 target 字符的板块文本，覆盖绝大多数高亮规则 */
function makeText(target: number): string {
  const unit = [
    '【小节】开场',
    '{{char}}把书递过来，指尖在书脊上停了一下。',
    '「你来晚了三分钟。」她说话时没有抬头。',
    '*她把帆布鞋在地板上蹭了蹭。*',
    '- 第一条注意事项',
    '- 第二条注意事项',
    '【称呼】{{user}} 与她以「老板」「小晚」互称。',
    '---',
    '# 注释：这是作者留言',
  ].join('\n');

  const parts: string[] = [];
  let length = 0;
  while (length < target) {
    parts.push(unit);
    length += unit.length + 1;
  }
  return parts.join('\n');
}

function ms(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

async function run(): Promise<void> {
  const out = document.getElementById('perf-out') as HTMLPreElement;
  const lines: string[] = [];

  const text = makeText(10_000);
  lines.push(`样本：${[...text].length} 字符 / ${bytesOf(text)} 字节 / ${text.split('\n').length} 行`);

  let ruleset: Awaited<ReturnType<typeof buildRuleset>> | null = null;
  const tRules = ms(() => {
    // buildRuleset 是 async，这里用同步占位，真实耗时在下面 await 前后取
  });
  void tRules;

  const r0 = performance.now();
  ruleset = await buildRuleset();
  const rulesMs = performance.now() - r0;
  lines.push(`规则装配 buildRuleset：${rulesMs.toFixed(1)} ms（一次）`);

  const compiled = ruleset.highlight;

  // 预热一次，避免 JIT 首次编译算进结果
  computeHighlightSpans(text, compiled, { blockId: 'basic' });

  const runs = 5;
  const spanTimes: number[] = [];
  for (let i = 0; i < runs; i++) {
    spanTimes.push(ms(() => void computeHighlightSpans(text, compiled, { blockId: 'basic' })));
  }
  const spans = computeHighlightSpans(text, compiled, { blockId: 'basic' });
  lines.push(
    `高亮区间 computeHighlightSpans：${spanTimes.map((t) => t.toFixed(1)).join(' / ')} ms` +
      `（${runs} 次，命中 ${spans.length} 段）`,
  );

  const decoTime = ms(() => {
    toDecorationSet(buildHighlightRanges(text, compiled, { blockId: 'basic' }));
  });
  lines.push(`装饰集构建 toDecorationSet：${decoTime.toFixed(1)} ms`);

  // 挂载：这就是"展开板块"时的真实成本
  const mount = document.getElementById('mount') as HTMLDivElement;
  const mountTimes: number[] = [];
  const created: BlockEditor[] = [];
  for (let i = 0; i < 3; i++) {
    mount.replaceChildren();
    mountTimes.push(
      ms(() => {
        created.push(
          new BlockEditor({
            parent: mount,
            text,
            blockId: 'basic',
            compiled,
            onChange: () => {},
          }),
        );
      }),
    );
  }
  for (const editor of created) editor.destroy();
  lines.push(`编辑器挂载 new EditorView：${mountTimes.map((t) => t.toFixed(1)).join(' / ')} ms（3 次）`);

  // 留一个实例在页面上，便于截图看实际渲染效果
  mount.replaceChildren();
  const finalEditor = new BlockEditor({
    parent: mount,
    text: text.slice(0, 2000),
    blockId: 'basic',
    compiled,
    onChange: () => {},
  });
  void finalEditor;

  const result = {
    chars: [...text].length,
    bytes: bytesOf(text),
    lines: text.split('\n').length,
    rulesMs: Number(rulesMs.toFixed(1)),
    spanMs: spanTimes.map((t) => Number(t.toFixed(1))),
    decoMs: Number(decoTime.toFixed(1)),
    mountMs: mountTimes.map((t) => Number(t.toFixed(1))),
    spanCount: spans.length,
    scheme: ruleset.highlightId,
    source: ruleset.sources.highlight,
  };
  (window as unknown as Record<string, unknown>)['__PERF__'] = result;

  lines.push('');
  lines.push(`DONE ${JSON.stringify(result)}`);
  out.textContent = lines.join('\n');
}

void run().catch((error: unknown) => {
  const out = document.getElementById('perf-out');
  if (out) out.textContent = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
});
