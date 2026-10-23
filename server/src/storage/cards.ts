/**
 * 角色卡与版本服务（T5.1 / T5.2 / T5.3 的领域层，HTTP 层只做参数解析）。
 *
 * 不可破坏的不变量：
 *   1. 入库的卡片字节 = 上传字节。任何路径（上传 / 新版本 / 回滚）都只把 `bytes` 交给 BlobStore 与 GitStore，
 *      不经过 `stringifyStCard`、不 `JSON.stringify`、不重排键序。解析结果只用于索引与审计。
 *   2. 每次版本提交都同时落一份审计快照（blob + Git 提交里的 audit.json），历史版本可回看当时的审计结论，
 *      而不是用今天的规则重新审判旧版本。
 *   3. 回滚 = 以目标版本的字节**新建一个提交**，历史只增不改。
 */

import { randomBytes } from 'node:crypto';

import type { AuditReport, AuditSummary } from '@tcs/shared';

import type { AuditService } from '../audit/service.js';
import { analyzeCardBytes } from '../audit/service.js';
import { AppError } from '../errors.js';
import type { Logger } from '../log.js';
import type { BlobStore } from './blobs.js';
import { ALL_CARDS, rowInScope, type CardScope } from './card-scope.js';
import type { CardIdSource, CardRow, Db, NewVersionRow, VersionKind, VersionRow } from './db.js';
import { compareBytes, diffJson, diffLines, sha256Of, type ByteComparison, type JsonDiff, type LineDiff } from './diff.js';
import type { GitStore } from './git-store.js';

export interface WriteOptions {
  message?: string;
  author?: string;
  platformId?: string | null;
  presetId?: string | null;
  includeStDefaults?: boolean;
  filename?: string;
  /**
   * 归属账户与仓库（T10.6）。
   *
   * 为什么放在 WriteOptions 而不是单独的参数：新建卡片时要同时写进 `cards` 行，
   * 与 message/author 属同一类"这次写入的上下文"。缺省（legacy 全局 token 上传）
   * 时留空 —— 那种情况下卡片没有账户归属，由运维用 `user adopt` 处理。
   */
  ownerId?: string | null;
  repoId?: string | null;
}

export interface CardSummaryDto {
  /**
   * 卡片 ID —— **寻址键**。历史 / 回滚 / 取原文全用它。
   *
   * 与 `id` 同值，但两个字段都留着：`id` 是"记录主键"的既有叫法（旧客户端在用），
   * `cardId` 是 F11 的领域概念（用户指定、跨端稳定的标识）。合并成一个名字
   * 会让"这到底是主键还是用户 ID"重新变模糊。
   */
  cardId: string;
  id: string;
  /** 见 `CardIdSource`：`client` = 用户指定；`auto` = 服务端发号；`legacy` = v0.1.1 之前入库 */
  idSource: CardIdSource;
  name: string;
  /**
   * 所属仓库（T10.6）。空串 = 尚未归属（v0.1.2 升级前的历史卡，
   * 由 `user migrate` 补进默认仓库）。
   *
   * 与 `repoName` 分开给：客户端要拿 id 做后续操作（上传指定仓库），
   * 名字只用于显示。只给名字的话客户端还得反查一次。
   */
  repoId: string;
  /** 仓库名；仓库不存在或未归属时为 null（不让显示层猜） */
  repoName: string | null;
  spec: string;
  specVersion: string;
  creator: string;
  tags: string[];
  sourceFilename: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  versionCount: number;
  /**
   * 最新版本序号（顶层便利字段）。
   *
   * 为什么在 `latest.seq` 之外再给一个：客户端列表和"分叉基线"都要读它，
   * 而 `latest` 可能是 null（没有任何版本的行）。旧客户端曾经按
   * `latestSeq` 读、服务端只给 `latest.seq`，结果那一列永远是 0 ——
   * 一个纯靠字段名对不上就静默取默认值的坑。
   */
  latestSeq: number | null;
  latest: {
    seq: number;
    commit: string;
    sha256: string;
    size: number;
    message: string;
    createdAt: string;
  } | null;
  audit: {
    sha256: string;
    generatedAt: string;
    error: number;
    warning: number;
    info: number;
    exportable: boolean;
  } | null;
  auditError: string | null;
}

export interface CardDetailDto extends CardSummaryDto {
  parseWarnings: Array<{ path: string; message: string; severity: string }>;
}

export interface VersionDto {
  seq: number;
  commit: string;
  /**
   * 内容指纹。**已清除的版本为 null** —— 用空串会把"内容没了"伪装成
   * "内容是一个空的 sha"，调用方（客户端渲染、导出）该走不同分支。
   */
  sha256: string | null;
  size: number;
  message: string;
  author: string;
  kind: VersionKind;
  parentCommit: string | null;
  createdAt: string;
  audit: {
    sha256: string;
    generatedAt: string;
    error: number;
    warning: number;
    info: number;
    exportable: boolean;
  } | null;
  auditError: string | null;
  meta: Record<string, unknown>;
  /** 内容已被清除（F13.3）。为 true 时 sha256/size 不再有意义 */
  pruned: boolean;
  prunedAt: string | null;
  prunedBy: string | null;
}

export interface DiffDto {
  from: VersionDto;
  to: VersionDto;
  bytes: ByteComparison;
  lines: LineDiff;
  json: JsonDiff;
  identical: boolean;
  /**
   * 有版本内容已被清除时，diff 无法计算 —— 这里为 true，
   * 且 `bytes/lines/json` 都是空壳。客户端据此显示「内容已清除」
   * 而不是"两个版本一样"（后者是彻头彻尾的错误结论）。
   */
  contentCleared: boolean;
}

/** 上传/追加时可能返回的警告（不阻断写入） */
export type UploadWarningCode =
  /** 远端最新版本不是本次会话上次上传的那个 → 本次追加会产生分叉历史 */
  | 'FORK'
  /** 客户端声称有基线（baseSeq ≥ 1），但远端已经没有这张卡（被删/库被清） */
  | 'REMOTE_MISSING';

export interface UploadWarning {
  code: UploadWarningCode;
  /** 给用户看的一句话（客户端可直接上屏，避免两端各写一套文案） */
  message: string;
  /** 客户端声明的基线序号；null = 客户端没有基线（首次上传） */
  baseSeq: number | null;
  /** 远端当前最新序号；null = 远端没有这张卡 */
  remoteLatestSeq: number | null;
  remoteLatestSha256: string | null;
}

/**
 * 上传结果。
 *
 * `cardId` / `seq` 提到**顶层**是有意的：需求要求"响应中明确返回两者"，
 * 让客户端不必再从 `card.id` / `version.seq` 里挖 —— 嵌套结构里少一层
 * 就会静默变成默认值（`latestSeq` 那个坑就是这么来的）。
 */
export interface UploadOutcome {
  cardId: string;
  seq: number;
  /** true = 本次新建了卡片；false = 追加了一个版本 */
  created: boolean;
  warnings: UploadWarning[];
  card: CardDetailDto;
  version: VersionDto;
}

/** ID 最大长度，与客户端 `CARD_ID_MAX_LENGTH` 保持一致 */
export const CARD_ID_MAX_LENGTH = 64;

/**
 * 校验客户端指定的角色卡 ID。
 *
 * 规则与 `client/src/session/card-id.ts` **必须同构**：只允许 `A-Za-z0-9-`、
 * 1–64 字符、首尾非连字符、至少含一个字母或数字。
 *
 * 客户端那层是"帮用户改对"，服务端这层是"坏 ID 不许进库"。少了后者，
 * 任何绕过界面的调用（curl、旧版客户端、脚本）都能造出无法寻址的卡 ——
 * 而那张卡之后**永远打不开**，因为它的 ID 里可能有 `/` 或空格。
 */
export function isValidCardId(id: string): boolean {
  if (id.length === 0 || id.length > CARD_ID_MAX_LENGTH) return false;
  if (!/^[A-Za-z0-9-]+$/.test(id)) return false;
  if (id.startsWith('-') || id.endsWith('-')) return false;
  return /[A-Za-z0-9]/.test(id);
}

/** 同一张卡的写操作串行化（Node 单进程内足够；跨进程部署时由 supervisor 保证单 worker） */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

function slugify(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return ascii || 'card';
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function summaryFromRow(row: CardRow | VersionRow): VersionDto['audit'] | null {
  if (row.audit_sha256 === null || row.audit_error_count === null) return null;
  return {
    sha256: row.audit_sha256,
    generatedAt: row.audit_generated_at ?? '',
    error: row.audit_error_count,
    warning: row.audit_warning_count ?? 0,
    info: row.audit_info_count ?? 0,
    exportable: row.audit_exportable === 1,
  };
}

export class CardService {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly db: Db,
    private readonly blobs: BlobStore,
    private readonly git: GitStore,
    private readonly audit: AuditService,
    private readonly defaults: { platformId: string; presetId: string },
    private readonly logger: Logger,
  ) {}

  // ────────────────────────────── 查询 ──────────────────────────────

  summary(row: CardRow, repoName: string | null = null): CardSummaryDto {
    return {
      cardId: row.id,
      id: row.id,
      idSource: row.id_source,
      name: row.name,
      repoId: row.repo_id,
      repoName,
      spec: row.spec,
      specVersion: row.spec_version,
      creator: row.creator,
      tags: JSON.parse(row.tags_json) as string[],
      sourceFilename: row.source_filename,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      versionCount: row.version_count,
      latestSeq: row.latest_seq,
      latest:
        row.latest_seq === null || row.latest_commit === null || row.latest_sha256 === null
          ? null
          : {
              seq: row.latest_seq,
              commit: row.latest_commit,
              sha256: row.latest_sha256,
              size: row.latest_size ?? 0,
              message: row.latest_message ?? '',
              createdAt: row.latest_at ?? row.updated_at,
            },
      audit: summaryFromRow(row),
      auditError: row.audit_error,
    };
  }

  detail(row: CardRow): CardDetailDto {
    return {
      ...this.summary(row, this.repoNameOf(row.repo_id)),
      parseWarnings: JSON.parse(row.parse_warnings_json) as CardDetailDto['parseWarnings'],
    };
  }

  /**
   * 仓库名批量查（列表用一次 IN 查询，不逐行 findById）。
   *
   * 为什么放在这里而不是注入 RepoStore：RepoStore 的所有方法都以 owner 为
   * 第一个参数（仓库归属是它的核心概念），而这里只需要「id → 名字」。
   * 为了一个显示字段把整套权限语境引进来，反而会让「卡片查询还没按账户过滤」
   * 这件事变得更容易被误读成"已经过滤了"。
   */
  private repoNameMap(repoIds: readonly string[]): Map<string, string> {
    const ids = [...new Set(repoIds.filter((id) => id !== ''))];
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db.handle
      .prepare(`SELECT id, name FROM repos WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: string; name: string }>;
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private repoNameOf(repoId: string): string | null {
    if (repoId === '') return null;
    return this.repoNameMap([repoId]).get(repoId) ?? null;
  }

  versionDto(row: VersionRow): VersionDto {
    const pruned = (row.pruned_at ?? null) !== null;
    return {
      seq: row.seq,
      commit: row.commit_sha,
      sha256: pruned ? null : row.blob_sha256,
      size: row.byte_size,
      message: row.message,
      author: row.author,
      kind: row.kind,
      parentCommit: row.parent_commit,
      createdAt: row.created_at,
      audit: summaryFromRow(row),
      auditError: row.audit_error,
      meta: JSON.parse(row.meta_json) as Record<string, unknown>,
      pruned,
      prunedAt: row.pruned_at ?? null,
      prunedBy: row.pruned_by ?? null,
    };
  }

  /**
   * 列表查询（T10.8：按可见范围过滤）。
   *
   * `scope` 缺省为 `ALL_CARDS`——**只在测试与运维脚本里**才该走缺省；
   * HTTP 路由一律显式传 `scopeFromIdentity(...)` 的结果。
   */
  list(options: {
    q?: string;
    limit: number;
    offset: number;
    includeDeleted?: boolean;
    scope?: CardScope;
  }): {
    total: number;
    items: CardSummaryDto[];
  } {
    const scope = options.scope ?? ALL_CARDS;
    const rows = this.db.listCards({ ...options, scope });
    const names = this.repoNameMap(rows.map((row) => row.repo_id));
    return {
      total: this.db.countCards({ ...options, scope }),
      items: rows.map((row) => this.summary(row, names.get(row.repo_id) ?? null)),
    };
  }

  get(cardId: string, options: { includeDeleted?: boolean; scope?: CardScope } = {}): CardDetailDto {
    const row = this.requireCard(cardId, options);
    return this.detail(row);
  }

  /**
   * 取一张卡并要求它在范围内。
   *
   * 「不存在」与「不属于你」在这里合流：范围条件进了 SQL（`db.getCard`），
   * 所以两种情况都返回同一个 `undefined` → 同一条 404 文案。这不是靠人工
   * 对齐措辞做到的，而是结构上没有第二条分支（docs/29 §2.1–2.2）。
   */
  private requireCard(
    cardId: string,
    options: { includeDeleted?: boolean; scope?: CardScope } = {},
  ): CardRow {
    const row = this.db.getCard(cardId, options);
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', `角色卡不存在：${cardId}`);
    }
    return row;
  }

  resolveVersion(cardId: string, rev?: string | null, scope: CardScope = ALL_CARDS): VersionRow {
    this.requireCard(cardId, { includeDeleted: true, scope });
    const raw = rev === undefined || rev === null || rev === '' ? 'latest' : String(rev).trim();
    if (raw === 'latest') {
      const latest = this.db.listVersions(cardId, { limit: 1 })[0];
      if (!latest) throw new AppError(404, 'NOT_FOUND', `角色卡 ${cardId} 还没有任何版本`);
      return latest;
    }

    /*
     * 数字形态的 rev 有**两种**合法含义，必须都试：
     *   · 版本序号（`/versions/2`）；
     *   · 全数字的提交短 sha 前缀（`/versions/1991`）。
     *
     * 这不是理论问题：git sha 是十六进制，4 位全是 0-9 的概率是 (10/16)^4 ≈ 15%，
     * 8 位约 2.3%。只按"数字 = 序号"解析的话，这些提交的短 sha 一查就是
     * `版本不存在：… v1991` —— 明明提交在库里，用户却拿不到，且报错文案
     * 把人往"是不是版本号写错了"的方向带。
     * （2026-10-23 全量测试偶发失败正是这条：`T5.2` 用 8 位短 sha 取版本，
     *   碰上一次纯数字前缀就 404。见 scripts/probe-shortsha.mjs 的实证。）
     *
     * 顺序是「先序号、后 sha」：序号是主用法且是确定值，`/versions/2` 不该
     * 因为某次提交恰好以 `2` 开头就变成歧义。
     */
    if (/^\d+$/.test(raw)) {
      const bySeq = this.db.getVersion(cardId, Number.parseInt(raw, 10));
      if (bySeq) return bySeq;
      const bySha = this.db.findVersionByCommit(cardId, raw.toLowerCase());
      if (bySha) return bySha;
      throw new AppError(404, 'NOT_FOUND', `版本不存在：${cardId} v${raw}`, {
        hint: '该标识既不是版本序号，也不是任何提交的 sha 前缀',
      });
    }

    if (/^[0-9a-fA-F]{4,40}$/.test(raw)) {
      const version = this.db.findVersionByCommit(cardId, raw.toLowerCase());
      if (!version) throw new AppError(404, 'NOT_FOUND', `提交不存在：${cardId} ${raw}`, { hint: '可用提交短 sha（至少 4 位）' });
      return version;
    }
    throw new AppError(400, 'BAD_REQUEST', `无法识别的版本标识：${raw}（可用 latest / 序号 / 提交 sha）`);
  }

  listVersions(cardId: string, options: { limit: number; offset: number; scope?: CardScope }): {
    total: number;
    items: VersionDto[];
  } {
    this.requireCard(cardId, { includeDeleted: true, scope: options.scope ?? ALL_CARDS });
    const rows = this.db.listVersions(cardId, options);
    return { total: this.db.countVersions(cardId), items: rows.map((row) => this.versionDto(row)) };
  }

  /**
   * 内容被清除的版本一律拒绝读出（F13.3）。
   *
   * 用 409 而不是 404：版本**确实存在**（列表里还看得见、序号还占着位），
   * 只是内容被有意清掉了。回 404 会让用户以为"这个版本不存在"，进而怀疑
   * 是不是自己记错了序号；409 才能表达"它在，但内容已经没了"。
   */
  private requireContent(version: VersionRow): void {
    if ((version.pruned_at ?? null) === null) return;
    throw new AppError(409, 'VERSION_CONTENT_CLEARED', `版本 v${version.seq} 的内容已被清除`, {
      seq: version.seq,
      prunedAt: version.pruned_at ?? null,
      prunedBy: version.pruned_by ?? null,
    });
  }

  /** 读取某版本的**原始字节**（从 blob 读，校验 sha256） */
  readBytes(
    cardId: string,
    rev?: string | null,
    scope: CardScope = ALL_CARDS,
  ): { bytes: Buffer; version: VersionRow } {
    const version = this.resolveVersion(cardId, rev, scope);
    this.requireContent(version);
    const bytes = this.blobs.read(version.blob_sha256);
    return { bytes, version };
  }

  readAuditBytes(
    cardId: string,
    rev?: string | null,
    scope: CardScope = ALL_CARDS,
  ): { bytes: Buffer; version: VersionRow } {
    const version = this.resolveVersion(cardId, rev, scope);
    this.requireContent(version);
    if (!version.audit_sha256) {
      throw new AppError(404, 'NOT_FOUND', `版本 ${cardId} v${version.seq} 没有审计快照`, {
        auditError: version.audit_error,
      });
    }
    return { bytes: this.blobs.read(version.audit_sha256), version };
  }

  // ────────────────────────────── 写入 ──────────────────────────────

  /**
   * 新建卡片（服务端发号）。
   *
   * v0.1.1 起这不是主路径了 —— 新客户端一律带 ID（见 {@link upload}）。
   * 保留它是为了**旧版客户端**（v0.1.0）还能正常上传：它不带卡 ID，
   * 服务端只能自己发一个。这样升级服务端不会把还在跑的旧客户端打断。
   */
  async create(bytes: Buffer, options: WriteOptions = {}): Promise<{ card: CardDetailDto; version: VersionDto }> {
    const cardId = this.allocateId(bytes);
    return this.mutex.run(cardId, () => this.createLocked(cardId, 'auto', bytes, options));
  }

  /**
   * 上传入口（T9.7 / F11）：**按 ID 归档**。
   *
   * `cardId === null` → 服务端发号（只留给旧版客户端；新客户端总会带 ID）。
   * `cardId` 有值 → 存在则追加版本、不存在则新建。
   *
   * 三个不可妥协的点：
   *   1. **带了 ID 就一定用它。** 绝不因为"没找到这张卡"就退回发号 ——
   *      那样客户端以为在更新自己的卡，实际在服务端凭空多出一张，两边永久分叉。
   *      写入后还有一道断言：落库的 ID 必须等于请求的 ID，不等就是 500 而不是悄悄放过。
   *      这就是 `assertAuditOptions` 的同一种思路：**能把错误变成响亮的，就别让它静默。**
   *   2. **ID 先校验再落库。** 非法 ID 进库会造出一张永远打不开的卡
   *      （ID 里有 `/` 或空格时，连 `/api/cards/:id` 都拼不出来）。
   *   3. **`baseSeq` 与远端最新不一致 → 返回 FORK 警告，但照常写入。**
   *      分叉本身不是错误（两个人从同一版各改各的很正常），真正的错误是
   *      "产生了分叉却不告诉用户"。
   */
  async upload(
    cardId: string | null,
    bytes: Buffer,
    options: WriteOptions & { baseSeq?: number | null; scope?: CardScope } = {},
  ): Promise<UploadOutcome> {
    if (cardId === null) {
      const result = await this.create(bytes, options);
      return {
        cardId: result.card.cardId,
        seq: result.version.seq,
        created: true,
        warnings: [],
        card: result.card,
        version: result.version,
      };
    }

    if (!isValidCardId(cardId)) {
      throw new AppError(400, 'BAD_CARD_ID', `角色卡 ID 不合法：${cardId}`, {
        hint: '只允许字母、数字、连字符，1–64 字符，首尾不能是连字符',
      });
    }

    const scope = options.scope ?? ALL_CARDS;

    return this.mutex.run(cardId, async () => {
      // 先**不带范围**查一次：要区分「真的不存在」与「存在但归别人」。
      // 后者绝不能当"不存在"去新建 —— 那是主键冲突；也绝不能追加版本 ——
      // 那是往别人卡里写内容。一律 404，且与真不存在的响应逐字节相同
      // （docs/29 §2.1：不能让它变成"这个 id 存在"的探针）。
      const anyRow = this.db.getCard(cardId, { includeDeleted: true });
      const visible = anyRow !== undefined && rowInScope(anyRow, scope);
      if (anyRow !== undefined && !visible) {
        throw new AppError(404, 'NOT_FOUND', `角色卡不存在：${cardId}`);
      }
      const existing = visible ? anyRow : undefined;

      if (existing && existing.deleted_at !== null) {
        // 已软删的 ID 不复用：否则"删除"会变成"隐藏"，用户重新上传同名 ID 就把
        // 旧历史连带复活了，而他以为这是一张干净的卡。
        throw new AppError(409, 'CARD_DELETED', `该 ID 已被一张已删除的卡片占用：${cardId}`, {
          hint: '换一个 ID，或在服务端彻底删除那张卡（DELETE /api/cards/<id>?hard=1）',
        });
      }

      const baseSeq = typeof options.baseSeq === 'number' ? options.baseSeq : null;

      if (!existing) {
        // 客户端声明了基线、远端却没有这张卡：历史不在这台服务器上
        // （被硬删 / 换了库 / ID 拼错）。仍然按新卡写入 —— 内容不能丢 ——
        // 但必须说清楚"这不是你以为的那张卡"。
        const warnings: UploadWarning[] =
          baseSeq !== null && baseSeq > 0
            ? [
                {
                  code: 'REMOTE_MISSING',
                  message: `服务端没有 ID 为 ${cardId} 的卡片，已作为新卡建立 v1（原有历史不在这台服务器上）`,
                  baseSeq,
                  remoteLatestSeq: null,
                  remoteLatestSha256: null,
                },
              ]
            : [];

        const result = await this.createLocked(cardId, 'client', bytes, options);
        if (result.card.cardId !== cardId) {
          throw new AppError(
            500,
            'INTERNAL',
            `入库的卡片 ID 与请求不一致：请求 ${cardId}，实际 ${result.card.cardId}`,
          );
        }
        return { cardId, seq: result.version.seq, created: true, warnings, card: result.card, version: result.version };
      }

      const latest = this.db.listVersions(cardId, { limit: 1 })[0];
      const remoteLatestSeq = latest ? latest.seq : null;
      const warnings: UploadWarning[] =
        baseSeq !== null && remoteLatestSeq !== null && baseSeq !== remoteLatestSeq
          ? [
              {
                code: 'FORK',
                message: `远端已有他人修改（最新 v${remoteLatestSeq}，你的基线是 v${baseSeq}），本次上传将产生分叉历史`,
                baseSeq,
                remoteLatestSeq,
                remoteLatestSha256: latest ? latest.blob_sha256 : null,
              },
            ]
          : [];

      const version = await this.addVersionLocked(cardId, bytes, options);
      const card = this.requireCard(cardId);
      return { cardId, seq: version.seq, created: false, warnings, card: this.detail(card), version };
    });
  }

  /** 追加版本（已持有该卡的锁时才可调；`upload` 与 `addVersion` 共用） */
  private async addVersionLocked(cardId: string, bytes: Buffer, options: WriteOptions = {}): Promise<VersionDto> {
    this.requireCard(cardId);
    const latest = this.db.listVersions(cardId, { limit: 1 })[0];
    if (!latest) throw new AppError(500, 'INTERNAL', `角色卡 ${cardId} 缺少版本记录`);
    const seq = latest.seq + 1;
    const now = new Date().toISOString();

    const version = await this.commitSnapshot({
      cardId,
      seq,
      bytes,
      parentCommit: latest.commit_sha,
      kind: 'update',
      options,
      createdAt: now,
      origin: `server:${cardId}`,
    });

    const updateRow = { ...version.row, name: version.name };
    const tx = this.db.handle.transaction(() => {
      this.db.insertVersion(updateRow);
      this.db.updateCardFromLatest(cardId, updateRow, { name: version.name, updatedAt: now });
    });
    tx();

    this.db.appendEvent({
      at: now,
      level: 'info',
      action: 'card.version',
      cardId,
      detail: { seq, sha256: version.row.blobSha256, size: version.row.byteSize, message: updateRow.message },
    });
    this.logger.info('card.version', { cardId, seq, sha256: version.row.blobSha256, size: version.row.byteSize });

    const persisted = this.db.getVersion(cardId, seq);
    if (!persisted) throw new AppError(500, 'INTERNAL', '版本写入后读回失败');
    return this.versionDto(persisted);
  }

  async addVersion(
    cardId: string,
    bytes: Buffer,
    options: WriteOptions & { scope?: CardScope } = {},
  ): Promise<VersionDto> {
    return this.mutex.run(cardId, () => this.addVersionLocked(cardId, bytes, options));
  }

  /**
   * 建卡并写入 v1（已持有该卡的锁时才可调）。
   *
   * `idSource` 决定这张卡在列表里被怎么标注：`client`（用户指定）/
   * `auto`（服务端发号，仅旧客户端）/ `legacy`（迁移前入库，只会出现在老数据上）。
   */
  private async createLocked(
    cardId: string,
    idSource: CardIdSource,
    bytes: Buffer,
    options: WriteOptions,
  ): Promise<{ card: CardDetailDto; version: VersionDto }> {
    const now = new Date();
    const version = await this.commitSnapshot({
      cardId,
      seq: 1,
      bytes,
      parentCommit: null,
      kind: 'upload',
      options,
      createdAt: now.toISOString(),
      origin: `server:${cardId}`,
    });

    const cardRow: CardRow = {
      id: cardId,
      id_source: idSource,
      // 归属：上传者账户 + 其仓库（T10.6）。缺省为空串 = 未归属，
      // 由 `user adopt` / 仓库迁移处理，不在这里编一个假 id。
      owner_id: options.ownerId ?? '',
      repo_id: options.repoId ?? '',
      name: version.name,
      spec: version.analyzed.spec,
      spec_version: version.analyzed.specVersion,
      creator: version.analyzed.creator,
      tags_json: JSON.stringify(version.analyzed.tags),
      source_filename: options.filename ?? '',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      deleted_at: null,
      version_count: 1,
      latest_seq: 1,
      latest_commit: version.row.commit,
      latest_sha256: version.row.blobSha256,
      latest_size: version.row.byteSize,
      latest_message: version.row.message,
      latest_at: version.row.createdAt,
      parse_warnings_json: JSON.stringify(
        version.analyzed.parseIssues.filter((issue) => issue.severity === 'warning'),
      ),
      audit_sha256: version.row.auditSha256,
      audit_error: version.row.auditError,
      audit_generated_at: version.row.auditGeneratedAt,
      audit_error_count: version.row.auditSummary?.error ?? null,
      audit_warning_count: version.row.auditSummary?.warning ?? null,
      audit_info_count: version.row.auditSummary?.info ?? null,
      audit_exportable: version.row.auditSummary ? (version.row.auditSummary.exportable ? 1 : 0) : null,
    };

    const tx = this.db.handle.transaction(() => {
      this.db.insertCard(cardRow);
      this.db.insertVersion(version.row);
    });
    tx();

    this.db.appendEvent({
      at: now.toISOString(),
      level: 'info',
      action: 'card.create',
      cardId,
      detail: { seq: 1, sha256: version.row.blobSha256, size: version.row.byteSize, idSource },
    });
    this.logger.info('card.create', {
      cardId,
      idSource,
      seq: 1,
      sha256: version.row.blobSha256,
      size: version.row.byteSize,
    });

    const saved = this.requireCard(cardId);
    const savedVersion = this.db.getVersion(cardId, 1);
    if (!savedVersion) throw new AppError(500, 'INTERNAL', '版本写入后读回失败');
    return { card: this.detail(saved), version: this.versionDto(savedVersion) };
  }

  /** 回滚：以目标版本的原始字节新建提交（历史不重写） */
  async rollback(
    cardId: string,
    targetRev: string,
    options: { message?: string; author?: string; scope?: CardScope } = {},
  ): Promise<{ version: VersionDto; restoredFrom: VersionDto }> {
    const target = this.resolveVersion(cardId, targetRev, options.scope ?? ALL_CARDS);
    // 回滚需要把目标版本的字节重新写一遍，而内容已被清除 —— 必须先拦住，
    // 否则会走到 blobs.read('') 抛一个看不懂的 500。
    this.requireContent(target);
    const bytes = this.blobs.read(target.blob_sha256);
    const message = options.message?.trim() || `回滚到 v${target.seq}（${target.commit_sha.slice(0, 7)}）`;

    return this.mutex.run(cardId, async () => {
      const latest = this.db.listVersions(cardId, { limit: 1 })[0];
      if (!latest) throw new AppError(500, 'INTERNAL', `角色卡 ${cardId} 缺少版本记录`);
      const seq = latest.seq + 1;
      const now = new Date().toISOString();

      const version = await this.commitSnapshot({
        cardId,
        seq,
        bytes,
        parentCommit: latest.commit_sha,
        kind: 'rollback',
        options: {
          message,
          author: options.author,
          // 回滚沿用「当时审计所用的规则」不可得时，用当前配置的规则重新审计并记录在快照里
        },
        createdAt: now,
        origin: `server:${cardId}`,
        meta: { rollbackOf: target.seq, rollbackCommit: target.commit_sha },
      });

      const updateRow = { ...version.row, name: version.name };
      const tx = this.db.handle.transaction(() => {
        this.db.insertVersion(updateRow);
        this.db.updateCardFromLatest(cardId, updateRow, { name: version.name, updatedAt: now });
      });
      tx();

      // 核验：回滚后的字节必须与目标版本逐字节相同
      const restored = this.blobs.read(updateRow.blobSha256);
      if (!restored.equals(bytes)) {
        throw new AppError(500, 'BLOB_CORRUPTED', '回滚写入的字节与目标版本不一致');
      }

      this.db.appendEvent({
        at: now,
        level: 'info',
        action: 'card.rollback',
        cardId,
        detail: { seq, target: target.seq, sha256: updateRow.blobSha256 },
      });
      this.logger.info('card.rollback', { cardId, seq, target: target.seq, sha256: updateRow.blobSha256 });

      const persisted = this.db.getVersion(cardId, seq);
      if (!persisted) throw new AppError(500, 'INTERNAL', '回滚版本写入后读回失败');
      return { version: this.versionDto(persisted), restoredFrom: this.versionDto(target) };
    });
  }

  /**
   * 软删除（F13.2）：进回收站，保留期内可恢复。
   *
   * 为什么删除默认不做物理清除：卡片是用户长期的创作，一次误点就是不可恢复的
   * 损失。软删让"删除"这一步可撤销，真正的不可逆操作单独叫 `purge` 且仅管理员可用。
   *
   * 软删期间 **cardId 仍不可复用**（既有 `CARD_DELETED` 语义）：如果允许复用，
   * 同一 ID 的新卡会继承旧的版本历史与审计记录 —— 那是把两张不同的卡混成一个。
   */
  async delete(
    cardId: string,
    options: { scope?: CardScope; actor?: string; ip?: string | null } = {},
  ): Promise<{ id: string; hard: false; alreadyDeleted: boolean }> {
    return this.mutex.run(cardId, async () => {
      const card = this.requireCard(cardId, { includeDeleted: true, scope: options.scope ?? ALL_CARDS });
      const at = new Date().toISOString();
      const alreadyDeleted = card.deleted_at !== null;
      if (!alreadyDeleted) this.db.softDelete(cardId, at);
      this.db.appendEvent({
        at,
        level: 'warn',
        action: 'card.delete',
        cardId,
        detail: { alreadyDeleted },
        ownerId: card.owner_id,
        actor: options.actor ?? null,
        ip: options.ip ?? null,
      });
      this.logger.warn('card.delete', { cardId, alreadyDeleted, actor: options.actor });
      return { id: cardId, hard: false as const, alreadyDeleted };
    });
  }

  /** 从回收站恢复（F13.2）。不在回收站里 → 409，而不是静默成功 */
  async restore(
    cardId: string,
    options: { scope?: CardScope; actor?: string; ip?: string | null } = {},
  ): Promise<{ id: string; restored: boolean }> {
    return this.mutex.run(cardId, async () => {
      const card = this.requireCard(cardId, { includeDeleted: true, scope: options.scope ?? ALL_CARDS });
      if (card.deleted_at === null) {
        throw new AppError(409, 'CONFLICT', `角色卡 ${cardId} 不在回收站里`);
      }
      this.db.restoreCard(cardId);
      const at = new Date().toISOString();
      this.db.appendEvent({
        at,
        level: 'info',
        action: 'card.restore',
        cardId,
        detail: { deletedAt: card.deleted_at },
        ownerId: card.owner_id,
        actor: options.actor ?? null,
        ip: options.ip ?? null,
      });
      this.logger.info('card.restore', { cardId, actor: options.actor });
      return { id: cardId, restored: true };
    });
  }

  /**
   * 彻底清除（F13.2）：物理删除索引行 + git 仓库 + 无引用的 blob。
   *
   * **仅管理员**（路由层用 `requireAdmin` 拦）。理由：这是唯一不可逆的操作，
   * 普通用户已经有"删除 + 30 天保留期"这条安全路径；再给他一条绕过保留期的快捷方式，
   * 等于把保留期做成摆设。
   *
   * blob 删除必须查引用：blob 按内容去重，同一份字节可能被别的卡/版本共用。
   */
  async purge(
    cardId: string,
    options: { scope?: CardScope; actor?: string; ip?: string | null } = {},
  ): Promise<{ id: string; purged: boolean; freedBlobs: number }> {
    return this.mutex.run(cardId, async () => {
      const card = this.requireCard(cardId, { includeDeleted: true, scope: options.scope ?? ALL_CARDS });
      const at = new Date().toISOString();
      const shas = this.db.listVersions(cardId, { limit: 100000 }).map((row) => row.blob_sha256);

      this.git.removeRepo(cardId);
      this.db.hardDelete(cardId);

      let freedBlobs = 0;
      for (const sha of new Set(shas)) {
        if (sha === '') continue;
        if (this.db.countVersionsUsingBlob(sha) === 0 && this.blobs.remove(sha)) freedBlobs += 1;
      }

      this.db.appendEvent({
        at,
        level: 'warn',
        action: 'card.purge',
        cardId,
        detail: { deletedAt: card.deleted_at, freedBlobs, versions: shas.length },
        ownerId: card.owner_id,
        actor: options.actor ?? null,
        ip: options.ip ?? null,
      });
      this.logger.warn('card.purge', { cardId, freedBlobs, actor: options.actor });
      return { id: cardId, purged: true, freedBlobs };
    });
  }

  /**
   * 清除某版本的内容（F13.3 / prune）。
   *
   * 为什么不能"物理删掉这一行"：versions 是链式结构（parent_commit），
   * 删中间一行会让 diff 与回滚的链路断掉 —— 之后任何跨过它的比较都会失败，
   * 而用户只是想让"这段内容别再留着"。所以保留元数据、清掉正文。
   *
   * **最新版本不可 prune**：它是这张卡对外可见的内容，清了就等于这张卡没有正文，
   * 而列表里还显示着它。要清整卡请用 purge。
   */
  async prune(
    cardId: string,
    seq: number,
    options: { scope?: CardScope; actor?: string; ip?: string | null; force?: boolean } = {},
  ): Promise<{ id: string; seq: number; pruned: boolean; alreadyPruned: boolean }> {
    return this.mutex.run(cardId, async () => {
      const card = this.requireCard(cardId, { includeDeleted: true, scope: options.scope ?? ALL_CARDS });
      const target = this.db.getVersion(cardId, seq);
      if (!target) {
        throw new AppError(404, 'NOT_FOUND', `角色卡 ${cardId} 没有版本 v${seq}`);
      }

      const latestSeq = card.latest_seq ?? null;
      if (!options.force && latestSeq !== null && seq >= latestSeq) {
        throw new AppError(
          409,
          'CONFLICT',
          `v${seq} 是这张卡的最新版本，不能清除内容 —— 它是这张卡对外可见的正文`,
          { latestSeq },
        );
      }
      if ((target.pruned_at ?? null) !== null) {
        return { id: cardId, seq, pruned: false, alreadyPruned: true };
      }

      const at = new Date().toISOString();
      this.db.pruneVersion(cardId, seq, at, options.actor ?? 'system');

      // blob 只在**没有任何版本**还引用它时删除。注意：即使这里删了 blob，
      // git 仓库里的对象仍然存在（链不可断的必然代价，见 docs/34 §16）。
      let blobFreed = false;
      if (target.blob_sha256 !== '' && this.db.countVersionsUsingBlob(target.blob_sha256) === 0) {
        blobFreed = this.blobs.remove(target.blob_sha256);
      }

      this.db.appendEvent({
        at,
        level: 'warn',
        action: 'card.version.prune',
        cardId,
        detail: { seq, byteSize: target.byte_size, blobFreed },
        ownerId: card.owner_id,
        actor: options.actor ?? null,
        ip: options.ip ?? null,
      });
      this.logger.warn('card.version.prune', { cardId, seq, blobFreed, actor: options.actor });
      return { id: cardId, seq, pruned: true, alreadyPruned: false };
    });
  }

  /**
   * 移动卡片到另一个仓库（F13.4）。
   *
   * **不动 `updated_at`**（T10.6 决策的延续）：归属变更不是内容变更。
   * 移动后卡片不应跳到"最近修改"最前面 —— 那会让用户以为自己刚编辑过。
   */
  async move(
    cardId: string,
    targetRepoId: string,
    options: { scope?: CardScope; actor?: string; ip?: string | null; reason?: string } = {},
  ): Promise<{ id: string; fromRepoId: string; repoId: string; moved: boolean }> {
    return this.mutex.run(cardId, async () => {
      const card = this.requireCard(cardId, { includeDeleted: true, scope: options.scope ?? ALL_CARDS });
      if (card.deleted_at !== null) {
        throw new AppError(409, 'CARD_IN_TRASH', `角色卡 ${cardId} 在回收站里，先恢复再移动`);
      }
      if (targetRepoId === '') {
        throw new AppError(400, 'BAD_REQUEST', '缺少目标仓库（body.repo）');
      }
      /*
       * 直接查 repos 表，不注入 RepoStore：CardService 已经握着 db 句柄，
       * 而多一个构造参数会让所有测试里的 new CardService(...) 全部要改
       * （它们大多不关心仓库）。这里只需要两个字段。
       */
      const repo = this.db.handle
        .prepare('SELECT id, owner_id FROM repos WHERE id = ? AND deleted_at IS NULL')
        .get(targetRepoId) as { id: string; owner_id: string } | undefined;
      if (repo === undefined) throw new AppError(404, 'NOT_FOUND', `仓库不存在：${targetRepoId}`);
      if (repo.owner_id !== card.owner_id) {
        // 跨账户移动只能由管理员发起，且必须走管理员的显式入口（路由层判定后传 allowCrossOwner）
        throw new AppError(403, 'FORBIDDEN', '目标仓库不属于该卡片的账户', {
          hint: '跨账户移动请用管理员的跨账户接口',
        });
      }
      if (card.repo_id === targetRepoId) {
        return { id: cardId, fromRepoId: card.repo_id, repoId: targetRepoId, moved: false };
      }

      this.db.moveCard(cardId, targetRepoId);
      const at = new Date().toISOString();
      this.db.appendEvent({
        at,
        level: 'info',
        action: 'card.move',
        cardId,
        detail: { from: card.repo_id, to: targetRepoId, reason: options.reason ?? null },
        ownerId: card.owner_id,
        actor: options.actor ?? null,
        ip: options.ip ?? null,
      });
      this.logger.info('card.move', { cardId, from: card.repo_id, to: targetRepoId, actor: options.actor });
      return { id: cardId, fromRepoId: card.repo_id, repoId: targetRepoId, moved: true };
    });
  }

  /**
   * 回收站清理（F13.2）：把超过保留期的软删卡片彻底清除。
   *
   * `retentionDays = 0` 表示不自动清理（见 TrashConfig 注释），此时直接返回 0 ——
   * 不是"立刻全删"，那会把"关闭自动清理"读成"马上清空回收站"。
   */
  async purgeExpired(
    retentionDays: number,
    options: { now?: Date; limit?: number } = {},
  ): Promise<{ scanned: number; purged: Array<{ id: string; freedBlobs: number }> }> {
    if (retentionDays <= 0) return { scanned: 0, purged: [] };
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const ids = this.db.listExpiredTrash(cutoff, options.limit ?? 500);
    const purged: Array<{ id: string; freedBlobs: number }> = [];
    for (const id of ids) {
      try {
        // scope 传 ALL_CARDS：定时任务是系统行为，按"归属"过滤会让它永远清不掉别人的卡
        const result = await this.purge(id, { actor: 'system' });
        purged.push({ id, freedBlobs: result.freedBlobs });
      } catch (error) {
        // 单张失败不该中断整轮清理：下一轮还会看到它
        this.logger.warn('trash.purge.failed', {
          cardId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (purged.length > 0) {
      this.logger.info('trash.purge.batch', { count: purged.length, retentionDays });
    }
    return { scanned: ids.length, purged };
  }

  stats(scope: CardScope = ALL_CARDS): {
    cards: number;
    versions: number;
    bytes: number;
    blobs: { count: number; bytes: number };
  } {
    const totals = this.db.totals(scope);
    // blob 是全局的去重存储，无法按账户切分；它只反映"磁盘占用"，
    // 不泄露任何卡片内容或归属，所以保持全局值。
    return { ...totals, blobs: this.blobs.stats() };
  }

  events(
    limit: number,
    scope: CardScope = ALL_CARDS,
  ): Array<{
    id: number;
    at: string;
    level: string;
    action: string;
    cardId: string | null;
    detail: unknown;
    /** 操作者与来源（F13.1 审计要求）。老事件为 null */
    actor: string | null;
    ip: string | null;
  }> {
    return this.db.listEvents(limit, scope).map((row) => ({
      id: row.id,
      at: row.at,
      level: row.level,
      action: row.action,
      cardId: row.card_id,
      detail: JSON.parse(row.detail) as unknown,
      actor: row.actor ?? null,
      ip: row.ip ?? null,
    }));
  }

  /** 三层 diff；默认同时给出，可用 include 选择（lines 在大文本下成本较高） */
  diff(
    cardId: string,
    fromRev: string,
    toRev: string,
    options: {
      include?: { bytes?: boolean; lines?: boolean; json?: boolean };
      context?: number;
      scope?: CardScope;
    } = {},
  ): DiffDto {
    const scope = options.scope ?? ALL_CARDS;
    const from = this.resolveVersion(cardId, fromRev, scope);
    const to = this.resolveVersion(cardId, toRev, scope);

    /*
     * 任一侧内容被清除 → 不读 blob（读了也没了），回一个**明确的空壳**。
     *
     * 不能返回"空 diff + identical:true"：那是"两个版本完全一样"的意思，
     * 与"内容被清掉了、没法比"是两件完全不同的事，而客户端会据此显示
     * "没有变化"。所以用一个显式标志，让上层必须区分这两种情况。
     */
    if ((from.pruned_at ?? null) !== null || (to.pruned_at ?? null) !== null) {
      const emptyBytes = {
        identical: false,
        fromSha256: from.blob_sha256,
        toSha256: to.blob_sha256,
        fromSize: from.byte_size,
        toSize: to.byte_size,
        sizeDelta: to.byte_size - from.byte_size,
        firstDiffOffset: null,
        commonPrefix: 0,
        commonSuffix: 0,
      } satisfies ByteComparison;
      return {
        from: this.versionDto(from),
        to: this.versionDto(to),
        bytes: emptyBytes,
        lines: {
          hunks: [],
          added: 0,
          removed: 0,
          truncated: false,
          oldLineCount: 0,
          newLineCount: 0,
          equalLinesButDifferentBytes: false,
        },
        json: { changes: [], truncated: false, parsed: false },
        identical: false,
        contentCleared: true,
      };
    }

    const fromBytes = this.blobs.read(from.blob_sha256);
    const toBytes = this.blobs.read(to.blob_sha256);
    const bytes = compareBytes(fromBytes, toBytes);
    const include = { bytes: true, lines: true, json: true, ...(options.include ?? {}) };

    const fromText = fromBytes.toString('utf8');
    const toText = toBytes.toString('utf8');

    const lines = include.lines
      ? diffLines(fromText, toText, { context: options.context ?? 3, bytesDiffer: !bytes.identical })
      : { hunks: [], added: 0, removed: 0, truncated: false, oldLineCount: 0, newLineCount: 0, equalLinesButDifferentBytes: false };
    const json = include.json ? diffJson(fromText, toText) : { changes: [], truncated: false, parsed: false };

    return {
      from: this.versionDto(from),
      to: this.versionDto(to),
      bytes: include.bytes ? bytes : { ...bytes },
      lines,
      json,
      identical: bytes.identical,
      contentCleared: false,
    };
  }

  // ────────────────────────────── 内部 ──────────────────────────────

  private allocateId(bytes: Buffer): string {
    // 先解析只为生成可读 id；解析失败会抛 422，不会创建任何记录
    const analyzed = analyzeCardBytes(bytes);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = `${slugify(analyzed.name)}-${randomBytes(3).toString('hex')}`;
      if (!this.db.getCard(id, { includeDeleted: true })) return id;
    }
    return `${slugify(analyzed.name)}-${sha256Of(bytes).slice(0, 8)}`;
  }

  private async commitSnapshot(input: {
    cardId: string;
    seq: number;
    bytes: Buffer;
    parentCommit: string | null;
    kind: VersionKind;
    options: WriteOptions;
    createdAt: string;
    origin: string;
    meta?: Record<string, unknown>;
  }): Promise<{
    row: NewVersionRow;
    name: string;
    analyzed: ReturnType<AuditService['run']>['analyzed'];
  }> {
    let auditResult: ReturnType<AuditService['run']>;
    try {
      auditResult = this.audit.run(
        input.bytes,
        {
          platformId: input.options.platformId,
          presetId: input.options.presetId,
          includeStDefaults: input.options.includeStDefaults,
        },
        input.origin,
      );
    } catch (error) {
      // 审计失败（规则文件损坏等）不允许静默跳过：直接失败，避免「无审计的版本」
      throw error;
    }

    const cardBlob = this.blobs.put(input.bytes);
    if (cardBlob.sha256 !== sha256Of(input.bytes)) {
      throw new AppError(500, 'INTERNAL', 'blob 写入后摘要不一致');
    }
    const auditBlob = this.blobs.put(auditResult.reportBytes);

    const message =
      input.options.message?.trim() ||
      (input.seq === 1 ? '初始版本' : input.kind === 'rollback' ? '回滚' : `更新 v${input.seq}`);
    const author = input.options.author?.trim() || 'Tavern Card Studio';

    const commit = await this.git.commitSnapshot({
      cardId: input.cardId,
      bytes: input.bytes,
      auditBytes: auditResult.reportBytes,
      message,
      author,
      parent: input.parentCommit,
    });

    const row: NewVersionRow = {
      cardId: input.cardId,
      seq: input.seq,
      commit: commit.commit,
      blobSha256: cardBlob.sha256,
      auditSha256: auditBlob.sha256,
      auditError: null,
      byteSize: input.bytes.byteLength,
      message,
      author,
      kind: input.kind,
      parentCommit: input.parentCommit,
      createdAt: input.createdAt,
      auditSummary: auditResult.report.summary,
      auditGeneratedAt: auditResult.report.generatedAt,
      meta: input.meta ?? {},
    };

    return { row, name: auditResult.analyzed.name, analyzed: auditResult.analyzed };
  }

  /** 用当前规则重算某版本的审计（不覆盖历史快照，供「按现行规则复核」使用） */
  recomputeAudit(
    cardId: string,
    rev: string | undefined,
    options: { platformId?: string | null; presetId?: string | null; scope?: CardScope },
  ): {
    report: AuditReport;
    reportBytes: Buffer;
    version: VersionDto;
    storedAuditSha256: string | null;
  } {
    const { bytes, version } = this.readBytes(cardId, rev, options.scope ?? ALL_CARDS);
    const result = this.audit.run(bytes, options, `server:${cardId}`);
    return {
      report: result.report,
      reportBytes: result.reportBytes,
      version: this.versionDto(version),
      storedAuditSha256: version.audit_sha256,
    };
  }

  /** 审计任意字节（不入库），供客户端「导出前审计」与服务端预检复用 */
  auditBytes(bytes: Buffer, options: { platformId?: string | null; presetId?: string | null; includeStDefaults?: boolean }): {
    report: AuditReport;
    reportBytes: Buffer;
    summary: AuditSummary;
  } {
    const result = this.audit.run(bytes, options, 'upload');
    return { report: result.report, reportBytes: result.reportBytes, summary: result.report.summary };
  }

  defaultsFor(): { platformId: string; presetId: string } {
    return { ...this.defaults };
  }
}
