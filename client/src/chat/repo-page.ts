/**
 * 「仓库」Tab（2026-11-04，T15.2 阶段 A；同日合并服务端配置到同一页）。
 *
 * ## 用户要求（2026-11-04 追加）
 *
 * > 自定义和内置云仓库应该在**同一个页面**处理，使用下拉选项进行选择，
 * > 选择自定义就出现服务端地址栏，用户名、密码以及登录注册按钮
 * > （http 不安全说明也得弹出来，如果是自签证书也要在连接的过程中提示是不信任的证书）；
 * > 选择内置云仓库就出现用户名、密码、邀请码（找开发者获取邀请码也要有哈，
 * > 且填写栏里面提示仅注册的时候才填写，登录不需要填写）以及登录注册按钮
 * > （支持注册后自动登录）
 *
 * > 内置云仓库的 URL 不要暴露给用户
 *
 * ## 页面结构（一页到底）
 *
 * ```text
 *   服务端
 *     [下拉] 内置云仓库 / 自定义仓库
 *       内置  → 只显示一句邀请码说明（**不显示地址**）
 *       自定义 → 服务端地址输入框（**没有预览行**，填错了提交时提示）
 *   账户
 *     未登录 → 用户名 / 密码 / [邀请码，仅内置] / 登录 · 注册
 *     已登录 → 已登录：xxx / 登出
 *   仓库里的卡片（仅已登录）
 * ```
 *
 * ## 为什么合并成"一页到底"
 *
 * 原来是"仓库页 → 点服务端 → 配置页 → 返回"。而换服务端**必然紧接着要登录**
 * （令牌是那台机器签发的），拆两页等于让用户为了做一件连续的事来回跳。
 * 而且下拉一改字段就变，比"进二级页才知道有哪些字段"更直观。
 *
 * ## 这一页只做「编排」
 *
 * 所有网络调用都通过注入的回调（外壳里接 `auth-client` / `repo-client` /
 * `server-sync` 的现成函数）。这里**一行 fetch 都不写**。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';
import { makeSelectTrigger } from './select-popover.ts';
import { makeAvatar } from './avatar.ts';
import { describeBridgeError } from '@tcs/shared';
import {
  CLOUD_INVITE_HINT,
  PLAIN_HTTP_RISK_BODY,
  PLAIN_HTTP_RISK_TITLE,
  needsPlainHttpAck,
  resolveRepoOrigin,
  type RepoConfigState,
} from '@tcs/shared';

/** 仓库页当前状态（由外壳算好传进来） */
/**
 * 与服务端的**连通**状态（2026-11-06，用户要求常驻指示灯）。
 *
 * ## 为什么和"是否登录"是两个维度
 *
 * ```text
 *           已登录              未登录
 *   在线    能用全部功能        能连上，只差登录（401 就是这一格）
 *   离线    令牌照样有，但用不了  连不上
 * ```
 *
 * 用户问的是"连上服务器没有"，**不是"登录没有"**。所以：
 *
 * ★ **`401` / `403` 一律算「在线」** —— 服务器回话了，只是不认这个身份。
 *   把它算成离线是最容易犯的错：用户明明是密码输错，
 *   却看到红灯说"连不上"，去查网络查地址，全都白费。
 */
export type RepoLinkState = 'unknown' | 'checking' | 'online' | 'offline';

export interface RepoStatus {
  /** 持久化过的服务端配置 */
  config: RepoConfigState;
  /** 账户名；未登录时 null */
  username: string | null;
  /** 登录态是否已过期 */
  expired: boolean;
  /** 当前是否在用仓库令牌（而非账户登录） */
  repoTokenMode: boolean;

  /* ── 连通状态（由外壳持有，**跨页面存活**）── */
  /**
   * 连通状态。`unknown` = 还没探测过。
   *
   * ★ 必须由外壳持有，不能放在页面闭包里 —— 页面每次切 Tab 都会重建，
   * 放页面里就是"切回来又变回未知、又得重新连一次"。
   */
  link: RepoLinkState;
  /** 补充说明（离线原因 / 在线时的额外信息）。空串表示没什么可说的 */
  linkDetail: string;
  /** 上次探测完成的时间戳，0 = 从没探测过 */
  linkCheckedAt: number;
}

/**
 * 一个仓库（一级列表项，2026-11-06）。
 *
 * ★ 只带**展示需要的字段**，不是服务端 `RepoSummary` 的镜像 ——
 * 页面不该知道 `createdAt` 这类它不显示的东西，否则以后加字段时
 * 会不自觉地把它塞进 UI。
 */
export interface RepoRow {
  id: string;
  name: string;
  description: string;
  /** 这个仓库里有多少张卡 */
  cardCount: number;
  /** 上传时不指定仓库会落到它上面 */
  isDefault: boolean;
}

/** 一个历史版本 */
export interface RepoVersionRow {
  seq: number;
  commit: string;
  createdAt: string;
  /** 内容已被清理时为 null */
  sha256: string | null;
  message: string;
}

export interface RepoPageCallbacks {
  /**
   * 服务端配置变了（切换类型 / 改地址并确认风险）。
   *
   * 外壳负责：持久化 + **origin 变了就清登录态** + 重设自签白名单。
   */
  onConfigChange: (next: RepoConfigState) => Promise<void>;
  /** 登录。配置随调用一起给出 —— 用户可能是刚改完地址就点登录 */
  onLogin: (config: RepoConfigState, username: string, password: string) => Promise<void>;
  /** 注册（邀请码仅内置云仓库；成功后自动登录由外壳负责） */
  onRegister: (
    config: RepoConfigState,
    username: string,
    password: string,
    inviteCode: string,
  ) => Promise<void>;
  onLogout: () => Promise<void>;
  /**
   * 探测一次与服务端的连通性（2026-11-06，常驻指示灯用）。
   *
   * ★ 与 `onRefreshCards` 分开，**不许合并**：
   *
   * ```text
   *   探测连通   打最轻的端点（/version），不要求登录，401 也算通
   *   拉卡片列表 要登录，要解析几十条数据
   * ```
   *
   * 合并的后果：未登录时探不出"通"（列表必然 401 失败），
   * 于是明明连得上也亮红灯；而且每次点指示灯都要拉一遍全量列表。
   */
  onProbeLink: () => Promise<{ state: RepoLinkState; detail: string }>;
  /**
   * 上一次拉到的卡片列表（同步返回）。
   *
   * ## 为什么需要这个
   *
   * 用户：
   *
   * > 切到其他地方不丢失连接，切回来不需要重新连接服务器。
   *
   * 页面每次切 Tab 都会重建（这是转场架构决定的，不能改）。
   * 重建时如果只能"先转圈再拉"，切回来那一下就是一次重新连接 ——
   * 服务端慢的话要盯着空列表等。
   *
   * 所以外壳把上次的列表留着，进页面时**先画出来**，再后台悄悄刷新。
   * 返回空数组就表示没缓存（首次进入），照常走"正在读取"。
   */

  /* ── 仓库列表（一级，2026-11-06）── */
  /**
   * 拉服务端的仓库列表。
   *
   * 用户：
   *
   * > 登录后按照仓库列表做展示（多仓库的情况下）
   *
   * ★ 这是**一级**页面的内容，点某个仓库才进二级（卡片列表）。
   *   原来是"一页到底"，所有卡片混在一个列表里。
   */
  onListRepos: () => Promise<RepoRow[]>;
  /**
   * 上次拉到的仓库列表（同步返回，空数组 = 没缓存）。
   *
   * 与 `onCachedCards` 同理：切回这一页时先有内容可看，不重新连。
   */
  onCachedRepos: () => RepoRow[];
  /** 点某个仓库：进二级 */
  onOpenRepo: (repoId: string, repoName: string) => void;

  /**
   * 「刷新」按钮（2026-11-07，用户要求）。
   *
   * ## 用户的原话
   *
   * > 解决方案有两个，一个是加一个刷新按钮，一个就是安卓端自动刷新，
   * > 我的建议是加一个刷新按钮，后续如果新增的仓库点刷新，
   * > 可以重新获取仓库情况
   *
   * ## 为什么要这个按钮（自动续期不是已经做了吗）
   *
   * 自动续期解决的是"令牌过期"，但解决不了这两件事：
   *
   * ```text
   *   别人刚建了一个新仓库         ⇒ 我的列表里没有，只能杀进程重进
   *   卡片数变了（别处上传过）      ⇒ 列表上的数字是旧的
   *   网络刚恢复，页面还挂着上次的错误 ⇒ 用户需要一个"再试一次"
   * ```
   *
   * 所以按钮的职责是"**重新获取仓库情况**"（用户原话），
   * 顺带也会走一次令牌续期 —— 两个问题一起解决。
   *
   * 返回值给页面自己决定要不要重画（成功/失败都要有反馈）。
   */
  onRefresh: () => Promise<void>;

  onPickLocalCard: () => Promise<Array<{ avatar: string; name: string }>>;
  /** 取角色头像缩略图（data URL）。取不到返回 null，头像退回首字占位圆 */
  onThumbnail: (avatar: string) => Promise<string | null>;
  onUpload: (avatar: string) => Promise<{ created: boolean; seq: number }>;
  onLoadVersions: (cardId: string) => Promise<RepoVersionRow[]>;
  onRollback: (cardId: string, seq: number) => Promise<void>;
  /**
   * 把某一版下载成本地角色卡（2026-11-04，用户要求）。
   *
   * 与 `onRollback` 是两件事，别混：
   * - `onImportVersion`：把这一版**取到手机上**，成为一张新卡
   * - `onRollback`：把这一版**变成仓库里的最新版**（不动手机）
   */
  onImportVersion: (cardId: string, seq: number) => Promise<void>;
  onDeleteCard: (cardId: string) => Promise<void>;
  onNotify: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
}

const KIND_OPTIONS = [
  { value: 'cloud', label: '内置云仓库' },
  { value: 'custom', label: '自定义仓库' },
];

/**
 * 三种非「在线」状态的文案。
 *
 * ★ `unknown` 不写「未知」—— 用户不知道"未知"是自己的问题还是软件的。
 * 写「未检测」是在说"还没试过"，下一步该做什么更清楚。
 *
 * ★ 在线态的文案**不在这里** —— 它还要看登录态，见 `linkLabel()`。
 */
const LINK_LOOK: Record<Exclude<RepoLinkState, 'online'>, string> = {
  unknown: '未检测',
  checking: '检测中',
  offline: '连不上',
};

/**
 * 指示灯的文案（2026-11-06 第二版：绿灯加「已登录」语义）。
 *
 * ## 为什么绿灯要分两种
 *
 * 第一版绿灯只说「已连接」，而仓库页最常出现的两种状态都是绿的：
 *
 * ```text
 *   连上了，没登录   ← 能连，但上传/看历史都用不了
 *   连上了，已登录   ← 全功能可用
 * ```
 *
 * 都用「已连接」表达，用户看不出"我现在到底是不是登录着"——
 * 而那正是他下一步动作的依据（要不要去填账号密码）。
 *
 * ## 优先级：连通 > 登录
 *
 * ```text
 *   连不上           ⇒ 「连不上」（红）   服务器都没了，登录态没意义
 *   检测中           ⇒ 「检测中」（黄）
 *   未检测           ⇒ 「未检测」（灰）
 *   在线 + 已登录     ⇒ 「已登录」（绿）
 *   在线 + 未登录     ⇒ 「未登录」（绿）
 * ```
 *
 * ★ 已登录但连不上时显示「连不上」而不是「已登录」：
 *   前者是可操作的信息（查网络/换地址），后者只会让人以为一切正常。
 *
 * ## 为什么绿灯未登录时写「未登录」而不是「已连接」
 *
 * 用户 2026-11-06 第二次调整：
 *
 * > 已连接的文案改成未登录更符合一点
 *
 * 对。绿灯的两种状态里，用户真正关心的是**"我还要不要登录"**：
 *
 * ```text
 *   「已连接」  只说了"网络通了"   —— 用户不知道接下来要干什么
 *   「未登录」  直接说"你还没登录"  —— 下一步动作一目了然
 * ```
 *
 * 而"能连上"这件事已经由**绿灯的颜色**表达了，文字不必再重复一遍 ——
 * 颜色说连通，文字说身份，各管一头，信息量最大。
 */
function linkLabel(state: RepoLinkState, loggedIn: boolean): string {
  if (state === 'online') return loggedIn ? '已登录' : '未登录';
  return LINK_LOOK[state];
}

/** 分组标题 */
function groupTitle(doc: DocLike, text: string): ElLike {
  const head = el(doc, 'div', 'nb-settings-group');
  head.textContent = text;
  return head;
}

/** 字段行（标签 + 控件 + 可选说明） */
function fieldRow(doc: DocLike, labelText: string): { row: ElLike; body: ElLike } {
  const row = el(doc, 'div', 'nb-field');
  const label = el(doc, 'label', 'nb-field-label');
  label.textContent = labelText;
  const body = el(doc, 'div', 'nb-field-body');
  row.append(label, body);
  return { row, body };
}

/** 输入框 */
function textInput(doc: DocLike, role: string, placeholder: string, type = 'text'): ElLike {
  const input = el(doc, 'input', 'nb-input');
  input.setAttribute('type', type);
  input.setAttribute('data-role', role);
  input.setAttribute('placeholder', placeholder);
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('spellcheck', 'false');
  return input;
}

/**
 * 把任何抛出来的东西变成一句能给用户看的话。
 *
 * ## 为什么不能写 `error instanceof Error ? error.message : String(error)`
 *
 * 真机踩过：仓库下载导入失败时，提示条上显示的是 **`[object Object]`**。
 *
 * 原因是 Tauri 的 `invoke` 失败时抛出的是**普通对象**
 * `{ code, message, details }`，不是 `Error` 实例 ——
 * `instanceof Error` 为假，走到 `String(obj)`，而对象转字符串就是
 * `[object Object]`，把唯一有用的 `message` 丢了。
 *
 * 用户看到"操作失败：[object Object]"等于什么都没说。
 *
 * 统一走 `describeBridgeError`：它认得字符串 / Error / `{code,message}` /
 * 其他对象（用 JSON 兜底），是全项目唯一一处"把错误翻译成人话"的地方。
 */
function describe(error: unknown): string {
  return describeBridgeError(error).message;
}

/** 从输入框读值 */
function valueOf(input: ElLike): string {
  return (input as unknown as HTMLInputElement).value ?? '';
}

/** 往输入框写值（绕过框架的 value setter，让 DOM 真的更新） */
function setValue(input: ElLike, value: string): void {
  const node = input as unknown as HTMLInputElement;
  const proto = node.type === 'password' || node.type === 'text' ? HTMLInputElement.prototype : null;
  const desc = proto === null ? undefined : Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set !== undefined) desc.set.call(node, value);
  else node.value = value;
}

export function renderRepoPage(
  doc: DocLike,
  status: RepoStatus,
  callbacks: RepoPageCallbacks,
): ElLike {
  const root = el(doc, 'div', 'nb-page nb-repo');
  root.setAttribute('data-role', 'repo-page');

  const topbar = el(doc, 'div', 'nb-topbar');
  const title = el(doc, 'h1', 'nb-topbar-title');
  title.textContent = '仓库';
  topbar.append(title);

  /*
   * ═══════════════════════════════════════════════════════════
     常驻连通指示灯（2026-11-06，用户要求）
     ═══════════════════════════════════════════════════════════

     用户原话：

     > 可以在仓库里面加常驻的图标用来指示是否连上服务器，比如连上就是
     > 绿色，没连上就是红色，**不影响页面的其他按钮**

     所以放在**标题栏右侧**（`.nb-topbar-title` 是 `flex: 1`，天然让出右侧），
     而不是浮在内容上的角标 —— 浮层会挡住滚动内容，还可能吃掉点击。

     ## 为什么颜色之外还要有文字
     ```text
       红绿两色         红绿色盲（男性约 8%）分不出
       只有一个圆点      看得见但读不出"到底怎么了"
     ```
     所以：**圆点给颜色，文字给身份**。

     文字一共五种，全部 ≤3 个字（不会挤掉标题）：

     ```text
       已登录 / 未登录    绿灯 —— 连通性好，区别在身份
       连不上             红灯
       检测中             黄灯
       未检测             灰灯（含"地址还没填"）
     ```

     ★ 「已登录 / 未登录」说的是**身份**，「连不上 / 检测中」说的是**连通**。
       两件事各用一个维度表达：颜色管连通，文字管身份 —— 信息量最大且互不重复。

     ## 为什么还要能点
     连不上时用户的第一反应是"重试"。不给可点的入口，他只能切走再切回 ——
     那反而是我们想避免的动作。点一下重新探测，成本最低。
     */
  const linkPill = el(doc, 'button', 'nb-repo-link');
  linkPill.setAttribute('type', 'button');
  linkPill.setAttribute('data-role', 'repo-link');

  const linkDot = el(doc, 'span', 'nb-repo-link-dot');
  linkDot.setAttribute('aria-hidden', 'true');
  const linkText = el(doc, 'span', 'nb-repo-link-text');
  linkPill.append(linkDot, linkText);
  topbar.append(linkPill);

  /**
   * 把状态画到指示灯上（幂等，可以反复调）。
   *
   * `loggedIn` 默认读 `status.username` —— 它来自外壳的**当前**登录态，
   * 不是页面自己猜的。登录/登出成功后外壳会 `renderPage()`，
   * 所以重画出来的指示灯自然是对的。
   */
  const paintLink = (
    state: RepoLinkState,
    detail: string,
    loggedIn: boolean = status.username !== null,
  ): void => {
    const label = linkLabel(state, loggedIn);
    linkPill.setAttribute('data-state', state);
    linkText.textContent = label;

    /*
     * 已登录时把用户名带进无障碍描述 —— 文字太短放不下（按钮只有 60 多 px），
     * 但读屏/长按提示里应该能知道"登的是哪个账号"。
     */
    const who = loggedIn && status.username !== null ? `账号 ${status.username}` : '';
    const parts = [label, who, detail].filter((one) => one !== '');
    const full = parts.join('：');

    linkPill.setAttribute('aria-label', full);
    if (detail !== '' || who !== '') linkPill.setAttribute('title', full.replace(/：/g, ' · '));
    else linkPill.removeAttribute('title');
    linkPill.removeAttribute('disabled');
  };

  paintLink(status.link, status.linkDetail);

  root.append(topbar);

  const scroller = el(doc, 'div', 'nb-scroll');
  root.append(scroller);
  const list = el(doc, 'div', 'nb-list');
  scroller.append(list);

  /** 工作副本：改动先落在这里，连接/切换时才交给外壳 */
  let draft: RepoConfigState = { ...status.config, trustedCertOrigins: [...status.config.trustedCertOrigins] };

  /** 表单值跨重绘保留（切换类型时会重画） */
  let username = status.username ?? '';
  let password = '';
  let inviteCode = '';

  /** 卡片区宿主（重绘时复用，避免每次重建都重新拉一遍） */
  let cardsHost: ElLike | null = null;
  /** 一级的仓库列表容器（2026-11-06） */
  let reposHost: ElLike | null = null;
  /**
   * "标脏并重拉仓库列表"的钩子。
   *
   * 只在渲染出仓库列表之后才被赋值 —— 上传动作发生在这之前时它是
   * 空操作，那不是漏（列表还没画，本来也没东西可刷）。
   */
  let markReposStale: () => void = () => {};
  let cardsLoaded = false;

  /* ═══ 明文风险确认框 ═══ */
  const askPlainHttpRisk = (origin: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const overlay = el(doc, 'div', 'nb-exit-overlay');
      overlay.setAttribute('data-role', 'repo-http-risk-dialog');

      const card = el(doc, 'div', 'nb-exit-card');
      const t = el(doc, 'p', 'nb-exit-title');
      t.textContent = PLAIN_HTTP_RISK_TITLE;

      const body = el(doc, 'p', 'nb-exit-subtitle');
      body.textContent = PLAIN_HTTP_RISK_BODY;

      /* 把具体地址写出来 —— 抽象的"明文"不如"这台机器是明文"有说服力 */
      const target = el(doc, 'p', 'nb-note');
      target.setAttribute('data-role', 'repo-http-risk-target');
      target.textContent = origin;

      const actions = el(doc, 'div', 'nb-exit-actions');
      const go = el(doc, 'button', 'nb-exit-leave');
      go.setAttribute('type', 'button');
      go.setAttribute('data-role', 'repo-http-risk-continue');
      go.textContent = '我了解风险，继续';

      const back = el(doc, 'button', 'nb-exit-stay');
      back.setAttribute('type', 'button');
      back.setAttribute('data-role', 'repo-http-risk-cancel');
      back.textContent = '换一个地址';

      const finish = (v: boolean): void => {
        overlay.remove();
        resolve(v);
      };
      go.addEventListener('click', () => finish(true));
      back.addEventListener('click', () => finish(false));
      overlay.addEventListener('click', (event) => {
        if ((event as { target?: unknown }).target === overlay) finish(false);
      });

      actions.append(go, back);
      card.append(t, body, target, actions);
      overlay.append(card);
      root.append(overlay);
    });

  /**
   * 把当前草稿过一遍所有闸门，返回"可以拿去连接"的配置。
   *
   * 三道闸门按顺序：
   * 1. 地址能解析（自定义模式）
   * 2. 明文 http 需要用户确认（确认后写进 `ackedPlainOrigin`）
   * 3. 证书不受信任 —— **不在这里**，由外壳在请求失败时弹（它才看得到错误）
   *
   * @returns null = 用户取消 / 地址非法，调用方应中止
   */
  const gateDraft = async (): Promise<RepoConfigState | null> => {
    const resolved = resolveRepoOrigin(draft);
    if (!resolved.ok) {
      callbacks.onNotify(resolved.reason, 'warn');
      return null;
    }

    if (needsPlainHttpAck(draft, resolved.address.origin)) {
      const confirmed = await askPlainHttpRisk(resolved.address.origin);
      if (!confirmed) return null;
      /*
       * 存归一化后的 origin —— 换个写法（大小写 / 尾斜线）不会重复问，
       * 换台机器一定重问。
       */
      draft = { ...draft, ackedPlainOrigin: resolved.address.origin };
    }

    return draft;
  };

  /**
   * 连接前先把配置交给外壳（持久化 + 必要时清登录态）。
   *
   * ## 为什么"先存配置再连接"
   *
   * 外壳的 `repoOrigin()` 读的是**它自己那份** `repoConfig`。
   * 不先同步的话，登录会打到上一次保存的地址上 ——
   * 而用户刚刚明明改了地址，现象是"我填的新地址没生效"。
   */
  const commitThen = async (action: (config: RepoConfigState) => Promise<void>): Promise<void> => {
    const gated = await gateDraft();
    if (gated === null) return;

    try {
      await callbacks.onConfigChange(gated);
    } catch (error) {
      callbacks.onNotify(describe(error), 'danger');
      return;
    }

    try {
      await action(gated);
    } catch (error) {
      callbacks.onNotify(describe(error), 'danger');
    }
  };

  /* ═══ 页面绘制 ═══ */
  const paint = (): void => {
    list.replaceChildren();
    cardsHost = null;
    cardsLoaded = false;

    /* ── ① 服务端 ── */
    list.append(groupTitle(doc, '服务端'));

    const kindField = fieldRow(doc, '仓库类型');
    const kindSelect = makeSelectTrigger(doc, {
      label: '仓库类型',
      options: KIND_OPTIONS,
      current: draft.kind,
      onPick: (value) => {
        const kind = value === 'custom' ? 'custom' : 'cloud';
        if (kind === draft.kind) return;
        draft = { ...draft, kind };
        /*
         * 切换类型**立刻持久化**。
         *
         * 它不需要校验（cloud 地址固定；custom 的地址在登录时才验），
         * 而用户切完就去填账号了 —— 等到登录才存会让"我选了自定义"
         * 这件事在重启后丢失。
         */
        void (async () => {
          try {
            await callbacks.onConfigChange(draft);
          } catch (error) {
            callbacks.onNotify(describe(error), 'danger');
          }
          paint();
        })();
      },
    }).el;
    kindSelect.setAttribute('data-role', 'repo-kind');
    kindField.body.append(kindSelect);
    list.append(kindField.row);

    if (draft.kind === 'cloud') {
      /*
       * ★ 内置云仓库**不显示地址**（用户明令：URL 不要暴露给用户）。
       *
       * 用户不需要知道它连到哪台机器 —— 他要的是"能用"。把域名和端口
       * 摆在界面上只会引出"这是谁的服务器""我能不能改"这类与任务无关的问题。
       *
       * 留一句说明：要注册得找开发者拿邀请码。这是**用户唯一需要知道的
       * 前置条件**，不写的话他会卡在注册页反复试。
       */
      const hint = el(doc, 'p', 'nb-note');
      hint.setAttribute('data-role', 'repo-invite-hint');
      hint.textContent = CLOUD_INVITE_HINT;
      list.append(hint);
    } else {
      const addrField = fieldRow(doc, '服务端地址');
      const addr = textInput(doc, 'repo-custom-address', '例如 192.168.1.20:8730');
      addr.setAttribute('inputmode', 'url');
      setValue(addr, draft.customAddress);
      addrField.body.append(addr);

      /*
       * ## 为什么这里**没有**一行"实际会连到哪"的预览（2026-11-04 用户要求）
       *
       * 用户原话：
       *
       * > 这个地方在 UI 上去掉，用户无感就行
       * > 那你填错了直接弹窗不就好了，因为这个地方 UI 的框很不一致，不好看
       *
       * 那行小字原来承担两件事，各自都有更合适的去处：
       *
       * | 原来靠它 | 现在 |
       * |---|---|
       * | 让用户确认归一化结果（补 `https://`、去尾斜线） | 不需要。用户写的就是他要连的机器，`10.9.0.2:8443` 补成 `https://…` 是帮他省事，不是需要他复核的决策 |
       * | 地址填错时给出原因 | `gateDraft()` 在点登录/注册时 `onNotify(reason)` 顶部提示 |
       *
       * ★ 关键是**别为了"实时反馈"再塞一个常驻元素**：它只在填错时才有信息量，
       * 填对的时候它只是一段重复用户输入的灰字，还把这一页的字段行拉得疏密不匀
       * （用户说的"框很不一致"）。常驻元素为低频事件服务，就是把成本摊给每一次打开。
       *
       * 打字过程中也不弹提示 —— 打到一半的 `https://10.9` 必然非法，
       * 那时弹等于对着用户的每个按键报错。闸门统一收在提交那一刻。
       */
      addr.addEventListener('input', () => {
        draft = { ...draft, customAddress: valueOf(addr) };
      });

      /*
       * 失焦时**持久化地址**。
       *
       * 用 `change` 而不是逐键存：逐键会在用户打到一半时把半截地址写进磁盘，
       * 重启后看到 `https://10.9` 这种值。
       *
       * 不在这里弹明文风险框 —— 打字过程中弹窗会打断输入。
       * 闸门留到点登录/注册那一刻（那时才真的要发请求）。
       */
      addr.addEventListener('change', () => {
        draft = { ...draft, customAddress: valueOf(addr) };
        const resolved = resolveRepoOrigin(draft);
        if (!resolved.ok) return; /* 半截地址不存，等用户填完 */

        void (async () => {
          try {
            await callbacks.onConfigChange(draft);
          } catch (error) {
            callbacks.onNotify(describe(error), 'danger');
          }
        })();
      });

      addrField.body.append(addr);
      list.append(addrField.row);
    }

    /* ── ② 账户 ── */
    list.append(groupTitle(doc, '账户'));

    if (status.username !== null) {
      /*
       * ★★★ 过期时必须在这里说清（2026-11-07，用户截图里那个矛盾状态）。
       *
       * 用户报的现象：
       *
       * > 如果已经登录服务端，重启 App 再进去，就会出现已连接却提示
       * > Token 无效的情况
       *
       * 截图里同时出现了两句话：
       *
       * ```text
       *   已登录：Gez              ← 账户区说登录着
       *   缺少或无效的访问令牌       ← 仓库区说令牌无效
       * ```
       *
       * 两句都是真的，但合起来是自相矛盾 —— 用户不知道该信哪一句，
       * 也不知道接下来该做什么。
       *
       * 现在 `status.expired` 只在**真的续期失败**后为 true
       * （见 `repoStatus()` 的注释），这时必须明确：
       *   · 登录还在（别否认，用户确实是 Gez）
       *   · 但会话已失效，点登出重新登录即可
       *
       * 文案判据（用户两次明令）：读了知道**能做什么**。
       */
      const who = el(doc, 'p', 'nb-note');
      who.setAttribute('data-role', 'repo-who');
      if (status.repoTokenMode) {
        who.textContent = '正在用仓库令牌（受限权限）';
      } else if (status.expired) {
        who.setAttribute('data-kind', 'warn');
        who.setAttribute('data-role', 'repo-who-expired');
        who.textContent = `登录已失效（${status.username}），点下面的「登出」再重新登录一次就好。`;
      } else {
        who.textContent = `已登录：${status.username}`;
      }
      list.append(who);

      const out = el(doc, 'button', 'nb-btn');
      out.setAttribute('type', 'button');
      out.setAttribute('data-role', 'repo-logout');
      /* 失效时这颗按钮是唯一出路，文案要跟着改（"登出"看起来像可有可无） */
      out.textContent = status.expired ? '登出并重新登录' : '登出';
      let busy = false;
      out.addEventListener('click', () => {
        if (busy) return;
        busy = true;
        out.setAttribute('disabled', 'true');
        void (async () => {
          try {
            await callbacks.onLogout();
          } catch (error) {
            callbacks.onNotify(describe(error), 'danger');
          } finally {
            busy = false;
            /*
             * ★ 复位必须 `removeAttribute`，不能 `setAttribute('disabled', '')`。
             *
             * `disabled` 是**布尔属性**：只要属性存在就禁用，值是什么无关。
             * 写空串自以为"清掉"，实测 `el.disabled === true`（真机验过）——
             * 于是按钮永久变灰。
             */
            out.removeAttribute('disabled');
          }
        })();
      });
      list.append(out);
    } else {
      if (status.expired) {
        const expired = el(doc, 'p', 'nb-note');
        expired.setAttribute('data-kind', 'warn');
        expired.textContent = '登录已过期，请重新登录。';
        list.append(expired);
      }

      const nameField = fieldRow(doc, '用户名');
      const nameInput = textInput(doc, 'repo-username', '用户名');
      setValue(nameInput, username);
      nameInput.addEventListener('input', () => {
        username = valueOf(nameInput);
      });
      nameField.body.append(nameInput);
      list.append(nameField.row);

      const passField = fieldRow(doc, '密码');
      const passInput = textInput(doc, 'repo-password', '密码', 'password');
      setValue(passInput, password);
      passInput.addEventListener('input', () => {
        password = valueOf(passInput);
      });
      passField.body.append(passInput);
      list.append(passField.row);

      /*
       * 邀请码：**只有内置云仓库**才有。
       *
       * 自部署实例通常开着开放注册，在那里显示一个邀请码框会让用户
       * 以为自己缺一个码，然后卡住。
       *
       * placeholder 明说"仅注册时填写" —— 否则用户登录时看到空的邀请码框
       * 会以为必填，回头去找开发者要一个本来不需要的码。
       */
      let inviteInput: ElLike | null = null;
      if (draft.kind === 'cloud') {
        const inviteField = fieldRow(doc, '邀请码');
        inviteInput = textInput(doc, 'repo-invite', '仅注册时填写，登录不用填');
        setValue(inviteInput, inviteCode);
        inviteInput.addEventListener('input', () => {
          inviteCode = valueOf(inviteInput ?? inviteField.body);
        });
        inviteField.body.append(inviteInput);
        list.append(inviteField.row);
      }

      const actions = el(doc, 'div', 'nb-tag-row');
      const loginBtn = el(doc, 'button', 'nb-btn');
      loginBtn.setAttribute('type', 'button');
      loginBtn.setAttribute('data-role', 'repo-login');
      loginBtn.textContent = '登录';

      const registerBtn = el(doc, 'button', 'nb-btn');
      registerBtn.setAttribute('type', 'button');
      registerBtn.setAttribute('data-role', 'repo-register');
      registerBtn.textContent = '注册';

      let busy = false;
      const guard = (fn: () => Promise<void>): void => {
        if (busy) return;
        const user = username.trim();
        if (user === '' || password === '') {
          callbacks.onNotify('用户名和密码都要填', 'warn');
          return;
        }
        busy = true;
        loginBtn.setAttribute('disabled', 'true');
        registerBtn.setAttribute('disabled', 'true');
        /*
         * ★★★ 忙碌时**必须改文字**（2026-11-06）。
         *
         * 原来只 `disabled`、文字一直是「登录」。用户点完看到一颗灰按钮，
         * 而内容**完全不变** —— 要盯 15 秒才知道在干什么，那 15 秒里
         * 用户会反复点、会以为卡死、会去查网络。
         *
         * 现在两个动作给不同的进行中文案（"登录中…" / "注册中…"），
         * 让人知道"它在干活"。
         *
         * ★ 文案要说**用户能判断的事**："连接服务端中…" 比 "加载中…" 好，
         * 因为服务端连不上是常见故障，用户看到这个词就知道该查地址。
         */
        const original = loginBtn.textContent ?? '登录';
        loginBtn.textContent = '连接服务端中…';
        void (async () => {
          try {
            await fn();
          } finally {
            busy = false;
            /*
             * ★★ 复位禁用必须 `removeAttribute`（2026-11-04 真机抓到的真缺陷）。
             *
             * 原来写的是 `setAttribute('disabled', '')` —— 以为空串等于"清掉"。
             * 但 `disabled` 是**布尔属性**：属性存在即禁用，值与"true"等效
             * （真机实测 `el.disabled === true`、`matches(':disabled') === true`）。
             *
             * 后果是一条很常见的路径就把登录彻底堵死：
             *
             * ```text
             *   点登录 → 弹「明文传输」风险框 → 点「换一个地址」取消
             *   → finally 把按钮设成 disabled=""
             *   → 按钮永久变灰，再点没有任何反应（除非切走 Tab 重画页面）
             * ```
             *
             * 同类错误在同一个文件里出现过三次（登出按钮也一样），一起改。
             */
            loginBtn.removeAttribute('disabled');
            registerBtn.removeAttribute('disabled');
            /* 文字必须跟着复位，否则按钮永远停在「连接服务端中…」 */
            loginBtn.textContent = original;
          }
        })();
      };

      loginBtn.addEventListener('click', () => {
        guard(async () => {
          await commitThen((config) => callbacks.onLogin(config, username.trim(), password));
        });
      });

      registerBtn.addEventListener('click', () => {
        guard(async () => {
          await commitThen((config) =>
            callbacks.onRegister(config, username.trim(), password, inviteCode.trim()),
          );
        });
      });

      actions.append(loginBtn, registerBtn);
      list.append(actions);

      const hint = el(doc, 'p', 'nb-note');
      hint.setAttribute('data-role', 'repo-login-hint');
      hint.textContent = '登录后可以上传卡片、查看历史版本、回滚。';
      list.append(hint);
    }

    /* ── ③ 仓库列表（2026-11-06 起是**一级**页面，点进去才是卡片）── */
    if (status.username !== null) {
      /*
       * 标题行 = 「仓库」+ 刷新按钮（2026-11-07）。
       *
       * ## 为什么放在标题旁而不是和「上传卡片」并排放底部
       *
       * 刷新是**整区**的动作（重新获取仓库情况），而上传是**单项**动作。
       * 放底部会和上传抢注意力，用户按"底部按钮 = 主操作"的直觉点错。
       * 放标题右侧是"这个列表的元操作"的常规位置（列表工具条）。
       *
       * ## 用 `nb-tag-row` 包一层而不是改 `groupTitle`
       *
       * `groupTitle()` 别处也在用（账户、服务端…），给它加参数会让
       * 所有调用方都要多传一个 `undefined`。这里单独排一行，改动面最小。
       */
      const titleRow = el(doc, 'div', 'nb-group-title-row');
      titleRow.append(groupTitle(doc, '仓库'));
      const refresh = el(doc, 'button', 'nb-icon-btn');
      refresh.setAttribute('type', 'button');
      refresh.setAttribute('data-role', 'repo-refresh');
      refresh.setAttribute('aria-label', '刷新仓库列表');
      refresh.setAttribute('title', '刷新仓库列表');
      /*
       * 文案用 ↻ 而不是图标：渲染层没有图标体系，而 `innerHTML` 是禁令。
       * 这个字形在所有安卓字体里都有（比 emoji 稳）。
       */
      refresh.textContent = '↻';
      titleRow.append(refresh);
      list.append(titleRow);

      const host = el(doc, 'div', 'nb-list');
      host.setAttribute('data-role', 'repo-repo-list');
      list.append(host);
      reposHost = host;

      /*
       * ★★★ 登录已失效时**不许自动拉列表**（2026-11-07，否则是死循环）。
       *
       * 链路本身是闭环的：
       *
       * ```text
       *   renderRepoPage
       *     → 自动 loadRepos → 请求 401
       *     → 自动 refresh（refresh token 也过期）→ 失败
       *     → repoExpiredError() → renderPage()
       *     → renderRepoPage → 又自动 loadRepos → ……
       * ```
       *
       * 每一圈都发一次网络请求，页面上什么都不变 —— 用户看到的是一个
       * 永远停在「正在读取…」的列表，同时手机在耗流量。
       *
       * 所以这个状态下**只画提示**，把"再试一次"交给用户点 ↻ 或
       * 「登出并重新登录」。**只有用户主动发起**的重试才允许进网络。
       */
      if (status.expired) {
        const blocked = el(doc, 'p', 'nb-note');
        blocked.setAttribute('data-kind', 'warn');
        blocked.setAttribute('data-role', 'repo-list-blocked');
        blocked.textContent = '会话已失效，仓库列表暂时拉不到。先重新登录，或点上面的 ↻ 再试一次。';
        host.append(blocked);

        /* 上传成功后会被调；过期状态下不发请求，避免又进那条循环 */
        markReposStale = (): void => {
          /* 有意留空 */
        };
      } else {
        /*
         * 上传成功后卡数会变，所以要能"标脏"并重拉。
         * 这是唯一需要在页面内部主动刷新仓库列表的地方。
         */
        markReposStale = (): void => {
          void loadRepos(host, { quiet: true });
        };

        /*
         * ★ 与卡片列表同样的策略：有缓存先画、再静默刷新。
         * 用户要求"切回来不需要重新连接服务器"，这条对仓库列表同样适用。
         */
        const cachedRepos = callbacks.onCachedRepos();
        if (cachedRepos.length > 0) {
          paintRepos(host, cachedRepos);
          void loadRepos(host, { quiet: true });
        } else {
          void loadRepos(host, { quiet: false });
        }
      }

      /*
       * 刷新按钮：重取仓库情况 + 顺带走一次令牌续期。
       *
       * ## 三态反馈（与下载按钮同一套规格）
       *
       * ```text
       *   点击瞬间    ↻ 半透明（data-busy）
       *   成功        ↻ 短暂置灰后复位，列表已更新
       *   失败        ↻ 复位，并**在列表位置显示原因**（不弹通知）
       * ```
       *
       * ★ 失败原因显示在列表里而不是弹通知：通知 3.2 秒就没了，
       *   而用户点刷新就是为了看到"为什么是空的"，那句话得留在页面上。
       */
      /*
       * 用**本地变量**记录"正在刷新"，而不是读 DOM 的 `disabled`。
       *
       * `ElLike` 刻意没有 `hasAttribute`（接口只留少数成员），而
       * `getAttribute('disabled')` 返回的是字符串 `''` —— 它对"有没有"
       * 这件事表达得很别扭。状态本来就是页面自己的知识，存在闭包里最直接。
       */
      let refreshing = false;
      refresh.addEventListener('click', () => {
        if (refreshing) return;
        refreshing = true;
        /*
         * 用 `'true'` 而不是 `''`。
         *
         * `disabled` 是布尔属性，值是什么都禁用 —— 但对**人类读者**和
         * 项目里的走查判据（`test/repo-tab.test.mjs`「不许用空串复位」）
         * 来说，`''` 这个写法已经背上了"想清掉却清不掉"的历史包袱。
         * 同一文件里其余按钮都写 `'true'`，保持一致。
         */
        refresh.setAttribute('disabled', 'true');
        refresh.setAttribute('data-busy', 'true');
        void (async () => {
          try {
            await callbacks.onRefresh();
            /*
             * `onRefresh` 成功后外壳会重画整页（新列表 + 新的令牌状态），
             * 这个按钮实例随即被销毁 —— 所以这里不用复位。
             * 但令牌续期失败时外壳**不会**重画（它要让用户看到错误），
             * 那时才需要复位（finally 里做）。
             */
          } catch (error) {
            host.replaceChildren();
            const fail = el(doc, 'p', 'nb-note');
            fail.setAttribute('data-kind', 'warn');
            fail.setAttribute('data-role', 'repo-refresh-error');
            fail.textContent = describe(error);
            host.append(fail);
          } finally {
            refreshing = false;
            refresh.removeAttribute('disabled');
            refresh.removeAttribute('data-busy');
          }
        })();
      });

      /*
       * ★ 与卡片列表同样的策略：有缓存先画、再静默刷新。
       * 用户要求"切回来不需要重新连接服务器"，这条对仓库列表同样适用。
       */
      const cachedRepos = callbacks.onCachedRepos();
      if (cachedRepos.length > 0) {
        paintRepos(host, cachedRepos);
        void loadRepos(host, { quiet: true });
      } else {
        void loadRepos(host, { quiet: false });
      }

      const actions = el(doc, 'div', 'nb-tag-row');
      const upload = el(doc, 'button', 'nb-btn');
      upload.setAttribute('type', 'button');
      upload.setAttribute('data-role', 'repo-upload');
      upload.textContent = '上传卡片';      upload.addEventListener('click', () => {
        void (async () => {
          let locals: Array<{ avatar: string; name: string }>;
          try {
            locals = await callbacks.onPickLocalCard();
          } catch (error) {
            callbacks.onNotify(describe(error), 'danger');
            return;
          }
          if (locals.length === 0) {
            callbacks.onNotify('角色库里还没有卡', 'warn');
            return;
          }
          askPickLocal(locals);
        })();
      });
      actions.append(upload);
      list.append(actions);
    }
  };

  const askPickLocal = (locals: Array<{ avatar: string; name: string }>): void => {
    const overlay = el(doc, 'div', 'nb-exit-overlay');
    overlay.setAttribute('data-role', 'repo-pick-local-dialog');

    const card = el(doc, 'div', 'nb-exit-card');
    const t = el(doc, 'p', 'nb-exit-title');
    t.textContent = '选择要上传的卡片';

    const pickList = el(doc, 'div', 'nb-list');
    pickList.setAttribute('data-role', 'repo-pick-local-list');
    for (const one of locals) {
      const row = el(doc, 'button', 'nb-listitem');
      row.setAttribute('type', 'button');
      row.setAttribute('data-role', 'repo-pick-local-item');
      row.setAttribute('data-avatar', one.avatar);

      /*
       * 圆形头像（2026-11-04 用户要求「仓库和角色选择里面支持显示角色缩略图，
       * 最好圆形的」）。
       *
       * 取不到图就退回首字占位圆 —— 上传列表里"这张是哪个角色"
       * 靠封面比靠名字快得多，尤其是几张同名卡的时候。
       */
      const avatar = makeAvatar(doc, {
        avatar: one.avatar,
        name: one.name,
        load: callbacks.onThumbnail,
        size: 40,
      });

      const main = el(doc, 'span', 'nb-listitem-main');
      const span = el(doc, 'span', 'nb-listitem-title');
      span.textContent = one.name;
      main.append(span);
      row.append(avatar, main);
      row.addEventListener('click', () => {
        overlay.remove();
        void (async () => {
          try {
            const outcome = await callbacks.onUpload(one.avatar);
            callbacks.onNotify(
              outcome.created
                ? `已上传「${one.name}」`
                : `已更新「${one.name}」（第 ${String(outcome.seq)} 版）`,
              'ok',
            );
            markReposStale();
          } catch (error) {
            callbacks.onNotify(describe(error), 'danger');
          }
        })();
      });
      pickList.append(row);
    }

    const cancel = el(doc, 'button', 'nb-exit-stay');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute('data-role', 'repo-pick-local-cancel');
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => overlay.remove());

    const actions = el(doc, 'div', 'nb-exit-actions');
    actions.append(cancel);

    card.append(t, pickList, actions);
    overlay.append(card);
    overlay.addEventListener('click', (event) => {
      if ((event as { target?: unknown }).target === overlay) overlay.remove();
    });
    root.append(overlay);
  };

  /** 画仓库列表（纯渲染） */
  const paintRepos = (host: ElLike, repos: RepoRow[]): void => {
    host.replaceChildren();

    if (repos.length === 0) {
      const empty = el(doc, 'p', 'nb-note');
      empty.setAttribute('data-role', 'repo-repos-empty');
      empty.textContent = '服务端上没有仓库。找管理员建一个，或者用仓库令牌上传。';
      host.append(empty);
      return;
    }

    for (const repo of repos) {
      const row = el(doc, 'button', 'nb-listitem');
      row.setAttribute('type', 'button');
      row.setAttribute('data-role', 'repo-repo-item');
      row.setAttribute('data-repo-id', repo.id);

      const main = el(doc, 'span', 'nb-listitem-main');
      const name = el(doc, 'span', 'nb-listitem-title');
      name.textContent = repo.name === '' ? repo.id : repo.name;
      const sub = el(doc, 'span', 'nb-listitem-sub');
      /*
       * 说明文字按优先级取最有用的一条：
       *   有描述 → 描述（人写的，信息量最大）
       *   没描述 → 「N 张卡」
       *   默认仓库额外标一下 —— 上传时不指定仓库会落到它上面
       */
      const bits: string[] = [];
      if (repo.description.trim() !== '') bits.push(repo.description.trim());
      bits.push(`${String(repo.cardCount)} 张卡`);
      if (repo.isDefault) bits.push('默认');
      sub.textContent = bits.join(' · ');
      main.append(name, sub);
      row.append(main);

      const arrow = el(doc, 'span', 'nb-src-chevron');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '›';
      row.append(arrow);

      row.addEventListener('click', () => callbacks.onOpenRepo(repo.id, name.textContent ?? ''));
      host.append(row);
    }
  };

  /**
   * 拉仓库列表。
   *
   * `quiet`：已经有缓存画出来了，失败就**保留已显示内容**不写错误
   * （理由同卡片列表：用户切回来是想看上次的东西）。
   */
  const loadRepos = async (host: ElLike, options: { quiet: boolean }): Promise<void> => {
    if (!options.quiet) {
      host.replaceChildren();
      const wait = el(doc, 'p', 'nb-note');
      wait.setAttribute('data-role', 'repo-repos-loading');
      wait.textContent = '正在读取…';
      host.append(wait);
    }

    try {
      const repos = await callbacks.onListRepos();
      paintRepos(host, repos);
    } catch (error) {
      if (options.quiet) return;
      host.replaceChildren();
      const fail = el(doc, 'p', 'nb-note');
      fail.setAttribute('data-kind', 'warn');
      fail.textContent = describe(error);
      host.append(fail);
    }
  };

  /**
   * 探测一次连通性并更新指示灯。
   *
   * ## 两个不同的"安静"程度
   *
   * ```text
   *   冷启动（从没探测过 / 切了服务端）
   *     显示「检测中」—— 让用户知道正在试，不是没反应
   *
   *   热刷新（已有 online/offline 结论，只是过期了）
   *     **不显示「检测中」**，直接静默探测，结果变了才改
   *     —— 否则每次切回来指示灯都闪一下「检测中」，
   *        看起来像"又重连了"，正是用户想避免的观感
   * ```
   */
  const probeLink = (options: { silent?: boolean } = {}): void => {
    const silent = options.silent === true;
    if (!silent) paintLink('checking', '');

    void (async () => {
      try {
        const result = await callbacks.onProbeLink();
        paintLink(result.state, result.detail);
      } catch (error) {
        /*
         * 探测接口本身不该抛（外壳内部已经把网络错误转成 offline）。
         * 真抛了只可能是代码问题，仍然要给用户一个确定的状态。
         */
        paintLink('offline', describe(error));
      }
    })();
  };

  linkPill.addEventListener('click', () => {
    /*
     * 点了就**重新探测**，不弹任何确认。
     *
     * 连不上时用户的下一步动作就是"再试一次"，成本最低的反馈才正确。
     */
    probeLink();
  });

  paint();

  /*
   * 进页面时是否探测 —— 这里是"切回来不需要重新连"的关键。
   *
   * ```text
   *   unknown                     ⇒ 探测（并显示「检测中」）
   *   有结论且还新鲜（< 60 秒）    ⇒ **不探测**，直接用上次的结论
   *   有结论但已过期              ⇒ 静默探测（不闪「检测中」）
   * ```
   *
   * 60 秒这个值：短于它，用户"切出去看一眼再切回来"不会触发探测；
   * 长于它，结论可能已经过时（服务端重启、网络切换），值得悄悄核对一次。
   */
  const LINK_FRESH_MS = 60_000;
  const age = status.linkCheckedAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - status.linkCheckedAt;
  if (status.link === 'unknown') {
    probeLink();
  } else if (age > LINK_FRESH_MS) {
    probeLink({ silent: true });
  }

  return root;
}
