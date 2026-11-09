/**
 * 「提示词管理」页（2026-11-03，第二十二批）。
 *
 * ## 为什么需要这一页
 *
 * 用户导入了 38 条提示词的预设，但**在 App 里看不到、也管不了**：
 *
 * > 这个我看不到导入预设后预设里面的提示词，
 * > 没有办法管理我要开哪个提示词或者关哪个提示词。
 *
 * 之前只做到「读出来 → 拼进请求」（memory §90），
 * 缺了「让用户看见并控制」这一段 —— 而后者才是"用户自己调教"的前提。
 *
 * ## 与 ST 原生面板的对应
 *
 * ST 那边是：一个下拉（选提示词）+ 一排按钮（插入/删除/导入/导出/重置/新建）
 * + 一个总 Token 数。手机屏上塞不下那一排，所以这里改成：
 *
 * | ST | 这里 | 为什么 |
 * |---|---|---|
 * | 列表 + 拖拽排序 | 列表 + 开关 | 手机上拖拽很容易误触；顺序在 ST 里调好即可 |
 * | 点名字看内容 | 点整行展开内容 | 一行里能同时看到"是什么"和"开没开" |
 * | 那排增删按钮 | 暂不做 | 增删提示词是低频操作，且做错会丢用户配置 |
 *
 * **核心是开关** —— 用户的原话就是"开哪个、关哪个"。
 */

import type { DocLike, ElLike } from './chat-view.js';
import type { ParsedPromptConfig, StPrompt } from '@tcs/shared';

/** 页面回调 */
export interface ChatPromptsCallbacks {
  onBack: () => void;
  /** 读当前配置（返回 null = 没有可用的提示词配置） */
  loadConfig: () => ParsedPromptConfig | null;
  /**
   * 切换某条的开关。
   *
   * 返回值决定界面怎么表现：
   *   · `ok: true` → 立刻更新界面（乐观更新后由外壳回写 ST）
   *   · `ok: false` → 保持原状 + 提示原因
   *
   * **失败时不能假装成功**：用户会以为关掉了，实际还在发 ——
   * 那是"设了不生效"的典型成因。
   */
  togglePrompt: (identifier: string, enabled: boolean) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * 打开编辑页（2026-11-07）。
   *
   * `identifier === null` = 新建。
   */
  openEditor?: (identifier: string | null) => void;
  onNotify?: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
}

function el(doc: DocLike, tag: string, className?: string): ElLike {
  const node = doc.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  return node;
}

/** role 的小标记（让人一眼看出这条是以什么身份发的） */
function roleBadge(prompt: StPrompt): string {
  if (prompt.marker === true) return '内置';
  if (prompt.role === 'user') return '用户';
  if (prompt.role === 'assistant') return '助手';
  return '系统';
}

/**
 * 渲染「提示词管理」页。
 *
 * 参数 `config` 由调用方传进来（外壳已经从当前预设解析好了）。
 * `null` 时给一句明白话，不渲染空列表 ——
 * 空列表看起来像"预设里没有提示词"，而实际是"还没读到"。
 */
export function renderChatPromptsPage(
  doc: DocLike,
  config: ParsedPromptConfig | null,
  callbacks: ChatPromptsCallbacks,
): ElLike {
  const root = el(doc, 'div', 'nb-page nb-chat-prompts');
  root.setAttribute('data-role', 'chat-prompts-page');

  /* ── 顶栏 ── */
  const topbar = el(doc, 'div', 'nb-topbar');
  const back = el(doc, 'button', 'nb-icon-btn');
  back.setAttribute('type', 'button');
  back.setAttribute('data-role', 'prompts-back');
  back.setAttribute('aria-label', '返回');
  back.textContent = '‹';
  back.addEventListener('click', () => callbacks.onBack());

  const title = el(doc, 'h1', 'nb-topbar-title');
  title.textContent = '提示词';
  topbar.append(back, title);

  /*
   * 右上角「+ 新建」（2026-11-07，用户要求"和原生 ST 一样"）。
   *
   * 只在能打开编辑页时出现 —— 拿不到入口就画一个按钮是"假控件"，
   * 点了没反应比不显示更糟（本项目反复强调的一条）。
   */
  if (callbacks.openEditor !== undefined) {
    const add = el(doc, 'button', 'nb-icon-btn');
    add.setAttribute('type', 'button');
    add.setAttribute('data-role', 'prompts-add');
    add.setAttribute('aria-label', '新建提示词');
    add.textContent = '＋';
    add.addEventListener('click', () => callbacks.openEditor?.(null));
    topbar.append(add);
  }

  root.append(topbar);

  const body = el(doc, 'div', 'nb-list');
  body.setAttribute('data-role', 'prompts-body');
  root.append(body);

  if (config === null || config.prompts.length === 0) {
    const empty = el(doc, 'div', 'nb-empty');
    empty.setAttribute('data-role', 'prompts-empty');
    /*
     * 文案判据（用户两次明令）：**读了知道能做什么**。
     * 不能只说"没有提示词" —— 用户的下一个问题必然是"那我怎么办"。
     */
    empty.textContent =
      '还没有读到提示词。到「AI 响应配置」里导入一份预设（或选一个已有的），再回来看。';
    body.append(empty);
    return root;
  }

  /* ── 汇总条：多少条启用 ── */
  const order = config.order ?? config.prompts.map((one) => ({ identifier: one.identifier, enabled: true }));
  const enabledIds = new Set(order.filter((one) => one.enabled).map((one) => one.identifier));

  const summary = el(doc, 'div', 'nb-prompts-summary');
  summary.setAttribute('data-role', 'prompts-summary');
  const summaryMain = el(doc, 'div', 'nb-prompts-summary-main');
  const refreshSummary = (): void => {
    summaryMain.textContent = `${String(enabledIds.size)} / ${String(order.length)} 条启用`;
  };
  refreshSummary();
  summary.append(summaryMain);

  const summarySub = el(doc, 'div', 'nb-prompts-summary-sub');
  /*
   * 说清"关掉会怎样"。
   *
   * 只说数字的话，用户不知道关掉一条的后果 ——
   * 是"不发这条"还是"整个预设失效"。前者才是事实。
   */
  summarySub.textContent = '关掉的不会发出去，其他照发。改完立即生效，也会写回这份预设。';
  summary.append(summarySub);
  body.append(summary);

  /* ── 列表 ── */
  const rowsHost = el(doc, 'div');
  rowsHost.setAttribute('data-role', 'prompts-rows');
  body.append(rowsHost);

  /*
   * 渲染顺序**按 order 走**，与真正发出去的顺序一致。
   *
   * 不按 `prompts` 数组顺序：那样用户看到的次序和实际发出的次序不同，
   * 而"第 3 条到底发没发"这种问题就无从对照。
   */
  const byId = new Map(config.prompts.map((one) => [one.identifier, one]));
  const ordered: StPrompt[] = [];
  for (const entry of order) {
    const prompt = byId.get(entry.identifier);
    if (prompt === undefined) continue;
    ordered.push(prompt);
    byId.delete(entry.identifier);
  }
  /* 顺序表里没有的（理论上不该有）附在最后，不让它们凭空消失 */
  for (const leftover of byId.values()) ordered.push(leftover);

  for (const prompt of ordered) {
    const row = el(doc, 'div', 'nb-prompt-row');
    row.setAttribute('data-role', 'prompt-row');
    row.setAttribute('data-identifier', prompt.identifier);
    /*
     * 能点进编辑时给一个显式标记：样式靠它加"可点"的反馈，
     * 真机判据也靠它区分"这行可编辑"和"这行只是展示"。
     */
    if (callbacks.openEditor !== undefined) row.setAttribute('data-editable', 'true');

    const main = el(doc, 'div', 'nb-prompt-main');

    const head = el(doc, 'div', 'nb-prompt-head');
    const name = el(doc, 'span', 'nb-prompt-name');
    /*
     * 稳定的 `data-role`：真机判据要靠它定位（`probe-prompts-page.mjs`）。
     * 不靠 class —— class 会随样式重构变，而 `data-role` 是这个项目的约定。
     */
    name.setAttribute('data-role', 'prompt-name');
    /*
     * 名字为空时用 identifier 前 8 位兜底。
     *
     * 不能留空行 —— 用户看到一行空白会以为"这条坏了"，
     * 而它可能只是一条没写名字的自定义提示词。
     */
    name.textContent = prompt.name !== '' ? prompt.name : `未命名 · ${prompt.identifier.slice(0, 8)}`;
    const badge = el(doc, 'span', 'nb-prompt-badge');
    badge.textContent = roleBadge(prompt);
    badge.setAttribute('data-role', 'prompt-badge');
    head.append(name, badge);

    /*
     * 内容预览：截一段。
     *
     * 只看名字无法判断"这条到底写了什么"，而开关的决策恰恰依赖内容。
     * 截 60 字 + 省略号，点行展开看全文。
     */
    const preview = el(doc, 'div', 'nb-prompt-preview');
    preview.setAttribute('data-role', 'prompt-preview');
    const bodyText = prompt.content.trim();
    if (bodyText === '') {
      /*
       * 标记位的正文是空的（内容来自卡/世界书/历史）。
       * 这里必须说清"它的内容从哪来"，否则用户会以为这条是坏的。
       */
      preview.textContent = prompt.marker === true ? '（内容来自角色卡 / 世界书 / 对话记录）' : '（这条没有正文）';
      preview.setAttribute('data-empty', 'true');
    } else {
      preview.textContent = bodyText.length > 60 ? `${bodyText.slice(0, 60)}…` : bodyText;
      preview.setAttribute('data-empty', 'false');
    }

    main.append(head, preview);
    main.addEventListener('click', () => {
      /*
       * 点内容区 = 打开编辑页（2026-11-07，用户要求"和原生 ST 一样"）。
       *
       * ST 里点名字就是打开编辑弹窗。编辑页能看到**全文**，所以
       * 原来那个"点开就地展开全文"就多余了 —— 两件事合并成一件。
       *
       * ★ `openEditor` 没给时退回展开（保持这一页单独可用，
       *   也让判据能在不接外壳的情况下测它）。
       */
      if (callbacks.openEditor !== undefined) {
        callbacks.openEditor(prompt.identifier);
        return;
      }
      const expanded = preview.getAttribute('data-expanded') === 'true';
      if (expanded) {
        preview.textContent =
          bodyText.length > 60 ? `${bodyText.slice(0, 60)}…` : bodyText === '' ? preview.textContent : bodyText;
        preview.setAttribute('data-expanded', 'false');
      } else {
        preview.textContent = bodyText === '' ? preview.textContent : bodyText;
        preview.setAttribute('data-expanded', 'true');
      }
    });

    /* 开关 */
    const switchWrap = el(doc, 'label', 'nb-prompt-switch');
    const input = el(doc, 'input', 'nb-switch');
    input.setAttribute('type', 'checkbox');
    input.setAttribute('data-role', 'prompt-toggle');
    (input as unknown as HTMLInputElement).checked = enabledIds.has(prompt.identifier);

    input.addEventListener('click', () => {
      /* 阻止冒泡：否则会同时触发"展开全文" */
      const target = enabledIds.has(prompt.identifier) ? false : true;
      void (async () => {
        const result = await callbacks.togglePrompt(prompt.identifier, target);
        if (result.ok) {
          if (target) enabledIds.add(prompt.identifier);
          else enabledIds.delete(prompt.identifier);
          (input as unknown as HTMLInputElement).checked = target;
          refreshSummary();
          return;
        }
        /*
         * 失败：把勾选状态**退回去**，并说明原因。
         *
         * 不退回去的话用户会以为关掉了 —— 而实际还在发，
         * 这是"设了不生效"里最难查的一种。
         */
        (input as unknown as HTMLInputElement).checked = !target;
        callbacks.onNotify?.(result.reason ?? '开关没保存成功，请重试。', 'danger');
      })();
    });

    switchWrap.append(input);
    row.append(main, switchWrap);
    rowsHost.append(row);
  }

  return root;
}
