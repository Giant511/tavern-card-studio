/**
 * 本地卡文件解析（v0.1.8）—— 纯逻辑，无 DOM、无桥、无副作用。
 *
 * ## 它解决什么
 *
 * 安卓端 v0.1.7 只有「仓库 → 下载」一条进卡的路。用户从微信收到一张 PNG 卡、
 * 或者拿到一个 JSON 卡文件，手机里**没有地方放**。这个模块负责第一段：
 * 把「用户选的那个文件的字节」变成「可以走导入管线的一包内容」。
 *
 * 第二段（落名、去重、写盘）不在这里 —— 它复用仓库下载那条路，
 * 见 `shell.ts` 的 `importCardJson`。分开放的理由是这一段能在 Node 里单测，
 * 那一段必须连引擎。
 *
 * ## 为什么只认 PNG 与 JSON
 *
 * TXT 不做，是刻意的：桌面端的 TXT 是**带板块标记的自有格式**（`@@性格` 之类），
 * 不是通用文本。手机上导入一个随便的 TXT，只会得到一张空卡或者解析失败 ——
 * 那比"没有这个入口"更糟，因为用户会以为是自己文件坏了。
 * 详见 `PLAN.md` 的 v0.1.8 待办。
 */

import { isPngBytes, parsePngCard } from '@tcs/shared';

export type LocalCardFile =
  | {
      kind: 'card';
      /** 卡 JSON 原文，逐字节保真；直接喂 `planCardImport` */
      jsonText: string;
      /**
       * 当底图用的 PNG 字节。
       *
       * - 进来的就是 PNG 卡 ⇒ 用**用户那张图本身**（封面不丢）
       * - 进来的是 JSON ⇒ `null`，由调用方补内置兜底卡面
       *
       * 用 `null` 而不是空数组表示"没有"：空数组是个合法值，
       * 混用会让调用方分不清"没图"和"图是空的"（本项目踩过 `null` ≠ `[]`）。
       */
      base: Uint8Array | null;
      /** 给用户看的一句话，说明这份文件被当成了什么 */
      note: string;
    }
  | {
      kind: 'reject';
      /** 为什么不能导入 —— 直接展示给用户，要具体 */
      reason: string;
    };

/** 文件扩展名（只用于给提示文案，不参与判定：判定看内容） */
function extOf(fileName: string): string {
  const at = fileName.lastIndexOf('.');
  return at <= 0 ? '' : fileName.slice(at + 1).toLowerCase();
}

/**
 * 把一个本地文件的字节解析成可导入的卡。
 *
 * ## 判定顺序：先看内容，不看扩展名
 *
 * 扩展名会骗人 —— 微信转存、改名的文件经常是 `卡.png` 但内容是 JSON，
 * 或者反过来。所以先按 PNG 签名（`89 50 4E 47 0D 0A 1A 0A`）判断，
 * 不匹配再按 JSON 试。扩展名只在两条路都失败时用来把提示说得更具体。
 *
 * ## 为什么不在这里校验"是不是一张合法的卡"
 *
 * `planCardImport` 也不校验（它只读 `spec` 与名字，读不出来就用兜底名）。
 * 真正的字段校验在 `parseStCard`，而导入这条路是"把文件原样交给引擎"，
 * 引擎自己会拒绝读不出来的东西。
 *
 * 这里只保证一件事：**别把二进制垃圾当文本写进角色目录**。
 * 所以 JSON 分支至少要 `JSON.parse` 成功且是对象。
 */
export function readLocalCardFile(fileName: string, bytes: Uint8Array): LocalCardFile {
  if (bytes.length === 0) {
    return { kind: 'reject', reason: `「${fileName}」是空文件` };
  }

  if (isPngBytes(bytes)) {
    let parsed: ReturnType<typeof parsePngCard>;
    try {
      parsed = parsePngCard(bytes);
    } catch (error) {
      /*
       * PNG 结构坏了（截断 / CRC 不符 / 缺 IEND）。
       * 这类错误 `parsePngCard` 抛得很具体，原样转给用户，
       * 不要包成"导入失败"—— 那样用户不知道该重下一张还是换个文件。
       */
      const detail = error instanceof Error ? error.message : String(error);
      return { kind: 'reject', reason: `这张 PNG 读不出来（${detail}）` };
    }

    if (parsed.kind === 'bare') {
      /*
       * 是张好 PNG，但里面没有卡数据块。
       *
       * 这是**最常见的误操作**：用户把卡面的截图、或者一张普通插画当成了卡。
       * 必须说清"这只是一张图"，否则用户会以为是 App 坏了。
       */
      return {
        kind: 'reject',
        reason: `这张 PNG 里没有卡片数据，只是一张图片${parsed.note === '' ? '' : `（${parsed.note}）`}`,
      };
    }

    return {
      kind: 'card',
      jsonText: parsed.jsonText,
      base: bytes,
      note: parsed.keyword === 'ccv3' ? 'PNG 卡（V3）' : 'PNG 卡（V2）',
    };
  }

  /* ── 不是 PNG，按 JSON 试 ── */
  let text = '';
  try {
    /* `fatal: true`：坏字节直接抛，而不是悄悄换成 U+FFFD 让 JSON 变成一坨问号 */
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return {
      kind: 'reject',
      reason: `「${fileName}」不是 PNG 卡，也不是 UTF-8 文本文件`,
    };
  }

  /* Windows 记事本存出来的 JSON 常带 BOM，`JSON.parse` 不认 */
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const trimmed = text.trim();
  if (trimmed === '') {
    return { kind: 'reject', reason: `「${fileName}」里没有内容` };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch {
    const ext = extOf(fileName);
    const hint =
      ext === 'txt'
        ? '。TXT 卡请在桌面客户端导入 —— 那是带板块标记的自有格式，手机端不支持'
        : '';
    return { kind: 'reject', reason: `「${fileName}」不是有效的 JSON${hint}` };
  }

  if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) {
    return { kind: 'reject', reason: `「${fileName}」的 JSON 顶层不是一个对象，不像角色卡` };
  }

  return { kind: 'card', jsonText: trimmed, base: null, note: 'JSON 卡' };
}

/**
 * 猜一个卡片 ID 给 `planCardImport` 当名字兜底。
 *
 * `planCardImport` 的 `cardId` **只用于卡名读不出来时兜底**，不参与"是不是同一张卡"
 * 的判断（那个按卡名比，见 `card-import.ts` 注释）。所以这里不必严格。
 *
 * 优先取卡内自带的 `data.extensions.tcs.cardId`（我们自己的卡都带），
 * 没有再退回文件名。理由：同一张卡换个文件名再导入时，卡内那个 ID 更可信。
 */
export function localCardId(jsonText: string, fileName: string): string {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = null;
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const top = parsed as Record<string, unknown>;
    const data =
      typeof top['data'] === 'object' && top['data'] !== null
        ? (top['data'] as Record<string, unknown>)
        : null;

    /* V2/V3 在 data.extensions，V1 在顶层 extensions —— 两处都试 */
    for (const holder of [data, top]) {
      if (holder === null) continue;
      const extensions = holder['extensions'];
      if (typeof extensions !== 'object' || extensions === null) continue;
      const tcs = (extensions as Record<string, unknown>)['tcs'];
      if (typeof tcs !== 'object' || tcs === null) continue;
      const id = (tcs as Record<string, unknown>)['cardId'];
      if (typeof id === 'string' && id.trim() !== '') return id.trim();
    }
  }

  const base = fileName.replace(/\.[^.]+$/, '').trim();
  return base === '' ? '未命名卡片' : base;
}
