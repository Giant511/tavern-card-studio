/**
 * 功能
 * ST 内嵌面板的按需打开、推送到 ST 的产物构建，外加两个演示场景
 * （到达规范化前后、审计前后）。从 EditorApp 搬出，4 个函数 231 行。
 *
 * 注意事项
 * `ensureStPane` 是**懒建**：面板首次要用时才创建，之后复用。
 * 它是唯一允许给 `stPane` 赋值的地方 —— 别处直接 new 会出现两份面板，
 * 表现为"关掉一个还有一个"。
 *
 * `runArrivalDemo` / `runAuditDemo` 只在带 URL 参数启动时跑（取证用），
 * 和 preview-scenarios 一样属于"生产包不该含"的那一类。
 *
 * 踩过的坑
 * `buildStPushArtifact` 会同时用开场白格式与对话示例格式，
 * 两个参数名只差一个词（greeting / chatExamples），传错不报错但产物不对。
 */

import type { AuditReport, GreetingFormatParams, UnifiedCard } from '@tcs/shared';
import { parseStCard } from '@tcs/shared';

import {
  importPlatformText,
  importWorldbookPresetText,
} from './import-actions';
import {
  configGet,
  configPatch,
  isShellAvailable,
  probeCardsDir,
  probeTcp,
  scanCardsDir,
  stProxyStart,
  stProxyStatus,
  stProxyStop,
  writeBinaryFileAtomic,
} from '../contract';
import { buildExportAsync, checkWorldbookExportSafety } from '../export/export-card';
import { convertToPng } from '../export/face-convert.ts';
import { isPngBytes } from '@tcs/shared';
import { configNameDeps } from '../session/st-push-registry';
import { resolveSaveFace } from './save-actions';
import { isPaneWidthUsable } from '../session/st-pane-layout';
import { pushCardToSt } from '../session/st-push';
import { locateStCharactersDir } from './dialogs';
import { describeError } from './error-text';
import { expand, onBlockChange } from './block-actions';
import { switchPlatform } from './ui-refresh';
import type { CardSession } from '../session/card-session';
import type { CrashLogger } from '../diagnostics/crash-log';
import type { Ruleset } from './rules';
import { StPane } from '../session/st-pane';

/**
 * 取证用的"自定义写法"世界书预设（v0.1.6 / 缺陷一）。
 *
 * 与 `DEFAULT_WORLDBOOK_FORMAT`（`@@ENTRY` / `@@CONTENT` / `@@END`）是**两套完全
 * 不同的标记**，这正是现场的分叉来源：卡里的世界书是按标准写法存的，而用户
 * 把预设换成了这种写法 ⇒ 旧代码渲染用前者、解析用后者，一个标记都认不出来。
 *
 * 放在源码里而不是夹具文件里：它只是一套**格式参数**，不含任何用户内容。
 */
export const ARRIVAL_DEMO_PRESET = {
  schemaVersion: 1,
  id: 'demo-custom-worldbook',
  name: '自定义写法示例',
  version: '1.0.0',
  format: {
    entryOpen: '【条目{id}：',
    entryClose: '【条目{id}结束】',
    contentMark: '内容：',
    fieldPrefix: '',
    entrySeparator: '\n\n',
    listSeparator: ', ',
    idPrefix: '条目',
  },
};


/**
 * 功能
 * 本模块能碰的编辑器状态与动作。
 *
 * 注意事项
 * `stPane` 可写（懒建）；`report` 只读（审计演示要看它有没有内容）。
 *
 * 踩过的坑
 * 无。
 */
export interface StPushHost {
  /** 当前卡片 */
  readonly card: UnifiedCard;
  /** 全部板块运行时（演示要判展开状态） */
  readonly blocks: readonly import('./block-runtime').BlockRuntime[];
  /** 当前会话 */
  readonly session: CardSession | null;
  /** 有没有打开会话 */
  readonly hasSession: boolean;
  /** 规则集 */
  readonly rules: Ruleset | null;
  /** 当前世界书预设 */
  readonly worldbookPreset: import('@tcs/shared').WorldbookPreset;
  /** 崩溃日志器（演示里也记） */
  readonly crashLogger: CrashLogger | null;
  /** 上次审计报告 */
  readonly report: AuditReport | null;
  /** 取证模式：演示不落盘。演示会临时置位再恢复 */
  demoQuiet: boolean;

  /** ST 内嵌面板。null = 还没建 */
  stPane: StPane | null;

  setStatus(message: string, kind: 'info' | 'ok' | 'warn' | 'bad'): void;
  /** 打开 ST 面板（弹「连不上」提示的那条路） */
  openStDialog(): Promise<void>;
  /** 会话摘要（崩溃日志与诊断用） */
  sessionSummary(): { openCards: number; activeCardId: string | null };
  /** 开场白格式 */
  greetingFormat(): { format: GreetingFormatParams };
  /** 对话示例格式 */
  chatExamplesFormat(): GreetingFormatParams;
  /** 选中某个世界书预设 */
  selectWorldbookPreset(id: string): void;
  /** 保存模块的接入点（演示要落盘） */
  saveHost(): import('./save-actions').SaveHost;
  /** 板块模块的接入点 */
  blockHost(): import('./block-actions').BlockHost;
  /** 导入模块的接入点 */
  importHost(): import('./import-actions').ImportHost;
  /** 刷新模块的接入点 */
  refreshHost(): import('./ui-refresh').RefreshHost;
  /** 按卡重铺板块 */
  reloadBlocksFromCard(): void;
  /** 替换当前卡 */
  replaceCard(card: UnifiedCard): void;
  /** 立刻校验 */
  validate(): void;
}

export async function runArrivalDemo(host: StPushHost, kind: 'before' | 'after'): Promise<void> {
  try {
    const response = await fetch('arrival/standard-card.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`取不到内置卡片（服务返回 ${String(response.status)}）`);
    const raw = await response.json();

    // 1. 导入一份"自定义写法"的世界书预设并切到它 —— 现场的前提条件
    host.demoQuiet = true;
    const outcome = importWorldbookPresetText(host.importHost(), JSON.stringify(ARRIVAL_DEMO_PRESET));
    if (!outcome.ok) throw new Error(`世界书预设导入失败：${outcome.issues[0]?.message ?? ''}`);
    if (outcome.id) host.selectWorldbookPreset(outcome.id);
    host.demoQuiet = false;

    // 2. 解析这张卡：before 不给格式（旧行为），after 给当前预设（现行）
    const parsed =
      kind === 'before'
        ? /* no-worldbook */ parseStCard(raw as unknown, {
            greetingFormat: host.greetingFormat().format,
            chatExamplesFormat: host.chatExamplesFormat(),
          })
        : parseStCard(raw as unknown, {
            greetingFormat: host.greetingFormat().format,
            chatExamplesFormat: host.chatExamplesFormat(),
            worldbookFormat: host.worldbookPreset.format,
          });

    // 3. 落地：before 直接进会话（跳过去达规范化），after 走真实入口
    if (kind === 'before') {
      host.session!.replaceCard(parsed.card);
      host.session!.markSaved(host.session!.filePath);
      host.reloadBlocksFromCard();
    } else {
      host.replaceCard(parsed.card);
    }
    host.validate();

    const runtime = host.blocks.find((item) => item.snapshot.id === 'worldbook');
    if (runtime !== undefined) expand(host.blockHost(), runtime, true);

    const report = host.report;
    const worldbookIssues =
      report?.issues.filter((issue) => issue.location.blockId === 'worldbook') ?? [];
    const errors = worldbookIssues.filter((issue) => issue.severity === 'error').length;
    host.setStatus(
      `对比（${kind === 'before' ? '修复前' : '修复后'}）` +
        ` · 世界书错误 ${String(errors)} 条 · 条目 ${String(host.session!.card.worldbook.entries.length)} 条` +
        ` · 文本 ${String(host.session!.card.worldbook.text.length)} 字` +
        ` · 当前预设「${host.worldbookPreset.name}」`,
      errors > 0 ? 'bad' : 'ok',
    );
  } catch (error) {
    host.demoQuiet = false;
    host.setStatus(`对比检查失败：${describeError(error)}`, 'bad');
  }
}

export async function runAuditDemo(host: StPushHost, kind: 'before' | 'after'): Promise<void> {
  try {
    const response = await fetch(`g7/${kind}.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`取不到夹具（HTTP ${String(response.status)}）`);
    const demo = (await response.json()) as {
      label: string;
      worldbookText: string;
      worldbookPreset: { id: string; name: string };
      platformRule: { id: string; name: string };
    };

    host.demoQuiet = true;
    const wbOutcome = importWorldbookPresetText(host.importHost(), JSON.stringify(demo.worldbookPreset));
    if (!wbOutcome.ok) throw new Error(`世界书预设导入失败：${wbOutcome.issues[0]?.message ?? ''}`);
    if (wbOutcome.id) host.selectWorldbookPreset(wbOutcome.id);

    const ruleOutcome = importPlatformText(host.importHost(), JSON.stringify(demo.platformRule));
    if (!ruleOutcome.ok) throw new Error(`平台规则导入失败：${ruleOutcome.issues[0]?.message ?? ''}`);
    if (ruleOutcome.id) switchPlatform(host.refreshHost(), ruleOutcome.id);
    host.demoQuiet = false;

    const runtime = host.blocks.find((item) => item.snapshot.id === 'worldbook');
    if (runtime === undefined) throw new Error('世界书面板还没建起来');
    onBlockChange(host.blockHost(), runtime, demo.worldbookText);
    /*
     * 必须重建一次板块视图再展开。
     *
     * `onBlockChange` 只更新 `runtime.snapshot` 与会话，**不会**把新文本推给
     * 已经存在的编辑器实例（BlockEditor 没有 setText）。所以先 expand 再改文本时，
     * 面板上仍是旧内容 —— 而审计用的是会话里的新内容，于是截图会出现
     * "面板显示 A、数字算的是 B"这种最误导人的组合。
     */
    host.reloadBlocksFromCard();
    const rebuilt = host.blocks.find((item) => item.snapshot.id === 'worldbook');
    if (rebuilt !== undefined) expand(host.blockHost(), rebuilt, true);
    host.validate();

    const report = host.report;
    const wb = host.session!.card.worldbook;
    host.setStatus(
      `检查结果（${demo.label}）：错误 ${String(report?.summary.error ?? 0)} · ` +
        `警告 ${String(report?.summary.warning ?? 0)} · 提示 ${String(report?.summary.info ?? 0)}` +
        ` · 世界书域 ${String(report?.issues.filter((i) => i.location.blockId === 'worldbook').length ?? 0)} 条` +
        ` · 世界书文本 ${String(wb.text.length)} 字 / 条目 ${String(wb.entries.length)} 条`,
      'info',
    );
  } catch (error) {
    host.demoQuiet = false;
    host.setStatus(`检查失败：${describeError(error)}`, 'bad');
  }
}

export function ensureStPane(host: StPushHost): StPane {
  if (host.stPane !== null) return host.stPane;

  const pane = new StPane({
    /*
     * 地址只来自壳。**不**在这里拼 `http://127.0.0.1:…`：
     * 拼错的后果不是"打不开"，而是"这扇窗指向了别处"。
     */
    startProxy: async () => {
      const info = await stProxyStart();
      return { baseUrl: info.baseUrl, target: info.target, port: info.port };
    },
    // 端口要传下去：迟到的停止请求不该杀掉后来新起的代理（缺陷二）
    stopProxy: (port) => stProxyStop(port),
    /*
     * 代理存活判据走壳侧 TCP 探测（`probe_tcp`），**不用 iframe 的 onerror**：
     * 跨源 iframe 在连不上时不保证触发 error 事件，也拿不到原因；
     * 而同进程探测回环端口不受系统代理干扰（F15 的结论）。
     */
    probePort: async (port) => {
      const probe = await probeTcp('127.0.0.1', port);
      return probe.alive;
    },
    /*
     * 决定性诊断（v0.1.6 真机缺陷二）：问壳"代理端口进来过几条连接"。
     * 0 条 ⇒ 请求从未离开浏览器网络层（环境拦了回环），壳内修不了。
     */
    queryProxyStats: async () => {
      const status = await stProxyStatus();
      return {
        alive: status.running && status.alive,
        accepted: status.stats.accepted,
        probeHits: status.stats.probeHits,
      };
    },
    logError: (line) => host.crashLogger?.record('error', new Error(line), host.sessionSummary()),
    loadWidth: async () => {
      const config = await configGet();
      const width = config.stPaneWidth;
      return isPaneWidthUsable(width) ? width : null;
    },
    saveWidth: async (width) => {
      await configPatch({ stPaneWidth: width });
    },
    push: async () => {
      const located = await locateStCharactersDir();
      if ('error' in located) return { error: located.error };
      const outcome = await pushCardToSt({
        charactersDir: located.dir,
        cardName: host.session!.card.meta.name,
        cardId: host.session!.cardId,
        build: () => buildStPushArtifact(host, ),
        deps: {
          probeDir: (dir, options) => probeCardsDir(dir, options),
          scanDir: (dir, limit, extensions) => scanCardsDir(dir, limit, extensions),
          writeBinary: (path, base64, sha256) => writeBinaryFileAtomic(path, base64, sha256),
          ...configNameDeps,
        },
      });
      if (!outcome.ok) return { error: outcome.reason };
      if (outcome.nameNote !== '') host.setStatus(outcome.nameNote, 'warn');
      if (outcome.staleNote !== '') host.setStatus(outcome.staleNote, 'info');
      // 带上 isUpdate：面板据此说「已更新」还是「已推送」（v0.1.7 修订一）
      return { fileName: outcome.fileName, isUpdate: outcome.isUpdate };
    },
    notify: (message, kind) => host.setStatus(message, kind ?? 'info'),
    hasCard: () => host.hasSession,
    openWizard: () => void host.openStDialog(),
    hasShell: () => isShellAvailable(),
  });

  const layout = document.querySelector('.layout');
  if (layout instanceof HTMLElement) pane.mount(layout);
  void pane.restoreWidth();
  host.stPane = pane;
  return pane;
}

export async function buildStPushArtifact(host: StPushHost): Promise<{
  bytes: Uint8Array;
  sha256: string;
  fileName: string;
  face: { from: 'source' | 'library' | 'default'; fileName: string | null; note: string };
} | null> {
  const reasons = checkWorldbookExportSafety(host.card, host.worldbookPreset.format);
  if (reasons.length > 0) {
    host.setStatus(`推送已阻止：${reasons[0] ?? ''}`, 'bad');
    return null;
  }

  const face = await resolveSaveFace(host.saveHost());
  if (face === null) {
    // 浏览器里读不到任何卡面（readDefaultFace 走 IPC）—— PNG 卡必须有图
    host.setStatus('推送需要一个卡面，但当前环境读不到（浏览器模式请用桌面客户端）', 'bad');
    return null;
  }

  const preset = host.rules?.preset ?? null;
  /*
   * 最后一公里防线：`buildPngCard` 只接受 PNG 容器。
   *
   * `resolveSaveFace()` 正常路径已经保证是 PNG（非 PNG 会走 `convertToPng`），
   * 但 2026-10-29 的现场是：取回一侧把仓库的 WebP 直接塞进了 `pngSource`，
   * 于是异常从这条链路最深处抛出来，而那里没人 catch ——
   * 用户看到的是"点推送没反应"。
   *
   * 所以这里再挡一次。它不是重复校验，是**把失败变成一个可读的提示**：
   * 宁可多转一次码，也不要让用户对着一个毫无反应的按钮猜。
   */
  let faceBytes = face.bytes;
  if (!isPngBytes(faceBytes)) {
    faceBytes = (await convertToPng(faceBytes, 'face.webp')).bytes;
  }

  const artifact = await buildExportAsync(
    host.card,
    preset,
    'png',
    host.greetingFormat().format,
    faceBytes,
    host.chatExamplesFormat(),
  );
  if (artifact.format !== 'png') throw new Error('内部错误：PNG 推送拿到了文本产物');
  return {
    bytes: artifact.png,
    sha256: artifact.sha256,
    fileName: artifact.fileName,
    face: { from: face.from, fileName: face.fileName, note: face.note },
  };
}