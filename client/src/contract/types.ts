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

/** 解压回执（F15 / T13.3 一键安装的 c 步） */export interface ExtractReceipt {
  /** 解压到的目录（壳给的展示路径） */
  destPath: string | null;
  /** 解压后该目录是否已经像 SillyTavern（判据与检测一致） */
  hasStStructure: boolean;
}

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
};
