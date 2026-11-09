/**
 * 「思考」设置区块（2026-11-07，P0 第三步）。
 *
 * ## 一条铁律：前端一个厂商判断都不做
 *
 * 用户明令：
 *
 * > 不要在前端去猜模型名字或厂商，**必须且只能**依赖 `ReasoningPlan`
 * > 提供的字段来渲染 UI。
 *
 * 所以这个文件里**看不到** `model.startsWith('deepseek')`、
 * `source === 'custom'` 这类判断。它只做三件事：
 *
 * ```text
 *   ① 把用户的操作（点三态 / 拖长度）交给 computePreview 重算
 *   ② 按回来的 preview.plan 选一个分支渲染
 *   ③ 把「能不能用」「要不要置灰」全部照抄 preview 的结论
 * ```
 *
 * 判断逻辑全在 `shared/src/chat/generate.ts` 的 `previewReasoningPlan` 里 ——
 * 与发送路径共用同一份实现，所以**界面显示的和实际发出去的必然一致**。
 *
 * ## 三个分支（对应交付要求 A/B/C）
 *
 * ```text
 *   A 正常    unsupported=false, degraded=false
 *             → 三态可用、长度控件显示、note 用小字提示
 *   B 降级    degraded=true
 *             → 三态置灰并强制显示「开启」、显示"已降级为限制长度"、长度控件仍可用
 *   C 不支持  unsupported=true
 *             → 整个区块置灰、显示"不会生效"
 * ```
 *
 * ★ 分支 B 的文案红线：**不许**写"已为您关闭思考"。
 *   模型还在思考，只是被限了长度。写"已关闭"就是撒谎（用户会以为省了 token）。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';
import { makeSelectTrigger } from './select-popover.ts';
import {
  FAMILY_PRESETS,
  familyPresetOf,
  type ParamFamily,
  type ReasoningPreview,
  type SamplingParams,
  type ThinkingIntent,
} from '@tcs/shared';

/** 三态的顺序与文案。顺序 = 界面从左到右 */
const INTENT_OPTIONS: ReadonlyArray<{ value: ThinkingIntent; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'off', label: '关闭' },
  { value: 'on', label: '开启' },
];

/** 这一块的当前值（外壳持久化时取） */
export interface ReasoningSectionState {
  readonly intent: ThinkingIntent;
  /** 思考长度；`undefined` = 用户没动过（用厂商默认） */
  readonly budget: number | string | undefined;
  /** 用户手动指定的参数族（兜底）。`undefined` = 让系统自动识别 */
  readonly family?: ParamFamily;
}

export interface ReasoningSectionOptions {
  readonly initialIntent: ThinkingIntent;
  readonly initialBudget?: number | string;
  readonly initialEffort?: string;
  /**
   * 用当前的 intent/budget 算一次预览。
   *
   * **必须由外壳注入**，内部实现是调 `previewReasoningPlan`。
   * 这样这个组件不需要知道 source / model / baseUrl ——
   * 也就没有能力去猜厂商。
   */
  readonly computePreview: (
    intent: ThinkingIntent,
    budget: number | string | undefined,
    family: ParamFamily | undefined,
  ) => ReasoningPreview;
  /** 值变化时通知外壳（持久化）。effort 是「推理强度」高级项的值 */
  readonly onChange?: (state: ReasoningSectionState, effort: string) => void;
  /** 上次存的手选参数族（2026-11-07 兜底） */
  readonly initialFamily?: ParamFamily;
}

export interface ReasoningSectionHandle {
  readonly el: ElLike;
  /** 当前值 */
  read: () => ReasoningSectionState & { effort: string };
  /**
   * 外部条件变了（换了源 / 改了模型名）时重算并重绘。
   *
   * ★ 只重绘**自己这一块**，不惊动整页 —— 整页重绘会抢走焦点、清零滚动
   *   （本项目真机踩过：`scrollTop 648→0`、`activeElement: BODY`）。
   */
  refresh: (next?: { intent?: ThinkingIntent; budget?: number | string }) => void;
}

/** 一句提示的样式档位 */
type HintKind = 'normal' | 'warn' | 'muted';

export function makeReasoningSection(
  doc: DocLike,
  options: ReasoningSectionOptions,
): ReasoningSectionHandle {
  let intent: ThinkingIntent = options.initialIntent;
  let budget: number | string | undefined = options.initialBudget;
  let effort: string = options.initialEffort ?? 'auto';
  /** 用户手选的参数族（兜底）。`undefined` = 自动识别 */
  let manualFamily: ParamFamily | undefined = options.initialFamily;
  let lastPreview: ReasoningPreview = options.computePreview(intent, budget, manualFamily);

  const root = el(doc, 'div', 'nb-reasoning');
  root.setAttribute('data-role', 'reasoning-section');

  /* ── 主开关行 ── */
  const switchRow = el(doc, 'div', 'nb-field');
  const switchLabel = el(doc, 'span', 'nb-field-label');
  switchLabel.textContent = '思考';
  const seg = el(doc, 'div', 'nb-seg');
  seg.setAttribute('data-role', 'thinking-intent');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', '思考模式');

  const segButtons = INTENT_OPTIONS.map((opt) => {
    const btn = el(doc, 'button', 'nb-seg-btn');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-role', 'thinking-intent-option');
    btn.setAttribute('data-value', opt.value);
    btn.setAttribute('role', 'radio');
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      /* 置灰时点不动（按钮本身 disabled，这里再兜一道防程序触发） */
      if (btn.getAttribute('disabled') !== null) return;
      if (intent === opt.value) return;
      intent = opt.value;
      paint();
      options.onChange?.(stateNow(), effort);
    });
    return btn;
  });
  seg.append(...segButtons);

  const switchHint = el(doc, 'span', 'nb-field-hint');
  switchHint.setAttribute('data-role', 'reasoning-hint');

  /*
   * 「当前按谁的规则控制」—— 用户要求"在思考下面提示一下目前是使用的
   * 什么模型的控制"（2026-11-07）。
   *
   * 单独一行，不并进 `switchHint`：`switchHint` 会随三态变化重写，
   * 而"当前识别到的是哪一家"是三态之外的信息，两者混在一行会互相覆盖。
   */
  const modelHint = el(doc, 'span', 'nb-field-hint nb-reasoning-model-hint');
  modelHint.setAttribute('data-role', 'reasoning-model-hint');

  switchRow.append(switchLabel, seg, switchHint, modelHint);

  /* ── 思考长度行（没有旋钮就整个隐藏） ── */
  const budgetRow = el(doc, 'div', 'nb-field');
  budgetRow.setAttribute('data-role', 'reasoning-budget-row');
  const budgetLabel = el(doc, 'span', 'nb-field-label');
  budgetLabel.textContent = '思考长度';
  const budgetBody = el(doc, 'div', 'nb-field-body nb-reasoning-budget');
  const budgetHint = el(doc, 'span', 'nb-field-hint');
  budgetHint.setAttribute('data-role', 'reasoning-budget-hint');
  budgetRow.append(budgetLabel, budgetBody, budgetHint);

  /** 数值型：滑杆 + 回显；枚举型：自绘下拉 */
  const paintBudget = (): void => {
    const view = lastPreview.budget;
    budgetBody.replaceChildren();

    if (view === null) {
      budgetRow.hidden = true;
      return;
    }
    budgetRow.hidden = false;
    /*
     * 说明文字分两段（2026-11-07，用户要求说清"思考和长度的关系"）：
     *
     * ```text
     *   第 1 段  budgetNote      —— 这一项此刻到底起不起作用（三种情况）
     *   第 2 段  spec.hint       —— 这一项本身是干什么的
     * ```
     *
     * ★ 顺序不能反。用户最想知道的是"我现在调它有用吗"，
     *   而不是"这个旋钮的定义是什么"。先说结论、后说定义。
     *
     * ★ 不可用时同时置灰，并在文字上说明原因 —— 只置灰不说话
     *   会让人以为是界面坏了。
     */
    const note = lastPreview.budgetNote;
    budgetHint.textContent = note === '' ? view.spec.hint : `${note} ${view.spec.hint}`;
    budgetHint.setAttribute('data-kind', lastPreview.budgetEffective ? 'normal' : 'warn');
    budgetRow.setAttribute('data-disabled', String(!lastPreview.budgetEffective));

    if (view.spec.kind === 'enum') {
      /*
       * ★ 用 `onPick` 而不是"点完 setTimeout 去读 data-value"。
       *
       * `makeSelectTrigger` 本身就提供 onPick：「点选即刻生效」的场景（契约里
       * 写明了两种用法）。轮询 data-value 是脏做法 —— 时序不确定，
       * 而且面板关闭的动画期间读到的可能还是旧值。
       */
      const trigger = makeSelectTrigger(doc, {
        label: '思考长度',
        options: (view.spec.options ?? []).map((v) => ({ value: v, label: enumLabel(v) })),
        current: String(view.value),
        onPick: (picked) => {
          if (picked === String(budget ?? '')) return;
          budget = picked;
          paint();
          options.onChange?.(stateNow(), effort);
        },
      });
      const node = trigger.el;
      node.setAttribute('data-role', 'reasoning-budget-select');
      budgetBody.append(node);
      return;
    }

    /* 数值型 */
    const min = view.spec.min ?? 128;
    const max = view.spec.max ?? 32768;
    const numeric = typeof view.value === 'number' ? view.value : Number(view.value);

    const slider = el(doc, 'input', 'nb-range');
    slider.setAttribute('type', 'range');
    slider.setAttribute('min', String(min));
    slider.setAttribute('max', String(max));
    slider.setAttribute('step', '128');
    slider.setAttribute('data-role', 'reasoning-budget-range');
    slider.setAttribute('aria-label', '思考长度');
    (slider as unknown as HTMLInputElement).value = String(numeric);

    const readout = el(doc, 'span', 'nb-reasoning-readout');
    readout.setAttribute('data-role', 'reasoning-budget-value');
    readout.textContent = String(numeric);

    /*
     * 拖动过程中只更新回显，**松手才落值**。
     *
     * 为什么：每次 `input` 都 `paint()` 会重建滑杆本身 ——
     * 手指还在拖的时候元素被换掉，拖动就断了（真机上表现为"滑一下就弹回去"）。
     */
    slider.addEventListener('input', () => {
      const v = Number((slider as unknown as HTMLInputElement).value);
      if (Number.isFinite(v)) readout.textContent = String(v);
    });
    slider.addEventListener('change', () => {
      const v = Number((slider as unknown as HTMLInputElement).value);
      if (!Number.isFinite(v)) return;
      budget = v;
      paint();
      options.onChange?.(stateNow(), effort);
    });

    budgetBody.append(slider, readout);
  };

  /* ── 高级项折叠区 ── */
  const adv = el(doc, 'div', 'nb-reasoning-adv');
  adv.setAttribute('data-role', 'reasoning-advanced');
  const advHead = el(doc, 'button', 'nb-reasoning-adv-head');
  advHead.setAttribute('type', 'button');
  advHead.setAttribute('data-role', 'reasoning-advanced-head');
  advHead.setAttribute('aria-expanded', 'false');
  const advTitle = el(doc, 'span', 'nb-reasoning-adv-title');
  advTitle.textContent = '高级设置';
  const advChevron = el(doc, 'span', 'nb-reasoning-adv-chevron');
  advChevron.setAttribute('aria-hidden', 'true');
  advChevron.textContent = '›';
  advHead.append(advTitle, advChevron);

  const advPanel = el(doc, 'div', 'nb-reasoning-adv-panel');
  advPanel.setAttribute('data-role', 'reasoning-advanced-panel');
  advPanel.hidden = true;

  const advRow = el(doc, 'div', 'nb-field');
  const advLabel = el(doc, 'span', 'nb-field-label');
  advLabel.textContent = '推理强度';
  const advBody = el(doc, 'div', 'nb-field-body');
  const advHint = el(doc, 'span', 'nb-field-hint');
  advHint.setAttribute('data-role', 'reasoning-effort-hint');
  advRow.append(advLabel, advBody, advHint);

  advPanel.append(advRow);
  adv.append(advHead, advPanel);

  advHead.addEventListener('click', () => {
    const open = advPanel.hidden;
    advPanel.hidden = !open;
    advHead.setAttribute('aria-expanded', String(open));
    advChevron.textContent = open ? '⌄' : '›';
  });

  /** 推理强度的显示名（沿用旧页面的 6 档文案，用户不用重新学） */
  const effortTrigger = makeSelectTrigger(doc, {
    label: '推理强度',
    options: [
      { value: 'auto', label: '自动' },
      { value: 'min', label: '最低' },
      { value: 'low', label: '低' },
      { value: 'medium', label: '中' },
      { value: 'high', label: '高' },
      { value: 'max', label: '最高' },
    ],
    current: effort,
    onPick: (picked) => {
      if (picked === effort) return;
      effort = picked;
      options.onChange?.(stateNow(), effort);
    },
  });
  {
    const node = effortTrigger.el;
    node.setAttribute('data-role', 'reasoning-effort-select');
    advBody.append(node);
  }

  /* ── 分支渲染 ── */
  const setHint = (text: string, kind: HintKind): void => {
    switchHint.textContent = text;
    switchHint.setAttribute('data-kind', kind);
  };

  const paint = (): void => {
    const preview = options.computePreview(intent, budget, manualFamily);
    lastPreview = preview;
    const plan = preview.plan;

    /*
     * 「当前按 X 的规则控制」（2026-11-07，用户要求）。
     *
     * 认出来了就报家门；认不出就明说认不出（并让用户看到下面的手选入口）。
     * ★ 这句话是**信任的基础**：用户改了半天参数，总得知道这些参数
     *   是按哪一家的规矩在发。没有这句，一切设置都像在黑箱里。
     */
    modelHint.textContent =
      preview.profileLabel === null
        ? '当前接口未识别，思考参数不会生效。'
        : `当前按「${preview.profileLabel}」的规则控制思考。`;
    modelHint.setAttribute('data-kind', preview.profileLabel === null ? 'warn' : 'muted');

    /* ── 分支 C：不支持 ── */
    if (plan.unsupported) {
      root.setAttribute('data-branch', 'unsupported');
      for (const btn of segButtons) {
        btn.setAttribute('disabled', 'true');
        btn.setAttribute('aria-checked', 'false');
      }
      setHint(plan.reason ?? '当前接口不在适配表内，思考设置不会生效。', 'warn');
      paintBudget();
      disableBudgetControls(true);
      applyEffortState('none', preview);
      /*
       * 这里是"用户能自救"的入口（2026-11-07，兜底方案）。
       *
       * 认不出接口时，与其让用户干瞪眼，不如让他照厂商文档自选一族。
       */
      paintManualFamily();
      manualRow.hidden = false;
      return;
    }

    /*
     * 其它分支（已认出）：
     *
     * ★ 但如果**用户手选过**，这一行必须继续显示 —— 否则死锁：
     *   手选让识别成功了 ⇒ 行收起 ⇒ 用户再也看不到自己选的是什么，
     *   也**没有任何办法改回自动识别**（那一项就在这个下拉里）。
     *
     * 第一版就是无条件隐藏，被判据「手选族的说明文字来自那族的 hint」抓到：
     * 手选 `enable_thinking` 后 hint 拿不到内容。
     *
     * 所以条件是 `manualFamily !== undefined`：手选过就留着，
     * 让用户随时能改回「不确定（不注入）」。
     */
    if (manualFamily !== undefined) {
      paintManualFamily();
      manualRow.hidden = false;
    } else {
      manualRow.hidden = true;
    }

    /* ── 分支 B：强制降级 ── */
    if (plan.degraded) {
      root.setAttribute('data-branch', 'degraded');
      for (const btn of segButtons) {
        /*
         * 置灰并**强制高亮「开启」**：模型确实在思考。
         * 若高亮「关闭」，用户会以为关掉了 —— 那是撒谎。
         */
        const isOn = btn.getAttribute('data-value') === 'on';
        btn.setAttribute('disabled', 'true');
        btn.setAttribute('aria-checked', String(isOn));
        btn.setAttribute('data-active', String(isOn));
      }
      setHint(
        plan.reason ?? '该模型强制思考，无法完全关闭，已为您降级为限制思考长度。',
        'warn',
      );
      paintBudget();
      /*
       * 长度控件**保持可用** —— 降级就是靠压它来实现的。
       *
       * ★ 用 `preview.budgetEffective` 而不是写死 `false`：
       *   万一将来某个强制思考的模型连长度旋钮都没有（DeepSeek-reasoner
       *   就是），这里要如实置灰，而不是留一个点了没反应的控件。
       */
      disableBudgetControls(!preview.budgetEffective);
      applyEffortState(preview.effortHandled, preview);
      return;
    }

    /* ── 分支 A：正常 ── */
    root.setAttribute('data-branch', 'normal');
    for (const btn of segButtons) {
      btn.removeAttribute('disabled');
      const active = btn.getAttribute('data-value') === intent;
      btn.setAttribute('aria-checked', String(active));
      btn.setAttribute('data-active', String(active));
    }
    /*
     * ★ 提示文字必须按**当前 intent** 分开写（2026-11-07 真机抓到的）。
     *
     * 第一版是 `plan.note ?? '自动 = 不干预…'`。而 `plan.note` 只在
     * `intent === 'auto'` 时才有值 ⇒ 用户点「关闭」后，下面还写着
     * 「自动 = 不干预，用接口自己的默认值」。
     *
     * 真机探针打出来的就是这句：点 off 后 hint 仍是"自动"的解释。
     * 那种错不会报错、不会红判据（判据只断言"非空"），
     * 但用户读到的是**跟自己操作相反**的说明。
     */
    setHint(normalHintOf(plan.note), 'normal');
    paintBudget();
    /*
     * 正常态也要看 `budgetEffective`（2026-11-07 用户要求 4）。
     *
     * 用户选「关闭」且模型能关时，思考已经不发生了 ——
     * 这时「思考长度」置灰并说明"不生效"，而不是留一个能拖但没用的滑杆。
     */
    disableBudgetControls(!preview.budgetEffective);
    applyEffortState(preview.effortHandled, preview);
  };

  /**
   * 长度控件整体置灰（分支 C 用；分支 B 保持可用）。
   *
   * ★ 用 `children` 而不是 `querySelectorAll` —— `ElLike` **没有**
   *   `querySelectorAll`（接口刻意精简，见 chat-view.ts 的说明）。
   *   而 `children` 的类型是 `ChildList`，**不是数组**，
   *   所以必须 `Array.from(...)` 才能用 for-of（memory §103 那条：
   *   `.find()` 在 `HTMLCollection` 上不存在，运行时才炸）。
   */
  function disableBudgetControls(disabled: boolean): void {
    for (const item of Array.from(budgetBody.children)) {
      if (disabled) item.setAttribute('disabled', 'true');
      else item.removeAttribute('disabled');
    }
    /*
     * ★ 始终写 `data-disabled`（`'true'` / `'false'`），**不要 remove**。
     *
     * 早先是 `if (disabled) set else removeAttribute`。那让"可用"和
     * "没人设过"两种状态在属性上无法区分（都是 `null`）——
     * 探针与判据只能靠猜。现在二值明确。
     */
    budgetRow.setAttribute('data-disabled', String(disabled));
  }

  /**
   * 高级项的处理（2026-11-07 修双入口）。
   *
   * ## 三态而不是布尔
   *
   * ```text
   *   'budget'    这家的「思考长度」用的就是 reasoning_effort
   *               ⇒ 整个高级项**隐藏**（不是置灰）
   *   'advanced'  高级项自己可用
   *   'none'      发不出去 ⇒ 置灰 + 说明原因
   * ```
   *
   * ★ 为什么 'budget' 要**隐藏**而不是置灰：
   *   置灰会暗示"这里本来能调、只是现在不行"。而实际是——用户想要的
   *   那个旋钮就在上面（「思考长度」），能调。两个控件指同一字段，
   *   留一个灰的只制造困惑。
   *
   * ★ 这里的判断只有 `preview.effortHandled` 一个来源 ——
   *   组件自己不去看 source/model。用户要求的就是这个。
   */
  function applyEffortState(handled: ReasoningPreview['effortHandled'], preview: ReasoningPreview): void {
    /* 整个折叠区隐藏：连"高级设置"这个入口都不给（里面只剩它一项） */
    adv.hidden = handled === 'budget';

    const node = advBody.children[0];
    if (node !== undefined) {
      if (handled === 'advanced') node.removeAttribute('disabled');
      else node.setAttribute('disabled', 'true');
    }
    advRow.setAttribute('data-disabled', String(handled !== 'advanced'));
    advHint.textContent = effortHintOf(handled, preview);
    advHint.setAttribute('data-kind', handled === 'advanced' ? 'normal' : 'warn');
  }

  /** 高级项说明文字：为什么可用 / 不可用 / 为什么不见了 */
  function effortHintOf(
    handled: ReasoningPreview['effortHandled'],
    preview: ReasoningPreview,
  ): string {
    if (handled === 'advanced') {
      return '仅在原生支持的接口（如 OpenAI / DeepSeek 官方）生效。';
    }
    if (handled === 'budget') {
      /*
       * 这一态整块被隐藏了，理论上用户看不到这句。
       * 但仍要返回有意义的话 —— 将来若改成内联提示，这里就是文案。
       */
      return preview.budget === null
        ? '这个字段已由上面的「思考长度」控制。'
        : `这个字段已由上面的「思考长度」控制（${preview.budget.spec.key}）。`;
    }
    if (preview.plan.channel === 'inject') {
      return `当前走「${preview.profileLabel ?? '注入'}」参数注入通道，推理强度发不出去，所以这里不可用。`;
    }
    return '当前接口不支持推理强度，这里不可用。';
  }

  /**
   * 正常态下按 intent 给说明。
   *
   * 三句话要各自说清"我现在会怎么做"，不能复用同一句 ——
   * 用户点哪个就该看到哪个的后果（真机踩过：点「关闭」却显示「自动」的解释）。
   */
  function normalHintOf(note: string | undefined): string {
    if (intent === 'auto') {
      return note ?? '自动 = 不干预，用接口自己的默认值。';
    }
    if (intent === 'off') {
      return '关闭思考：回复更快、更省 token，但复杂任务的质量会低一些。';
    }
    return '开启思考：模型先推理再回答，更慢也更贵，但复杂任务更准。';
  }

  /* ── 兜底：手动指定参数族（只在"认不出"时出现） ── */
  const manualRow = el(doc, 'div', 'nb-field nb-reasoning-manual');
  manualRow.setAttribute('data-role', 'reasoning-manual-row');
  manualRow.hidden = true;
  const manualLabel = el(doc, 'span', 'nb-field-label');
  manualLabel.textContent = '接口参数';
  const manualBody = el(doc, 'div', 'nb-field-body');
  const manualHint = el(doc, 'span', 'nb-field-hint');
  manualHint.setAttribute('data-role', 'reasoning-manual-hint');
  manualRow.append(manualLabel, manualBody, manualHint);

  const paintManualFamily = (): void => {
    manualBody.replaceChildren();
    const trigger = makeSelectTrigger(doc, {
      label: '接口用哪种思考参数',
      options: [
        { value: '', label: '不确定（不注入）' },
        ...FAMILY_PRESETS.map((p) => ({ value: p.family, label: p.label })),
      ],
      current: manualFamily ?? '',
      onPick: (picked) => {
        manualFamily = picked === '' ? undefined : (picked as ParamFamily);
        options.onChange?.(stateNow(), effort);
        paint();
      },
    });
    const node = trigger.el;
    node.setAttribute('data-role', 'reasoning-manual-select');
    manualBody.append(node);

    const preset = manualFamily === undefined ? null : familyPresetOf(manualFamily);
    manualHint.textContent =
      preset === null
        ? '不确定就留空。如果知道接口文档里写的是哪个字段，选它就能生效。'
        : preset.hint;
  };

  /** 当前状态快照（含手选族） */
  const stateNow = (): ReasoningSectionState =>
    manualFamily === undefined
      ? { intent, budget }
      : { intent, budget, family: manualFamily };

  root.append(switchRow, budgetRow, adv, manualRow);
  paint();

  return {
    el: root,
    read: () => ({ intent, budget, effort, family: manualFamily }),
    refresh: (next) => {
      if (next?.intent !== undefined) intent = next.intent;
      if (next?.budget !== undefined) budget = next.budget;
      paint();
    },
  };
}

/** 枚举档位的中文名（GLM 的 low/high/max 用） */
function enumLabel(value: string): string {
  switch (value) {
    case 'low':
      return '轻';
    case 'medium':
      return '中';
    case 'high':
      return '重';
    case 'max':
      return '最深';
    case 'minimal':
    case 'min':
      return '最轻';
    case 'none':
      return '无';
    default:
      return value;
  }
}

/**
 * 「推理强度」字段的识别。
 *
 * 只用来让设置页**不再单独渲染**这个字段 —— 它已经挪进「高级设置」折叠区，
 * 由本组件统一管。**不是**用来判断厂商。
 */
export function isReasoningEffortField(path: readonly string[]): boolean {
  return path.length === 2 && path[0] === 'oai_settings' && path[1] === 'reasoning_effort';
}

/** 把本组件的值并进采样参数（发送路径用） */
export function mergeReasoningSampling(
  sampling: SamplingParams,
  state: ReasoningSectionState,
): SamplingParams {
  const next: SamplingParams = { ...sampling, thinkingIntent: state.intent };
  if (state.budget !== undefined) next.thinkingBudget = state.budget;
  if (state.family !== undefined) next.thinkingFamily = state.family;
  return next;
}
