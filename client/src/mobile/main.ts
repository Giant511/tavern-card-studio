/**
 * 移动端入口（v0.1.7 / T15.3 接线）。
 *
 * ## 这个文件补的是什么缺口
 *
 * T15.5 把移动端 UI（四 Tab + 夜航 Nebula 聊天页）做完了，`AppShell`、
 * `ChatPanel`、`chat.css`、`nebula-tokens.css` 全都在，**但从来没有入口页**：
 *
 *   · `client/index.html` 一直是**桌面编辑器**（顶栏 新建/打开/导出… + 审计面板）；
 *   · `client/src/chat/demo.html` 只用于截图验收，**不进产物**；
 *   · 因此 `chat/` 整个目录没有被任何非 chat 文件 import 过 —— 它不在包里。
 *
 * 结果就是 2026-10-31 用户在真机上看到的：**装上 APK 打开是桌面编辑器**，
 * 顶栏九个按钮挤在竖屏里被切掉。他的原话是
 * 「感觉只是把电脑客户端的 UI 给完完全全打包进去了」—— 这个判断是对的。
 *
 * ## 为什么用独立的 mobile.html 而不是在 index.html 里运行时分支
 *
 * 三条理由，按重要程度：
 *
 * 1. **体积**：桌面 editor 那条线依赖很多（审计引擎、规则引擎、各种对话框），
 *    移动端一条都不需要。运行时分支会把两套都打进同一个 chunk，
 *    手机端白下载几百 KB 的编辑器代码。
 * 2. **可验证**：两个入口 = 两份独立产物。截图/断言可以分别针对
 *    「桌面是编辑器」与「移动是四 Tab」做，不会互相污染。
 * 3. **不碰桌面行为**：桌面客户端是已交付的东西，动它的入口风险不对等。
 *
 * 代价是 `index.html` 里要有一行平台跳转（见该文件），可接受。
 *
 * ## ST 地址从哪来
 *
 * 现在用**回环 8000** 作为初始值 —— 那是 T15.3 内嵌 ST 的固定端口
 * （`android/st-lifecycle.ts` 的 `candidatePorts`）。等 App 内真能起 ST，
 * 这里连上去就是通的，不需要再改。
 *
 * 但**不能静默失败**：连不上时"我的"页会给出明确的状态与下一步，
 * 而不是转圈或者一片空白（设计册 §7.3）。
 */

import { AppShell, type SavedChatSession } from '../chat/shell.ts';
import { DEFAULT_API_STATE, type ApiPageState } from '../chat/api-page.ts';
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../chat/voice-settings.ts';
import type { DocLike, ElLike } from '../chat/chat-view.ts';
import { resolveStAddress } from '../session/st-address.ts';
import { attachKeyboardInset, type KeyboardHost } from '../chat/keyboard-inset.ts';
import { attachFocusScroll } from '../chat/focus-scroll.ts';
import { parseEngineStatus, waitForEngine, type BootProbe } from '@tcs/shared';
import type { StChatSource } from '@tcs/shared';
import type { ParamFamily } from '@tcs/shared';
import {
  emptyPersonaState,
  parsePersonaState,
  type PersonaState,
} from '@tcs/shared';
import { BootSplash } from './boot-splash.ts';
import { cleanupBuiltinTestCards } from '../chat/test-card-cleanup.ts';
import { SAMPLE_CHAT_NAME, SAMPLE_MESSAGES } from './sample-chat.ts';

/**
 * ST 地址**只能从这里取**，不许在渲染层抄字面量。
 *
 * 项目有一条静态断言（`test/st-address.test.mjs`）：
 * `127.0.0.1:8000` 这个字面量只允许出现在 `contract/types.ts` 的
 * `ST_DEFAULT_ADDRESS` 定义处，别处一律走 `resolveStAddress()`。
 *
 * 我第一版在这里写了 `const DEFAULT_ST_BASE_URL = 'http://127.0.0.1:8000'`，
 * 当场被两条断言抓住（`st-address.test.mjs` + `st-proxy.test.mjs`）。
 * 那条纪律是对的：地址一旦散落成多份字面量，改端口时必然漏改一处，
 * 而漏掉的那处表现为"某个入口连不上"，很难联想到是端口。
 *
 * 传 `null` = "用户没改过" → 解析成默认值（8000）。将来「我的」页接上
 * 地址设置后，把用户配的值传进来即可，这一行不用改。
 */
const stAddress = resolveStAddress(null);

/** 设置项在 localStorage 里的键（与桌面端不共享，各存各的） */
const LS_API_STATE = 'tcs.mobile.apiState';
/**
 * 用户设定（persona）的存储键（2026-11-04 第三十批）。
 *
 * 与 API 偏好同一层（localStorage）。用户设定**不写引擎** ——
 * 拼装时只需要名字与描述两段纯文本，写进去反而会变成两处各一份。
 */
const LS_PERSONA = 'tcs.mobile.personas';

/** 读用户设定。校验全在 `parsePersonaState` 里（逐项校验、坏项丢弃） */
function readPersonaState(): PersonaState {
  try {
    const raw = globalThis.localStorage?.getItem(LS_PERSONA);
    if (!raw) return emptyPersonaState();
    return parsePersonaState(JSON.parse(raw));
  } catch {
    /* 读坏了就当没有 —— 用户设定丢了是小事，页面崩了是大事 */
    return emptyPersonaState();
  }
}

function readApiState(): ApiPageState {
  try {
    const raw = globalThis.localStorage?.getItem(LS_API_STATE);
    if (!raw) return DEFAULT_API_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return DEFAULT_API_STATE;
    }

    /*
     * 只取 `DEFAULT_API_STATE` 里存在的键 —— **逐个白名单拷贝**。
     *
     * ★ 2026-10-31 第四批修：这段注释以前就写着"只合并 DEFAULT 里存在的键"，
     * 但代码是 `{ ...DEFAULT, ...parsed }` —— 那是**全量展开**，
     * 把 parsed 里所有键（包括垃圾键）都带进来了。注释与实现不符。
     *
     * 为什么这次必须真做：采样参数已经迁出这一页，而旧版 localStorage 里
     * 还存着 `sampling`。全量展开会把它一直带在状态里、下次又写回去 ——
     * 于是"采样改存 ST 设置"之后，localStorage 里永远躺着一份过期副本，
     * 谁看到都会以为它还是生效的。
     *
     * `source` / `model` 也做类型检查：localStorage 是用户能手改的明文，
     * 一个 `model: 123` 会让下游 `model.trim()` 当场抛异常。
     */
    return {
      source:
        typeof (parsed as Record<string, unknown>)['source'] === 'string'
          ? ((parsed as Record<string, unknown>)['source'] as ApiPageState['source'])
          : DEFAULT_API_STATE.source,
      model:
        typeof (parsed as Record<string, unknown>)['model'] === 'string'
          ? ((parsed as Record<string, unknown>)['model'] as string)
          : DEFAULT_API_STATE.model,
      /*
       * 自定义服务地址（2026-10-31 第五批加）。
       *
       * 它必须进白名单 —— 否则用户填了地址、保存、重启后回来发现空了，
       * 而界面显示"已保存"（因为写的是 localStorage 里的旧对象）。
       */
      baseUrl:
        typeof (parsed as Record<string, unknown>)['baseUrl'] === 'string'
          ? ((parsed as Record<string, unknown>)['baseUrl'] as string)
          : DEFAULT_API_STATE.baseUrl,
      /*
       * 最大回复长度（2026-11-02 加）。
       *
       * 读的时候要**夹范围**：localStorage 是用户能手改的明文，
       * 一个 `maxTokens: 99999999` 流进请求体会让上游拒绝或挂很久。
       */
      maxTokens: (() => {
        const raw = (parsed as Record<string, unknown>)['maxTokens'];
        const n = typeof raw === 'number' ? raw : Number.NaN;
        return Number.isFinite(n) && n >= 256 && n <= 8192
          ? n
          : DEFAULT_API_STATE.maxTokens;
      })(),
    };
  } catch {
    // 存储被禁（隐私模式）/ 内容坏了：回到默认值，不阻断启动
    return DEFAULT_API_STATE;
  }
}

/**
 * 存 API 连接配置，**写完读回来比对**（2026-11-01 用户明确要求）。
 *
 * ## 为什么必须回读
 *
 * 用户的原话：「保存结果必须以回读为准（写入后读回比对），
 * 不许只看写入调用未抛错就算成功」。
 *
 * 只 `setItem` 不抛错**不能**说明存上了：
 *   · 隐私模式 / 配额满：某些实现静默丢弃
 *   · 存进去被别的路径改掉（本模块另一处也写同一个 key）
 *   · 序列化丢字段（比如 `undefined`）
 *
 * 前两版这里是 `catch { /* 写不进去也不该让整页挂掉 *​/ }` ——
 * **失败被完全吞掉**，界面显示"已保存"而其实什么都没存。
 * 那正是用户报"无法判断是否保存成功"的一半原因。
 *
 * ## 不一致就抛错
 *
 * 抛出去让 `ApiPage` 的 catch 走 `describeBridgeError()` 显示可归因原因。
 * 静默降级会让用户下次启动才发现配置没了。
 */
/**
 * 秘钥"配过没有"的标记（2026-11-02）。
 *
 * ## 为什么必须另存一份
 *
 * 聊天 API 的 key 写进 SillyTavern 之后**读不回来**（契约 §3.5 掩码），
 * 所以"这个源配过 key 吗"这个事实，除了 `writeSecret` 的那一刻，别处无从得知。
 * 用户在配置页看到一片空白时，无法区分"没配过"和"配过但不回显"——
 * 而这两者的后续行为完全不同（前者必须填，后者留空表示不改）。
 *
 * 用户原话：「给一个变量专门指示是否填写了秘钥…这样用户才知道自己有没有配置」。
 *
 * ## 为什么按源分开
 *
 * 用户可能给 OpenAI 配了、没给 DeepSeek 配。一个全局布尔会让切到 DeepSeek
 * 也显示"已配置"，他以为能用，然后发消息失败 —— 比不显示更糟。
 *
 * ## 这个标记可能不准，取舍是什么
 *
 * 标记只增不减（本期不提供"删除 key"），且**不校验** ST 里到底有没有。
 * 如果用户在 SillyTavern 网页里清掉了 key，这里仍显示"已配置"。
 * 接受这个偏差：它比"永远显示空白"有用得多，而且错了会立刻表现为
 * "鉴权失败"（可归因），不会静默。
 */
const LS_API_KEY_SOURCES = 'tcs.mobile.apiKeySources';

/** 支持配 key 的源白名单 —— 防止 localStorage 里的脏值被当成源 */
const KNOWN_KEY_SOURCES = new Set<string>([
  'openai',
  'deepseek',
  'openrouter',
  'groq',
  'claude',
  'custom',
]);

function readApiKeySources(): StChatSource[] {
  try {
    const raw = globalThis.localStorage?.getItem(LS_API_KEY_SOURCES);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    /*
     * 逐个白名单过滤（与 `readApiState` 同一条纪律）：
     * localStorage 是用户能手改的明文，脏值流进下游会让
     * `Set.has()` 之外的地方出怪事，也会让副标题显示垃圾源名。
     */
    return parsed.filter(
      (item): item is StChatSource => typeof item === 'string' && KNOWN_KEY_SOURCES.has(item),
    );
  } catch {
    return [];
  }
}

/**
 * 记下"这个源已配 key"。
 *
 * **不抛错**：这是辅助标记，写失败最坏结果是"下次打开显示未配置"，
 * 而它发生在 `onSave` 的成功路径里 —— 为了一个 UI 提示去让整次保存
 * 报"保存失败"是主次颠倒（用户刚写进 ST 的 key 其实是好的）。
 */
function writeApiKeySource(source: StChatSource): void {
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined || storage === null) return;
    const next = new Set(readApiKeySources());
    next.add(source);
    storage.setItem(LS_API_KEY_SOURCES, JSON.stringify([...next]));
  } catch {
    // 见上：辅助标记，失败不改主流程结果
  }
}

/**
 * 写用户设定（2026-11-04 第三十批）。
 *
 * 与 `writeApiState` 同一条纪律：**不许吞错误**。
 * 吞了就是"界面说已保存、重启后人设没了"。
 */
async function writePersonaState(state: PersonaState): Promise<void> {
  const storage = globalThis.localStorage;
  if (storage === undefined || storage === null) {
    throw new Error('这台设备上存不了用户设定（没有可用的本地存储）。');
  }

  try {
    storage.setItem(LS_PERSONA, JSON.stringify(state));
  } catch (error) {
    throw new Error(`用户设定写不进去：${error instanceof Error ? error.message : String(error)}`);
  }

  /* 回读比对 —— 以读到的为准 */
  if (storage.getItem(LS_PERSONA) === null) {
    throw new Error('用户设定写进去之后读不回来了。');
  }
}

async function writeApiState(state: ApiPageState): Promise<void> {
  const storage = globalThis.localStorage;
  if (storage === undefined || storage === null) {
    throw new Error('这台设备上存不了配置（没有可用的本地存储）。');
  }

  try {
    storage.setItem(LS_API_STATE, JSON.stringify(state));
  } catch (error) {
    /*
     * 配额满 / 隐私模式都会在这里抛。
     * **不许吞**：吞了就是"界面说已保存、重启后配置没了"。
     */
    throw new Error(`配置写不进去：${error instanceof Error ? error.message : String(error)}`);
  }

  /* 回读比对 —— 以读到的为准 */
  const back = storage.getItem(LS_API_STATE);
  if (back === null) {
    throw new Error('配置写进去之后读不回来了。');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(back);
  } catch {
    throw new Error('配置写进去之后读回来是坏的。');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('配置写进去之后读回来的形状不对。');
  }
  const record = parsed as Record<string, unknown>;
  const mismatch: string[] = [];
  if (record['source'] !== state.source) mismatch.push('接口源');
  if (record['model'] !== state.model) mismatch.push('模型名');
  if (record['baseUrl'] !== state.baseUrl) mismatch.push('服务地址');
  if (record['maxTokens'] !== state.maxTokens) mismatch.push('最大回复长度');
  if (mismatch.length > 0) {
    throw new Error(`保存没有生效（${mismatch.join('、')}读回来和写进去的不一致）。`);
  }
}

/* ───────────────────── 语音设置（2026-11-01 第六批接线） ───────────────────── */

/**
 * 语音设置在 localStorage 里的键。
 *
 * 与 `LS_API_STATE` **分开存**，不是图省事：
 * 两者的作用域不同（一份给聊天后端，一份给语音），
 * 混在一个对象里就会出现"改语音把聊天配置覆盖了"这类隔离事故 ——
 * 而 `config-scopes.ts` 那套作用域校验的前提正是"它们本来就是两份"。
 */
const LS_VOICE_SETTINGS = 'tcs.mobile.voiceSettings';

/**
 * 「显示完整思考链」开关（2026-11-05 用户要求）。
 *
 * 存本机、默认**关**。
 *
 * ## 为什么默认关
 *
 * 推理模型的思考链动辄几百上千字，默认开会让每个气泡先铺满一大段
 * "思维过程"，把真正的回复挤到下面 —— 第一次用的人会以为回复就是这个。
 * 需要的用户在「AI 响应配置」里自己打开。
 */
const LS_SHOW_REASONING = 'tcs.mobile.showReasoning';

/**
 * ASR key 的存放位置。
 *
 * ## 为什么是 localStorage 而不是 ST 的 secret store
 *
 * ST 的 secret store 会被写进**另一个产品的配置文件**，且在那里可见/可导出。
 * 一个只用于语音转写的第三方 key 不该出现在那儿。
 *
 * ## 已知的取舍（如实记录，不粉饰）
 *
 * WebView 的 localStorage 是**本机明文**：能读到这台设备文件的程序就能读到它。
 * 与"聊天 key 走 ST 加密存储"相比，这一处的保护更弱。
 * 要提升需要平台侧凭据库（Android Keystore），本期没做 ——
 * 如实写进交付说明的"没做到的"里，而不是让人以为它被加密过。
 */
const LS_VOICE_KEY = 'tcs.mobile.voiceKey';

/**
 * 上次正在聊的会话（2026-11-01 第八批第二轮）。
 *
 * ## 为什么这个必须存
 *
 * 真机实测：**切到别的 App 再回来，聊天记录就没了**。
 * Android 会回收 WebView，整个 JS 堆重建 —— `selectedCharacter`
 * 与 `chatSnapshot` 双双归零，界面回到「未选择聊天」。
 *
 * 实测证据（`.verify/verify-switch-scenarios.mjs`）：
 * ```text
 * A. 内部 Tab 往返       3 → -1 → 3       PASS
 * B. 页面重载（等价回收）  3 → count=1    FAIL
 * ```
 *
 * ## 只存身份，不存消息
 *
 * 消息的唯一事实来源是 ST 的 jsonl。在这里再存一份会出现"两份历史",
 * 而"该信哪一份"是个新的复杂度来源 —— 每次不一致都要判断。
 * 存了 `avatar` + `fileName` 就够：按这两个值能把内容完整读回来。
 */
const LS_CHAT_SESSION = 'tcs.mobile.chatSession';

function readChatSession(): SavedChatSession | null {
  try {
    const raw = globalThis.localStorage?.getItem(LS_CHAT_SESSION);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    /*
     * 白名单逐个取（与 `readVoiceSettings` 同一条纪律）。
     *
     * `avatar` 缺失就整条作废 —— 没有它无法定位 ST 目录，
     * 留着一个空 avatar 的会话只会让后面的请求 400。
     */
    const avatar = record['avatar'];
    if (typeof avatar !== 'string' || avatar === '') return null;
    const name = typeof record['name'] === 'string' ? record['name'] : avatar;
    const fileName =
      typeof record['fileName'] === 'string' && record['fileName'] !== ''
        ? record['fileName']
        : null;
    return { avatar, name, fileName };
  } catch {
    return null;
  }
}

function writeChatSession(session: SavedChatSession): void {
  try {
    globalThis.localStorage?.setItem(LS_CHAT_SESSION, JSON.stringify(session));
  } catch {
    /*
     * 写不进去（配额满 / 隐私模式）不影响聊天本身：
     * 消息照样落 ST 的 jsonl，只是下次进来要重新选角色。
     * 这种情况**不弹提示** —— 用户正在聊天，为"印象笔记式的背景动作"
     * 弹一条警告只会打断他。
     */
  }
}

/** 读「显示完整思考链」开关；没存过 = 关 */
function readShowReasoning(): boolean {
  try {
    return globalThis.localStorage?.getItem(LS_SHOW_REASONING) === '1';
  } catch {
    /* 隐私模式 / 被策略禁用：当作关（与默认一致） */
    return false;
  }
}

/**
 * 写开关。
 *
 * 写不进去**不抛**：这是显示偏好，下次进来回到默认值而已，
 * 不该因为存储不可用就让用户点开关时报错。
 */
function writeShowReasoning(next: boolean): void {
  try {
    globalThis.localStorage?.setItem(LS_SHOW_REASONING, next ? '1' : '0');
  } catch {
    /* 忽略 */
  }
}

/**
 * 思考模式的本机偏好（2026-11-07，P0 第三步）。
 *
 * ## 为什么存这里而不是 ST 设置
 *
 * `thinking_intent` 是**本 App 独有**的概念 —— ST 的 `oai_settings`
 * 里没有这个键。硬塞进去等于往另一个产品的配置里写私有数据，
 * 而且 ST 可能把它当未知键清掉（本项目 §99：只存 ST 的参数不生效）。
 *
 * ## 存什么
 *
 * ```text
 *   intent   'auto' | 'off' | 'on'
 *   budget   数字或枚举字符串；没有就不存（用厂商默认）
 * ```
 *
 * 解析时逐项校验：localStorage 是用户能手改的明文，一个脏的 intent
 * 会让 `buildReasoningInjection` 走进未定义分支。
 */
const LS_THINKING = 'tcs.mobile.thinking';

const THINKING_INTENTS = new Set(['auto', 'off', 'on']);

const FAMILIES = new Set(['thinking.type', 'enable_thinking', 'reasoning_effort', 'think']);

function readThinking(): {
  intent: 'auto' | 'off' | 'on';
  budget?: number | string;
  family?: ParamFamily;
} {
  try {
    const raw = globalThis.localStorage?.getItem(LS_THINKING);
    if (raw === null || raw === undefined || raw === '') return { intent: 'auto' };
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { intent: 'auto' };
    }
    const rec = parsed as Record<string, unknown>;
    const intent = typeof rec['intent'] === 'string' && THINKING_INTENTS.has(rec['intent'])
      ? (rec['intent'] as 'auto' | 'off' | 'on')
      : 'auto';
    const b = rec['budget'];
    const budget =
      typeof b === 'number' && Number.isFinite(b)
        ? b
        : typeof b === 'string' && b.trim() !== ''
          ? b.trim()
          : undefined;
    /*
     * 手选参数族也要校验（2026-11-07 兜底）。
     * 脏值会让 `manualProfile` 返回 null，从而悄悄退回自动识别 ——
     * 用户以为"我指定过了"，实际没生效。
     */
    const fm = rec['family'];
    const family =
      typeof fm === 'string' && FAMILIES.has(fm) ? (fm as ParamFamily) : undefined;

    const out: { intent: 'auto' | 'off' | 'on'; budget?: number | string; family?: ParamFamily } = {
      intent,
    };
    if (budget !== undefined) out.budget = budget;
    if (family !== undefined) out.family = family;
    return out;
  } catch {
    /* 脏值 / 隐私模式：回到默认「自动」，不抛 */
    return { intent: 'auto' };
  }
}

function writeThinking(next: {
  intent: 'auto' | 'off' | 'on';
  budget?: number | string;
  family?: ParamFamily;
}): void {
  try {
    /* 只写有值的键：`{intent:'auto', budget:undefined}` 会把 undefined 序列化掉，
       但显式构造更容易读，也避免 JSON 里出现 `"budget":null` 这种脏值。 */
    const payload: Record<string, unknown> = { intent: next.intent };
    if (next.budget !== undefined) payload['budget'] = next.budget;
    if (next.family !== undefined) payload['family'] = next.family;
    globalThis.localStorage?.setItem(LS_THINKING, JSON.stringify(payload));
  } catch {
    /* 写不进去只是下次回到默认，不该让用户点三态时报错 */
  }
}

function readVoiceSettings(): VoiceSettings {
  try {
    const raw = globalThis.localStorage?.getItem(LS_VOICE_SETTINGS);
    if (!raw) return DEFAULT_VOICE_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return DEFAULT_VOICE_SETTINGS;
    }
    const record = parsed as Record<string, unknown>;
    /*
     * 逐个白名单拷贝（与 `readApiState` 同一条纪律）。
     * 这里的"垃圾键"不是假想：`lastMode` 曾经是 `string`，
     * 全量展开会把用户手改进去的任意值一路带下去。
     */
    return {
      confirmBeforeSend:
        typeof record['confirmBeforeSend'] === 'boolean'
          ? record['confirmBeforeSend']
          : DEFAULT_VOICE_SETTINGS.confirmBeforeSend,
      presetId:
        typeof record['presetId'] === 'string'
          ? record['presetId']
          : DEFAULT_VOICE_SETTINGS.presetId,
      baseUrl:
        typeof record['baseUrl'] === 'string' ? record['baseUrl'] : DEFAULT_VOICE_SETTINGS.baseUrl,
      model:
        typeof record['model'] === 'string' ? record['model'] : DEFAULT_VOICE_SETTINGS.model,
      modelPath: typeof record['modelPath'] === 'string' ? record['modelPath'] : '',
      ...(typeof record['lastMode'] === 'string' ? { lastMode: record['lastMode'] } : {}),
    };
  } catch {
    return DEFAULT_VOICE_SETTINGS;
  }
}

async function writeVoiceSettings(settings: VoiceSettings, apiKey: string | null): Promise<void> {
  const storage = globalThis.localStorage;
  if (storage === undefined || storage === null) {
    throw new Error('这台设备上存不了语音配置（没有可用的本地存储）。');
  }

  try {
    storage.setItem(LS_VOICE_SETTINGS, JSON.stringify(settings));
    /*
     * `apiKey === null` 表示"这次没改 key"，**不许**用空串覆盖 ——
     * 那会让"我只是改了一下地址"把已存的 key 清掉，
     * 而界面上一切正常，直到下次录音才报"还没填 key"。
     */
    if (apiKey !== null) {
      storage.setItem(LS_VOICE_KEY, apiKey);
    }
  } catch (error) {
    // 与 writeApiState 同一条纪律：**不许吞**（2026-11-01 用户要求）
    throw new Error(`语音配置写不进去：${error instanceof Error ? error.message : String(error)}`);
  }

  /* 回读比对（用户要求：以读到的为准，不看写入是否抛错） */
  const back = storage.getItem(LS_VOICE_SETTINGS);
  if (back === null) {
    throw new Error('语音配置写进去之后读不回来了。');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(back);
  } catch {
    throw new Error('语音配置写进去之后读回来是坏的。');
  }
  const record =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const mismatch: string[] = [];
  if (record['presetId'] !== settings.presetId) mismatch.push('厂商');
  if (record['baseUrl'] !== settings.baseUrl) mismatch.push('服务地址');
  if (record['model'] !== settings.model) mismatch.push('模型名');
  if (mismatch.length > 0) {
    throw new Error(`语音配置没有生效（${mismatch.join('、')}读回来和写进去的不一致）。`);
  }

  /*
   * key 单独校验存在性 —— **不能比对内容**（那是敏感值，
   * 而且约定是"写进去读不回来"，界面也不回显）。
   */
  if (apiKey !== null && apiKey !== '') {
    const storedKey = storage.getItem(LS_VOICE_KEY);
    if (storedKey === null || storedKey === '') {
      throw new Error('语音 key 写进去之后读不回来了。');
    }
  }
}

function readVoiceKey(): string {
  try {
    return globalThis.localStorage?.getItem(LS_VOICE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * 软键盘避让（2026-11-01 第七批问题三）。
 *
 * 装一次、活到进程结束 —— 它写的是**文档级** CSS 变量，
 * 与哪个面板是活的无关。所以不在 `renderChat()` 里装
 * （那样每切一次 Tab 就多一个监听器，且旧的不清理）。
 */
function installKeyboardInset(): void {
  const host = globalThis as unknown as KeyboardHost;
  attachKeyboardInset(host);
}

/**
 * 「聚焦输入框就把它滚进可见区」（2026-11-04）。
 *
 * ## 为什么光有 CSS 不够
 *
 * `.nb-page` 现在会随键盘变矮（底边停在键盘上沿），但**滚动容器不会自己滚**：
 * WebView 判断可见性用的是布局视口（键盘是 overlay，`innerHeight` 不变），
 * 它认为输入框一直可见 ⇒ 不滚。用户看到的就是"页面不动，键盘盖住半屏"。
 *
 * ## 为什么挂在文档上、装一次
 *
 * 输入框散落在所有页面（仓库、我的、AI 配置、用户设定…），
 * 逐个挂就是"新加页面又忘了"。`focusin` 会冒泡到文档，
 * 一次覆盖全部。
 *
 * `measureVisibleBottom` 读的是 `.nb-page` 的**实际底边**，
 * 而不是 `visualViewport`：真机上 `visualViewport` 不随键盘变（本机恒 851），
 * 唯一准确的信号是页面自己变矮之后的位置。
 */
function installFocusScroll(): void {
  /*
   * ★★★ 必须传 `document`，不能传 `globalThis`（2026-11-05 真机抓到的）。
   *
   * `revealFocusedInput(host, …)` 第一行是：
   *
   * ```ts
   * const active = (doc.activeElement ?? null) …
   * if (active === null || !isTextEntry(active)) return false;
   * ```
   *
   * 而 **`window.activeElement` 是 `undefined`** —— `activeElement` 在
   * `document` 上，不在 `window` 上。传 `globalThis` 等于让它每次都在
   * 第一行 return false，**一次滚都没滚过**。
   *
   * 为什么一直没被发现：`test/focus-scroll.test.mjs` 测的是纯函数
   * `focusScrollTop()`（那个是对的），**没有一条测"传 window 会怎样"**。
   * 真机证据（`.verify/diag-focus-timeline.mjs`）：
   *
   * ```text
   *   +120 起 可见底=464 kb=370px   ← CSS 那条链完全正常
   *   元素底边恒为 632 > 464        ← 被键盘盖住 168px
   *   scrollTop 恒为 0              ← focus-scroll 从未动过
   * ```
   *
   * 用户看到的就是"页面变矮了，但输入框还在键盘底下"。
   *
   * ★ 监听挂 `document` 一样能收到 `focusin`（它冒泡到 document 就停了），
   * 所以这次改动不会丢事件。
   */
  attachFocusScroll(globalThis.document as unknown as Parameters<typeof attachFocusScroll>[0], () => {
    const page = globalThis.document.querySelector('.nb-page');
    if (page !== null) return page.getBoundingClientRect().bottom;
    return globalThis.innerHeight;
  });
}

/**
 * 读一次引擎状态，转成开屏要的形状。
 *
 * ## 为什么和 `readEngineStatus` 分开
 *
 * `ShellOptions.readEngineStatus` 返回 `EngineStatus | null`（完整模型，
 * 给设置页排障用）。开屏只需要四个布尔字段，而且**语义不同**：
 *
 * · 设置页关心"能不能读设置"（含 error 文案）
 * · 开屏只关心"能不能进"（ready / running / unpacked）
 *
 * 复用同一个函数会让两边互相牵制 —— 以后给设置页加字段，开屏的判据
 * 也会跟着变，而那是没人会去检查的隐式耦合。
 *
 * 返回 `null` = 这个平台没有引擎桥（浏览器预览 / 桌面端）⇒ 开屏直接放行。
 */
function readEngineProbe(): BootProbe | null {
  const bridge = (globalThis as { __ST_ENGINE__?: { status?: () => string } }).__ST_ENGINE__;
  if (bridge?.status === undefined) return null;
  try {
    const parsed = parseEngineStatus(bridge.status());
    if (parsed === null) return null;
    return {
      running: parsed.running,
      ready: parsed.ready,
      unpacked: parsed.unpacked,
      error: parsed.error,
    };
  } catch {
    // 跨 JS 边界调用可能抛 —— 当作"拿不到"，开屏放行而不是卡住
    return null;
  }
}

async function boot(): Promise<void> {
  const doc = globalThis.document;
  const host = doc.getElementById('app');
  if (host === null) return;

  // 清掉首屏骨架
  host.replaceChildren();

  /*
   * ★ 先跑开屏，等引擎稳定，再挂 shell（2026-11-01 第九批）。
   *
   * ## 为什么不是"挂完 shell 再等"
   *
   * 那样用户会先看到**空聊天页**（「未选择聊天 / 还没有对话」），
   * 然后过几秒内容才冒出来 —— 这正是用户报"记录丢了"的那个画面。
   * 先开屏则整段等待是一个明确的"正在加载世界"。
   *
   * ## 开屏失败也进主界面
   *
   * 超时 / 引擎报错时**不把用户关在开屏里**。理由：
   * 进去至少能手动选角色重试、能看到引擎状态；
   * 卡在开屏只能杀进程。所以任何结局都往下走，只是提示不同。
   */
  const splash = new BootSplash(doc as unknown as DocLike);
  splash.mount(host as unknown as ElLike);

  const waited = await waitForEngine({
    intervalMs: 1000,
    /*
     * ★★★ 与引擎侧的探活上限同值（2026-11-09）。
     *
     * 原来是 90 秒，而引擎侧是 30 秒 —— **两侧不一致**，后果是：
     * 引擎先放弃并写下"启动失败"状态，开屏还在傻等 60 秒，
     * 然后显示"等了 90 秒还没就绪"。用户看到两个失败，
     * 而实际上引擎 60 秒后就起来了。
     *
     * 现在两侧都是 120 秒（与 `st-lifecycle.ts` 的 `PROBE_TIMEOUT_MS` 一致）。
     * 慢一点可接受，**"起来了却报失败"不可接受**。
     */
    timeoutMs: 120_000,
    probe: () => readEngineProbe(),
    onPhase: (phase) => {
      splash.setPhase(phase);
    },
  });

  if (!waited.ok) {
    /*
     * 失败时的提示必须**可操作**：
     * · 超时 → 告诉他在等什么、可以先进去
     * · 引擎报错 → 把引擎自己的话带出来（那是它的原话，比我们猜的准）
     */
    splash.setPhase('failed');
    splash.setHint(
      waited.reason === null || waited.reason === '等待超时'
        ? `等了 ${String(Math.round(waited.elapsedMs / 1000))} 秒还没就绪，先进去吧 —— 之后可以手动选角色重试。`
        : `引擎没能启动：${waited.reason}。先进去吧，里面能看到连接状态。`,
    );
    // 让用户看清这句话再走；不设这个延时的话失败提示会一闪而过
    await new Promise((resolve) => setTimeout(resolve, 2200));
  }

  /*
   * ★★★ 开屏**不在这里淡出**（2026-11-06）。
   *
   * 见文件末尾 `shell.mount(asHost)` 之后那段：要等 shell 把上次的聊天
   * 记录恢复完再淡出，否则中间会闪一下"还没有对话"的空界面。
   *
   * 用户原话：
   *
   * > 在已经存在聊天记录的时候，再次打开 APP，开屏动画之后会短暂显示
   * > 还没有聊天的那个界面，干脆再把开屏动画弄长一点，聊天记录页面
   * > 加载完成后再显示。
   */

  // 键盘避让：与面板生命周期无关，装一次即可
  installKeyboardInset();
  // 聚焦时把输入框滚进可见区（CSS 只管盒子变矮，滚不滚是另一件事）
  installFocusScroll();

  /*
   * `AppShell` 接受极简的 `DocLike`/`ElLike` 接口（为的是能在 Node 里测），
   * 真实 `document` 结构上兼容，这里集中做一次断言而不是到处撒 `as unknown`。
   */
  const asDoc = doc as unknown as DocLike;
  const asHost = host as unknown as ElLike;

  /*
   * 会话恢复落定的信号（2026-11-06，见 `onSessionSettled` 的注释）。
   *
   * 用 Promise 而不是"挂个回调就 dismiss"：`mount()` 是同步的，
   * 恢复是异步的，只有等 Promise 才能表达"还没好就继续等"。
   */
  let settleSession: () => void = () => {};
  const sessionSettled = new Promise<void>((resolve) => {
    settleSession = resolve;
  });

  /**
   * 顶端通知（从 `onNotify` 内联实现提取，2026-11-09）。
   *
   * 提取的唯一原因：**启动期的清理也要能提示**（内置测试卡清理）。
   * 原来它只作为 `AppShell` 的构造参数存在，启动流程拿不到。
   * 行为与提取前逐字相同 —— 这不是重写，只是把它挪到能复用的位置。
   */
  const showNotify = (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger'): void => {
      /*
       * ## 2026-11-02 重做（用户四条要求）
       *
       * > 各个错误弹窗或提醒的位置给我改成顶端提示（聊天栏下面），
       * > 底端会影响到底部的按钮，并且这个弹窗长按或者点击不能触发复制等选型，
       * > 弹出弹窗后在消失之前点一下屏幕空白处可以快速去掉通知弹窗
       *
       * | 要求 | 实现 |
       * |---|---|
       * | 顶端（聊天栏下面） | `top` 读 `.nb-topbar` 的**实际底边** + 8px |
       * | 长按不许选中/复制 | 样式在 `.nb-notify`（三条属性一起才拦得住） |
       * | 点空白处去掉 | capture 阶段挂一次性 `pointerdown` |
       * | 底端会压按钮 | 所以不再用 `bottom` |
       *
       * ## 样式为什么从内联挪到 CSS
       *
       * 原来整块用 `style.cssText` 拼字符串：`bottom` 写死、颜色写死
       * rgba 裸值（走查第 1 条本来就不允许），而且**没法写伪类/动画**。
       * 挪进 `chat.css` 后，危险态只需要一个 `data-kind` 属性。
       *
       * ## 为什么只留一条
       *
       * 出错时常常连着弹好几条（转写失败 + ASR 未配置）。叠在一起会把
       * 聊天区顶部整块盖住 —— 而那正好是用户此刻最想看清楚的地方。
       */
      for (const old of [...doc.querySelectorAll('[data-role="shell-notify"]')]) old.remove();

      const line = doc.createElement('div');
      line.setAttribute('data-role', 'shell-notify');
      line.className = 'nb-notify';
      line.setAttribute('data-kind', kind === 'danger' ? 'danger' : kind === 'warn' ? 'warn' : 'info');

      /*
       * `top` 不再由 JS 算 —— 见下面的挂载位置说明。
       *
       * 用 `textContent`，不是 `innerHTML`：通知里会出现用户内容
       * （比如服务端返回的错误原文），innerHTML 就是把外部字符串当标记解析。
       */
      line.textContent = message;

      /*
       * ★★★ 必须挂进 `.nb-topbar`，**不能挂 body、也不能用内联 top**。
       *
       * 实测（真机 r34，探针 `probe-notify-style.mjs`）：
       *
       * ```text
       *   line.setAttribute('style', 'top:93px')
       *   line.getAttribute('style')        → "top:93px"      ← 属性在
       *   getComputedStyle(line).top        → "851.273px"     ← 但没生效
       *   getComputedStyle(line).position   → "fixed"
       * ```
       *
       * **内联 `style` 被 CSP 拦了**（属性保留、样式不应用）。于是
       * `top` 解析成 `auto`，`position: fixed` 的元素退回"静态位置" ——
       * 通知直接跑到屏幕最底部，正好压住用户说的"底部按钮"。
       *
       * 改成挂进 `.nb-topbar`，由 CSS 的 `position:absolute; top:100%` 定位：
       * 一个内联样式都不用，而且"贴在顶部栏下沿"这件事由 CSS 自己算
       * （topbar 多高都跟着，52 / 77 / 刘海屏各不相同）。
       *
       * ⚠ 不能挂 `.nb-chat`：实测它的 `top` 是 24，而 topbar 底边是 77 ——
       * 两者重叠 53px（topbar 浮在内容之上），挂进去会被盖住。
       */
      const host = doc.querySelector('.nb-topbar') ?? doc.body;
      host.append(line);

      /*
       * 点任意处即时关闭。
       *
       * capture 阶段挂：晚于它的处理器若 `stopPropagation()`，bubble 阶段就收不到。
       * 但**不调 `preventDefault()`** —— 用户点按钮时那一下仍要正常生效，
       * 不能为了关通知把操作吃掉。
       */
      /*
       * ★ Android 上 `-webkit-touch-callout` **无效**（那是 iOS 的属性）。
       *
       * 真机实测：`getPropertyValue('-webkit-touch-callout')` 返回空串 ——
       * 不是"被覆盖"，是这台 WebView 根本不认这条声明。
       *
       * Android 的长按菜单走的是 `contextmenu` 事件，必须显式拦。
       * CSS 里那三条属性继续留着（对 iOS / 别家内核有用），
       * 这里再补一道 —— **长按弹复制菜单**正是用户明确要求去掉的。
       */
      line.addEventListener?.('contextmenu', (event) => {
        const ev2 = event as { preventDefault?: () => void };
        ev2.preventDefault?.();
      });

      const detach = (): void => {
        line.remove();
        doc.removeEventListener?.('pointerdown', dismiss, true);
      };
      const dismiss = (): void => detach();
      doc.addEventListener?.('pointerdown', dismiss, true);

      /* 到时自动消失；`detach` 里会顺手把监听摘掉，避免堆积 */
      globalThis.setTimeout(() => detach(), 3200);
      // 同时留一份到控制台：用户反馈问题时我们要能看到
      console.warn('[mobile]', message);
  };

  const shell = new AppShell({
    doc: asDoc,
    stBaseUrl: stAddress.baseUrl,
    onSessionSettled: () => {
      settleSession();
    },
    /*
     * 引擎真实状态（2026-10-31 第五批问题三）。
     *
     * ## 为什么这里要读 Android 注入的 JS 桥
     *
     * 用户报："引擎实际在跑、UI 却读不到"。
     * 取证结论：UI 那份「读不到当前的聊天设置。可能是内嵌服务还没起来。」
     * 判的**不是**"引擎在不在跑"，而是"能不能读到设置" —— 后者当时
     * 断在 `connect()` 从未被调用，与引擎死活无关。**归因错了**。
     *
     * 现在设置页需要两样东西分开：读失败原因 + 引擎真实状态。
     * 后者只有 Android 侧知道（`__ST_ENGINE__.status()` 读的是
     * `/proc` 与真实探活缓存）。
     *
     * ## 桥不在时返回 null，**不伪造 `{ready:false}`**
     *
     * 浏览器预览 / 桌面端没有这个桥。伪造一个"没就绪"会让 UI 说
     * "引擎没起来" —— 而桌面端的 ST 是用户自己在外面起的，那句话是错的。
     */
    readEngineStatus: () => {
      const bridge = (globalThis as { __ST_ENGINE__?: { status?: () => string } }).__ST_ENGINE__;
      if (bridge?.status === undefined) return null;
      try {
        return parseEngineStatus(bridge.status());
      } catch {
        // 跨 JS 边界调用可能抛 —— 当作"拿不到"，不猜
        return null;
      }
    },
    /*
     * 用户名先给一个中性默认值。
     *
     * 不写成"未登录"或留空：那两个在消息气泡上会显示成一个空名字，
     * 看起来像渲染坏了。等"我的"页接上真实设置再覆盖。
     */
    userName: '旅人',
    /*
     * 卡片上下文现在给空对象。
     *
     * `ChatPanel` 里对空卡片的处理是「先选一个角色」的提示，
     * 那是**正确的空状态**，不是错误 —— 而移动端选卡功能属于 T15.2。
     */
    card: {},
    apiState: readApiState(),
    onPersistApi: writeApiState,
    personaState: readPersonaState(),
    onPersistPersona: writePersonaState,
    /*
     * 秘钥"配过没有"的标记（2026-11-02 用户要求）。
     *
     * 聊天 API 的 key 写进 SillyTavern 后**读不回来**（契约 §3.5 掩码），
     * 所以想显示"已配置"就只能另外记一份。这里记在 localStorage，
     * 按源分开 —— 用户可能给 OpenAI 配了、没给 DeepSeek 配。
     */
    apiKeySources: readApiKeySources(),
    onApiKeyWritten: writeApiKeySource,
    voiceSettings: readVoiceSettings(),
    /* 显示完整思考链（2026-11-05 用户要求）：默认关，存过就按存的 */
    readShowReasoning: readShowReasoning,
    onPersistShowReasoning: writeShowReasoning,
    /* 思考模式（2026-11-07，P0 第三步）：默认「自动」，存过就按存的 */
    readThinking,
    onPersistThinking: writeThinking,
    onPersistVoice: writeVoiceSettings,
    readVoiceKey,
    savedSession: readChatSession(),
    onPersistSession: writeChatSession,
    onNotify: showNotify,
  });

  /*
   * `?sample=1`：灌一份对话快照。
   *
   * 为什么不像别处那样用动态 `import()`：桌面端 `app.ts` 的 `?sample=1` 是静态
   * import 的样本卡，我照它的口径来。动态 import 会让截图脚本多一个必须等待的
   * 时序（chunk 加载完才能截），而省下的几 KB 不值得多一个不稳定判据 ——
   * `scripts/probe-shots.mjs` 已经因为"没等应用就绪就截图"踩过一次。
   *
   * **必须在 `mount()` 之前**：`setChatSnapshot()` 在 `pageHost` 还是 null 时
   * 只登记不重绘（`mount()` 里建面板时会重放快照）。放到 `mount()` 之后也能用，
   * 但那样会先按空对话建一个面板、立刻又 dispose 重建一个 —— 多一次没必要的
   * 建/拆，也给了"两个面板同时在"的机会（第一版就叠出过两个）。
   *
   * 判据留在 `body.dataset.sampleChat` 上：截图脚本等这个标记，而不是 sleep。
   */
  const isSample = new URLSearchParams(globalThis.location.search).get('sample') === '1';
  if (isSample) {
    shell.setChatSnapshot(SAMPLE_CHAT_NAME, SAMPLE_MESSAGES);
  }

  /*
   * ★★★ 全局拦长按菜单（2026-11-02 用户要求）。
   *
   * > 除了聊天界面，其他界面原本文本可以输入的地方以外，全部都给我禁掉长按复制
   *
   * CSS 那边已经 `user-select: none`（大部分选中都拦住了），但
   * **Android 的长按菜单不是"选中"，是 `contextmenu` 事件**——
   * 只靠 CSS 仍会弹出「复制 / 全选 / 搜索 / 翻译」。
   *
   * 两道一起才拦得住：
   *   · CSS `user-select: none` → 手指拖不出选择区
   *   · 这里 `preventDefault()` → 长按不弹系统菜单
   *
   * 白名单与 CSS 保持一致：输入类元素 + 聊天记录。
   */
  doc.addEventListener?.('contextmenu', (event) => {
    const target = (event as { target?: unknown }).target as
      | { tagName?: string; closest?: (selector: string) => unknown }
      | null;

    const tag = String(target?.tagName ?? '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    /* 聊天记录允许（用户明确说"除了聊天界面"） */
    if (typeof target?.closest === 'function' && target.closest('.nb-msglist') !== null) return;

    (event as { preventDefault?: () => void }).preventDefault?.();
  });

  shell.mount(asHost);

  /*
   * ═══════════════════════════════════════════════════════════
     开屏在**聊天记录恢复完**之后才淡出（2026-11-06）
     ═══════════════════════════════════════════════════════════

     用户：

     > 在已经存在聊天记录的时候，再次打开 APP，开屏动画之后会短暂显示
     > 还没有聊天的那个界面，干脆再把开屏动画弄长一点，聊天记录页面
     > 加载完成后再显示。

     三种结局，都要淡出：

     ```text
       恢复完成      ⇒ 立即淡出（最常见的路径）
       恢复很慢      ⇒ 最多等 3 秒，之后照常淡出
       引擎起不来    ⇒ `restoreLatestChat` 会重试到 60 秒，
                        不能让用户盯着开屏等那么久 ⇒ 3 秒上限就是为它设的
     ```

     ★ 3 秒的依据：用户愿意为"别闪那一下"多等一点，但超过 3 秒的
       静止画面会让人以为卡死。之后进主界面，后台恢复完照样会补上。
     */
  /*
   * 清理早期版本播下的「内置测试卡」（2026-11-09，A1）。
   *
   * ## 为什么必须在这一步做
   *
   * v0.1.7 早期包首启会把一张测试卡拷进 `characters/`。播种器与资产
   * 都已删除，但**已经装过早期包的机器上那张卡还在** ——
   * 删播种器只保证"不再播新的"。
   *
   * 放在 splash 期间是因为：清理完再 dismiss，用户切到「卡片」Tab 时
   * 列表已经是干净的；反过来（先渲染再清理）会让他先看见那张卡、
   * 然后它自己消失 —— 那比不清理更让人困惑。
   *
   * ## 为什么失败不影响启动
   *
   * `cleanupBuiltinTestCards` 内部吞掉所有错误并返回空结果：
   * 清理是"顺手做的好事"，不是用户要求的动作。为它报错或中断启动，
   * 只会让用户看到一个他无法理解的失败。
   *
   * ## 为什么 `await`
   *
   * 要保证"渲染角色列表之前已经清完"。它很快（列目录 + 删几个文件），
   * 而且此刻用户看的是启动画面，等这几十毫秒不会被感知。
   * 桌面端没有这个桥 → 立即返回，零开销。
   */
  await cleanupBuiltinTestCards((message) => showNotify(message, 'info'));

  await Promise.race([
    sessionSettled,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 3000);
    }),
  ]);

  splash.dismiss();

  /*
   * 接管 Android 的系统返回手势（2026-11-03 第二十三批）。
   *
   * ## 用户原话
   *
   * > 还有我想让系统的返回手势也生效为返回上一级
   *
   * ## 改之前是什么样
   *
   * 完全没接管。于是落到 Tauri 的默认行为：
   *
   * ```text
   *   webView.canGoBack() ? webView.goBack() : activity.onBackPressed()
   * ```
   *
   * 我们是单页应用（没有 pushState），`canGoBack()` 恒为 false ⇒
   * 每次都走 `onBackPressed()` ⇒ **直接退出应用**。
   *
   * ## 边界：到顶层时退出
   *
   * `goBackOneLevel()` 返回 false 表示"应用内已经退无可退"，
   * 这时调 `exit(0)`。
   *
   * ★ `exit(0)` 在 Android 上**不是 kill 进程** ——
   * Tauri 的 `AppPlugin.exit` 做的是 `activity.finishAffinity()`，
   * 源码注释原话："closed gracefully instead of the process being killed"。
   * 所以下次点图标进来不会重新冷启动 ST 引擎。
   *
   * ## 为什么用动态 import + catch
   *
   * `onBackButtonPress` 只在 Android 上会回调；浏览器预览与桌面端
   * 没有这个事件源。静态 import 在纯 Web 环境会连带 `@tauri-apps/api`
   * 的初始化一起失败，把整个入口拖死。
   */
  void registerBackGesture(shell);

  if (isSample) {
    doc.body.dataset['sampleChat'] = 'true';
  }

  // 屏上自证：让验收脚本能判断"挂的是移动壳还是桌面编辑器"
  doc.body.dataset['shell'] = 'mobile';
  doc.body.dataset['appReady'] = 'true';
}

/*
 * `boot()` 现在是 async（要等引擎）。这里 `void` 掉：
 * 它自己不会 reject —— 开屏的三种结局都是返回值，不是异常。
 * 加 `.catch` 反而会掩盖"某个 await 意外抛了"这件事。
 */
if (globalThis.document.readyState === 'loading') {
  globalThis.document.addEventListener('DOMContentLoaded', () => void boot());
} else {
  void boot();
}

/**
 * 把 Android 的系统返回手势接到"返回上一级"（2026-11-03）。
 *
 * ## 为什么必须自己接管
 *
 * Tauri 的默认行为是 `webView.canGoBack() ? goBack() : activity.onBackPressed()`。
 * 我们是单页应用，没有 `pushState` 制造历史 ⇒ `canGoBack()` 恒为 false ⇒
 * **每次按返回都直接退出应用**。用户看到的就是"返回手势不生效"。
 *
 * ## 注册即接管
 *
 * `onBackButtonPress` 一旦注册，Tauri 就不再走默认行为（源码里
 * `AppPlugin` 判断 `hasListener(BACK_BUTTON_EVENT)`）。
 * 所以到顶层时**必须自己**调 `exit`，否则返回键会看起来坏掉。
 *
 * ## 与界面返回按钮共用 `goBackOneLevel()`
 *
 * 两套实现分叉的话，会出现"点左上角退一步、按手势退两步"这种
 * 用户永远学不会的行为。层级只在一处定义。
 *
 * 失败时**静默**：浏览器预览 / 桌面端本来就没有这个事件，
 * 抛错会让控制台满屏红字，而功能其实完全正常。
 */
async function registerBackGesture(shell: AppShell): Promise<void> {
  try {
    const { onBackButtonPress, exit } = await import('@tauri-apps/api/app');

    /*
     * ★ 把"真正退出"的动作交给壳。
     *
     * 壳的 `goBackOneLevel()` 到顶层时**自己弹退出确认框**（不再返回 false
     * 交给这里），而确认框里的「狠心离开」按钮调的就是这个 `exitApp`。
     *
     * `exit(0)` 在 Android 上是 `finishAffinity()`（退到桌面），
     * 不杀进程 —— 见调用处注释。
     *
     * ★★★ 不许 `void exit(0)` 吞掉错误（2026-11-03 第二十五批真机教训）。
     *
     * 用户报「点狠心退出时没有退出APP」，真因是 capabilities 缺
     * `core:app:allow-exit` ⇒ `invoke` 被权限拒绝 ⇒ 抛错被 `void` 吞掉。
     * 这里**返回 Promise**，让壳那边 `catch` 到并弹提示；
     * 吞掉的代价是"点了没反应"，那是最难查的一类故障。
     */
    shell.exitApp = () => exit(0);

    await onBackButtonPress(() => {
      /*
       * 应用内能退就退；退到顶层时 `goBackOneLevel()` 会弹确认框并消费
       * 这次返回（返回 true），退出与否交给用户在弹窗里决定。
       */
      shell.goBackOneLevel();
    });
    /*
     * 留一个可查的痕迹：真机判据要能确认"这个 listener 真的注册上了"。
     * 没有它的话，"返回手势没生效"到底是没注册、还是注册了但逻辑错了，
     * 从外部看不出来。
     */
    (globalThis as { __TCS_BACK_GESTURE__?: boolean }).__TCS_BACK_GESTURE__ = true;
  } catch {
    /* 非 Android 环境：本来就没有返回手势，忽略 */
  }
}
