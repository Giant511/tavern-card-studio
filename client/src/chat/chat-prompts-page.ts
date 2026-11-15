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
import type { CharacterPromptConfig, ParsedPromptConfig, StPrompt } from '@tcs/shared';
import { PROMPT_LIMITS, hasOverride, ownIdentifierOf } from '@tcs/shared';

/**
 * 当前在改"谁的那一份"（v0.2.0）。
 *
 * ```text
 *   global     改的是当前预设 —— 所有角色一起变（v0.1.10 的行为）
 *   character  改的是这张卡 —— 只有这个角色变，预设不动
 * ```
 */
export type PromptScope = 'global' | 'character';

/**
 * 角色作用域需要的一切。
 *
 * 整体可选：拿不到（没选角色 / 还没读到卡）时页面只显示「全局」，
 * 不画一个点了没反应的「本角色」切换 —— 假控件比没有更糟。
 */
export interface CharacterPromptScope {
  /** 角色名（切换按钮上显示，让用户知道在给谁改） */
  characterName: string;
  /** 当前角色的覆盖配置（可能为空配置） */
  config: CharacterPromptConfig;
  /** 切换作用域 */
  onScopeChange: (scope: PromptScope) => void;
  /** 单条恢复全局（删掉这条覆盖，不动其它） */
  onRestoreOne: (identifier: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 整角色恢复卡片默认（清空全部覆盖与角色特有项） */
  onRestoreAll: () => Promise<{ ok: boolean; reason?: string }>;
}

/** 页面回调 */
export interface ChatPromptsCallbacks {
  onBack: () => void;
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
  /** 角色作用域（v0.2.0）。缺省 = 只有全局 */
  character?: CharacterPromptScope;
  /** 当前作用域。缺省 `'global'` */
  scope?: PromptScope;
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
 * 作用域切换条。两个胶囊，当前那个高亮。
 *
 * ## 为什么写"存到哪"而不只写"全局/本角色"
 *
 * 用户第一次看到这个切换时，最需要知道的不是两个名字，而是
 * **"我在这里改，会影响谁"**：
 *
 * ```text
 *   全局     所有角色一起变（写回预设文件）
 *   本角色   只有这个角色变（写进这张卡）
 * ```
 *
 * 只写名字的话，用户会以为「本角色」是"查看模式"，
 * 于是不敢点，或者点了发现开关变了却不知道变了什么。
 */
function buildScopeBar(doc: DocLike, character: CharacterPromptScope, scope: PromptScope): ElLike {
  const wrap = el(doc, 'div', 'nb-scope-bar');
  wrap.setAttribute('data-role', 'prompts-scope-bar');

  const make = (key: PromptScope, label: string, hint: string): ElLike => {
    const btn = el(doc, 'button', `nb-scope-btn${scope === key ? ' is-active' : ''}`);
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-role', `prompts-scope-${key}`);
    btn.setAttribute('aria-pressed', scope === key ? 'true' : 'false');
    const main = el(doc, 'span', 'nb-scope-btn-label');
    main.textContent = label;
    const sub = el(doc, 'span', 'nb-scope-btn-hint');
    sub.textContent = hint;
    btn.append(main, sub);
    /*
     * 点当前那个不重绘 —— 重绘会清零滚动位置（§130 真机实测过
     * `scrollTop 648→0`），而用户只是想确认一下。
     */
    if (scope !== key) btn.addEventListener('click', () => character.onScopeChange(key));
    return btn;
  };

  wrap.append(
    make('global', '全局', '所有角色'),
    make('character', character.characterName, '只这个角色'),
  );
  return wrap;
}

/**
 * 上限计数条（PLAN §5.6）。
 *
 * 显示"已用 / 上限"而不是只显示一条进度 —— 用户要据此判断"还能不能加"，
 * 而"还剩 3 条"比"用了 17 条"更容易直接决策。所以两样都给。
 *
 * `data-over` 标出来超限的那些（正常情况下不应该出现，因为保存会被拒；
 * 但用户在别的工具里改过卡就可能读到超限数据，那时要显眼）。
 */
function buildQuotaBar(doc: DocLike, config: CharacterPromptConfig): ElLike {
  const wrap = el(doc, 'div', 'nb-quota-bar');
  wrap.setAttribute('data-role', 'prompts-quota');

  const ownCount = config.own.length;
  const totalChars =
    config.own.reduce((sum, one) => sum + one.content.length, 0) +
    Object.values(config.overrideOrder).reduce((sum, one) => sum + (one.content?.length ?? 0), 0);

  const line = (label: string, used: number, limit: number): ElLike => {
    const row = el(doc, 'div', 'nb-quota-line');
    row.setAttribute('data-role', `prompts-quota-${label === '角色特有' ? 'count' : 'chars'}`);
    const name = el(doc, 'span', 'nb-quota-label');
    name.textContent = label;
    const value = el(doc, 'span', 'nb-quota-value');
    const remaining = limit - used;
    value.textContent =
      remaining >= 0
        ? `${String(used)} / ${String(limit)}（还能加 ${String(remaining)}）`
        : `${String(used)} / ${String(limit)}（超 ${String(-remaining)}）`;
    if (remaining < 0) row.setAttribute('data-over', 'true');
    row.append(name, value);
    return row;
  };

  wrap.append(
    line('角色特有', ownCount, PROMPT_LIMITS.ownCount),
    line('正文字数', totalChars, PROMPT_LIMITS.totalContent),
  );

  const note = el(doc, 'div', 'nb-quota-note');
  /*
   * 这句必须写：用户会问"为什么我只能加 20 条"。
   * 答案（卡片藏在 PNG 里、base64 ×1.33）不需要写，但"藏哪"要写 ——
   * 它决定了"为什么换个 App 可能丢"。
   */
  note.textContent = `存在角色卡里，换设备也能带走。每条正文上限 ${String(PROMPT_LIMITS.contentPerPrompt)} 字符。`;
  wrap.append(note);
  return wrap;
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

  const scope: PromptScope = callbacks.scope ?? 'global';
  const character = callbacks.character;
  const inCharacter = scope === 'character' && character !== undefined;

  /* ── 作用域切换 ── */
  if (character !== undefined) {
    body.append(buildScopeBar(doc, character, scope));
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
  summarySub.setAttribute('data-role', 'prompts-summary-sub');
  /*
   * 说清"关掉会怎样" **以及"改的东西存到哪"**。
   *
   * 只说数字的话，用户不知道关掉一条的后果 ——
   * 是"不发这条"还是"整个预设失效"。前者才是事实。
   *
   * 第二句按作用域变：这是 v0.2.0 最容易误会的点 ——
   * 同一个开关，在两个作用域下改的是**完全不同的东西**。
   */
  summarySub.textContent = inCharacter
    ? `关掉的不会发出去，其他照发。这里的改动只影响「${character.characterName}」，存在卡里。`
    : '关掉的不会发出去，其他照发。改完立即生效，也会写回这份预设。';
  summary.append(summarySub);

  /*
   * 上限计数（PLAN §5.6，用户明确要求"放到 UI 上"）。
   *
   * 只在角色作用域显示：全局作用域改的是预设文件，没有这套上限。
   * 显示**剩余可用**而不是只显示已用 —— "还能加几条"是用户真正要判断的。
   */
  if (inCharacter) {
    summary.append(buildQuotaBar(doc, character.config));

    /*
     * 整角色「恢复卡片默认」。
     *
     * 只在**真有改动时**才画。没改过就画一个按钮，点了什么也不会变，
     * 用户会以为按钮坏了 —— 而它只是没有可恢复的东西。
     */
    if (character.config.own.length > 0 || Object.keys(character.config.overrideOrder).length > 0) {
      const reset = el(doc, 'button', 'nb-mini-btn nb-mini-btn--danger');
      reset.setAttribute('type', 'button');
      reset.setAttribute('data-role', 'prompts-restore-all');
      reset.textContent = '恢复卡片默认';
      reset.addEventListener('click', () => {
        void (async () => {
          /*
           * 两步确认，与「删除聊天文件」同一套手势。
           *
           * 这个操作**不可逆**：用户的改动和卡作者写的那份存在同一个位置
           * （`extensions.tcs.prompts`），删掉之后连原版也读不回来。
           * 不用 `confirm()` —— 它在 Android WebView 里阻塞主线程（§129）。
           */
          if (reset.getAttribute('data-armed') !== 'true') {
            reset.setAttribute('data-armed', 'true');
            reset.textContent = '确认恢复？改动会丢掉';
            callbacks.onNotify?.(
              `再点一次就清掉「${character.characterName}」的全部提示词改动。`,
              'warn',
            );
            return;
          }
          const result = await character.onRestoreAll();
          if (!result.ok) {
            /* 失败要把按钮退回去，否则它还挂着"确认恢复？" */
            reset.removeAttribute('data-armed');
            reset.textContent = '恢复卡片默认';
            callbacks.onNotify?.(result.reason ?? '恢复失败，请重试。', 'danger');
          }
        })();
      });
      summary.append(reset);
    }
  }
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
     * 「本角色已改」标记（v0.2.0）。
     *
     * 只在角色作用域显示：全局作用域下"有没有角色覆盖"是别人的事，
     * 混进来会让用户以为这条在全局下也被改过。
     */
    const overridden = inCharacter && hasOverride(character.config, prompt.identifier);
    if (overridden) row.setAttribute('data-overridden', 'true');
    /*
     * 角色特有项（`tcs-*`）：全局预设里没有这一条，是卡自带的。
     * 标出来，否则用户会去全局作用域里找它 —— 找不到。
     */
    const isOwn = inCharacter && character.config.own.some(
      (one) => ownIdentifierOf(one) === prompt.identifier,
    );
    if (isOwn) row.setAttribute('data-own', 'true');
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

    /*
     * 「本角色已改」标记 + 单条「恢复」按钮（v0.2.0）。
     *
     * 只在角色作用域且这条真有覆盖时出现。**必须比开关更靠近眼睛**：
     * 用户看到"这条关着"时要能立刻分辨是"全局就关着"还是"我在这里关的"，
     * 否则他会去全局作用域找一个不存在的差异。
     */
    if (overridden && character !== undefined) {
      const tagRow = el(doc, 'div', 'nb-prompt-override-row');
      const tag = el(doc, 'span', 'nb-prompt-override-tag');
      tag.setAttribute('data-role', 'prompt-overridden-tag');
      tag.textContent = '本角色已改';
      const restore = el(doc, 'button', 'nb-prompt-restore');
      restore.setAttribute('type', 'button');
      restore.setAttribute('data-role', 'prompt-restore-one');
      restore.textContent = '恢复全局';
      restore.addEventListener('click', (event) => {
        /* 别让点击冒泡到 `main` ⇒ 那会打开编辑页 */
        (event as { stopPropagation?: () => void }).stopPropagation?.();
        void (async () => {
          const result = await character.onRestoreOne(prompt.identifier);
          if (!result.ok) {
            callbacks.onNotify?.(result.reason ?? '恢复失败，请重试。', 'danger');
            return;
          }
          callbacks.onNotify?.('已恢复成全局的设置', 'ok');
        })();
      });
      tagRow.append(tag, restore);
      main.append(tagRow);
    }

    if (isOwn) {
      const tagRow = el(doc, 'div', 'nb-prompt-override-row');
      const tag = el(doc, 'span', 'nb-prompt-override-tag');
      tag.setAttribute('data-role', 'prompt-own-tag');
      /*
       * 说清"这条只在这个角色下有" —— 用户去全局作用域找不到它时，
       * 得能回想起为什么。
       */
      tag.textContent = '角色特有（全局里没有这条）';
      tagRow.append(tag);
      main.append(tagRow);
    }

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
