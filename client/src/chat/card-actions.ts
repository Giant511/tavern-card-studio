/**
 * 功能
 * 卡片这一族的行为：读卡、采纳、选封面、写卡入库存、内嵌世界书落地。
 * 从 AppShell 的 14 个方法搬出（约 600 行）。
 *
 * 注意事项
 * 状态仍在壳上（`loadedCard` / `lastWorldbookFailure` / `selectedCharacter`），
 * 本模块通过 host 读写。`characterPrompts` 与 `shareCache` 属于别的簇，
 * 这里只是暂借；搬那两个簇时要一起拿走。
 *
 * `writeCardToLibrary` 的 `worldbook` 是三态不是布尔：`none` 表示卡本来没书
 * （不必提示），`failed` 表示有书但没落地（必须提示）。别压成 boolean。
 *
 * 踩过的坑
 * 这族方法原来直接在类里访问 9 个字段。搬之前先量了每个字段在簇内/簇外的
 * 读写次数，才发现 `loadedCard` 与 `lastWorldbookFailure` 在簇外各有 4–5 处
 * （聊天页与提示词页要用）—— 它们如果跟着搬走，那两处就断了。
 * 所以字段留壳、方法搬走。
 */

import type { EngineStatus, ImportPlan } from '@tcs/shared';
import {
  attachWorldToCard,
  buildPngCard,
  convertEmbeddedWorldbook,
  describeBridgeError,
  importWorldbook,
  parseCharacterList,
  parseCharacterPrompts,
  parsePngCard,
  planCardImport,
  readEmbeddedWorldbook,
  stringifyStCard,
} from '@tcs/shared';

import type { CanvasDoc } from './card-face';
import { faceFromImage, faceFromName } from './card-face';
import { localCardId, readLocalCardFile } from './card-import-local';
import { readDefaultFaceBytes } from './default-face';
import type { CardWriteResult } from './shell-contract';
import { el } from './chat-view';
import type { DocLike, ElLike } from './chat-view';
import { clearThumbnailCacheFor, loadThumbnail } from './thumbnail';
import { runBusy } from './busy-button';
import { diagNote } from '../diagnostics/mobile-diag.ts';

/**
 * 读角色卡的重试预算（2026-11-11）。
 *
 * 70 秒来自真机首启实测：引擎就绪要 7–57 秒。取 57 之上留余量。
 * 读卡必须跟读历史一样能等 —— 两件事开头是同一个阻塞点（引擎没起）。
 * 只给历史重试不给卡重试，会出现「历史等到了、卡是空的」⇒ 有对话没开场白。
 */
const CARD_LOAD_TIMEOUT_MS = 70_000;
import type { ShellOptions } from './shell-contract';
import type { StChatBridge } from './st-bridge';

/**
 * 功能
 * 本模块能碰的壳能力。
 *
 * 注意事项
 * `characterPrompts` / `shareCache` 是暂借字段，搬对应簇时要移走。
 * 加成员前先想清楚能否从参数传进来。
 *
 * 踩过的坑
 * 无。
 */
export interface CardHost {
  readonly doc: DocLike;
  readonly root: ElLike | null;
  readonly options: ShellOptions;
  readonly bridge: StChatBridge;
  readonly shareCache: Map<string, Uint8Array>;
  /** 暂借：提示词簇的字段。可写 —— 读卡后会按卡重建一次 */
  characterPrompts: unknown;

  readonly selectedCharacter: { avatar: string; name: string } | null;

  /** 最后一次内嵌世界书失败的原因。写卡前要清空，否则沿用上次的失败 */
  lastWorldbookFailure: string;

  /** 已加载的角色卡内容。读卡成功才非空 */
  loadedCard: Record<string, unknown>;

  /** 引擎状态（Android 注入的桥；桌面/浏览器为 undefined） */
  readonly readEngineStatus?: () => EngineStatus | null;

  ensureConnected(): Promise<void>;
  withConnection<T>(run: () => Promise<T>): Promise<T>;
  /** 换卡后重建提示词配置 */
  rebuildPromptConfig(): void;
}

export async function persistEmbeddedWorldbook(host: CardHost, 
  jsonText: string,
  cardName: string,
): Promise<string | null> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    /* 卡 JSON 不合法：那不是这里要处理的（`planCardImport` 已校验过） */
    return null;
  }

  let plan: ReturnType<typeof convertEmbeddedWorldbook> = null;
  try {
    plan = convertEmbeddedWorldbook(parsed, { cardName });
  } catch {
    return null;
  }
  if (plan === null) return null;

  try {
    /*
     * 先查重：ST 的 import 同名覆盖，不能撞掉别人的书。
     *
     * 上限 50 与 `uniqueAvatar` 同一套思路：极端情况下不死循环。
     *
     * ★ `null` ≠ `[]`（2026-11-06 修）：读失败与"确实一本都没有"是两件事。
     *   读失败时若当成空表，同名就会**静默覆盖用户已有的书** —— 那比不落地
     *   世界书严重得多（丢的是别人一整套设定，且不可逆）。所以读失败就
     *   整个跳过：卡已经写好了，少一本书是可重试的，覆盖是不可逆的。
     */
    const existing = await listWorldbookNames(host);
    if (existing === null) return null;
    let name = plan.name;
    if (existing.includes(name)) {
      /*
       * 已有同名。名字本身带 ` (n)` 说明它当初就是被加过序号的，
       * 那几乎肯定是我们为同一张卡建的 ⇒ 覆盖是对的。
       * 否则保守加序号。
       */
      if (!/ \(\d+\)$/.test(name)) {
        for (let index = 2; index <= 50; index += 1) {
          const candidate = `${plan.name} (${String(index)})`;
          if (!existing.includes(candidate)) {
            name = candidate;
            break;
          }
        }
      }
    }

    await host.withConnection(() =>
      host.bridge.importWorldbook(name, JSON.stringify(plan.entries)),
    );
    return name;
  } catch (error) {
    /*
     * ★★★ 失败不能再静默（2026-11-09 用户报「导入卡片后却没有导入角色的世界书」）。
     *
     * 原来这里是一个空 catch，只 `return null`。后果是：
     *
     * ```text
     *   卡面写好了 → 用户能用角色 → 但世界书没进来
     *   而界面上一个字的提示都没有 → 用户以为"这张卡本来就没世界书"
     * ```
     *
     * 真实原因可能是：ST 的 worldinfo/import 被拒、名字撞了加序号后
     * 仍失败、引擎连接在半路断了……**每一种处置都不同**，
     * 静默等于把这四种都压成"没有"。
     *
     * 现在记下原因，由调用方在**导入成功之后**补一条 warn（不是 danger：
     * 角色确实可用了，不该让用户以为整个导入失败）。
     */
    host.lastWorldbookFailure = describeBridgeError(error).message;
    return null;
  }
}

export async function listWorldbookNames(host: CardHost): Promise<string[] | null> {
  try {
    const raw = await host.withConnection(() => host.bridge.listWorldbooksRaw());
    const parsed: unknown = JSON.parse(raw === '' ? '[]' : raw);
    if (!Array.isArray(parsed)) return null;
    const out: string[] = [];
    for (const one of parsed) {
      if (one === null || typeof one !== 'object') continue;
      const obj = one as Record<string, unknown>;
      /* ST 列表里 `file_id` 才是文件名主干；`name` 可能是显示名 */
      const fileId = typeof obj['file_id'] === 'string' ? obj['file_id'] : '';
      const name = typeof obj['name'] === 'string' ? obj['name'] : '';
      const value = fileId !== '' ? fileId : name;
      if (value !== '') out.push(value);
    }
    return out;
  } catch (error) {
    host.lastWorldbookFailure = describeBridgeError(error).message;
    return null;
  }
}

export async function resolveCardPlacement(host: CardHost, input: {
  jsonText: string;
  cardId: string;
  confirmOverwrite: boolean;
}): Promise<ImportPlan | null> {
  /*
   * 现有文件名要**现取**，不能用页面进页面时那份：
   * 用户可能刚导入过一张，再导同名的那张就该变 ` (2)`。
   */
  const rawList = await host.withConnection(() => host.bridge.listCharactersRaw());
  const listed = parseCharacterList(rawList);
  if (!listed.ok) throw new Error(listed.reason);

  const planned = planCardImport({
    jsonText: input.jsonText,
    cardId: input.cardId,
    existingAvatars: listed.items.map((one) => one.avatar),
    /*
     * ★ 名字也要传（2026-11-06，用户报「同一个角色出现多个」）。
     *
     * 只给文件名判断不出"同一个角色"：`西奥.png` 与 `西奥 (2).png`
     * 是两个不同的字符串，但它们是同一个角色。必须按**卡名**比。
     */
    existingNames: listed.items.map((one) => one.name),
  });
  if (!planned.ok) throw new Error(planned.reason);

  /*
   * 覆盖不可逆，而本地导入没有服务端那份兜底：从别人那里收到一张同名卡，
   * 就会顶掉用户自己那张。所以这条路必须先问。
   *
   * 仓库下载不弹（`confirmOverwrite: false`）—— 那份是权威版本，
   * 用户点"下载"就是要把本地刷成它。
   */
  if (planned.plan.overwrite && input.confirmOverwrite) {
    const go = await confirmOverwriteCard(host, planned.plan.displayName);
    if (!go) return null;
  }

  return planned.plan;
}

export async function writeCardToLibrary(host: CardHost, input: {
  plan: ImportPlan;
  jsonText: string;
  /**
   * 当底图的 PNG 字节。
   *
   * `null` = 没有图 ⇒ 按卡名生成一张首字封面。
   * 用 `null` 而不是空数组：空数组是合法值，混用分不清「没图」和「图是空的」。
   */
  base: Uint8Array | null;
}): Promise<CardWriteResult> {
  const { plan, jsonText } = input;

  /*
   * 内嵌世界书**先**落地。
   * 失败**不阻断导入** —— 卡本身能用；阻断会让用户连卡都拿不到，
   * 那比"世界书没进来"更糟。
   */
  /* 先清掉上一次的失败痕迹，否则这一次"没有书"会被上一次的失败原因污染 */
  host.lastWorldbookFailure = '';

  const worldName = await persistEmbeddedWorldbook(host, jsonText, plan.displayName);
  const cardText = worldName === null ? jsonText : JSON.stringify(
    attachWorldToCard(JSON.parse(jsonText) as unknown, worldName),
  );

  /*
   * ★ 卡里到底有没有书，与"落地成没成"是**两件事**（2026-11-09）。
   *
   * `persistEmbeddedWorldbook` 返回 `null` 同时覆盖两种情况，
   * 所以这里再问一次源头，才能给出对的话：
   *
   * ```text
   *   卡里没有 character_book  → 本来就没有，"缺书"不是问题，不该提示
   *   有书但落地失败          → 必须告诉用户，否则他会以为卡没带书
   * ```
   */
  const worldbook: CardWriteResult['worldbook'] = (() => {
    if (worldName !== null) return 'ok';
    if (host.lastWorldbookFailure !== '') return 'failed';
    /* 没失败但也没书名 ⇒ 卡里没有内嵌书 */
    let hasBook = false;
    try {
      hasBook = readEmbeddedWorldbook(JSON.parse(jsonText) as unknown) !== null;
    } catch {
      hasBook = false;
    }
    return hasBook ? 'failed' : 'none';
  })();

  /*
   * 没有底图就按卡名画一张（v0.1.8，用户口径）。
   *
   * 为什么不塞一张统一的默认卡面：选角色列表**显示头像**，
   * 所有没有封面的卡长得一模一样，用户只能靠名字分辨 ——
   * 那等于把"有没有封面"变成了"能不能认出自己的卡"。
   *
   * 失败不阻断：画不出来就退回内置卡面；内置也没有才抛（那是打包问题）。
   */
  let base = input.base;
  if (base === null) {
    try {
      base = await faceFromName(host.doc as unknown as CanvasDoc, plan.displayName);
    } catch {
      base = await readDefaultFaceBytes();
    }
  }

  const png = buildPngCard(base, cardText, plan.spec);

  const status = host.readEngineStatus?.() ?? null;
  const charactersDir = status?.charactersDir ?? '';
  if (charactersDir === '') throw new Error('拿不到角色库目录，无法保存');

  /*
   * ★★★ 写卡之后必须让**头像缩略图**失效（2026-11-11）。
   *
   * ## 用户两次报同一件事
   *
   * ```text
   *   ① 下载后威廉的角色头像还是原来的那个兜底的
   *   ② 现在连直接导入 PNG 卡，缩略图还是会显示兜底
   * ```
   *
   * 第 ② 次说明第一版只修了仓库下载那条路 —— 而本地导入走的是同一个
   * `writeCardToLibrary`。**修在调用方就是会漏，修在这里才对。**
   *
   * ## 真因（直连 ST 读字节取证）
   *
   * ```text
   *   原图   /characters/威廉.png      PNG  683×1024（691 KB） ← 已经是新卡面
   *   缩略图 /thumbnail?type=avatar    JPEG  96×144（5 KB）    ← 还是绿「威」字
   * ```
   *
   * ST 靠 `originalStat.mtimeMs > cachedStat.ctimeMs` 判断原图变没变
   * （`thumbnails.js`）。而我们是**直接写文件**（tmp + rename），绕过了
   * 它的 API —— 那条路上它没有机会知道"图换了"，于是永远回旧缩略图。
   *
   * ## 两层都要清
   *
   * ```text
   *   ST  磁盘缩略图  ← invalidateThumbnail（删文件，下次请求自动重建）
   *   App 内存 cache  ← clearThumbnailCacheFor
   * ```
   *
   * 只清一层不够：ST 那层不清，App 重新请求拿到的还是旧字节；
   * App 那层不清，这一会话里根本不会重新请求。
   *
   * 失败**不阻断导入**：卡的内容已经落地了，头像只是观感。
   */
  try {
    await host.withConnection(() => host.bridge.invalidateThumbnail(plan.avatar, charactersDir));
  } catch {
    /* 清不掉就让 ST 继续用旧缩略图 —— 不影响卡内容 */
  }
  clearThumbnailCacheFor(plan.avatar);

  /*
   * `allowCreate` 跟着 `overwrite` 走 —— 两个语义**必须成对**：
   *
   * ```text
   *   新卡（overwrite=false） ⇒ allowCreate=true   要求同名不存在
   *   覆盖（overwrite=true）  ⇒ allowCreate=false  要求文件已存在
   * ```
   *
   * 反着传会直接报错（Rust 侧两个方向都校验），这正是我们要的：
   * "该新建却去覆盖" / "该覆盖却去新建" 立刻暴露，而不是静默走错。
   */
  await writeCardPng(host, plan.avatar, charactersDir, png, !plan.overwrite);

  return {
    worldbook,
    ...(worldName === null ? {} : { worldbookName: worldName }),
    ...(host.lastWorldbookFailure === '' ? {} : { worldbookFailure: host.lastWorldbookFailure }),
  };
}

export async function importLocalCard(host: CardHost, button: ElLike): Promise<void> {
  const picked = await pickFileBytes(host, 'image/png,application/json,.png,.json');
  if (picked === null) return;

  const parsed = readLocalCardFile(picked.name, picked.bytes);
  if (parsed.kind === 'reject') {
    /* 不是卡就是不是卡，不能进忙碌态装作在处理 */
    host.options.onNotify?.(parsed.reason, 'warn');
    return;
  }

  /*
   * PNG 卡用**它自己那张图**当底图 —— 本地导入的卡应该保留它自己的封面。
   *
   * JSON 卡本身没有图，所以这里**问一句**（v0.1.8 用户口径）：
   * 从相册选一张，或者让它按卡名生成。
   *
   * 为什么不直接塞默认图：选角色列表是显示头像的，所有没有封面的卡
   * 长得一模一样，用户只能靠名字分辨。而 JSON 卡的封面一旦定下，
   * 手机端**没有任何地方能改**（卡面编辑只在桌面端有），
   * 所以选择必须发生在导入这一刻。
   */
  let base = parsed.base;
  if (base === null) {
    const choice = await askCardFace(host, );
    if (choice === 'cancel') return;

    if (choice === 'pick') {
      const pickedFace = await pickFaceImage(host, );
      /* 选图框取消了就当作用户放弃这次导入，不偷偷退回默认图 */
      if (pickedFace === null) return;
      base = pickedFace;
    }
    /* choice === 'default' ⇒ base 保持 null，写入时按卡名生成 */
  }

  const cardId = localCardId(parsed.jsonText, picked.name);

  let plan: ImportPlan | null = null;
  try {
    plan = await resolveCardPlacement(host, {
      jsonText: parsed.jsonText,
      cardId,
      confirmOverwrite: true,
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    host.options.onNotify?.(text, 'danger');
    return;
  }
  if (plan === null) return; /* 用户取消覆盖 */

  const target = plan;
  let written: CardWriteResult | null = null;
  await runBusy(
    button,
    { idle: '从手机导入卡片', busy: '导入中…', done: '已导入 ✓', retry: '重试' },
    async () => {
      written = await writeCardToLibrary(host, { plan: target, jsonText: parsed.jsonText, base });
    },
    { doneKind: 'ok' },
  ).then(() => {
    /*
     * 成功后才通知，且**这时候不会重绘**（卡片页不列卡片），
     * 所以挂 topbar 的通知不会被删掉。
     */
    const done = target.overwrite
      ? `已覆盖「${target.displayName}」`
      : `已导入「${target.displayName}」`;
    /*
     * ★ 世界书那半句必须单独说（2026-11-09）。
     *
     * 卡写成功但书没进来时，只说"已导入"就是在撒谎 ——
     * 用户以为设定齐了，实际角色会在聊天里"忘事"，而且找不到原因。
     */
    const result = written as CardWriteResult | null;
    if (result !== null && result.worldbook === 'failed') {
      host.options.onNotify?.(
        `${done}，但内嵌世界书没进来：${result.worldbookFailure ?? '未知原因'}`,
        'warn',
      );
      return;
    }
    const extra = result !== null && result.worldbook === 'ok'
      ? `，含世界书「${result.worldbookName ?? ''}」`
      : '';
    host.options.onNotify?.(`${done}${extra}`, 'ok');
  }).catch((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    host.options.onNotify?.(`导入失败：${text}`, 'danger');
  });
}

export async function pickFileBytes(host: CardHost, 
  accept: string,
): Promise<{ name: string; bytes: Uint8Array } | null> {
  const input = host.doc.createElement('input');
  input.setAttribute('type', 'file');
  /* 扩展名与 MIME 都写：不同 ROM 的选文件器认其中一种 */
  input.setAttribute('accept', accept);
  input.setAttribute('style', 'position:fixed;left:-9999px;top:0;opacity:0;');
  const body = (host.doc as unknown as { body?: ElLike }).body;
  if (body === undefined) return null;
  body.append(input);

  try {
    return await new Promise<{ name: string; bytes: Uint8Array } | null>((resolve) => {
      let settled = false;
      const finish = (value: { name: string; bytes: Uint8Array } | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      input.addEventListener('change', () => {
        const file = (input as unknown as HTMLInputElement).files?.[0];
        if (file === undefined) {
          finish(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          /*
           * 必须是 ArrayBuffer。用 `readAsText` 读 PNG 会把二进制掰成文本，
           * 那份字节再写进角色目录就是一个坏文件 —— 而且看起来像"导入成功"。
           */
          if (result instanceof ArrayBuffer) {
            finish({ name: file.name, bytes: new Uint8Array(result) });
            return;
          }
          finish(null);
        };
        reader.onerror = () => finish(null);
        reader.readAsArrayBuffer(file);
      });
      input.addEventListener('cancel', () => finish(null));
      globalThis.setTimeout(() => finish(null), 60_000);
      (input as unknown as HTMLInputElement).click();
    });
  } finally {
    input.remove();
  }
}

export async function askCardFace(host: CardHost): Promise<'pick' | 'default' | 'cancel'> {
  /*
   * 局部名用 `root`，与参数 `host` 区分。
   * 原来在类里是 `const host = this.root`，搬出来后会与参数同名 ——
   * 严格模式下直接报重复声明。
   */
  const root = host.root;
  if (root === null) return 'default';

  return await new Promise<'pick' | 'default' | 'cancel'>((resolve) => {
    const overlay = el(host.doc, 'div', 'nb-exit-overlay');
    overlay.setAttribute('data-role', 'card-face-ask');

    const card = el(host.doc, 'div', 'nb-exit-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    const title = el(host.doc, 'p', 'nb-exit-title');
    title.textContent = '给这张卡配一张封面？';
    const sub = el(host.doc, 'p', 'nb-exit-subtitle');
    sub.textContent = '这张卡文件里没有图。可以选一张，或者用卡名生成一张。';

    const actions = el(host.doc, 'div', 'nb-exit-actions');

    const pick = el(host.doc, 'button', 'nb-exit-leave');
    pick.setAttribute('type', 'button');
    pick.setAttribute('data-role', 'card-face-pick');
    pick.textContent = '选一张图';
    pick.addEventListener('click', () => {
      overlay.remove();
      resolve('pick');
    });

    const fallback = el(host.doc, 'button', 'nb-exit-stay');
    fallback.setAttribute('type', 'button');
    fallback.setAttribute('data-role', 'card-face-default');
    fallback.textContent = '用卡名生成';
    fallback.addEventListener('click', () => {
      overlay.remove();
      resolve('default');
    });

    const cancel = el(host.doc, 'button', 'nb-exit-stay');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute('data-role', 'card-face-cancel');
    cancel.textContent = '不导了';
    cancel.addEventListener('click', () => {
      overlay.remove();
      resolve('cancel');
    });

    actions.append(pick, fallback, cancel);
    card.append(title, sub, actions);
    overlay.append(card);
    /* 点遮罩 = 按卡名生成：既不臆断用户要走，也不让他卡在一个必答问题上 */
    overlay.addEventListener('click', (event) => {
      if ((event as { target?: unknown }).target !== overlay) return;
      overlay.remove();
      resolve('default');
    });

    root.append(overlay);
  });
}

export async function pickFaceImage(host: CardHost): Promise<Uint8Array | null> {
  const picked = await pickFileBytes(host, 'image/*');
  if (picked === null) return null;

  try {
    return await faceFromImage(host.doc as unknown as CanvasDoc, picked.bytes);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    host.options.onNotify?.(text, 'warn');
    return null;
  }
}

export async function confirmOverwriteCard(host: CardHost, name: string): Promise<boolean> {
  const root = host.root;
  if (root === null) return false;

  return await new Promise<boolean>((resolve) => {
    const overlay = el(host.doc, 'div', 'nb-exit-overlay');
    overlay.setAttribute('data-role', 'card-import-confirm');

    const card = el(host.doc, 'div', 'nb-exit-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    const title = el(host.doc, 'p', 'nb-exit-title');
    title.textContent = `本地已有「${name}」`;
    const sub = el(host.doc, 'p', 'nb-exit-subtitle');
    sub.textContent = '覆盖会替换这张卡的内容，不能恢复。';

    const actions = el(host.doc, 'div', 'nb-exit-actions');

    const confirm = el(host.doc, 'button', 'nb-exit-leave');
    confirm.setAttribute('type', 'button');
    confirm.setAttribute('data-role', 'card-import-confirm-ok');
    confirm.textContent = '覆盖';
    confirm.addEventListener('click', () => {
      overlay.remove();
      resolve(true);
    });

    const cancel = el(host.doc, 'button', 'nb-exit-stay');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute('data-role', 'card-import-confirm-cancel');
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => {
      overlay.remove();
      resolve(false);
    });

    actions.append(confirm, cancel);
    card.append(title, sub, actions);
    overlay.append(card);
    /* 点遮罩等同取消：覆盖是危险动作，误触不该前进 */
    overlay.addEventListener('click', (event) => {
      if ((event as { target?: unknown }).target !== overlay) return;
      overlay.remove();
      resolve(false);
    });

    root.append(overlay);
  });
}

export function chatAvatar(host: CardHost): string | null {
  return host.selectedCharacter?.avatar ?? null;
}

export async function loadCharacterCard(host: CardHost, avatar: string): Promise<boolean> {
  try {
    const pngBytes = await host.withConnection(() => host.bridge.characterPng(avatar));
    const parsed = parsePngCard(new Uint8Array(pngBytes));
    if (parsed.kind !== 'card') {
      adoptLoadedCard(host, {});
      return false;
    }
    const json = JSON.parse(parsed.jsonText) as unknown;
    if (json === null || typeof json !== 'object') {
      adoptLoadedCard(host, {});
      return false;
    }
    const root = json as Record<string, unknown>;
    const data = root['data'];
    adoptLoadedCard(host, 
      data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : root,
    );
    return true;
  } catch {
    adoptLoadedCard(host, {});
    return false;
  }
}

export function adoptLoadedCard(host: CardHost, card: Record<string, unknown>): void {
  host.loadedCard = card;
  /*
   * `extensions` 是 V2/V3 规范里放应用私有数据的唯一位置。
   * 取不到（V1 卡 / 没配过）就是 `null` —— 面板据此完全走全局。
   */
  host.characterPrompts = parseCharacterPrompts(card['extensions']);
  host.rebuildPromptConfig();
}

export async function loadCharacterCardWithRetry(host: CardHost, avatar: string): Promise<boolean> {
  const deadline = Date.now() + CARD_LOAD_TIMEOUT_MS;
  for (;;) {
    /*
     * 用户可能在这期间换了角色 —— 立刻放弃，别把别人的卡读到这个槽里。
     * 与 `restoreLatestChat` 里那条判断同源。
     */
    if (host.selectedCharacter !== null && host.selectedCharacter.avatar !== avatar) return false;

    await host.ensureConnected();
    if (await loadCharacterCard(host, avatar)) return true;

    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

export async function writeCardPng(host: CardHost, 
  avatar: string,
  charactersDir: string,
  png: Uint8Array,
  allowCreate: boolean,
): Promise<void> {
  await host.withConnection(() =>
    host.bridge.writeCharacterPng(avatar, charactersDir, png, allowCreate),
  );
  /*
   * 写成功就作废这张卡的分享缓存。顺序不能反：先清再写的话，
   * 写失败时缓存已经没了 —— 下次导出会重新读（也能读到旧的），
   * 但白丢一次预取。
   */
  host.shareCache.delete(avatar);
  diagNote('note', `[卡] 已写回 avatar=${avatar} 缓存已作废`);
}