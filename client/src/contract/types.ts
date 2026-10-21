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

/** 客户端持久化配置（T6.8） */
export interface ClientConfig {
  /** 服务端 API 根地址，如 http://127.0.0.1:8730 */
  serverUrl: string;
  /** 访问令牌 */
  token: string;
  /** 当前平台规则 id */
  platformRuleId: string | null;
  /** 当前 TXT 预设 id */
  presetId: string | null;
  /** 当前高亮方案 id */
  highlightSchemeId: string | null;
}

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  serverUrl: 'http://127.0.0.1:8730',
  token: '',
  platformRuleId: null,
  presetId: null,
  highlightSchemeId: null,
};
