/**
 * 功能
 * 板块的增删与显隐：创建、展开、折叠、内容变更后的响应，以及世界书操作条
 * 与作用域门控。从 EditorApp 搬出，6 个函数 156 行。
 *
 * 注意事项
 * `expand` / `collapse` 只动 DOM 与 `runtime.expanded`，**不进快照** ——
 * 折叠一个板块不算"改了卡"，写进快照会让导出带上无意义的差异。
 *
 * `onBlockChange` 是内容变更的唯一入口：它负责「更新快照 → 重算该块徽标 →
 * 排一次校验」。绕过它直接改 snapshot 会让徽标与校验都停在上一次。
 *
 * 踩过的坑
 * `buildWorldbookActions` 返回的是**未挂载**的节点，由调用方决定插在哪。
 * 曾经在这里直接 append 到 document，结果每次重建板块都留一个游离节点。
 */

import type { EditorBlockSnapshot } from './block-doc';
import type { BlockRuntime } from './block-runtime';
import { makeUndoSnapshot, pickUndoState } from './undo-snapshot';
import type { Ruleset } from './rules';

import { disabledReason } from '../auth/repo-token';
import { byId } from './dom-id';
import { describeError } from './error-text';
import { pickAndImportWorldbook } from './import-actions';
import { BlockEditor } from './block-editor';
import { el } from './dom';

/**
 * 功能
 * 本模块能碰的编辑器状态与动作。
 *
 * 注意事项
 * `blockList` 是容器节点，`blocks` 是运行时数组 —— 两个都要
 * （一个管挂载，一个管遍历）。别只留一个。
 *
 * 踩过的坑
 * 无。
 */
export interface BlockHost {
  /** 板块运行时数组（每次重铺会整体替换） */
  readonly blocks: readonly BlockRuntime[];
  /** 板块容器节点 */
  readonly blockList: HTMLElement;
  /** 当前卡片 */
  readonly card: import('@tcs/shared').UnifiedCard;
  /** 规则集（作用域门控要用） */
  readonly rules: Ruleset | null;
  /** 当前会话（拿它的规则选择） */
  readonly session: import('../session/card-session').CardSession | null;
  /** 账号认证会话（世界书上传要先看有没有登录） */
  readonly authSession: import('../auth/session').AuthSession | null;

  /** 重画统计数字 */
  refreshStats(): void;
  /** 重画标签栏 */
  refreshTabs(): void;
  /** 排一次校验（防抖） */
  scheduleValidate(delayMs?: number): void;
  /** 取某个板块的问题清单（按 blockId 过滤） */
  issuesFor(blockId: import('@tcs/shared').BlockId): readonly import('./block-editor').EditorIssue[];
  /** 导出世界书（操作条上的按钮）。`format` 决定导 JSON 还是 TXT */
  exportWorldbookFile(format: 'json' | 'txt'): void;
  /** 折叠/展开切换（`createBlock` 的点击回调用它） */
  toggle(runtime: BlockRuntime): void;
  /** 导入模块的接入点（世界书操作条要用） */
  importHost(): import('./import-actions').ImportHost;
}

export function applyScopeGating(host: BlockHost): void {
  const session = host.authSession;
  const isRepoToken = session?.isRepoTokenMode === true;
  const caps = session?.capabilities ?? null;

  const set = (id: string, enabled: boolean, reason: string): void => {
    const button = byId<HTMLButtonElement>(id);
    button.disabled = !enabled;
    if (enabled) {
      button.removeAttribute('title');
    } else {
      button.title = reason;
    }
  };

  if (!isRepoToken || caps === null) {
    // 账户 / legacy：恢复"全部可用"，并把上一次令牌模式留下的 title 清掉
    set('btn-upload', true, '');
    set('btn-history', true, '');
    set('btn-rollback', true, '');
    document.body.dataset['credentialMode'] = host.authSession?.mode ?? 'none';
    delete document.body.dataset['repoTokenScopes'];
    return;
  }

  set('btn-upload', caps.canUpload, disabledReason('upload', caps));
  // 历史只需要读：有 read 就能看
  set('btn-history', caps.canRead, caps.canRead ? '' : '此令牌没有「读」权限');
  set('btn-rollback', caps.canRollback, disabledReason('rollback', caps));

  // 端到端断言用：不靠读文案判断模式与权限
  document.body.dataset['credentialMode'] = 'repo-token';
  document.body.dataset['repoTokenScopes'] = [...(host.authSession?.repoTokenScopes ?? [])].join(',');
}

export function buildWorldbookActions(host: BlockHost): HTMLElement {
  const row = el('div', 'worldbook-actions');
  const importButton = el('button', 'btn small', '导入世界书…') as HTMLButtonElement;
  importButton.type = 'button';
  importButton.dataset['role'] = 'worldbook-import';
  importButton.title = '支持世界书文件与纯文本，会自动识别格式';
  importButton.addEventListener('click', () => void pickAndImportWorldbook(host.importHost()));

  const exportJson = el('button', 'btn small ghost', '导出文件…') as HTMLButtonElement;
  exportJson.type = 'button';
  exportJson.dataset['role'] = 'worldbook-export-json';
  exportJson.addEventListener('click', () => void host.exportWorldbookFile('json'));

  const exportTxt = el('button', 'btn small ghost', '导出 TXT…') as HTMLButtonElement;
  exportTxt.type = 'button';
  exportTxt.dataset['role'] = 'worldbook-export-txt';
  exportTxt.addEventListener('click', () => void host.exportWorldbookFile('txt'));

  row.append(importButton, exportJson, exportTxt);
  return row;
}

export function createBlock(host: BlockHost, snapshot: EditorBlockSnapshot): BlockRuntime {
  const section = el('section', 'block');
  section.dataset['blockId'] = snapshot.id;

  const header = el('button', 'block-head');
  header.type = 'button';

  const caret = el('span', 'caret', '▸');
  const title = el('span', 'block-title', snapshot.label);
  const meta = el('span', 'block-meta', `${snapshot.length} 字`);

  // 缺失标记：CardBlock.missing 的语义是「导入源里根本没有这个板块」，
  // shared 要求 UI 显式标出，不允许让它看起来像「用户清空了」。
  // 因此这里在标题旁常驻一个小标签，与「空块」在视觉上区分开。
  const missingTag = el('span', 'block-missing', '原文缺失');
  missingTag.hidden = !snapshot.missing;
  missingTag.title = '导入源中没有该板块，已按空处理；填写后会在导出时写入';

  const badge = el('span', 'block-badge');
  badge.hidden = true;

  header.append(caret, title, missingTag, meta, badge);
  if (snapshot.missing) section.dataset['missing'] = '1';

  const body = el('div', 'block-body');
  body.hidden = true;

  const cmHost = el('div', 'cm-host');
  const preview = el('div', 'preview');
  preview.hidden = true;
  // 世界书块额外挂「导入 / 导出」——世界书是唯一能从外部独立导入导出的板块，
  // 入口放在它自己的块里，用户不用去别处找（T10.9）。
  if (snapshot.id === 'worldbook') body.append(buildWorldbookActions(host));
  body.append(cmHost, preview);

  section.append(header, body);

  const runtime: BlockRuntime = {
    snapshot,
    section,
    body,
    host: cmHost,
    preview,
    badge,
    editor: null,
    expanded: false,
    previewOn: false,
    undo: null,
  };

  header.addEventListener('click', () => host.toggle(runtime));
  host.blockList.append(section);
  return runtime;
}

export function expand(host: BlockHost, runtime: BlockRuntime, silent = false): void {
  if (runtime.expanded) return;
  runtime.expanded = true;
  runtime.body.hidden = false;
  runtime.section.classList.add('expanded');
  runtime.section.querySelector('.caret')!.textContent = '▾';

  // 懒渲染：只有展开时才创建 CodeMirror 实例
  if (!runtime.editor) {
    const compiled = host.rules?.highlight ?? null;
    /*
     * 折叠过的块带着撤销现场回来（P1-10）。
     *
     * `pickUndoState` 会校验"文本没被别处改过 && 高亮没换过" ——
     * 任一不满足就返回 null，于是走新建分支。**宁可撤销不可用，
     * 也不能让内容回退到旧版本。**
     */
    const reused = pickUndoState(runtime.undo, runtime.snapshot.text, compiled);
    runtime.undo = null;
    runtime.editor =
      reused !== null
        ? new BlockEditor({
            parent: runtime.host,
            blockId: runtime.snapshot.id,
            compiled,
            state: reused,
            onChange: (text) => onBlockChange(host, runtime, text),
          })
        : new BlockEditor({
            parent: runtime.host,
            blockId: runtime.snapshot.id,
            compiled,
            text: runtime.snapshot.text,
            onChange: (text) => onBlockChange(host, runtime, text),
          });
    runtime.editor.setIssues(host.issuesFor(runtime.snapshot.id));
  }
  if (!silent) runtime.editor.view.focus();
}

export function collapse(host: BlockHost, runtime: BlockRuntime): void {
  if (!runtime.expanded) return;
  runtime.expanded = false;
  runtime.body.hidden = true;
  runtime.section.classList.remove('expanded');
  runtime.section.querySelector('.caret')!.textContent = '▸';

  /*
   * 折叠即销毁：保证隐藏板块不进 DOM（含 CodeMirror 的 contenteditable 结构）。
   *
   * 但**撤销栈要留下来**（P1-10）：CodeMirror 的 history 住在 EditorState 里，
   * 直接 destroy + 重新 create 会让 Ctrl+Z 彻底失效 —— 用户折叠一下再展开，
   * 之前打的字就撤不回去了。所以先把 state 存进 runtime，展开时再交回去。
   */
  if (runtime.editor !== null) {
    runtime.undo = makeUndoSnapshot(runtime.editor.snapshotState(), runtime.editor.highlight);
  }
  runtime.editor?.destroy();
  runtime.editor = null;
  runtime.host.replaceChildren();
}

export function onBlockChange(host: BlockHost, runtime: BlockRuntime, text: string): void {
  // 走 session：它内部会置脏并让审计缓存失效。
  // 直接 `host.card = result.card` 会绕过这两件事 —— 那正是脏标记不可靠的老原因。
  // 记下改之前是否已脏：脏标记只在「首次变脏」时才会改变标签文字，
  // 每敲一个字都重绘整个标签栏是白费（TabBar.render 会重建 DOM）。
  const wasDirty = host.session!.dirty;
  const result = host.session!.setBlockText(runtime.snapshot.id, text);
  if (!result.changed) return;

  runtime.snapshot = {
    ...runtime.snapshot,
    text,
    length: [...text].length,
    empty: text.trim() === '',
  };
  // 标签上的 ● 必须跟着第一次改动立刻出现。
  // 之前这里只刷了统计与校验，于是「改完内容后标签看不出有未保存修改」，
  // 要等切标签/新建才补上（2026-10-22 T9.14 端到端抓到的缺陷）。
  if (!wasDirty && host.session!.dirty) host.refreshTabs();
  host.refreshStats();
  host.scheduleValidate(260);
}