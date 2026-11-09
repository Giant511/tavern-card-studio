/**
 * 「开场与示例」页（2026-11-05，用户决定 1）。
 *
 * ## 用户要求
 *
 * > 在卡片栏单独加一个 tap 卡片放置开场白和对话示例
 *
 * ## 为什么是这四段字段，而不是两块板块
 *
 * ST 把"一开场就发生的事"拆成三个字段、把"示范怎么说"放第四个：
 *
 * | ST 字段 | 是什么 | 进 prompt | 聊天里用 |
 * |---|---|---|---|
 * | `scenario` | 场景一句话 | ✅ scenario 槽 | — |
 * | `first_mes` | 第一条消息（开场白） | ❌ | ✅ 建新聊天时插入 |
 * | `alternate_greetings` | 备用开场白（数组） | ❌ | 用户可换 |
 * | `mes_example` | 对话示例 | ✅ dialogueExamples 槽 | — |
 *
 * ★ `scenario` 在**整个 `client/src` 里原本零编辑入口**（桌面端也没有）。
 * 它每轮都进 prompt 却没人能改 —— 这一页顺手补上这个缺口。
 *
 * ## ★★★ 为什么必须同屏
 *
 * 用户那张卡自相矛盾：`scenario` 写"旧城区下着小雨…走进「拾光」书店"，
 * 而 `first_mes` 写"夜里十点半，私人健身工作室"。**两个字段说的不是同一个地方。**
 *
 * 这种矛盾只有把两者摆在同一屏才看得见。放进聊天记录里，用户只会看到
 * 健身房那一段，书店那句就永远躺在那儿、每轮还花 25 token 进上下文。
 *
 * ## ★★★ 兼容旧版导出 / 无缝升级（用户决定 5）
 *
 * 三条设计，缺一条就会"打开旧卡就把它改了"：
 *
 * 1. **读的时候不解释、不归一**：`residual` 里是什么就显示什么。
 *    旧版导出的卡（甚至别的工具导出的卡）都能原样打开。
 * 2. **只写改动过的字段**：`changed()` 逐字段比对，没改的一个字节都不碰。
 *    这样"打开看一眼就返回"绝不会改到数据。
 * 3. **保存时整份按**当前**规则重新序列化** —— 这一步就是"无缝升级"：
 *    用户改完保存，产物自动带上当前导出规则（世界书标题落 `comment` 等）。
 *
 * 判据：`test/greeting-page.test.mjs`。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';
import { fieldRow } from './field-row.ts';
import { buildTopbar } from './chat-settings.ts';

/** 这一页要编辑的四段内容 */
export interface GreetingDraft {
  scenario: string;
  firstMes: string;
  alternateGreetings: string[];
  mesExample: string;
}

export interface GreetingCharacter {
  avatar: string;
  name: string;
}

export interface GreetingPageState {
  /** 可选角色（来自引擎） */
  characters: GreetingCharacter[];
  /** 正在编辑哪个角色的卡片文件；`null` = 还没选 */
  selected: string | null;
  /** 选中角色的当前内容 */
  draft: GreetingDraft;
  /** 载入中（角色列表或卡片内容） */
  loading: boolean;
  /** 载入失败原因（空串 = 没有） */
  error: string;
  /**
   * 载入时四段内容的**指纹**。
   *
   * 用它判"有没有改动"而不是逐字段比 —— 后者要求每个字段各写一遍比较，
   * 加第五个字段时必然漏一处，于是"没改也说改了"或"改了说没改"。
   */
  baseline: string;
  /**
   * 刚保存过（2026-11-06，用户问题「保存后没有提示」）。
   *
   * ★ 为什么不能只靠顶部的通知条：通知挂在 `.nb-topbar` 里，
   *   而保存成功后这一页会**整页重绘**（`pageHost.replaceChildren()`
   *   连 topbar 一起删）⇒ 通知跟着消失，用户什么都看不到。
   *
   * 所以反馈做在**按钮自己**身上：它就在用户刚点的地方，
   * 且 `renderGreetingPage` 每次重绘都会按这个标记重新画成"已保存 ✓"。
   * 通知是补充，不是唯一手段。
   */
  savedFlash: boolean;
}

export interface GreetingPageCallbacks {
  /** 返回：有选中 → 回角色列表；没选中 → 回「卡片」页 */
  onBack: () => void;
  /** 选一个角色开始编辑 */
  onSelect: (avatar: string) => void;
  /** 改了某几段（部分更新） */
  onChange: (patch: Partial<GreetingDraft>) => void;
  /** 新增一条备用开场白 */
  onAddAlternate: () => void;
  /** 删掉第 N 条备用开场白 */
  onRemoveAlternate: (index: number) => void;
  /** 保存 */
  onSave: () => void;
}

/** 空草稿（也用于"还没选中角色"时占位） */
export function emptyGreetingDraft(): GreetingDraft {
  return { scenario: '', firstMes: '', alternateGreetings: [], mesExample: '' };
}

/**
 * 页面初始状态（外壳持有它）。
 *
 * `baseline` 用空草稿的指纹而不是空串：这样"还没选角色"时
 * `hasGreetingChanges()` 也是 `false`，按钮不会一进来就显示"保存到卡片"。
 */
export function emptyGreetingPageState(): GreetingPageState {
  const draft = emptyGreetingDraft();
  return {
    characters: [],
    selected: null,
    draft,
    loading: false,
    error: '',
    baseline: greetingFingerprint(draft),
    savedFlash: false,
  };
}

/**
 * 四段内容的指纹。
 *
 * 用 `\u0000` 当分隔符而不是 `|` / `,`：那两种字符在正常文本里会出现
 * （用户会在开场白里写竖线），拼起来可能让两份不同的内容算出同一个指纹。
 */
export function greetingFingerprint(draft: GreetingDraft): string {
  return [
    draft.scenario,
    draft.firstMes,
    draft.alternateGreetings.join('\u0000'),
    draft.mesExample,
  ].join('\u0001');
}

/** 有没有未保存的改动 */
export function hasGreetingChanges(state: GreetingPageState): boolean {
  return greetingFingerprint(state.draft) !== state.baseline;
}

/** 造一个多行输入框 */
function textArea(doc: DocLike, role: string, rows: number, placeholder: string): ElLike {
  const node = el(doc, 'textarea', 'nb-input nb-textarea');
  node.setAttribute('data-role', role);
  node.setAttribute('rows', String(rows));
  node.setAttribute('placeholder', placeholder);
  return node;
}

function readValue(node: ElLike): string {
  const value = (node as unknown as { value?: unknown }).value;
  return typeof value === 'string' ? value : '';
}

/**
 * 写输入框的值。
 *
 * `ElLike` 刻意没有声明 `value`（见 `chat-view.ts` 的接口注释：声明面越小，
 * Node 里的 DOM stub 越好写）。所以这里显式断言一次 —— 项目里其它页面
 * （`worldbook-page.ts` / `persona-page.ts`）也是这个写法，保持一致。
 */
function setValue(node: ElLike, text: string): void {
  (node as unknown as { value: string }).value = text;
}

export function renderGreetingPage(
  doc: DocLike,
  state: GreetingPageState,
  callbacks: GreetingPageCallbacks,
): ElLike {
  const root = el(doc, 'div', 'nb-page nb-greeting');
  root.setAttribute('data-role', 'greeting-page');

  const title = state.selected === null ? '开场与示例' : '开场与示例';
  root.append(buildTopbar(doc, title, callbacks.onBack));

  const scroller = el(doc, 'div', 'nb-scroll');
  root.append(scroller);
  const list = el(doc, 'div', 'nb-list');
  scroller.append(list);

  /* ── 载入中 / 失败 ── */
  if (state.loading) {
    const wait = el(doc, 'p', 'nb-note');
    wait.setAttribute('data-role', 'greeting-loading');
    wait.textContent = '正在读取…';
    list.append(wait);
    return root;
  }

  if (state.error !== '') {
    const bad = el(doc, 'p', 'nb-note');
    bad.setAttribute('data-role', 'greeting-error');
    bad.setAttribute('data-kind', 'warn');
    bad.textContent = state.error;
    list.append(bad);
    return root;
  }

  if (state.characters.length === 0) {
    const empty = el(doc, 'p', 'nb-note');
    empty.setAttribute('data-role', 'greeting-empty');
    empty.textContent = '还角色库里还没有角色。先导入一张卡，再回来改它的开场。';
    list.append(empty);
    return root;
  }

  /* ═══ 第一步：选角色 ═══ */
  if (state.selected === null) {
    const head = el(doc, 'div', 'nb-settings-group');
    head.textContent = '选一个角色';
    list.append(head);

    const hint = el(doc, 'p', 'nb-note');
    hint.textContent = '改的是卡片本身，不是某一次聊天。改完所有新对话都用新的开场。';
    list.append(hint);

    for (const one of state.characters) {
      const row = el(doc, 'button', 'nb-listitem');
      row.setAttribute('type', 'button');
      row.setAttribute('data-role', 'greeting-character');
      row.setAttribute('data-avatar', one.avatar);

      const main = el(doc, 'span', 'nb-listitem-main');
      const name = el(doc, 'span', 'nb-listitem-title');
      name.textContent = one.name;
      main.append(name);

      const chevron = el(doc, 'span', 'nb-src-chevron');
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '›';

      row.append(main, chevron);
      row.addEventListener('click', () => callbacks.onSelect(one.avatar));
      list.append(row);
    }
    return root;
  }

  /* ═══ 第二步：编辑四段 ═══ */
  const current = state.characters.find((one) => one.avatar === state.selected);
  const who = el(doc, 'div', 'nb-settings-group');
  who.textContent = current === undefined ? '当前角色' : current.name;
  list.append(who);

  /*
   * 一段说明，讲清"这几个字段在 ST 里分别管什么"。
   *
   * 不写"为什么不支持"这类开发话术（§23 文案红线）——
   * 只写用户**知道了能做什么**的东西：哪一段会进模型、哪一段会出现在聊天里。
   */
  const guide = el(doc, 'p', 'nb-note');
  guide.textContent =
    '场景与对话示例每轮都会发给模型；开场白不进模型，它是新对话的第一条消息。';
  list.append(guide);

  /* ① 场景 */
  const scenarioField = fieldRow(doc, '场景', '一句话说清"现在是什么时候、在哪里"。会进模型。');
  const scenario = textArea(doc, 'greeting-scenario', 3, '例如：深秋的午后，旧城区下着小雨。');
  setValue(scenario, state.draft.scenario);
  scenario.addEventListener('input', () => callbacks.onChange({ scenario: readValue(scenario) }));
  scenarioField.body.append(scenario);
  list.append(scenarioField.row);

  /* ② 开场白 */
  const firstField = fieldRow(
    doc,
    '开场白',
    '新对话的第一条消息。空着的话，开始聊天会是一片空白。',
  );
  const firstMes = textArea(doc, 'greeting-first-mes', 8, '（角色说的第一段话）');
  setValue(firstMes, state.draft.firstMes);
  firstMes.addEventListener('input', () => callbacks.onChange({ firstMes: readValue(firstMes) }));
  firstField.body.append(firstMes);
  list.append(firstField.row);

  /* ③ 备用开场白 */
  const altHead = el(doc, 'div', 'nb-settings-group');
  altHead.textContent = '备用开场白';
  list.append(altHead);

  const altNote = el(doc, 'p', 'nb-note');
  altNote.textContent =
    state.draft.alternateGreetings.length === 0
      ? '还没有备用开场。加一条就能换个开局重来。'
      : '每条都是另一套开局：第一段是默认，其余可以随时换。';
  list.append(altNote);

  state.draft.alternateGreetings.forEach((text, index) => {
    const field = fieldRow(doc, `备用 ${String(index + 1)}`);
    const area = textArea(doc, `greeting-alternate-${String(index)}`, 6, '（另一套开局）');
    setValue(area, text);
    area.addEventListener('input', () => {
      const next = [...state.draft.alternateGreetings];
      next[index] = readValue(area);
      callbacks.onChange({ alternateGreetings: next });
    });
    field.body.append(area);
    list.append(field.row);
  });

  const addAlt = el(doc, 'button', 'nb-btn');
  addAlt.setAttribute('type', 'button');
  addAlt.setAttribute('data-role', 'greeting-add-alternate');
  addAlt.textContent = '＋ 加一条备用开场';
  addAlt.addEventListener('click', () => callbacks.onAddAlternate());
  list.append(addAlt);

  /* ④ 对话示例 */
  const exampleHead = el(doc, 'div', 'nb-settings-group');
  exampleHead.textContent = '对话示例';
  list.append(exampleHead);

  /*
   * ★ 这一段说明是本轮"对齐 ST"的落点之一。
   *
   * ST 认的是「每块以 <START> 开头、说话人行用半角冒号」。用户从别的平台
   * 搬过来时最常见的就是写「用户：」「角色：」（全角冒号），而 ST 匹配不到
   * 说话人就会**把整块静默丢掉** —— 界面上什么都看不出来。
   *
   * 所以这行提示必须给出"该怎么写"的具体样子，而不是"请遵守格式"。
   */
  const exampleNote = el(doc, 'p', 'nb-note');
  exampleNote.textContent =
    '每段示例以 <START> 单独一行开头，说话人写成 {{user}}: 和 {{char}}:（冒号用半角）。这样模型才分得清谁在说。';
  list.append(exampleNote);

  const exampleField = fieldRow(doc, '示例对话', '会进模型，用来示范说话风格与互动节奏。');
  const example = textArea(doc, 'greeting-mes-example', 12, '<START>\n{{user}}: …\n{{char}}: …');
  setValue(example, state.draft.mesExample);
  example.addEventListener('input', () => callbacks.onChange({ mesExample: readValue(example) }));
  exampleField.body.append(example);
  list.append(exampleField.row);

  /* ⑤ 保存 */
  const changed = hasGreetingChanges(state);
  /*
   * ★ 三种形态（2026-11-06，用户问题①「保存后没有提示」）：
   *
   * ```text
   *   有改动        保存到卡片      主按钮，可点
   *   刚保存成功     已保存 ✓       绿色 + done 态，不可点（2 秒后自动回落）
   *   无改动        没有改动        普通按钮，禁用
   * ```
   *
   * 为什么"已保存"必须停在按钮上：保存成功后整页会重绘，
   * 顶部通知挂在 topbar 里、被一起删掉（那是真机看不到提示的真因）。
   * 按钮在用户刚点的地方，跑不掉。
   */
  const justSaved = state.savedFlash && !changed;
  const saveClass = changed
    ? 'nb-btn nb-btn--primary'
    : justSaved
      ? 'nb-btn nb-btn--primary'
      : 'nb-btn';
  const save = el(doc, 'button', saveClass);
  save.setAttribute('type', 'button');
  save.setAttribute('data-role', 'greeting-save');
  save.setAttribute('data-changed', String(changed));
  if (justSaved) save.setAttribute('data-state', 'done');
  save.textContent = changed ? '保存到卡片' : justSaved ? '已保存 ✓' : '没有改动';
  /*
   * 没改动时**禁用**而不是"点了没反应"：点了没反应用户会以为保存失败。
   * 复位用 `disabled` 属性本身（布尔属性存在即生效，不能用空串复位）。
   *
   * "已保存"那一刻同样禁用 —— 内容已经落盘，再点一次是空操作。
   */
  if (!changed) save.setAttribute('disabled', '');
  save.addEventListener('click', () => {
    if (!hasGreetingChanges(state)) return;
    callbacks.onSave();
  });
  list.append(save);

  return root;
}
