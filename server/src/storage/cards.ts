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
import type { CardRow, Db, NewVersionRow, VersionKind, VersionRow } from './db.js';
import { compareBytes, diffJson, diffLines, sha256Of, type ByteComparison, type JsonDiff, type LineDiff } from './diff.js';
import type { GitStore } from './git-store.js';

export interface WriteOptions {
  message?: string;
  author?: string;
  platformId?: string | null;
  presetId?: string | null;
  includeStDefaults?: boolean;
  filename?: string;
}

export interface CardSummaryDto {
  id: string;
  name: string;
  spec: string;
  specVersion: string;
  creator: string;
  tags: string[];
  sourceFilename: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  versionCount: number;
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
  sha256: string;
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
}

export interface DiffDto {
  from: VersionDto;
  to: VersionDto;
  bytes: ByteComparison;
  lines: LineDiff;
  json: JsonDiff;
  identical: boolean;
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

  summary(row: CardRow): CardSummaryDto {
    return {
      id: row.id,
      name: row.name,
      spec: row.spec,
      specVersion: row.spec_version,
      creator: row.creator,
      tags: JSON.parse(row.tags_json) as string[],
      sourceFilename: row.source_filename,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      versionCount: row.version_count,
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
      ...this.summary(row),
      parseWarnings: JSON.parse(row.parse_warnings_json) as CardDetailDto['parseWarnings'],
    };
  }

  versionDto(row: VersionRow): VersionDto {
    return {
      seq: row.seq,
      commit: row.commit_sha,
      sha256: row.blob_sha256,
      size: row.byte_size,
      message: row.message,
      author: row.author,
      kind: row.kind,
      parentCommit: row.parent_commit,
      createdAt: row.created_at,
      audit: summaryFromRow(row),
      auditError: row.audit_error,
      meta: JSON.parse(row.meta_json) as Record<string, unknown>,
    };
  }

  list(options: { q?: string; limit: number; offset: number; includeDeleted?: boolean }): {
    total: number;
    items: CardSummaryDto[];
  } {
    const rows = this.db.listCards(options);
    return { total: this.db.countCards(options), items: rows.map((row) => this.summary(row)) };
  }

  get(cardId: string, options: { includeDeleted?: boolean } = {}): CardDetailDto {
    const row = this.requireCard(cardId, options);
    return this.detail(row);
  }

  private requireCard(cardId: string, options: { includeDeleted?: boolean } = {}): CardRow {
    const row = this.db.getCard(cardId, options);
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', `角色卡不存在：${cardId}`);
    }
    return row;
  }

  resolveVersion(cardId: string, rev?: string | null): VersionRow {
    this.requireCard(cardId, { includeDeleted: true });
    const raw = rev === undefined || rev === null || rev === '' ? 'latest' : String(rev).trim();
    if (raw === 'latest') {
      const latest = this.db.listVersions(cardId, { limit: 1 })[0];
      if (!latest) throw new AppError(404, 'NOT_FOUND', `角色卡 ${cardId} 还没有任何版本`);
      return latest;
    }
    if (/^\d+$/.test(raw)) {
      const version = this.db.getVersion(cardId, Number.parseInt(raw, 10));
      if (!version) throw new AppError(404, 'NOT_FOUND', `版本不存在：${cardId} v${raw}`);
      return version;
    }
    if (/^[0-9a-fA-F]{4,40}$/.test(raw)) {
      const version = this.db.findVersionByCommit(cardId, raw.toLowerCase());
      if (!version) throw new AppError(404, 'NOT_FOUND', `提交不存在：${cardId} ${raw}`, { hint: '可用提交短 sha（至少 4 位）' });
      return version;
    }
    throw new AppError(400, 'BAD_REQUEST', `无法识别的版本标识：${raw}（可用 latest / 序号 / 提交 sha）`);
  }

  listVersions(cardId: string, options: { limit: number; offset: number }): {
    total: number;
    items: VersionDto[];
  } {
    this.requireCard(cardId, { includeDeleted: true });
    const rows = this.db.listVersions(cardId, options);
    return { total: this.db.countVersions(cardId), items: rows.map((row) => this.versionDto(row)) };
  }

  /** 读取某版本的**原始字节**（从 blob 读，校验 sha256） */
  readBytes(cardId: string, rev?: string | null): { bytes: Buffer; version: VersionRow } {
    const version = this.resolveVersion(cardId, rev);
    const bytes = this.blobs.read(version.blob_sha256);
    return { bytes, version };
  }

  readAuditBytes(cardId: string, rev?: string | null): { bytes: Buffer; version: VersionRow } {
    const version = this.resolveVersion(cardId, rev);
    if (!version.audit_sha256) {
      throw new AppError(404, 'NOT_FOUND', `版本 ${cardId} v${version.seq} 没有审计快照`, {
        auditError: version.audit_error,
      });
    }
    return { bytes: this.blobs.read(version.audit_sha256), version };
  }

  // ────────────────────────────── 写入 ──────────────────────────────

  async create(bytes: Buffer, options: WriteOptions = {}): Promise<{ card: CardDetailDto; version: VersionDto }> {
    const cardId = this.allocateId(bytes);
    return this.mutex.run(cardId, async () => {
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
        detail: { seq: 1, sha256: version.row.blobSha256, size: version.row.byteSize },
      });
      this.logger.info('card.create', { cardId, seq: 1, sha256: version.row.blobSha256, size: version.row.byteSize });

      const saved = this.requireCard(cardId);
      const savedVersion = this.db.getVersion(cardId, 1);
      if (!savedVersion) throw new AppError(500, 'INTERNAL', '版本写入后读回失败');
      return { card: this.detail(saved), version: this.versionDto(savedVersion) };
    });
  }

  async addVersion(cardId: string, bytes: Buffer, options: WriteOptions = {}): Promise<VersionDto> {
    return this.mutex.run(cardId, async () => {
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
    });
  }

  /** 回滚：以目标版本的原始字节新建提交（历史不重写） */
  async rollback(
    cardId: string,
    targetRev: string,
    options: { message?: string; author?: string } = {},
  ): Promise<{ version: VersionDto; restoredFrom: VersionDto }> {
    const target = this.resolveVersion(cardId, targetRev);
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

  async delete(cardId: string, options: { hard?: boolean } = {}): Promise<{ id: string; hard: boolean }> {
    return this.mutex.run(cardId, async () => {
      const card = this.requireCard(cardId, { includeDeleted: true });
      const at = new Date().toISOString();
      if (options.hard) {
        this.git.removeRepo(cardId);
        this.db.hardDelete(cardId);
        this.db.appendEvent({ at, level: 'warn', action: 'card.purge', cardId, detail: {} });
        this.logger.warn('card.purge', { cardId });
        return { id: cardId, hard: true };
      }
      if (!card.deleted_at) this.db.softDelete(cardId, at);
      this.db.appendEvent({ at, level: 'warn', action: 'card.delete', cardId, detail: { hard: false } });
      this.logger.warn('card.delete', { cardId });
      return { id: cardId, hard: false };
    });
  }

  stats(): {
    cards: number;
    versions: number;
    bytes: number;
    blobs: { count: number; bytes: number };
  } {
    const totals = this.db.totals();
    return { ...totals, blobs: this.blobs.stats() };
  }

  events(limit: number): Array<{ id: number; at: string; level: string; action: string; cardId: string | null; detail: unknown }> {
    return this.db.listEvents(limit).map((row) => ({
      id: row.id,
      at: row.at,
      level: row.level,
      action: row.action,
      cardId: row.card_id,
      detail: JSON.parse(row.detail) as unknown,
    }));
  }

  /** 三层 diff；默认同时给出，可用 include 选择（lines 在大文本下成本较高） */
  diff(
    cardId: string,
    fromRev: string,
    toRev: string,
    options: { include?: { bytes?: boolean; lines?: boolean; json?: boolean }; context?: number } = {},
  ): DiffDto {
    const from = this.resolveVersion(cardId, fromRev);
    const to = this.resolveVersion(cardId, toRev);
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
  recomputeAudit(cardId: string, rev: string | undefined, options: { platformId?: string | null; presetId?: string | null }): {
    report: AuditReport;
    reportBytes: Buffer;
    version: VersionDto;
    storedAuditSha256: string | null;
  } {
    const { bytes, version } = this.readBytes(cardId, rev);
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
