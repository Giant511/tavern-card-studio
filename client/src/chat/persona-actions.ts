/**
 * 功能
 * 「用户设定」这一族：读当前用户设定、按角色应用、同步进聊天上下文，
 * 以及那一页的渲染与切换弹层。从 AppShell 搬出，6 个函数约 190 行。
 *
 * 注意事项
 * `personaState` 留壳（`pageKey` 与存储回读也要读它）。
 * `syncPersonaToChat` 会调 `persistChat` —— 改完设定要落盘，否则只改内存、
 * 下次读回还是旧的。
 *
 * 踩过的坑
 * `currentUserName` 被三处调用（聊天气泡的作者名、导出文件名、记忆分槽），
 * 它必须返回**稳定的字符串**而不是 null：调用方都直接拼进模板串。
 */

import type { DocLike, ElLike } from './chat-view';
import type { ChatPanel } from './chat-panel';
import {
  activePersona,
  parseCharacterList,
  personasForCharacter,
  relabelUserMessages,
  selectPersona,
  syncPersonaToCharacter,
  updatePersona,
  type PersonaState,
} from '@tcs/shared';
import type { ShellOptions } from './shell-contract';
import type { StChatBridge } from './st-bridge';
import type { ChatSessionState } from './chat-session-state';

import { pickAvatarDataUrl } from './avatar-upload';
import { chatAvatar } from './card-actions';
import { openSelectPopover } from './select-popover.ts';
import { el } from './chat-view';
import { renderPersonaPage as renderPersonaPageView } from './persona-page.ts';

/**
 * 功能
 * 本模块能碰的壳能力。
 *
 * 注意事项
 * `personaState` 双向：切角色与保存后都要改。其余只读。
 *
 * 踩过的坑
 * 无。
 */
export interface PersonaHost extends ChatSessionState {
  readonly doc: DocLike;
  readonly pageHost: ElLike | null;
  readonly bridge: StChatBridge;
  readonly options: ShellOptions;
  readonly chatPanel: ChatPanel | null;

  /** 当前用户设定（名字、头像、描述） */
  personaState: PersonaState;

  withConnection<T>(run: () => Promise<T>): Promise<T>;
  renderPage(): void;
  goBackOneLevel(): boolean;
  /** 落盘当前聊天（`syncPersonaToChat` 改完内容要调） */
  persistChat(messages: import('@tcs/shared').StChatMessage[], avatar: string | null): Promise<void>;
  cardHost(): import('./card-actions').CardHost;
}

export function renderPersonaPage(host: PersonaHost): void {
  if (host.pageHost === null) return;

  const page = renderPersonaPageView(host.doc, host.personaState, {
    /*
     * 返回**统一走 `goBackOneLevel()`**（2026-11-04）。
     *
     * 那里已经有 `personaOpen` 分支。自己写一份 `personaOpen = false;
     * renderPage()` 看起来一样，但那是"层级有两个定义"的开始 ——
     * 判据 `back-navigation.test.mjs` 就是为了防这件事。
     */
    onBack: () => {
      host.goBackOneLevel();
    },
    onChange: (next) => {
      host.personaState = next;
      void host.options.onPersistPersona?.(next);
      syncPersonaToChat(host, );
    },
    onNotify: (message, kind) => {
      host.options.onNotify?.(message, kind);
    },
    /*
     * 人设头像上传（2026-11-04）。
     *
     * 选图与缩放都在 `avatar-upload.ts`（用 `<input type="file">` +
     * canvas，这个壳的 WebChromeClient 已实现 `onShowFileChooser`）。
     * 这里只负责把结果写回状态并落盘。
     */
    onPickAvatar: (personaId: string) => {
      void (async () => {
        let dataUrl: string | null = null;
        try {
          dataUrl = await pickAvatarDataUrl();
        } catch (error) {
          host.options.onNotify?.(
            error instanceof Error ? error.message : '这张图读不了，换一张试试',
            'danger',
          );
          return;
        }
        /* 用户取消：什么都不做，不要弹提示（他什么都没做错） */
        if (dataUrl === null) return;

        host.personaState = updatePersona(host.personaState, personaId, { avatar: dataUrl });
        void host.options.onPersistPersona?.(host.personaState);
        /* 头像只影响这一页的显示，不推给聊天面板（它不显示人设图） */
        host.renderPage();
      })();
    },
    onRelabelMessages: async (name) => {
      const panel = host.chatPanel;
      if (panel === null) return 0;

      const messages = panel.getMessages();
      const userCount = messages.filter((one) => one.is_user).length;
      if (userCount === 0) return 0;

      /*
       * 记下滚动位置再改：`setMessages` 会重绘列表把它归零。
       * 批量改名后把位置还回去，用户不会"被弹回顶部"。
       */
      const keepScroll = panel.getScrollTop();
      const next = relabelUserMessages(messages, name);
      panel.setMessages(next, host.chatFileName ?? undefined, host.selectedCharacter?.avatar);
      panel.restoreScroll(keepScroll);

      if (host.chatSnapshot !== null) {
        host.chatSnapshot = { ...host.chatSnapshot, messages: next.slice() };
      }
      await host.persistChat(next, host.selectedCharacter?.avatar ?? null);
      return userCount;
    },
    listWorldbooks: async () => {
      try {
        const raw = await host.withConnection(() => host.bridge.listWorldbooksRaw());
        const parsed: unknown = JSON.parse(raw === '' ? '[]' : raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
          .map((one) => {
            const item = one as Record<string, unknown>;
            const name = item['name'];
            return typeof name === 'string' ? name : '';
          })
          .filter((name) => name !== '');
      } catch {
        /* 读不到就给空列表：下拉里只剩「不关联」，不阻塞页面 */
        return [];
      }
    },
    listCharacters: async () => {
      try {
        const raw = await host.withConnection(() => host.bridge.listCharactersRaw());
        const parsed = parseCharacterList(raw);
        if (!parsed.ok) return [];
        return parsed.items.map((one) => ({ avatar: one.avatar, name: one.name }));
      } catch {
        return [];
      }
    },
  });

  host.pageHost.append(page);
}

export function currentUserName(host: PersonaHost): string {
  return activePersona(host.personaState)?.name ?? host.options.userName;
}

export function applyPersonaForCharacter(host: PersonaHost, avatar: string): void {
  const next = syncPersonaToCharacter(host.personaState, avatar);
  if (next === host.personaState) return;
  host.personaState = next;
  void host.options.onPersistPersona?.(next);
}

export function personaContext(host: PersonaHost):
  | undefined
  | {
      name: string;
      description: string;
      position: 'in_prompt' | 'top_an' | 'bottom_an' | 'at_depth' | 'none';
      depth: number;
      role: 'system' | 'user' | 'assistant';
    } {
  const active = activePersona(host.personaState);
  if (active === null) return undefined;
  return {
    name: active.name,
    description: active.description,
    position: active.position,
    depth: active.depth,
    role: active.role,
  };
}

export function syncPersonaToChat(host: PersonaHost): void {
  /*
   * 标签一起更新（2026-11-06）：顶栏胶囊也跟着换名字。
   * 只推 `userName` 的话，胶囊会停在旧人设名上 —— 而用户刚点的就是它。
   */
  const label = activePersona(host.personaState)?.name ?? '';
  host.chatPanel?.setContext({
    userName: currentUserName(host),
    persona: personaContext(host),
    personaLabel: label,
  });
  host.chatPanel?.syncPersonaChip(label);
}

export function openPersonaSwitcher(host: PersonaHost, anchor: unknown): void {
  const avatar = chatAvatar(host.cardHost());
  const available = avatar === null ? host.personaState.personas : personasForCharacter(host.personaState, avatar);

  if (available.length === 0) {
    host.options.onNotify?.('还没有用户设定，去「卡片 → 用户设定管理」加一套', 'info');
    return;
  }

  const currentId = host.personaState.selectedId ?? '';
  /*
   * 末位「默认人设」= 不绑定任何一套，用默认名。
   *
   * ★ 文案从「不设人设（用默认名）」缩到这里（2026-11-07，用户要求）：
   *
   * > 默认人设这个列表里面你就写默认或者默认人设就行
   *
   * 原来那 10 个字是全列表最长的一条，逼着面板按它算宽度、
   * 在窄屏上还要换行。短文案让面板能小一点、也更像"一个选项"
   * 而不是"一句解释"。
   */
  const options = [
    ...available.map((one) => ({ value: one.id, label: one.name })),
    ...(currentId === '' ? [] : [{ value: '', label: '默认人设' }]),
  ];

  openSelectPopover(host.doc, {
    options,
    current: currentId,
    anchorEl: anchor,
    onPick: (value) => {
      const next = selectPersona(host.personaState, value === '' ? null : value);
      host.personaState = next;

      /* 先推送再落盘：界面上立刻生效，落盘失败也不会让操作看起来没反应 */
      syncPersonaToChat(host, );
      void host.options.onPersistPersona?.(next).catch(() => {
        host.options.onNotify?.('人设切换已生效，但没能存下来（重启后会复原）', 'warn');
      });

      /*
       * 提示只在用户开了那个全局开关时给（ST 的「切换用户设定时显示提示」）。
       * 默认值是开的，但用户可能关掉 —— 关掉就安静切换。
       */
      if (next.notifyOnSwitch) {
        const name = activePersona(next)?.name ?? currentUserName(host);
        host.options.onNotify?.(`已切换到：${name}`, 'ok');
      }
    },
  });
}
