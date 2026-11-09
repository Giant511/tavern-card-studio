/**
 * 语音输入设置页（v0.1.7 / T15.6）。
 *
 * ## 这一页要做四件事（需求 4）
 *
 * 1. 「发送前需确认」开关（C5，默认 **false**）；
 * 2. 厂商模板下拉 —— 选中后**自动填 base_url 与 model**；
 * 3. key 手填 + 「获取模型列表」+ 「3 秒测试音频校验」；
 * 4. 错误分流文案（走 `classifyAsrFailure`，不自己写）。
 *
 * ## ★ 与「API 连接」页的隔离
 *
 * ASR 配置与聊天后端配置**必须互不可见、互不覆盖**。
 * 这一页只管语音那几个字段，**不碰** `serverUrl` / `provider` / `model`（聊天侧）。
 *
 * 隔离有两层保障：
 *   · 本页只写 `voiceAsr*` 前缀的键（命名空间隔离）；
 *   · `config-scopes.ts` 的 `applyScopedPatch` 对跨作用域写入**抛错**。
 * 第二层是硬的 —— 就算有人在本页里误写了聊天字段，也会当场抛而不是静默生效。
 *
 * ## 「3 秒测试音频」验的是什么、不验什么
 *
 * 验：**配置能用** —— 域名通、key 对、模型名对、协议选对。
 * 不验：**识别准不准** —— 这需要真人声样本，内置合成音只能证明链路通。
 *
 * 这条边界必须写清：否则用户看到"测试通过"会以为"识别效果好"，
 * 而实际用起来对着一句话识别错，就会觉得是 bug。
 */

import {
  ALL_ASR_PRESETS,
  ASR_ADVANCED_PRESETS,
  ASR_QUICK_GUIDE,
  classifyAsrFailure,
  findAsrPreset,
  GRADIO_BASE_URL_HINT,
  GRADIO_MODEL_PATH_HINT,
  interpretModelsResponse,
  initialKeyState,
  keyFieldPlaceholder,
  keyFieldType,
  keyFieldValue,
  keyStateOnBlur,
  keyStateOnFocus,
  keyToSave,
  needsApiKey,
  TEXT_ONLY_VENDORS_NOTE,
  type AsrPreset,
  type KeyFieldState,
} from '@tcs/shared';

import { el, type DocLike, type ElLike } from './chat-view.ts';
import { transcribe } from './asr-client.ts';

/** 语音设置的持久化形状（只含语音字段，与聊天配置无交集） */
export interface VoiceSettings {
  /** 「发送前需确认」开关 */
  confirmBeforeSend: boolean;
  /** 选中的厂商模板 id */
  presetId: string;
  /** 手填/模板填的 base_url */
  baseUrl: string;
  /** 手填/模板填的 model */
  model: string;
  /**
   * 仅 gradio 路线：模型权重所在目录。
   *
   * 与 `model` 分开存（不合并成一个字段）的理由见 `AsrPreset.modelPath`：
   * `model` 是"选哪个模型"，路径是"权重在哪"，改一个不必改另一个。
   */
  modelPath?: string;
  /** 上次用的语音模式（UI 记忆，不是必需） */
  lastMode?: string;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  /*
   * 默认 **false**（决策 C5）。
   *
   * 为什么默认关：需求「最常用路径必须是零额外动作的那条」——
   * 默认开确认等于每次说话都要再点一下发送，而多数用户想要的是"说完就发出"。
   * 需要谨慎的用户可以自己打开。
   */
  confirmBeforeSend: false,
  presetId: 'aliyun-paraformer',
  baseUrl: '',
  model: '',
  modelPath: '',
};

export interface VoiceSettingsCallbacks {
  /** 保存配置。`apiKey` 为 null 表示"这次没改 key" */
  onSave: (settings: VoiceSettings, apiKey: string | null) => Promise<void>;
  /**
   * 是否已经配置过 key（2026-11-02 用户要求）。
   *
   * 有它才能把秘钥框显示成一串星号，而不是"永远空白"—— 空白既可能表示
   * "没配过"也可能表示"配过但不回显"，用户分不出来，而他原话是
   * 「这样用户才知道自己有没有配置」。
   *
   * 聊天配置页用 `hasKeyFor(source)`（key 存在 SillyTavern，只能写不能读，
   * 靠外壳记标记）；这里语音 key 存在本机 localStorage，外壳能读出来，
   * 所以接口更简单 —— 一个无参布尔就够。
   */
  hasKey?: () => boolean;
  /**
   * 读本机已存的 key（空串 = 没存过）。
   *
   * ## 为什么"测试/拉模型"需要它
   *
   * 秘钥框改成掩码显示后，用户不清空它就不会输入新值。此时"测试连接"
   * 与"获取模型列表"要用的仍然是**已存的那把 key** —— 而掩码串
   * `'••••••••••••'` 绝不能拿去发请求（那必然 401，且错误只说
   * "鉴权失败"，没人会想到是掩码被当成了 key）。
   *
   * 语音 key 存在本机 localStorage，外壳能读出来，所以这里能拿到真值
   * （与聊天 key 不同：那把写进 SillyTavern 后读不回来）。
   */
  readKey?: () => string;
  /** 获取模型列表（成败都走这个回调，由外壳决定要不要落盘） */
  onFetchModels?: (settings: VoiceSettings, apiKey: string) => Promise<string[]>;
  onNotify?: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
  /** 注入测试音频（默认用内置合成音频） */
  testAudio?: () => Promise<Blob>;
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /**
   * 是否渲染自带的顶栏（标题「语音输入」）。默认 `true`。
   *
   * 与 `api-page.ts` 的 `hideTopbar` 同一理由、同一批加：
   * 这一页被嵌进「我的」页的收纳项里，而收纳项标题行已经写着
   * 「语音输入配置」—— 再渲染一次顶栏就是同一个标题连着出现两遍。
   */
  hideTopbar?: boolean;
  /**
   * 重绘后要显示的一行提示（2026-11-01 发布阻断级同批修复）。
   *
   * ## 为什么语音页也需要它（API 页早就有，这一页漏了）
   *
   * 保存成功后外壳会 `renderPage()` 整页重绘（副标题「当前：xxx」要跟着变）。
   * 而 `showStatus('已保存')` 是在 `await onSave()` **之后**执行的 ——
   * 那一刻 `status` 已经是**从 DOM 上摘掉的旧节点**，改它没有任何效果。
   *
   * 真机现象：点保存后界面毫无变化，用户无法判断成功与否。
   *
   * 所以由外壳在重绘前记一句，重绘时传进来显示 —— 与 `api-page.ts`
   * 的 `notice` 完全同构（那里还额外踩了 `status.hidden = true` 的坑）。
   */
  notice?: string;
}

export interface VoiceSettingsPage {
  root: ElLike;
  /** 读当前表单值（外壳保存时用） */
  read: () => VoiceSettings;
}

/**
 * 渲染语音设置页。
 *
 * 返回 `{ root, read }` —— `read()` 让外壳能拿到"用户此刻填的值"，
 * 而不必从 DOM 里再捞一遍（那样每个字段的取值方式就散到两处了）。
 */
export function renderVoiceSettingsPage(
  doc: DocLike,
  initial: VoiceSettings,
  callbacks: VoiceSettingsCallbacks,
): VoiceSettingsPage {
  const root = el(doc, 'div', 'nb-page nb-voice-settings');
  root.setAttribute('data-role', 'voice-settings-page');

  // ── 顶栏（嵌进收纳项时由调用方关掉，见 `hideTopbar` 的注释）──
  if (callbacks.hideTopbar !== true) {
    const topbar = el(doc, 'div', 'nb-topbar');
    const title = el(doc, 'h1', 'nb-topbar-title');
    title.textContent = '语音输入';
    topbar.append(title);
    root.append(topbar);
  }

  const body = el(doc, 'div', 'nb-list');
  root.append(body);

  /* ── ① 发送前需确认（C5） ── */
  const confirmRow = el(doc, 'label', 'nb-field nb-field--switch');
  const confirmLabel = el(doc, 'span', 'nb-field-label');
  confirmLabel.textContent = '发送前需确认';
  const confirmToggle = el(doc, 'input', 'nb-switch') as unknown as HTMLInputElement;
  confirmToggle.setAttribute('type', 'checkbox');
  confirmToggle.setAttribute('data-role', 'confirm-toggle');
  (confirmToggle as unknown as HTMLInputElement).checked = initial.confirmBeforeSend;
  const confirmHint = el(doc, 'span', 'nb-field-hint');
  /*
   * 这句要说清两种模式的差别 —— 用户才能做决策。
   * 「开启后会先显示可编辑文本」比「此选项控制确认行为」有用得多。
   */
  confirmHint.textContent = '开着的话，松开后先显示一段可编辑的文字等你确认；关着就直接发出去。';
  confirmRow.append(confirmLabel, confirmToggle as unknown as ElLike, confirmHint);
  body.append(confirmRow);

  /* ── ② 厂商模板 ── */
  const guide = el(doc, 'p', 'nb-note');
  guide.textContent = ASR_QUICK_GUIDE;
  body.append(guide);

  /*
   * ═══ 服务商列表（2026-11-05 改） ═══
   *
   * ## 用户要求
   *
   * > 语音输入里面的服务商的UI不对哈，做成API连接里面的那种就行
   *
   * 改之前是一个原生 `<select>`（`nb-input nb-select`）。问题不是"难看"，
   * 而是**同一件事在两个页面长成了两个样子**：
   *
   * ```text
   *   API 连接   竖排的行列表，点一行就地展开它自己的配置，选中的那行高亮
   *   语音输入   一个下拉 + 下面一堆与"某一行"无关的共用的输入框
   * ```
   *
   * 后者有个真实的认知问题：下拉里选了「Groq」，下面那些输入框**看起来**
   * 是"应用的设置"，实际是"这一个服务商的设置"。用户在 A 服务商填的地址，
   * 切到 B 之后发现还在（因为共用一份），会以为切错了。
   *
   * ## 现在
   *
   * 与 `api-page.ts` 的服务商列表**同一套结构与类名**：
   *
   * ```text
   *   ┏━━━━━━━━━━━━━━━┓  .nb-listitem.nb-src-item
   *   ┃ 阿里百炼 Paraformer ┃
   *   ┃ 需要 DashScope 的 key › ┃
   *   ┣━━━━━━━━━━━━━━━┫  展开时变成抽屉的上半截（CSS 的 [aria-expanded]）
   *   ┃ 服务地址 [        ]  ┃  .nb-acc-panel
   *   ┃ 模型名   [        ]  ┃
   *   ┗━━━━━━━━━━━━━━━┛
   * ```
   *
   * ## 手风琴：同时只展开一个
   *
   * 与 API 连接一致。另一个理由是**字段唯一**：`asr-base-url` 这些
   * `data-role` 在测试与验收脚本里按"全局只有一个"取
   * （`byRole(page, 'asr-model')[0]`）。八个服务商各留一份常驻输入框，
   * 取到的会是第一个（可能是收起的那个），表现是"改了值但保存的不是它"。
   *
   * 所以字段只有**一份真实节点**，展开谁就把它搬进谁的面板
   * （`mountFields`）。不做"八份常驻 + 切显隐"。
   */
  const presetList = el(doc, 'div');
  presetList.setAttribute('data-role', 'asr-preset-list');

  /** 当前选中的服务商（保存时用它） */
  let currentPresetId: string = initial.presetId;
  /** 当前展开的是谁（null = 全部收起） */
  let expandedPresetId: string | null = null;

  interface PresetRow {
    id: string;
    button: ElLike;
    panel: ElLike;
  }
  const presetRows: PresetRow[] = [];

  /**
   * 随服务商变化的那些字段（**只有一份节点**）。
   *
   * 定义在这里（而不是各自的创建处）是为了让 `mountFields` 能按固定顺序
   * 一次性搬过去 —— 顺序散在各处的话，某天加一个字段忘了放进数组，
   * 那个字段就永远不显示，而界面上看不出是"忘了"。
   */
  let fieldNodes: ElLike[] = [];

  // 只支持文本、不支持语音的厂商说明（避免用户在聊天模型里找不到能用的）
  if (TEXT_ONLY_VENDORS_NOTE !== '') {
    const textOnly = el(doc, 'p', 'nb-note');
    textOnly.textContent = TEXT_ONLY_VENDORS_NOTE;
    body.append(textOnly);
  }

  /*
   * ★ 这里**不再**单独放一行「服务商说明」（`preset.note`）。
   *
   * 原来（下拉时代）它是一段独立文字，因为下拉只显示名字。
   * 改成行列表后，`preset.note` 已经是那一行的**副标题** ——
   * 面板里再放一遍就是同一句话连着出现两次（真机截图里一眼就看出来了：
   * 行下「国内直连 · 中文最强」，面板里第一块又是「国内直连 · 中文最强」）。
   *
   * API 连接那边也是这个结构：副标题在行上，面板直接就是字段。
   */

  const urlRow = el(doc, 'div', 'nb-field');
  const urlLabel = el(doc, 'label', 'nb-field-label');
  urlLabel.textContent = '服务地址';
  const urlInput = el(doc, 'input', 'nb-input') as unknown as HTMLInputElement;
  urlInput.setAttribute('type', 'text');
  urlInput.setAttribute('data-role', 'asr-base-url');
  urlInput.setAttribute('placeholder', 'https://…/v1');
  (urlInput as unknown as HTMLInputElement).value = initial.baseUrl;
  const urlHint = el(doc, 'span', 'nb-field-hint');
  urlHint.textContent = '选服务商会自动填好。自己搭的服务填它的地址即可。';
  urlRow.append(urlLabel, urlInput as unknown as ElLike, urlHint);
  /* 不 append 到 body —— 由 mountFields 搬进当前展开的服务商面板 */

  /*
   * 模型路径（仅 gradio 路线）。
   *
   * 为什么单独一个字段而不是塞进「模型名」：
   * 自建服务要的是两个东西 —— **选哪个模型**（`fun-asr-nano`）与
   * **权重放在哪**（`./models/Fun-ASR-Nano`）。合并成一个输入框，
   * 用户改其中一个就必须同时改另一个，且填错时无法判断是哪个错了。
   */
  const modelPathRow = el(doc, 'div', 'nb-field');
  const modelPathLabel = el(doc, 'label', 'nb-field-label');
  modelPathLabel.textContent = '模型路径';
  const modelPathInput = el(doc, 'input', 'nb-input') as unknown as HTMLInputElement;
  modelPathInput.setAttribute('type', 'text');
  modelPathInput.setAttribute('data-role', 'asr-model-path');
  /*
   * ★ placeholder 必须写**反斜杠**（2026-11-02 实测）。
   *
   * 服务端的下拉框合法值是 `./models\Fun-ASR-Nano`（反斜杠），
   * 而这里原来写的是正斜杠。用户照着 placeholder 抄，必然被服务端
   * 的 choices 校验拒掉 —— 而客户端拿到的 `error` 事件 data 是空的，
   * 界面上只会显示"转写失败"，什么都看不出。
   *
   * 现在 `asr-client` 里会做斜杠归一 + 回落到服务端合法值（见
   * `coerceToChoices`），所以正斜杠也能跑；但 placeholder 仍要写对 ——
   * **不要让提示文字本身成为错误的来源**。
   */
  modelPathInput.setAttribute('placeholder', './models\\Fun-ASR-Nano');
  (modelPathInput as unknown as HTMLInputElement).value = initial.modelPath ?? '';
  const modelPathHint = el(doc, 'span', 'nb-field-hint');
  modelPathHint.textContent = GRADIO_MODEL_PATH_HINT;
  modelPathRow.append(modelPathLabel, modelPathInput as unknown as ElLike, modelPathHint);
  modelPathRow.hidden = true;
  // 行的 data-role 与输入框分开：测试要看"整行有没有被藏起来"，而 hidden 设在行上
  modelPathRow.setAttribute('data-role', 'asr-model-path-row');

  const modelRow = el(doc, 'div', 'nb-field');
  const modelLabel = el(doc, 'label', 'nb-field-label');
  modelLabel.textContent = '模型名';
  const modelInput = el(doc, 'input', 'nb-input') as unknown as HTMLInputElement;
  modelInput.setAttribute('type', 'text');
  modelInput.setAttribute('data-role', 'asr-model');
  modelInput.setAttribute('placeholder', '选服务商会自动填好');
  (modelInput as unknown as HTMLInputElement).value = initial.model;

  const fetchBtn = el(doc, 'button', 'nb-btn');
  fetchBtn.setAttribute('type', 'button');
  fetchBtn.setAttribute('data-role', 'fetch-models');
  fetchBtn.textContent = '获取模型列表';
  modelRow.append(modelLabel, modelInput as unknown as ElLike, fetchBtn);

  // 模型列表（拉回来之后填进来，点一下就选中）
  const modelListEl = el(doc, 'div', 'nb-model-list');
  modelListEl.setAttribute('data-role', 'model-list');
  modelListEl.hidden = true;

  const keyRow = el(doc, 'div', 'nb-field');
  const keyLabel = el(doc, 'label', 'nb-field-label');
  keyLabel.textContent = 'API key';
  const keyInput = el(doc, 'input', 'nb-input') as unknown as HTMLInputElement;

  /*
   * ★ 2026-11-02 用户要求：**配置过就显示一串星号，没配过就是空的**。
   *
   * 三态与映射在 `shared/src/voice/key-field.ts`（与 API 配置页共用同一套）。
   * 那一层还负责拦"把掩码串当新 key 写进 ST"这种会把真 key 覆盖掉的错误。
   */
  const hadKeyAtBuild = callbacks.hasKey?.() ?? false;
  let keyState: KeyFieldState = initialKeyState(hadKeyAtBuild);
  const paintKeyField = (): void => {
    keyInput.setAttribute('type', keyFieldType(keyState));
    keyInput.setAttribute('placeholder', keyFieldPlaceholder(keyState));
    keyInput.value = keyFieldValue(keyState);
    keyInput.setAttribute('data-key-state', keyState);
  };
  paintKeyField();

  keyInput.addEventListener?.('focus', () => {
    keyState = keyStateOnFocus(keyState);
    if (keyState === 'editing') keyInput.value = '';
    keyInput.setAttribute('type', keyFieldType(keyState));
    keyInput.setAttribute('placeholder', keyFieldPlaceholder(keyState));
    keyInput.setAttribute('data-key-state', keyState);
  });
  keyInput.addEventListener?.('blur', () => {
    /*
     * ★★★ 用户填了内容时**不许**走 `paintKeyField()`（2026-11-07 真机 bug）。
     *
     * 用户原话：
     *
     * > 我填入秘钥并保存后提示没有输入秘钥
     *
     * 真因就是这两行：`keyStateOnBlur` 在"填了内容"时正确返回 `editing`
     * （它的注释也写着"保存时要读它"），但紧接着 `paintKeyField()` 无条件执行
     * `keyInput.value = keyFieldValue(state)` —— 而 `keyFieldValue('editing')`
     * 是**空串**。
     *
     * 于是：粘贴 → 点一下别处（或直接点保存，真实触摸会让输入框失焦）
     * → 值被抹掉 → 保存时 `keyToSave('')` 返回 null
     * → 当作"这次没改 key" → 若之前没存过，就报"还没有 key"。
     *
     * ★ 为什么自动化探针测不出来：脚本用 `element.click()` 不会移动焦点，
     *   也就不会触发 blur。真实手指点击一定会。**只有真手指能复现的 bug**。
     */
    const next = keyStateOnBlur(keyState, keyInput.value ?? '', callbacks.hasKey?.() ?? false);
    const keepTyped = next === 'editing' && (keyInput.value ?? '').trim() !== '';
    keyState = next;
    if (keepTyped) {
      /* 只更新属性，不碰 value */
      keyInput.setAttribute('type', keyFieldType(next));
      keyInput.setAttribute('placeholder', keyFieldPlaceholder(next));
      keyInput.setAttribute('data-key-state', next);
      return;
    }
    paintKeyField();
  });

  keyInput.setAttribute('data-role', 'asr-key');
  keyInput.setAttribute('autocomplete', 'off');
  const keyHint = el(doc, 'span', 'nb-field-hint');
  keyHint.textContent = keyState === 'masked'
    ? '已经配过了。要换就点一下这里重新粘贴；留空表示不改。'
    : 'key 只存在这台设备上，语音请求直接发给你选的服务商。';
  keyRow.append(keyLabel, keyInput as unknown as ElLike, keyHint);
  keyRow.setAttribute('data-role', 'asr-key-row');

  /*
   * 收集"随服务商变化"的字段（顺序就是它们在面板里的顺序）。
   *
   * 用数组而不是在 `mountFields` 里一个个 append：加字段时只改这一处，
   * 不会出现"新字段忘了搬进去，于是永远不显示"。
   */
  fieldNodes = [
    urlRow,
    modelPathRow,
    modelRow,
    modelListEl,
    keyRow,
  ];

  /* ── ④ 状态与动作 ── */
  const status = el(doc, 'p', 'nb-note');
  status.setAttribute('data-role', 'voice-status');
  /*
   * ★ 有 notice 就显示它（2026-11-01）。
   *
   * 这一行原本是 `status.hidden = true` —— 无条件隐藏。API 页那边
   * 同样的写法导致"已保存"写进去了却看不见，这里是同一批修。
   */
  const hasNotice = callbacks.notice !== undefined && callbacks.notice !== '';
  if (hasNotice) {
    status.textContent = callbacks.notice ?? '';
    status.setAttribute('data-kind', 'ok');
  }
  status.hidden = !hasNotice;
  body.append(status);

  const actions = el(doc, 'div', 'nb-page-foot');
  const testBtn = el(doc, 'button', 'nb-btn');
  testBtn.setAttribute('type', 'button');
  testBtn.setAttribute('data-role', 'test-asr');
  testBtn.textContent = '测试连接';
  const saveBtn = el(doc, 'button', 'nb-btn nb-btn--primary');
  saveBtn.setAttribute('type', 'button');
  saveBtn.setAttribute('data-role', 'save-voice');
  saveBtn.textContent = '保存';
  actions.append(testBtn, saveBtn);
  root.append(actions);

  /* ── 表单值读取（唯一入口） ── */
  const read = (): VoiceSettings => ({
    confirmBeforeSend: (confirmToggle as unknown as HTMLInputElement).checked === true,
    /*
     * 用本地变量 `currentPresetId`，不再从 `<select>` 读 ——
     * 服务商已经改成行列表了，那个 select 不存在了。
     */
    presetId: currentPresetId,
    baseUrl: ((urlInput as unknown as HTMLInputElement).value ?? '').trim(),
    model: ((modelInput as unknown as HTMLInputElement).value ?? '').trim(),
    modelPath: ((modelPathInput as unknown as HTMLInputElement).value ?? '').trim(),
  });

  /* ── 选中的模板 → 自动填 base_url / model ── */

  /**
   * 切模板时同步界面。
   *
   * ## 三件事必须一起做，否则会出现"看起来能填、其实没用"的字段
   *
   * | 模板 | key 输入框 | 模型路径 | 「获取模型列表」 |
   * |---|---|---|---|
   * | 需要 key 的（厂商 / 中转站） | 显示 | 隐藏 | 显示 |
   * | 不需要 key 的（自建 Gradio） | **隐藏** | 显示 | **隐藏** |
   *
   * 隐藏「获取模型列表」的理由：Gradio 服务根本没有 `/models` 接口，
   * 点它必然失败。留着一个必然失败的按钮，等于让用户替我们趟一次错。
   */
  const syncPresetUi = (presetId: string): void => {
    const preset = findAsrPreset(presetId);
    const gradio = preset?.protocol === 'gradio';

    keyRow.hidden = !needsApiKey(presetId);
    modelPathRow.hidden = !gradio;
    fetchBtn.hidden = gradio === true;
    // 本地服务的模型列表不可枚举，留着上次拉到的列表只会误导
    if (gradio) modelListEl.hidden = true;

    if (gradio) {
      // 需求原话：填部署机器的局域网地址，如 http://192.168.1.x:7860
      urlInput.setAttribute('placeholder', 'http://192.168.1.x:7860');
      urlHint.textContent = GRADIO_BASE_URL_HINT;
    } else {
      urlInput.setAttribute('placeholder', 'https://…/v1');
      urlHint.textContent = '选服务商会自动填好。自己搭的服务填它的地址即可。';
    }
  };

  /**
   * 记住"上一次是模板填进去的值"。
   *
   * ## 为什么必须记这件事（2026-11-01 第六批修的真问题）
   *
   * 原来的规则是"模板里该字段为空就保留用户已填的值"，本意是别把用户手填的
   * 地址冲掉。但它没区分**用户填的**和**上一个模板填的**：
   *
   * ```text
   * 选阿里   → 地址自动变成 https://dashscope.aliyuncs.com/...
   * 选本地 Gradio → 该模板要手填，于是"保留原值" → 框里还是阿里的地址
   * 保存 → 拿阿里的地址去连 Gradio → 404
   * ```
   *
   * 而 404 的文案是"端口填错了" —— 用户看着这行字，框里的地址却是别人家的，
   * 完全对不上。**这不是用户的问题，是我们留了一个坑。**
   *
   * 判据改成三态：
   * - 框里的值仍等于上次模板填的值（说明用户没动过）→ 跟着新模板走，可以为空；
   * - 用户改过 → 保留（原有意图）；
   * - 从没模板填过、框里也没值 → 按空处理。
   */
  let autoUrl: string | null = null;
  let autoModel: string | null = null;
  let autoPath: string | null = null;

  /*
   * 冷启动播种：如果存下来的值恰好等于当前预设的模板值，
   * 说明它本来就来自模板（不是用户手填的），后续切换可以覆盖它。
   */
  const seeding = findAsrPreset(initial.presetId);
  if (seeding !== null) {
    if (seeding.baseUrl !== '' && seeding.baseUrl === initial.baseUrl) autoUrl = seeding.baseUrl;
    if (seeding.model !== '' && seeding.model === initial.model) autoModel = seeding.model;
    if (seeding.modelPath !== undefined && seeding.modelPath === initial.modelPath) {
      autoPath = seeding.modelPath;
    }
  }

  /**
   * 按"是否仍是上次模板填的"决定：新模板给了值就填新的，没给就清空。
   *
   * @param input 目标输入框
   * @param next 新模板给的值（空串表示"要求手填"）
   * @param last 上一次模板填进去的值（null 表示没填过）
   * @returns 这次填进去的值（记回去用）
   */
  const fillField = (
    input: unknown,
    next: string,
    last: string | null,
  ): string | null => {
    const element = input as unknown as HTMLInputElement;
    const current = (element.value ?? '').trim();
    const pristine = last === null ? current === '' : current === last;

    if (next !== '') {
      element.value = next;
      return next;
    }
    if (pristine) {
      element.value = '';
      return '';
    }
    return last;
  };

  const applyPreset = (presetId: string): void => {
    const preset = findAsrPreset(presetId);
    if (preset === null) return;

    autoUrl = fillField(urlInput, preset.baseUrl, autoUrl);
    autoModel = fillField(modelInput, preset.model, autoModel);
    if (preset.modelPath !== undefined) {
      autoPath = fillField(modelPathInput, preset.modelPath, autoPath);
    } else if (autoPath !== null) {
      // 换到非 gradio 路线：把上一家留下的路径清掉，免得下次切回来时是旧的
      autoPath = fillField(modelPathInput, '', autoPath);
    }

    /* 服务商说明已经在那一行副标题上（见上方注释），面板里不再重复 */
    syncPresetUi(presetId);
  };

  /* ═══════════════════════════════════════════════════════════
     服务商行列表（与「API 连接」同一套结构，2026-11-05）
     ═══════════════════════════════════════════════════════════ */

  /**
   * 把那一份字段节点搬进某个面板。
   *
   * ## 为什么"搬"而不是"各建一份"
   *
   * 见上面 `presetList` 那段注释：`data-role` 必须全局唯一。
   * 搬之前先 `replaceChildren()` 清空**所有**面板 —— 只清目标那个的话，
   * 上一次展开的那份还留在（隐藏的）面板里，`byRole(...)[0]` 就会取到旧的，
   * 表现是"改了值但保存的不是它"。API 页踩过一模一样的坑
   * （`api-page.ts` 里 2026-10-31 第五批那段注释）。
   */
  const mountFields = (panel: ElLike | null): void => {
    for (const one of presetRows) one.panel.replaceChildren();
    if (panel === null) return;
    for (const node of fieldNodes) panel.append(node);
  };

  /** 只有"选中"与"展开"两件事会改变行的视觉，统一在这里落 */
  const syncRows = (): void => {
    for (const row of presetRows) {
      row.button.setAttribute('aria-pressed', String(row.id === currentPresetId));
      row.button.setAttribute('aria-expanded', String(row.id === expandedPresetId));
      row.panel.hidden = row.id !== expandedPresetId;
    }
  };

  /**
   * 展开某个服务商（`null` = 全部收起）。
   *
   * ## 选中与展开是两件事
   *
   * 与 API 连接一致：点已展开的那一行是**收起**，此时选中不变
   * （`currentPresetId` 仍是它，保存用的还是它）。把两件事绑在一起会
   * 出现"我收起一下看看别的，结果当前服务商被改了"。
   *
   * `expandPreset` 只管展开；"点一下同时选中并展开"在点击处理器里组合。
   */
  const expandPreset = (presetId: string | null): void => {
    expandedPresetId = presetId;
    if (presetId === null) {
      mountFields(null);
    } else {
      const row = presetRows.find((one) => one.id === presetId);
      mountFields(row === undefined ? null : row.panel);
    }
    syncRows();
  };

  for (const preset of ALL_ASR_PRESETS) {
    const button = el(doc, 'button', 'nb-listitem nb-src-item');
    button.setAttribute('type', 'button');
    button.setAttribute('data-role', 'asr-preset-item');
    button.setAttribute('data-preset-id', preset.id);
    button.setAttribute('aria-pressed', String(preset.id === currentPresetId));
    button.setAttribute('aria-expanded', 'false');

    const main = el(doc, 'span', 'nb-listitem-main');
    const name = el(doc, 'span', 'nb-listitem-title');
    /*
     * 「（高级）」保留在下拉时代的说法：不是说它难用，而是提醒
     * "这条路要多填一两项"。`preset.advanced` 是表里已有的标记。
     */
    name.textContent = preset.advanced ? `${preset.name}（高级）` : preset.name;
    const hint = el(doc, 'span', 'nb-listitem-sub');
    hint.textContent = preset.note;
    main.append(name, hint);

    const chevron = el(doc, 'span', 'nb-src-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    button.append(main, chevron);

    const panel = el(doc, 'div', 'nb-acc-panel');
    panel.setAttribute('data-role', 'asr-preset-panel');
    panel.setAttribute('data-preset-id', preset.id);
    panel.hidden = true;

    button.addEventListener('click', () => {
      if (expandedPresetId === preset.id) {
        /* 已展开 → 再点收起（选中保持不变） */
        expandPreset(null);
        return;
      }
      /*
       * 展开别的 → 同时把它设为当前服务商，并同步模板值。
       *
       * 顺序：先 `applyPreset` 再 `expandPreset`。反过来的话，
       * 面板先被挂上、字段还是上一个服务商的默认值，用户会看到
       * 一帧"别人的地址"（然后才被填成自己的）。
       */
      currentPresetId = preset.id;
      applyPreset(preset.id);
      expandPreset(preset.id);
    });

    presetRows.push({ id: preset.id, button, panel });
    presetList.append(button, panel);
  }

  body.append(presetList);

  /*
   * 初始状态：选中当前服务商并**展开它**（与 API 连接一致 ——
   * 进去就能看到"当前用的是哪个、它需要填什么"）。
   */
  applyPreset(currentPresetId);
  expandPreset(currentPresetId);

  /* ── 获取模型列表 ── */

  fetchBtn.addEventListener('click', () => {
    void (async () => {
      const settings = read();
      /*
       * 取 key：优先用用户刚输入的新值，否则回落到已存的那把。
       *
       * `keyToSave` 对掩码哨兵值返回 null（显示中的圆点不是值），
       * 此时必须用 `readKey()` 拿真 key —— 否则会把 12 个圆点当 key 发出去。
       */
      const typedKey = keyToSave((keyInput as unknown as HTMLInputElement).value ?? '');
      const key = typedKey ?? (callbacks.readKey?.() ?? '').trim();
      if (callbacks.onFetchModels === undefined) return;
      if (key === '') {
        showStatus('先填 key 才能拉列表。已经有 key 的话留空也能试 —— 若失败再填一次。', 'warn');
      }
      try {
        const models = await callbacks.onFetchModels(settings, key);
        renderModelList(models);
      } catch (error) {
        showStatus(error instanceof Error ? error.message : String(error), 'danger');
      }
    })();
  });

  const renderModelList = (models: string[]): void => {
    modelListEl.replaceChildren();
    if (models.length === 0) {
      modelListEl.hidden = true;
      showStatus('这个服务没有返回可用的语音模型。可能是 key 不对，或该服务不提供语音转写。', 'warn');
      return;
    }
    modelListEl.hidden = false;
    for (const name of models) {
      const item = el(doc, 'button', 'nb-listitem');
      item.setAttribute('type', 'button');
      item.setAttribute('data-model', name);
      const main = el(doc, 'span', 'nb-listitem-main');
      const t = el(doc, 'span', 'nb-listitem-title');
      t.textContent = name;
      main.append(t);
      item.append(main);
      item.addEventListener('click', () => {
        (modelInput as unknown as HTMLInputElement).value = name;
        modelListEl.hidden = true;
        showStatus(`已选 ${name}`, 'ok');
      });
      modelListEl.append(item);
    }
    showStatus(`拉到 ${models.length} 个可用模型，点一个填进去。`, 'ok');
  };

  /* ── 测试连接 ── */

  testBtn.addEventListener('click', () => {
    void (async () => {
      const settings = read();
      /* 与"获取模型列表"同一条规则：掩码不是值，要回落到已存的那把 */
      const typedKey = keyToSave((keyInput as unknown as HTMLInputElement).value ?? '');
      const key = typedKey ?? (callbacks.readKey?.() ?? '').trim();
      const preset = findAsrPreset(settings.presetId);

      // 校验顺序：先模板存在 → 再地址/模型 → 最后 key
      if (preset === null) {
        showStatus('选一个服务商。', 'warn');
        return;
      }
      if (settings.baseUrl === '') {
        showStatus('还没填服务地址。', 'warn');
        return;
      }
      if (settings.model === '') {
        showStatus('还没填模型名。可以点「获取模型列表」挑一个。', 'warn');
        return;
      }
      /*
       * key 只有**这条路线需要它**时才拦。
       *
       * 自建 Gradio 服务没有鉴权，硬要一个 key 只会让用户去编一串字符塞进去 ——
       * 然后他以为配好了，实际那个值从没被用到。
       */
      if (key === '' && needsApiKey(settings.presetId)) {
        showStatus('还没填 key。', 'warn');
        return;
      }

      showStatus('正在测试…', 'info');
      const audio = await (callbacks.testAudio?.() ?? makeTestAudio());
      const result = await transcribe({
        preset,
        baseUrl: settings.baseUrl,
        apiKey: key,
        model: settings.model,
        ...(settings.modelPath !== undefined ? { modelPath: settings.modelPath } : {}),
        audio,
        fetchImpl: callbacks.fetchImpl,
      });

      if (!result.ok) {
        showStatus(result.failure.message, 'danger');
        return;
      }
      /*
       * ★ 这里必须说清"通过了什么、没验证什么"。
       *
       * 内置测试音频是合成音，ASR 识别不出有意义的文字 ——
       * 它证明的是**链路通、鉴权过**，不是识别质量。
       * 只说"测试通过"会让用户以为识别效果好，用起来不对就以为是 bug。
       */
      showStatus(
        `连接正常，服务有响应${result.text.trim() === '' ? '（测试音是合成的，识别不出文字是正常的）' : ''}。真实录音的效果取决于服务本身。`,
        'ok',
      );
    })();
  });

  /* ── 保存 ── */

  saveBtn.addEventListener('click', () => {
    void (async () => {
      const settings = read();
      /*
       * 保存时**只**认用户新输入的值（null = 不改）。
       *
       * 这里故意**不**回落到 `readKey()`：保存的语义是"把我填进去的存下来"，
       * 没填就不动已存的那把。回落到旧值会把同一把 key 反复写一遍
       * （无害但会制造"每次保存都在改 key"的假象），而且一旦哪天
       * `readKey` 读失败，就会把空串当成"用户要清空 key"写进去。
       */
      const key = keyToSave((keyInput as unknown as HTMLInputElement).value ?? '');
      if (settings.baseUrl === '' || settings.model === '') {
        showStatus('服务地址和模型名都要填。', 'warn');
        return;
      }
      try {
        await callbacks.onSave(settings, key);
        /*
         * ★ 2026-11-02：保存后**不再清空**输入框，改成回到 masked 态。
         *
         * 原来是 `value = ''`，用户看到的是"我刚填的 key 消失了" ——
         * 这正是他这次报的「秘钥看不见了，我不知道有没有配置」。
         * 现在显示一串星号：既证明"存进去了"，又不泄露真值。
         */
        keyState = 'masked';
        paintKeyField();
        showStatus('已保存', 'ok');
        callbacks.onNotify?.('语音设置已保存', 'ok');
      } catch (error) {
        showStatus(error instanceof Error ? error.message : String(error), 'danger');
      }
    })();
  });

  const showStatus = (message: string, kind: 'info' | 'ok' | 'warn' | 'danger'): void => {
    status.hidden = false;
    status.textContent = message;
    status.setAttribute('data-kind', kind);
    callbacks.onNotify?.(message, kind);
  };

  return { root, read };
}

/**
 * 内置「3 秒测试音频」。
 *
 * ## 为什么是合成音，而不是录一段人声
 *
 * 人声样本要么体积大（塞进仓库不合适）、要么需要真人录（用户第一次配置时
 * 不该被要求先录一段）。而这次校验的目标是**链路通不通**，不是识别质量 ——
 * 合成音完全够用。
 *
 * 合成一个 440Hz 的正弦波（WAV 头 + 16 位 PCM）。用 WAV 而不是 m4a/webm：
 * 这两种编码器在浏览器里只有 MediaRecorder 能给，而那是**输入设备相关**的 ——
 * 拿不到麦克风的环境（比如桌面上没插麦）也会连带做不了测试。
 * WAV 可以纯用 ArrayBuffer 拼出来，零依赖。
 */
export async function makeTestAudio(durationSec = 3, sampleRate = 16000): Promise<Blob> {
  const samples = Math.floor(durationSec * sampleRate);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块大小
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  writeAscii(36, 'data');
  view.setUint32(40, samples * 2, true);

  /*
   * 用一个**缓慢起伏的 440Hz 音**而不是恒定正弦。
   *
   * 恒定的纯音会让部分服务直接判"静音/无语音"而返回空；
   * 加起伏（幅度 30%..70% 的正弦调制）更接近人说话的包络，
   * 至少能被当成"有音频输入"。
   */
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const envelope = 0.5 + 0.2 * Math.sin(2 * Math.PI * 2 * t);
    const value = Math.sin(2 * Math.PI * 440 * t) * envelope;
    view.setInt16(44 + i * 2, Math.round(value * 32767 * 0.6), true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/** 给外壳用：拿到某模板以便构造转写器 */
export function presetOf(settings: VoiceSettings): AsrPreset | null {
  return findAsrPreset(settings.presetId);
}

/** 高级模板清单（给"高级模式"折叠区用） */
export { ASR_ADVANCED_PRESETS };
