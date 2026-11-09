/**
 * ST 后端桥（v0.1.7 / T15.5）—— UI 与 Rust 之间**唯一**的调用入口。
 *
 * ## 为什么要有这一层（而不是 UI 里直接 invoke）
 *
 * 三条具体的理由，都是会咬人的：
 *
 * 1. **流式的 listen 必须成对注销**。`listen(STREAM_EVENT)` 返回一个 unlisten 函数，
 *    忘了调就会累积监听器 —— 表现为"聊到第 30 条时每条回复都重复出现 N 次"。
 *    把它关在一个类里，生命周期跟面板走，就不会漏。
 * 2. **帧解析只有一份**。Rust 推上来的是 `raw` payload，要经
 *    `translateFrame`（`shared` 里有契约测试）才能变成四种事件。
 *    散在各处调用就会出现"某个后端在某条路径上解析不出来"。
 * 3. **错误翻译只有一份**。ST 的 403 响应体是 HTML（契约 §9.3），
 *    直接丢给界面是一整页标签。
 *
 * ## 这一层**不做**业务判断
 *
 * `{}` / `[]` / 数组三态判定在 `shared` 的 `parseChatResponse`；能不能保存
 * 在 `canSaveOverEmpty`。这里只搬字节。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** 选文件的结果（三态，见 `StChatBridge.pickJsonFile` 的注释） */
export type PickedJsonFile =
  | { ok: true; fileName: string; text: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; reason: string };

import {
  applyStreamEvent,
  createStreamState,
  startStreaming,
  describeBridgeError,
  explainGenerateError,
  translateFrame,
  type StChatMessage,
  type StChatSource,
  type StStreamEvent,
  type StreamState,
} from '@tcs/shared';

/** Rust 侧 `STREAM_EVENT` 常量必须与此一致（`st_chat.rs` 顶部） */
export const STREAM_EVENT = 'tcs://st-stream';

/** Rust 推上来的一条事件（**只带原始 payload**，语义由 `translateFrame` 解析） */
type RawStreamEvent =
  | { type: 'frame'; streamId: number; raw: string }
  | { type: 'done'; streamId: number }
  | { type: 'error'; streamId: number; message: string };

/** 生成开始后拿到的句柄：`id` 用于 abort，`done` 在结束时 resolve */
export interface GenerateHandle {
  id: number;
  /** 等生成走完（含被停止）。**无论成败都会 resolve**，不会 hang */
  done: Promise<void>;
  /** 请求停止（= 断连，ST 没有 `/stop` 端点） */
  abort: () => Promise<void>;
}

export interface GenerateCallbacks {
  /** 每收到一批事件就回调一次，参数是**累积后**的状态（直接用它的 text 渲染） */
  onState: (state: StreamState) => void;
}

/**
 * 把 invoke 的错误统一成给人看的一句话。
 *
 * ★ 2026-10-31 第五批：实现挪进 `shared/src/chat/bridge-error.ts`。
 *
 * 原来这里写的是 `String(error)` 兜底 —— 而 Tauri 拒绝时交给前端的是
 * **普通对象** `{code, message}`（`error.rs:198`），`String()` 出来的就是
 * `"[object Object]"`。用户报的「保存失败: [object Object]」正是这条路径。
 *
 * 挪出去的理由：`api-page.ts` 里还有一份**同样的** `String(error)`。
 * 两处各写一份错误渲染，改一处漏一处是必然的 —— 收到一个函数里。
 */
function explainInvokeError(error: unknown): string {
  const described = describeBridgeError(error);
  /*
   * 状态码还要再过一层 `explainGenerateError`（403/401/429/5xx 的专用文案）。
   * 那套文案在 shared 里已有，且比通用描述具体得多。
   */
  const status = /status:?\s*(\d{3})/i.exec(described.message);
  if (status?.[1] !== undefined) {
    return explainGenerateError(Number(status[1]), described.message);
  }
  return described.message;
}

export class StChatBridge {
  private unlisten: UnlistenFn | null = null;

  /** 连接 ST（建会话 + 取 CSRF）。连接一次后所有命令复用同一个 cookie jar */
  async connect(baseUrl: string): Promise<void> {
    await invoke('st_chat_connect', { baseUrl });
  }

  async health(): Promise<{ ok: boolean; version: string }> {
    const [ok, version] = await invoke<[boolean, string]>('st_chat_health');
    return { ok, version };
  }

  /**
   * 角色列表。**原样返回文本**，形状判定交给 `shared` 的 `parseCharacters`。
   *
   * 这里不 `JSON.parse` 一遍再 `stringify` 回去 —— 那会丢掉 `shared` 需要的
   * 原始形态（比如 `[]` 与 `{}` 的区别在 JS 里都变成"非空对象"就分不出了）。
   */
  listCharactersRaw(): Promise<string> {
    return invoke<string>('st_chat_characters');
  }

  /**
   * 删除角色（2026-11-04，第二十九批）。
   *
   * `deleteChats: true` = 连整个聊天目录一起删（ST 侧的 `fs.rm recursive`）。
   * 用户要求「彻底删除并且 ST 内无该角色及其相关数据和聊天记录」，
   * 所以界面上永远是 true —— 参数留着是为了让这条命令的语义显式化，
   * 将来若要做"只删卡片、保留记录"时不用改签名。
   *
   * ★ 不可撤销：卡片的 PNG 与聊天 jsonl 都会被 `unlink` / `rm`。
   * 调用方必须在**用户明确确认之后**才调它。
   */
  /**
   * 读角色的**原始 PNG 字节**（2026-11-04，T15.2）。
   *
   * 为什么读 PNG 而不是 JSON：ST 的 `readCharacterData()` 是
   * `parse(png)` —— 数据在 PNG 的 `chara` tEXt 块里，`.json` 只是副产物，
   * 很多卡根本没有那个文件（真机查过：`测试用-夜航小助手.png` 就没有）。
   */
  characterPng(avatar: string): Promise<number[]> {
    return invoke<number[]>('st_chat_character_png', { avatar });
  }

  /**
   * 把 PNG 字节写回角色文件（2026-11-04，T15.2）。
   *
   * 前端已经用 `buildPngCard` 把新 JSON 嵌好了，这里只负责原子落盘。
   *
   * @param allowCreate 是否允许**新建**。
   *   - 不传 / false：只改现有卡，文件不存在就报错（编辑器写回用）
   *   - true：新建，且要求**同名文件不存在**（导入用；重名要先在
   *     `planCardImport` 里加序号，不许在这里悄悄顶掉别人的卡）
   */
  writeCharacterPng(
    avatar: string,
    charactersDir: string,
    bytes: Uint8Array,
    allowCreate = false,
  ): Promise<string> {
    return invoke<string>('st_chat_character_write_png', {
      avatar,
      charactersDir,
      /* Tauri 的 Vec<u8> 要普通数组，Uint8Array 传过去是对象 */
      bytes: Array.from(bytes),
      allowCreate,
    });
  }

  /** 世界书列表（2026-11-04）：人设世界书的下拉要用 */
  listWorldbooksRaw(): Promise<string> {
    return invoke<string>('st_chat_worldinfo_list');
  }

  /** 读一本世界书的全部内容（2026-11-04，世界书管理） */
  getWorldbookRaw(name: string): Promise<string> {
    return invoke<string>('st_chat_worldinfo_get', { name });
  }

  /**
   * 写回一本世界书。
   *
   * `dataJson` 必须是**整份** entries 的 JSON —— 只传改动的那几条
   * 会把其余条目删掉（ST 是整份覆盖，§93 同一个坑）。
   */
  editWorldbook(name: string, dataJson: string): Promise<string> {
    return invoke<string>('st_chat_worldinfo_edit', { name, data: dataJson });
  }

  /** 导入一本世界书（同名会覆盖，调用方先查重） */
  importWorldbook(name: string, dataJson: string): Promise<string> {
    return invoke<string>('st_chat_worldinfo_import', { name, data: dataJson });
  }

  /** 删除一本世界书 */
  deleteWorldbook(name: string): Promise<string> {
    return invoke<string>('st_chat_worldinfo_delete', { name });
  }

  deleteCharacter(avatar: string, deleteChats: boolean): Promise<string> {
    return invoke<string>('st_chat_character_delete', { avatar, deleteChats });
  }

  listChatsRaw(avatar: string): Promise<string> {
    return invoke<string>('st_chat_list', { avatar });
  }

  loadChatRaw(avatar: string, fileName: string): Promise<string> {
    return invoke<string>('st_chat_load', { avatar, fileName });
  }

  saveChat(avatar: string, fileName: string, chat: readonly StChatMessage[]): Promise<string> {
    return invoke<string>('st_chat_save', { avatar, fileName, chat });
  }

  renameChat(avatar: string, fileId: string, newName: string): Promise<string> {
    return invoke<string>('st_chat_rename', { avatar, fileId, newName });
  }

  deleteChat(avatar: string, fileId: string): Promise<string> {
    return invoke<string>('st_chat_delete', { avatar, fileId });
  }

  /**
   * 建一个群聊，返回 ST 给的群对象（JSON 文本）。
   *
   * 转群聊就是"用当前角色建一个单成员群" —— ST 的模型里群是独立实体，
   * 没有一个"把角色变成群"的接口（`group/convert` 实测 404）。
   */
  createGroup(name: string, members: readonly string[]): Promise<string> {
    return invoke<string>('st_chat_group_create', { name, members: [...members] });
  }

  settingsGetRaw(): Promise<string> {
    return invoke<string>('st_chat_settings_get');
  }

  /**
   * 用 ST 自己的分词器数 token（2026-11-03，第十九批 ④）。
   *
   * `messages` 是 `[{ role, content }]` 的 JSON 文本。
   *
   * ★ 为什么参数是 JSON **字符串**而不是对象：
   * 与 `presetSave` 同样的理由 —— 让"解析"只发生在一个地方。
   * 传对象会让 Rust 也序列化一遍，两边的键序/转义差异会引出
   * "同一批消息数出两个不同数字"这种极难查的问题。
   *
   * ★ 失败时由**调用方**回退到 `estimateTokens()`。
   * 这里不兜底成估算值：那会让"ST 连不上"和"ST 说就是 100 token"
   * 变成同一个返回值，而前者用户应该知道。
   */
  countTokens(model: string, messages: string): Promise<number> {
    return invoke<number>('st_chat_count_tokens', { model, messages });
  }

  /** 整份覆盖（陷阱 #6）—— 调用方必须先 GET 再改再 POST */
  settingsSave(settings: Record<string, unknown>): Promise<string> {
    return invoke<string>('st_chat_settings_save', { settings });
  }

  /**
   * 保存/导入一份对话补全预设（2026-11-03）。
   *
   * ST 侧是 `POST /api/presets/save`，body `{ apiId: 'openai', name, preset }`。
   * 返回 ST 回给的名字（它会对文件名做 `sanitize`，可能与传入的不同）。
   *
   * ★ 这个接口**不做内容校验**：传 `{}` 也返回 200。所以调用方必须先用
   * `validatePresetBody()` 判一遍 —— 否则用户导错文件时界面会报"成功"，
   * 而下拉里那一条选中后什么都不会变。
   */
  /**
   * 保存/导入一份对话补全预设（2026-11-03）。
   *
   * ST 侧是 `POST /api/presets/save`，body `{ apiId: 'openai', name, preset }`。
   *
   * 返回**ST 认可的名字**（Rust 侧已从 `{ "name": ... }` 里取出来）。
   * 为什么要用它的而不是传进去的：ST 会对文件名做 `sanitize-filename`，
   * 回的名字可能不同 —— 拿传入的那个去"切换"会切到一个不存在的名字。
   *
   * ★ 这个接口**不做内容校验**：传 `{}` 也返回 200。所以调用方必须先用
   * `validatePresetBody()` 判一遍 —— 否则用户导错文件时界面会报"成功"，
   * 而下拉里那一条选中后什么都不会变。
   */
  presetSave(name: string, presetJson: string): Promise<string> {
    return invoke<string>('st_chat_preset_save', { name, presetJson });
  }

  /**
   * 选一个 JSON 文件并把内容读回来（原生文件选择器在 Rust 侧）。
   *
   * ## 为什么返回三态而不是"文件或 null"
   *
   * "用户点了取消"与"读文件失败"必须分开：
   *   · 取消 → 什么都不该发生（不该弹错误）
   *   · 失败 → 必须告诉用户为什么
   *
   * 合成一个 `null` 的话，取消会走进"失败"分支弹红条，
   * 而失败会静默什么都不做。
   */
  pickJsonFile(): Promise<PickedJsonFile> {
    return invoke<PickedJsonFile>('pick_json_file');
  }

  /** 写密钥。**写进去读不回来**（契约 §3.5 掩码），所以界面上不许回显 */
  writeSecret(key: string, value: string, label?: string): Promise<string> {
    return invoke<string>('st_chat_secret_write', { key, value, label });
  }

  /**
   * 问 ST「哪些 secret 真的配了」（2026-11-07）。
   *
   * 返回的是 key 名数组（如 `['api_key_custom']`），**不含任何 key 内容** ——
   * Rust 侧已经把 ST 的掩码响应压成了名字，见 `st_chat_secret_present`。
   *
   * ## 为什么不能靠本地标记
   *
   * 「这个源配没配 key」原来由 localStorage 记着。那标记会因换版本、
   * 清缓存、在 ST 原始界面配过而丢失 —— 真机上出现"配了 key 却显示未配"。
   * ST 的 `secrets.json` 才是真相。
   */
  secretPresent(): Promise<string[]> {
    return invoke<string[]>('st_chat_secret_present');
  }

  /**
   * 流式生成。
   *
   * ## 事件监听在这里建立与拆除，不可外泄
   *
   * `done` 一定 resolve（Rust 侧无论成败都发 done，见 `st_chat.rs`），
   * 所以调用方 `await handle.done` 不会 hang。而 unlisten 在 done 之后立刻调 ——
   * 晚一步就会让下一次生成收到上一次的尾巴。
   */
  async generate(
    request: Record<string, unknown>,
    source: StChatSource,
    callbacks: GenerateCallbacks,
  ): Promise<GenerateHandle> {
    // 先建立监听、再发起请求：反过来的话第一批增量可能在 listen 就绪前就到了，
    // 表现为"前几个字丢失"。
    /*
     * ★ 必须从 `startStreaming()` 起，**不是** `createStreamState()`。
     *
     * `applyStreamEvent` 有一道门（`stream.ts:84`）：
     *
     * ```ts
     * if (state.phase !== 'streaming' && state.phase !== 'stopping') return state;
     * ```
     *
     * 而 `createStreamState()` 的 phase 是 `'idle'` —— 于是**每一个文本帧
     * 都被静默丢掉**。真机实测的表现：请求确实发出去了、ST 也确实流式回了帧
     * （`adb logcat -s StNode` 能看到 "Streaming request in progress"），
     * 但气泡里只有一个时间戳，一个字都没有。
     *
     * 为什么单测没抓到：`test/stream.test.mjs` 测的是 `applyStreamEvent` 本身
     * （直接传 `startStreaming()` 的状态），而**这条桥接路径从来没被跑过**。
     * 典型的"零件都对、装配错了"。
     *
     * 第一版写成 `createStreamState()` 大概是把它当"初始状态"了 ——
     * 但这两个函数不是同一个意思：`createStreamState()` 是"什么都没有"，
     * `startStreaming()` 才是"正在收流"。
     */
    let state = startStreaming();
    /*
     * 用对象包一层而不是 `let settle = null`。
     *
     * 直接写 `let settle: (() => void) | null = null` 再在 Promise 里赋值（初版就是这样），
     * TS 的流分析会把外层变量收窄成 `null`（它没意识到回调会在之后执行），
     * 于是 `settle?.()` 报 "Type 'never' has no call signatures"。
     * 包成对象后属性访问不走那套收窄。
     */
    const gate: { resolve: (() => void) | null } = { resolve: null };
    const done = new Promise<void>((resolve) => {
      gate.resolve = resolve;
    });

    let streamId = -1;
    const target: number[] = [];

    const unlisten = await listen<RawStreamEvent>(STREAM_EVENT, (event) => {
      const payload = event.payload;
      // 还没拿到 streamId（或不是本流的事件）一律跳过
      if (target[0] === undefined || payload.streamId !== target[0]) return;

      if (payload.type === 'frame') {
        // ★ 唯一解析点：四种后端形状的差异由 translateFrame 统一
        const events: StStreamEvent[] = translateFrame({ data: payload.raw }, source);
        for (const one of events) {
          state = applyStreamEvent(state, one);
        }
        callbacks.onState(state);
        return;
      }

      if (payload.type === 'error') {
        state = applyStreamEvent(state, { type: 'error', message: payload.message });
        callbacks.onState(state);
        gate.resolve?.();
        return;
      }

      // done：Rust 侧保证一定发，所以这里一定 settle
      state = applyStreamEvent(state, { type: 'done' });
      callbacks.onState(state);
      gate.resolve?.();
    });

    this.unlisten = unlisten;

    try {
      streamId = await invoke<number>('st_chat_generate', { request });
      target[0] = streamId;
    } catch (error) {
      // 连请求都没发出去 —— 直接收尾，避免 done 永远不 resolve
      state = applyStreamEvent(state, { type: 'error', message: explainInvokeError(error) });
      callbacks.onState(state);
      gate.resolve?.();
    }

    // done 之后必须注销，否则下一次生成会收到这一次的残留
    void done.then(() => {
      unlisten();
      if (this.unlisten === unlisten) this.unlisten = null;
    });

    return {
      id: streamId,
      done,
      abort: async () => {
        if (streamId < 0) return;
        try {
          await invoke<boolean>('st_chat_abort', { streamId });
        } catch {
          /*
           * 停止失败不该弹错误：它通常是"刚好写完了"的竞态。
           * 界面会收到 done 事件，状态自然回 idle。
           */
        }
      },
    };
  }

  /** 面板销毁时调用。不调的话监听器会跨页面累积。 */
  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
  }
}
