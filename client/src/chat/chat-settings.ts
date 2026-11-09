/**
 * 聊天参数配置页（v0.1.7 / 第三批问题二）。
 *
 * ## 两项内容
 *
 * 1. `renderChatSettingsMenu()` —— 四项分组菜单（聊天页顶栏的设置按钮点进来）
 * 2. `renderFieldSection()` —— 某一组字段的表单（点菜单项进去）
 *
 * ## 为什么不做一个"全在一页"的长表单
 *
 * 四组字段加起来十几个，加上世界书与用户设置，一页拉下来要看很久，
 * 而且改错一个数字很难发现。用户要的是"分组与 ST 原生一致"，
 * 那本身就是分页语义 —— ST 里这四项也是分面板的。
 *
 * ## 保存策略：整组一起存，不逐字段自动存
 *
 * 逐字段自动存的问题：`/api/settings/save` 是**整份覆盖**，
 * 每个字段一次请求就是一次"拿旧值覆盖新值"的机会。
 * 整组一个"保存"按钮，只发一次写请求，风险最小。
 */

import {
  CHAT_SETTINGS_GROUPS,
  BEHAVIOR_SECTION,
  FORMATTING_SECTION,
  SAMPLING_SECTION,
  readField,
  validateNumber,
  writeField,
  type SettingField,
  type SettingSection,
  type StSettings,
  type PresetSummary,
  type ParamFamily,
  type ReasoningPreview,
  type ThinkingIntent,
} from '@tcs/shared';

import { el, type DocLike, type ElLike } from './chat-view.ts';
import { makeSelectTrigger } from './select-popover.ts';
import {
  isReasoningEffortField,
  makeReasoningSection,
  type ReasoningSectionHandle,
  type ReasoningSectionState,
} from './reasoning-section.ts';

export interface ChatSettingsCallbacks {
  /** 返回上一级（菜单 ← 分组页，或分组页 ← 聊天页） */
  onBack: () => void;
  /** 读当前 ST 设置。失败时给 null（页面显示"读不到"而不是空白表单） */
  loadSettings: () => Promise<StSettings | null>;
  /**
   * 保存。**只传改动过的路径**，由外壳组进 `mutateSettings`。
   *
   * 为什么不传整份 settings：外壳需要自己走 `mutateSettings`（GET→改→POST），
   * 页面交出去的东西越少，就越不可能绕过那三道防线。
   */
  saveFields: (fields: ReadonlyArray<{ field: SettingField; value: unknown }>) => Promise<{
    ok: boolean;
    reason?: string;
  }>;
  onNotify?: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
  /**
   * 读当前的上下文预算与上一次用量（2026-11-03，第十九批 ④）。
   *
   * 用**回调**而不是把数字当参数传：
   * 这一页在用户改完「上下文长度」并保存后要刷新提示，
   * 而那时外壳手上的值已经变了。传死值会显示旧预算 ——
   * 用户改完 32768 却看到 8192，会以为没生效。
   *
   * 不传则这一块整块不渲染（不显示"预算 0"这种假信息）。
   */
  /**
   * 打开「提示词管理」页（2026-11-03）。
   *
   * ★ 可选，但**漏接会静默失效**：不传就整块不渲染，
   * 用户看不到入口也不会报错。所以外壳必须给。
   * 判据：`test/prompts-page.test.mjs` 断言 shell 里真的接了。
   */
  onOpenPrompts?: () => void;
  /**
   * 思考模式的初值与"预览计算器"（2026-11-07，P0 第三步）。
   *
   * ## 为什么把 `computePreview` 做成回调而不是让这里自己算
   *
   * 用户明令「前端不许猜厂商」。而"当前配置能不能关思考"需要
   * 源 + 地址 + 模型名 + 能力表四样东西 —— 四样都在外壳手上，
   * 判定逻辑在 `shared` 里。
   *
   * 所以这里只负责**摆控件**，结论由外壳调 `previewReasoningPlan` 算好送进来。
   * 不传则整块不渲染（老调用方/测试不会因此炸）。
   */
  thinking?: {
    readonly initialIntent: ThinkingIntent;
    readonly initialBudget?: number | string;
    readonly initialEffort?: string;
    readonly computePreview: (
      intent: ThinkingIntent,
      budget: number | string | undefined,
      family: ParamFamily | undefined,
    ) => ReasoningPreview;
    /** 上次存的手选参数族（兜底） */
    readonly initialFamily?: ParamFamily;
    /** 值变化（外壳负责持久化到本机偏好） */
    readonly onChange?: (state: ReasoningSectionState) => void;
  };
  /**
   * 读当前的上下文预算与上一次用量（2026-11-03，第十九批 ④）。
   *
   * 用**回调**而不是把数字当参数传：
   * 这一页在用户改完「上下文长度」并保存后要刷新提示，
   * 而那时外壳手上的值已经变了。传死值会显示旧预算 ——
   * 用户改完 32768 却看到 8192，会以为没生效。
   *
   * 不传则这一块整块不渲染（不显示"预算 0"这种假信息）。
   */
  budget?: () => {
    /** 预算 = 上下文长度 − 留给回复；0 表示未设置（不裁） */
    budget: number;
    contextLimit: number | undefined;
    responseLimit: number | undefined;
    /** 上一次生成实际发出去多少 token；`null` = 还没生成过 */
    lastUsed: number | null;
    /** 上次被裁掉几条历史 */
    lastTrimmed: number;
    /** 必留项自己就超预算了（要显眼提示） */
    overBudget: boolean;
  };
  /**
   * 「显示完整思考链」开关（2026-11-05 用户要求）。
   *
   * > 在 AI 响应里面做一个开关，打开显示完整思考链，关闭就只显示思考回复中
   *
   * ## 为什么它不是 `SAMPLING_SECTION` 里的一个字段
   *
   * 那一节是 **ST 设置的映射表**，有判据守着"每个字段都必须有映射、
   * 映射里每个键都必须在表里"（`sampling-bridge.ts` 的注释就写着）。
   * 而这个开关是本 App 的**显示偏好**，ST 根本没有对应项 ——
   * 塞进去会让那条判据要么假绿要么报错。
   *
   * 所以它走自己的存取（`localStorage`），只在这一页占一行。
   *
   * ## 为什么传回调而不是传值
   *
   * 用户点开关要**立刻**生效（下次流式就能看到区别），
   * 而这一页是纯渲染函数、不持有状态。传值的话改完得重画整页。
   */
  reasoning?: {
    /** 当前是否显示完整思考链 */
    get: () => boolean;
    /** 用户翻了开关 */
    set: (next: boolean) => void;
  };
  /** 打开某一组的二级页（世界书 / 用户设置）。不传则该组显示"还没做" */
  onOpenGroup?: (groupId: string) => void;
  /**
   * 打开「聊天操作」页（2026-11-03）。
   *
   * ★ 必选（不带 `?`）而不是可选：这个项目最反复的缺陷类型就是
   * "实现存在但没接线" —— 可选回调漏接时**安静地什么都不做**，
   * 界面看起来完全正常，点了毫无反应（`onOpenGroup` 就漏过一次）。
   */
  onOpenActions: () => void;
  /**
   * 读设置失败时，给一份**如实**的归因（2026-10-31 第五批）。
   *
   * 页面自己只有"读到 / 读到 null"两个信息，无法判断引擎死活。
   * 归因需要"引擎真实状态 + 读失败原因"两样，那两样只有外壳有。
   *
   * 不传 = 用中性文案（不猜原因）——
   * **绝不默认说"服务没起来"**，那正是用户报的错判。
   */
  describeReadFailure?: () => { message: string; hint: string };
  /**
   * 预设能力（2026-11-03 / 任务 #259）。
   *
   * ## 为什么整块可选
   *
   * 预设只对「AI 响应配置」有意义（ST 的 `OpenAI Settings` 目录）。
   * 「聊天行为」「AI 回复格式化」那些组没有预设概念，
   * 给它们也渲染一个下拉只会让人困惑。
   *
   * 但**只要传了 `presets`，三个方法就必须齐全** —— 类型上是
   * 一个非可选成员的对象，避免"读得到列表、却点不动"的半接线状态。
   */
  presets?: PresetCallbacks;
}

/** 预设相关的三个动作。给了就三个都要给 */
export interface PresetCallbacks {
  /** 列出全部预设 + 当前用的是哪个 */
  list: () => Promise<{ presets: PresetSummary[]; current: string } | null>;
  /**
   * 切换到一个已有预设。
   *
   * 外壳负责：把预设体按短名→长名映射后写进 `oai_settings`，
   * 并同时更新 `preset_settings_openai`。**不许动连接设置**（模型/地址）。
   */
  apply: (name: string) => Promise<{ ok: boolean; reason?: string; skipped?: number }>;
  /**
   * 选一个 JSON 文件并导入成新预设。
   *
   * 返回导入后的名字，供界面把下拉切过去。
   */
  importFile: () => Promise<{ ok: boolean; name?: string; reason?: string }>;
}

/** 按 id 取字段分区（世界书 / 用户设置不走字段表） */
function sectionOf(groupId: string): SettingSection | null {
  if (groupId === 'behavior') return BEHAVIOR_SECTION;
  if (groupId === 'sampling') return SAMPLING_SECTION;
  if (groupId === 'formatting') return FORMATTING_SECTION;
  return null;
}

/**
 * 四项分组菜单。
 *
 * 顺序与文案来自 `CHAT_SETTINGS_GROUPS`（单一真相，测试守着顺序）。
 * 每项右边一个 chevron，点整行进入。
 */
export function renderChatSettingsMenu(
  doc: DocLike,
  callbacks: ChatSettingsCallbacks,
): ElLike {
  const root = el(doc, 'div', 'nb-page nb-chat-settings');
  root.setAttribute('data-role', 'chat-settings-menu');

  root.append(buildTopbar(doc, '聊天设置', callbacks.onBack));

  const body = el(doc, 'div', 'nb-list');
  body.setAttribute('data-role', 'settings-groups');
  root.append(body);

  /*
   * 「聊天操作」放在最上面（2026-11-03）。
   *
   * 位置理由：它是**动作**（保存检查点、开新聊天…），而下面四组是**配置**。
   * 用户点开"聊天设置"时，十有八九想干点什么而不是调数字 ——
   * 把动作排在配置前面省一次滚动。
   */
  const actionsRow = el(doc, 'button', 'nb-listitem');
  actionsRow.setAttribute('type', 'button');
  actionsRow.setAttribute('data-role', 'settings-actions');
  const actionsMain = el(doc, 'span', 'nb-listitem-main');
  const actionsTitle = el(doc, 'span', 'nb-listitem-title');
  actionsTitle.textContent = '🧭 聊天操作';
  const actionsHint = el(doc, 'span', 'nb-listitem-sub');
  /*
   * ★ 文案里**不许提已隐藏的功能**（2026-11-03）。
   *
   * 原来是「检查点、新聊天、续写、管理聊天文件」—— 而「续写」已被用户
   * 要求从那一页隐藏掉了。文案是产品内**唯一的教学**：写着"有续写"、
   * 点进去却没有，用户会以为功能坏了（§72 记过同类：文案与行为相反）。
   */
  actionsHint.textContent = '检查点、新聊天、管理聊天文件';
  actionsMain.append(actionsTitle, actionsHint);
  const actionsChevron = el(doc, 'span', 'nb-src-chevron');
  actionsChevron.setAttribute('aria-hidden', 'true');
  actionsChevron.textContent = '›';
  actionsRow.append(actionsMain, actionsChevron);
  actionsRow.addEventListener('click', () => {
    callbacks.onOpenActions();
  });
  body.append(actionsRow);

  for (const group of CHAT_SETTINGS_GROUPS) {
    const row = el(doc, 'button', 'nb-listitem');
    row.setAttribute('type', 'button');
    row.setAttribute('data-role', 'settings-group');
    row.setAttribute('data-group', group.id);

    const main = el(doc, 'span', 'nb-listitem-main');
    const title = el(doc, 'span', 'nb-listitem-title');
    title.textContent = group.label;
    const hint = el(doc, 'span', 'nb-listitem-sub');
    hint.textContent = group.hint;
    main.append(title, hint);

    const chevron = el(doc, 'span', 'nb-src-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';

    row.append(main, chevron);
    row.addEventListener('click', () => {
      callbacks.onOpenGroup?.(group.id);
    });
    body.append(row);
  }

  return root;
}

/**
 * 一组的字段表单。
 *
 * ## 加载失败要说清楚，不要给一张空表单
 *
 * 读不到 ST 设置时如果照常渲染表单，用户看到的是"温度 1、上限 300"这些
 * **fallback 值** —— 他会以为那就是现在的设置，然后在上面改，一保存就把
 * 真实设置覆盖成 fallback。这是"整份覆盖"最阴的一处。
 *
 * 所以读失败时只给一句人话 + 一个重试按钮。
 */
export function renderFieldSection(
  doc: DocLike,
  groupId: string,
  callbacks: ChatSettingsCallbacks,
): ElLike {
  const section = sectionOf(groupId);
  const root = el(doc, 'div', 'nb-page nb-chat-settings');
  root.setAttribute('data-role', 'chat-settings-section');
  root.setAttribute('data-group', groupId);

  root.append(buildTopbar(doc, section?.title ?? '聊天设置', callbacks.onBack));

  const body = el(doc, 'div', 'nb-list');
  root.append(body);

  if (section === null) {
    // 世界书 / 用户设置：本版不做字段表单（各有专门页面）
    const note = el(doc, 'p', 'nb-note');
    note.textContent = '这一组在单独页面里，正在加载。';
    body.append(note);
    return root;
  }

  const intro = el(doc, 'p', 'nb-note');
  intro.textContent = section.intro;
  body.append(intro);

  const status = el(doc, 'p', 'nb-note');
  status.setAttribute('data-role', 'settings-status');
  status.textContent = '正在读取当前设置…';
  body.append(status);

  const formHost = el(doc, 'div');
  formHost.setAttribute('data-role', 'settings-form');
  body.append(formHost);

  /**
   * 预设区（2026-11-03）：一个下拉 + 一个「导入 JSON」按钮。
   *
   * ## 为什么放在表单**上面**
   *
   * 切换预设会**整批改写**下面的字段。放在下面的话，用户改了半天参数、
   * 再滚下去切预设，改动就被覆盖了 —— 而且界面上看不出发生过什么
   * （数值变了，但没有提示）。
   *
   * 放最上面还有一层语义：预设是"整套参数"的入口，单项微调在下面。
   *
   * ## 为什么切换后要重新读设置
   *
   * 切换写的是 ST 侧 `oai_settings`，本地 `settings` 快照还是旧的。
   * 不重读就会出现"下拉显示新预设、下面字段还是旧值"——
   * 用户按旧值改一项再保存，等于把预设覆盖回去。
   */
  function renderPresetBar(presets: PresetCallbacks): void {
    const bar = el(doc, 'div', 'nb-preset-bar');
    bar.setAttribute('data-role', 'preset-bar');

    const label = el(doc, 'span', 'nb-preset-label');
    label.textContent = '当前预设';
    bar.append(label);

    /*
     * ★ 预设选择器也**不用原生 `<select>`**（2026-11-03）。
     *
     * 它和枚举字段是同一个系统弹窗 —— 白底白字、样式改不了。
     * ★ 预设选择器也**不用原生 `<select>`**（2026-11-03）。
     *
     * 它和枚举字段是同一个系统弹窗 —— 白底白字、样式改不了。
     * 只换枚举字段、留着预设用原生 select，用户会在同一个页面上
     * 看到一个好下拉和一个坏弹窗，反而更困惑。
     */
    let currentPreset = '';

    const presetSelect = makeSelectTrigger(doc, {
      label: '切换对话补全预设',
      options: [],
      current: '',
      /*
       * 预设是"点选即生效"：切预设本身就是一个动作，不像枚举字段要等保存。
       *
       * ★ 这里用 `applyPreset` 的**函数声明提升**：`makeSelectTrigger` 在
       * `applyPreset` 之前调用，闭包里引用的是同一个函数对象，运行时才执行，
       * 所以顺序没问题。
       */
      onPick: (picked) => {
        if (picked === '' || picked === currentPreset) return;
        applyPreset(picked);
      },
    });
    /*
     * 触发器要能在"切换失败"时拨回原值，也要能被标成"正在切换"。
     * `makeSelectTrigger` 返回的是 `{ el, setOptions, setValue }`，
     * 那两个动作从它身上取，不去读 DOM 属性 —— 读属性等于把渲染细节
     * 当接口用（这一轮已经在别处踩过一次）。
     */
    const select = presetSelect.el;
    select.className = 'nb-input nb-select-trigger nb-preset-select';
    select.setAttribute('data-role', 'preset-select');
    /* 未加载完时先标一下，视觉上变淡（不禁用，禁用会让某些 WebView 吞点击） */
    select.setAttribute('data-loading', 'true');
    bar.append(select);

    /**
     * 切换预设。
     *
     * 抽成函数是因为有两处要调：用户在下拉里点选、以及导入成功后自动切过去。
     * 复制一份的后果是"导入后自动切换"那条分支会慢慢漏掉这里的
     * 失败回滚与提示顺序。
     */
    function applyPreset(picked: string): void {
      void (async () => {
        select.setAttribute('data-loading', 'true');
        const result = await presets.apply(picked);
        select.setAttribute('data-loading', 'false');
        if (!result.ok) {
          callbacks.onNotify?.(result.reason ?? '切换预设失败', 'danger');
          /* 切失败要把选择器拨回原值，否则界面在骗人 */
          presetSelect.setValue(currentPreset);
          return;
        }
        /*
         * ★★★ 顺序：**先 onBack() 再提示**。
         *
         * 2026-11-03 真机复验时抓到的 —— 我在这一处又写反了一次，
         * 而 §86 已经为完全相同的成因改过 `save` 按钮：
         *
         *   `.nb-notify` 挂在 `.nb-topbar` 里，而 `onBack()` → `renderPage()`
         *   会**重建 topbar** ⇒ 刚插进旧 topbar 的提示随旧元素一起脱离文档。
         *
         * 真机现象：切换**成功**了（ST 里 temperature 确实变了），
         * 但屏幕上没有任何反馈 —— 用户会以为没点上，再点一次。
         */
        callbacks.onBack();
        callbacks.onNotify?.(
          result.skipped === undefined
            ? `已切换到「${picked}」`
            : `已切换到「${picked}」（跳过 ${String(result.skipped)} 项连接设置）`,
          'ok',
        );
      })();
    }

    const importBtn = el(doc, 'button', 'nb-mini-btn');
    importBtn.setAttribute('type', 'button');
    importBtn.setAttribute('data-role', 'preset-import');
    importBtn.textContent = '导入 JSON';
    bar.append(importBtn);

    const hint = el(doc, 'span', 'nb-field-hint');
    hint.textContent = '预设是一整套参数。切换只改参数，不会改你的模型和接口地址。';
    bar.append(hint);

    formHost.append(bar);

    /*
     * 「管理提示词」入口（2026-11-03 第二十二批）。
     *
     * ## 为什么放在预设区**正下方**
     *
     * 提示词是**预设的一部分**（整套 `prompts` + `prompt_order` 都在预设文件里）。
     * 用户的动线是"导入/切换预设 → 看看它带了哪些提示词 → 关掉不要的"。
     * 放在别处（比如设置菜单）会多两次点击，而且看不出两者的关系。
     *
     * ## 为什么是按钮不是开关
     *
     * 38 条提示词塞不进这张表单。这里只做"入口"，
     * 列表与开关在单独一页（`chat-prompts-page.ts`）。
     */
    if (callbacks.onOpenPrompts !== undefined) {
      const promptsBtn = el(doc, 'button', 'nb-listitem');
      promptsBtn.setAttribute('type', 'button');
      promptsBtn.setAttribute('data-role', 'open-prompts');

      const promptsMain = el(doc, 'span', 'nb-listitem-main');
      const promptsTitle = el(doc, 'span', 'nb-listitem-title');
      promptsTitle.textContent = '管理提示词';
      const promptsHint = el(doc, 'span', 'nb-listitem-sub');
      promptsHint.textContent = '看这份预设带了哪些提示词，逐条开关';
      promptsMain.append(promptsTitle, promptsHint);

      const promptsChevron = el(doc, 'span', 'nb-src-chevron');
      promptsChevron.setAttribute('aria-hidden', 'true');
      promptsChevron.textContent = '›';

      promptsBtn.append(promptsMain, promptsChevron);
      promptsBtn.addEventListener('click', () => {
        callbacks.onOpenPrompts?.();
      });
      formHost.append(promptsBtn);
    }

    void (async () => {
      const listed = await presets.list();
      if (listed === null) {
        select.setAttribute('data-loading', 'false');
        hint.textContent = '读不到预设列表。可以先用下面的单项设置。';
        return;
      }

      currentPreset = listed.current;
      presetSelect.setOptions(
        listed.presets.length === 0
          ? [
              {
                /*
                 * 文案判据：用户读了知道能做什么。
                 *
                 * 原来写「（一个预设都没有）」—— 只报了现象。
                 * 而用户此刻真正的问题是"那我要怎么弄一个"。旁边的
                 * 「导入 JSON」按钮就是答案，所以直接把话指过去。
                 */
                value: '',
                label: '还没有预设 —— 点右侧「导入 JSON」加一个',
              },
            ]
          : listed.presets.map((preset) => ({ value: preset.name, label: preset.name })),
      );
      presetSelect.setValue(listed.current);
      select.setAttribute('data-loading', 'false');
      select.setAttribute('data-current', listed.current);

    })();


    importBtn.addEventListener('click', () => {
      void (async () => {
        importBtn.setAttribute('data-busy', 'true');
        const result = await presets.importFile();
        importBtn.setAttribute('data-busy', 'false');
        if (!result.ok) {
          /*
           * `reason` 是空串 ⇒ 用户取消了。**什么都不弹** ——
           * 取消不是错误，弹红条会让人以为程序坏了。
           */
          if (result.reason !== undefined && result.reason !== '') {
            callbacks.onNotify?.(result.reason, 'danger');
          }
          return;
        }
        /* 导入完直接切过去：用户导一份配置就是为了用它 */
        callbacks.onBack();
        /* ★ 与上面切换同理：先 onBack 再提示，否则提示被 topbar 重建吞掉 */
        callbacks.onNotify?.(`已导入预设「${result.name ?? ''}」`, 'ok');
      })();
    });
  }

  /*
   * 校验状态：键是 `path.join('.')`，值是错误文案。
   * 放在闭包里而不是读 DOM —— 读 DOM 要在提交时把所有输入再捞一遍，
   * 取值方式就散到两处了（同 `voice-settings.ts` 里 `read()` 的取舍）。
   */
  const errors = new Map<string, string>();
  /*
   * 每行的错误提示元素（键同为 `path.join('.')`）。
   *
   * 存引用而不是提交时 `querySelector` 找：`ElLike` 接口刻意只留 11 个成员
   * （见 `chat-view.ts` 的注释），没有 querySelector。为了这里用一次
   * 就往接口上加成员，会让所有测试里的 stub 都得跟着改 —— 代价不对等。
   */
  const errorBoxes = new Map<string, ElLike>();

  void (async () => {
    const settings = await callbacks.loadSettings();
    if (settings === null) {
      /*
       * 读失败：**不渲染表单**。
       *
       * 渲染了就等于用 fallback 值冒充真实值，用户在上面改，
       * 一保存就把真实设置覆盖成 fallback —— 静默数据丢失。
       *
       * ★ 2026-10-31 第五批：文案原来是写死的
       *   「读不到当前的聊天设置。可能是内嵌服务还没起来。」
       *
       * 那句话把"读失败"归因成"服务没起来" —— 而实测引擎明明在跑
       * （pid 在、8000 LISTEN、/version 返回 1.19.0）。**归因是错的**，
       * 用户据此去查引擎，什么也查不到。
       *
       * 现在交给外壳按"引擎真实状态 + 读失败原因"组合出如实的那一句。
       */
      const note = callbacks.describeReadFailure?.();
      status.textContent =
        note === undefined
          ? '读不到当前的聊天设置。'
          : `${note.message}\n${note.hint}`;
      status.setAttribute('data-kind', 'warn');
      const retry = el(doc, 'button', 'nb-btn');
      retry.setAttribute('type', 'button');
      retry.setAttribute('data-role', 'settings-retry');
      retry.textContent = '重试';
      retry.addEventListener('click', () => {
        callbacks.onNotify?.('重试读取设置', 'info');
        callbacks.onBack();
      });
      body.append(retry);
      return;
    }

    // `ElLike` 没有 remove()（接口刻意极简，见 chat-view.ts 注释）。
    // 用"清空文本 + 隐藏"等价表达"这条提示不该再出现"。
    status.textContent = '';
    status.hidden = true;

    /* 预设区（只有给了回调的组才有，见 `ChatSettingsCallbacks.presets`） */
    if (callbacks.presets !== undefined) {
      renderPresetBar(callbacks.presets);
    }

    /*
     * 上下文预算提示（2026-11-03，第十九批 ④）。
     *
     * ## 为什么放在这一页
     *
     * `上下文长度` 与 `每次生成几个备选`（= 回复额度）就在这张表单里。
     * 预算 = 前者 − 后者，二者改完能立刻在这里看到结果 ——
     * 放在别处的话，用户调完数字没有任何反馈。
     *
     * ## 为什么不是"总 token 数量"一个孤零零的数字
     *
     * 单说「31094」没有意义：用户不知道这是多了还是少了。
     * 写成「预算 31094 token（上下文 32768 − 回复 1674）」才回答得了
     * "这个数是怎么来的、我该调哪个"。
     */
    if (callbacks.budget !== undefined) {
      const info = callbacks.budget();
      const box = el(doc, 'div', 'nb-budget-hint');
      box.setAttribute('data-role', 'budget-hint');
      box.setAttribute('data-over', String(info.overBudget));

      const main = el(doc, 'div', 'nb-budget-hint-main');
      main.textContent =
        info.budget > 0
          ? `上下文预算 ${String(info.budget)} token`
          : '上下文预算未设置（不会裁剪）';
      box.append(main);

      const detail = el(doc, 'div', 'nb-budget-hint-sub');
      /*
       * 副标题要说**两件事**：
       *
       * ```text
       *   ① 超了会怎样   —— 「超了就自动略过最早的对话」
       *   ② 这个数怎么来的 —— 「由 上下文长度 4095 − 回复 300 得来」
       * ```
       *
       * 第一版只写了算式（②），于是用户看到「上下文预算 3795 token」
       * 不知道这是"上限"还是"已用"，更不知道超了会怎样 ——
       * 而这一页正是他调这两个数的地方，最该说清的恰恰是后果。
       *
       * （用户两次明令的文案判据：**用户读了知道能做什么**，
       * 不是"这句话有没有错"。）
       */
      detail.textContent =
        info.budget > 0
          ? `超了就自动略过最早的对话 · 由「上下文长度 ${String(info.contextLimit ?? 0)}」减去「留给回复 ${String(info.responseLimit ?? 0)}」得来`
          : '填好「上下文长度」后才会按预算裁剪';
      box.append(detail);

      /*
       * 上一次生成的用量。
       *
       * 只在真生成过之后才显示 —— 没生成时说"上次用了 0"是误导。
       */
      if (info.lastUsed !== null) {
        const used = el(doc, 'div', 'nb-budget-hint-sub');
        used.setAttribute('data-role', 'budget-used');
        /*
         * 说清"这是上一次真发出去的量"。
         *
         * 只写「上次发送 3795 token」的话，用户会拿它跟预算比 ——
         * 而两者相等时他分不清"刚好顶格"还是"被裁到刚好"。
         * 把裁掉的条数带上就分得清了。
         */
        const trimmedPart =
          info.lastTrimmed > 0 ? `，已略过最早 ${String(info.lastTrimmed)} 条历史` : '';
        used.textContent = `上次发送用了 ${String(info.lastUsed)} token${trimmedPart}`;
        box.append(used);
      }

      formHost.append(box);
    }

    const inputs = new Map<string, ElLike>();
    /**
     * 「思考」区块的句柄（2026-11-07）。
     *
     * 保存时要把它内部的「推理强度」一起提交 —— 那个控件不在 `inputs` 里
     * （它是组件自绘的，不是本函数的字段循环产物）。
     */
    let reasoningHandle: ReasoningSectionHandle | null = null;
    /**
     * 「思考」区块**打开这一页时**的原始值（2026-11-07）。
     *
     * ## 为什么必须记这一份
     *
     * 用户报的原话：
     *
     * > 改了这个开关参数说没有改变，需要配合其他项的修改才可以
     *
     * 真机复现：只把「思考长度」从 `low` 改成 `high`，接着按保存 ——
     * 弹出「没有改动」，而 localStorage 里**已经是** `{"budget":"high"}`。
     *
     * 也就是说**值真的存下去了**，只是这句话在撒谎。原因：思考类的值
     * 走 `onPersistThinking`（改完立即写入），而「保存」按钮只算 ST 字段的
     * diff（`changed`）—— 思考不算 ST 字段，于是 `changed` 为空 ⇒
     * 直接 `return` 并提示"没有改动"。
     *
     * 用户看到这句话的合理推论就是"我的修改没生效"，然后去改别的项"凑"
     * 一次保存 —— 而那时真正起作用的仍然是他改的那一项。
     *
     * 修法：把"思考类是否被改过"也纳入判断，并且**如实说明**它已经存了。
     */
    let initialThinking: { intent: string; budget: string; family: string } | null = null;
    /** 上一个字段的分组标题，用来决定"要不要新起一段" */
    let lastGroup: string | undefined;
    /**
     * 枚举字段的"待提交值"（2026-11-03）。
     *
     * 下拉不再是原生 `<select>`，用户点选后值存在这里，
     * 点「保存」时与其它字段一起提交。不在这里直接存 —— 见 `enum` 分支的注释。
     */
    const pendingEnum = new Map<string, string>();
    /*
     * 每行的错误提示元素也存起来。
     *
     * 不用 `formHost.querySelector(...)` 找它们：`ElLike` 接口**没有** querySelector
     * （列表就是那 11 个成员，见 chat-view.ts）。硬加一个成员会让所有测试里的
     * stub 都得跟着改 —— 为了一个只在这里用一次的能力，代价不对等。
     */

    for (const field of section.fields) {
      const key = field.path.join('.');

      /*
       * 「推理强度」不再单独渲染 —— 它已挪进「思考」区块的「高级设置」折叠区
       * （2026-11-07，P0 第三步）。
       *
       * 在这里**原地插入**整块「思考」区，位置正好是原来那一行：
       * 用户的活动记忆不会失效（"思考相关的项还在那一带"）。
       *
       * ★ 判据只认 `isReasoningEffortField(path)`，那是"字段身份"，
       *   **不是**在猜厂商 —— 厂商判断全部在 shared 的 preview 里。
       */
      if (isReasoningEffortField(field.path)) {
        if (callbacks.thinking !== undefined) {
          const cfg = callbacks.thinking;
          reasoningHandle = makeReasoningSection(doc, {
            initialIntent: cfg.initialIntent,
            initialBudget: cfg.initialBudget,
            initialEffort: readField(settings, field) as string,
            ...(cfg.initialFamily === undefined ? {} : { initialFamily: cfg.initialFamily }),
            computePreview: cfg.computePreview,
            onChange: (state) => cfg.onChange?.(state),
          });
          formHost.append(reasoningHandle.el);
          /*
           * 记下打开页面这一刻的值，供「保存」判断"思考类有没有改过"。
           *
           * 必须在**创建之后立刻**读，不能等到保存时再读 ——
           * 那时读到的已经是用户改完的值，diff 永远为空。
           */
          const first = reasoningHandle.read();
          initialThinking = {
            intent: first.intent,
            budget: String(first.budget ?? ''),
            family: String(first.family ?? ''),
          };
        }
        continue;
      }

      /*
       * 分组标题（2026-11-03 加）。
       *
       * 这一页照 ST 原生面板补到 27 个字段，一条长列表滚下来找不到"温度在哪段"。
       * 分组只是视觉分段 —— 判据靠 `data-group-head` 属性，不靠样式。
       */
      if (field.group !== undefined && field.group !== lastGroup) {
        lastGroup = field.group;
        const head = el(doc, 'div', 'nb-settings-group');
        head.setAttribute('data-role', 'settings-group-head');
        head.setAttribute('data-group', field.group);
        head.textContent = field.group;
        formHost.append(head);
      }

      const row = el(doc, 'div', 'nb-field');
      row.setAttribute('data-field', key);
      if (field.sent === false) row.setAttribute('data-sent', 'false');

      const label = el(doc, 'label', 'nb-field-label');
      label.textContent = field.label;

      const current = readField(settings, field);

      let input: ElLike;
      if (field.kind === 'boolean') {
        input = el(doc, 'input', 'nb-switch');
        input.setAttribute('type', 'checkbox');
        (input as unknown as HTMLInputElement).checked = current === true;
      } else if (field.kind === 'textarea') {
        /*
         * 多行文本（2026-11-03 加）：作者注释 / 反向提示词。
         *
         * 用单行 `input` 编辑这些内容体验很差 —— 看不到换行、
         * 光标一动就滚到看不见的位置，而这类提示词**通常就是多行的**。
         */
        input = el(doc, 'textarea', 'nb-input nb-input--multiline');
        input.setAttribute('rows', '3');
        input.setAttribute('type', 'text');
        (input as unknown as HTMLTextAreaElement).value = String(current);
      } else if (field.kind === 'enum') {
        /*
         * 下拉（2026-11-03 加；同日改为**自己画面板**）。
         *
         * ## 为什么不用原生 `<select>`
         *
         * 用户原话：「AI 响应配置的所有下拉框里面都显示不出来，而且这个下拉框的
         * 样式有点丑，和 APP 的 UI 风格一点也不搭，不要这种弹窗式的」。
         *
         * 真机抽帧看到的：元素本身正常（361×51、近白文字、深色底），
         * 但点开后的系统弹窗是**白底 + 白字** ⇒ 一个字都看不见。
         * 那个弹窗是 WebView 用系统控件画的，只认 `color-scheme`、
         * 不认我们的 token，而且 `option` 的样式**改不了**（写 CSS 无效）。
         *
         * 所以换成 `makeSelectTrigger`：长得像输入框，点开是
         * 我们自己的底部面板（复用 `nb-sheet`，与长按气泡菜单同一套视觉）。
         *
         * ## 值怎么读
         *
         * 原来读 `<select>.value`，现在读 `data-value` 属性。
         * 保存在下面 `save` 分支里对应改过（不再 `HTMLSelectElement.value`）。
         */
        input = makeSelectTrigger(doc, {
          label: field.label,
          options: (field.options ?? []).map((option) => ({
            value: String(option.value),
            label: option.label,
          })),
          current: String(current),
        }).el;
        /*
         * 记下"待提交值"：用户点选后值在控件内部，`data-value` 已经更新，
         * 保存时统一从 `data-value` 读（见下面 save 分支）。
         *
         * 为什么不在这里直接调 `callbacks.saveFields`：
         * 这一页的约定是「改完点保存」，其它字段也都是这样。
         * 下拉若单独即时保存，用户改三个字段会发三次请求，
         * 而且"取消"就没有意义了（已经存进去了）。
         */
      } else {
        input = el(doc, 'input', 'nb-input');
        input.setAttribute('type', field.kind === 'number' ? 'number' : 'text');
        if (field.kind === 'number') {
          if (field.min !== undefined) input.setAttribute('min', String(field.min));
          if (field.max !== undefined) input.setAttribute('max', String(field.max));
          if (field.step !== undefined) input.setAttribute('step', String(field.step));
          // 手机上数字键盘：小数与负数都要
          input.setAttribute('inputmode', 'decimal');
        }
        (input as unknown as HTMLInputElement).value = String(current);
      }
      input.setAttribute('data-role', 'settings-input');
      input.setAttribute('aria-label', field.label);

      /*
       * 暂不支持的字段：**禁用**（2026-11-03 第二十七批）。
       *
       * 用户要求「两个 CFG 在 UI 上先标暂不支持，然后也不可配置」。
       *
       * 为什么不是"只标一句、仍可编辑"：真机 10 次实测证明 CFG 两项
       * 根本不进生成请求，配了完全没效果。可编辑会让人以为配了有用，
       * 而界面上看起来一切正常 —— 这是最难自查的一类误导。
       */
      if (field.unsupported !== undefined) {
        input.setAttribute('disabled', 'true');
        row.setAttribute('data-unsupported', 'true');
      }

      row.append(label, input);

      /*
       * 说明文字：暂不支持的字段显示**原因**，普通字段显示 hint。
       *
       * 两个都给会自相矛盾（"越大越贴提示词" + "暂不支持"），
       * 所以这里二选一。
       */
      if (field.unsupported !== undefined) {
        const blocked = el(doc, 'span', 'nb-field-hint nb-field-hint--unsupported');
        blocked.setAttribute('data-role', 'settings-unsupported');
        blocked.textContent = field.unsupported;
        row.append(blocked);
      } else if (field.hint !== undefined) {
        const hint = el(doc, 'span', 'nb-field-hint');
        hint.textContent = field.hint;
        row.append(hint);
      }

      const error = el(doc, 'span', 'nb-field-error');
      error.setAttribute('data-role', 'settings-error');
      error.hidden = true;
      row.append(error);

      inputs.set(key, input);
      errorBoxes.set(key, error);
      formHost.append(row);
    }

    /*
     * ═══ 「显示完整思考链」开关（2026-11-05 用户要求） ═══
     *
     * > 在 AI 响应里面做一个开关，打开显示完整思考链，关闭就只显示思考回复中
     *
     * ## 为什么放在字段循环**之后**、保存按钮**之前**
     *
     * 它不在 `SAMPLING_SECTION.fields` 里（那是 ST 设置的映射表，
     * 有判据守着"每个字段必须有映射"，见 callbacks 上的注释）。
     * 放在这里既在「AI 响应配置」页里（用户要的位置），
     * 又不会混进 ST 设置那一套读写。
     *
     * ## 为什么**立即生效**而不是等点保存
     *
     * 它是显示偏好，改完马上就该看到区别（下次流式就能对比）。
     * 而且它不涉及 ST —— 点保存时那套 `mutateSettings` 与它无关，
     * 混进去会让"保存失败"连累一个本来已经生效的开关。
     */
    if (callbacks.reasoning !== undefined) {
      const reasoning = callbacks.reasoning;
      const head = el(doc, 'div', 'nb-settings-group');
      head.textContent = '思考过程';
      formHost.append(head);

      const row = el(doc, 'label', 'nb-field nb-field--switch');
      const label = el(doc, 'span', 'nb-field-label');
      label.textContent = '显示完整思考链';

      const toggle = el(doc, 'input', 'nb-switch') as unknown as HTMLInputElement;
      toggle.setAttribute('type', 'checkbox');
      toggle.setAttribute('data-role', 'reasoning-toggle');
      (toggle as unknown as HTMLInputElement).checked = reasoning.get();

      const hint = el(doc, 'span', 'nb-field-hint');
      /*
       * 说清两种状态**分别看到什么** —— 用户才能做决策。
       * 不写"控制思考链的显示行为"这种同义反复。
       */
      const paintHint = (on: boolean): void => {
        hint.textContent = on
          ? '模型思考时，气泡里会显示它完整的思考过程。'
          : '模型思考时，气泡里只显示「思考中…」，不显示具体内容。';
      };
      paintHint((toggle as unknown as HTMLInputElement).checked === true);

      toggle.addEventListener('change', () => {
        const next = (toggle as unknown as HTMLInputElement).checked === true;
        reasoning.set(next);
        paintHint(next);
      });

      row.append(label, toggle as unknown as ElLike, hint);
      formHost.append(row);
    }

    const save = el(doc, 'button', 'nb-btn nb-btn--primary');
    save.setAttribute('type', 'button');
    save.setAttribute('data-role', 'settings-save');
    save.textContent = '保存';
    body.append(save);

    save.addEventListener('click', () => {
      errors.clear();
      const changed: Array<{ field: SettingField; value: unknown }> = [];

      for (const field of section.fields) {
        /*
         * 暂不支持的字段**不参与保存**（2026-11-03）。
         *
         * 控件已禁用，正常操作下读到的就是原值、不会产生变更；
         * 但这里再跳一次是防"某天有人把 disabled 去掉" ——
         * 那会让用户改一个"配了没用"的字段，还以为保存成功了。
         */
        if (field.unsupported !== undefined) continue;

        const key = field.path.join('.');
        const input = inputs.get(key);
        if (input === undefined) continue;

        if (field.kind === 'boolean') {
          const next = (input as unknown as HTMLInputElement).checked === true;
          if (next !== readField(settings, field)) changed.push({ field, value: next });
          continue;
        }

        /*
         * 枚举：从 `data-value` 读（不再有 `<select>.value`），
         * 并把字符串转回该字段真实的类型。
         *
         * `names_behavior` 在 ST 里是数字（-1/0/1/2），而属性永远是字符串。
         * 直接写回去会存成 `"0"`，ST 那边 `switch (names_behavior)` 用的是
         * 严格比较 ⇒ 永不命中 ⇒ 静默按默认处理。所以必须按 `fallback` 的类型还原。
         */
        if (field.kind === 'enum') {
          const raw = pendingEnum.get(key) ?? input.getAttribute('data-value') ?? '';
          const next: unknown = typeof field.fallback === 'number' ? Number(raw) : raw;
          if (next !== readField(settings, field)) changed.push({ field, value: next });
          continue;
        }

        // 数字字段先过校验；文本字段原样
        if (field.kind === 'number') {
          const checked = validateNumber(field, (input as unknown as HTMLInputElement).value ?? '');
          if (!checked.ok) {
            errors.set(key, checked.reason);
            continue;
          }
          if (checked.value !== readField(settings, field)) {
            changed.push({ field, value: checked.value });
          }
          continue;
        }

        const raw = (input as unknown as HTMLInputElement).value ?? '';
        if (raw !== readField(settings, field)) changed.push({ field, value: raw });
      }

      /*
       * 「推理强度」不在 `inputs` 里（它由「思考」区块自绘），
       * 所以单独补一次（2026-11-07）。
       *
       * 不在字段循环里处理的原因：那一行已经被 `continue` 跳过了，
       * 而它的值住在组件内部。`read()` 是唯一出口 —— 也是"显示值与实际值
       * 必然一致"的保证（组件内部同一份变量）。
       */
      if (reasoningHandle !== null) {
        const effField = section.fields.find((f) => isReasoningEffortField(f.path));
        if (effField !== undefined && effField.unsupported === undefined) {
          const { effort } = reasoningHandle.read();
          if (effort !== readField(settings, effField)) {
            changed.push({ field: effField, value: effort });
          }
        }
      }

      // 把校验错误显示到对应行（先全部清掉，再填本次的）
      for (const [key, box] of errorBoxes) {
        const message = errors.get(key);
        box.textContent = message ?? '';
        box.hidden = message === undefined;
      }

      /*
       * 「思考」区块自己那三个值（意图 / 长度 / 手选族）有没有改过。
       *
       * ★ 它们**不是 ST 字段**：走 `onPersistThinking` 写本机偏好，
       *   改完立即生效。所以它们永远不会出现在 `changed` 里 ——
       *   这正是"只改思考长度，保存却说没改动"的成因。
       */
      let thinkingTouched = false;
      if (reasoningHandle !== null && initialThinking !== null) {
        const now = reasoningHandle.read();
        thinkingTouched =
          now.intent !== initialThinking.intent ||
          String(now.budget ?? '') !== initialThinking.budget ||
          String(now.family ?? '') !== initialThinking.family;
      }

      if (errors.size > 0) {
        callbacks.onNotify?.(`有 ${String(errors.size)} 项填得不对，先改一下`, 'warn');
        return;
      }

      /*
       * ★★★ 只改了「思考」时不能说"没有改动"（2026-11-07 真机 bug）。
       *
       * 那些值已经由 `onPersistThinking` 即时写入并推给聊天面板，
       * 所以正确的话是"已保存"，不是"没有改动"。
       *
       * 用户听到"没有改动"的合理推论是"我白改了"，于是去改别的项凑一次保存。
       * 把话说对，这个绕路就没了。
       */
      if (changed.length === 0 && thinkingTouched) {
        callbacks.onNotify?.('思考设置已保存（这一类改完立即生效）', 'ok');
        return;
      }

      if (changed.length === 0) {
        callbacks.onNotify?.('没有改动', 'info');
        return;
      }

      save.setAttribute('data-busy', 'true');
      void callbacks.saveFields(changed).then((result) => {
        /*
         * `ElLike` 没有 removeAttribute。用 `disabled="false"` 而不是删属性：
         * 真实 DOM 里 `disabled="false"` **仍然算禁用**（布尔属性看存在性），
         * 所以这里必须写空字符串之外的合法"未禁用"表达 ——
         * 最稳的是把属性值设成 `"false"` 并把按钮交给 CSS 的 `[disabled]` 处理…
         * 但那样在真实 DOM 里会禁用，所以改成**不设 disabled**，
         * 用 `data-busy` 表示"正在保存"（视觉由 CSS 负责，不禁用点击）。
         */
        save.setAttribute('data-busy', 'false');
        if (result.ok) {
          /*
           * ★★★ 顺序不能反：**先 onBack() 再 onNotify()**（2026-11-03 真机定位）。
           *
           * 原来写的是 `onNotify(...)` → `onBack()`，结果用户**永远看不到**
           * 「已保存 N 项」——`onBack()` 会 `renderPage()` 重建整个 `.nb-topbar`，
           * 而通知正是挂在 topbar 里的，于是刚插进去的提示跟着旧 topbar 一起
           * 脱离文档。
           *
           * 真机取证（`.verify/probe-save-notify.mjs`）：
           *
           * ```text
           *   349ms  add    "已保存 1 项"        ← 确实创建了
           *   509ms  notifyCount = 0             ← 但 document 里已经找不到
           *  3549ms  remove "已保存 1 项"        ← 定时器到点，从废弃的旧 topbar 里摘掉
           *
           *   topbarSame = false                  ← topbar 被换成了新元素
           *   topbarBeforeConnected = false       ← 旧的已脱离文档
           *   notifyInOldTopbar = true            ← 通知还挂在那个废弃元素上
           * ```
           *
           * 这类缺陷 DOM 层面「一切正常」：元素存在、文案对、`console.warn` 也打了，
           * 只有量「它到底在不在 document 里」才看得见。
           */
          callbacks.onBack();
          callbacks.onNotify?.(`已保存 ${String(changed.length)} 项`, 'ok');
          return;
        }
        callbacks.onNotify?.(result.reason ?? '保存失败', 'danger');
      });
    });
  })();

  return root;
}

/** 二级页的顶栏：返回箭头 + 标题 */
/**
 * 页面顶栏（返回 + 标题）。
 *
 * 导出给「聊天操作」「聊天文件」两个页面复用 —— 三个页面的顶栏必须长得一样，
 * 各写一份的下场是返回按钮的 `data-role` 或字形慢慢分叉。
 */
export function buildTopbar(doc: DocLike, titleText: string, onBack: () => void): ElLike {
  const topbar = el(doc, 'div', 'nb-topbar');

  const back = el(doc, 'button', 'nb-icon-btn');
  back.setAttribute('type', 'button');
  back.setAttribute('data-role', 'settings-back');
  back.setAttribute('aria-label', '返回');
  back.textContent = '‹';
  back.addEventListener('click', onBack);

  const title = el(doc, 'h1', 'nb-topbar-title');
  title.textContent = titleText;

  topbar.append(back, title);
  return topbar;
}

/**
 * 把"改了哪些字段"合进一份 settings 副本（给外壳用）。
 *
 * 放在这里而不是外壳里：它和 `writeField` 是同一件事的两半，
 * 分开写容易出现"一个改 path、一个改点号字符串"的分叉。
 */
export function applyFieldChanges(
  settings: StSettings,
  changes: ReadonlyArray<{ field: SettingField; value: unknown }>,
): StSettings {
  let next: StSettings = settings;
  for (const change of changes) {
    next = writeField(next, change.field, change.value) as StSettings;
  }
  return next;
}
