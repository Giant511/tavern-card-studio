/**
 * 「聊天文件」页的回调（2026-11-24，从 `AppShell.makeFilesCallbacks` 搬出）。
 *
 * ## 为什么搬
 *
 * 它是 `AppShell` 里第三大的方法（306 行，其中约一半是注释 —— 记的都是
 * 聊天文件页踩过的坑：改名重名、空名字、ST 的 400 语义）。
 * 那个类有 10,031 行、119 个方法、跨 12 类职责（报告 P2-1）。
 *
 * ## 搬得动的关键：`FilesHost` 窄接口
 *
 * 原地搬不动，因为它依赖 13 个 `private` 成员。解法不是把它们改成 public，
 * 而是让 `AppShell` 提供一个显式接口（`shell.ts` 里的 `filesHost()`）：
 *
 * ```text
 *   读写状态     selectedCharacter / chatFileName / chatSnapshot /
 *               lastSavedFingerprint / chatSettingsRoute   ← 5 对 get/set
 *   只读依赖     bridge / options
 *   动作         withConnection / openChatFile / persistSession /
 *               renderPage / goBackOneLevel / currentUserName
 * ```
 *
 * 读完这个接口就知道本模块能碰什么 —— 不必翻 1 万行。
 */

import { parseChatFileRows, type ChatFilesCallbacks } from './chat-actions-page';
import {
  chatExportFileName,
  chatToText,
  describeBridgeError,
  parseChatResponse,
  type StChatMessage,
} from '@tcs/shared';
import type { ShellOptions } from './shell-contract';
import type { ChatSessionState } from './chat-session-state';
import type { StChatBridge } from './st-bridge';

import { diagNote } from '../diagnostics/mobile-diag.ts';

/** 见文件头：本模块能碰的全部状态与动作 */
export interface FilesHost extends ChatSessionState {
  readonly bridge: StChatBridge;
  readonly options: ShellOptions;


  withConnection<T>(run: () => Promise<T>): Promise<T>;
  openChatFile(avatar: string, fileName: string): Promise<boolean>;
  persistSession(): void;
  renderPage(): void;
  goBackOneLevel(): boolean;
  currentUserName(): string;
}

export function makeFilesCallbacks(host: FilesHost): ChatFilesCallbacks {
    return {
      /* 同样统一走层级表：文件页的上一级是「聊天操作」 */
      onBack: () => {
        host.goBackOneLevel();
      },
      onNotify: (message, kind) => host.options.onNotify?.(message, kind),
      loadFiles: async () => {
        const avatar = host.selectedCharacter?.avatar ?? null;
        if (avatar === null) return [];
        try {
          const raw = await host.withConnection(() => host.bridge.listChatsRaw(avatar));
          return parseChatFileRows(raw, host.chatFileName ?? null);
        } catch {
          return null;
        }
      },
      onOpen: async (id) => {
        const avatar = host.selectedCharacter?.avatar ?? null;
        if (avatar === null) return;
        const loaded = await host.openChatFile(avatar, id);
        /*
         * 读不到就**留在文件列表页**（2026-11-14）。
         *
         * 原来不管成没成都跳回聊天页，于是用户看到一段空对话 +
         * 一条顶部提示，而"哪一条没读出来"这个信息已经丢了 ——
         * 他还得重新进列表才知道。
         */
        if (!loaded) return;
        host.chatSettingsRoute = null;
        host.renderPage();
      },
      onRename: async (id, newName) => {
        const avatar = host.selectedCharacter?.avatar ?? null;
        if (avatar === null) return { ok: false, detail: '先选一个角色。' };

        /*
         * 空名字直接拦掉（2026-11-15）。
         *
         * 空格子点保存 → `renamed_file = ".jsonl"` → ST 那边
         * `path.parse('.jsonl').name = '.jsonl'`（点开头的隐藏文件）
         * ⇒ 一个看不见的聊天文件。用户此后既找不到也删不掉。
         */
        const trimmed = newName.trim();
        if (trimmed === '') return { ok: false, detail: '名字不能是空的。' };

        /*
         * ★★★ 先在本地查重，别让 ST 用 400 回我们（2026-11-15）。
         *
         * ST 的 `/rename` 在目标文件已存在时返回 **400**，而那个 400 与
         * "源文件不存在"的 400 **是同一个状态码**（它只回 `{error:true}`）。
         *
         * ```js
         *   if (!fs.existsSync(pathToOriginalFile) || fs.existsSync(pathToRenamedFile)) {
         *       return response.status(400).send({ error: true });
         *   }
         * ```
         *
         * 用户看到的是「改名失败：/api/chats/rename 返回 HTTP 400」，
         * 而他唯一能做的动作就是"再点一次"或"换个名字瞎试"。
         *
         * 列表就在手上，所以这里自己判：
         *
         * ```text
         *   重名（且不是自己）⇒ "已经有同名的，换一个"     精准、可行动
         *   其余 400        ⇒ 保留原始错误 + 提示可能是文件已被删
         * ```
         *
         * 判重必须排除**自己**：把「A」改成「A」是不该报错的（用户可能只改了
         * 首尾空格，trim 之后与原 id 相同）。
         */
        try {
          const listRaw = await host.withConnection(() => host.bridge.listChatsRaw(avatar));
          const rows = parseChatFileRows(listRaw, host.chatFileName ?? null);
          const clash = rows.some((row) => row.id === trimmed && row.id !== id);
          if (clash) {
            return { ok: false, detail: `已经有叫「${trimmed}」的聊天文件了，换一个名字。` };
          }
        } catch {
          /*
           * 列表读不到就**不阻断改名** —— 它只是"提前给个好提示"的优化，
           * 不是正确性的一部分。真重名时 ST 那边还会用 400 兜住。
           */
        }

        try {
          const raw = await host.withConnection(() => host.bridge.renameChat(avatar, id, trimmed));

          /*
           * ★★★ 用 ST 返回的名字，不是用户输入的名字（2026-11-15）。
           *
           * ST 那侧过了一遍 `sanitize()`（`sanitize-filename` 包）：
           * 非法字符会被删掉、结尾的点和空格会被去掉、超长会截断。
           * 然后它回一个 `sanitizedFileName`（**不带扩展名**）。
           *
           * ```text
           *   用户输入  a/b:c   → 实际文件  abc.jsonl
           *   记成 a/b:c 的话，下次按这个名字读 ⇒ 404 ⇒ 又"记录没了"
           * ```
           *
           * 所以指针必须记**磁盘上真实的名字**。拿不到回退值时才用输入名，
           * 并把这件事说给用户（`detail` 里带上实际名字，他就能对上）。
           */
          let sanitized = '';
          try {
            const parsed = JSON.parse(raw === '' ? '{}' : raw) as { sanitizedFileName?: unknown };
            sanitized = typeof parsed.sanitizedFileName === 'string' ? parsed.sanitizedFileName.trim() : '';
          } catch {
            /* 返回不是 JSON ⇒ 当没有回传值，走下面的回退 */
          }
          const finalName = sanitized === '' ? trimmed : sanitized;

          diagNote(
            'note',
            `[会话] 改名 ${id} → ${finalName}` +
              `${sanitized === '' ? '（ST 未回传，用输入名）' : ''}` +
              ` 指针原值=${host.chatFileName ?? 'null'}`,
          );

          /*
           * ★★★★★ 改的是"当前这段"⇒ 必须按新名字**重新打开一次**（2026-11-15）。
           *
           * ## 为什么只是"把指针改成 finalName"不够
           *
           * 昨天的版本就只改了指针。用户操作是「改名 → 回聊天页 → 发一句话 →
           * 杀进程重进」，结果记录没了。日志里的证据：
           *
           * ```text
           *   engine：Successfully renamed chat file.        ← 改名确实成功
           *   16:22 重进后的请求里第 4 条是**开场白**       ← 打开的是新的一段
           *   15:45→16:22 之间没有任何 save / 删除错误
           * ```
           *
           * 也就是说：改名成功了，但**重进时按某个名字读不到**，于是走了
           * "空聊天 → 发一句话 → 建档"那条路，那段历史就被"新的 2 条"顶掉了。
           *
           * ## 改指针解决不了的那种情况
           *
           * ```text
           *   改名时 host.chatFileName 是 null（上一次恢复就没成功）
           *   ⇒ `chatFileName === id` 不成立 ⇒ 指针不更新 ⇒ localStorage 里
           *      还是旧名字/空 ⇒ 重进按旧名字读 ⇒ 那个文件已被改名删掉 ⇒ 读不到
           * ```
           *
           * 所以判断条件要放宽到"快照指向它"也算当前；而且改完之后
           * **真的去读一次** —— 读成功才算这件事办完了。
           *
           * 这一步同时是**验证**：如果新名字读不回内容，说明 ST 的 sanitize
           * 结果与回传值不一致（或文件没落地），必须当场告诉用户，
           * 而不是等他第二天来报"记录没了"。
           */
          const wasCurrent = host.chatFileName === id || host.chatSnapshot?.fileName === id;

          if (wasCurrent) {
            host.chatFileName = finalName;
            if (host.chatSnapshot !== null) {
              host.chatSnapshot = { ...host.chatSnapshot, fileName: finalName };
            }
            host.persistSession();

            const reopened = await host.openChatFile(avatar, finalName);
            diagNote(
              'note',
              `[会话] 改名后重开 finalName=${finalName} 结果=${reopened ? 'ok' : 'miss'}`,
            );
            if (!reopened) {
              /*
               * 改名成功但读不回来 —— 这是**必须出声**的状态：
               * 用户以为"改完了继续聊"，而下一句话会写进一个新文件、
               * 把这段历史的连续性断掉。
               */
              return {
                ok: true,
                detail:
                  `已改名为「${finalName}」，但按新名字读不回内容。` +
                  '请在列表里点「打开」确认一下——如果打不开，说明这个名字没落地。',
              };
            }
          }

          /*
           * 改的不是当前这段 ⇒ 只同步快照（如果它恰好指向它），不动指针。
           * 面板不用管：用户切回去时会按快照重建。
           */
          if (!wasCurrent && host.chatSnapshot !== null && host.chatSnapshot.fileName === id) {
            host.chatSnapshot = { ...host.chatSnapshot, fileName: finalName };
          }

          return {
            ok: true,
            detail:
              finalName === trimmed
                ? `已改名为「${finalName}」。`
                : `已改名为「${finalName}」（原名字里有不能用的字符，已自动调整）。`,
          };
        } catch (error) {
          return { ok: false, detail: `改名失败：${describeBridgeError(error).message}` };
        }
      },
      onDelete: async (id) => {
        const avatar = host.selectedCharacter?.avatar ?? null;
        if (avatar === null) return { ok: false, detail: '先选一个角色。' };
        try {
          await host.withConnection(() => host.bridge.deleteChat(avatar, id));
          /* 删的正是当前打开的那条 ⇒ 关掉会话，否则界面还指着一个不存在的文件 */
          if (host.chatFileName === id) {
            host.selectedCharacter = null;
            host.chatFileName = null;
            host.chatSnapshot = null;
            host.lastSavedFingerprint = null;
          }
          return { ok: true, detail: '已删除。' };
        } catch (error) {
          return { ok: false, detail: `删除失败：${describeBridgeError(error).message}` };
        }
      },
      /*
       * 导出这段聊天为 TXT 并起分享面板（2026-11-14，v0.1.9）。
       *
       * ## 三步：读 → 转 → 分享
       *
       * 转那一步是纯函数（`shared/src/chat/chat-export.ts`），
       * 五条容易做错的细节都在它的判据里（不是在这里）。
       *
       * ## 为什么不用 `panel.getMessages()`
       *
       * 面板手上的只是**当前打开的那一段**。用户在这一页可以导出任何一条
       * 历史聊天，所以必须按 `id` 现读 —— 用面板的消息会把 A 段的内容
       * 存成 B 段的文件名。
       *
       * ## 失败不抛，返回 `{ ok, detail }`
       *
       * 界面把 `detail` 直接显示在状态条上。抛异常会让每个调用点各写一遍捕获。
       */
      onExport: async (id, name) => {
        const avatar = host.selectedCharacter?.avatar ?? null;
        if (avatar === null) return { ok: false, detail: '先选一个角色。' };

        let raw = '';
        try {
          raw = await host.withConnection(() => host.bridge.loadChatRaw(avatar, id));
        } catch (error) {
          return { ok: false, detail: `读不到这段聊天：${describeBridgeError(error).message}` };
        }

        let messages: StChatMessage[] = [];
        try {
          const parsed = parseChatResponse(JSON.parse(raw === '' ? '{}' : raw) as unknown);
          if (parsed.kind !== 'chat') {
            /*
             * `missing` / `empty` / `malformed` 三种都不是"可以导出"的状态。
             * 尤其是 `malformed`：导出一个空文件让用户以为记录丢了，
             * 而实际是读取环节出了问题 —— 两者必须分开说。
             */
            return {
              ok: false,
              detail:
                parsed.kind === 'missing'
                  ? '这个聊天文件不在了（可能刚被删掉）。'
                  : '这段聊天的内容读不出来，没法导出。',
            };
          }
          messages = parsed.messages;
        } catch {
          return { ok: false, detail: '这段聊天的内容读不出来，没法导出。' };
        }

        const characterName = host.selectedCharacter?.name ?? '';
        const exported = chatToText(messages, {
          characterName,
          userName: host.currentUserName(),
        });

        /*
         * `shareText` 是原生方法，**必须直接调不能解引用**（§125）：
         * `const f = bridge.shareText; f(...)` 会报 "non-injected object"。
         */
        const bridge = (globalThis as { __ST_ENGINE__?: { shareText?: (t: string, n: string) => string } })
          .__ST_ENGINE__;
        if (typeof bridge?.shareText !== 'function') {
          return { ok: false, detail: '这台设备不支持导出。' };
        }

        let reply: { ok?: boolean; error?: string; bytes?: number } = {};
        try {
          reply = JSON.parse(
            bridge.shareText(exported.text, chatExportFileName(characterName)),
          ) as typeof reply;
        } catch {
          return { ok: false, detail: '导出失败（返回的不是有效数据）。' };
        }

        if (reply.ok !== true) return { ok: false, detail: reply.error ?? '导出失败。' };

        /*
         * 说清"导出了几条"而不是"已导出" ——
         * 后者在空聊天时会骗人（那种情况也"导出成功"了，但一条都没有）。
         */
        return {
          ok: true,
          detail: exported.empty
            ? '这段聊天还没有记录，已导出说明文本。'
            : `已导出 ${String(exported.count)} 条，选择应用打开即可。`,
        };
      },
    };
  }
