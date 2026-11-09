/**
 * API 连接页（v0.1.7 / T15.5）。
 *
 * ## 三条硬约束，每条都来自契约里点名的坑
 *
 * 1. **六后端源**（决策 #269）。其余源**明确报错，不许静默回退** ——
 *    用户选了不支持的源却按 openai 发出去，等于拿着 A 的 key 打 B 的域名。
 * 2. **采样参数随请求体带**。ST 服务端**不读** settings 里的采样参数，
 *    只认请求体（这个页面上填的值必须拼进 `StGenerateRequest`）。
 * 3. **key 只写不读**（契约 §3.5）。写进去之后读回来是掩码，
 *    所以界面上**不许尝试回显** —— 那是拿不到还要假装拿到了。
 * 界面上的做法是：输入框永远空白 + 一句"已保存，不会再显示"。
 *
 * ## 存储位置
 *
 * 采样参数与所选后端源存在**本机应用配置**里（每次请求时拼进请求体）；
 * key 与 model 走 ST 的 `/api/secrets/write` 与 `/api/settings/save`。
 * 这条分工不能混：把 key 存本地等于我们自己保管凭据，而它本该在 ST 手里。
 */

import {
  CHAT_SOURCE_LABELS,
  CHAT_SOURCES,
  initialKeyState,
  isSupportedChatSource,
  keyFieldPlaceholder,
  keyFieldType,
  keyFieldValue,
  keyStateOnBlur,
  keyStateOnFocus,
  keyToSave,
  unsupportedSourceMessage,
  type KeyFieldState,
  type StChatSource,
} from '@tcs/shared';

import { describeBridgeError } from '@tcs/shared';
import { el, type DocLike, type ElLike } from './chat-view.ts';
/**
 * 这一页只需要一项 ST 能力：**写密钥**。
 *
 * ## 为什么不直接收 `StChatBridge`
 *
 * 2026-10-31 第五批：`bridge.writeSecret()` 直接调 Tauri 命令，**绕过了
 * 连接门**（外壳的 `withConnection`）。而 Rust 侧 `StChatState.api`
 * 在没 connect 之前是 None，于是第一次保存必然返回
 * `StUnavailable` —— 真机实测就是"保存失败：连不上 SillyTavern"。
 *
 * 把依赖收窄成这一个方法之后，外壳可以传一个**包过连接门**的实现进来，
 * 页面也就没有能力绕过它。
 */
export interface SecretWriter {
  /*
   * 返回 Promise<unknown> 而不是 Promise<void>：
   * 真实实现（StChatBridge.writeSecret）返回 ST 的响应体文本。
   * 这一页**不关心**那个响应 —— 但类型上若强求 void，调用方就得包一层
   * 无意义的 .then(() => {})。用 unknown 表达"返回值用不到"。
   */
  writeSecret: (key: string, value: string) => Promise<unknown>;
}

/**
 * API 连接页的状态。
 *
 * ## 2026-10-31 第四批：采样参数已从这里移除
 *
 * 用户要求「采样参数移入聊天页的 AI 响应配置页 —— 采样随生成请求体下发，
 * 属聊天行为配置，非账户级配置」。所以这一页现在**只放连接类字段**：
 * 接口源 / 模型名 / key / 自定义地址。
 *
 * 采样参数去哪了：`shared/src/chat/settings-schema.ts` 的 `SAMPLING_SECTION`
 * （存 ST 设置的 `oai_settings.*`），入口是聊天页顶栏齿轮 →「AI 响应配置」。
 *
 * ★ 迁移前它存在 **localStorage**（`tcs.mobile.apiState`），不是 ST 设置。
 * 用户的要求是"仍走 ST 设置接口"，所以这次实际上把存储也换了
 * （见 `.verify/task1-sampling-evidence.md` 第四节）。
 */
export interface ApiPageState {
  source: StChatSource;
  model: string;
  /**
   * 自定义服务地址（只对 `source === 'custom'` 有意义）。
   *
   * ★ 2026-10-31 第五批补：这个值此前只存在页面内的 `drafts` Map 里，
   * `onSave({source, model})` **不包含它** —— 用户填的自定义地址
   * 切一次 Tab 就没了，更不可能存进配置。
   *
   * 用户明确要求"地址 + key + 模型名能存、能读回状态"，所以它必须
   * 进状态、进持久化、并且**在生成请求体里带出去**（契约 §3.2：
   * `custom_url` 属于请求体，服务端不读设置）。
   */
  baseUrl: string;
  /**
   * 单次回复的最大 token 数（2026-11-02 加）。
   *
   * ## 为什么必须让用户能改
   *
   * 推理模型（`deepseek-v4-pro` 等）会**先输出思维链**再输出正文。
   * 真机实测：302 帧全是 `reasoning_content`、`content` 一个字没有，
   * API 后台显示 `510 / 300` —— **300 的预算被思考吃完了**，
   * 于是正文为空、气泡消失、但钱已经扣了。
   *
   * 这个值原来固定在 ST 设置里（`openai_max_tokens`），App 界面没有入口，
   * 用户遇到"生成不出内容"时**根本没法自救**，只能换模型。
   *
   * `undefined` = 没设置过，沿用 ST 的值（默认 300）。
   */
  maxTokens?: number;
}

/**
 * 回复长度默认值。
 *
 * ## 为什么不是 ST 出厂的 300
 *
 * 300 对非推理模型够用，对推理模型**一定不够**：光思考就能吃掉 300，
 * 正文一个字都留不下（真机实测 302 帧全是思维链）。
 *
 * ## 为什么是 2048 而不是 800
 *
 * 我第一版给 800，理由是"够装一段思考 + 一段回复"。**实测打脸**：
 * 两次同样的配置，思维链分别是 459 字与 2074 字 —— 800 在第二次里
 * 连思考都装不完。
 *
 * 2048 能覆盖常见推理模型的思考量；再大的话普通模型会变得话痨，
 * 而 `stop` 序列与角色卡约束通常会让它在合理长度收住。
 */
export const DEFAULT_MAX_TOKENS = 2048;

/**
 * 「最大回复长度」允许的区间（2026-11-09）。
 *
 * ## 为什么要有这一对常量
 *
 * 原来这个数在**三个地方各写了一遍 8192**：
 *
 * ```text
 *   input 的 max 属性          max="8192"        （浏览器层面的夹紧）
 *   草稿校验                   n >= 256 && n <= 8192
 *   保存校验                   rawMax >= 256 && rawMax <= 8192
 * ```
 *
 * 三处都是"越界**静默替换**成默认值" —— 用户填 100000 保存后，
 * 界面上看到的是 2048，而**没有任何提示说被改了**。
 *
 * 这就是用户报「最大回复长度是否有限制？正常这个地方不应该有限制」的真因：
 * 他改了，但被夹回去，然后回复写到一半截断。
 *
 * 现在三处共用这一对常量，改一处全动。
 *
 * ## 为什么上限定成一百万
 *
 * 那只是拦明显误触（多按几个零），不构成对任何现役模型的限制 ——
 * Claude 4 / Gemini 2.5 的输出上限只有用户和上游知道，我们不该替他们拍。
 * 与 `shared/src/chat/settings-schema.ts` 的 `max` 保持一致。
 */
export const MAX_TOKENS_MIN = 1;
export const MAX_TOKENS_MAX = 1_000_000;

export const DEFAULT_API_STATE: ApiPageState = {
  source: 'openai',
  model: '',
  baseUrl: '',
  maxTokens: DEFAULT_MAX_TOKENS,
};

export interface ApiPageCallbacks {
  /** 保存：写 key（若有）+ 存本机偏好 + 通知外壳 */
  onSave: (state: ApiPageState, apiKey: string | null) => Promise<void>;
  /**
   * 这个源**是否已经配置过 key**（2026-11-02 用户要求）。
   *
   * ## 为什么要问外壳而不是自己判断
   *
   * key 存在 SillyTavern 里且**只能写不能读**（契约 §3.5），页面自己
   * 无从知道"配过没有"。而外壳在保存时是知情的，所以由外壳记一份标记、
   * 页面来问。
   *
   * ## 为什么返回的是"每个源分别的"
   *
   * 一个用户可能给 OpenAI 配了 key、没给 DeepSeek 配。若用一个全局布尔，
   * 切到 DeepSeek 也会显示"已配置"—— 那比不显示更糟：他会以为能用，
   * 然后发消息失败。
   */
  hasKeyFor?: (source: StChatSource) => boolean;
  onNotify?: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
  /**
   * 是否渲染自带的顶栏（标题「API 连接」）。默认 `true`。
   *
   * 2026-10-31 第三批：这一页被嵌进「我的」页的一级收纳项里，
   * 而收纳项的标题行已经写着「API 连接」—— 再渲染一次顶栏就是
   * **同一个标题连着出现两遍**（截图里能直接看到）。
   *
   * 用选项而不是直接删：这一页还有"独占整屏"的用法（将来做二级页面时）。
   * 删了顶栏那种用法就没标题了，而缺陷只出现在"嵌进收纳项"这一种场景。
   */
  hideTopbar?: boolean;
  /**
   * 重绘后要显示的一行提示（2026-11-01 加）。
   *
   * ## 为什么需要它
   *
   * 保存成功时这一页会**整页重绘**（副标题「当前：xxx」要跟着变）。
   * 而重绘会把 `status` 元素整个换掉 —— 所以 "已保存" 那句写在旧元素上，
   * 用户**一个字都看不到**。真机实测：保存其实是成功的
   * （localStorage 里三个字段都对），但界面上没有任何反馈。
   *
   * 失败时反而能看到：失败路径不重绘（onSave 抛错就不会走到 renderPage）。
   * **成功没提示、失败有提示**这种不对称，用户会以为"点了没成功"。
   *
   * 所以由外壳在重绘前记一句，重绘时传进来显示。
   */
  notice?: string;
}

/**
 * 渲染 API 连接页。
 *
 * 返回根元素；内部通过 `callbacks.onSave` 把值交出去（这个页面不自己写配置 ——
 * 写配置要走 `contract/shell.ts` 的 `configPatch`，那是外壳的职责）。
 */
export function renderApiPage(
  doc: DocLike,
  bridge: SecretWriter,
  initial: ApiPageState,
  callbacks: ApiPageCallbacks,
): ElLike {
  const root = el(doc, 'div', 'nb-page nb-api');
  root.setAttribute('data-role', 'api-page');

  // ── 顶栏（嵌进收纳项时由调用方关掉，见 `hideTopbar` 的注释）──
  if (callbacks.hideTopbar !== true) {
    const topbar = el(doc, 'div', 'nb-topbar');
    const title = el(doc, 'h1', 'nb-topbar-title');
    title.textContent = 'API 连接';
    topbar.append(title);
    root.append(topbar);
  }

  const body = el(doc, 'div', 'nb-list');
  root.append(body);

  // ── ① 接口类型（六个） ──
  const sourceNote = el(doc, 'p', 'nb-note');
  sourceNote.textContent = '选一个接口。需要别的服务就选「自定义（OpenAI 兼容）」，填它的地址。';
  body.append(sourceNote);

  const sourceList = el(doc, 'div');
  sourceList.setAttribute('data-role', 'source-list');
  let currentSource: StChatSource = initial.source;

  /*
   * ── 每个源各自的草稿 ──
   *
   * 为什么要按源分开存：用户先配好 OpenAI 的 model，再点 DeepSeek 看看，
   * 回来时 OpenAI 那个不能丢。共用一个 `model` 变量的话，切一圈回来
   * 填过的名字全没了 —— 而模型名是最难记的那个字段。
   *
   * key 不存这里：它是"只写不读"的（契约 §3.5），暂存到内存再写进 ST，
   * 保存后立刻清空输入框，**不进任何状态对象**。
   */
  /*
   * 每个源的草稿（切 Tab 不丢）。
   *
   * ★ `maxTokens` 也在里面 —— 它是**按源**的配置（不同模型适合不同上限），
   * 不是全局一份。少放进去的表现是"切一次 Tab 就回去 800"。
   */
  const drafts = new Map<
    StChatSource,
    { model: string; baseUrl: string; maxTokens?: number }
  >();
  for (const source of CHAT_SOURCES) {
    drafts.set(source, {
      // 只有当前源继承外部传进来的 model，其余源从空开始
      model: source === initial.source ? initial.model : '',
      /*
       * ★ `baseUrl` 必须**同样**继承（2026-11-01 发布阻断级修复）。
       *
       * 原来这里是硬写的 `baseUrl: ''`，而上面一行 `model` 是继承的 ——
       * 于是同一份 `apiState` 打开配置页后：模型名在、地址是空的。
       *
       * 后果不是"显示不全"这么轻：地址为空 ⇒ 点「保存」走校验分支 ⇒
       * 提示「自定义接口要填服务地址」⇒ 用户眼里就是"保存坏了/没反应"。
       * 而他的地址其实一直好好存着（localStorage 里查得到）。
       *
       * 实测证据（真机 CDP，2026-11-01 23:25）：
       *   localStorage['tcs.mobile.apiState']
       *     = {source:'custom', model:'[次0.2]claude-opus-4-8',
       *        baseUrl:'https://ai.ota1245.top/v1'}
       *   打开配置页后
       *     model-input.value   = '[次0.2]claude-opus-4-8'   ← 有
       *     baseurl-input.value = ''                          ← 空
       *   点保存 → api-status = '自定义接口要填服务地址。…'
       *
       * 为什么只有这一处错：`voice-settings.ts` 是直接 `= initial.baseUrl`，
       * 所以语音页没这个问题。**同一个"回填初始值"的动作写了两遍，
       * 只有一遍漏了一个字段** —— 这正是本项目反复出现的形状。
       */
      baseUrl: source === initial.source ? initial.baseUrl : '',
    });
  }

  /** 折叠状态下"当前源"那一行要高亮，这是选中反馈的主体 */
  const syncSelection = (): void => {
    for (const row of sourceRows) {
      const isCurrent = row.source === currentSource;
      row.button.setAttribute('aria-pressed', String(isCurrent));
      row.button.setAttribute('aria-expanded', String(row.panelExpanded));
    }
  };

  interface SourceRow {
    source: StChatSource;
    button: ElLike;
    panel: ElLike;
    panelExpanded: boolean;
  }
  const sourceRows: SourceRow[] = [];

  /*
   * ★ 展开区的字段是**动态构建**的，不是六个常驻再切显隐。
   *
   * 原因不是性能，是**唯一性**：`model-input` / `key-input` 这些 data-role
   * 在验收脚本与单元测试里都按"全局只有一个"来取
   * （`byRole(page, 'key-input')[0]`）。如果六个源的输入框都常驻 DOM，
   * 取到的会是第一个源的（可能是收起的那个），
   * 表现为"改了值但保存的不是它" —— 而这种错在界面上看不出来。
   *
   * 所以：同一时刻 DOM 里只有一组配置输入。
   */
  let currentPanelHost: ElLike | null = null;
  let modelInput: HTMLInputElement | null = null;
  let maxTokensInput: HTMLInputElement | null = null;
  let keyInput: HTMLInputElement | null = null;
  let baseUrlInput: HTMLInputElement | null = null;
  /*
   * 当前面板的 key 字段状态（2026-11-02）。
   *
   * 面板是**动态重建**的（切源就换一组输入框），所以这两个函数也必须在
   * `buildPanel` 里被重新赋值 —— 保存时读到的必须是"当前这个面板"的状态，
   * 而不是上一个源的。
   *
   * 默认值给成保守的 `'empty'` / 空操作：面板还没建（全部收起）时保存，
   * 读到的就是"没有 key 要改"，语义正确。
   */
  let markKeyConfigured: () => void = () => {};

  const buildPanel = (host: ElLike, source: StChatSource): void => {
    host.replaceChildren();
    const draft = drafts.get(source);
    if (draft === undefined) return;
    const meta = CHAT_SOURCE_LABELS[source];

    // ── 地址：只有「自定义」需要；其余源用内置地址 ──
    if (source === 'custom') {
      const row = el(doc, 'label', 'nb-field');
      const label = el(doc, 'span', 'nb-field-label');
      label.textContent = '服务地址';
      const input = el(doc, 'input', 'nb-input') as unknown as HTMLInputElement;
      input.setAttribute('type', 'url');
      input.setAttribute('inputmode', 'url');
      input.setAttribute('placeholder', 'https://你的服务/v1');
      input.setAttribute('data-role', 'baseurl-input');
      (input as unknown as HTMLInputElement).value = draft.baseUrl;
      input.addEventListener?.('input', () => {
        draft.baseUrl = (input as unknown as HTMLInputElement).value ?? '';
      });
      const hint = el(doc, 'span', 'nb-field-hint');
      hint.textContent = '填到 /v1 为止。留空则用 OpenAI 官方地址。';
      row.append(label, input as unknown as ElLike, hint);
      host.append(row);
      baseUrlInput = input as unknown as HTMLInputElement;
    } else {
      baseUrlInput = null;
    }

    // ── 模型名 ──
    const modelRow = el(doc, 'label', 'nb-field');
    const modelLabel = el(doc, 'span', 'nb-field-label');
    modelLabel.textContent = '模型名';
    const mi = el(doc, 'input', 'nb-input') as unknown as HTMLInputElement;
    mi.setAttribute('type', 'text');
    mi.setAttribute('placeholder', meta.modelPlaceholder);
    mi.setAttribute('data-role', 'model-input');
    mi.setAttribute('autocomplete', 'off');
    (mi as unknown as HTMLInputElement).value = draft.model;
    mi.addEventListener?.('input', () => {
      draft.model = (mi as unknown as HTMLInputElement).value ?? '';
    });
    const modelHint = el(doc, 'span', 'nb-field-hint');
    modelHint.textContent = '名字要跟这个接口文档里的一致。填错的话生成会直接报错。';
    modelRow.append(modelLabel, mi as unknown as ElLike, modelHint);
    host.append(modelRow);
    modelInput = mi as unknown as HTMLInputElement;

    /*
     * ── 最大回复长度（2026-11-02 加） ──
     *
     * ## 这一格是"推理模型生成不出内容"的**唯一自救入口**
     *
     * 真机实测：`deepseek-v4-pro` 输出了 302 帧思维链、0 字正文，
     * API 后台 `510 / 300` —— 300 的预算被思考吃完了。
     * 用户当时能做的只有"换个模型"，因为界面上没有这一格。
     *
     * ## 为什么用 `number` 且给上下限
     *
     * 太小（< 256）连正常回复都装不下；太大（> 8192）会让弱模型
     * 输出到一半卡死，而且预付费站点可能直接拒绝。夹在 256–8192。
     */
    const maxRow = el(doc, 'label', 'nb-field');
    const maxLabel = el(doc, 'span', 'nb-field-label');
    maxLabel.textContent = '最大回复长度';
    const maxInput = el(doc, 'input', 'nb-input') as unknown as HTMLInputElement;
    maxInput.setAttribute('type', 'number');
    maxInput.setAttribute('min', '256');
    maxInput.setAttribute('max', String(MAX_TOKENS_MAX));
    maxInput.setAttribute('min', String(MAX_TOKENS_MIN));
    maxInput.setAttribute('step', '64');
    maxInput.setAttribute('inputmode', 'numeric');
    maxInput.setAttribute('data-role', 'max-tokens-input');
    (maxInput as unknown as HTMLInputElement).value = String(
      draft.maxTokens ?? DEFAULT_MAX_TOKENS,
    );
    if (draft.maxTokens === undefined) draft.maxTokens = DEFAULT_MAX_TOKENS;
    maxInput.addEventListener?.('input', () => {
      const n = Number.parseInt(String((maxInput as unknown as HTMLInputElement).value ?? ''), 10);
      /* 非法输入不写进 draft —— 留着上一次有效值，保存时不会变成 NaN */
      if (Number.isFinite(n) && n >= MAX_TOKENS_MIN && n <= MAX_TOKENS_MAX) draft.maxTokens = n;
    });
    const maxHint = el(doc, 'span', 'nb-field-hint');
    maxHint.textContent =
      '单次回复的 token 上限。用「会思考的模型」（推理模型）时务必调大，' +
      '否则思考会把预算吃光、正文为空。默认 2048；若仍提示"只有思考没有正文"，按提示里的数值再加。';
    maxRow.append(maxLabel, maxInput as unknown as ElLike, maxHint);
    host.append(maxRow);
    maxTokensInput = maxInput as unknown as HTMLInputElement;

    // ── API key（只写不读） ──
    const keyRow = el(doc, 'label', 'nb-field');
    const keyLabel = el(doc, 'span', 'nb-field-label');
    keyLabel.textContent = 'API key';
    const ki = el(doc, 'input', 'nb-input') as unknown as HTMLInputElement;

    /*
     * ★ 2026-11-02 用户要求：**配置过就显示一串星号，没配过就是空的**。
     *
     * 原来这里恒为空白 + 一句"已保存过就留空"。空白既可能是"没配过"
     * 也可能是"配过但不回显"，用户没法区分 —— 而他原话是
     * 「这样用户才知道自己有没有配置」。
     *
     * 三态（empty / masked / editing）与渲染映射都在
     * `shared/src/voice/key-field.ts`，两个配置页共用同一套判定。
     * 那一层还有一个**安全职责**：`keyToSave()` 会拦住"把掩码串当成
     * 新 key 写进 ST"这种会把真 key 覆盖掉的错误。
     */
    let keyState: KeyFieldState = initialKeyState(callbacks.hasKeyFor?.(source) ?? false);
    /*
     * ★ 说明文字要跟着状态走。
     *
     * `keyHint` 在下面才创建（它要 append 到 keyRow，而 keyRow 在更后面组好），
     * 所以这里先占一个"待接上"的钩子：`paintKeyField` 每次跑都顺手刷说明。
     *
     * 不用条件判断"有没有赋值"—— 直接给个空函数兜底，创建后立刻替换。
     * 这样 `paintKeyField()` 在创建之前被调用（下面第 432 行）也不会炸。
     */
    let paintKeyHint: () => void = () => {};
    const paintKeyField = (): void => {
      ki.setAttribute('type', keyFieldType(keyState));
      ki.setAttribute('placeholder', keyFieldPlaceholder(keyState));
      ki.value = keyFieldValue(keyState);
      ki.setAttribute('data-key-state', keyState);
      /*
       * ★★★ 必须刷说明（2026-11-07）。
       *
       * 说明文字是**随状态变的**：没配 / 正在填 / 已配 三句话完全不同。
       * 原来它只在渲染时写一次，于是用户点进输入框（empty → editing）后
       * 下面还写着"还没有配 key"，读完会以为自己没进编辑态。
       */
      paintKeyHint();
    };
    paintKeyField();

    ki.addEventListener?.('focus', () => {
      /*
       * 聚焦就把掩码清掉。
       *
       * 不清的话用户会在 12 个点后面继续输入，拼出
       * `••••••••••••sk-xxx` 这种东西，保存时被当成新 key 写进 ST ——
       * 之后所有请求 401，而错误只说"鉴权失败"，没人能想到原因。
       */
      keyState = keyStateOnFocus(keyState);
      /* masked → editing 时 value 要清空；其余态本来就没值 */
      if (keyState === 'editing') ki.value = '';
      ki.setAttribute('type', keyFieldType(keyState));
      ki.setAttribute('placeholder', keyFieldPlaceholder(keyState));
      ki.setAttribute('data-key-state', keyState);
    });
    ki.addEventListener?.('blur', () => {
      /*
       * 没输入内容就退回掩码 —— 但**只有原本配置过**才退回 masked。
       *
       * 否则会出现"从没配过 key 的用户点一下框再点开，界面变成已配置"，
       * 那是明确的撒谎。
       */
      const hadKey = callbacks.hasKeyFor?.(source) ?? false;
      keyState = keyStateOnBlur(keyState, ki.value ?? '', hadKey);
      paintKeyField();
    });

    ki.setAttribute('data-role', 'key-input');
    ki.setAttribute('autocomplete', 'off');
    const keyHint = el(doc, 'span', 'nb-field-hint');
    keyHint.setAttribute('data-role', 'key-hint');
    /*
     * ★★★ 三态各自的说明（2026-11-07 修一个会误导人的真缺陷）。
     *
     * 原来只有两个分支：
     *
     * ```text
     *   masked  → '已经配过了。要换就点一下这里重新粘贴；留空表示不改。'
     *   else    → 'key 已保存，这里不会再显示。要换就重新粘贴一次。'
     * ```
     *
     * 而 `else` 同时覆盖着 **`empty`（根本没配过）** 和 `editing`。
     * 于是在**一个从来没有 key 的源**上，输入框下面明明白白写着
     * 「**key 已保存，这里不会再显示**」。
     *
     * ## 这就是用户那条 400 的直接原因
     *
     * 他切到「DeepSeek 官方接口」，看到这句话 ⇒ 认定已经配好了
     * ⇒ 不去填 ⇒ 发消息 ⇒ ST 的缺 key 分支返回 `400 {"error":true}`
     * （那条分支**不带 message**，所以界面上什么原因都没有）。
     *
     * 真机取证：secrets.json 里确实没有 `api_key_deepseek`；
     * 补上之后同一个请求立刻 200。
     *
     * ★ 这条缺陷的形状值得记：**它不是"少写了一个状态"，而是
     *   `else` 把"没配"和"正在填"两个态都算进了"已配"的语义里。**
     *   文案是断言句（"已保存"），所以它不是"没说清"，是**说错了**。
     *
     * ## 为什么做成函数而不是渲染时算一次
     *
     * `focus` / `blur` 会改 `keyState`。写死一次的话，用户点进框里
     * （→ editing）说明还停在旧的那句，读完会以为没进入编辑态。
     */
    const paintKeyHintImpl = (): void => {
      keyHint.textContent =
        keyState === 'masked'
          ? /*
             * ★ 必须说明"真 key 不会再显示"（老判据
             *   `test/api-page-dom.test.mjs`「key 输入框初始必须是空的」
             *   专门要求这句话）。
             *
             * 理由：框里只有一串掩码，用户会怀疑"是不是没存上/是不是坏了"。
             * 明确说"不会回显"才能让他安心 —— 这不是啰嗦，是防一个具体的误解。
             */
            '已经配过了。真 key 不会再显示；要换就点一下这里重新粘贴，留空表示不改。'
          : keyState === 'editing'
            ? '粘贴这个接口的 API key，然后点下面的「保存」。'
            : '还没有配 key。这个接口需要它才能发消息：把 key 粘贴到这里，再点下面的「保存」。';
    };
    /* 接上前面那个钩子，然后立刻刷一次（渲染时就要对） */
    paintKeyHint = paintKeyHintImpl;
    paintKeyHint();
    keyRow.append(keyLabel, ki as unknown as ElLike, keyHint);
    host.append(keyRow);
    keyInput = ki as unknown as HTMLInputElement;
    /*
     * 把"当前这个面板的 key 状态"暴露给保存逻辑。
     *
     * 用闭包变量而不是从 DOM 反推：DOM 里 masked 态的值就是掩码串，
     * 反推要靠"值等于 KEY_MASK"这种脆弱的比较；而状态本来就只有一个
     * 生产者（上面那几个事件），没必要绕一圈再猜。
     */
    /*
     * 刚写入成功 ⇒ **直接**置为 `masked`，不去问 `hasKeyFor()`。
     *
     * 理由是时序：这一刻外壳的标记可能还没落盘（`onSave` 是在
     * `writeSecret` 之后才被调用的），回头问会拿到"没配过"，
     * 界面就又把刚存的 key 显示成空白 —— 正是用户这次报的那个现象。
     * 既然刚刚亲手写成功了，事实就是"已配置"，不需要再问一次。
     */
    markKeyConfigured = () => {
      keyState = 'masked';
      paintKeyField();
    };
  };

  /** 展开某个源；传 null 表示全部收起 */
  const expandSource = (source: StChatSource | null): void => {
    for (const row of sourceRows) {
      const shouldExpand = row.source === source;
      row.panelExpanded = shouldExpand;
      row.panel.hidden = !shouldExpand;
    }

    /*
     * ★ 每次都**先清空所有面板**，再建当前这一个。
     *
     * 2026-10-31 第五批修：原来只在 `source === null`（全部收起）时清，
     * 于是"从 openai 切到 custom"会让 openai 的面板**留着内容**（只是 hidden）。
     * 实测后果（真机 CDP 探测）：
     *
     * ```
     * 1 展开后:   modelInputs: [ {v:"gpt-4o-mini"} ]                         ← 1 个
     * 2 点custom: modelInputs: [ {v:"gpt-4o-mini"}, {v:""} ]                 ← 2 个！
     * ```
     *
     * 页面上看不出问题（旧的那个 hidden），但它让 `data-role="model-input"`
     * **不再唯一** —— 而"同一时刻只有一组配置输入"是这个文件自己写下的纪律
     * （第三批还有一条断言守着它）。断言没抓到，是因为它扫的是源码而不是运行时 DOM。
     *
     * 更实际的危害：任何按 `data-role` 取输入的自动化（我这次的端到端脚本就是）
     * 会取到**隐藏的那个**，然后"填了值但保存说没填" —— 用户视角是玄学。
     */
    for (const row of sourceRows) row.panel.replaceChildren();

    // 指针先全部置空，避免指向已被清掉的旧元素
    modelInput = null;
    keyInput = null;
    baseUrlInput = null;
    currentPanelHost = null;

    if (source !== null) {
      const row = sourceRows.find((r) => r.source === source);
      if (row !== undefined) {
        buildPanel(row.panel, source);
        currentPanelHost = row.panel;
      }
    }

    syncSelection();
  };

  for (const source of CHAT_SOURCES) {
    const meta = CHAT_SOURCE_LABELS[source];
    const item = el(doc, 'button', 'nb-listitem nb-src-item');
    item.setAttribute('type', 'button');
    item.setAttribute('data-source', source);
    item.setAttribute('data-role', 'source-item');
    item.setAttribute('aria-pressed', String(source === currentSource));
    item.setAttribute('aria-expanded', 'false');

    const main = el(doc, 'span', 'nb-listitem-main');
    const name = el(doc, 'span', 'nb-listitem-title');
    name.textContent = meta.label;
    const hint = el(doc, 'span', 'nb-listitem-sub');
    hint.textContent = meta.hint;
    main.append(name, hint);

    /*
     * ★★★ 「还没配 key」的标记（2026-11-07，用户报 HTTP 400 {"error":true}）。
     *
     * ## 用户遇到的事
     *
     * 他给「自定义」源配过 key（secrets 里 `api_key_custom` 有 3 条），
     * 后来切到「DeepSeek 官方接口」——**那个源从来没有 key**。
     * 界面上两个源长得一模一样，切过去也没有任何提示，
     * 于是他直接发消息，拿到：
     *
     * ```text
     *   /api/backends/chat-completions/generate 返回 HTTP 400: {"error":true}
     * ```
     *
     * 真机取证：ST 的 `secrets.json` 里只有 `api_key_openai` 与
     * `api_key_custom`，**没有 `api_key_deepseek`**；而 ST 源码里那条
     * `if (!apiKey && !request.body.reverse_proxy) → 400 {error:true}`
     * 正是"缺 key"分支（且**不带 message**，所以界面上什么信息都没有）。
     *
     * 补上 key 之后同一个请求立刻 200（正文"好"）。⇒ 链路本身是好的，
     * 缺的就是"这个源还没配 key"这句话。
     *
     * ## 为什么标在列表项上而不是只在面板里
     *
     * 面板里那一栏要展开才看得见。用户选源的**那一刻**就该知道
     * "这个源还没配好、切过去也发不出去" —— 换源是个横向比较的动作，
     * 状态必须并排可见。
     *
     * ## 只说"未配 key"，不猜"能不能用"
     *
     * `hasKeyFor()` 来自 App 自己的标记（localStorage）。用户在 ST 那边
     * 直接配过 key 的话这里会显示"未配" —— 那是**保守的误报**，
     * 代价是用户多点一次面板，比"以为配好了却发不出去"轻得多。
     */
    const keyMissing = callbacks.hasKeyFor?.(source) !== true;
    if (keyMissing) {
      const badge = el(doc, 'span', 'nb-src-badge');
      badge.setAttribute('data-role', 'source-key-missing');
      /*
       * ★ 属性名**不能**复用 `data-source`（2026-11-07，判据当场抓到）。
       *
       * `data-source` 在这个页面里是"**源行**"的标识：`expandSource()`、
       * 手风琴选中态、以及 `test/api-page-dom.test.mjs` 的
       * 「源的数量必须恰好等于六个」都在按它找。
       *
       * 我在标记上随手也写了 `data-source=source`，于是多出 5 个
       * `[data-source]` 节点 —— 那条判据立刻报
       * `expected 1, actual 2`（同一个源被找到两次）。
       *
       * 一物一属性：标记用 `data-badge-source` 表达"这个标记属于哪个源"。
       */
      badge.setAttribute('data-badge-source', source);
      badge.textContent = '未配 key';
      main.append(badge);
    }

    /*
     * 右侧的展开指示（›/⌄）。它和 aria-expanded 同源 ——
     * 只用 CSS 的 `::after` 也行，但那样读屏拿不到状态；用真元素更稳。
     */
    const chevron = el(doc, 'span', 'nb-src-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';

    item.append(main, chevron);

    // 展开区：与选项行同级，插在它后面（"就地展开"的视觉就是它紧贴在该行下方）
    const panel = el(doc, 'div', 'nb-acc-panel');
    panel.setAttribute('data-role', 'source-panel');
    panel.hidden = true;

    const row: SourceRow = { source, button: item, panel, panelExpanded: false };
    sourceRows.push(row);

    item.addEventListener('click', () => {
      /*
       * 手风琴语义：点已展开的 → 收起；点别的 → 展开它并收起原来那个。
       *
       * 用户明确要求"再次点击收起"，所以这里**不是**"点了就一定是选中"。
       * 但"当前选中源"必须独立于展开态存在 —— 收起之后
       * `currentSource` 仍是它，保存时用的也还是它。
       */
      if (row.panelExpanded) {
        expandSource(null);
        return;
      }
      currentSource = source;
      expandSource(source);
    });

    sourceList.append(item, panel);
  }
  body.append(sourceList);

  // 默认展开当前源 —— 用户进来就能看到"当前用的是哪个、它需要填什么"
  expandSource(currentSource);

  // ── ⑤ 保存 ──
  const footer = el(doc, 'div', 'nb-page-foot');
  const saveBtn = el(doc, 'button', 'nb-btn nb-btn--primary');
  saveBtn.setAttribute('type', 'button');
  saveBtn.setAttribute('data-role', 'save-api');
  saveBtn.textContent = '保存';
  const status = el(doc, 'p', 'nb-note');
  status.setAttribute('data-role', 'api-status');
  /*
   * 重绘前记下的提示（比如"已保存"）—— 见 `notice` 的注释。
   *
   * ★★★ 2026-11-01 第二个断点：**`status.hidden = true` 原来是无条件执行的**，
   * 就在下面紧跟着。于是"已保存"写进了 `textContent`，但元素是隐藏的 ——
   * 用户一个字都看不到。
   *
   * 真机现象（用户截图 21:32）：点保存后停在原页，无成功提示也无失败提示。
   * 而 `localStorage` 里三个字段都是对的 ⇒ **保存成功、反馈丢失**。
   *
   * 这是"加了一行赋值、没看下一行"的典型：那次改动的意图是加成功反馈，
   * 但紧跟着的 `status.hidden = true` 让它彻底失效，而**测试全绿**
   * （判据只断言 `textContent`，没断言可见性）。
   *
   * 修法：有提示 ⇒ 显示；没提示 ⇒ 隐藏。
   */
  const hasNotice = callbacks.notice !== undefined && callbacks.notice !== '';
  if (hasNotice) {
    status.textContent = callbacks.notice ?? '';
    status.setAttribute('data-kind', 'ok');
  }
  status.hidden = !hasNotice;

  saveBtn.addEventListener('click', () => {
    void (async () => {
      /*
       * 输入框在收起态是**不存在**的（面板内容动态构建），所以取之前要判空。
       *
       * 值是优先从 DOM 取、回落到草稿：DOM 里的比草稿新（用户可能刚敲完
       * 还没触发 input 事件）；收起后 DOM 没了，就只能用草稿。
       */
      const draft = drafts.get(currentSource);
      const rawModel = (
        modelInput !== null ? (modelInput.value ?? '') : (draft?.model ?? '')
      ).trim();
      const rawKey = keyToSave(keyInput !== null ? (keyInput.value ?? '') : '');

      /*
       * ★ 校验顺序：先判源合法，再判模型。
       *
       * 反过来的话，用户选了个不支持的源、又没填模型，会先看到"没填模型"，
       * 改完模型再保存才被告知"源不支持" —— 两次往返。
       */
      if (!isSupportedChatSource(currentSource)) {
        status.hidden = false;
        status.textContent = unsupportedSourceMessage(String(currentSource));
        callbacks.onNotify?.(status.textContent, 'danger');
        return;
      }
      if (rawModel === '') {
        status.hidden = false;
        status.textContent = '还没填模型名。填完再保存。';
        callbacks.onNotify?.(status.textContent, 'warn');
        return;
      }

      try {
        /*
         * key 只在用户**真的填了**时才写。`rawKey === null` = 不改
         * （不覆盖已存的那份）。
         *
         * ★ 这里的 null 来自 `keyToSave()`：它认**掩码哨兵值**，不看状态标记。
         * 直接读 `keyInput.value` 的话，展示用的掩码串
         * `'••••••••••••'` 会被当成新 key 写进 SillyTavern，
         * 把用户真实的 key 覆盖成一串圆点 —— 之后所有请求 401。
         */
        /*
         * ★★★ 这里是**唯一的写入点**（2026-11-09 明确）。
         *
         * 之前 `writeApiConnectionToSt()` 里也写了一遍同样的 key，
         * 而 ST 的 `writeSecret` 是**追加**语义（新写一条、把别的置为
         * `active: false`）。两处都写 ⇒ 每保存一次就往 secrets.json 加两条，
         * 保存一百次就积两百条历史 key，越用越脏。
         *
         * 现在分工：
         *
         * ```text
         *   这一页   写 key（用户操作的直接处，写完立刻切掩码态）
         *   外壳     只**回读校验**（secretPresent 确认引擎真的读得到）
         *            —— 不写，避免重复
         * ```
         */
        if (rawKey !== null) {
          await bridge.writeSecret(`api_key_${currentSource}`, rawKey);
          /*
           * ★ 写完之后**不**清空输入框，改成回到 masked 态。
           *
           * 原来是 `keyInput.value = ''`，用户看到的是"我刚填的 key 消失了"
           * —— 这正是他报的「秘钥看不见了，我不知道有没有配置」。
           * 现在改成显示一串星号：既证明"存进去了"，又不泄露真值。
           */
          markKeyConfigured();
        }
        // 保存成功后把 model 落到草稿，切走再切回来不会丢
        if (draft !== undefined) draft.model = rawModel;
        const rawBaseUrl = (
          baseUrlInput !== null ? (baseUrlInput.value ?? '') : (draft?.baseUrl ?? '')
        ).trim();

        /*
         * 自定义源必须填地址 —— 否则"保存成功"之后生成时根本不知道发给谁。
         * 校验放在这里而不是连接页之外：这是唯一知道用户选了哪个源的地方。
         */
        if (currentSource === 'custom' && rawBaseUrl === '') {
          status.hidden = false;
          status.textContent = '自定义接口要填服务地址。填到 /v1 为止，再保存。';
          callbacks.onNotify?.(status.textContent, 'warn');
          return;
        }

        if (draft !== undefined) draft.baseUrl = rawBaseUrl;

        /*
         * 最大回复长度：从输入框读，读不到就用 draft 里上一次的有效值，
         * 再不行用默认值 —— **绝不允许传 NaN/undefined 到请求体**，
         * 那会让上游按它自己的默认（300）跑，用户以为改了其实没改。
         */
        const rawMax = maxTokensInput !== null
          ? Number.parseInt(String(maxTokensInput.value ?? ''), 10)
          : Number.NaN;
        const draftMax = draft === undefined ? undefined : draft.maxTokens;
        const maxTokens = Number.isFinite(rawMax) && rawMax >= MAX_TOKENS_MIN && rawMax <= MAX_TOKENS_MAX
          ? rawMax
          : (draftMax ?? DEFAULT_MAX_TOKENS);

        await callbacks.onSave(
          { source: currentSource, model: rawModel, baseUrl: rawBaseUrl, maxTokens },
          rawKey,
        );
        status.hidden = false;
        status.textContent = rawKey === null ? '已保存' : '已保存，key 也换好了';
        callbacks.onNotify?.('已保存', 'ok');
      } catch (error) {
        /*
         * ★ 2026-10-31 第五批：这里原来是
         *     `error instanceof Error ? error.message : String(error)`
         *   而 Tauri 拒绝时给的是**普通对象** ⇒ `[object Object]`。
         *
         *   现在走 `describeBridgeError()`：它把 `{code, message}` 拆开、
         *   按错误码分类，并保证**任何形态都不会产出 `[object Object]`**。
         *   同时把 `hint`（下一步该做什么）单独一行显示 ——
         *   用户报的是"没法归因"，只给一句话还不够，要告诉他去查什么。
         */
        const described = describeBridgeError(error);
        status.hidden = false;
        status.textContent =
          described.hint === undefined
            ? `保存失败：${described.message}`
            : `保存失败：${described.message}\n${described.hint}`;
        callbacks.onNotify?.(`保存失败：${described.message}`, 'danger');
      }
    })();
  });

  footer.append(saveBtn, status);
  root.append(footer);

  return root;
}

/*
 * `readNumber()` 随采样参数一起删掉了（2026-10-31 第四批）。
 *
 * 它是采样输入框专用的"越界夹紧"读取器。采样迁走后它没有任何调用点，
 * 留着就是死代码 —— 而**死代码会骗人**：下一个人看到它，会以为
 * 这一页还有数字输入要校验。
 *
 * 顺带说一句：它的语义（越界静默夹紧）与 `settings-schema.ts` 的
 * `validateNumber`（越界报错并说明范围）是**相反的**。这种"两个函数
 * 对同一件事有相反约定"最容易在迁移时被误用，一并清掉更安全。
 */
