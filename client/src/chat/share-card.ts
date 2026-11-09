/**
 * 「导出为 PNG 并分享」（2026-11-04，用户要求「支持将卡导出为PNG分享出来」）。
 *
 * ## 三件事，一件都不能省
 *
 * ```text
 * ① 读卡      st_chat_character_png（既有命令，已经导出过干净卡）
 * ② 转 base64 跨桥只能传字符串
 * ③ 起分享     StBridge.sharePng → ACTION_SEND + FileProvider
 * ```
 *
 * ## 为什么复用 `st_chat_character_png` 而不是自己读文件
 *
 * 那条命令走的是引擎的 `/api/characters/export`，它会 `unsetPrivateFields`
 * —— 导出的卡里**不含** `chat_size` / `date_last_chat` 这类运行时字段。
 * 分享出去的卡是给别人用的，带上一堆本地状态没有意义，还会让对方
 * 以为"这张卡有多少条聊天记录"。
 *
 * ## 为什么分享在原生做
 *
 * WebView 里没有 `navigator.share`（这个壳连 `fetch` 都不通），
 * 也没有写文件能力。`ACTION_SEND` + `FileProvider` 只能从 Kotlin 起。
 */

/** 桥里 sharePng 的最小形状（便于单测注入） */
export interface ShareBridge {
  sharePng: (base64: string, fileName: string) => string;
}

/** `st_chat_character_png` 那条命令的返回（`number[]`） */
export type PngBytes = number[] | Uint8Array;

function findBridge(): ShareBridge | null {
  const raw = (globalThis as { __ST_ENGINE__?: Partial<ShareBridge> }).__ST_ENGINE__;
  if (typeof raw?.sharePng !== 'function') return null;
  return raw as ShareBridge;
}

/**
 * 字节 → base64。
 *
 * 分块：`String.fromCharCode(...bytes)` 一次铺几十万个数会超出调用栈
 * （V8 约 6 万~12 万），而分块 0x8000 是安全且够快的折中。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const btoaFn = (globalThis as { btoa?: (input: string) => string }).btoa;
  if (typeof btoaFn !== 'function') throw new Error('这台设备缺少 base64 编码能力');

  const chunk = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoaFn(binary);
}

/** 卡名 → 分享用的文件名（去扩展名、滤掉不安全字符） */
export function shareFileName(name: string): string {
  let out = '';
  for (const ch of Array.from(name.trim())) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if ('/\\:*?"<>|'.includes(ch)) continue;
    out += ch;
  }
  out = out.replace(/\.png$/i, '').trim().slice(0, 60);
  return `${out === '' ? '卡片' : out}.png`;
}

export interface ShareOutcome {
  ok: boolean;
  /** 失败原因（`ok: false` 时一定有） */
  reason?: string;
  /** 落盘的临时文件 URI（排障用，不给用户看） */
  uri?: string;
  bytes?: number;
}

/**
 * 把一张角色卡的 PNG 分享出去。
 *
 * **不抛异常**：失败返回 `{ ok:false, reason }`，
 * 让调用方统一用顶部提示条告诉用户 —— 抛异常会让每个调用点各写一遍捕获。
 */
export function shareCardPng(name: string, png: PngBytes): ShareOutcome {
  const bridge = findBridge();
  if (bridge === null) return { ok: false, reason: '这台设备不支持分享' };

  const bytes = png instanceof Uint8Array ? png : new Uint8Array(png);
  if (bytes.length === 0) return { ok: false, reason: '这张卡没有可导出的内容' };

  let base64 = '';
  try {
    base64 = bytesToBase64(bytes);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : '编码失败' };
  }

  let reply: { ok?: boolean; error?: string; uri?: string; bytes?: number } = {};
  try {
    reply = JSON.parse(bridge.sharePng(base64, shareFileName(name))) as typeof reply;
  } catch {
    return { ok: false, reason: '分享失败（返回的不是有效数据）' };
  }

  if (reply.ok !== true) return { ok: false, reason: reply.error ?? '分享失败' };
  return { ok: true, uri: reply.uri, bytes: reply.bytes };
}
