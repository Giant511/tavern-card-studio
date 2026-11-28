/**
 * 功能
 * 打开卡片的所有入口：选文件、直接从 PNG 打开、从纯文本导入、
 * 查看卡信息、打开刚收到的卡。从 EditorApp 搬出，5 个函数 219 行。
 *
 * 注意事项
 * 五个入口最后都汇到同一条路：`arriveCard(card)` → `activateSession(id)`。
 * 这条汇合是刻意的 —— "打开一张卡之后该发生什么"（切标签、重铺板块、
 * 排校验、恢复滚动位置）只该有一处实现。新加入口请复用它。
 *
 * `openPngCard` 与 `importCardTextFile` 的区别是**有没卡面**：
 * 前者读 PNG 里的卡数据块并保留原始字节，后者只有文本、卡面要另找。
 * 卡面字节决定导出时能不能"逐字节写回"，所以两条路不能合并。
 *
 * 踩过的坑
 * `openCardInfo` 只有 6 行，本来想内联进调用点。但它同时被顶栏和
 * 右键菜单调用，内联会变成两份"打开卡信息框"的代码。
 */

import type { GreetingFormatParams, UnifiedCard, WorldbookFormatParams } from '@tcs/shared';

import type { CardSession } from '../session/card-session';
import type { CardInfoDialog } from '../settings/card-info-dialog';
import type { ExportDialog } from '../export/export-dialog';
import type { ImportDialog } from './import-dialog';

import { parseStCard } from '@tcs/shared';

import { pickCardFile, readBinaryFile, readTextExact } from '../contract';
import { generateCardId, readCardIdFromCard } from '../session/card-id';
import { effectiveCardsDir } from '../session/cards-dir';
import { decideOpenTarget } from '../session/open-target';
import { decodeBinaryFile, inspectPng, toPngSource } from '../session/png-source';
import { confirmOverwrite } from './dialogs';
import { describeError } from './error-text';
import { deriveCardNameFromFile } from './open-name';

/**
 * 功能
 * 本模块能碰的编辑器状态与动作。
 *
 * 注意事项
 * 8 个字段里 3 个是对话框实例（懒建后复用）、2 个是 getter（卡与会话）、
 * 其余是标签与会话列表。
 *
 * 踩过的坑
 * 无。
 */
export interface OpenHost {
  /** 当前卡片 */
  readonly card: UnifiedCard;
  /** 当前会话。`hasSession` 为真时非空 */
  readonly session: CardSession | null;
  /** 有没有打开会话 */
  readonly hasSession: boolean;
  /** 全部会话 */
  readonly sessions: CardSession[];
  /** 当前激活的标签 id */
  readonly activeId: string | null;
  /** 当前世界书预设（导入文本时要按它的格式解析） */
  readonly worldbookPreset: { readonly format: WorldbookFormatParams };

  /** 卡信息框 */
  cardInfoDialog: CardInfoDialog | null;
  /** 导出框 */
  exportDialog: ExportDialog | null;
  /** 导入框 */
  importDialog: ImportDialog | null;

  setStatus(message: string, kind: 'info' | 'ok' | 'warn' | 'bad'): void;
  /** 从纯文本建一个会话 */
  openTextCard(fileName: string, text: string, dir: string): Promise<void>;
  /** 把卡载入当前会话（返回处理后的卡） */
  arriveCard(card: UnifiedCard): UnifiedCard;
  /** 切到某个会话 */
  activateSession(id: string): void;
  /** 替换当前会话的卡 */
  replaceCard(card: UnifiedCard): void;
  /** 按卡重铺板块 */
  reloadBlocksFromCard(): void;
  /** 排一次校验 */
  scheduleValidate(delayMs?: number): void;
  /** 从文件建会话 */
  createSessionFromFile(path: string): string;
  /** 用卡建会话 */
  createSessionWithCard(card: UnifiedCard, cardId: string): string;
  /** 开场白格式（导出参数） */
  greetingFormat(): { format: GreetingFormatParams };
  /** 对话示例格式（导出参数） */
  chatExamplesFormat(): GreetingFormatParams;
}

export function openCardInfo(host: OpenHost): void {
  if (!host.hasSession) {
    host.setStatus('先打开或新建一张卡', 'warn');
    return;
  }
  host.cardInfoDialog?.open();
}

export async function openCard(host: OpenHost): Promise<void> {
  try {
    const dir = await effectiveCardsDir();
    // T10.9：过滤器放开 .txt —— TXT 角色卡**没有 JSON 信封**，整篇按当前预设切板块
    // v0.1.4 / T12.4：再放开 .png —— SillyTavern 的 PNG 卡
    const path = await pickCardFile(dir === '' ? undefined : dir, { allowText: true });
    if (!path) return;

    /*
     * PNG 必须在**读文本之前**分流。
     *
     * `readTextExact` 对 PNG 会报 `NOT_UTF8`（那是它的正确行为）——
     * 若把它当"打开失败"报给用户，一张正常的 PNG 卡就变成了"文件有问题"。
     */
    if (/\.png$/i.test(path)) {
      await openPngCard(host, path, dir);
      return;
    }

    const file = await readTextExact(path);

    // 按扩展名分流，而不是「先试 JSON、失败再退回 TXT」：后者会把一个语法错误的
    // JSON 悄悄当成纯文本再解析一次，用户看到的是一份莫名其妙的板块缺失列表，
    // 而真正的原因（JSON 少了个逗号）被完全掩盖。
    //
    // ★ TXT 走 `openTextCard`（2026-11-17）：它自己判"同名覆盖 / 异名新建"，
    //   因为 TXT 的卡名只能从文件名推，判定必须在读文本之后、建会话之前做。
    if (/\.txt$/i.test(path)) {
      await host.openTextCard(file.pathDisplay ?? path, file.text, dir);
      return;
    }

    const parsed = parseStCard(file.text, {
      greetingFormat: host.greetingFormat().format,
      chatExamplesFormat: host.chatExamplesFormat(),
      worldbookFormat: host.worldbookPreset.format,
    });
    /*
     * ★ 同名覆盖 / 异名新建（2026-11-17）。以前这里无条件 `replaceCard`，
     *   于是"打开一张新卡"＝悄悄丢弃当前卡的内容。
     */
    const placed = await openArrivedCard(host, parsed.card, path);
    // 用户在覆盖确认里选了取消：什么都不做（连 PNG 来源都不动）
    if (placed.mode === 'cancelled') return;
    /*
     * 打开了 JSON 卡 ⇒ 这张卡的原图来源失效。
     *
     * 不清的话，用户在 A 卡（PNG 导入）的会话里又打开了一个 JSON 卡，
     * 导出 PNG 时"原图"候选还是 A 那张 —— 等于把别人的封面安到这张卡上。
     */
    host.session!.setPngSource(null);
    // 打开的文件不在 cardsDir 里时说一句：用户会以为"打开过的卡都在那个目录"
    const outside = dir !== '' && !path.toLowerCase().startsWith(dir.toLowerCase());
    host.setStatus(
      `${placed.mode === 'created' ? `已新建「${placed.name}」并打开` : `已覆盖同名卡「${placed.name}」`}：` +
        `${file.pathDisplay ?? '(非 UTF-8 路径)'}（${file.bytesLen} 字节）` +
        (outside ? ` —— 该文件不在卡片目录内，另存时会回到 ${dir}` : ''),
      outside ? 'warn' : placed.mode === 'created' ? 'ok' : 'info',
    );
  } catch (error) {
    host.setStatus(`打开失败：${describeError(error)}`, 'bad');
  }
}

export async function openPngCard(host: OpenHost, path: string, cardsDir: string): Promise<void> {
  const binary = await readBinaryFile(path);
  const { bytes, digestVerified } = await decodeBinaryFile(binary);
  const display = binary.pathDisplay ?? '(非 UTF-8 路径)';

  if (!digestVerified) {
    // 不阻断：可能是环境没有 subtle，也可能真的坏了。后面 CRC 会再判一次。
    host.setStatus(`警告：${display} 的字节摘要与读取结果不一致，可能已损坏`, 'warn');
  }

  const inspected = inspectPng(bytes);

  if (inspected.kind === 'bare') {
    // 没有卡数据：当作封面图，不当作失败的导入
    const created = host.hasSession
      ? null
      : host.createSessionFromFile(path.replace(/\.png$/i, '.json'));
    host.session!.setPngSource(toPngSource(bytes, binary.pathDisplay, 'chara'));
    const size = `${String(inspected.note)}`;
    host.setStatus(
      created === null
        ? `已把 ${display} 设为当前卡的封面（${size}）`
        : `已新建「${created}」并把 ${display} 设为封面（${size}）`,
      'info',
    );
    // 封面只能在导出时体现，界面需要重画一次候选列表
    host.exportDialog?.refreshFaceChoices();
    return;
  }

  const parsed = parseStCard(inspected.jsonText, {
    greetingFormat: host.greetingFormat().format,
    chatExamplesFormat: host.chatExamplesFormat(),
    worldbookFormat: host.worldbookPreset.format,
  });
  /* 同名覆盖 / 异名新建（2026-11-17）—— 与 JSON、TXT 同一条规则 */
  const placed = await openArrivedCard(host, parsed.card, path);
  if (placed.mode === 'cancelled') return;
  /*
   * 记住原图（D4）。注意存的是**完整字节**（含数据块）：导出时
   * `buildPngCard` 会剥掉旧块再写新卡，所以"复用原图"不会把旧内容留在图里。
   *
   * `openArrivedCard` 可能已经切到另一个标签，所以这里读的 `host.session`
   * 是切过之后的那一个 —— 正是刚写入这张卡的那个，符合预期。
   */
  host.session!.setPngSource(toPngSource(bytes, binary.pathDisplay, inspected.keyword));
  host.exportDialog?.refreshFaceChoices();

  const spec = inspected.keyword === 'ccv3' ? 'V3' : 'V2';
  const outside = cardsDir !== '' && !path.toLowerCase().startsWith(cardsDir.toLowerCase());
  const tail = outside ? ` —— 该文件不在卡片目录内，另存时会回到 ${cardsDir}` : '';
  host.setStatus(
    `${placed.mode === 'created' ? `已新建「${placed.name}」并打开` : `已覆盖同名卡「${placed.name}」`} PNG 卡：` +
      `${display}（${spec} 数据块 · ${String(binary.bytesLen)} 字节）${tail}`,
    outside ? 'warn' : placed.mode === 'created' ? 'ok' : 'info',
  );
}

export async function openArrivedCard(host: OpenHost, 
  card: UnifiedCard,
  fallbackName: string,
): Promise<{ mode: 'replaced' | 'created' | 'cancelled'; name: string }> {
  const incomingName = (card.meta.name ?? '').trim();
  const target = decideOpenTarget({
    incomingName,
    openSessions: host.sessions.map((item) => ({ id: item.id, name: item.card.meta.name })),
    activeId: host.hasSession ? host.activeId : null,
  });

  if (target.kind === 'replace') {
    /*
     * 目标标签有未保存修改 → 先问（只有这条路径会静默丢内容，
     * TXT 那条有导入对话框兜底，不必二次确认）。
     */
    const victim = host.sessions.find((item) => item.id === target.sessionId);
    if (victim !== undefined && victim.dirty && !(await confirmOverwrite(target.name))) {
      return { mode: 'cancelled', name: target.name };
    }
    if (target.sessionId !== host.activeId) host.activateSession(target.sessionId);
    host.replaceCard(card);
    return { mode: 'replaced', name: target.name };
  }

  /*
   * 新建。名字优先用卡里的；没有就从文件名推，并**去重**——
   * 两个同名标签会让"覆盖哪一个"变得无法预期。
   */
  const name =
    incomingName !== ''
      ? incomingName
      : deriveCardNameFromFile(fallbackName, host.sessions.map((item) => item.card.meta.name));
  const named = incomingName !== '' ? card : { ...card, meta: { ...card.meta, name } };
  const created = host.createSessionWithCard(
    named,
    readCardIdFromCard(named) ?? generateCardId(name),
  );
  return { mode: 'created', name: created };
}

export async function importCardTextFile(host: OpenHost, 
  fileName: string,
  text: string,
  createdSession: string | null = null,
  autoConfirm = false,
  /** 追加在最终结论后面的说明（打开路径用它说清"覆盖了哪张卡 / 目录外"） */
  note = '',
): Promise<void> {
  if (!host.hasSession) {
    host.setStatus('先打开或新建一张卡，再导入 TXT（导入会替换当前卡的板块内容）', 'warn');
    return;
  }
  // 不 await：对话框要等用户点确认/取消。自动确认（截图与端到端用）时
  // 先让渲染跑一帧再点按钮 —— 否则 querySelector 拿到的还是上一轮隐藏的节点。
  const pending = host.importDialog?.openCardText(fileName, text);
  if (autoConfirm) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    document.querySelector<HTMLButtonElement>('[data-role="import-confirm"]')?.click();
  }
  const decision = await pending;
  if (!decision || !('card' in decision)) {
    // 用户取消：刚建的那张卡**留着**（它是用户点「打开…」的直接结果，
    // 而且里面还是空卡，没有需要回滚的内容）。状态栏说明这一点，避免"我点了取消
    // 怎么多了一张卡"的困惑。
    if (createdSession !== null) {
      host.setStatus(
        `已新建「${createdSession}」（空卡）；TXT 导入已取消，未写入任何内容${note}`,
        'info',
      );
    }
    return;
  }

  /*
   * TXT 导入是**第三条到达路径**：`import-flow` 交回来的已经是卡对象，
   * 不经过 `replaceCard`（那条路会 markSaved，而导入是"改当前卡"）。
   * 所以这里必须显式过一遍到达规范化 —— 否则"用自定义世界书预设导入
   * 一份标准写法的 TXT"仍然会报 no-entry-marker，正是缺陷一本身。
   */
  host.session!.replaceCard(host.arriveCard(decision.card));
  host.reloadBlocksFromCard();
  host.scheduleValidate(0);

  const prefix = createdSession === null ? `已导入 TXT：${fileName}` : `已新建「${createdSession}」并导入：${fileName}`;

  // 保全机制（v0.1.2 反馈项二）之后，导入结果的说明重心从"缺了几个板块"
  // 变成"多少原文被放到了哪里" —— 后者才是用户需要知道的事。
  // 措辞由 import-flow.preservedNoteOf 统一给出，对话框里显示的是同一句。
  if (decision.preservedNote !== '') {
    const tone = decision.preserved?.wholeText === true ? 'warn' : 'info';
    host.setStatus(`${prefix} —— ${decision.preservedNote}${note}`, tone);
    return;
  }
  host.setStatus(`${prefix}（原文全部识别，无未识别内容）${note}`, 'ok');
}