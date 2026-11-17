/**
 * 「角色提示词」板块（2026-11-17，用户在桌面端要求的第 9 个编辑区）。
 *
 * ## 为什么它不是 `BlockId`
 *
 * 这套编辑器的"板块"是为 **ST 卡字段**设计的（`description` 的分段、
 * `personality`、`mes_example`、`character_book`…）。而角色级提示词存在
 * `data.extensions.tcs.prompts` —— 那是**我们自己的扩展键**，不是 ST 字段。
 *
 * 硬塞进 `BLOCK_IDS` 会连环出问题（都是查过代码确认的，不是担心）：
 *
 * ```text
 *   BlockStField 里没有对应值 → word-count / scopes / 审计三处 switch 都要加分支
 *   TEXT_BLOCK_IDS 会把它当正文块 → description 拼装会把提示词写进角色描述
 *   TXT 预设要为它造一个标题行 → 而它本来不是"可导出的正文"
 * ```
 *
 * 所以它走**和「卡片信息」同一条路**：一个独立编辑区，数据落在 passthrough，
 * 不进板块模型。视觉上它排在左栏最后一个，用户感知就是"第九个板块"。
 *
 * ## 与安卓端保持同一套规则
 *
 * ```text
 * 上限        直接复用 `PROMPT_LIMITS` + `validateCharacterPrompts`
 * 写回        直接复用 `writeCharacterPrompts`（深合并，绝不整块替换）
 * 深度默认    4（与 ST 一致，见 `NEW_PROMPT_DRAFT` 的注释）
 * ```
 *
 * ★ 一处都不许另写。两份规则必然分叉，而分叉的表现是"桌面端能存、
 *   手机上打不开"—— 用户完全无从理解。
 *
 * ## 两种条目分开显示
 *
 * ```text
 * 角色专属      这条只有本角色有（own）
 * 覆盖全局      改的是全局预设里的某一条（overrideOrder）
 * ```
 *
 * 合成后用户看到的是"覆盖后的效果"，但**编辑必须分开** ——
 * 它们的生命周期不同：删掉「专属」是删内容，删掉「覆盖」是回到全局。
 * 混成一个列表会让"删除"有两种完全不同的后果。
 */

import {
  NEW_PROMPT_DRAFT,
  PROMPT_LIMITS,
  emptyCharacterPrompts,
  nextOwnPromptId,
  ownIdentifierOf,
  parseCharacterPrompts,
  removeOwnPrompt,
  clearOverride,
  setCharacterPromptContent,
  setCharacterPromptEnabled,
  upsertOwnPrompt,
  validateCharacterPrompts,
  type CharacterPromptConfig,
  type OwnPrompt,
  type PromptDraft,
  type PromptOverride,
  type PromptRole,
} from '@tcs/shared';

import { promptLimitMessages } from '../session/card-prompts.ts';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface PromptsPanelCallbacks {
  /** 从当前卡读（每次调用都现读，不缓存 —— 卡会被打开/替换） */
  getConfig: () => CharacterPromptConfig;
  /** 写回。返回 `false` 表示被上限拦下（组件据此保留编辑态不刷新列表） */
  onChange: (next: CharacterPromptConfig) => boolean;
  logError?: (line: string) => void;
}

export interface PromptsPanel {
  readonly el: HTMLElement;
  /** 卡被替换后重画（`reloadBlocksFromCard` 会调） */
  refresh: () => void;
}

const ROLE_LABEL: Readonly<Record<PromptRole, string>> = {
  system: '系统',
  user: '用户',
  assistant: '助手',
};

const ROLE_VALUES: readonly PromptRole[] = ['system', 'user', 'assistant'];

/** 位置：0 = 跟随顺序，1 = 按深度插入（与 ST 的 RELATIVE / ABSOLUTE 同值） */
const POSITION_ORDER = 0;
const POSITION_DEPTH = 1;

export function createPromptsPanel(callbacks: PromptsPanelCallbacks): PromptsPanel {
  const root = el('section', 'block prompts-block');
  root.dataset['role'] = 'prompts-panel';

  /*
   * 头部沿用**既有板块的类名**（`block-head` / `caret` / `block-title` /
   * `block-meta`）—— 这一块在视觉上就是第九个板块，自己发明一套类名
   * 会让它与上面八块在字号、内边距、hover 上有细微差别，而那种差别
   * 用户只会感觉"这块有点怪"，说不清哪里怪。
   */
  const header = el('button', 'block-head prompts-head');
  header.type = 'button';
  header.setAttribute('aria-expanded', 'false');
  const caret = el('span', 'caret', '▸');
  const title = el('span', 'block-title', '角色提示词');
  const count = el('span', 'block-meta', '');
  header.append(caret, title, count);

  const hint = el('span', 'block-missing prompts-badge', '随卡片走');
  hint.title = '写在 data.extensions.tcs.prompts 里，随卡片文件走；其他工具会忽略它';
  header.append(hint);

  const body = el('div', 'block-body');
  body.hidden = true;

  const intro = el(
    'p',
    'prompts-intro muted',
    '这里是**本角色**的提示词：专属条目只有这个角色有，覆盖条目改的是全局预设里的某一条。' +
      '不改的话全部跟随全局预设。',
  );
  body.append(intro);

  /** 上限计数（与安卓端同一口径：只说已用/上限，超了才说超多少） */
  const quota = el('div', 'prompts-quota');
  body.append(quota);

  /** 违规提示（超限时才有内容） */
  const problems = el('div', 'prompts-problems');
  problems.hidden = true;
  body.append(problems);

  const ownHost = el('div', 'prompts-section');
  body.append(ownHost);

  const overrideHost = el('div', 'prompts-section');
  body.append(overrideHost);

  let expanded = false;

  const paintToggle = (): void => {
    header.setAttribute('aria-expanded', String(expanded));
    body.hidden = !expanded;
    caret.textContent = expanded ? '▾' : '▸';
  };
  header.addEventListener('click', () => {
    expanded = !expanded;
    paintToggle();
  });

  /* ─────────────────────────── 写回 ─────────────────────────── */

  /**
   * 提交一次变更。
   *
   * 顺序：算 next → 交给调用方写 → 成功才重画。
   *
   * ★ 为什么不先重画再写：写失败（超限被拒）时界面已经显示新状态，
   *   用户会以为改成了。这个顺序坑在本项目反复出现过。
   */
  const commit = (mutate: (current: CharacterPromptConfig) => CharacterPromptConfig): void => {
    let next: CharacterPromptConfig;
    try {
      next = mutate(callbacks.getConfig());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.logError?.(`[prompts-panel] 变更失败：${message}`);
      return;
    }
    const accepted = callbacks.onChange(next);
    if (accepted) paint();
  };

  /* ─────────────────────────── 计数 ─────────────────────────── */

  const paintQuota = (config: CharacterPromptConfig): void => {
    quota.replaceChildren();
    const ownCount = config.own.length;
    const overrideCount = Object.keys(config.overrideOrder).length;
    const chars =
      config.own.reduce((sum, one) => sum + one.content.length, 0) +
      Object.values(config.overrideOrder).reduce((sum, one) => sum + (one.content?.length ?? 0), 0);

    const line = (label: string, used: number, limit: number): HTMLElement => {
      const row = el('div', 'prompts-quota-line');
      row.append(el('span', 'prompts-quota-label', label));
      const over = used - limit;
      row.append(
        el(
          'span',
          'prompts-quota-value',
          over > 0
            ? `${String(used)} / ${String(limit)}（超 ${String(over)}）`
            : `${String(used)} / ${String(limit)}`,
        ),
      );
      if (over > 0) row.dataset['over'] = 'true';
      return row;
    };

    quota.append(
      line('专属条目', ownCount, PROMPT_LIMITS.ownCount),
      line('覆盖全局', overrideCount, PROMPT_LIMITS.ownCount),
      line('正文字数', chars, PROMPT_LIMITS.totalContent),
    );
    count.textContent = ownCount + overrideCount === 0 ? '未改动' : `${String(ownCount + overrideCount)} 项`;
  };

  const paintProblems = (config: CharacterPromptConfig): void => {
    const messages = promptLimitMessages(config);
    problems.replaceChildren();
    problems.hidden = messages.length === 0;
    for (const message of messages) problems.append(el('p', 'prompts-problem', message));
  };

  /* ─────────────────────── 专属条目（own） ─────────────────────── */

  /**
   * 还没写内容的「草稿」条目（2026-11-17，自己踩出来的缺陷）。
   *
   * ## 为什么必须有这一层
   *
   * 第一版点「新增」就直接写进卡（`own` 多一条 `content: ''`）。看起来没问题，
   * 实际现象是**点完什么也没多出来** —— 真因在 `parseCharacterPrompts`：
   *
   * ```text
   *   if (id === '' || content.trim() === '') continue;   // 空正文条目被丢弃
   * ```
   *
   * 于是"写进卡"和"读回列表"给出的结果不同：卡里有、界面没有、
   * 用户第二次点新增又多一条空条目。而那条规则本身是对的
   * （移动端保存前就要求正文非空，见 `validateDraft`），
   * 不该为了桌面端去放宽共享语义。
   *
   * 所以：**草稿只活在内存里**，正文一非空才落盘。这既符合"编辑器里
   * 允许有半成品"，也不给卡里塞垃圾。
   */
  const pending: OwnPrompt[] = [];

  /** 把草稿里"已经能落盘"的条目写进卡；返回是否真的写了 */
  const flushPending = (): boolean => {
    const ready = pending.filter((one) => one.content.trim() !== '');
    if (ready.length === 0) return false;

    const accepted = callbacks.onChange(
      ready.reduce((config, one) => upsertOwnPrompt(config, one), callbacks.getConfig()),
    );
    if (!accepted) return false;
    for (const one of ready) {
      const index = pending.indexOf(one);
      if (index >= 0) pending.splice(index, 1);
    }
    return true;
  };

  /**
   * 改一条 own（草稿或已保存）。
   *
   * ## 为什么草稿要单独走一条路
   *
   * 草稿不在卡里（故意不写，否则"读回列表"会把它丢掉，见 `pending` 的注释）。
   * 所以改它只能改内存里的那个对象。写完内容由 `flushPending` 落盘 ——
   * 落盘之后同一个 id 就变成"已存在"，后续编辑自动走 persisted 分支。
   *
   * ★ 用**对象引用**判断是不是草稿，而不是判 id 后缀：
   *   后缀是给人看的，引用才是身份。判后缀会在 `tcs-1-draft1` 这种
   *   恰好被手写成正式 id 的卡上误判。
   */
  const patchOwn = (target: OwnPrompt, patch: Partial<OwnPrompt>): void => {
    const isDraft = pending.includes(target);
    if (isDraft) {
      Object.assign(target, patch);
      /* 内容非空就尝试落盘；落盘成功会把目标从 pending 移走 */
      if (flushPending()) {
        paint();
        return;
      }
      paint();
      return;
    }
    commit((current) => {
      const index = current.own.findIndex((item) => item.id === target.id);
      if (index < 0) return current;
      const own = [...current.own];
      const existing = own[index];
      if (existing === undefined) return current;
      own[index] = { ...existing, ...patch } as OwnPrompt;
      return { ...current, own };
    });
  };

  const buildOwnRow = (one: OwnPrompt, index: number): HTMLElement => {
    const identifier = ownIdentifierOf(one);
    const isDraft = pending.includes(one);
    const wrap = el('div', 'prompts-row');
    wrap.dataset['role'] = 'prompt-own-row';
    wrap.dataset['identifier'] = identifier;
    wrap.dataset['own'] = 'true';

    const head = el('div', 'prompts-row-head');
    const enabled = el('input', 'prompts-check') as HTMLInputElement;
    enabled.type = 'checkbox';
    enabled.checked = one.enabled;
    enabled.dataset['role'] = 'prompt-own-enabled';
    enabled.title = '取消勾选 = 这条不发送';
    enabled.addEventListener('change', () => {
      patchOwn(one, { enabled: enabled.checked });
    });

    const name = el('input', 'prompts-name') as HTMLInputElement;
    name.type = 'text';
    name.value = one.name;
    name.placeholder = '这条提示词的名字';
    name.dataset['role'] = 'prompt-own-name';
    name.maxLength = PROMPT_LIMITS.nameLength;
    /*
     * `change` 而不是 `input`：每次敲键都写回会让"上限校验"在打字中途
     * 弹出（用户还没写完就报"超了"），而且会把脏标记刷成几十次。
     */
    name.addEventListener('change', () => {
      const value = name.value.trim();
      patchOwn(one, { name: value === '' ? '未命名' : value });
    });

    const del = el('button', 'btn small ghost prompts-del', '删除');
    del.type = 'button';
    del.dataset['role'] = 'prompt-own-delete';
    del.addEventListener('click', () => {
      if (isDraft) {
        /* 草稿还没进卡，删它就只是从内存里去掉 —— 不该写卡、也不该报"已更新" */
        const at = pending.indexOf(one);
        if (at >= 0) pending.splice(at, 1);
        paint();
        return;
      }
      commit((current) => removeOwnPrompt(current, one.id));
    });

    /*
     * 草稿标记做成**真实元素**而不是 `::after`：
     * `<input>` 是替换元素，`::after` 在它上面不渲染（不报错，只是什么都没有）。
     */
    if (isDraft) head.append(el('span', 'prompts-draft-tag', '未保存'));
    head.append(enabled, name, del);
    wrap.append(head);

    const content = el('textarea', 'prompts-content') as HTMLTextAreaElement;
    content.rows = 4;
    content.value = one.content;
    content.placeholder = '这条提示词的内容（发送给模型；写了内容才会保存）';
    content.dataset['role'] = 'prompt-own-content';
    content.addEventListener('change', () => {
      patchOwn(one, { content: content.value });
    });
    wrap.append(content);

    const meta = el('div', 'prompts-meta');

    const role = el('select', 'prompts-select') as HTMLSelectElement;
    role.dataset['role'] = 'prompt-own-role';
    for (const value of ROLE_VALUES) {
      const option = el('option', undefined, ROLE_LABEL[value]) as HTMLOptionElement;
      option.value = value;
      role.append(option);
    }
    role.value = one.role;
    role.addEventListener('change', () => {
      patchOwn(one, { role: role.value as PromptRole });
    });

    const position = el('select', 'prompts-select') as HTMLSelectElement;
    position.dataset['role'] = 'prompt-own-position';
    const orderOption = el('option', undefined, '跟随顺序') as HTMLOptionElement;
    orderOption.value = String(POSITION_ORDER);
    const depthOption = el('option', undefined, '按深度插入') as HTMLOptionElement;
    depthOption.value = String(POSITION_DEPTH);
    position.append(orderOption, depthOption);

    const injection = one.injection ?? { position: POSITION_ORDER, depth: 4, order: 100 };
    position.value = String(injection.position);

    const depth = el('input', 'prompts-number') as HTMLInputElement;
    depth.type = 'number';
    depth.min = '0';
    depth.value = String(injection.depth);
    depth.dataset['role'] = 'prompt-own-depth';
    depth.title = '0 = 在最后一条消息之后，1 = 在最后一条消息之前，依次往前；一般用 4';
    /* 深度只在"按深度插入"时有意义 —— 跟随顺序时置灰，但仍显示值 */
    depth.disabled = injection.position !== POSITION_DEPTH;

    const order = el('input', 'prompts-number') as HTMLInputElement;
    order.type = 'number';
    order.value = String(injection.order);
    order.dataset['role'] = 'prompt-own-order';
    order.title = '同一深度内的次序，小的先发（ST 默认 100）';

    const applyInjection = (patch: Partial<{ position: number; depth: number; order: number }>): void => {
      const base = one.injection ?? { position: POSITION_ORDER, depth: 4, order: 100 };
      patchOwn(one, { injection: { ...base, ...patch } });
    };

    position.addEventListener('change', () => {
      const next = position.value === String(POSITION_DEPTH) ? POSITION_DEPTH : POSITION_ORDER;
      depth.disabled = next !== POSITION_DEPTH;
      applyInjection({ position: next });
    });
    depth.addEventListener('change', () => {
      const parsed = Number.parseInt(depth.value, 10);
      applyInjection({ depth: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 });
    });
    order.addEventListener('change', () => {
      const parsed = Number.parseInt(order.value, 10);
      applyInjection({ order: Number.isFinite(parsed) ? parsed : 100 });
    });

    meta.append(
      el('span', 'prompts-meta-label', '身份'),
      role,
      el('span', 'prompts-meta-label', '位置'),
      position,
      el('span', 'prompts-meta-label', '深度'),
      depth,
      el('span', 'prompts-meta-label', '排序'),
      order,
    );
    wrap.append(meta);

    /* 序号：用户说"第 3 条"时能对上（与上限报错里的"第 N 条"同源） */
    wrap.dataset['index'] = String(index + 1);
    return wrap;
  };

  const paintOwn = (config: CharacterPromptConfig): void => {
    ownHost.replaceChildren();
    const head = el('div', 'prompts-section-head');
    head.append(el('h3', 'prompts-section-title', '专属条目'));
    const add = el('button', 'btn small', '＋ 新增');
    add.type = 'button';
    add.dataset['role'] = 'prompt-own-add';
    head.append(add);
    ownHost.append(head);

    const note = el(
      'p',
      'prompts-section-note muted',
      '这些条目只属于本角色，全局预设里没有。删掉就是真的删掉。',
    );
    ownHost.append(note);

    add.addEventListener('click', () => {
      /*
       * 新建的初值与安卓端**完全一致**（`NEW_PROMPT_DRAFT`）。
       * 自己写一份 `{position:0, depth:0}` 会让两端新建出来的条目行为不同，
       * 而用户只会觉得"桌面端建的不生效"。
       */
      const draft: PromptDraft = { ...NEW_PROMPT_DRAFT, name: '新提示词' };
      pending.push({
        /* 草稿 id 只要在本会话内唯一即可 —— 落盘时用的是它自己 */
        id: nextOwnPromptId(config) + '-draft' + String(pending.length + 1),
        name: draft.name,
        content: '',
        role: draft.role,
        enabled: true,
        injection: {
          position: draft.injectionPosition,
          depth: draft.injectionDepth,
          order: draft.injectionOrder,
        },
      });
      paint();
    });

    if (pending.length === 0 && config.own.length === 0) {
      ownHost.append(el('p', 'prompts-empty muted', '还没有专属条目。'));
      return;
    }

    /*
     * 草稿排在前面：用户刚点完新增，最想看到的就是它。
     * `data-draft="1"` 让样式标出"还没保存"，也让探针能与已保存的区分。
     */
    for (const one of pending) {
      const row = buildOwnRow(one, 0);
      row.dataset['draft'] = '1';
      ownHost.append(row);
    }
    config.own.forEach((one, index) => {
      ownHost.append(buildOwnRow(one, index));
    });
  };

  /* ───────────────────── 覆盖条目（overrideOrder） ───────────────────── */

  const buildOverrideRow = (identifier: string, one: PromptOverride): HTMLElement => {
    const wrap = el('div', 'prompts-row');
    wrap.dataset['role'] = 'prompt-override-row';
    wrap.dataset['identifier'] = identifier;

    const head = el('div', 'prompts-row-head');
    head.append(el('span', 'prompts-override-id', identifier));

    /*
     * 开关覆盖：只在**本来就有** `enabled` 时才画勾选框。
     *
     * 为什么：`{ content: '...' }` 这种只改正文的条目没有 enabled 语义，
     * 画一个"已勾选"的框会让用户以为他设过开关。要设的话由下面的按钮加。
     */
    if (one.enabled !== undefined) {
      const enabled = el('input', 'prompts-check') as HTMLInputElement;
      enabled.type = 'checkbox';
      enabled.checked = one.enabled;
      enabled.dataset['role'] = 'prompt-override-enabled';
      enabled.title = '取消勾选 = 本角色不发送这一条（全局仍然开着）';
      enabled.addEventListener('change', () => {
        const value = enabled.checked;
        commit((current) => ({
          ...current,
          overrideOrder: {
            ...current.overrideOrder,
            [identifier]: { ...current.overrideOrder[identifier], enabled: value },
          },
        }));
      });
      head.append(enabled);
    }

    const del = el('button', 'btn small ghost prompts-del', '恢复全局');
    del.type = 'button';
    del.dataset['role'] = 'prompt-override-clear';
    del.title = '删掉这一处覆盖，回到全局预设';
    del.addEventListener('click', () => {
      commit((current) => clearOverride(current, identifier));
    });
    head.append(del);
    wrap.append(head);

    /*
     * 正文覆盖：只有 `main` / `nsfw` / `jailbreak` 三个槽允许（与
     * `CONTENT_OVERRIDABLE` 同源）。其余槽的正文来自卡片或时序，
     * 覆盖它会让"角色描述"和"卡里的描述"两个真相打架 —— 所以不画输入框，
     * 而不是画了再拒绝（画了不能改是故意惹人烦）。
     */
    if (one.content !== undefined) {
      const content = el('textarea', 'prompts-content') as HTMLTextAreaElement;
      content.rows = 3;
      content.value = one.content;
      content.dataset['role'] = 'prompt-override-content';
      content.addEventListener('change', () => {
        const value = content.value;
        commit((current) => ({
          ...current,
          overrideOrder: {
            ...current.overrideOrder,
            [identifier]: { ...current.overrideOrder[identifier], content: value },
          },
        }));
      });
      wrap.append(content);
    } else {
      wrap.append(
        el(
          'p',
          'prompts-section-note muted',
          '只覆盖了开关。要改正文，请在手机上改（标记位的正文来自卡片与时序，不在这里覆盖）。',
        ),
      );
    }

    return wrap;
  };

  const paintOverride = (config: CharacterPromptConfig): void => {
    overrideHost.replaceChildren();
    const head = el('div', 'prompts-section-head');
    head.append(el('h3', 'prompts-section-title', '覆盖全局'));
    overrideHost.append(head);

    const note = el(
      'p',
      'prompts-section-note muted',
      '这些是从全局预设里"改一条"：删掉就回到全局。想加新的，先在上面加专属条目。',
    );
    overrideHost.append(note);

    const identifiers = Object.keys(config.overrideOrder);
    if (identifiers.length === 0) {
      overrideHost.append(el('p', 'prompts-empty muted', '没有覆盖任何全局条目。'));
      return;
    }
    for (const identifier of identifiers) {
      const one = config.overrideOrder[identifier];
      if (one === undefined) continue; /* noUncheckedIndexedAccess 守卫 */
      overrideHost.append(buildOverrideRow(identifier, one));
    }
  };

  /* ─────────────────────────── 总装 ─────────────────────────── */

  function paint(): void {
    let config: CharacterPromptConfig;
    try {
      config = callbacks.getConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.logError?.(`[prompts-panel] 读配置失败：${message}`);
      config = emptyCharacterPrompts();
    }
    paintQuota(config);
    paintProblems(config);
    paintOwn(config);
    paintOverride(config);
  }

  root.append(header, body);
  paintToggle();
  paint();

  return {
    el: root,
    refresh: () => {
      paint();
    },
  };
}
