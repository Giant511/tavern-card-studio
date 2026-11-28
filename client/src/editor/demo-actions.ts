/**
 * 编辑器的调试/截图动作（2026-11-24，从 `app.ts` 的 demo 区块搬出）。
 *
 * ## 为什么能搬出来了
 *
 * 这 20 个方法共约 500 行，此前卡在 `EditorApp` 里动不了 —— 它们依赖 26 个
 * `private` 成员，跨文件访问不了（报告 P2-2 建议的"移到单独文件"因此做不到）。
 *
 * 解法不是把 26 个成员改成 public（那会让封装永久变松），而是让 `EditorApp`
 * 提供一个**窄接口**`DemoHost`：31 个访问点的类型集中声明在这里，
 * 由 `app.ts` 的 `demoHost()` 构造。读代码时"这个模块依赖什么"一眼看得完。
 *
 * ```text
 *   app.ts         demoHost(): DemoHost     ← 31 行转发，集中一处
 *   本文件          export function xxx(host, ...)  ← 纯函数，可直接单测
 * ```
 *
 * ## 纪律：走真实逻辑，不伪造状态
 *
 * `?rules=1&applyPreset=divider` 真的执行「应用预设」（会重排），
 * 而不是把界面摆成"应用过了"的样子。`?crashInject=1` 走真实的全局 error 钩子
 * —— 这样截图与端到端才有验证价值。
 *
 * ## 加载方式
 *
 * 本模块被 `debug-params.ts` import。而 `debug-params.ts` 只在 URL 带调试参数时
 * 才被 `boot()` 动态加载，所以这一整块（含它依赖的对话框/预览代码）
 * **不进主 chunk**。
 */

import type {
  AuditIssue,
  PresetApplyPlan,
  RuleIssue,
  TxtPreset,
  UnifiedCard,
  WorldbookPreset,
} from '@tcs/shared';
import { importWorldbook, applyPresetPlan, renderWorldbookTextWith } from '@tcs/shared';

import type { ExportDialog } from '../export/export-dialog';
import type { ImportDialog } from './import-dialog';
import type { Ruleset } from './rules';
import type { RulesDialog } from '../rules/rules-dialog';
import type { SyncDialog } from '../sync/sync-dialog';
import type { PresetImportOutcome } from '../rules/preset-library';
import type { ProbeResult } from '../net/server-probe';
import type { BlockRuntime } from './block-runtime';

import { decideApplyPreset } from '../rules/preset-switch';
import { browserHintStore, dismissNameHint, resetNameHint } from './name-hint';
import { importCardText } from './block-doc';
import { byId } from './dom-id';
import { isShellAvailable } from '../contract';
import { probeServer } from '../net/server-probe';

/**
 * `EditorApp` 提供给 demo 动作的窄接口。
 *
 * 31 个成员，**全部是 demo 代码真实用到的**（逐个 grep 出来的，没有预留）。
 * 字段除 `settingsToken` 外都是只读 —— 只有它会被 demo 写入（`?settings=1` 带 token）。
 */
export interface DemoHost {
  // ── 状态（只读）──────────────────────────
  readonly card: UnifiedCard;
  readonly hasSession: boolean;
  readonly rules: Ruleset | null;
  readonly blocks: readonly BlockRuntime[];
  readonly issues: readonly AuditIssue[];
  readonly lastSummary: { error: number; warning: number; info: number };
  readonly worldbookPreset: WorldbookPreset;

  // ── 对话框（可能尚未构造）───────────────
  readonly exportDialog: ExportDialog | null;
  readonly importDialog: ImportDialog | null;
  readonly rulesDialog: RulesDialog | null;
  readonly syncDialog: SyncDialog | null;

  // ── 唯一可写字段 ─────────────────────────
  settingsToken: string;

  // ── 动作 ─────────────────────────────────
  setStatus(text: string, kind?: 'ok' | 'warn' | 'bad' | 'info'): void;
  validate(): void;
  refreshRulesLabel(): void;
  refreshStats(): void;
  refreshNameHint(): void;
  reloadBlocksFromCard(): void;
  replaceCard(card: UnifiedCard): void;
  selectPresetById(id: string): void;
  selectWorldbookPreset(id: string): void;
  switchPlatform(id: string): void;
  switchHighlight(id: string): void;
  commitPresetApply(preset: TxtPreset, plan: PresetApplyPlan): void;
  createSessionFromFile(path: string): string;
  applyConnection(result: ProbeResult | null): void;
  expand(runtime: BlockRuntime, silent?: boolean): void;
  collapse(runtime: BlockRuntime): void;
  /**
   * 返回导入结果。
   *
   * 只声明 demo 真正用到的两个字段（`ok` 与 `issues`）—— 声明整份
   * `ImportOutcome<T>` 会因为它有早退分支（`value: null`）而类型冲突，
   * 而 demo 根本不看 value。
   */
  importPlatformText(text: string): {
    readonly ok: boolean;
    readonly issues: readonly RuleIssue[];
  };
  importTxtPresetText(text: string): PresetImportOutcome<TxtPreset[]>;
  importWorldbookPresetText(text: string): PresetImportOutcome<WorldbookPreset[]>;
  importCardTextFile(
    fileName: string,
    text: string,
    createdSession?: string | null,
    autoConfirm?: boolean,
    note?: string,
  ): Promise<void>;
}

export function selectPresetForDemo(host: DemoHost, id: string): void {
    host.selectPresetById(id);
    host.refreshRulesLabel();
}

export function applyPresetForDemo(host: DemoHost, id: string): void {
    const preset = host.rules?.presets.find((item) => item.id === id);
    if (!preset) return;
    const decision = decideApplyPreset(host.card, preset);
    if (decision.kind !== 'confirm') {
      host.setStatus(decision.kind === 'noop' ? decision.message : '没有可应用的变化', 'warn');
      return;
    }
    // 与 UI 里的「应用预设」走同一条路径，只是跳过 window.confirm（自动化无法应答）
    host.commitPresetApply(preset, decision.plan);
}

export function switchPlatformForDemo(host: DemoHost, id: string): void {
    host.switchPlatform(id);
    host.refreshRulesLabel();
}

export function switchHighlightForDemo(host: DemoHost, id: string): void {
    host.switchHighlight(id);
    host.refreshRulesLabel();
}

export function openRulesDialogForDemo(host: DemoHost): void {
    host.rulesDialog?.open();
}

  /**
   * T10.34 验收演示：一份「条目4：爱好」数据走**自定义路径**（截图用）。
   *
   * 走的是真实链路，没有伪造状态：
   *   · 自定义 TXT 预设 → 经 importTxtPresetText（同一套原子回退/同 id 覆盖）；
   *   · 中文世界书预设 → preset-library；
   *   · 自定义平台规则 → 经 importPlatformText（schema 校验 + 继承解析）；
   *   · 世界书条目 → importWorldbook 按自定义格式解析出来，再回写成 TXT。
   */
export function applyCustomTrackDemo(host: DemoHost, mode: 'rules' | 'audit' | 'warn'): void {
    // 零标签时先建一张卡：host.card 只在有活动会话时可用，
    // 直接写卡片状态会抛「当前没有活动会话」而整段演示静默中断。
    if (!host.hasSession) host.createSessionFromFile('未命名角色卡.txt');
    // warn 模式：删掉「关键词」行 + 触发深度写 88（越界），用来展示自定义规则的
    // 与内置默认规则集各自报什么（验收第 ③④ 条）。
    const sample =
      mode === 'warn'
        ? ['条目4：', '名称：爱好', '触发深度：88', '内容：', '主角喜欢读书和看电影。', '条目4结束', ''].join('\n')
        : [
            '条目4：',
            '名称：爱好',
            '关键词：读书、电影',
            '触发深度：5',
            '内容：',
            '主角喜欢读书和看电影。',
            '条目4结束',
            '',
          ].join('\n');

    const customWb = {
      schemaVersion: 1 as const,
      id: 'cn-kv',
      name: '中文键值世界书',
      version: '1.0.0',
      description: '条目{id}：/ 名称：/ 关键词：/ 触发深度：/ 内容：',
      format: {
        entryOpen: '条目{id}：',
        contentMark: '内容：',
        entryClose: '条目{id}结束',
        fieldOrder: ['name', 'keys', 'insertion_order'],
        labelMap: { name: '名称', keys: '关键词', insertion_order: '触发深度' },
        fieldSeparator: '：',
        listSeparator: '、',
        entrySeparator: '\n',
      },
    };

    // 1) 自定义 TXT 预设（复制内置那份并改 id，模拟"导入用户自己的格式"）
    const basePreset = host.rules?.presets.find((item) => item.id === 'default');
    if (basePreset) {
      host.importTxtPresetText(
        JSON.stringify({ ...basePreset, id: 'my-format', name: '我的格式', builtin: false }),
      );
    }

    // 2) 自定义世界书预设并选中
    const wbOutcome = host.importWorldbookPresetText(JSON.stringify(customWb));
    if (wbOutcome.ok && wbOutcome.id !== null) host.selectWorldbookPreset(wbOutcome.id);

    // 3) 解析样本 → 写入卡片的世界书（按自定义格式回写 TXT，结构检查才不会误报）
    const format = host.worldbookPreset.format;
    const parsed = importWorldbook(sample, format);
    if (parsed.entries.length > 0) {
      host.card.worldbook = {
        entries: parsed.entries,
        text: renderWorldbookTextWith(parsed.entries, format),
        dirty: false,
        raw: null,
      };
      host.reloadBlocksFromCard();
    }

    // 4) 自定义平台规则（经真实导入路径）
    host.importPlatformText(
      JSON.stringify({
        schemaVersion: 1,
        id: 'my-worldbook-policy',
        name: '我的世界书规范',
        version: '1.0.0',
        target: { spec: 'any' },
        placeholders: { char: ['{{char}}'], user: ['{{user}}'] },
        fields: [],
        rules: [
          {
            id: 'mine:entry-name-required',
            type: 'non-empty',
            message: '条目名不能为空（{entry}）',
            scope: 'worldbook:entries[].name',
            severity: 'error',
            category: 'worldbook',
          },
          {
            id: 'mine:keys-not-empty',
            type: 'list-count',
            min: 1,
            message: '{entry}没有关键词，永远不会被触发',
            scope: 'worldbook:entries[].keys',
            severity: 'warning',
            category: 'worldbook',
          },
          {
            id: 'mine:depth-range',
            type: 'number-range',
            min: 0,
            max: 10,
            message: '触发深度必须在 0..10',
            scope: 'worldbook:entries[].insertion_order',
            severity: 'warning',
            category: 'worldbook',
          },
        ],
      }),
    );
    host.switchPlatform('my-worldbook-policy');
    host.validate();

    if (mode === 'rules') host.rulesDialog?.open();
    host.setStatus('已导入自定义预设与平台规则', 'ok');
}

  /**
   * 演示/验证用：让**两个新板块**各产生一条真实的审计问题。
   *
   * 为什么需要它：`?forceError=1` 的问题都落在「基本信息」，看不出新板块
   * 是否真的接进了审计链路（一个板块"显示出来"和"它的文本真的进入规则求值"
   * 是两件事）。这里同样不伪造报告 —— 把新板块改成真正会触发内置检查的状态：
   *   · 对话示例：标成"导入源里没有这个标题"（`missing`），触发 `builtin:block-missing`；
   *   · 初始场景：写一段**分隔行条数多于备用开场白**的文本，触发
   *     `builtin:greeting-divider-ambiguous`（这是 v0.1.3 新增的那条 info）。
   * 两条问题的 `location.blockId` 分别是两个新板块，面板上可直接点着定位。
   */
export function injectNewBlockIssuesForDemo(host: DemoHost): void {
    const broken = structuredClone(host.card);
    const examples = broken.blocks.find((block) => block.id === 'chat-examples');
    if (examples) {
      examples.text = '';
      examples.raw = '';
      examples.dirty = false;
      examples.missing = true;
    }
    const scene = broken.blocks.find((block) => block.id === 'initial-scene');
    if (scene) {
      // 分隔行 2 处、备用开场白 0 条 ⇒ 多出来的来自 first_mes 正文本身
      scene.text = '第一幕\n\n---\n\n第二幕\n\n---\n\n第三幕';
      scene.dirty = false;
    }
    host.replaceCard(broken);
    host.validate();
    const newBlockIssues = host.issues.filter(
      (issue) => issue.location.blockId === 'chat-examples' || issue.location.blockId === 'initial-scene',
    );
    host.setStatus(
      `新板块产生 ${String(newBlockIssues.length)} 条提示（对话示例·原文缺失 / 初始场景·分隔行二义）`,
      'warn',
    );
}

  /**
   * 演示/验证用：注入一个**真实会被规则引擎判为 error** 的问题。
   *
   * 做法不是伪造报告——而是把卡片改成真正违规（清空 name、并把某必填字段写空），
   * 再走正常审计链路。这样弹出的拦截框与真实使用完全一致。
   */
export function injectErrorForDemo(host: DemoHost): void {
    const broken = structuredClone(host.card);
    // name 为空：多数平台规则将其判为 error（必填）
    broken.meta.name = '';
    // 再把基本信息正文清空，触发"必填板块为空"这类 error
    const basic = broken.blocks.find((block) => block.id === 'basic');
    if (basic) {
      basic.text = '';
      basic.dirty = true;
    }
    host.replaceCard(broken);
    host.validate();
    const { error } = host.lastSummary;
    host.setStatus(`已生成 ${String(error)} 个错误级问题（角色名称为空 + 基本信息为空）`, 'warn');
}

export function openExportForDemo(host: DemoHost): void {
    host.exportDialog?.open('json');
}

  /** 调试/截图：直接打开同步面板（需连接就绪） */
export function openSyncForDemo(host: DemoHost): void {
    host.syncDialog?.open();
}

  /** 调试/截图：预选服务端卡片并加载其版本历史 */
export function preselectSyncCardForDemo(host: DemoHost, cardId: string): void {
    // 只改"看哪张卡的历史"，不改上传目标 —— 上传目标恒为活动会话
    host.syncDialog?.selectCard(cardId);
}

  /** 调试/截图：以给定地址+令牌连接一次（走真实 probeServer） */
export async function connectForDemo(host: DemoHost, serverUrl: string, token: string): Promise<void> {
    host.settingsToken = token;
    const result = await probeServer({ serverUrl, token });
    host.applyConnection(result);
}

  /**
   * 演示/验证用：喂一段**真实存在缺陷**的规则文本走完整导入链路，
   * 让「导入失败 + 原子回退 + 字段级错误」在界面上可见。
   * 文本取自真实规则文件并定向破坏（不是手搓的假结构）。
   */
export function importBadRuleForDemo(host: DemoHost): void {
    if (!host.rules) return;
    const sample = host.rules.platformSourceText[host.rules.platformId];
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

    const outcome = host.importPlatformText(broken);
    host.rulesDialog?.open();
    host.rulesDialog?.showImportFailure(outcome);
}

  /** 演示/验证用：走真实的宽松 TXT 导入，让「原文缺失」标记可见 */
export function applyDemoLenientText(host: DemoHost): void {
    if (!host.rules?.preset) return;
    const text = '【基本信息】\n姓名：{{char}}\n年龄：24';
    const result = importCardText(host.card, text, host.rules.preset, 'lenient');
    if (!result.card) {
      host.setStatus(`导入被拒绝：${result.issues.map((i) => i.message).join('；')}`, 'bad');
      return;
    }
    host.replaceCard(result.card);
    host.setStatus(
      `宽松导入仅含「基本信息」的 TXT，其余板块按「原文缺失」标记（${String(result.issues.length)} 条提示）`,
      'warn',
    );
}

  /**
   * 演示/截图/端到端入口：用内置样本文本走**真实的导入对话框**（T10.27）。
   *
   * 为什么要这类入口：浏览器直开（截图与 headless 验证就是这么跑的）没有壳能力，
   * 点「打开…」弹不出文件选择器。这里注入的只是**输入文本**，之后的分流、预览、
   * 保全装配、状态栏文案全是生产代码 —— 与 `?demo=lenient` 同一个套路。
   *
   * @param sample 'zero'（0 命中）/ 'mixed'（混合）/ 'clean'（全部标准板块）
   */
export async function importSampleForDemo(host: DemoHost, sample: string): Promise<void> {
    const texts: Record<string, string> = {
      zero: [
        '条目1：这是一段完全自由的设定文本',
        '它没有使用任何【】或 ## 标题，所以整篇都不会被切分。',
        '',
        '条目2：第二段',
        '  缩进与空行都是原文的一部分',
        '',
        '条目3：结尾',
      ].join('\n'),
      mixed: [
        '【基本信息】',
        '姓名：林晚照',
        '年龄：27',
        '',
        '【性格】',
        '冷静，话少。',
        '',
        '## 战斗系统',
        '条目1：先攻按敏捷排序',
        '条目2：暴击倍率 1.5',
        '',
        '【其他设定】',
        '这是已识别到的其他设定内容。',
        '',
        '## 招式表',
        '条目甲：斩击',
        '条目乙：突刺',
      ].join('\n'),
      clean: [
        '【基本信息】',
        '姓名：林晚照',
        '年龄：27',
        '',
        '【性格】',
        '冷静，话少。',
        '',
        '【其他设定】',
        '普通设定。',
        '',
        '【特殊设定】',
        '无。',
        '',
        '【用户相关设定】',
        '{{user}} 是常客。',
      ].join('\n'),
    };
    const text = texts[sample];
    if (text === undefined) return;
    // 零标签时先按文件名建会话 —— 与「打开…」走同一条路径（T10.28）
    if (!host.hasSession) host.createSessionFromFile(`${sample}.txt`);
    await host.importCardTextFile(`${sample}.txt`, text, null, true);
}

  /** 演示/截图入口：只打开导入对话框（不确认），用于截"导入前"那两张图 */
export async function previewSampleForDemo(host: DemoHost, sample: string): Promise<void> {
    if (!host.hasSession) host.createSessionFromFile(`${sample}.txt`);
    const texts: Record<string, string> = {
      zero: '条目1：这是一段完全自由的设定文本\n它没有使用任何【】或 ## 标题，所以整篇都不会被切分。\n\n条目2：第二段\n  缩进与空行都是原文的一部分\n\n条目3：结尾',
      mixed: '【基本信息】\n姓名：林晚照\n年龄：27\n\n【性格】\n冷静，话少。\n\n## 战斗系统\n条目1：先攻按敏捷排序\n条目2：暴击倍率 1.5\n\n【其他设定】\n这是已识别到的其他设定内容。\n\n## 招式表\n条目甲：斩击\n条目乙：突刺',
    };
    const text = texts[sample];
    if (text === undefined) return;
    await host.importDialog?.openCardText(`${sample}.txt`, text);
}

  /**
   * 演示/截图入口：注入一个真实的渲染层异常（T10.26）。
   *
   * 用 `window.dispatchEvent(new ErrorEvent(...))` 而不是 `setTimeout(() => { throw })`：
   * 前者走的就是全局 `error` 钩子，且不会让 headless Chrome 因为未捕获异常
   * 而提前退出（那样 `--dump-dom` 拿不到任何东西）。
   * 落盘在浏览器模式下是 no-op（`isShellAvailable()` 为 false），
   * 所以"日志文件里有记录"这条必须到壳里验 —— 见 scripts/verify-t1026-crash.mjs。
   */
export function injectCrashForDemo(host: DemoHost): void {
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: '模拟异常：Uncaught TypeError: demo is not a function',
        error: new TypeError('demo is not a function'),
      }),
    );
}

  /**
   * 演示/截图入口：把某一个板块的高亮效果单独展示出来（v0.1.3 追加项二）。
   *
   * 为什么不是"打开样例卡再滚过去"：headless Chrome 里 `scrollIntoView` 会让
   * 整块布局下移、上方留一片空白，截出来像布局坏了（v0.1.3 / F4 踩过两次）。
   * 这里改成**只展开目标板块**（其余折叠 → 折叠即销毁编辑器），
   * 页面本身就短，不需要滚动。
   *
   * 内容也是刻意构造的：`worldbook` 要出现 `@@ENTRY` / `keys:` / `@@CONTENT` /
   * `@@END`（否则看不见新增的那 5 条规则），`chat-examples` 要出现 `<START>`，
   * `initial-scene` 要出现多条开场白的分隔行。用样例卡会碰运气。
   */
export function demoHighlightBlock(host: DemoHost, blockId: string): void {
    if (!host.hasSession) host.createSessionFromFile('高亮示例.txt');

    const demoWorldbookText = [
      '@@ENTRY 0',
      'name: 银座',
      'keys: 东京, 银座, 酒吧',
      'insertion_order: 10',
      '@@CONTENT',
      '{{char}} 在这里第一次遇见 {{user}}。',
      '@@END 0',
      '',
      '@@ENTRY 1',
      'name: 旧宅',
      'keys: 旧宅, 老屋',
      '@@CONTENT',
      '木门后面是{{user}}小时候住过的院子。',
      '@@END 1',
    ].join('\n');

    const demoExamples = [
      '<START>',
      '{{user}}: 「今天也不打算说话？」',
      '{{char}}: 「……嗯。」她把手里的书翻过一页。',
      '<START>',
      '{{user}}: 「我带了咖啡。」',
      '{{char}}: （抬头看了一眼）「放那儿吧。」',
    ].join('\n');

    /*
     * 分隔行刻意**两种都放**：`---` 与 `~~~`。
     *
     *   · `---` 会同时命中全局 `hr-line`(priority 80) 与专用 `scene-divider`(78)，
     *     高优先级赢 —— 视觉上仍是分隔线，证明两条规则不打架；
     *   · `~~~` 只有 `scene-divider` 认（`hr-line` 的字符类是 `-=*`），
     *     这是本板块专用规则存在的**唯一可见证据**。
     *
     * 只放 `---` 的话，`scene-divider` 被 `hr-line` 压着，
     * 删掉它截图也一模一样 —— 那样的"验收"等于没验（第一版就是这样）。
     *
     * 切分仍按冻结分隔符 `\n\n---\n\n`：`~~~` 在第二段正文里，不参与切分。
     */
    const demoScene = [
      '{{char}} 推开窗，风把纸页吹得哗啦响。',
      '',
      '---',
      '',
      '「你来得比约定的早。」{{char}} 说。',
      '',
      '~~~',
      '',
      '雨停之后，{{user}} 在门口等到了她。',
    ].join('\n');

    const base = structuredClone(host.card);
    base.blocks = base.blocks.map((block) => {
      if (block.id === 'chat-examples') return { ...block, text: demoExamples, dirty: false };
      if (block.id === 'initial-scene') return { ...block, text: demoScene, dirty: false };
      return block;
    });
    base.worldbook = { ...base.worldbook, text: demoWorldbookText };
    // residual 也一起改：否则下一次校验会按 residual 把视图刷回去，
    // 截图里看到的是"内容变空"而不是演示文本。
    base.residual = {
      ...base.residual,
      mesExample: demoExamples,
      firstMes: demoScene.split('\n\n---\n\n')[0]!,
      alternateGreetings: demoScene.split('\n\n---\n\n').slice(1),
    };
    host.replaceCard(base);

    // 只留目标板块展开：折叠会销毁编辑器，页面于是只剩一块内容
    for (const runtime of host.blocks) {
      if (runtime.snapshot.id === blockId) host.expand(runtime, true);
      else if (runtime.expanded) host.collapse(runtime);
    }
    host.setStatus(`高亮检查：${blockId}（当前方案 ${host.rules?.highlightId ?? '—'}）`, 'info');
}

  /**
   * 演示/截图入口：把规则面板滚到两个新预设区块之一（v0.1.3 追加项一）。
   *
   * ## 为什么滚的是 `.modal` 而不是 window
   *
   * 面板本体是 `.modal`（`max-height: 90vh; overflow: auto`），滚动容器是
   * **它自己**，页面本身不滚。用 `scrollIntoView` 会连带滚动所有可滚祖先
   * （含 window），在 headless 里表现是整块布局下移、上方留一片空白 ——
   * v0.1.3 的 F4 截图为此返工过两次。这里直接改容器的 `scrollTop`，指哪打哪。
   */
export function demoRulesSection(host: DemoHost, section: 'greeting' | 'example'): void {
    const role = section === 'greeting' ? 'greeting-preset-section' : 'chat-example-preset-section';
    const target = document.querySelector<HTMLElement>(`[data-role="${role}"]`);
    if (target === null) return;
    const scroller = target.closest<HTMLElement>('.modal');
    if (scroller === null) return;
    // 目标区块相对滚动容器的偏移（加 scrollTop 是因为 rect 已是"滚动后"的位置）
    const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    // 留 8px 呼吸位，避免标题贴着容器顶边
    scroller.scrollTop = Math.max(0, offset - 8);
}

  /** 演示/截图入口：改名提示（T10.29）。`state` = 'show' 显示 / 'hide' 模拟已点过 */
export function setNameHintForDemo(host: DemoHost, state: 'show' | 'hide'): void {
    if (state === 'hide') {
      dismissNameHint(browserHintStore());
      const hint = byId<HTMLElement>('card-name-hint');
      hint.hidden = true;
      return;
    }
    resetNameHint(browserHintStore());
    host.refreshNameHint();
}
