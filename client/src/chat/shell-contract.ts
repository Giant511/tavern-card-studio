/**
 * 聊天外壳的**契约面**（2026-11-24，从 `shell.ts` 搬出）。
 *
 * ## 为什么单独成文件
 *
 * `AppShell` 有 10,209 行、121 个方法、跨 12 类职责（报告 P2-1）。
 * 拆它的第一步不是搬方法，而是**先让契约面独立** —— 具体理由：
 *
 * ```text
 *   拆分方法 需要先知道"每个方法依赖哪些外部能力"
 *            而这些能力全部集中在 ShellOptions 的 22 个字段里
 *            契约面在 shell.ts 内部时，读一个方法要往上翻一千行才看到它依赖什么
 *   契约面独立后  "桌面/移动差异"有了唯一落点，抽哪一类职责都有明确边界
 * ```
 *
 * 顺带解决报告点名的另一条：原文"`ShellOptions`（22 个字段、158 行接口定义）"
 * 混在 1 万行里，任何改契约的人都得先滚过半个文件。
 *
 * ## 这里只有类型与常量，零运行时逻辑
 *
 * 唯一的运行时值是 `TABS`（四个 Tab 的 id / 标题 / 图标）。
 * 它是**顺序即 UI** 的数据（聊天必须是第一个），放这里与 `TabId` 挨着，
 * 改 Tab 时不会漏。
 *
 * ## 引用方式不变
 *
 * `shell.ts` 仍然 `export type { ShellOptions, SavedChatSession } from './shell-contract'`，
 * 所以 `mobile/main.ts` 那句 `import { AppShell, type SavedChatSession } from '../chat/shell.ts'`
 * 一个字都不用改。
 */

import type {
  EngineStatus,
  ParamFamily,
  PersonaState,
  StChatSource,
  ThinkingIntent,
} from '@tcs/shared';

import type { ApiPageState } from './api-page.ts';
import type { DocLike } from './chat-view.ts';
import type { VoiceSettings } from './voice-settings.ts';
import type { ElLike } from './chat-view';

export type TabId = 'chat' | 'cards' | 'repo' | 'me';

export interface TabDef {
  id: TabId;
  label: string;
  icon: string;
}

/** Tab 顺序即从左到右（聊天是第一页 —— 它是这个 App 的主用途） */
export const TABS: readonly TabDef[] = [
  { id: 'chat', label: '聊天', icon: '💬' },
  { id: 'cards', label: '卡片', icon: '🗂' },
  { id: 'repo', label: '仓库', icon: '☁️' },
  { id: 'me', label: '我的', icon: '⚙️' },
];

export interface ShellOptions {
  doc: DocLike;
  /**
   * ST 的地址。**外壳会用它在首次需要时调 `connect()`**。
   *
   * 2026-10-31 第五批修：这个字段此前**只被赋值、从未被读**
   * （`grep stBaseUrl shell.ts` 只有声明那一行）。
   * 而 `StChatBridge.connect()` 全库零调用 ⇒ Rust 侧 `StChatState.api`
   * 恒为 None ⇒ 所有 ST 命令都返回 `StUnavailable`。
   * 用户看到的「保存失败: [object Object]」和「读不到当前的聊天设置」
   * 都是这一个断点的两种表现。
   */
  stBaseUrl: string;
  /**
   * 读引擎真实状态（Android 侧注入的 JS 桥）。
   *
   * 不传 = 这个平台没有这项能力（桌面端 / 浏览器）。
   * **不许在拿不到时假装 `{ready:false}`** —— 那会让 UI 说
   * "引擎没起来"，而我们其实只是没有信息源。
   */
  readEngineStatus?: () => EngineStatus | null;
  userName: string;
  /** 卡片数据（聊天上下文用） */
  card: Record<string, unknown>;
  /** 本机已保存的 API 偏好 */
  apiState?: ApiPageState;
  /**
   * 本机已保存的用户设定（2026-11-04 第三十批）。
   *
   * 存在 App 自己这里而不是引擎里 —— 详见 `shared/chat/persona.ts`。
   */
  personaState?: PersonaState;
  /** 保存用户设定（外壳负责落盘） */
  onPersistPersona?: (state: PersonaState) => Promise<void>;
  /** 保存 API 偏好（外壳负责落盘） */
  onPersistApi?: (state: ApiPageState) => Promise<void>;
  /**
   * 哪些源**已经配置过 key**（2026-11-02 用户要求）。
   *
   * ## 为什么需要它
   *
   * 用户原话：「秘钥也改一下，改成可见的一串星号（给一个变量专门指示是否
   * 填写了秘钥…），这样用户才知道自己有没有配置」。
   *
   * 聊天 API 的 key 写进 SillyTavern 后**读不回来**（契约 §3.5 掩码），
   * 所以"配过没有"只能由**知道写入这件事的那一方**记一份标记。
   * 写入发生在本壳里（`renderApiPage` 的保存流程），所以标记也放这里。
   *
   * ## 为什么是「按源」而不是一个全局布尔
   *
   * 用户可能给 OpenAI 配了、没给 DeepSeek 配。全局布尔会让切到 DeepSeek
   * 也显示"已配置" —— 比不显示更糟：他以为能用，然后发消息失败。
   */
  apiKeySources?: readonly StChatSource[];
  /**
   * 某个源刚写入了新 key（外壳落盘标记）。
   *
   * 与 `onPersistApi` 分开：那是"页面状态"（源/模型/地址），这是
   * "秘钥是否存在"的标记，两者的存储介质与失败影响都不同。
   */
  onApiKeyWritten?: (source: StChatSource) => void;
  /** 本机已保存的语音设置 */
  voiceSettings?: VoiceSettings;
  /** 保存语音设置（外壳负责落盘 + 写 key） */
  onPersistVoice?: (settings: VoiceSettings, apiKey: string | null) => Promise<void>;
  /**
   * 读「显示完整思考链」开关（2026-11-05）。
   *
   * 与 `onPersistVoice` 同一个模式：外壳不知道存储介质，
   * 只负责把它传给设置页与聊天面板。
   *
   * 不传 = 关（默认不显示完整思考链，见 `mobile/main.ts` 里那段理由）。
   */
  readShowReasoning?: () => boolean;
  /** 写这个开关。不传则开关只在本次进程内有效 */
  onPersistShowReasoning?: (next: boolean) => void;
  /**
   * 读/写思考模式的本机偏好（2026-11-07，P0 第三步）。
   *
   * 落盘方式与平台相关（移动端是 localStorage），所以由入口负责，
   * 外壳只持有内存值 —— 与 `readShowReasoning` 同一条纪律。
   */
  readThinking?: () => { intent: ThinkingIntent; budget?: number | string; family?: ParamFamily };
  onPersistThinking?: (next: { intent: ThinkingIntent; budget?: number | string; family?: ParamFamily }) => void;
  /**
   * 读本机已存的 ASR key（为空串表示没存过）。
   *
   * 为什么要一个"读 key"的回调，而不是让外壳自己也存一份：
   * key 的落盘方式与平台相关（Android 走 localStorage / 桌面以后可能走
   * 系统凭据库），外壳不该知道这些。它只要能**在需要转写的那一刻拿到**。
   *
   * 注意：这**不是**"把 key 放进聊天请求"。ASR 请求直连用户配的服务，
   * TCS 服务端零接触（需求 §五 第 6 条）。
   */
  readVoiceKey?: () => string;
  onNotify?: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;

  /**
   * 冷启动的**会话恢复**已经落定（无论成功 / 没历史 / 失败）（2026-11-06）。
   *
   * ## 为什么需要这个回调
   *
   * 用户：
   *
   * > 在已经存在聊天记录的时候，再次打开 APP，开屏动画之后会短暂显示
   * > 还没有聊天的那个界面，干脆再把开屏动画弄长一点，聊天记录页面
   * > 加载完成后再显示。
   *
   * 真因：`mount()` 里的恢复是 `void` 异步（**故意不 await**，否则首屏
   * 迟迟不出现），于是：
   *
   * ```text
   *   splash 消失 → shell 挂上 → 渲染"还没有对话"（快照还是 null）
   *   → 后台读完历史 → 再渲染 → 消息出现
   * ```
   *
   * 中间那一帧就是用户看到的"短暂显示空界面"。
   *
   * 有了这个回调，`main.ts` 可以：
   *
   * ```text
   *   splash 保持显示 → shell.mount() → 等这个回调（或 3 秒上限）→ 淡出
   * ```
   *
   * 于是用户看到的是"开屏久一点，然后直接有聊天记录"。
   *
   * ★ 调用时机是 `finally`（成功失败都调）—— 失败时也必须放行，
   *   否则引擎起不来会把用户永久关在开屏里。
   */
  onSessionSettled?: () => void;

  /**
   * 上次退出时正在聊的会话（2026-11-01 第八批问题二第二轮）。
   *
   * ## 为什么必须有
   *
   * 真机实测：内部 Tab 往返没问题（`chatSnapshot` 在内存里），但
   * **切到别的 App / 按 Home 再回来**（Android 会回收 WebView）之后，
   * 整个 JS 堆没了 —— `selectedCharacter` 与 `chatSnapshot` 双双归零，
   * 界面回到「未选择聊天」。用户说"切走再回来消息全没了"就是这个。
   *
   * 实测证据（`.verify/verify-switch-scenarios.mjs`）：
   * ```text
   * A. 内部 Tab 往返   3 → -1 → 3        PASS
   * B. 页面重载(等价回收) 3 → count=1     FAIL
   * ```
   *
   * 所以会话身份（哪个角色、哪个聊天文件）必须**落盘**。
   * 消息本身不用存 —— 它们在 ST 的 jsonl 里，按文件名能读回来。
   */
  savedSession?: SavedChatSession | null;
  /**
   * 会话身份变化时落盘。
   *
   * 与 `onPersistVoice` 同一个模式：外壳不知道存储介质
   * （Android 是 localStorage / 桌面以后可能是别的），只负责"什么时候该存"。
   */
  onPersistSession?: (session: SavedChatSession) => void;
}


/**
 * 需要跨进程存活的会话身份。
 *
 * **不存 messages**：消息在 ST 的 jsonl 里，是唯一事实来源。
 * 在这里存一份会导致"两份历史不一致"，而合并策略是新的复杂度来源。
 */
export interface SavedChatSession {
  /** 角色头像文件名（ST 用它定位目录） */
  avatar: string;
  /** 角色显示名 */
  name: string;
  /** 聊天文件名（**不带扩展名**，`get`/`save` 要的那个） */
  fileName: string | null;
}

/**
 * 一次"把卡写进角色库"的结果（2026-11-09）。
 *
 * 只为一件事：**世界书到底进没进来，要能如实告诉用户**。
 *
 * ## 为什么必须区分 `none` 与 `failed`
 *
 * `persistEmbeddedWorldbook` 返回 `null` 同时覆盖两种情况，而它们的
 * 处置完全相反：
 *
 * ```text
 *   none    卡里本来就没有 character_book ⇒ 什么都不该说
 *   failed  卡里带了书但没落地           ⇒ 必须说，否则用户以为卡没带书
 * ```
 *
 * 把两者混成一句"世界书未导入"，会让**本来就没有书**的卡也弹提示 ——
 * 那是拿噪音换消息，用户很快就不看了。
 */
export interface CardWriteResult {
  /** `ok` = 落地成功；`none` = 卡里没有内嵌书；`failed` = 有书但失败 */
  worldbook: 'ok' | 'none' | 'failed';
  /** 落地后的书名（`worldbook === 'ok'` 时才有） */
  worldbookName?: string;
  /** 失败原因（`worldbook === 'failed'` 时才有） */
  worldbookFailure?: string;
}

/** 折叠项规格。设置页与卡片页都用它描述一段可展开的内容 */
export interface AccordionSpec {
  /** 标题行的 `data-role`（验收脚本按它找入口） */
  entryRole: string;
  /** 面板的 `data-role` */
  panelRole: string;
  title: string;
  /** 副标题：说清"现在是什么状态"，不展开也能判断 */
  subtitle: string;
  expanded: boolean;
  /**
   * 用户点了标题行。实现方负责翻转自己那个 `*Expanded` 字段。
   *
   * 返回值决定"要不要真的展开"：
   *   · `true`  —— 可折叠条目（API / 语音）：翻转并渲染
   *   · `false` —— **纯说明条目**（卡片 Tab 那两个）：点了不展开。
   *     它们本来就是一段话，做成可折叠会让用户以为里面还有配置。
   */
  onToggle: () => boolean;
  /** 展开时构建内容（收起时会被 `replaceChildren` 清掉） */
  buildBody: () => ElLike;
}
