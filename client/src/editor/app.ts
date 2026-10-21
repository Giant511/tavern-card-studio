/**
 * 六板块编辑器（T6.1）+ 审计面板（T6.5）。
 *
 * 结构：
 *   顶栏（卡片名 / 统计 / 文件操作 / 连接状态 / 设置）
 *   同步条（可用性由服务端连接决定，与本地编辑解耦）
 *   ├ 左：六个板块（折叠面板，折叠时销毁编辑器 → 隐藏块不进 DOM）
 *   └ 右：审计面板（过滤 / 分组 / 字数分布；点击问题定位到板块内偏移）
 *
 * 依赖方向：本文件只 import `../contract`（原生能力）与 `@tcs/shared`（纯逻辑），
 * 不直接碰 `@tauri-apps/*`，也不自己拼卡片字符串。
 */

import {
  applyPresetPlan,
  buildAuditReport,
  compileHighlightRule,
  createEmptyCard,
  parseStCard,
  resolveHighlightRule,
  resolvePlatformRule,
  type AuditIssue,
  type PresetApplyPlan,
  type TxtPreset,
  type AuditReport,
  type BlockId,
  type UnifiedCard,
} from '@tcs/shared';

import {
  configGet,
  isShellAvailable,
  pickCardFile,
  pickSavePath,
  readTextExact,
  writeFileAtomic,
  type ShellError,
} from '../contract';

import {
  collectBlocks,
  importCardText,
  serializeCard,
  setBlockText,
  totalLength,
  type EditorBlockSnapshot,
} from './block-doc';
import { BlockEditor, type EditorIssue } from './block-editor';
import { applySchemeStyles, buildPreviewFragment } from './highlight';
import {
  buildRuleset,
  DEFAULT_HIGHLIGHT_ID,
  DEFAULT_PLATFORM_ID,
  type Ruleset,
} from './rules';
import { AuditPanel } from '../audit/audit-panel';
import {
  RulesDialog,
  type DialogState,
} from '../rules/rules-dialog';
import { importHighlightScheme, importPlatformRule } from '../rules/rule-library';
import {
  decideApplyPreset,
  describePresets,
  previewPresetSelection,
} from '../rules/preset-switch';
import { isSyncReady, probeServer, type ProbeResult } from '../net/server-probe';
import { ExportDialog } from '../export/export-dialog';
import { buildExportAsync } from '../export/export-card';
import { SyncDialog } from '../sync/sync-dialog';
import type { SyncConfig } from '../sync/server-sync';
import { SettingsDialog } from '../settings/settings-dialog';

import sampleCardJson from '../../../test/fixtures/sample-card.json';

// ── DOM 助手（typed + 无 innerHTML）────────────────────────────
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 DOM 节点 #${id}`);
  return node as T;
}

interface BlockRuntime {
  snapshot: EditorBlockSnapshot;
  section: HTMLElement;
  body: HTMLElement;
  host: HTMLElement;
  preview: HTMLElement;
  badge: HTMLElement;
  editor: BlockEditor | null;
  expanded: boolean;
  previewOn: boolean;
}

class EditorApp {
  private card: UnifiedCard;
  private rules: Ruleset | null = null;
  private blocks: BlockRuntime[] = [];
  private issues: readonly AuditIssue[] = [];
  private report: AuditReport | null = null;
  private auditPanel: AuditPanel | null = null;
  private rulesDialog: RulesDialog | null = null;
  private exportDialog: ExportDialog | null = null;
  private syncDialog: SyncDialog | null = null;
  /** 已关联的服务端卡片 id（上传/版本/回滚都针对它） */
  private syncCardId: string | null = null;
  /** 设置里保存的 token（同步请求要用；probeServer 的 url 不含 token） */
  private settingsToken = '';
  private validateTimer: number | null = null;
  private activeIssueId: string | null = null;

  private readonly toolbarStats = byId('stats');
  private readonly blockList = byId('block-list');
  private readonly issueSummary = byId('issue-summary');
  private readonly statusBar = byId('status');
  private settings: SettingsDialog | null = null;
  private connection: ProbeResult | null = null;
  /** 最近一次审计的等级计数（切规则后要给用户一句话结论） */
  private lastSummary = { error: 0, warning: 0, info: 0 };

  constructor(card: UnifiedCard) {
    this.card = card;
  }

  async start(): Promise<void> {
    this.setStatus('加载规则…');
    this.rules = await buildRuleset();
    // 配色来自高亮方案本体（规则资产），不写死在样式表里
    applySchemeStyles(this.rules.highlightFile);
    if (this.rules.warnings.length > 0) {
      this.setStatus(this.rules.warnings.join('；'), 'warn');
    } else {
      this.setStatus(
        `规则：平台 ${this.rules.platformId} · 高亮 ${this.rules.highlightId} · 预设 ${this.rules.preset?.id ?? '—'}` +
          `（来源：${Object.values(this.rules.sources).every((s) => s === 'shell') ? '壳资源目录' : '打包副本'}）`,
      );
    }

    this.blocks = collectBlocks(this.card).map((snapshot) => this.createBlock(snapshot));
    // 默认只展开前两块，其余折叠（懒渲染）。`?expand=all` 是给截图/联调用的调试开关。
    const expandAll = new URLSearchParams(location.search).get('expand') === 'all';
    for (const [index, runtime] of this.blocks.entries()) {
      if (expandAll || index < 2) this.expand(runtime, true);
    }

    this.refreshStats();
    // T6.5：审计面板在首次校验前就位，否则第一次报告会无处渲染
    this.auditPanel = new AuditPanel(
      {
        onLocate: (issue) => this.locateIssue(issue),
        onFocusBlock: (blockId) => {
          const runtime = this.blocks.find((block) => block.snapshot.id === blockId);
          if (runtime) this.expand(runtime, true);
        },
      },
      byId('audit-panel'),
    );
    this.wireToolbar();
    this.wireSettings();
    this.wireRules();
    this.wireExportAndSync();
    this.scheduleValidate(0);
  }

  // ── 规则与预设（T6.2 / T6.3）─────────────────────────────
  //
  // 语义要点：
  //   · 切换平台规则 → **立即重检**（阶段 3 定的「切换即重检」）；
  //   · 切换高亮方案 → 立即重新着色（配色来自方案本身）；
  //   · 选择预设 → 只改导出格式（标题/顺序），**原文不动**；
  //   · 应用预设 → 唯一重排入口，走 plan → 确认 → applyPresetPlan。
  /** 设置保存后重新读取 token，并重新探测（地址可能变了） */
  private async refreshTokenAfterSave(): Promise<void> {
    try {
      const config = await configGet();
      this.settingsToken = config.token;
      const result = await probeServer(config);
      this.applyConnection(result);
    } catch {
      // 浏览器模式读不到配置，忽略
    }
  }

  private wireRules(): void {
    const button = byId<HTMLButtonElement>('btn-rules');
    button.addEventListener('click', () => this.rulesDialog?.open());

    this.rulesDialog = new RulesDialog({
      getState: () => this.dialogState(),
      notify: (message, kind) => this.setStatus(message, kind ?? 'info'),

      onPlatformChange: (id) => this.switchPlatform(id),
      onHighlightChange: (id) => this.switchHighlight(id),
      onPresetSelect: (id) => {
        this.selectPresetById(id);
        this.refreshRulesLabel();
      },
      onPresetApply: (presetId, plan) => {
        const preset = this.rules?.presets.find((item) => item.id === presetId);
        if (!preset) {
          this.setStatus(`预设「${presetId}」不存在`, 'bad');
          return;
        }
        this.commitPresetApply(preset, plan);
      },

      importPlatformText: (text) => this.importPlatformText(text),
      importHighlightText: (text) => this.importHighlightText(text),

      exportPlatformRule: (id) => this.rules?.platformSourceText[id] ?? null,
      exportHighlightScheme: (id) => this.rules?.highlightSourceText[id] ?? null,
    });
  }

  // ── 导出与同步（T6.6 / T6.7）──────────────────────────────
  private wireExportAndSync(): void {
    this.exportDialog = new ExportDialog({
      getState: () => ({
        card: this.card,
        report: this.report,
        preset: this.rules?.preset ?? null,
      }),
      // 导出前强制重算：不能用过期报告放行
      revalidate: () => {
        this.validate();
        return this.report;
      },
      notify: (message, kind) => this.setStatus(message, kind ?? 'info'),
      onExported: () => {
        // 导出成功后不自动上传（避免误操作）；用户可在同步面板手动上传
      },
    });

    this.syncDialog = new SyncDialog({
      getConnection: () => this.connection,
      getConfig: () => this.currentSyncConfig(),
      // 上传内容与「导出 JSON」同一份，保证服务端字节与本地可复现
      getPayload: () => {
        const preset = this.rules?.preset ?? null;
        return buildExportAsync(this.card, preset, 'json').then((artifact) => artifact.text);
      },
      getCurrentCardId: () => this.syncCardId,
      setCurrentCardId: (id) => {
        this.syncCardId = id;
      },
      onRollbackApplied: (text, version) => {
        this.applyRemoteText(text, version.seq);
      },
      notify: (message, kind) => this.setStatus(message, kind ?? 'info'),
    });

    byId<HTMLButtonElement>('btn-export').addEventListener('click', () => {
      this.exportDialog?.open('json');
    });
  }

  /** 当前同步配置：连接通过时才返回（未就绪不构造请求参数） */
  private currentSyncConfig(): SyncConfig | null {
    const connection = this.connection;
    if (!connection || !connection.url) return null;
    if (!isSyncReady(connection)) return null;
    return { serverUrl: connection.url, token: this.settingsToken ?? '' };
  }

  /**
   * 把服务端版本内容载入编辑器。
   *
   * 走 `parseStCard` 而不是直接替换文本：必须经过同一套解析，
   * 否则 anchor / worldbook 结构会与本地不一致，后续编辑就会写错位置。
   */
  private applyRemoteText(text: string, seq: number): void {
    try {
      const parsed = parseStCard(JSON.parse(text) as unknown);
      this.replaceCard(parsed.card);
      this.setStatus(`已载入服务端 v${seq} 的内容（原文件未自动保存，建议另存）`, 'warn');
    } catch (error) {
      this.setStatus(
        `载入服务端版本失败：${error instanceof Error ? error.message : String(error)}`,
        'bad',
      );
    }
  }

  private dialogState(): DialogState {
    const rules = this.rules;
    return {
      platformId: rules?.platformId ?? DEFAULT_PLATFORM_ID,
      platforms: (rules?.platformFiles ?? []).map((file) => ({ id: file.id, name: file.name })),
      highlightId: rules?.highlightId ?? DEFAULT_HIGHLIGHT_ID,
      highlights: (rules?.highlightFiles ?? []).map((file) => ({ id: file.id, name: file.name })),
      presetId: rules?.preset?.id ?? null,
      presets: describePresets(rules?.presets ?? []),
      previewFor: (presetId) => {
        const preset = rules?.presets.find((item) => item.id === presetId);
        return preset ? previewPresetSelection(this.card, preset) : null;
      },
      decideFor: (presetId) => {
        const preset = rules?.presets.find((item) => item.id === presetId);
        return preset ? decideApplyPreset(this.card, preset) : null;
      },
    };
  }

  /** 切换平台规则：立即按新规则重检并提醒 */
  private switchPlatform(id: string): void {
    if (!this.rules) return;
    let resolved;
    try {
      resolved = resolvePlatformRule(id, this.rules.platformFiles);
    } catch (error) {
      this.setStatus(
        `平台规则「${id}」无法解析：${error instanceof Error ? error.message : String(error)}`,
        'bad',
      );
      return;
    }

    this.rules = { ...this.rules, platform: resolved, platformId: id };
    // 切换即重检：不等防抖，立刻跑，让用户马上看到结论变化
    this.validate();
    const { error, warning, info } = this.lastSummary;
    this.setStatus(
      `已切换到「${resolved.name}」：错误 ${error} · 警告 ${warning} · 提示 ${info}`,
      error > 0 ? 'bad' : warning > 0 ? 'warn' : 'ok',
    );
    this.refreshRulesLabel();
  }

  /** 切换高亮方案：重新编译 + 重新着色 */
  private switchHighlight(id: string): void {
    if (!this.rules) return;
    const file = this.rules.highlightFiles.find((item) => item.id === id);
    if (!file) {
      this.setStatus(`高亮方案「${id}」不存在`, 'bad');
      return;
    }

    let compiled;
    try {
      compiled = compileHighlightRule(resolveHighlightRule(id, this.rules.highlightFiles));
    } catch (error) {
      this.setStatus(
        `高亮方案「${id}」编译失败：${error instanceof Error ? error.message : String(error)}`,
        'bad',
      );
      return;
    }

    this.rules = { ...this.rules, highlight: compiled, highlightFile: file, highlightId: id };
    // 配色来自方案本体 → 重新生成 CSS
    applySchemeStyles(file);

    // 已挂载的编辑器需要重建才能用新方案（装饰在 ViewPlugin 构造时绑定）
    for (const runtime of this.blocks) {
      if (!runtime.expanded) continue;
      const text = runtime.editor?.getText() ?? runtime.snapshot.text;
      runtime.editor?.destroy();
      runtime.editor = null;
      runtime.host.replaceChildren();
      runtime.editor = new BlockEditor({
        parent: runtime.host,
        blockId: runtime.snapshot.id,
        text,
        compiled,
        onChange: (next) => this.onBlockChange(runtime, next),
      });
      runtime.editor.setIssues(this.issuesFor(runtime.snapshot.id));
    }

    this.setStatus(`已切换高亮方案：${file.name}（${id}）`, 'ok');
    this.refreshRulesLabel();
  }

  /** 选择预设（不重排）：只影响导出装配参数 + 格式检查口径 */
  private selectPresetById(id: string): void {
    const preset = this.rules?.presets.find((item) => item.id === id);
    if (!preset || !this.rules) return;
    this.rules = { ...this.rules, preset };

    // 预设参与**格式检查**（如「板块间分隔符是否与预设一致」），
    // 所以切预设也必须立即重检——否则面板会停留在旧口径上，
    // 用户看到的结论与实际导出格式不符。
    this.validate();

    const { error, warning } = this.lastSummary;
    this.setStatus(
      `导出格式已切换为「${preset.name}」：原文未改动（要重排请点「应用预设」）` +
        ` · 按新口径重检：错误 ${error} 警告 ${warning}`,
      error > 0 ? 'bad' : warning > 0 ? 'warn' : 'ok',
    );
  }

  /** 导入平台规则：校验 + 原子回退都在 rule-library 里 */
  private importPlatformText(text: string) {
    if (!this.rules) {
      return { ok: false, value: null, issues: [], warnings: [], id: null, name: null };
    }
    const outcome = importPlatformRule(this.rules.platformFiles, text);

    if (outcome.ok) {
      // 只有成功才落到 this.rules —— 这就是原子性的落点
      const platformSourceText = { ...this.rules.platformSourceText };
      if (outcome.id) platformSourceText[outcome.id] = text;
      this.rules = {
        ...this.rules,
        platformFiles: outcome.value,
        platformSourceText,
      };
      // 若当前平台被同名覆盖，重新解析一次，避免用着旧对象
      if (outcome.id === this.rules.platformId) {
        this.rules = {
          ...this.rules,
          platform: resolvePlatformRule(outcome.id, outcome.value),
        };
        this.validate();
      }
    }
    return outcome;
  }

  /** 导入高亮方案：同样原子回退，且必须能编译 */
  private importHighlightText(text: string) {
    if (!this.rules) {
      return { ok: false, value: null, issues: [], warnings: [], id: null, name: null };
    }
    const outcome = importHighlightScheme(
      this.rules.highlightFile,
      this.rules.highlightFiles,
      text,
    );

    if (outcome.ok && outcome.value && outcome.compiled && outcome.id) {
      const highlightSourceText = { ...this.rules.highlightSourceText };
      highlightSourceText[outcome.id] = text;
      this.rules = {
        ...this.rules,
        highlightFiles: [...this.rules.highlightFiles.filter((f) => f.id !== outcome.id), outcome.value],
        highlightSourceText,
      };
      // 导入即应用：切到新方案，用户能立刻看到效果
      this.switchHighlight(outcome.id);
      this.rulesDialog?.refresh();
    }
    return outcome;
  }

  private refreshRulesLabel(): void {
    const label = byId('rules-label');
    const rules = this.rules;
    if (!rules) return;
    label.textContent = `平台 ${rules.platformId} · 高亮 ${rules.highlightId} · 预设 ${rules.preset?.id ?? '—'}`;
  }

  /** 卡片被整体替换（应用预设 / 打开文件）后重建板块视图 */
  private reloadBlocksFromCard(): void {
    for (const runtime of this.blocks) {
      this.collapse(runtime);
      runtime.section.remove();
    }
    this.blocks = collectBlocks(this.card).map((snapshot) => this.createBlock(snapshot));
    const expandAll = new URLSearchParams(location.search).get('expand') === 'all';
    for (const [index, runtime] of this.blocks.entries()) {
      if (expandAll || index < 2) this.expand(runtime, true);
    }
    this.refreshStats();
    byId('card-name').textContent = this.card.meta.name || '(未命名)';
  }

  // ── 设置与同步可用性（T6.8）──────────────────────────────
  //
  // 关键原则：同步是"可选的增强"，网络问题不得影响本地编辑。
  // 因此这里做三件事：① 顶栏状态胶囊；② 同步条按钮启用/禁用；③ 最多一次自动探测。
  private wireSettings(): void {
    this.settings = new SettingsDialog({
      onConnectionChange: (result) => this.applyConnection(result),
      onSaved: () => {
        void this.refreshTokenAfterSave();
        this.setStatus('设置已保存', 'ok');
      },
    });

    byId<HTMLButtonElement>('btn-settings').addEventListener('click', () => {
      void this.settings?.open();
    });

    // 调试/截图入口：?settings=1 自动打开；配合 &serverUrl=…&token=… 会执行一次真实探测。
    // 只影响"打开面板"这一步，探测逻辑与手动点击完全一致（不伪造状态）。
    const params = new URLSearchParams(location.search);
    if (params.get('settings') === '1') {
      const serverUrl = params.get('serverUrl') ?? undefined;
      const token = params.get('token') ?? undefined;
      void (async () => {
        await this.settings?.open({ serverUrl, token });
        if (params.get('probe') === '1') {
          await this.settings?.runProbe();
        }
      })();
    }

    // T6.7：三个同步入口都打开同一个面板（面板内按职责分区：上传 / 历史 / 回滚）
    for (const id of ['btn-upload', 'btn-history', 'btn-rollback']) {
      byId<HTMLButtonElement>(id).addEventListener('click', () => {
        if (!isSyncReady(this.connection)) {
          this.setStatus('同步未就绪：请到「设置」检查服务端地址与令牌', 'warn');
          return;
        }
        this.syncDialog?.open();
      });
    }

    this.applyConnection(null);
    void this.autoProbe();
  }

  /** 启动时探测一次已保存的配置；失败静默（不打扰编辑） */
  private async autoProbe(): Promise<void> {
    try {
      const config = await configGet();
      this.settingsToken = config.token;
      if (!config.serverUrl.trim()) return;
      const result = await probeServer(config);
      this.applyConnection(result);
    } catch {
      // 读不到配置（浏览器模式）或探测失败：保持"未连接"，不影响本地功能
    }
  }

  /** 把连接结果映射到界面：胶囊 + 同步按钮 + 提示 */
  private applyConnection(result: ProbeResult | null): void {
    this.connection = result;

    const chip = byId('conn-chip');
    const text = byId('conn-text');
    const hint = byId('sync-hint');
    const ready = isSyncReady(result);

    chip.className = 'conn-chip ' + (ready ? 'on' : result ? (result.reachable ? 'warn' : 'bad') : 'off');
    text.textContent = ready ? '已连接' : result?.reachable ? '鉴权未通过' : '未连接';

    for (const id of ['btn-upload', 'btn-history', 'btn-rollback']) {
      byId<HTMLButtonElement>(id).disabled = !ready;
    }

    if (ready) {
      hint.textContent =
        result?.cardCount === null || result?.cardCount === undefined
          ? '同步已就绪'
          : `同步已就绪 · 服务端现有 ${result.cardCount} 张卡`;
      hint.className = 'sync-hint ok';
    } else {
      hint.textContent = result
        ? '同步不可用（编辑 / 审计 / 导出不受影响）'
        : '同步未启用（编辑 / 审计 / 导出不受影响）';
      hint.className = 'sync-hint warn';
    }
  }

  // ── 构造 ────────────────────────────────────────────────
  private createBlock(snapshot: EditorBlockSnapshot): BlockRuntime {
    const section = el('section', 'block');
    section.dataset['blockId'] = snapshot.id;

    const header = el('button', 'block-head');
    header.type = 'button';

    const caret = el('span', 'caret', '▸');
    const title = el('span', 'block-title', snapshot.label);
    const meta = el('span', 'block-meta', `${snapshot.length} 字`);

    // 缺失标记：CardBlock.missing 的语义是「导入源里根本没有这个板块」，
    // shared 要求 UI 显式标出，不允许让它看起来像「用户清空了」。
    // 因此这里在标题旁常驻一个小标签，与「空块」在视觉上区分开。
    const missingTag = el('span', 'block-missing', '原文缺失');
    missingTag.hidden = !snapshot.missing;
    missingTag.title = '导入源中没有该板块，已按空处理；填写后会在导出时写入';

    const badge = el('span', 'block-badge');
    badge.hidden = true;

    header.append(caret, title, missingTag, meta, badge);
    if (snapshot.missing) section.dataset['missing'] = '1';

    const body = el('div', 'block-body');
    body.hidden = true;

    const host = el('div', 'cm-host');
    const preview = el('div', 'preview');
    preview.hidden = true;
    body.append(host, preview);

    section.append(header, body);

    const runtime: BlockRuntime = {
      snapshot,
      section,
      body,
      host,
      preview,
      badge,
      editor: null,
      expanded: false,
      previewOn: false,
    };

    header.addEventListener('click', () => this.toggle(runtime));
    this.blockList.append(section);
    return runtime;
  }

  // ── 展开 / 折叠（懒渲染核心）──────────────────────────────
  private toggle(runtime: BlockRuntime): void {
    if (runtime.expanded) this.collapse(runtime);
    else this.expand(runtime);
  }

  private expand(runtime: BlockRuntime, silent = false): void {
    if (runtime.expanded) return;
    runtime.expanded = true;
    runtime.body.hidden = false;
    runtime.section.classList.add('expanded');
    runtime.section.querySelector('.caret')!.textContent = '▾';

    // 懒渲染：只有展开时才创建 CodeMirror 实例
    if (!runtime.editor) {
      runtime.editor = new BlockEditor({
        parent: runtime.host,
        blockId: runtime.snapshot.id,
        text: runtime.snapshot.text,
        compiled: this.rules?.highlight ?? null,
        onChange: (text) => this.onBlockChange(runtime, text),
      });
      runtime.editor.setIssues(this.issuesFor(runtime.snapshot.id));
    }
    if (!silent) runtime.editor.view.focus();
  }

  private collapse(runtime: BlockRuntime): void {
    if (!runtime.expanded) return;
    runtime.expanded = false;
    runtime.body.hidden = true;
    runtime.section.classList.remove('expanded');
    runtime.section.querySelector('.caret')!.textContent = '▸';

    // 折叠即销毁：保证隐藏板块不进 DOM（含 CodeMirror 的 contenteditable 结构）
    runtime.editor?.destroy();
    runtime.editor = null;
    runtime.host.replaceChildren();
  }

  // ── 编辑 → 校验 ──────────────────────────────────────────
  private onBlockChange(runtime: BlockRuntime, text: string): void {
    const result = setBlockText(this.card, runtime.snapshot.id, text);
    if (!result.changed) return;

    this.card = result.card;
    runtime.snapshot = {
      ...runtime.snapshot,
      text,
      length: [...text].length,
      empty: text.trim() === '',
    };
    this.refreshStats();
    this.scheduleValidate(260);
  }

  private scheduleValidate(delay: number): void {
    if (this.validateTimer !== null) window.clearTimeout(this.validateTimer);
    this.validateTimer = window.setTimeout(() => {
      this.validateTimer = null;
      this.validate();
    }, delay);
  }

  private validate(): void {
    if (!this.rules) return;
    // T6.5：一次审计产出完整报告，面板与编辑器标记共用同一份数据，
    // 避免"面板显示 3 条、编辑器画 5 条"这类两处各算一次导致的不一致。
    const report = buildAuditReport(this.card, {
      platformRule: this.rules.platform,
      preset: this.rules.preset,
    });
    this.report = report;
    this.issues = report.issues;
    this.lastSummary = {
      error: report.summary.error,
      warning: report.summary.warning,
      info: report.summary.info,
    };

    if (this.auditPanel) {
      this.auditPanel.setReport(report);
      // 标题栏只放一个短状态，详细摘要由面板自己渲染（避免同一句话出现两次）
      this.issueSummary.textContent =
        report.issues.length === 0 ? '无问题' : `${report.issues.length} 条`;
      this.issueSummary.className = `issue-summary ${
        report.summary.error > 0 ? 'bad' : report.issues.length > 0 ? 'warn' : 'ok'
      }`;
    }
    this.refreshBlockBadges(report.issues);
    // 顶栏计数必须跟着报告走，否则会出现"顶栏 错误 0 / 面板 错误 1"
    this.refreshStats();
    // 已挂载的编辑器同步标记：修正后这里会收到空数组，高亮即时消失
    for (const runtime of this.blocks) {
      runtime.editor?.setIssues(this.issuesFor(runtime.snapshot.id));
    }
  }

  /**
   * 定位到某条问题（面板点击 / 字数条点击都走这里）。
   * 位置信息**完全取自报告**：编辑器只负责把 start/end 变成选区。
   */
  private locateIssue(issue: AuditIssue): void {
    const { blockId, start, end } = issue.location;
    if (!blockId) {
      this.setStatus('该问题不属于任何板块（全文级统计），无法定位到具体位置', 'warn');
      return;
    }
    const runtime = this.blocks.find((b) => b.snapshot.id === blockId);
    if (!runtime) return;

    this.activeIssueId = issue.id;
    this.expand(runtime, true);
    runtime.editor?.focusRange(start, end);
    this.auditPanel?.setActiveIssue(issue.id);
  }

  private issuesFor(blockId: BlockId): EditorIssue[] {
    return this.issues
      .filter((issue) => issue.location.blockId === blockId)
      .map((issue) => ({
        id: issue.id,
        severity: issue.severity,
        message: issue.message,
        start: issue.location.start,
        end: issue.location.end,
      }));
  }

  // ── 渲染：统计 / 徽标 / 问题列表 ──────────────────────────
  private refreshStats(): void {
    const total = totalLength(this.blocks.map((block) => block.snapshot));
    const totalCp = [...[...this.blocks.map((b) => b.snapshot.text)].join('')].length;
    // 等级计数一律取 lastSummary：它是「最近一次审计报告」的唯一投影。
    // 若在这里数 this.issues，会和 report.summary 形成两个数据源
    // （曾导致顶栏显示"错误 0"而审计面板显示"错误 1"）。
    const { error: errors, warning: warnings } = this.lastSummary;

    this.toolbarStats.replaceChildren(
      el('span', 'stat', `六板块 ${totalCp} 字`),
      el('span', 'stat', `块内合计 ${total} 字`),
      el('span', `stat ${errors > 0 ? 'bad' : 'ok'}`, `错误 ${errors}`),
      el('span', `stat ${warnings > 0 ? 'warn' : 'ok'}`, `警告 ${warnings}`),
    );
  }

  private refreshBlockBadges(all: readonly AuditIssue[]): void {
    for (const runtime of this.blocks) {
      const mine = all.filter((issue) => issue.location.blockId === runtime.snapshot.id);
      const errors = mine.filter((i) => i.severity === 'error').length;
      const warnings = mine.filter((i) => i.severity === 'warning').length;
      const total = mine.length;

      runtime.section.dataset['errors'] = String(errors);
      runtime.section.dataset['warnings'] = String(warnings);

      const meta = runtime.section.querySelector('.block-meta');
      if (meta) meta.textContent = `${runtime.snapshot.length} 字`;

      if (total === 0) {
        runtime.badge.hidden = true;
        runtime.badge.textContent = '';
        continue;
      }
      runtime.badge.hidden = false;
      // 只有提示级问题时不能显示「0 警告」——按最严重的一级决定文案
      if (errors > 0) {
        runtime.badge.textContent = `${errors} 错误`;
        runtime.badge.className = 'block-badge bad';
      } else if (warnings > 0) {
        runtime.badge.textContent = `${warnings} 警告`;
        runtime.badge.className = 'block-badge warn';
      } else {
        runtime.badge.textContent = `${total} 提示`;
        runtime.badge.className = 'block-badge info';
      }
    }
  }


  // ── 工具条：打开 / 另存 / 预览 ────────────────────────────
  private wireToolbar(): void {
    const openButton = byId<HTMLButtonElement>('btn-open');
    const saveButton = byId<HTMLButtonElement>('btn-save');
    const previewButton = byId<HTMLButtonElement>('btn-preview');
    const shell = isShellAvailable();

    if (!shell) {
      openButton.disabled = true;
      saveButton.disabled = true;
      openButton.title = '浏览器模式：请在桌面客户端内使用';
      saveButton.title = '浏览器模式：请在桌面客户端内使用';
    }

    openButton.addEventListener('click', () => void this.openCard());
    saveButton.addEventListener('click', () => void this.saveCard());
    previewButton.addEventListener('click', () => this.togglePreview());
  }

  private async openCard(): Promise<void> {
    try {
      const path = await pickCardFile();
      if (!path) return;
      const file = await readTextExact(path);
      const parsed = parseStCard(file.text);
      this.replaceCard(parsed.card);
      this.setStatus(`已打开：${file.pathDisplay ?? '(非 UTF-8 路径)'}（${file.bytesLen} 字节）`);
    } catch (error) {
      this.setStatus(`打开失败：${describe(error)}`, 'bad');
    }
  }

  private async saveCard(): Promise<void> {
    try {
      const target = await pickSavePath(`${this.card.meta.name || 'card'}.json`, 'json');
      if (!target) return;
      const text = serializeCard(this.card);
      const receipt = await writeFileAtomic(target, text);
      this.setStatus(
        `已保存：${receipt.pathDisplay ?? '(非 UTF-8 路径)'} · ${receipt.bytesWritten} 字节 · ` +
          `sha256 ${receipt.sha256.slice(0, 12)}… · 回读${receipt.verified ? '一致' : '不一致！'}`,
        receipt.verified ? 'ok' : 'bad',
      );
    } catch (error) {
      this.setStatus(`保存失败：${describe(error)}`, 'bad');
    }
  }

  private togglePreview(): void {
    for (const runtime of this.blocks) {
      if (!runtime.expanded) continue;
      runtime.previewOn = !runtime.previewOn;
      runtime.preview.hidden = !runtime.previewOn;
      if (runtime.previewOn) this.renderPreview(runtime);
      else runtime.preview.replaceChildren();
    }
  }

  private renderPreview(runtime: BlockRuntime): void {
    if (!this.rules) return;
    const fragment = buildPreviewFragment(
      runtime.snapshot.text,
      this.rules.highlight,
      { blockId: runtime.snapshot.id },
    );
    runtime.preview.replaceChildren(fragment);
  }

  private replaceCard(card: UnifiedCard): void {
    this.card = card;
    this.reloadBlocksFromCard();
    this.scheduleValidate(0);
  }

  private setStatus(text: string, kind: 'ok' | 'warn' | 'bad' | 'info' = 'info'): void {
    this.statusBar.textContent = text;
    this.statusBar.className = `status ${kind}`;
  }

  // ── 调试/截图入口（走真实逻辑，不伪造状态）──────────────────
  selectPresetForDemo(id: string): void {
    this.selectPresetById(id);
    this.refreshRulesLabel();
  }

  applyPresetForDemo(id: string): void {
    const preset = this.rules?.presets.find((item) => item.id === id);
    if (!preset) return;
    const decision = decideApplyPreset(this.card, preset);
    if (decision.kind !== 'confirm') {
      this.setStatus(decision.kind === 'noop' ? decision.message : '没有可应用的变化', 'warn');
      return;
    }
    // 与 UI 里的「应用预设」走同一条路径，只是跳过 window.confirm（自动化无法应答）
    this.commitPresetApply(preset, decision.plan);
  }

  /**
   * 真正落地「应用预设」：**同时**把该预设设为当前预设，再按 plan 重排。
   *
   * 为什么必须一起做：重排是按这个预设的标题/分隔符写的，
   * 若 `rules.preset` 还停在旧预设，导出会按旧格式拼装，
   * 于是"刚重排成 divider，导出的却是 default"——两者不一致。
   */
  private commitPresetApply(preset: TxtPreset, plan: PresetApplyPlan): void {
    if (this.rules) {
      this.rules = { ...this.rules, preset };
    }
    this.card = applyPresetPlan(this.card, plan);
    this.reloadBlocksFromCard();
    this.rulesDialog?.refresh();
    // 重排后按新预设口径立即重检（分隔符/顺序类问题应当消失）
    this.validate();
    this.refreshRulesLabel();
    this.refreshStats();
    this.setStatus(
      `已应用预设「${preset.name}」：${plan.changes.join('；') || '标题样式已重排'} · 已按新格式重检`,
      'ok',
    );
  }

  switchPlatformForDemo(id: string): void {
    this.switchPlatform(id);
    this.refreshRulesLabel();
  }

  switchHighlightForDemo(id: string): void {
    this.switchHighlight(id);
    this.refreshRulesLabel();
  }

  openRulesDialogForDemo(): void {
    this.rulesDialog?.open();
  }

  /**
   * 演示/验证用：注入一个**真实会被规则引擎判为 error** 的问题。
   *
   * 做法不是伪造报告——而是把卡片改成真正违规（清空 name、并把某必填字段写空），
   * 再走正常审计链路。这样弹出的拦截框与真实使用完全一致。
   */
  injectErrorForDemo(): void {
    const broken = structuredClone(this.card);
    // name 为空：多数平台规则将其判为 error（必填）
    broken.meta.name = '';
    // 再把基本信息正文清空，触发"必填板块为空"这类 error
    const basic = broken.blocks.find((block) => block.id === 'basic');
    if (basic) {
      basic.text = '';
      basic.dirty = true;
    }
    this.replaceCard(broken);
    this.validate();
    const { error } = this.lastSummary;
    this.setStatus(`演示：已注入 ${error} 个错误级问题（name 为空 + 基本信息为空）`, 'warn');
  }

  openExportForDemo(): void {
    this.exportDialog?.open('json');
  }

  /** 调试/截图：直接打开同步面板（需连接就绪） */
  openSyncForDemo(): void {
    this.syncDialog?.open();
  }

  /** 调试/截图：预选服务端卡片并加载其版本历史 */
  preselectSyncCardForDemo(cardId: string): void {
    this.syncCardId = cardId;
    this.syncDialog?.selectCard(cardId);
  }

  /** 调试/截图：以给定地址+令牌连接一次（走真实 probeServer） */
  async connectForDemo(serverUrl: string, token: string): Promise<void> {
    this.settingsToken = token;
    const result = await probeServer({ serverUrl, token });
    this.applyConnection(result);
  }

  /**
   * 演示/验证用：喂一段**真实存在缺陷**的规则文本走完整导入链路，
   * 让「导入失败 + 原子回退 + 字段级错误」在界面上可见。
   * 文本取自真实规则文件并定向破坏（不是手搓的假结构）。
   */
  importBadRuleForDemo(): void {
    if (!this.rules) return;
    const sample = this.rules.platformSourceText[this.rules.platformId];
    let broken: string;
    if (sample) {
      const parsed = JSON.parse(sample) as Record<string, unknown>;
      const fields = Array.isArray(parsed['fields']) ? (parsed['fields'] as unknown[]) : [];
      // 定向破坏两处：清空 label、把 required 改成字符串
      if (fields.length > 0 && typeof fields[0] === 'object' && fields[0] !== null) {
        (fields[0] as Record<string, unknown>)['label'] = '';
      }
      if (fields.length > 1 && typeof fields[1] === 'object' && fields[1] !== null) {
        (fields[1] as Record<string, unknown>)['required'] = 'yes';
      }
      parsed['id'] = 'broken-demo';
      broken = JSON.stringify(parsed, null, 2);
    } else {
      broken = '{ "id": "broken-demo", "name": '; // 截断 JSON
    }

    const outcome = this.importPlatformText(broken);
    this.rulesDialog?.open();
    this.rulesDialog?.showImportFailure(outcome);
  }

  /** 演示/验证用：走真实的宽松 TXT 导入，让「原文缺失」标记可见 */
  applyDemoLenientText(): void {
    if (!this.rules?.preset) return;
    const text = '【基本信息】\n姓名：{{char}}\n年龄：24';
    const result = importCardText(this.card, text, this.rules.preset, 'lenient');
    if (!result.card) {
      this.setStatus(`演示导入被拒绝：${result.issues.map((i) => i.message).join('；')}`, 'bad');
      return;
    }
    this.replaceCard(result.card);
    this.setStatus(
      `演示：宽松导入仅含「基本信息」的 TXT，其余板块按「原文缺失」标记（${result.issues.length} 条提示）`,
      'warn',
    );
  }
}

function describe(error: unknown): string {
  const shellError = error as Partial<ShellError>;
  if (typeof shellError?.code === 'string') {
    return `[${shellError.code}] ${shellError.message ?? ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// ── 启动 ────────────────────────────────────────────────────
async function boot(): Promise<void> {
  let card: UnifiedCard;
  try {
    card = parseStCard(sampleCardJson as unknown).card;
  } catch {
    card = createEmptyCard('未命名');
  }

  byId('card-name').textContent = card.meta.name || '(未命名)';

  const app = new EditorApp(card);
  await app.start();

  // 调试/截图入口：?demo=lenient 用「只有基本信息」的 TXT 走一次**真实的宽松导入**，
  // 用于验证/展示「原文缺失」标记。走的是 shared 的 applyCardText，不伪造状态。
  const params = new URLSearchParams(location.search);
  if (params.get('demo') === 'lenient') {
    app.applyDemoLenientText();
  }

  // 调试/截图入口（T6.2/T6.3）：
  //   ?rules=1&preset=divider     打开规则面板并把预设选为 divider（不重排）
  //   ?rules=1&applyPreset=divider 直接执行「应用预设」（会重排，走同一套 plan→apply）
  //   ?platform=janitorai         切到指定平台规则（触发重检）
  //   ?highlight=dark             切到指定高亮方案
  const presetParam = params.get('preset');
  if (presetParam) app.selectPresetForDemo(presetParam);
  const applyParam = params.get('applyPreset');
  if (applyParam) app.applyPresetForDemo(applyParam);
  const platformParam = params.get('platform');
  if (platformParam) app.switchPlatformForDemo(platformParam);
  const highlightParam = params.get('highlight');
  if (highlightParam) app.switchHighlightForDemo(highlightParam);
  if (params.get('rules') === '1') app.openRulesDialogForDemo();
  if (params.get('badImport') === '1') app.importBadRuleForDemo();
  // ?export=1           打开导出面板（正常路径）
  // ?export=1&forceError=1  先注入一个 error 级问题，用于展示拦截弹窗
  if (params.get('forceError') === '1') app.injectErrorForDemo();
  if (params.get('export') === '1') app.openExportForDemo();
  const syncUrl = params.get('syncUrl');
  const syncToken = params.get('syncToken');
  if (syncUrl && syncToken) {
    void (async () => {
      await app.connectForDemo(syncUrl, syncToken);
      if (params.get('sync') === '1') app.openSyncForDemo();
      // ?syncCard=card-xxxx 预选某张卡，便于截图展示版本历史
      const preselect = params.get('syncCard');
      if (preselect) app.preselectSyncCardForDemo(preselect);
    })();
  }

  // 便于性能脚本与调试访问（只挂载在 window 上，不参与业务逻辑）
  (window as unknown as Record<string, unknown>)['__tcs'] = { app };
}

void boot();
