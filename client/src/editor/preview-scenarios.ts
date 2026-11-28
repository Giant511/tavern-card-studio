/**
 * 功能
 * 调试/取证用的三个入口：预览场景驱动、折叠往返、世界书演示。
 * 从 EditorApp 搬出，3 个函数 206 行。
 *
 * 注意事项
 * 这些函数**只在带 URL 参数启动时**才被调用（`?preview=cycle10` 之类），
 * 正常用户路径不会走到。搬成独立文件是为了让"生产代码"与"取证代码"
 * 在文件层面分开 —— 这是 P2-2 的第一步（生产包不该含 demo）。
 *
 * 它们靠 `document.body.dataset` 回报结果：`previewMs` / `previewVisible` /
 * `previewNodes` 等键由外部截图脚本读取。改键名会同时改坏取证脚本，
 * 而那个脚本不在本仓库，改完不容易发现。
 *
 * 踩过的坑
 * `runPreviewScenario` 里 `button.click()` 直接触发 UI，不走方法调用 ——
 * 这是**故意的**：要验的是"用户点这个按钮会发生什么"，绕开 UI 就等于
 * 只测了内部函数。
 */

import type { StPane } from '../session/st-pane';

import { expand, onBlockChange } from './block-actions';
import { byId } from './dom-id';

/**
 * 功能
 * 本模块能碰的编辑器状态与动作。
 *
 * 注意事项
 * 只要 `blocks`（判有几个块展开着）和 `stPane`（世界书演示要往它里面塞）。
 *
 * 踩过的坑
 * 无。
 */
export interface PreviewHost {
  /** 全部板块运行时（看展开状态） */
  readonly blocks: readonly import('./block-runtime').BlockRuntime[];
  /** ST 内嵌面板。null = 还没打开过 */
  readonly stPane: StPane | null;

  setStatus(message: string, kind: 'info' | 'ok' | 'warn' | 'bad'): void;
  /** 立刻校验 */
  validate(): void;
  /** 板块模块的接入点 */
  blockHost(): import('./block-actions').BlockHost;
}

export async function runPreviewScenario(host: PreviewHost, mode: string): Promise<void> {
  const button = byId<HTMLButtonElement>('btn-preview');
  const visibleCount = (): number =>
    [...document.querySelectorAll<HTMLElement>('.preview')].filter((node) => !node.hidden).length;
  const nodeCount = (): number =>
    [...document.querySelectorAll<HTMLElement>('.preview')].reduce((sum, node) => sum + node.childNodes.length, 0);
  const mark = (key: string, value: string): void => {
    document.body.dataset[key] = value;
  };

  // 默认启动会展开前两个板块，预览只对已展开的块生效
  const expanded = host.blocks.filter((runtime) => runtime.expanded).length;
  mark('previewExpanded', String(expanded));

  if (mode === 'open') {
    const started = performance.now();
    button.click();
    mark('previewMs', (performance.now() - started).toFixed(1));
    mark('previewVisible', String(visibleCount()));
    mark('previewNodes', String(nodeCount()));
    return;
  }

  if (mode === 'cycle10') {
    // 需求 F8.2：重复打开关闭 10 次，不泄漏、不累积遮罩
    let worstVisibleAfterClose = 0;
    let worstNodesAfterClose = 0;
    for (let round = 0; round < 10; round += 1) {
      button.click();
      button.click();
      worstVisibleAfterClose = Math.max(worstVisibleAfterClose, visibleCount());
      worstNodesAfterClose = Math.max(worstNodesAfterClose, nodeCount());
    }
    mark('previewCycles', '10');
    mark('previewVisibleAfterClose', String(worstVisibleAfterClose));
    mark('previewNodesAfterClose', String(worstNodesAfterClose));
    // 只统计**可见**的遮罩层。页面里本来就有设置/规则对话框的 .modal-overlay，
    // 它们带 hidden 属性常驻 DOM；把它们算进来会得到一个永远非零的假告警。
    const visibleOverlays = [...document.querySelectorAll<HTMLElement>(
      '[class*=overlay],[class*=mask],[class*=backdrop]',
    )].filter((node) => !node.hidden && node.getClientRects().length > 0).length;
    mark('previewOverlays', String(visibleOverlays));
    return;
  }

  if (mode === 'typing') {
    // 需求 F8.2：预览打开期间编辑器仍可输入（预览不应独占）
    button.click();
    mark('previewVisible', String(visibleCount()));
    const content = document.querySelector<HTMLElement>('.cm-content');
    if (!content) {
      mark('typingResult', 'no-editor');
      return;
    }
    const before = content.textContent ?? '';
    content.focus();
    // execCommand 会产生真实的 beforeinput/input 事件，CM6 按正常路径接收
    document.execCommand('insertText', false, '预览期间输入');
    const after = content.textContent ?? '';
    mark('typingResult', after !== before ? 'changed' : 'unchanged');
    mark('typingContentEditable', content.getAttribute('contenteditable') ?? 'null');
    // 中心点最上层元素必须仍在编辑器内，说明没有被全屏遮罩挡住
    const rect = content.getBoundingClientRect();
    const top = document.elementFromPoint(
      Math.round(rect.left + rect.width / 2),
      Math.round(rect.top + Math.min(rect.height / 2, 20)),
    );
    mark('typingTopmost', top && content.contains(top) ? 'editor' : (top?.className || top?.tagName || 'null'));
    return;
  }

  if (mode === 'sweep') {
    // T9.18：顶栏其余按钮逐个点一遍，确认没有「点了不返回」的同类状态机问题。
    // 判据是 click 的同步耗时 —— F8 那种故障会让 click 永不返回，
    // 这里因此拿不到 dump（进程被杀），本身就是失败信号。
    const ids = [
      'btn-open',
      'btn-save',
      'btn-preview',
      'btn-export',
      'btn-rules',
      'btn-settings',
      'btn-upload',
      'btn-history',
      'btn-rollback',
    ];
    const parts: string[] = [];
    for (const id of ids) {
      const node = document.getElementById(id) as HTMLButtonElement | null;
      if (!node) {
        parts.push(`${id}:missing`);
        continue;
      }
      if (node.disabled) {
        // 「打开/另存为」在浏览器模式下不可用（依赖 Tauri 契约），保持跳过；
        // 同步三键在未配置服务端时是 disabled，但它们内部只是「置一条提示后返回」，
        // 强制启用一次才能真正覆盖到处理函数，否则这一格等于没测。
        if (id.startsWith('btn-') && !['btn-open', 'btn-save'].includes(id)) {
          node.disabled = false;
          const startedForce = performance.now();
          let forcedState = 'ok';
          try {
            node.click();
          } catch (error) {
            forcedState = `threw(${(error as Error).message.slice(0, 30)})`;
          }
          parts.push(`${id}:${(performance.now() - startedForce).toFixed(1)}ms:${forcedState}(forced)`);
          node.disabled = true;
        } else {
          parts.push(`${id}:disabled`);
        }
        continue;
      }
      const started = performance.now();
      let state = 'ok';
      try {
        node.click();
      } catch (error) {
        state = `threw(${(error as Error).message.slice(0, 30)})`;
      }
      const elapsed = performance.now() - started;
      parts.push(`${id}:${elapsed.toFixed(1)}ms:${state}`);
      // 关掉可能弹出的对话框，否则会挡住后续点击
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      for (const close of document.querySelectorAll<HTMLElement>('.modal-close,[data-close]')) {
        if (close.getClientRects().length > 0) close.click();
      }
      // 预览是开关，点成打开后要再点回来，避免状态污染后续按钮
      if (id === 'btn-preview' && visibleCount() > 0) node.click();
    }
    // 全部点完再看一次：可见遮罩应为 0，页面仍可响应
    const leftover = [...document.querySelectorAll<HTMLElement>(
      '[class*=overlay],[class*=mask],[class*=backdrop]',
    )].filter((node) => !node.hidden && node.getClientRects().length > 0).length;
    mark('sweepResults', parts.join(' | '));
    mark('sweepVisibleOverlays', String(leftover));
    mark('sweepVisiblePreview', String(visibleCount()));
    return;
  }
}

export function applyDemoWorldbook(host: PreviewHost, kind: 'foreign' | 'good'): void {
  const foreign = [
    '持续世界书',
    '【条目1：西奥核心关系逻辑】',
    '顺序：275',
    '触发概率：100',
    '内容：{{char}}与{{user}}的关系发展缓慢，从保持距离逐渐转为依赖。',
    '【条目2：西奥成人规则】',
    '顺序：300',
    '触发概率：100',
    '内容：{{char}}是纯0／固定被动方，不会转为1。',
  ].join('\n');

  const good = [
    '@@ENTRY 0',
    'name: 西奥核心关系逻辑',
    'insertion_order: 275',
    '@@CONTENT',
    '{{char}}与{{user}}的关系发展缓慢，从保持距离逐渐转为依赖。',
    '@@END 0',
    '',
    '@@ENTRY 1',
    'name: 西奥成人规则',
    'insertion_order: 300',
    '@@CONTENT',
    '{{char}}是纯0／固定被动方，不会转为1。',
    '@@END 1',
  ].join('\n');

  const runtime = host.blocks.find((item) => item.snapshot.id === 'worldbook');
  if (runtime === undefined) return;
  if (!runtime.expanded) expand(host.blockHost(), runtime, true);
  const text = kind === 'foreign' ? foreign : good;
  onBlockChange(host.blockHost(), runtime, text);
  host.validate();
}

export async function runCollapseRoundTrip(host: PreviewHost): Promise<void> {
  const pane = host.stPane;
  if (pane === null) return;
  const button = document.querySelector<HTMLButtonElement>('[data-role="st-pane-toggle"]');
  if (button === null) {
    host.setStatus('检查折叠按钮失败：没有找到按钮', 'bad');
    return;
  }

  const nextFrame = (): Promise<void> =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

  const beforeWidth = pane.currentWidth;
  pane.collapse();
  await nextFrame();
  const collapsedWidth = pane.currentWidth;
  const collapsedGlyph = button.textContent ?? '';

  button.click(); // ← 就是这一步在真机里没反应
  await nextFrame();
  const expanded = !pane.isCollapsed;
  const expandedWidth = pane.currentWidth;

  const ok = collapsedWidth !== beforeWidth && expanded && expandedWidth === beforeWidth;
  host.setStatus(
    `折叠宽度 ${String(collapsedWidth)}（图标「${collapsedGlyph}」）` +
      ` → 点击后 ${expanded ? '已展开' : '仍是折叠'}，宽 ${String(expandedWidth)}` +
      `（记忆值 ${String(beforeWidth)}）`,
    ok ? 'ok' : 'bad',
  );
}