/**
 * 功能
 * 提示词配置的读写与回写：重算生效配置、存/还原本角色覆盖、刷新触发词，
 * 以及编辑器里的增删改（草稿、开关、删除）。从 AppShell 搬出，9 个函数约 375 行。
 *
 * 注意事项
 * `rebuildPromptConfig` 是唯一允许写 `promptConfig` 的地方。散开写会出现
 * "改了设定但请求里还是旧提示词"，而这个症状看起来像模型不听话。
 *
 * `characterPrompts` 与 `globalPromptConfig` 都留壳：前者被卡片簇暂借，
 * 后者被设置页读来算"已生效几条"。
 *
 * 踩过的坑
 * 这些函数都很短，但不要并成一个大函数：它们改的是不同层（全局预设 /
 * 本角色覆盖 / 草稿层），合并会丢掉"改的是哪一层"这个信息。
 */

import type { ChatPanel } from './chat-panel';
import type { ShellOptions } from './shell-contract';
import type { StChatBridge } from './st-bridge';
import type { ChatSessionState } from './chat-session-state';
import type {
  AuthorNoteConfig,
  CharacterPromptConfig,
  EngineStatus,
  OwnPrompt,
  ParsedPromptConfig,
  PromptDraft,
} from '@tcs/shared';
import {
  buildPngCard,
  clearOverride,
  combineGlobalAndCharacter,
  createPrompt,
  currentPresetName,
  deletePrompt,
  describeBridgeError,
  effectiveEnabled,
  emptyCharacterPrompts,
  isCharacterPromptsEmpty,
  newPromptIdentifier,
  nextOwnPromptId,
  ownIdentifierOf,
  parsePngCard,
  parsePromptConfig,
  parseStCardText,
  presetBodiesByName,
  readInjectionTrigger,
  removeOwnPrompt,
  setCharacterPromptContent,
  setCharacterPromptEnabled,
  setPromptEnabled,
  stringifyStCard,
  updatePrompt,
  upsertOwnPrompt,
  validateCharacterPrompts,
  validateDraft,
  writeCharacterPrompts,
} from '@tcs/shared';

import { chatAvatar, writeCardPng } from './card-actions';
import { diagNote } from '../diagnostics/mobile-diag.ts';

/**
 * 功能
 * 本模块能碰的壳能力。
 *
 * 注意事项
 * `characterPrompts` / `promptConfig` / `promptTriggers` 都要写 ——
 * 每一条都是"改完要立刻生效"的路径。
 *
 * 踩过的坑
 * 无。
 */
export interface PromptHost extends ChatSessionState {
  readonly bridge: StChatBridge;
  readonly options: ShellOptions;
  readonly chatPanel: ChatPanel | null;

  /** 全局提示词配置（从 ST 设置解析出来的那份） */
  globalPromptConfig: ParsedPromptConfig | null;
  /** 本角色对提示词的覆盖与自建条目。null = 还没读过 */
  characterPrompts: CharacterPromptConfig | null;
  /** 拼好的生效配置（请求体里用它） */
  promptConfig: ParsedPromptConfig | null;
  /** 触发词表：identifier → 该条目的触发词。划词菜单用它 */
  promptTriggers: Map<string, readonly string[]>;
  /** 编辑器当前作用域：改全局预设还是本角色覆盖 */
  promptScope: 'global' | 'character';
  /** 正在编辑的条目 id（null = 没在编辑） */
  promptEditId: string | null;
  /** 作者注释（提示词之外的独立字段，编辑器里一起存） */
  authorNote: AuthorNoteConfig | null;

  withConnection<T>(run: () => Promise<T>): Promise<T>;
  renderPage(): void;
  /** 当前所在设置路由（null = 不在二级页） */
  /** 引擎状态（Android 注入的桥；桌面/浏览器为 undefined） */
  readonly readEngineStatus?: () => EngineStatus | null;
  /** 卡片簇的接入点（取当前头像要走它） */
  cardHost(): import('./card-actions').CardHost;
}

export function rebuildPromptConfig(host: PromptHost): void {
  const merged = combineGlobalAndCharacter(host.globalPromptConfig, host.characterPrompts);
  host.promptConfig = merged;
  host.chatPanel?.setContext({ promptConfig: merged });
}

export async function saveCharacterPrompts(host: PromptHost, 
  mutate: (config: CharacterPromptConfig) => CharacterPromptConfig,
): Promise<{ ok: boolean; reason?: string }> {
  const avatar = chatAvatar(host.cardHost());
  if (avatar === null) return { ok: false, reason: '还没选角色，不知道该存到哪张卡。' };

  const next = mutate(host.characterPrompts ?? emptyCharacterPrompts());

  /*
   * 上限校验。**先校验后写盘** —— 反过来的话卡已经被改坏了才发现超限，
   * 那时只能再写一次去修，而两次写之间用户可能已经杀掉 App。
   */
  const violations = validateCharacterPrompts(next);
  if (violations.length > 0) {
    return { ok: false, reason: violations.map((one) => one.message).join(' ') };
  }

  try {
    const pngBytes = await host.withConnection(() => host.bridge.characterPng(avatar));
    const bytes = new Uint8Array(pngBytes);
    const parsedPng = parsePngCard(bytes);
    if (parsedPng.kind !== 'card') {
      return { ok: false, reason: '这个角色不是 PNG 卡，存不了角色级提示词。' };
    }

    const parsedCard = parseStCardText(parsedPng.jsonText);
    const card = parsedCard.card;

    /*
     * `extensions` 在 `passthrough.data` 这个**原样桶**里。
     *
     * `writeCharacterPrompts` 只动 `tcs.prompts`，其余键（别的工具放的
     * `depth_prompt` / `world` / `fav`，以及我们自己的 `tcs.cardId`）
     * 逐个保留 —— V2 规范 MUST NOT destroy unknown key-value pairs。
     */
    const prevExtensions = card.passthrough.data['extensions'];
    const extensions = writeCharacterPrompts(
      prevExtensions !== null && typeof prevExtensions === 'object' && !Array.isArray(prevExtensions)
        ? (prevExtensions as Record<string, unknown>)
        : null,
      next,
    );

    const updated = {
      ...card,
      passthrough: {
        ...card.passthrough,
        data: {
          ...card.passthrough.data,
          /*
           * 强转的理由：`writeCharacterPrompts` 的输出**自证是 JSON-safe** ——
           * 它只写我们从卡片 JSON 里读出来的值（string / boolean / number /
           * 数组 / 普通对象），没有 Date / Map / undefined。
           *
           * 而它的返回类型故意是 `Record<string, unknown>`：那个文件在
           * `shared/src/chat/` 下，不该为了一个类型去依赖 format 层的
           * `JsonObject`（否则改 format 会牵动 chat）。所以边界处转一次，
           * 且只在这一个位置转。
           */
          extensions: extensions as unknown as (typeof card.passthrough.data)[string],
        },
      },
    };

    const jsonText = stringifyStCard(updated, { indent: 2, entryTitleToComment: true });
    /*
     * `spec` 要跟原卡走：v3 卡写 `ccv3`、v2 卡写 `chara`。
     * 传错会在 ST 读不到的关键字上写一块 —— 表现是"改完 ST 里没变化"。
     */
    const spec = card.meta.spec === 'v3' ? 'v3' : 'v2';
    const png = buildPngCard(bytes, jsonText, spec);

    const status = host.readEngineStatus?.() ?? null;
    const charactersDir = status?.charactersDir ?? '';
    if (charactersDir === '') return { ok: false, reason: '拿不到角色库目录，无法保存。' };

    await writeCardPng(host.cardHost(), avatar, charactersDir, png, false);

    /*
     * 写成功后更新内存并重算。顺序不能反：先重算再写盘的话，
     * 写盘失败时内存里已经是"已保存"的状态，界面会骗人。
     */
    host.characterPrompts = isCharacterPromptsEmpty(next) ? null : next;
    rebuildPromptConfig(host, );

    /*
     * 记下"这几个数"。排查"改了没生效"时：
     * 日志里有这行而卡里没有 ⇒ 写盘或序列化出的问题；
     * 日志里没有这行 ⇒ 根本没走到保存（前端状态没更新）。
     */
    diagNote(
      'note',
      `[提示词] 写回 avatar=${avatar} own=${String(next.own.length)} override=${String(Object.keys(next.overrideOrder).length)} 字节=${String(png.length)}`,
    );

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describeBridgeError(error).message };
  }
}

export async function restoreCharacterPrompts(host: PromptHost): Promise<{ ok: boolean; reason?: string }> {
  const result = await saveCharacterPrompts(host, () => emptyCharacterPrompts());
  if (!result.ok) return result;
  host.renderPage();
  host.options.onNotify?.('已恢复到卡片原本的提示词设置', 'ok');
  return { ok: true };
}

export async function refreshPromptTriggers(host: PromptHost): Promise<void> {
  const config = host.promptConfig;
  if (config === null) return;
  try {
    const raw = await host.withConnection(() => host.bridge.settingsGetRaw());
    const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
    const bodies = presetBodiesByName(envelope);

    const settings = (envelope as Record<string, unknown>)['settings'];
    const resolved =
      typeof settings === 'string'
        ? ((): unknown => {
            try {
              return JSON.parse(settings);
            } catch {
              return null;
            }
          })()
        : settings;
    const presetName = currentPresetName(resolved);
    const body = presetName === '' ? undefined : bodies[presetName];
    /*
     * `undefined`（没这份预设）与 `null`（这份预设读不出对象）都跳过。
     * 都不当"没有触发器"—— 那是两回事，见上面那段说明。
     */
    if (body === undefined || body === null) return;

    const next = new Map<string, readonly string[]>();
    for (const prompt of config.prompts) {
      next.set(prompt.identifier, readInjectionTrigger(body, prompt.identifier));
    }
    host.promptTriggers = next;
    /*
     * 已经在这一页上就重绘一次，让只读值显示出来。
     *
     * 只在编辑页时重绘 —— 在列表页重绘会让用户刚滑到一半的位置跳回顶部。
     */
    if (host.chatSettingsRoute === 'promptEdit') host.renderPage();
  } catch {
    /* 读不到就保持"所有类型"，见上面那段说明 */
  }
}

export async function savePromptDraft(host: PromptHost, 
  identifier: string | null,
  draft: PromptDraft,
): Promise<{ ok: boolean; reason?: string }> {
  const problem = validateDraft(draft);
  if (problem !== null) return { ok: false, reason: problem };

  if (host.promptScope === 'character' && chatAvatar(host.cardHost()) !== null) {
    return saveCharacterPromptDraft(host, identifier, draft);
  }

  const isCreate = identifier === null;
  const newId = isCreate ? newPromptIdentifier() : identifier;

  const result = await mutatePromptPreset(host, (body, config) =>
    isCreate ? createPrompt(body, draft, newId) : updatePrompt(body, identifier, draft),
  );
  if (!result.ok) return result;

  /*
   * 新建成功后**停在编辑页**并显示这条的真正 id？
   *
   * 不 —— 回到列表。用户新建完最想看的是"它进列表了吗、开着吗"，
   * 而列表正好回答这两个问题（末尾一条、开关是开）。
   */
  host.promptEditId = null;
  host.chatSettingsRoute = 'prompts';
  host.renderPage();
  host.options.onNotify?.(isCreate ? '已新建，默认是开启的' : '已保存', 'ok');
  return { ok: true };
}

export async function saveCharacterPromptDraft(host: PromptHost, 
  identifier: string | null,
  draft: PromptDraft,
): Promise<{ ok: boolean; reason?: string }> {
  const global = host.globalPromptConfig;
  const isCreate = identifier === null;

  // ① 新建 → 角色特有项
  if (isCreate) {
    const result = await saveCharacterPrompts(host, (current) => {
      const own: OwnPrompt = {
        id: nextOwnPromptId(current),
        name: draft.name.trim() === '' ? '未命名' : draft.name.trim(),
        content: draft.content,
        role: draft.role,
        enabled: true,
        injection: {
          position: draft.injectionPosition,
          depth: draft.injectionDepth,
          order: draft.injectionOrder,
        },
      };
      return upsertOwnPrompt(current, own);
    });
    if (!result.ok) return result;
    host.promptEditId = null;
    host.chatSettingsRoute = 'prompts';
    host.renderPage();
    host.options.onNotify?.('已加到这个角色，默认是开启的', 'ok');
    return { ok: true };
  }

  // ② 编辑角色特有项 → 按 id 覆盖
  const own = host.characterPrompts?.own.find((one) => ownIdentifierOf(one) === identifier);
  if (own !== undefined) {
    const result = await saveCharacterPrompts(host, (current) => {
      const exists = current.own.some((one) => one.id === own.id);
      if (!exists) return current;
      return upsertOwnPrompt(current, {
        ...own,
        name: draft.name.trim() === '' ? own.name : draft.name.trim(),
        content: draft.content,
        role: draft.role,
        injection: {
          position: draft.injectionPosition,
          depth: draft.injectionDepth,
          order: draft.injectionOrder,
        },
      });
    });
    if (!result.ok) return result;
    host.promptEditId = null;
    host.chatSettingsRoute = 'prompts';
    host.renderPage();
    host.options.onNotify?.('已保存', 'ok');
    return { ok: true };
  }

  // ③ 编辑全局条目 → 只覆盖正文
  const globalPrompt = global?.prompts.find((one) => one.identifier === identifier);
  if (globalPrompt === undefined) {
    return { ok: false, reason: '这条提示词已经不在全局预设里了，先回列表刷新一下。' };
  }
  /*
   * 标记位（`charDescription` / `chatHistory` …）的正文来自卡片与时序，
   * 覆盖它语义不清 —— `setCharacterPromptContent` 会拒绝并给原因，
   * 这里直接把它的话透出去（不自己再写一份判断，那样两处会分叉）。
   */
  const changed = setCharacterPromptContent(
    host.characterPrompts ?? emptyCharacterPrompts(),
    identifier,
    draft.content,
    globalPrompt.content,
    globalPrompt.marker,
  );
  if (!changed.ok) return { ok: false, reason: changed.reason };

  const result = await saveCharacterPrompts(host, () => changed.config);
  if (!result.ok) return result;
  host.promptEditId = null;
  host.chatSettingsRoute = 'prompts';
  host.renderPage();
  host.options.onNotify?.('已保存，只影响这个角色', 'ok');
  return { ok: true };
}

export async function deletePromptById(host: PromptHost, identifier: string): Promise<{ ok: boolean; reason?: string }> {
  /*
   * 角色作用域下：角色特有项可以删；全局预设里的那条**不许删** ——
   * 它属于预设，删掉会让所有角色都少一条。要让它不生效，只能关掉。
   *
   * 这两件事在前端看起来都是"删除"，但后果差一个数量级。
   */
  if (host.promptScope === 'character' && chatAvatar(host.cardHost()) !== null) {
    const own = host.characterPrompts?.own.find((one) => ownIdentifierOf(one) === identifier);
    if (own === undefined) {
      return {
        ok: false,
        reason: '这条在全局预设里，删掉会影响所有角色。只想让它在这个角色下不生效的话，把它关掉。',
      };
    }
    const result = await saveCharacterPrompts(host, (current) => removeOwnPrompt(current, own.id));
    if (!result.ok) return result;
    host.promptEditId = null;
    host.chatSettingsRoute = 'prompts';
    host.renderPage();
    host.options.onNotify?.('已删除', 'ok');
    return { ok: true };
  }

  const result = await mutatePromptPreset(host, (body) => deletePrompt(body, identifier));
  if (!result.ok) return result;

  host.promptEditId = null;
  host.chatSettingsRoute = 'prompts';
  host.renderPage();
  host.options.onNotify?.('已删除', 'ok');
  return { ok: true };
}

export async function mutatePromptPreset(host: PromptHost, 
  apply: (
    body: Record<string, unknown>,
    config: ParsedPromptConfig,
  ) =>
    | { ok: true; body: Record<string, unknown>; changed: boolean }
    | { ok: false; reason: string },
): Promise<{ ok: boolean; reason?: string }> {
  const config = host.promptConfig;
  if (config === null) return { ok: false, reason: '还没读到提示词配置，请回上一页重新进入。' };

  try {
    const raw = await host.withConnection(() => host.bridge.settingsGetRaw());
    const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
    const bodies = presetBodiesByName(envelope);

    const settings = (envelope as Record<string, unknown>)['settings'];
    const resolved =
      typeof settings === 'string'
        ? ((): unknown => {
            try {
              return JSON.parse(settings);
            } catch {
              return null;
            }
          })()
        : settings;
    const presetName = currentPresetName(resolved);
    if (presetName === '') {
      return { ok: false, reason: '不知道该写回哪一份预设（还没选预设）。' };
    }

    const body = bodies[presetName];
    /*
     * `undefined` = 没有这份预设；非对象 = 这份预设读坏了。
     * 两种都要拦住 —— 把它当空对象传下去，保存时会用"只剩我们改的那几个键"
     * 的内容覆盖整份预设，用户的采样参数会全丢。
     */
    if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, reason: `找不到「${presetName}」这份预设的内容，可能刚被删掉。` };
    }

    const next = apply(body as Record<string, unknown>, config);
    if (!next.ok) return { ok: false, reason: next.reason };
    if (!next.changed) return { ok: true };

    await host.withConnection(() =>
      host.bridge.presetSave(presetName, JSON.stringify(next.body)),
    );

    /*
     * 重新解析，让面板手上的配置与磁盘一致。
     *
     * 这一步不能省：不重新解析的话，聊天时用的还是旧内容/旧开关。
     *
     * ★ v0.2.0：写的是 `globalPromptConfig`（磁盘那份预设），再由
     *   `rebuildPromptConfig()` 叠上当前角色的覆盖。直接写
     *   `host.promptConfig` 会把角色覆盖冲掉 —— 表现是"我改完这条
     *   开关，本角色的定制全没了"，而且只在**这个角色有定制**时才出现，
     *   一般人测不到。
     */
    const fresh = parsePromptConfig(next.body);
    host.globalPromptConfig = fresh.prompts.length > 0 ? fresh : null;
    rebuildPromptConfig(host, );
    if (host.authorNote !== null) {
      host.chatPanel?.setContext({ authorNote: host.authorNote });
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describeBridgeError(error).message };
  }
}

export async function savePromptToggle(host: PromptHost, 
  identifier: string,
  enabled: boolean,
): Promise<{ ok: boolean; reason?: string }> {
  return mutatePromptPreset(host, (body, config) =>
    setPromptEnabled(body, config, identifier, enabled),
  );
}
