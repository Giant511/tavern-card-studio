/**
 * ST 端点的路径与请求体拼装（v0.1.7 / T15.4）。
 *
 * 全部是纯函数 —— 不碰网络、不碰 cookie。这样契约测试可以只验"我发的形状对不对"，
 * HTTP 层由 Rust 侧（`st_api.rs`）负责，两层各自可测。
 *
 * 路径常量集中在这里的另一个理由：**端点名字有陷阱**，散落在各处必然有人写错。
 * 最典型的是「按角色的聊天列表」挂在 `characters` 路由下而不是 `chats` ——
 * ST 里根本没有 `/api/chats/list`（契约 §3.2 开头特意先说了这条）。
 */

import type { StChatSource, StGenerateRequest, StChatHeader } from './types.js';
import { ST_HEADER_PLACEHOLDER } from './types.js';

/**
 * 端点路径。
 *
 * 行号取自 ST 1.19.0；用途见各条注释。方法（GET/POST）也写在这里，
 * 因为 ST 有几个端点方法反直觉：读设置是 POST，角色列表也是 POST。
 */
export const ST_ENDPOINTS = {
  /** 取 CSRF token（**未登录也可取**）`src/server-main.js:192-196` */
  csrfToken: { path: '/csrf-token', method: 'GET' },

  /** 角色列表，无 body，返回**裸数组** `characters.js:1466` */
  charactersAll: { path: '/api/characters/all', method: 'POST' },
  /** 单个角色（含 `json_data`）`characters.js:1480` */
  characterGet: { path: '/api/characters/get', method: 'POST' },

  /**
   * 按角色的聊天列表 `characters.js:1499`。
   * 注意挂在 **characters** 下 —— 不是 `/api/chats/list`（那个不存在）。
   */
  chatsOfCharacter: { path: '/api/characters/chats', method: 'POST' },
  /** 全局最近聊天 `chats.js:1054` */
  chatsRecent: { path: '/api/chats/recent', method: 'POST' },
  /** 读聊天，`file_name` **无扩展名** `chats.js:592` */
  chatGet: { path: '/api/chats/get', method: 'POST' },
  /** 存聊天，**全量覆盖** `chats.js:545` */
  chatSave: { path: '/api/chats/save', method: 'POST' },
  /** 重命名，`original_file`/`renamed_file` **带 `.jsonl`** `chats.js:621` */
  chatRename: { path: '/api/chats/rename', method: 'POST' },
  /** 删除，`chatfile` 可带可不带扩展名 `chats.js:654` */
  chatDelete: { path: '/api/chats/delete', method: 'POST' },

  /** 生成（核心）`chat-completions.js:2242` */
  generate: { path: '/api/backends/chat-completions/generate', method: 'POST' },

  /** 读设置，**POST** `settings.js:219` */
  settingsGet: { path: '/api/settings/get', method: 'POST' },
  /** 写设置，**整份覆盖、无 patch** `settings.js:206` */
  settingsSave: { path: '/api/settings/save', method: 'POST' },

  /** 写密钥，返回 `{id}` `secrets.js:511` */
  secretsWrite: { path: '/api/secrets/write', method: 'POST' },
  /** 读密钥（**脱敏**）`secrets.js:529` */
  secretsRead: { path: '/api/secrets/read', method: 'POST' },
} as const;

/**
 * 角色头像的静态 URL。
 *
 * 名字必须 `encodeURIComponent` —— ST 的 avatar 是文件名，里面可能有空格、
 * 括号、中文。不编码会 404，而 404 的表现是"头像空白"，很难联想到编码问题。
 */
export function characterAvatarPath(avatar: string): string {
  return `/characters/${encodeURIComponent(avatar)}`;
}

/**
 * 缩略图 URL（`thumbnails.js:248-253`）。
 *
 * 移动端列表用它而不是原图：原图可能是 2 MB 的 PNG，一屏 20 个角色
 * 就是 40 MB，在手机上足够让列表卡住。
 */
export function thumbnailPath(
  type: 'avatar' | 'bg' | 'persona',
  file: string,
): string {
  return `/thumbnail?type=${encodeURIComponent(type)}&file=${encodeURIComponent(file)}`;
}

/**
 * 拼出 `POST /api/characters/chats` 的请求体。
 *
 * `simple: true` 时返回项只有 `file_id` / `file_name`（`characters.js:1517-1519`），
 * 体积小很多。列表页要 `chat_items`/`last_mes` 排序时才需要 `simple: false`。
 */
export function buildChatsOfCharacterBody(
  avatar: string,
  options: { simple?: boolean; metadata?: boolean } = {},
): Record<string, unknown> {
  return {
    avatar_url: avatar,
    ...(options.simple === undefined ? {} : { simple: options.simple }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
}

/** 读聊天的请求体：`file_name` **不带** `.jsonl`（陷阱 #3） */
export function buildChatGetBody(avatar: string, fileNameWithoutExt: string): Record<string, unknown> {
  return { avatar_url: avatar, file_name: fileNameWithoutExt };
}

/**
 * 存聊天的请求体：**必须带完整数组，含第 0 条 header**。
 *
 * 这是全项目最容易造成"用户历史丢光"的一处（陷阱 #1）：
 * ST 的实现是 `JSON.stringify` 每行再 join 写盘（`chats.js:532-543`），
 * 没有合并语义。只发改动的消息，等于把整段历史覆盖成那几条。
 */
export function buildChatSaveBody(
  avatar: string,
  fileNameWithoutExt: string,
  messages: readonly unknown[],
  options: { force?: boolean } = {},
): Record<string, unknown> {
  return {
    avatar_url: avatar,
    file_name: fileNameWithoutExt,
    chat: messages,
    ...(options.force === undefined ? {} : { force: options.force }),
  };
}

/** 重命名：两个文件名都要**带 `.jsonl`**（陷阱 #3） */
export function buildChatRenameBody(
  avatar: string,
  fromWithExt: string,
  toWithExt: string,
): Record<string, unknown> {
  return { avatar_url: avatar, original_file: fromWithExt, renamed_file: toWithExt };
}

/**
 * 新建聊天的 header。
 *
 * `user_name` / `character_name` 填 `"unused"` 不是占位符写错了 ——
 * ST 就是这么约定的（`public/script.js:7428-7445`），真正的值服务端从 session 取。
 * 这里用常量而不是让调用方传，避免有人认真地把角色名填进去然后困惑"为什么没用"。
 */
export function buildChatHeader(metadata: Record<string, unknown> = {}): StChatHeader {
  return {
    user_name: ST_HEADER_PLACEHOLDER,
    character_name: ST_HEADER_PLACEHOLDER,
    chat_metadata: metadata,
  };
}

/**
 * 生成请求体。
 *
 * ## 为什么要显式拒绝不支持的后端
 *
 * 见 `isSupportedChatSource` 的注释：静默回退会拿错厂商的 key 去打别人的域名。
 * 这里再拦一道，因为拼请求体是最后一道能拦的地方。
 */
export function buildGenerateBody(request: StGenerateRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chat_completion_source: request.chat_completion_source,
    model: request.model,
    messages: request.messages,
    stream: request.stream,
  };
  /*
   * 采样参数**全部显式带过去**：ST 服务端不读 settings.json
   * （`chat-completions.js:2652-2669` 全取 request.body.*）。
   * 漏传一个不会报错，只会表现为"模型表现和桌面上不一样"——
   * 这种"不报错但行为不同"的差异最难查。
   */
  const optional = [
    'temperature',
    'top_p',
    'max_tokens',
    'presence_penalty',
    'frequency_penalty',
    'secret_id',
    'custom_url',
    'reverse_proxy',
    'chat_id',
  ] as const;
  for (const key of optional) {
    const value = request[key];
    if (value !== undefined) body[key] = value;
  }
  return body;
}

/**
 * 把 `chat_completion_source` 规范化。
 *
 * 返回值是 `{ ok: true }` 或 `{ ok: false, reason }` 而不是直接抛异常：
 * 调用方需要把这个原因显示给用户（"该后端暂未支持"），
 * 而异常在半路被 catch 掉就会变成一句没头没尾的"生成失败"。
 */
export function normalizeChatSource(
  value: unknown,
): { ok: true; source: StChatSource } | { ok: false; reason: string } {
  // 延迟引入避免循环依赖
  const list: readonly string[] = [
    'openai',
    'custom',
    'deepseek',
    'openrouter',
    'groq',
    'claude',
  ];
  if (typeof value === 'string' && list.includes(value)) {
    return { ok: true, source: value as StChatSource };
  }
  return {
    ok: false,
    reason:
      `暂不支持这个后端（${String(value)}）。请在「高级功能 → 原生界面」里使用，` +
      '或改选支持的后端之一。',
  };
}
