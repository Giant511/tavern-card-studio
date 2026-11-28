/**
 * 功能
 * "外部内容落进当前卡"的三条路：到达规范化、应用远端文本、取回服务端卡面。
 * 从 EditorApp 搬出，3 个函数 131 行。
 *
 * 注意事项
 * `arriveCard` 是**到达规范化的唯一入口** —— 打开卡、导入 TXT、从服务端
 * 取回版本、回滚，四条路都必须过它。绕过就等于"用自定义世界书预设导入
 * 标准写法的 TXT 仍然报 no-entry-marker"（§159 那个缺陷）。
 *
 * `applyRemoteText` 只改内容，不动标签与会话 id：它是"覆盖当前卡"，
 * 不是"打开一张新卡"。两者混起来会让服务端历史分叉。
 *
 * 踩过的坑
 * `pullFaceFromServer` 是 fire-and-forget 的：内容已经载入成功了，
 * 卡面失败不该把整次操作判失败（用户看到的画面已经对了，图只在推 ST/导出时用）。
 */

import type { GreetingFormatParams, UnifiedCard, WorldbookFormatParams } from '@tcs/shared';
import { normalizeOnArrival, parseStCard } from '@tcs/shared';

import type { CardSession } from '../session/card-session';
import type { SyncConfig } from '../sync/server-sync';

import { convertToPng } from '../export/face-convert.ts';
import { toPngSource } from '../session/png-source';
import { fetchFace } from '../sync/server-sync';
import { planRemoteApply } from '../sync/remote-apply';
import { isPngBytes } from '@tcs/shared';

/**
 * 功能
 * 本模块能碰的编辑器状态与动作。
 *
 * 注意事项
 * `session` 与 `sessions` 都要：前者是当前卡，后者用来找"这张卡在哪个标签"。
 *
 * 踩过的坑
 * 无。
 */
export interface LandingHost {
  /** 当前会话 */
  readonly session: CardSession | null;
  /** 有没有打开会话 */
  readonly hasSession: boolean;
  /** 全部会话 */
  readonly sessions: CardSession[];
  /** 当前世界书预设（解析远端文本时按它的格式） */
  readonly worldbookPreset: { readonly format: WorldbookFormatParams };

  setStatus(message: string, kind: 'info' | 'ok' | 'warn' | 'bad'): void;
  /** 替换当前会话的卡 */
  replaceCard(card: UnifiedCard): void;
  /** 用卡建会话，返回新会话 id */
  createSessionWithCard(card: UnifiedCard, cardId: string): string;
  /** 当前同步配置 */
  currentSyncConfig(): SyncConfig | null;
  /** 开场白格式 */
  greetingFormat(): { format: GreetingFormatParams };
  /** 对话示例格式 */
  chatExamplesFormat(): GreetingFormatParams;
}

export async function pullFaceFromServer(host: LandingHost, cardId: string): Promise<void> {
  if (cardId === '') return;
  const config = host.currentSyncConfig();
  if (config === null) return;
  try {
    const face = await fetchFace(config, cardId);
    if (face === null) return;
    if (!host.hasSession) return;
    /*
     * keyword 固定给 'chara'：这里拿到的是**纯图**（服务端不收卡数据块），
     * 它本身没有 keyword 概念；真正写进 PNG 时由导出链路按目标 spec 决定，
     * 这个字段只在"保持原 spec"那条路上被读。
     */
    /*
     * **必须先转成 PNG 容器**（v0.1.7 增补二之后）。
     *
     * 仓库卡面资产是 WebP（250KB 红线逼出来的），而 `pngSource` 的下游
     * —— `buildPngCard` / 导出 / 推 ST —— 全都要求 PNG。
     * 直接塞 WebP 的后果实测过：点推送抛
     * `PngCardError: 不是 PNG 文件（文件签名不匹配）`，且那条链路没人 catch，
     * 用户看到的是"点推送没反应"。
     *
     * 判据用**字节签名**而不是 MIME：MIME 来自 HTTP 头，可能是错的；
     * 签名是内容本身。非 PNG 才转码，PNG 走原路（零重编码，决策 D1）。
     */
    let faceBytes = face.bytes;
    if (!isPngBytes(faceBytes)) {
      const converted = await convertToPng(faceBytes, 'face.webp');
      faceBytes = converted.bytes;
    }
    host.session!.setPngSource(toPngSource(faceBytes, null, 'chara'));
    host.session!.noteFaceUploaded(face.sha256 === '' ? null : face.sha256);
  } catch {
    // 拉卡面失败静默：内容已经载入，图只是可选资产
  }
}

export function applyRemoteText(host: LandingHost, 
  text: string,
  displaySeq: number,
  remoteSeq: number = displaySeq,
  context?: { cardId: string; mode: 'restore' | 'rollback' },
): void {
  try {
    const parsed = parseStCard(JSON.parse(text) as unknown, {
      greetingFormat: host.greetingFormat().format,
      /* 对话示例的说话人写法也按当前预设渲染（2026-11-11） */
      chatExamplesFormat: host.chatExamplesFormat(),
      /*
       * 世界书必须按**当前激活预设**渲染（v0.1.6 缺陷一）。
       * 不传的话这里会用内置默认格式渲染文本，而审计用当前预设解析 ——
       * 两套格式分叉就是现场那条 `worldbook-no-entry-marker` 的来源。
       */
      worldbookFormat: host.worldbookPreset.format,
    });

    /*
     * 零标签（v0.1.3 追加项三）：不再报"请先打开卡片"，而是**自动建一张卡**。
     *
     * 决策全部在 `planRemoteApply` 里（纯函数、有单测），这里只负责落地：
     *   · `create` → 走 `createSessionWithCard`（与「打开…」同一条建卡路径），
     *     cardId 用服务端那个，于是下一次上传是追加版本而不是新建卡；
     *   · `replace` → 既有行为，一字未改。
     *
     * 没有 context 时（旧调用方/截图入口）按"有标签替换"处理 —— 那种情况下
     * 本来就一定有会话，否则旧代码会抛错。
     */
    const plan = planRemoteApply({
      hasSession: host.hasSession,
      mode: context?.mode ?? 'restore',
      serverCardId: context?.cardId ?? (host.hasSession ? host.session!.cardId : ''),
      targetSeq: displaySeq,
      remoteSeq,
      cardName: parsed.card.meta.name,
      existingNames: host.sessions.map((item) => item.card.meta.name),
    });

    if (plan.action === 'create') {
      if (plan.newSessionName !== null) {
        // 名字已在 plan 里去重；卡片本身的 meta.name 也要跟着改，
        // 否则标签栏显示"卡片 (2)"、导出文件里还是原名。
        const renamed = { ...parsed.card, meta: { ...parsed.card.meta, name: plan.newSessionName } };
        host.createSessionWithCard(renamed, plan.cardId);
      }
      host.session!.noteRemoteVersion(plan.cardId, plan.baseSeq);
    } else {
      host.replaceCard(parsed.card);
      host.session!.noteRemoteVersion(host.session!.cardId, plan.baseSeq);
    }

    host.setStatus(plan.status, plan.action === 'create' ? 'ok' : 'warn');

    /*
     * 卡面（v0.1.7 修订二）：取回/回滚时把服务端那份封面也收下来。
     *
     * fire-and-forget：内容已经载入成功了，卡面失败不该把这次操作判失败
     * （而且用户看到的画面已经是对的 —— 编辑不需要图，图只在推 ST/导出时用）。
     */
    void pullFaceFromServer(host, plan.cardId);
  } catch (error) {
    host.setStatus(
      `载入服务端版本失败：${error instanceof Error ? error.message : String(error)}`,
      'bad',
    );
  }
}

export function arriveCard(host: LandingHost, card: UnifiedCard): UnifiedCard {
  const result = normalizeOnArrival(card, {
    worldbook: host.worldbookPreset.format,
    greeting: host.greetingFormat().format,
    /*
     * ★ 对话示例的说话人写法必须一起给（2026-11-17）。
     *
     * 少了这一项，`refreshFieldBlockViews` 会拿初始场景的格式去重算
     * 「对话示例」板块 —— 那套格式没有 `user`/`char` 映射，于是
     * `renderChatExamples` 原样返回，**把导入时刚渲染好的 `用户：`
     * 刷回 `{{user}}:`**。导入那一步永远看起来是对的，所以极难归因。
     */
    chatExamples: host.chatExamplesFormat(),
  });

  /*
   * "格式不匹配"与"解析不出"是两种状态，措辞必须分开：
   *   · 前者是 info —— 用户没做错任何事，卡是好的，只是写法不同；
   *   · 后者是 bad —— 真的解析不出，导出会被硬闸门挡住。
   * 把前者报成错误，就是现场这次"一张正常卡看起来坏了"。
   */
  const firstFailure = result.failures[0];
  if (firstFailure !== undefined) {
    host.setStatus(firstFailure.message, 'bad');
  } else if (result.notes.length > 0) {
    host.setStatus(result.notes.join('；'), 'info');
  }
  return result.card;
}