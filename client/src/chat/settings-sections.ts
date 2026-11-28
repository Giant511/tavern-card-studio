/**
 * 功能
 * 设置页的两块折叠项与其回调：API 配置、诊断、设置页回调、预设回调，
 * 外加四个配套动作（写连接参数进 ST、探测 key、诊断文本选中、采样推导）。
 * 从 AppShell 搬出，共 8 个函数约 1000 行。
 *
 * 注意事项
 * 这些函数**返回 DOM 或回调对象**，不自己挂载 —— 挂载仍由壳的
 * `renderSettingsPage()` 做，所以壳里是
 * `renderAccordion({ ..., buildBody: () => renderApiSection(this.settingsHost()) })`。
 *
 * 字段几乎全留壳上：`sampling` / `thinking*` / `contextLimit` / `responseLimit`
 * 在构建聊天请求时也要用（不在本簇内），`apiState` 被聊天页读来判当前源。
 * 只有 `apiExpanded` / `diagExpanded` / `pendingApiNotice` 是纯页面状态。
 *
 * 踩过的坑
 * `pendingApiNotice` 是"一次性提示"：显示完必须置空，否则下次进设置页还会
 * 看到上一次的错。字段留壳、由本模块在渲染末尾清掉。
 */

import type { ApiPageState } from './api-page.ts';
import type { ChatSettingsCallbacks } from './chat-settings';
import type { ChatPanel, ChatPanelContext } from './chat-panel';
import type { AccordionSpec } from './shell-contract';
import type { ChatSessionState } from './chat-session-state';
import type { ShellOptions } from './shell-contract';
import type { StChatBridge } from './st-bridge';
import type { ParamFamily, ParsedPromptConfig, ThinkingIntent } from '@tcs/shared';

import {
  CHAT_SOURCE_LABELS,
  buildStConnectionPatch,
  describeBridgeError,
  isLocalEndpoint,
  computeBudget,
  isSupportedChatSource,
  mutateSettings,
  parseSettingsEnvelope,
  previewReasoningPlan,
  samplingFromSettings,
  secretKeyOf,
  currentPresetName,
  describeSettingsFailure,
  mergePresetIntoOai,
  parsePresetList,
  parsePromptConfig,
  planApplyPreset,
  presetBodiesByName,
  presetNameFromFile,
  validatePresetBody,
  verifyConnectionPersisted,
  writeField,
  type DerivedSampling,
  type PresetSummary,
  type StChatSource,
  type StSettings,
} from '@tcs/shared';

import { el, type DocLike, type ElLike } from './chat-view';
import { renderApiPage } from './api-page.ts';
import {
  buildDiagReport,
  clearDiagLog,
  diagNote,
  exportNativeLog,
  nativeStatus,
  readDiagEntries,
} from '../diagnostics/mobile-diag.ts';
import { pickFetch } from './native-fetch';

/**
 * 功能
 * 本模块能碰的壳能力。
 *
 * 注意事项
 * 成员偏多（14 个字段 + 8 个动作）是因为"设置页"本身就是壳的横切面：
 * API 配置要读采样参数、诊断要读连接状态。这是这一层的实际形状。
 * 加成员前先确认能否从参数传进来。
 *
 * 踩过的坑
 * 无。
 */
export interface SettingsHost extends ChatSessionState {
  readonly doc: DocLike;
  readonly bridge: StChatBridge;
  readonly options: ShellOptions;
  readonly chatPanel: ChatPanel | null;

  /** API 折叠项是否展开 */
  apiExpanded: boolean;
  /** 诊断折叠项是否展开 */
  diagExpanded: boolean;
  /** 当前 API 页状态（源、模型、是否已填 key…） */
  apiState: ApiPageState;
  /** 哪些源已填 key。探测后整体替换（`Set` 而不是逐条增删 —— 见 refreshKeyPresence 的注释） */
  apiKeyPresent: Set<StChatSource>;
  /** 一次性 API 提示，显示完要清（置 null）。空串会显示一个空提示框 */
  pendingApiNotice: string | null;
  /** 上一次保存设置失败的原因。null 表示没有失败（不是空串 —— 空串会显示一个空提示框） */
  lastSettingsFailure: string | null;
  /** 采样参数（聊天请求也用） */
  sampling: DerivedSampling;
  /** 上下文上限（token）。undefined = 用源的默认值，不是 0 */
  contextLimit: number | undefined;
  /** 回复上限（token）。undefined = 用源的默认值 */
  responseLimit: number | undefined;
  showReasoning: boolean;
  thinkingBudget: number | string | undefined;
  thinkingFamily: ParamFamily | undefined;
  thinkingIntent: ThinkingIntent;

  /** API 页的容器元素（渲染后回填，用于局部刷新） */
  apiPageEl: ElLike | null;
  /** 全局提示词配置（提示词簇的字段，设置页要读它算"已生效几条"） */
  globalPromptConfig: ParsedPromptConfig | null;
  /** 会话的提示词格式表（传进 chatPanel 的 ctx） */
  promptFormats: ChatPanelContext['promptFormats'];

  withConnection<T>(run: () => Promise<T>): Promise<T>;
  renderPage(): void;
  goBackOneLevel(): boolean;
  renderAccordion(spec: AccordionSpec): ElLike;
  /** 最近一次引擎退出是否干净（诊断页顶部那条） */
  diagBoot(): { lastExitClean: boolean };
  /** 提示词配置变了要重算（提示词簇实现） */
  rebuildPromptConfig(): void;
}

export function deriveSampling(host: SettingsHost, settings: Record<string, unknown>): DerivedSampling {
  return samplingFromSettings(settings);
}

export async function writeApiConnectionToSt(host: SettingsHost, 
  state: ApiPageState,
  apiKey: string | null,
): Promise<string[] | null> {
  const problems: string[] = [];

  /*
   * ── ① 秘钥：核对引擎里这个源**到底有没有**可用 key ──
   *
   * ★★★ 这里原来有个致命的条件：只有"这次填了新 key"才核对。
   *
   * ```ts
   *   if (apiKey !== null && apiKey.trim() !== '') { …核对… }
   * ```
   *
   * ## 它造成的完整事故链（2026-11-12 真机取证）
   *
   * 用户报「填了秘钥，还是 401」并说"点保存后提示已保存"。
   * 直连他手机的 ST 读 `/api/secrets/read`：**52 个槽位全是 null**。
   * 也就是说 key 一个字节都没进去，而界面一路说成功。
   *
   * ```text
   *   ① api-page 拿到的 rawKey 是 null（原因待查，见下面的日志）
   *   ② 这一步因为 apiKey === null 直接跳过核对
   *   ③ problems 为空 ⇒ stOk = true
   *   ④ 界面显示「已保存（已同步到服务）」
   *   ⑤ 发消息 → Bearer 为空 → 上游 401
   * ```
   *
   * ## 修法：不管这次填没填，都问引擎"有没有"
   *
   * 「不改 key」不等于「不需要 key」。用户点了保存，就该知道
   * 这个接口现在到底能不能用。
   *
   * ## 为什么是 warn 而不是 error
   *
   * 有些源**本来就不需要 key**（本地跑的 ollama / koboldcpp / vLLM，
   * 地址是回环或局域网）。对它们硬报错会让用户没法保存。
   *
   * 所以：`custom` 源 + 回环地址 ⇒ 不要求 key（它就是本地服务）；
   * 其余情况没有 key ⇒ 明确提示"发消息会失败"，但不阻断保存。
   */
  let keyWritten = false;
  {
    const secretKey = secretKeyOf(state.source);
    try {
      /*
       * ★★★ 这里**不再写 key**，只回读确认（2026-11-09）。
       *
       * ## 为什么把写入让给 api-page
       *
       * 两处都写会让 ST 的 secrets.json 每次保存多出一条
       * （`writeSecret` 是追加语义）。api-page 是用户点"保存"的直接处理者，
       * 由它写最自然；这一层负责**核实**。
       *
       * ## 为什么要核实（这是本轮修的核心）
       *
       * 用户报：
       *
       * > 我明明填了秘钥……报 Key 错误：Key 填错、过期或未设置 Bearer
       *
       * 真机取证（直连 ST 的 `/api/secrets/read`）：整张表**全是 null**，
       * 包括 `api_key_custom`。也就是 key 一个字节都没进去，而界面说成功。
       * 于是请求带 `Authorization: Bearer `（空），上游回"未设置 Bearer"。
       *
       * `writeSecret` 返回 200 只说明 ST **收下了请求**，不代表 secrets.json
       * 里真有一条 `active: true`。而 ST 的 `readSecret()` 只认 active 那条：
       *
       * ```js
       *   const activeSecret = secretArray.find(s => id ? s.id === id : s.active);
       *   return activeSecret?.value || '';      // 没有 active ⇒ 空串
       * ```
       *
       * 所以判据要用 ST 自己的口径：**`secretPresent()` 里有没有这个名字**。
       * 那个函数已改成与 `readSecret` 完全一致（只认 active:true）。
       */
      const present = await host.withConnection(() => host.bridge.secretPresent());
      if (present.includes(secretKey)) {
        keyWritten = true;
      } else if (apiKey !== null && apiKey.trim() !== '') {
        /* 这次填了，引擎里却没有 ⇒ 写入本身失败了，这是硬错误 */
        problems.push(
          `秘钥没在引擎里生效（${secretKey} 找不到 active 记录）。` +
            '再点一次保存；还不行就说明引擎没连上。',
        );
      } else if (!isLocalEndpoint(state.baseUrl)) {
        /*
         * 这次没填、引擎里也没有 ⇒ 用户以为配好了，实际必然失败。
         *
         * 这是本次修复的核心：原来这种情况**什么都不说**，界面还显示
         * "已保存（已同步到服务）"。用户只能等到发消息看到 401 才知道。
         *
         * 文案要说清两件事：现在什么状态、下一步做什么。
         */
        problems.push(
          `这个接口还没有可用的秘钥 —— 现在发消息会失败。` +
            '把 key 粘贴到上面的输入框，再点一次保存。',
        );
      }
      /* 没填 + 本地服务 ⇒ 不需要 key，不报 */
    } catch (error) {
      /*
       * 写不进去**必须报**：只改源和模型而不写 key，等于把用户
       * 从"能聊"改成"必然 401"，而且表面上一切正常。
       */
      problems.push(
        `秘钥没写进引擎：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /* ── ② settings：source / model / custom_url ── */
  const patch = buildStConnectionPatch(state);
  let saved: Record<string, unknown> | null = null;
  try {
    const result = await mutateSettings(
      {
        getRaw: () => host.withConnection(() => host.bridge.settingsGetRaw()),
        save: (settings) => host.withConnection(() => host.bridge.settingsSave(settings)),
      },
      (current) => {
        const oai = current['oai_settings'];
        const base = oai !== null && typeof oai === 'object' ? (oai as Record<string, unknown>) : {};
        return { ...current, oai_settings: { ...base, ...patch } };
      },
    );
    if (!result.ok) {
      problems.push(`连接配置没写进引擎：${result.reason}`);
    } else {
      saved = result.settings;
    }
  } catch (error) {
    problems.push(
      `连接配置没写进引擎：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  /* ── ③ 回读校验：不信"写成功"，只信"读回来一致" ── */
  if (saved !== null) {
    try {
      const raw = await host.withConnection(() => host.bridge.settingsGetRaw());
      const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
      const parsed = parseSettingsEnvelope(envelope);
      if (!parsed.ok) {
        problems.push(`保存后核对不一致：${parsed.reason}`);
      } else {
        const verdict = verifyConnectionPersisted(parsed.settings, {
          source: state.source,
          model: state.model,
          baseUrl: state.baseUrl,
          keyWritten,
        });
        if (!verdict.ok) problems.push(...verdict.problems);
      }
    } catch (error) {
      problems.push(
        `保存后核对不一致：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return problems.length === 0 ? null : problems;
}

export async function refreshKeyPresence(host: SettingsHost): Promise<void> {
  let names: string[];
  try {
    names = await host.withConnection(() => host.bridge.secretPresent());
  } catch {
    /* 连不上 / 解析失败：保持现有显示（"不知道"不等于"都没有"） */
    return;
  }

  /*
   * ST 的 secret key 命名是 `api_key_<source>`（见 ST 的 `SECRET_KEYS`）。
   * 直接按前缀剥，比维护一张映射表稳 —— ST 加新源时自动跟着走，
   * 剥出来的名字若不在我们的支持列表里，`isSupportedChatSource` 会挡掉。
   */
  const fromSt = new Set<StChatSource>();
  for (const name of names) {
    if (!name.startsWith('api_key_')) continue;
    const candidate = name.slice('api_key_'.length);
    if (isSupportedChatSource(candidate)) fromSt.add(candidate);
  }

  /*
   * 没变化就不重绘 —— 否则每次进 API 页都会闪一下
   * （重绘会收起已展开的收纳项，用户正在填的输入框也会被换掉）。
   */
  const same =
    fromSt.size === host.apiKeyPresent.size &&
    [...fromSt].every((one) => host.apiKeyPresent.has(one));
  if (same) return;

  host.apiKeyPresent = fromSt;

  /* 只有用户正看着 API 那一块时才重绘，别打扰别的页面 */
  if (host.apiExpanded) host.renderPage();
}

export function makeSettingsCallbacks(host: SettingsHost): ChatSettingsCallbacks {
  return {
    /*
     * 统一走层级表（2026-11-03 第二十三批）。
     *
     * 原来这里写的是 `route === 'menu' ? null : 'menu'` —— 对分组页正确，
     * 但它把"上一级是谁"这件事**又实现了一遍**，与别处的写死目标分叉。
     * 现在只有 `parentRouteOf()` 一个答案。
     */
    onBack: () => {
      host.goBackOneLevel();
    },
    /*
     * ★ 菜单项点进分组页。
     *
     * 这一行第一次**漏了** —— `chat-settings.ts` 里 `callbacks.onOpenGroup?.()`
     * 是可选调用，没接线时它安静地什么也不做：菜单渲染得好好的、四项都在、
     * 点下去毫无反应。截图里就是"点了还停在菜单"。
     *
     * 又是"实现存在但没接线"（本项目最反复的缺陷类型）。
     * 所以 `test/chat-settings-ui.test.mjs` 里有一条断言专门守它：
     * `makeSettingsCallbacks` 必须给 `onOpenGroup` 赋值。
     */
    onOpenGroup: (groupId) => {
      host.chatSettingsRoute = groupId;
      host.renderPage();
    },
    reasoning: {
      get: () => host.showReasoning,
      set: (next) => {
        host.showReasoning = next;
        host.options.onPersistShowReasoning?.(next);
        /*
         * 面板如果已经建好，要**立刻**把新值推过去 ——
         * 否则用户翻完开关回到聊天，下一次生成还是旧行为。
         */
        host.chatPanel?.setShowReasoning(next);
      },
    },
    /*
     * 「思考」区块（2026-11-07，P0 第三步）。
     *
     * ## 这里的 `computePreview` 是**唯一**的判定入口
     *
     * 用户要求前端不许猜厂商。所以设置页每点一次三态，都回到这里
     * 调一次 `previewReasoningPlan` —— 它和发送路径共用同一个实现
     * （`buildGenerateRequest` 内部也调它），所以"界面显示"与"实际发出"
     * 必然一致，不会分叉。
     */
    thinking: {
      initialIntent: host.thinkingIntent,
      initialBudget: host.thinkingBudget,
      initialEffort: host.sampling['reasoningEffort'] as string | undefined,
      ...(host.thinkingFamily === undefined ? {} : { initialFamily: host.thinkingFamily }),
      computePreview: (intent, budget, family) =>
        previewReasoningPlan({
          source: host.apiState.source,
          model: host.apiState.model,
          customUrl: host.apiState.baseUrl,
          intent,
          budget,
          ...(family === undefined ? {} : { manualFamily: family }),
        }),
      onChange: (state) => {
        host.thinkingIntent = state.intent;
        host.thinkingBudget = state.budget;
        host.thinkingFamily = state.family;
        host.options.onPersistThinking?.(state);
        /*
         * 推给聊天面板：下一次生成立刻用新值。
         *
         * 不走 `renderPage()` —— 那会把用户刚展开的折叠区收回去、
         * 还会抢焦点（本页真机踩过 `activeElement: BODY`）。
         */
        host.chatPanel?.setThinking(state.intent, state.budget, state.family);
      },
    },
    onOpenActions: () => {
      host.chatSettingsRoute = 'actions';
      host.renderPage();
    },
    /*
     * 上下文预算（2026-11-03，第十九批 ④）。
     *
     * 用**回调**而不是传死值：用户在这一页改完「上下文长度」并保存后，
     * 外壳手上的 `promptFormats` / 面板上的用量都变了 ——
     * 传死值会让提示停留在旧数字上，而用户会以为自己没改成功。
     *
     * 预算为 0（ST 里没填上下文长度）时如实返回 0，
     * 页面据此显示"不会裁剪"而不是"预算 0 token"。
     */
    /*
     * 打开「提示词管理」（2026-11-03 第二十二批）。
     *
     * ★ 这一行漏了就是"入口不存在"——`callbacks.onOpenPrompts` 是可选调用，
     * 不传时整块不渲染，界面上看不到、点了也没反应，而测试全绿。
     * 本项目最反复的缺陷类型（memory §90.6 记过 6 次）。
     */
    onOpenPrompts: () => {
      host.chatSettingsRoute = 'prompts';
      host.renderPage();
    },
    budget: () => {
      const contextLimit = host.contextLimit;
      const responseLimit = host.responseLimit;
      const usage = host.chatPanel?.tokenUsage() ?? null;
      return {
        budget: computeBudget(contextLimit, responseLimit),
        contextLimit,
        responseLimit,
        lastUsed: usage === null ? null : usage.used,
        lastTrimmed: usage === null ? 0 : usage.trimmed,
        overBudget: usage !== null && usage.budget > 0 && usage.used > usage.budget,
      };
    },
    loadSettings: async () => {
      try {
        const raw = await host.withConnection(() => host.bridge.settingsGetRaw());
        const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
        const parsed = parseSettingsEnvelope(envelope);
        if (!parsed.ok) {
          // 读到了但解析不了 —— 要把原因带出去（见 loadFailure）
          host.lastSettingsFailure = parsed.reason;
          return null;
        }
        host.lastSettingsFailure = null;
        return parsed.settings;
      } catch (error) {
        /*
         * ★ 不能只 `return null` 就完事。
         *
         * 设置页要区分"引擎没起"与"引擎在跑但读失败" —— 那是两种不同的
         * 下一步动作，而用户这次报的正是"引擎在跑、UI 却说没起来"。
         * 所以把原始原因记下来，交给 `readSettingsFailure()` 归因。
         */
        host.lastSettingsFailure = describeBridgeError(error).message;
        return null;
      }
    },
    /*
     * 设置读失败时给页面一份**如实**的归因。
     *
     * 页面自己没有能力判断引擎死活（它只拿到一个 null），
     * 所以由外壳把"读失败原因 + 引擎真实状态"组合好再交出去。
     */
    describeReadFailure: () =>
      describeSettingsFailure(host.options.readEngineStatus?.() ?? null, host.lastSettingsFailure ?? undefined),
    saveFields: async (fields) => {
      /*
       * 走 `mutateSettings`：GET → 改 → 整份 POST，三道防线在那边。
       * 这里**不许**直接调 `bridge.settingsSave` —— 那是整份覆盖，
       * 少一个字段就把用户设置清空了。
       */
      const result = await mutateSettings(
        {
          // ★ 两个传输动作都过连接门 —— mutateSettings 内部就是 GET→改→POST
          getRaw: () => host.withConnection(() => host.bridge.settingsGetRaw()),
          save: (settings) => host.withConnection(() => host.bridge.settingsSave(settings)),
        },
        (current) => {
          let next: StSettings = current;
          for (const { field, value } of fields) {
            next = writeField(next, field, value) as StSettings;
          }
          return next;
        },
      );

      if (!result.ok) return { ok: false, reason: result.reason };

      /*
       * ★ 保存成功后**立刻**把新采样值推给聊天面板。
       *
       * 不推的后果：用户改完温度、回到聊天页，发现回复风格没变 ——
       * 因为请求体里还是旧值。而这个问题**不会报错**，只能靠"再发一条
       * 试试"才发现，很容易被当成"模型不听话"。
       *
       * 用保存后的 `result.settings` 重新派生（而不是从 `fields` 里挑），
       * 保证运行时值与存储值来自同一份数据、同一个函数 ——
       * 挑字段就等于在第二个地方实现一遍映射。
       */
      host.sampling = deriveSampling(host, result.settings);
      host.chatPanel?.setContext({ sampling: { ...host.sampling } });

      return { ok: true };
    },
    /*
     * 预设（2026-11-03 / 任务 #259）。
     *
     * 只对「AI 响应配置」给 —— 那一组就是 ST 的 `OpenAI Settings` 预设。
     * 其它组没有预设概念，渲染一个下拉只会让人困惑。
     */
    presets: makePresetCallbacks(host),
    onNotify: host.options.onNotify,
  };
}

export function makePresetCallbacks(host: SettingsHost): {
  list: () => Promise<{ presets: PresetSummary[]; current: string } | null>;
  apply: (name: string) => Promise<{ ok: boolean; reason?: string; skipped?: number }>;
  importFile: () => Promise<{ ok: boolean; name?: string; reason?: string }>;
} {
  return {
    list: async () => {
      try {
        const raw = await host.withConnection(() => host.bridge.settingsGetRaw());
        const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
        if (envelope === null || typeof envelope !== 'object') return null;
        const presets = parsePresetList(envelope);
        const parsed = parseSettingsEnvelope(envelope);
        const current = parsed.ok ? currentPresetName(parsed.settings) : '';
        return { presets, current };
      } catch {
        /*
         * 读不到列表**不等于**出错要报警：用户可能就是想调单个参数。
         * 返回 null 让界面把提示换成"可以先用下面的单项设置"，
         * 而不是弹一个红色错误挡住整个页面。
         */
        return null;
      }
    },

    apply: async (name) => {
      try {
        /* 先拿到要切的那份预设体 */
        const raw = await host.withConnection(() => host.bridge.settingsGetRaw());
        const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
        if (envelope === null || typeof envelope !== 'object') {
          return { ok: false, reason: '读不到预设列表' };
        }
        const bodies = presetBodiesByName(envelope);
        const body = bodies[name];
        if (body === undefined) {
          return { ok: false, reason: `找不到名为「${name}」的预设（可能刚被删掉）` };
        }

        const plan = planApplyPreset(body, name);
        if (Object.keys(plan.updates).length === 0) {
          return { ok: false, reason: `「${name}」里没有可用的参数（文件是空的？）` };
        }

        /*
         * 走 `mutateSettings`（GET → 改 → 整份 POST），
         * 不是直接 `settingsSave` —— 那是整份覆盖，少一个字段就清空用户设置。
         */
        const result = await mutateSettings(
          {
            getRaw: () => host.withConnection(() => host.bridge.settingsGetRaw()),
            save: (settings) => host.withConnection(() => host.bridge.settingsSave(settings)),
          },
          (current) => {
            const oai = (current['oai_settings'] ?? {}) as Record<string, unknown>;
            const merged = mergePresetIntoOai(oai, plan);
            return { ...current, oai_settings: merged } as StSettings;
          },
        );

        if (!result.ok) return { ok: false, reason: result.reason };

        /* 立刻把新采样值推给聊天面板 —— 否则下一次生成还用旧值 */
        host.sampling = deriveSampling(host, result.settings);
        host.chatPanel?.setContext({ sampling: { ...host.sampling } });

        /*
         * 提示词配置也要跟着换（2026-11-03）。
         *
         * ★ 不重新播的话会出现**最难归因的一种**：用户切换了预设，
         * 采样值变了（温度/长度立刻新值），但提示词还是上一份预设的 ——
         * 表现是"换了预设，风格只变了一半"，而这看起来像模型不稳定。
         *
         * 这里直接传预设体（手上就有），不用再发一次请求。
         *
         * ★ v0.2.0：赋给 `globalPromptConfig` 再 `rebuildPromptConfig()`。
         *   换预设不该改变"这个角色的定制"，所以角色覆盖要重新叠上去。
         */
        const nextConfig = parsePromptConfig(body);
        host.globalPromptConfig = nextConfig.prompts.length > 0 ? nextConfig : null;
        host.rebuildPromptConfig();
        {
          const readText = (key: string): string | undefined => {
            const value = (body as Record<string, unknown>)[key];
            return typeof value === 'string' && value !== '' ? value : undefined;
          };
          host.promptFormats = {
            scenarioFormat: readText('scenario_format'),
            personalityFormat: readText('personality_format'),
            wiFormat: readText('wi_format'),
            newExampleChatPrompt: readText('new_example_chat_prompt'),
          };
        }
        host.chatPanel?.setContext({ promptFormats: host.promptFormats });

        return { ok: true, skipped: plan.skipped.length };
      } catch (error) {
        return { ok: false, reason: describeBridgeError(error).message };
      }
    },

    importFile: async () => {
      try {
        /* 1. 选文件（原生对话框在 Rust 侧，见 `pick_json_file`） */
        const picked = await host.bridge.pickJsonFile();
        /*
         * 用户取消 ≠ 失败。取消时静默返回"没做成、也没出错"，
         * 界面据此什么都不弹 —— 弹一条红色"导入失败"会让用户以为程序坏了。
         */
        if (!picked.ok) {
          return picked.cancelled === true ? { ok: false, reason: '' } : { ok: false, reason: picked.reason };
        }

        /* 2. 解析 + 校验（导错文件在这里拦住，别等到"导入了却没用"） */
        let body: unknown;
        try {
          body = JSON.parse(picked.text);
        } catch {
          return { ok: false, reason: `「${picked.fileName}」不是合法的 JSON 文件。` };
        }

        const verdict = validatePresetBody(body);
        if (!verdict.ok) return { ok: false, reason: verdict.reason };

        const name = presetNameFromFile(picked.fileName);
        if (name === '') return { ok: false, reason: '文件名是空的，没法给预设起名。' };

        /* 3. 写进 ST */
        const saved = await host.withConnection(() =>
          host.bridge.presetSave(name, JSON.stringify(body)),
        );
        const savedName = saved === '' ? name : saved;

        /*
         * 4. 导入完**直接切过去**。
         *
         * 用户导一份配置就是为了用它。导完还得再手动选一次，
         * 中间那句"导入成功"会让人以为已经生效了。
         */
        const applied = await makePresetCallbacks(host).apply(savedName);
        if (!applied.ok) {
          return { ok: true, name: savedName, reason: `已导入，但切换失败：${applied.reason ?? ''}` };
        }
        return { ok: true, name: savedName };
      } catch (error) {
        return { ok: false, reason: describeBridgeError(error).message };
      }
    },
  };
}

export function renderApiSection(host: SettingsHost): ElLike {
  /*
   * 进这一块就先问一次 ST「哪些源真的配了 key」（2026-11-07）。
   *
   * ★ 为什么必须问 ST 而不是只用本地标记：
   *
   * 用户真机报「配了 API key，界面说没配」。本地标记会因换版本、
   * 清缓存、在 ST 原始界面配过而丢失 —— 而 ST 的 `secrets.json`
   * 才是真相。`/api/secrets/read` 返回的每一项要么是数组、要么是 `null`。
   *
   * 这里是"fire and forget"：同步渲染用当前已知状态，
   * 拿到真相后如果需要再重绘一次（`refreshKeyPresence` 内部判断）。
   */
  void refreshKeyPresence(host, );

  return host.renderAccordion({
    entryRole: 'api-entry',
    panelRole: 'api-panel',
    title: 'API 连接',
    subtitle: apiSummary(host.apiState),
    expanded: host.apiExpanded,
    onToggle: () => {
      host.apiExpanded = !host.apiExpanded;
      return true;
    },
    buildBody: () => {
      /*
       * 传一个**包过连接门**的 writeSecret。
       *
       * 直接传 `host.bridge` 的话，第一次保存会撞上 "还没连上 SillyTavern"
       * —— 而那一刻外壳其实有能力连上，只是没被要求连。
       */
      const writer = {
        writeSecret: (key: string, value: string) =>
          /*
           * ★★★ 写入 + **自证成功**（2026-11-11）。
           *
           * ## 为什么必须在这里自证
           *
           * 用户报：
           *
           * > 我现在尝试了多次，无法更新秘钥
           *
           * 而界面每次都显示「已保存」。真机取证（直读 ST 的
           * `/api/secrets/read`）：`api_key_custom` 里只有一条
           * `label: "cli-test"` —— 那是**旧探针脚本**写的，
           * `App 一次都没写进去过`。
           *
           * ## 为什么以前的校验看不出来
           *
           * 外壳的 `writeApiConnectionToSt()` 只核「`api_key_custom`
           * 这个名字在不在」。旧的那条一直在 ⇒ **永远通过** ⇒ 显示"已保存"。
           *
           * ```text
           *   写入失败（或压根没调用）
           *     → secretPresent() 返回 ['api_key_custom']（旧值）
           *     → 校验通过 → "已保存"
           * ```
           *
           * ## 判据：写入前后比对 active 那条的 id
           *
           * key 的值读不回来（掩码），但 id 会变：
           *
           * ```text
           *   ST.writeSecret → 旧的 active=false，push 新 uuid active=true
           *   ⇒ id 不变 == 没写进去
           * ```
           *
           * 这是唯一可靠的证据。失败就直接抛错 —— 抛了 api-page 才会
           * 显示红条而不是"已保存"。
           */
          host.withConnection(async () => {
            const before = await host.bridge.secretActiveId(key);
            const written = await host.bridge.writeSecret(key, value);
            const after = await host.bridge.secretActiveId(key);
            if (after === null || after === before) {
              /*
               * ★ 用户可见文案里不出现 "ST" 这种内部术语（项目文案红线）。
               * 说"聊天服务"就够了 —— 用户知道那指的是引擎。
               */
              throw new Error(
                '新密钥没写进聊天服务：写入前后指向同一条记录。' +
                  '先确认服务在运行，然后重新保存一次。',
              );
            }
            return written;
          }),
      };

      const page = renderApiPage(host.doc, writer, host.apiState, {
        /*
         * 收纳项的标题行已经写着「API 连接」，这一页自带顶栏会重复一次
         * （2026-10-31 第三批截图里能直接看到两个「API 连接」）。
         */
        hideTopbar: true,
        // 重绘前记下的提示（"已保存"）—— 显示一次就清
        notice: host.pendingApiNotice ?? undefined,
        /*
         * 秘钥框的三态要问"这个源配过没有"（2026-11-02 用户要求）。
         *
         * 传函数而不是布尔：页面在**切换源**时会重建输入框，
         * 那一刻要按新源重新判断。传快照的话切到另一个源仍显示旧状态。
         */
        hasKeyFor: (source) => host.apiKeyPresent.has(source),
        onSave: async (state, apiKey) => {
          /*
           * ★★★ 第一步就是**真的写进 SillyTavern**（2026-11-04 第二十八批）。
           *
           * 取证结论：改之前这一页**只写 localStorage** ——
           * ST 的 secrets 从未被调用（`SecretWriter` 定义了但零引用），
           * ST 的 settings 只写过 `max_tokens`。
           * 所以 ST 里一直是 `openai / gpt-4-turbo`，App 里是
           * `custom / deepseek-v4-pro`，两边长期不一致。
           *
           * 放到最前面而不是最后：这一步是"保存"的**实质**，
           * 它的成败决定后面能不能说"已保存"。
           */
          const stProblems = await writeApiConnectionToSt(host, state, apiKey);
          const stOk = stProblems === null;

          host.apiState = state;

          /*
           * 本地状态照写。
           *
           * 为什么 ST 失败也写本地：请求体用的是本地这份，写了才聊得动；
           * 不写会让用户"连本机都存不了"。但**必须告诉他没同步进引擎** ——
           * 只写本机而不说，就是改之前那种"看起来成功了、其实是假的"。
           */
          let localError: string | null = null;
          try {
            await host.options.onPersistApi?.(state);
          } catch (error) {
            localError = error instanceof Error ? error.message : String(error);
          }

          /*
           * 这次写了新 key ⇒ 记下"这个源已配置"。
           *
           * ★ 只在**真的写进 ST** 时才认这个标记。改之前是无条件记的，
           * 于是 UI 会显示"已配置秘钥"，而引擎里一个字节都没有 ——
           * 用户发消息才发现 401。
           */
          if (apiKey !== null && stOk && localError === null) {
            host.apiKeyPresent.add(state.source);
            host.options.onApiKeyWritten?.(state.source);
          }
          /*
           * 只同步连接类字段。
           *
           * 2026-10-31 第四批：采样参数已迁走，这里**不许**再碰
           * `sampling` —— 一旦这里还写一遍，保存连接配置就会把
           * 聊天页正在用的采样值覆盖成默认值（用户会看到"我只是改了
           * 模型名，温度怎么回默认了"）。
           */
          host.chatPanel?.setContext({
            source: state.source,
            model: state.model,
            // 地址也要同步 —— 否则填完地址要重启才生效
            baseUrl: state.baseUrl,
          });

          /*
           * ★★★ 「最大回复长度」不再在这里写（2026-11-21 用户决定）。
           *
           * ## 为什么删掉
           *
           * 它和「AI 响应配置」页的「最大回复长度（Token）」**是同一个东西**
           * ——两处最终都落到 ST 的 `oai_settings.openai_max_tokens`。
           * 而这一处是"按源"存（localStorage），保存时覆盖 ST 的值。
           *
           * 于是同一个数字有两个入口、两个存放位置，且这里的优先级更高。
           * 用户实际遇到的是：
           *
           * ```text
           *   在「自定义」页填 4096 → 保存 → 值确实进了 ST
           *   下次再进这一页 → 输入框显示 2048（草稿没从 apiState 回填）
           *   ⇒ 看起来"没保存"，再点一次保存就把 4096 覆盖成 2048
           * ```
           *
           * 用户的判断是对的：**留一处更合理**。所以现在只保留
           * 「AI 响应配置 → 最大回复长度（Token）」，它直接读写
           * `openai_max_tokens`，是唯一入口、也是唯一真相。
           *
           * 保存连接配置时**刻意不碰**这个字段 —— 改模型名不该顺手改长度。
           */

          /*
           * 记下"已保存"给重绘后的页面显示。
           *
           * 不记的话用户看不到任何成功反馈（真机实测：保存其实成功了，
           * 但界面上一片空白）—— 见 `pendingApiNotice` 与
           * `ApiPageCallbacks.notice` 的注释。
           */
          /*
           * ★★★ 反馈只由**实际结果**决定（用户要求"回读验证后 UI 反馈才允许显示成功"）。
           *
           * 改之前无论 ST 写没写都显示"已保存" —— 那正是这个 bug 能潜伏
           * 这么久的原因：界面一直在说成功。
           */
          if (stOk && localError === null) {
            host.pendingApiNotice = '已保存（已同步到服务）';
          } else if (stOk) {
            host.pendingApiNotice = '引擎已同步，但本机没存住';
          } else {
            host.pendingApiNotice = '只保存到本机，没同步到服务';
            host.options.onNotify?.(
              `「${state.model}」没能同步到服务：${(stProblems ?? []).join('；')}`,
              'danger',
            );
          }
          if (localError !== null) {
            host.options.onNotify?.(`本机配置没存住：${localError}`, 'danger');
          }
          /*
           * 重绘后立刻清掉，保证"只显示一次"。
           *
           * 用微任务而不是同步清：`renderPage()` 是同步的，它在下面这行
           * 之前执行，所以这次渲染能读到值；清空留到下一轮事件循环，
           * 这样切 Tab 回来时不会又冒出"已保存"。
           */
          queueMicrotask(() => {
            host.pendingApiNotice = null;
          });
          /*
           * 副标题要跟着变（"当前：xxx 模型 yyy"）。
           * 重绘整页是唯一可靠的办法：`renderAccordion` 每次重建标题行，
           * 手工去改那个 span 会漏掉"另一个条目也被重建了"这件事。
           */
          host.renderPage();
        },
        onNotify: host.options.onNotify,
      });
      host.apiPageEl = page;
      return page;
    },
  });
}

export function renderDiagSection(host: SettingsHost): ElLike {
  const boot = host.diagBoot();
  const entries = readDiagEntries();
  const errorCount = entries.filter(
    (one) => one.kind === 'error' || one.kind === 'unhandledrejection',
  ).length;
  const status = nativeStatus();

  /*
   * 副标题只说**能被用户理解**的事：
   *
   * ```text
   *   "上次异常结束"  → 他心里"对，就是它崩了"
   *   "0x00000008"   → 无意义
   * ```
   */
  /*
   * 副标题要一眼回答两件事：**上次崩没崩**、**日志有多大**。
   *
   * 后者是用户要求的直接来源：
   *
   * > 日志需要能够让用户方便快速的找到并可以传输的方式
   *
   * 只说"已记录"没用 —— 他要知道该不该先导出（快满了就得先导）。
   */
  const sizeText =
    status === null
      ? ''
      : ` · ${(status.totalBytes / 1024 / 1024).toFixed(1)}/${String(Math.round(status.limitBytes / 1024 / 1024))}MB`;
  /*
   * ★★★ 这里不许出现 markdown 强调语法（2026-11-13，用户截图报的）。
   *
   * 原来写的是 `上次**异常结束**` —— 那四个星号是我在**注释里**习惯用
   * `**重点**` 的写法，直接漏进了用户可见文案。真机上副标题显示成：
   *
   * ```text
   *   上次**异常结束** · 共 0 条 · 0.0/18MB
   * ```
   *
   * `textContent` 不做 markdown 渲染，星号就是四个字符。
   *
   * 判断标准很简单：**用户看到的每一个字符都得是有意义的**。
   * 要强调就靠措辞和位置，不靠星号 —— 这里本来也没有富文本能力。
   */
  const subtitle = boot.lastExitClean
    ? `上次正常退出 · 共 ${String(entries.length)} 条${sizeText}`
    : `上次异常结束${errorCount > 0 ? `（有 ${String(errorCount)} 条报错）` : ''} · 共 ${String(entries.length)} 条${sizeText}`;

  return host.renderAccordion({
    entryRole: 'diag-entry',
    panelRole: 'diag-panel',
    title: '诊断日志',
    subtitle,
    expanded: host.diagExpanded,
    onToggle: () => {
      host.diagExpanded = !host.diagExpanded;
      return true;
    },
    buildBody: () => {
      const body = el(host.doc, 'div', 'nb-diag-body');
      body.setAttribute('data-role', 'diag-body');

      const note = el(host.doc, 'p', 'nb-note');
      note.textContent =
        '闪退后重新打开 App，这里会显示上次是怎么结束的。把下面的内容复制出来发给开发者，就能定位问题。';
      body.append(note);

      /*
       * 日志文件在哪 + 多大（2026-11-12 用户要求）。
       *
       * 用户原话：
       *
       * > 最好是放在用户无 root 时可以访问的目录，这样在应用反复崩溃时
       * > 也可以拿到 APP 日志
       *
       * 所以这里要把路径明写出来 —— 他能照着去电脑上找。同时说明
       * "导出到 Download"更省事（Android 11+ 文件管理器进不去 Android/data）。
       */
      if (status !== null) {
        /*
         * ★★★ 路径**单独成块**，不混在说明文字里（2026-11-13 第二次修）。
         *
         * ## 为什么
         *
         * 原来是一句话：`日志文件：${status.dir}（N 个文件，…）`。
         * 而「中文 + 一条 80 字符、没有空格的绝对路径」在真机上会断错位置：
         * 红米那台把**标题**拆成了「日志文 / 件：/storage/…」。
         *
         * 试过两轮 CSS（`overflow-wrap: anywhere` → `break-word`），
         * 都没解决 —— 断行落点取决于 WebView 版本，**不可预测**。
         *
         * ⇒ 改结构：说明是说明，路径是路径。
         *
         * ```text
         *   日志文件（1 个文件，0.0 MB，上限 18 MB）
         *   ┌──────────────────────────────────────┐
         *   │ /storage/emulated/0/Android/data/…   │  ← 等宽、可选中复制
         *   └──────────────────────────────────────┘
         * ```
         *
         * 顺带修好了另一个体验问题：路径现在**能长按复制**，
         * 用户不必照着手打。
         *
         * ★ 文案里也不许出现 "Android 11+" 之外的内部细节 ——
         *   "自带文件管理器进不去"是用户能理解的事实，保留。
         */
        const where = el(host.doc, 'p', 'nb-note');
        where.setAttribute('data-role', 'diag-where');
        where.textContent =
          `日志文件（${String(status.fileCount)} 个文件，` +
          `${(status.totalBytes / 1024 / 1024).toFixed(1)} MB，上限 ` +
          `${String(Math.round(status.limitBytes / 1024 / 1024))} MB）：` +
          '用数据线连电脑即可取。Android 11+ 的手机自带文件管理器进不去这个目录，' +
          '请用下面的「导出到下载目录」。';

        /*
         * 路径块挂在同一个段落**后面**（不是段落里面）——
         * 放进段落里会被段落的文字排版规则管住，又回到断错行的老问题。
         */
        const pathEl = el(host.doc, 'div', 'nb-diag-path');
        pathEl.setAttribute('data-role', 'diag-path');
        pathEl.textContent = status.dir;

        body.append(where, pathEl);
      } else {
        const where = el(host.doc, 'p', 'nb-note');
        where.setAttribute('data-role', 'diag-where');
        where.textContent =
          '当前拿不到原生日志（可能不在安卓上）。下面的内容只存在于本次会话，重启会丢。';
        body.append(where);
      }

      const pre = el(host.doc, 'pre', 'nb-diag-pre');
      pre.setAttribute('data-role', 'diag-text');
      /*
       * 只在展开时才拼整份报告：`buildDiagReport()` 要读 localStorage
       * 并格式化上百行，每次重绘都算一遍是白花钱。
       */
      pre.textContent = buildDiagReport();
      body.append(pre);

      const row = el(host.doc, 'div', 'nb-tag-row');

      /*
       * 「导出到下载目录」放第一位（2026-11-12）。
       *
       * 理由：这是用户**真正用得上**的那一步 —— 复制文本适合一两条报错，
       * 而闪退要的是完整日志。导出后是 `Download/tcs-log-<时间>.txt`，
       * 任何文件管理器能开、能长按分享到微信/QQ。
       */
      if (status !== null) {
        const exportBtn = el(host.doc, 'button', 'nb-btn');
        exportBtn.setAttribute('type', 'button');
        exportBtn.setAttribute('data-role', 'diag-export');
        exportBtn.textContent = '导出到下载目录';
        exportBtn.addEventListener('click', () => {
          const name = exportNativeLog();
          if (name === '') {
            host.options.onNotify?.('导出失败，日志可能还是空的', 'warn');
            return;
          }
          host.options.onNotify?.(`已导出：下载目录 / ${name}`, 'ok');
        });
        row.append(exportBtn);
      }

      const copy = el(host.doc, 'button', 'nb-btn');
      copy.setAttribute('type', 'button');
      copy.setAttribute('data-role', 'diag-copy');
      copy.textContent = '复制全部';
      copy.addEventListener('click', () => {
        /*
         * `navigator.clipboard` 在 WebView 里可能没有（或需要 https）。
         * 失败不装作成功 —— 改成全选文本，用户手动长按复制，
         * 并明说这一步（不能让他以为复制好了）。
         */
        const text = buildDiagReport();
        const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } })
          .navigator?.clipboard;
        if (clipboard?.writeText !== undefined) {
          void clipboard.writeText(text).then(
            () => host.options.onNotify?.('已复制到剪贴板', 'ok'),
            () => selectDiagText(host, pre),
          );
          return;
        }
        selectDiagText(host, pre);
      });
      row.append(copy);

      const clear = el(host.doc, 'button', 'nb-btn');
      clear.setAttribute('type', 'button');
      clear.setAttribute('data-role', 'diag-clear');
      clear.textContent = '清空日志';
      clear.addEventListener('click', () => {
        clearDiagLog();
        host.options.onNotify?.('诊断日志已清空', 'ok');
        host.renderPage();
      });
      row.append(clear);

      body.append(row);
      return body;
    },
  });
}

export function selectDiagText(host: SettingsHost, pre: ElLike): void {
  const doc = (globalThis as { document?: { createRange?: () => Range } }).document;
  const selection = (globalThis as { getSelection?: () => Selection | null }).getSelection?.();
  if (doc?.createRange === undefined || selection === null || selection === undefined) {
    host.options.onNotify?.('复制失败，请长按文本手动选择', 'warn');
    return;
  }
  try {
    const range = doc.createRange();
    range.selectNodeContents(pre as unknown as Node);
    selection.removeAllRanges();
    selection.addRange(range);
    host.options.onNotify?.('已选中全部文本，长按复制', 'warn');
  } catch {
    host.options.onNotify?.('复制失败，请长按文本手动选择', 'warn');
  }
}

/**
 * API 连接的副标题。
 *
 * 只说用户关心的两件事：**连哪个后端、用哪个模型**。
 * 不显示 key（有也不显示 —— 屏幕上出现密钥片段是事故），
 * 不显示采样参数（那是展开后的事）。
 */
export function apiSummary(state: ApiPageState): string {
  const label = CHAT_SOURCE_LABELS[state.source]?.label ?? '自定义';
  const model = state.model.trim();
  return model === '' ? `当前：${label}（还没填模型名）` : `当前：${label} · ${model}`;
}
