/**
 * 壳能力契约 · 类型定义（唯一事实源）
 *
 * 这份文件与 src-tauri/src/commands.rs 的 serde 结构一一对应。
 * 两侧任何一侧改字段名，都必须同步改这里——契约测试见 §「契约对齐表」。
 *
 * 命名规则：Rust 侧一律 `#[serde(rename_all = "camelCase")]`，
 * 因此这里全部用 camelCase，不做二次转换。
 */

/** 内置规则类别。注意：**不是路径**——路径由 Rust 侧解析，前端无权指定目录。 */
export type RuleKind = 'platforms' | 'presets' | 'highlight';

/** 读取结果：文本 + 完整性信息 */
export interface TextFile {
  /**
   * 供 UI 展示的路径。
   * 路径不是合法 UTF-8 时为 null —— 绝不 `to_string_lossy()` 静默替换，
   * 否则用户看到的路径与实际路径不一致。
   */
  pathDisplay: string | null;
  /** 严格 UTF-8 解码后的文本（非法字节直接报错，不做替换） */
  text: string;
  /** 原始字节数（不是字符数） */
  bytesLen: number;
  /** 原始字节的 sha256（小写 hex），用于「上传/写回前后字节一致」的断言 */
  sha256: string;
}

/** 原子写入回执 */
export interface WriteReceipt {
  pathDisplay: string | null;
  bytesWritten: number;
  sha256: string;
  /** 写入后回读并重算 sha256，与写入值一致才为 true */
  verified: boolean;
}

/**
 * 二进制读取结果（v0.1.4 / T12.3）。
 *
 * 为什么走 base64 而不是字节数组：Tauri 的命令参数/返回值要过 JSON，
 * 一个 5 MB 的 PNG 变成 `number[]` 就是 5M 个 JSON 数字（约 20 MB 文本，
 * 序列化要几秒）；base64 只膨胀 33%，且两端都有现成实现。
 *
 * 渲染层拿到后 `atob` → `Uint8Array` 再交给 `shared/png-card`。
 * `sha256` 与 `bytesLen` 是**回读自证**的判据：解码回来长度/摘要对不上，
 * 说明传输链路有问题，此时不该继续写盘。
 */
export interface BinaryFile {
  /** 供 UI 展示的路径；非 UTF-8 时为 null（与 TextFile 同口径） */
  pathDisplay: string | null;
  /** 原始字节的 base64（标准字母表，**不带**换行） */
  base64: string;
  /** 原始字节数（不是 base64 字符串长度） */
  bytesLen: number;
  /** 原始字节的 sha256（小写 hex） */
  sha256: string;
}

/** 规则目录中的单个文件 */
export interface RuleFileEntry {
  /** 文件名（UTF-8）。非 UTF-8 文件名不会出现在这里，而是进 skipped */
  name: string;
  size: number;
  /** 修改时间，Unix 毫秒 */
  mtimeMs: number;
}

/** 规则目录扫描结果 */
export interface RuleDirScan {
  kind: RuleKind;
  /** 实际解析到的目录（展示用；非 UTF-8 时为 null） */
  root: string | null;
  /**
   * 目录签名：`name:size:mtimeMs;` 排序后拼接。
   * 与服务端 server/src/rules/registry.ts 的 `name:size:mtime` 同构，
   * 语义都是「签名变了才重新解析」。
   */
  signature: string;
  entries: RuleFileEntry[];
  /** 被跳过的条目（非 UTF-8 文件名、读取失败等），不静默丢弃 */
  skipped: Array<{ name: string | null; reason: string }>;
}

/** 壳自检信息 */
export interface ShellInfo {
  /** 壳版本（来自 Cargo.toml） */
  version: string;
  /** 解析到的内置规则根目录（展示用） */
  rulesRoot: string | null;
  /** 运行模式：debug / release */
  mode: 'debug' | 'release';
}

/**
 * 目录探测结果（T9.8）。
 *
 * 「存在 / 已创建 / 可写」三件事分开报，而不是一个 `ok` 布尔 ——
 * 因为它们的处置完全不同：
 *   · 不存在且创建失败 → **拒绝保存**（用户填了个建不出来的路径，存了也用不了）；
 *   · 存在但不可写     → **允许保存 + 黄色警告**（可能是权限临时问题，
 *     或者是只读盘/网络盘；拦下来会让人连"先记下来待会修"都做不到）。
 */
export interface DirProbe {
  /** 原样回传的绝对路径 */
  path: string;
  /** 展示用路径；非 UTF-8 时为 null */
  pathDisplay: string | null;
  /** 探测时是否已存在 */
  exists: boolean;
  /** 本次是否为调用方新建（exists=false 且创建成功时为 true） */
  created: boolean;
  /** 是否可写（实际写入一个探针文件再删掉，不是只看属性位） */
  writable: boolean;
  /** 不可写 / 创建失败的原因，面向用户的一句话；正常时为 null */
  reason: string | null;
}

/**
 * 卡片目录扫描结果。
 *
 * **只有文件名，没有路径、没有内容、不递归** —— 这个能力存在的唯一目的是
 * 「保存时别把同名文件覆盖掉」，所以它不该有能力看到子目录或读文件。
 */
export interface CardsDirScan {
  /** 展示用目录路径；非 UTF-8 时为 null */
  pathDisplay: string | null;
  /** 目录下 `.json` 文件名（不含路径） */
  names: string[];
  /** 条目过多被截断（只影响"重名检测"的完备性，不影响保存本身） */
  truncated: boolean;
}

/**
 * 路径存在形态（F15 / T13.1）。
 *
 * 三态而不是布尔：`file` 与 `dir` 对调用方的含义完全不同 ——
 * "`package.json` 是个目录"和"它不存在"在 ST 检测里都算"没装"，
 * 但在排查时一个是"用户目录被搞坏了"，一个是"还没装"。
 */
export type PathKind = 'file' | 'dir' | 'none';

/** 单条路径探测结果 */
export interface PathProbe {
  /** 原样回传的绝对路径（调用方用它对上"我问的是哪一条"） */
  path: string;
  exists: PathKind;
}

/**
 * 单个文件的元信息（v0.1.7 增补三，`stat_file` 的返回）。
 *
 * ## 为什么需要它
 *
 * 取回/导出撞名时，"本地这份有没有被改过"只能靠**文件的修改时间**判断：
 * 编辑器里的未保存修改能问渲染层，但用户用别的工具改过、或者关掉编辑器改的，
 * 渲染层无从知晓。而 `CardsDirScan` 只列文件名（契约写明"不读内容"，也没带时间），
 * 所以必须有单独一条命令把 mtime 拿出来。
 *
 * ## 为什么不算"读内容"
 *
 * 它**不返回文件内容**，只返回元信息。`sha256` 是顺带算的（服务端卡面比对用的
 * 同一套摘要），调用方拿到它就能回答"这个文件还是不是上次那份"，
 * 而不必把几 MB 的字节搬过 IPC。
 */
export interface FileStat {
  /**
   * 修改时间（epoch 毫秒）。
   *
   * 精度由文件系统决定：NTFS 约 100ns、FAT32 只有 2 秒。
   * 所以**不能拿它判断"两次写入之间谁先谁后"**，只能判断"变没变" ——
   * 判据要用 `>` 比基线，而不是 `===` 比上一次的值。
   */
  mtimeMs: number;
  /** 字节数 */
  size: number;
  /**
   * 内容摘要（小写十六进制）。
   *
   * **超过 64 MiB 的文件返回空串**（不算摘要）—— 这条命令是给卡文件用的，
   * 不该为了一个 500 MB 的视频把渲染层卡住。空串的含义是"没算"，
   * 不是"内容为空"，调用方不要拿它做相等比较。
   */
  sha256: string;
}

/**
 * SillyTavern 候选目录（F15 / T13.2）。
 *
 * **这是候选，不是结论**：`dirs` 里的目录可能全都不存在。
 * 判定由 `client/src/session/st-install.ts` 的 `judgeStInstall` 做 ——
 * 判据要能被矩阵单测，而壳里没有测试宿主。
 */
export interface StCandidates {
  /** 用户主目录（展示用）；拿不到时为 null */
  home: string | null;
  /** 候选目录绝对路径，已去重排序；标准位置即使不存在也会在列 */
  dirs: string[];
}

/**
 * 允许启动的目标（白名单，与 Rust 侧 `SPAWN_TARGETS` 逐字一致）。
 *
 * 只这三个：ST 官方 Windows 入口 `start.bat`（磁盘上常写作 `Start.bat`，
 * 大小写由壳侧兼容），以及"直接跑 node server.js"的两种表达。
 */
export type SpawnTarget = 'start.bat' | 'node.exe' | 'server.js';

/** 启动回执（F15 / T13.4） */
export interface SpawnReceipt {
  /** 子进程 pid（仅用于展示与日志对号） */
  pid: number;
  /**
   * 子进程 stdout/stderr 的落点（`<应用配置目录>/logs/st-launch.log`）。
   *
   * 为什么要交给渲染层：启动失败时要把 **ST 自己的报错**贴给用户，
   * 而不是我们转述。路径本身由壳解析，这里只是转发 —— 渲染层没有
   * "指定任意路径"的能力，拿到的是一条已存在文件的路径。
   */
  logPath: string | null;
}

/**
 * 回环端口探测结果（F15 / v0.1.5 生产反馈追加）。
 *
 * 为什么需要它：webview 里的 `fetch` 会被系统代理 / 安全软件 / 本地网络权限挡住，
 * 而"ST 有没有在跑"这个问题与 HTTP 层无关 —— 端口有没有人 accept 就够了。
 * 壳侧 `TcpStream::connect_timeout` 只连 `127.0.0.1`，不经过任何 HTTP 中间层。
 */
export interface PortProbe {
  alive: boolean;
  /** 固定 `127.0.0.1`（不接受参数，所以这条能力不是端口扫描器） */
  host: string;
  port: number;
  /** 探测耗时（毫秒），用于区分"立刻被拒"与"卡到超时" */
  elapsedMs: number;
  /** `io::ErrorKind` 的可读名：ConnectionRefused / TimedOut / PermissionDenied… */
  errorKind: string | null;
  errorMessage: string | null;
}

/**
 * 本地回环反向代理的运行信息（v0.1.6 / T14.1）。
 *
 * `baseUrl` 是 iframe 地址的**唯一合法来源**：它由壳按内核分配的端口生成，
 * 渲染层不能自己拼（`test/st-proxy.test.mjs` 有静态断言守着）。
 * 拼出来的后果不是"样式错位"，而是"iframe 指着别处"，那正是这个代理
 * 设计上要排除的东西。
 */
export interface ProxyInfo {
  /** 内核分配的端口（不写死，避免多开/占用打架） */
  port: number;
  /** `http://127.0.0.1:<port>` */
  baseUrl: string;
  /** 代理指向的 ST 地址（`host:port`），如实显示给用户 */
  target: string;
}

/**
 * 代理当前状态。用不着 `ProxyInfo | null` 是因为渲染层需要"为什么没起"
 * —— 四个字段一起 null 比一个 null 更能说明"确实没在跑"。
 */
export interface ProxyStatus {
  running: boolean;
  /**
   * 监听器是否还活着（v0.1.6 生产缺陷追加）。
   *
   * `running` 说的是"壳里有没有这条记录"，`alive` 说的是"那个 accept 循环还在不在"。
   * 两者会分叉：task 已经退出、端口已释放，而记录还在（见决策 #233）。
   * 分叉时 `running === true && alive === false` —— 这时候拿 `baseUrl` 去设
   * iframe 就是一定打不开的地址。
   */
  alive: boolean;
  /**
   * 连接计数（v0.1.6 真机缺陷二的决定性诊断）。
   *
   * `accepted === 0` 且 `alive === true` 只有一个含义：**流量从未到达壳的监听端口**
   * —— 那是环境层拦了回环（代理工具/安全软件/防火墙），壳内怎么改都没用。
   * `accepted > 0` 则说明请求进来了，问题在转发链路。
   */
  stats: {
    accepted: number;
    /**
     * 面板自检探测被收到的次数（专用路径 `/__tcs_probe__`，不转发给 ST）。
     *
     * **判据只用它，不用 `accepted`**：`accepted` 是累计值，iframe 正常加载一次
     * 就会涨几十，一次成功之后再也不是 0 —— 拿它判断"请求没发出"只在全新代理上
     * 成立一次（2026-10-27 真机复发就是这么被污染的）。
     */
    probeHits: number;
    lastPeer: string | null;
    lastAcceptedMs: number | null;
  };
  port: number | null;
  baseUrl: string | null;
  target: string | null;
}

/** 解压回执（F15 / T13.3 一键安装的 c 步） */
export interface ExtractReceipt {
  /** 解压到的目录（壳给的展示路径） */
  destPath: string | null;
  /** 解压后该目录是否已经像 SillyTavern（判据与检测一致） */
  hasStStructure: boolean;
}

/**
 * ST 默认地址（v0.1.6 / T14.0）：**这个字面量在全仓库只允许出现这一次**。
 *
 * 需求原文："静态断言守护：代码中不得出现独立的 `127.0.0.1:8000` 字面量
 * （唯一允许出现在默认值定义处）"。`test/st-address.test.mjs` 会扫源码来守它，
 * 所以别处要用地址就 `resolveStAddress(config.stAddress)`，不要抄这个串。
 *
 * 为什么把它放在契约层而不是 `session/st-address.ts`：能对拍它的地方包括
 * 契约测试与 Rust 侧常量，放在类型文件里两侧都好引用，也不引入循环依赖。
 */
export const ST_DEFAULT_ADDRESS = '127.0.0.1:8000';

/** 客户端持久化配置（T6.8） */
export interface ClientConfig {
  /** 服务端 API 根地址，如 http://127.0.0.1:8730 */
  serverUrl: string;
  /**
   * legacy 全局访问令牌（v0.1.1 形态）。
   *
   * T10.7 起与账户登录并存：填了它就一直能用（等同"全部仓库读写"），
   * 登录后则优先用 `accessToken`。保留它是因为升级用户的配置里已经有值，
   * 不能因为引入账户就把他们已有的连接弄断。
   */
  token: string;
  /** 账户 access 令牌（JWT，2h）。空串 = 未用账户登录 */
  accessToken: string;
  /** refresh 令牌（每次使用都会轮换）。空串 = 未用账户登录 */
  refreshToken: string;
  /** access 到期时刻（epoch ms）；0 = 未知（旧配置或手工清过） */
  accessExpiresAt: number;
  /**
   * 已登录账户的公开信息。
   *
   * **不含令牌**，也不含哈希 —— 只用于显示"当前是谁"与判断角色。
   * 结构上与 `auth/auth-client` 的 `AuthUser` 一致（那边是网络层类型，
   * 这里不该依赖它，避免契约层被网络层牵着走）。
   */
  authUser: { userId: string; username: string; role: 'admin' | 'user' } | null;
  /**
   * 仓库令牌模式（v0.1.3 / F5 后半）。空串 = 当前不在这个模式。
   *
   * 与 `accessToken` 是**两条互斥的凭证路径**：账户登录答"你是谁"，
   * 仓库令牌答"你能对这个仓库做什么"。两者同时存在时以仓库令牌为准 ——
   * 因为进入这个模式是个显式动作（用户主动粘贴令牌），
   * 不该被一个更早的、还没过期的账户会话悄悄顶掉。
   *
   * 存原文而不是哈希：客户端本来就要用它发请求，服务端只存 sha256。
   */
  repoToken: string;
  /** 令牌绑定的仓库（id 用于寻址，name 只用于显示） */
  repoTokenRepoId: string;
  repoTokenRepoName: string;
  /** 令牌的权限范围（read/write/rollback）。存下来是为了**离线**也能正确置灰按钮 */
  repoTokenScopes: string[];
  /** 令牌到期时刻（ISO）；null = 永不过期。仅用于显示 */
  repoTokenExpiresAt: string | null;
  /** 当前平台规则 id */
  platformRuleId: string | null;
  /** 当前 TXT 预设 id */
  presetId: string | null;
  /** 当前高亮方案 id */
  highlightSchemeId: string | null;
  /**
   * 当前世界书格式预设 id（v0.1.5 / G5）。
   *
   * 上面三个字段从 v0.1.0 就存在，但**直到 G5 才真正被读写** ——
   * 之前只声明、不落盘，所以"切换过哪个"重启就丢。四个 id 现在一起生效：
   * 启动时按它们恢复选择，切换时立即写回。
   *
   * 值为 `null` 表示"没选过/用内置默认"。**不存预设本体** ——
   * 本体在预设库（`preset-library.json`，由壳解析路径），这里只存指针。
   */
  worldbookPresetId: string | null;
  /** 当前初始场景格式预设 id（v0.1.5 / G5） */
  greetingPresetId: string | null;
  /** 当前对话示例格式预设 id（v0.1.5 / G5） */
  chatExamplePresetId: string | null;
  /**
   * 角色卡目录（T9.8 / F4）。`null` = 未设置，使用壳给出的默认值
   * （`%USERPROFILE%\Documents\TavernCardStudio\cards`）。
   *
   * 存的是**路径字符串**，不是文件系统授权 —— 授权由每次的原生对话框现给，
   * 重启即失效。这一点见 docs/11 §8。
   */
  cardsDir: string | null;
  /**
   * 上次导出 PNG 时用的卡面（v0.1.4 / T12.5，需求 F4.4「记忆」）。
   *
   * 编码成一个字符串而不是对象，避免在两侧维护 shape 与迁移旧配置：
   *   `null` 未设置 / `'default'` 内置默认 / `'source'` 当前卡原图 /
   *   `'lib:<文件名>'` 图库里某一张。
   * 前缀 `lib:` 是必需的 —— 图库文件名可能恰好叫 `default`。
   * **"浏览选择"的路径不写入这里**（那是一次性动作）。
   */
  lastFaceChoice: string | null;
  /**
   * 用户手动指定过的 SillyTavern 安装目录（F15 / T13.2，需求里的"记忆路径"）。
   *
   * 与 `cardsDir` 同一套语义：`null` = 没指定过，走自动扫描
   * （`find_st_candidates` 列出的候选，逐个验判据）。
   *
   * 为什么要记：ST 的目录名千奇百怪（`SillyTavern-1.13.2`、
   * `我的酒馆`…），自动扫描只认 `SillyTavern*` 前缀，
   * 用户自己指定过一次之后就不该再让他每次重选。
   */
  stPath: string | null;
  /**
   * SillyTavern release 包的下载镜像前缀（F15 / T13.3）。
   *
   * 需求写的是"官方 GitHub release + 可配置镜像前缀"。前缀直接拼在官方地址前面
   * （`https://ghfast.top/https://github.com/...`），所以留空就是官方地址。
   * 校验（必须 http(s):// 开头）在 `st-install.ts` 的 `stDownloadUrl` 里做 ——
   * 这里只存原文，不做归一化，坏值在下载时给出明确报错。
   */
  stMirrorPrefix: string | null;
  /**
   * SillyTavern 的访问地址（v0.1.6 / T14.0）：`主机:端口`，**host 只能是回环**。
   *
   * `''` / null = 没配过，用 [`ST_DEFAULT_ADDRESS`]。非法值（手改配置文件填了
   * 内网地址）会在读取时被 `resolveStAddress()` 回落成默认值，并由设置面板标出来 ——
   * 不让整块功能瘫掉，但也绝不悄悄把它当成有效配置用。
   *
   * 存字符串而不是 `{host, port}`：C5（plugin-store）逐键回落，多一层对象
   * 迁移就多一个"旧配置缺字段"的坑；字符串也让用户手改配置文件时看得懂。
   */
  stAddress: string;
  /**
   * 右侧 ST 面板的宽度（v0.1.6 / T14.3），单位 px；`null` = 没拖过，用默认值。
   *
   * 存下来是因为"写卡区该占多少、聊天区该占多少"只有用户自己知道，而他会在
   * 两种状态之间来回切 —— 每次打开都复位成默认宽度，等于每次都要重拖一遍。
   * 取值区间由 `session/st-pane-layout.ts` 钳制（读的时候会 clamp，坏值不报错）。
   */
  stPaneWidth: number | null;
  /**
   * `卡片 key → SillyTavern 角色文件名` 映射（v0.1.7 修订一：更新式推送）。
   *
   * key 是 cardId（F11 的稳定标识）；没有 cardId 时用 `name:<角色名>`（见
   * `client/src/session/st-push-name.ts` 的 `nameKeyFor`）。value 是落盘文件名，
   * 含 `.png`，如 `西奥.png`。
   *
   * **为什么必须持久化**：ST 的角色身份就是文件名。不记这份映射，第二次推送
   * 就无从知道"上次这张卡落到哪个文件"，只能按名字重新占名 —— 于是同名加序号，
   * ST 里多出一个角色，而用户跟原角色的聊天记录全留在旧文件上。
   *
   * **为什么存在客户端而不是服务端**：它描述的是**本机 ST 目录的状态**。
   * 换一台机器，ST 目录不同，映射也就不该跟着走。同理，它不进版本历史 ——
   * 改一个文件名不是"卡的内容变了"。
   */
  stPushNames: Record<string, string>;
  /**
   * `本地文件路径 → 上次与本客户端同步时的 mtimeMs`（v0.1.7 增补三：取回撞名判定）。
   *
   * ## 它解决的是"我怎么知道这个文件被人在外面改过"
   *
   * 取回/导出撞名时要判断"本地这份要不要保"。两路信息源：
   *   · 编辑器里的未保存修改 —— 渲染层知道，直接问就行；
   *   · **文件被别的程序改过**（用户手工编辑、另一个工具、同步盘）——
   *     渲染层无从知晓，只能比 `mtime` 与"上次我们碰它的时候"。
   *
   * 第二条就是这份基线存在的理由。没有它，`mtime` 只能和"现在"比，
   * 而任何文件都早于现在，判据就退化成恒真。
   *
   * ## 为什么存客户端、不进服务端
   *
   * 它描述的是**本机这份文件的历史**，换台机器就毫无意义。与 `stPushNames`
   * 同一条理由。服务端也不该知道用户的磁盘布局。
   *
   * ## 键是规范化后的路径
   *
   * Windows 上 `C:\a\b.png` 与 `c:/A/B.PNG` 是同一个文件。键由
   * `sync/file-baseline.ts` 的 `baselineKey()` 统一生成（小写 + 反斜杠归一），
   * **不要在这里自己拼** —— 两处各归一一次必然分叉。
   *
   * ## 没记录过的路径怎么办
   *
   * 不判脏（`decideFaceDrop` 的 `localNewer` 为 false），并在第一次成功读写后
   * 补记。这样老文件不会因为"没基线"而每次都弹窗，而它一旦被我们碰过、
   * 之后再被外部改动，就检测得到了。
   */
  fileBaselines: Record<string, number>;
  /**
   * 新建卡时套用的卡片级默认值（v0.1.6）。
   *
   * 用户原话是「最好是用户可以自定义」—— 光有编辑器只满足「这张卡能改」，
   * 而作者名、创作说明这类值每张卡都一样，不该每次重填。存在配置里而不是
   * 跟着卡走，是因为它属于「我的习惯」，不属于任何一张卡。
   *
   * 类型声明成 unknown 而非强类型：配置来自磁盘，可能是旧版本或人手工改过的。
   * 读取方必须走 `session/card-info.ts` 的 `sanitizeDefaults()` 清洗 ——
   * 一个 `tags: '日常'`（字符串而非数组）就足以让新建卡抛异常，而新建卡
   * 是用户最常用的入口，崩在那里等于整个客户端不能用。
   */
  cardDefaults: unknown;
  /**
   * 语音发送前是否要确认（v0.1.7 / T15.6 终版，默认 `false`）。
   *
   * - `false`（默认）：按住 → 转写 → 自动包裹 → **直发**，零中断。
   *   这是最常用的路径，多一步确认就等于每条语音多一次点击。
   * - `true`：转写完成后在输入区上方出一条待确认条
   *   `[波形缩略] [已包裹文本（可编辑）] [发送] [取消]`，
   *   发送前不进气泡。适合"ASR 识别率不稳、宁可多看一眼"的场景。
   *
   * ## 为什么默认关
   *
   * 语音输入的价值就是**快**。默认开会让所有人先付一次"每条都要点发送"的税，
   * 而受益的只是少数识别不准的人。反过来，觉得识别不准的人自己开一次即可 ——
   * 一次性的成本，换所有人事后的零成本。
   *
   * ## 为什么它独立于 ASR 三字段
   *
   * 需求重申过「配置独立性，防接线合并」：ASR 的 `base_url` / `key` / `model`
   * 是**外部服务凭据**，这个是**本地交互偏好**。两者存在同一份配置对象里
   * （都是本机偏好，没必要分文件），但**语义上互不依赖**：
   * 换 ASR 厂商不该重置确认开关，反之亦然。决策 #309 有隔离断言。
   */
  voiceConfirmBeforeSend: boolean;
}

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  serverUrl: 'http://127.0.0.1:8730',
  token: '',
  accessToken: '',
  refreshToken: '',
  accessExpiresAt: 0,
  authUser: null,
  repoToken: '',
  repoTokenRepoId: '',
  repoTokenRepoName: '',
  repoTokenScopes: [],
  repoTokenExpiresAt: null,
  platformRuleId: null,
  presetId: null,
  highlightSchemeId: null,
  worldbookPresetId: null,
  greetingPresetId: null,
  chatExamplePresetId: null,
  cardsDir: null,
  lastFaceChoice: null,
  stPath: null,
  stMirrorPrefix: null,
  stAddress: '',
  stPaneWidth: null,
  // 空对象 = 还没推过任何卡（不是 null，省掉一处判空；也没有"未设置"这个语义，
  // 空表就是"没有任何映射"，与"有映射但都是空"不可区分也不需要区分）
  stPushNames: {},
  // 空对象 = 还没有任何文件的同步基线。
  // 空表意味着"一律不判脏"（见 file-baseline.ts 文件头第 1 条），
  // 这是正确的初始状态：第一次用还没有历史可比。
  fileBaselines: {},
  // 空对象 = 没有自定义默认值（不用 null，省掉一处判空）
  cardDefaults: {},
  voiceConfirmBeforeSend: false,
};
