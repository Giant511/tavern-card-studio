/**
 * 功能
 * 「聊天操作」页的回调对象工厂，从 AppShell.makeActionsCallbacks 搬出（原 206 行）。
 *
 * 注意事项
 * 与 files-callbacks.ts 共用 ChatSessionState 里的五个会话字段，两边都
 * `extends` 它，不要在各自文件里重复声明。
 * 本模块额外需要 bridge / options / chatPanel（只读），以及 hasOpenChat /
 * withConnection / renderPage / persistSession / goBackOneLevel 五个动作。
 *
 * 踩过的坑
 * 搬家时不能在 AppShell 里留一个同名薄包装方法转发进来。包装要同步调到本模块，
 * 就得静态 import，主 chunk 会把这 206 行重新装回去，等于白拆。
 * 正确做法是让调用方持有 `app.actionsHost()`，用 `import type` 引类型
 * （编译后擦除，不产生运行时依赖）。
 */

import type { ChatActionsCallbacks, ChatActionOutcome } from './chat-actions-page';
import type { ChatPanel } from './chat-panel';
import type { ShellOptions } from './shell-contract';
import type { StChatBridge } from './st-bridge';
import type { ChatSessionState } from './chat-session-state';
import type { StChatMessage } from '@tcs/shared';

import { describeBridgeError } from '@tcs/shared';

export interface ActionsHost extends ChatSessionState {
  readonly bridge: StChatBridge;
  readonly options: ShellOptions;
  readonly chatPanel: ChatPanel | null;

  hasOpenChat(): boolean;
  withConnection<T>(run: () => Promise<T>): Promise<T>;
  renderPage(): void;
  persistSession(): void;
  goBackOneLevel(): boolean;
}

export function makeActionsCallbacks(host: ActionsHost): ChatActionsCallbacks {
    const doc = host.options.doc;
    void doc;

    /*
     * ★ 返回 `fileName` 而不是让调用方从 `detail` 文案里正则抠。
     *
     * 从人类可读的文案里解析机器要用的值，是最脆的耦合之一：
     * 改一个字（加个书名号、换个词）就静默失效，而且失效方式取决于文案。
     * 第一版就是这么写的，`/「(.+?)」/` 一改文案就抓不到。
     */
    const saveAs = async (
      nameHint: string,
      messages: readonly StChatMessage[],
    ): Promise<ChatActionOutcome & { fileName?: string }> => {
      const avatar = host.selectedCharacter?.avatar ?? null;
      if (avatar === null) return { ok: false, detail: '先选一个角色。' };
      /*
       * ★★★ 空内容一律不建文件（2026-11-14）。
       *
       * `saveAs` 是唯一一个"用新文件名写盘"的入口，而新名字不覆盖任何东西
       * —— 所以它**不会**造成数据丢失，只会造成垃圾：
       *
       * ```text
       *   每调一次 ⇒ 角色目录里多一个 chat_items: 0 的空壳 jsonl
       * ```
       *
       * 用户视频里那 8 个「2027 条」的同类就是这么攒出来的
       * （另一个来源是 `onNewChat`，已改成完全不写）。
       *
       * 上游「保存检查点」本来也判了空，这里再判一次是因为
       * **判据要钉在最靠近副作用的地方** —— 上游多一个调用点就漏一次。
       */
      if (messages.length === 0) {
        return { ok: false, detail: '当前对话是空的，没有可保存的内容。' };
      }
      try {
        /*
         * 文件名必须**独一无二**：ST 的 `chats/save` 是整份覆盖，
         * 撞名就会把已有聊天覆盖掉 —— 而"保存检查点"的语义恰恰是"别动原来的"。
         * 所以带上时间戳到秒。
         */
        const stamp = new Date();
        const pad = (n: number): string => String(n).padStart(2, '0');
        const when =
          `${String(stamp.getFullYear())}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}` +
          `@${pad(stamp.getHours())}h${pad(stamp.getMinutes())}m${pad(stamp.getSeconds())}s`;
        const fileName = `${nameHint} - ${when}`;

        await host.withConnection(() =>
          host.bridge.saveChat(avatar, fileName, [...messages]),
        );
        host.options.onNotify?.(`已保存为「${fileName}」`, 'ok');
        return {
          ok: true,
          detail: `已保存为「${fileName}」。可在「管理聊天文件」里打开。`,
          fileName,
        };
      } catch (error) {
        const text = describeBridgeError(error).message;
        return { ok: false, detail: `保存失败：${text}` };
      }
    };

    return {
      /* 聊天操作页的上一级是设置菜单 —— 统一走层级表 */
      onBack: () => {
        host.goBackOneLevel();
      },
      onNotify: (message, kind) => host.options.onNotify?.(message, kind),
      hasOpenChat: host.hasOpenChat(),

      onSaveCheckpoint: async () => {
        const messages = host.chatPanel?.getMessages() ?? [];
        if (messages.length === 0) return { ok: false, detail: '当前对话是空的，没有可保存的内容。' };
        const name = host.options.card['name'] === undefined
          ? '检查点'
          : `检查点 ${String(host.options.card['name'])}`;
        return saveAs(name, messages);
      },

      /*
       * 「开始新聊天」= **只清前端状态，不写文件**（2026-11-14 修）。
       *
       * ## 原来的做法与它的三个后果
       *
       * 原来调 `saveAs('新聊天', [])`，也就是立刻往 ST 写一个**空 jsonl**，
       * 再 `openChatFile()` 把它读回来。真机日志（vivo）里留下的痕迹：
       *
       * ```text
       *   File not found: …/威廉/新聊天 - 2026-11-14@19h57m46s.jsonl.
       *     The chat does not exist or is empty.
       *   Deleted file: …/威廉/新聊天 - 2026-11-14@19h57m46s.jsonl
       * ```
       *
       * ```text
       *   ① 每点一次「开始新聊天」就多一个空壳文件
       *      —— 正是前两天用户截图里那 8 个「2027 条」垃圾的同类
       *   ② 写完之后立刻读它，ST 把"空"报成"不存在" ⇒ 一条 W 级错误
       *      用户看日志会以为记录丢了，实际是我们自己刚造的空文件
       *   ③ 读完失败还会把 chatFileName 指过去（已在上游修掉）
       * ```
       *
       * ## 现在：什么都不写，等第一句话
       *
       * `chatPanel.newChat()` 会清空消息、注入开场白、回调 `onChatChanged`；
       * 而 `handleChatChanged` 里那道 `shouldStartNewChatFile` 闸
       * 明确"只有开场白不建档"。⇒ **用户真的发出第一句话时才建文件**。
       *
       * 这也正是 ST 自己的行为（它的「Start new chat」只清 DOM）。
       *
       * ## 没说话就退出会怎样
       *
       * `chatFileName` 是 null，localStorage 里也是 null ⇒ 下次进 App
       * `restoreLatestChat` 会找回上一段。**什么都没说，等于没开新段** ——
       * 这比"留一个空文件等他回来发现是空的"合理得多。
       */
      onNewChat: async () => {
        const avatar = host.selectedCharacter?.avatar ?? null;
        if (avatar === null) return { ok: false, detail: '先选一个角色。' };

        /*
         * 先清指针，再让面板清消息 —— 顺序不能反。
         *
         * `newChat()` 会回调 `onChatChanged`，如果那一刻 `chatFileName`
         * 还是旧值，保存就会写进**上一段**（把旧聊天覆盖成开场白）。
         */
        host.chatFileName = null;
        host.chatSnapshot = null;
        host.lastSavedFingerprint = null;

        host.chatPanel?.newChat(avatar, host.selectedCharacter?.name);
        host.persistSession();
        host.renderPage();

        return { ok: true, detail: '已开一段新对话，说第一句话就会保存成新文件。' };
      },

      onCloseChat: () => {
        /*
         * 关闭 = 清掉"当前打开哪一段"的指针。
         *
         * **不删文件**：用户在 ST 里还能看到它，下次也能从
         * 「管理聊天文件」里重新打开。删文件是另一个动作。
         */
        host.selectedCharacter = null;
        host.chatFileName = null;
        host.chatSnapshot = null;
        host.lastSavedFingerprint = null;
        host.chatSettingsRoute = null;
        host.renderPage();
        /*
         * ★ 不清 localStorage 里的会话指针也可以，但**必须重绘** ——
         * 否则界面还停在那段对话上。这里靠 `renderPage()` 走空状态分支。
         */
        return { ok: true, detail: '已关闭当前对话。' };
      },

      onManageFiles: () => {
        host.chatSettingsRoute = 'files';
        host.renderPage();
      },

      onAiAssist: async () => {
        if (!host.hasOpenChat()) return { ok: false, detail: '先打开一段对话。' };
        await host.chatPanel?.runDirective(
          '你现在是「旁白/编剧」而不是角色本人。请**不要**替代角色说话，' +
            '而是让角色以简短的方式给用户 2-3 条接下来的走向建议（每条一句话）。',
        );
        return { ok: true, detail: '已请求建议，回复会出现在下面。' };
      },

      onContinueWriting: async () => {
        if (!host.hasOpenChat()) return { ok: false, detail: '先打开一段对话。' };
        await host.chatPanel?.runDirective(
          '请自然地接着上文继续写下去，不要重复已经写过的内容，也不要重新开始一个话题。',
        );
        return { ok: true, detail: '已请求续写，回复会出现在下面。' };
      },

      onConvertToGroup: async () => {
        const avatar = host.selectedCharacter?.avatar ?? null;
        const name = host.selectedCharacter?.name ?? '';
        if (avatar === null) return { ok: false, detail: '先选一个角色。' };
        try {
          /*
           * ST 的群是**独立实体**，没有"把角色变成群"的接口
           * （`group/convert` 实测 404）。所以这里用当前角色建一个单成员群 ——
           * 语义上等价于"以这个角色为起点开了个群"，之后可在 ST 里加人。
           */
          const raw = await host.withConnection(() => host.bridge.createGroup(`${name} 的群聊`, [avatar]));
          const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
          const groupName =
            parsed !== null && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>)['name'] === 'string'
              ? String((parsed as Record<string, unknown>)['name'])
              : `${name} 的群聊`;
          host.options.onNotify?.(`已建群「${groupName}」`, 'ok');
          return {
            ok: true,
            detail: `已建群「${groupName}」（成员：${name}）。要在群里加人请到群聊设置里操作。`,
          };
        } catch (error) {
          return { ok: false, detail: `建群失败：${describeBridgeError(error).message}` };
        }
      },
    };
  }
