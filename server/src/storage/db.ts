/**
 * SQLite 索引库（T5.1 / T5.2）。
 *
 * 只存**索引与元数据**：卡片名、规范版本、版本指针、审计摘要、事件日志。
 * 卡片正文永远不在这里 —— 正文字节在 blob 仓库、版本图在 Git 裸仓库。
 * 因此即使库损坏，凭 Git 仓库 + blob 也能把数据恢复出来（`tcs-server repair` 后续可加）。
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AuditSummary } from '@tcs/shared';

export type VersionKind = 'upload' | 'update' | 'rollback' | 'import';

/**
 * 卡片 ID 的来源（F11 / T9.7）。
 *
 *   · `client` —— 客户端/用户指定的 ID（v0.1.1 起的唯一新增方式）；
 *   · `auto`   —— 服务端自动发号（`slug-6位hex`），仅供**旧版客户端**上传时兼容；
 *   · `legacy` —— v0.1.1 之前入库的卡片（迁移时统一打上这个标记）。
 *
 * 为什么要在库里记一列，而不是靠格式猜：
 * `slug-abcdef` 这种形状用户完全可以手填。若用正则推断，一张新建的卡会被
 * 显示成"遗留卡片"，而"遗留"在界面上意味着"ID 是自动生成的、别指望它稳定"——
 * 给用户的信息就错了。事实就该记在库里。
 */
export type CardIdSource = 'client' | 'auto' | 'legacy';

export interface CardRow {
  id: string;
  /** 见 {@link CardIdSource}；迁移前的老行由 ALTER TABLE 的默认值补成 `legacy` */
  id_source: CardIdSource;
  name: string;
  spec: string;
  spec_version: string;
  creator: string;
  tags_json: string;
  source_filename: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version_count: number;
  latest_seq: number | null;
  latest_commit: string | null;
  latest_sha256: string | null;
  latest_size: number | null;
  latest_message: string | null;
  latest_at: string | null;
  parse_warnings_json: string;
  audit_sha256: string | null;
  audit_error: string | null;
  audit_generated_at: string | null;
  audit_error_count: number | null;
  audit_warning_count: number | null;
  audit_info_count: number | null;
  audit_exportable: number | null;
}

export interface VersionRow {
  card_id: string;
  seq: number;
  commit_sha: string;
  blob_sha256: string;
  audit_sha256: string | null;
  audit_error: string | null;
  byte_size: number;
  message: string;
  author: string;
  kind: VersionKind;
  parent_commit: string | null;
  created_at: string;
  audit_generated_at: string | null;
  audit_error_count: number | null;
  audit_warning_count: number | null;
  audit_info_count: number | null;
  audit_exportable: number | null;
  meta_json: string;
}

export interface NewVersionRow {
  cardId: string;
  seq: number;
  commit: string;
  blobSha256: string;
  auditSha256: string | null;
  auditError: string | null;
  byteSize: number;
  message: string;
  author: string;
  kind: VersionKind;
  parentCommit: string | null;
  createdAt: string;
  auditSummary: AuditSummary | null;
  auditGeneratedAt: string | null;
  meta?: Record<string, unknown>;
}

export interface EventRow {
  id: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  action: string;
  card_id: string | null;
  detail: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  id_source TEXT NOT NULL DEFAULT 'legacy',
  name TEXT NOT NULL,
  spec TEXT NOT NULL DEFAULT '',
  spec_version TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  source_filename TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version_count INTEGER NOT NULL DEFAULT 0,
  latest_seq INTEGER,
  latest_commit TEXT,
  latest_sha256 TEXT,
  latest_size INTEGER,
  latest_message TEXT,
  latest_at TEXT,
  parse_warnings_json TEXT NOT NULL DEFAULT '[]',
  audit_sha256 TEXT,
  audit_error TEXT,
  audit_generated_at TEXT,
  audit_error_count INTEGER,
  audit_warning_count INTEGER,
  audit_info_count INTEGER,
  audit_exportable INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cards_updated ON cards(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);

CREATE TABLE IF NOT EXISTS versions (
  card_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL,
  audit_sha256 TEXT,
  audit_error TEXT,
  byte_size INTEGER NOT NULL,
  message TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_commit TEXT,
  created_at TEXT NOT NULL,
  audit_generated_at TEXT,
  audit_error_count INTEGER,
  audit_warning_count INTEGER,
  audit_info_count INTEGER,
  audit_exportable INTEGER,
  meta_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (card_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_versions_card ON versions(card_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_versions_commit ON versions(commit_sha);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  action TEXT NOT NULL,
  card_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at DESC);
`;

/**
 * 给已存在的表补列（SQLite 没有 `ADD COLUMN IF NOT EXISTS`）。
 *
 * 为什么需要它：`CREATE TABLE IF NOT EXISTS` 对**已经建好的表**什么都不做，
 * 所以只改 SCHEMA 里的建表语句，老库不会得到新列 —— 而服务是以 Windows 服务
 * 长期驻留的，升级 MSI 后用的是同一份 ProgramData 库，这一步不能省。
 * 默认值要把**老数据的语义**写对：`id_source` 的默认是 `legacy`，
 * 于是所有迁移前入库的卡片自动被标成"遗留"，无需额外的回填脚本。
 */
function ensureColumn(handle: Database.Database, table: string, column: string, ddl: string): void {
  const columns = handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  handle.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export class Db {
  readonly handle: Database.Database;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.handle = new Database(file);
    this.handle.pragma('journal_mode = WAL');
    this.handle.pragma('foreign_keys = ON');
    this.handle.pragma('synchronous = FULL');
    this.handle.exec(SCHEMA);
    // v0.1.1（T9.7）：卡片 ID 从"服务端发号"改为"客户端指定"，需要记录来源以区分遗留卡
    ensureColumn(this.handle, 'cards', 'id_source', "id_source TEXT NOT NULL DEFAULT 'legacy'");
  }

  close(): void {
    this.handle.close();
  }

  insertCard(row: CardRow): void {
    this.handle
      .prepare(
        `INSERT INTO cards (
          id, id_source, name, spec, spec_version, creator, tags_json, source_filename, created_at, updated_at,
          deleted_at, version_count, latest_seq, latest_commit, latest_sha256, latest_size, latest_message,
          latest_at, parse_warnings_json, audit_sha256, audit_error, audit_generated_at,
          audit_error_count, audit_warning_count, audit_info_count, audit_exportable
        ) VALUES (
          @id, @id_source, @name, @spec, @spec_version, @creator, @tags_json, @source_filename, @created_at, @updated_at,
          @deleted_at, @version_count, @latest_seq, @latest_commit, @latest_sha256, @latest_size, @latest_message,
          @latest_at, @parse_warnings_json, @audit_sha256, @audit_error, @audit_generated_at,
          @audit_error_count, @audit_warning_count, @audit_info_count, @audit_exportable
        )`,
      )
      .run(row);
  }

  getCard(id: string, options: { includeDeleted?: boolean } = {}): CardRow | undefined {
    const row = this.handle.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
    if (!row) return undefined;
    if (row.deleted_at && !options.includeDeleted) return undefined;
    return row;
  }

  updateCardFromLatest(cardId: string, version: NewVersionRow, meta: { name: string; updatedAt: string }): void {
    this.handle
      .prepare(
        `UPDATE cards SET
          name = @name,
          updated_at = @updatedAt,
          version_count = @seq,
          latest_seq = @seq,
          latest_commit = @commit,
          latest_sha256 = @blobSha256,
          latest_size = @byteSize,
          latest_message = @message,
          latest_at = @createdAt,
          audit_sha256 = @auditSha256,
          audit_error = @auditError,
          audit_generated_at = @auditGeneratedAt,
          audit_error_count = @errorCount,
          audit_warning_count = @warningCount,
          audit_info_count = @infoCount,
          audit_exportable = @exportable
        WHERE id = @cardId`,
      )
      .run({
        cardId,
        name: meta.name,
        updatedAt: meta.updatedAt,
        seq: version.seq,
        commit: version.commit,
        blobSha256: version.blobSha256,
        byteSize: version.byteSize,
        message: version.message,
        createdAt: version.createdAt,
        auditSha256: version.auditSha256,
        auditError: version.auditError,
        auditGeneratedAt: version.auditGeneratedAt,
        errorCount: version.auditSummary?.error ?? null,
        warningCount: version.auditSummary?.warning ?? null,
        infoCount: version.auditSummary?.info ?? null,
        exportable: version.auditSummary ? (version.auditSummary.exportable ? 1 : 0) : null,
      });
  }

  listCards(options: { q?: string; limit: number; offset: number; includeDeleted?: boolean }): CardRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit, offset: options.offset };
    if (!options.includeDeleted) where.push('deleted_at IS NULL');
    if (options.q && options.q.trim() !== '') {
      where.push('(name LIKE @q OR id LIKE @q)');
      params['q'] = `%${options.q.trim()}%`;
    }
    const sql = `SELECT * FROM cards ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id ASC LIMIT @limit OFFSET @offset`;
    return this.handle.prepare(sql).all(params) as CardRow[];
  }

  countCards(options: { q?: string; includeDeleted?: boolean } = {}): number {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (!options.includeDeleted) where.push('deleted_at IS NULL');
    if (options.q && options.q.trim() !== '') {
      where.push('(name LIKE @q OR id LIKE @q)');
      params['q'] = `%${options.q.trim()}%`;
    }
    const sql = `SELECT COUNT(*) AS n FROM cards ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    return (this.handle.prepare(sql).get(params) as { n: number }).n;
  }

  softDelete(cardId: string, at: string): boolean {
    const result = this.handle
      .prepare('UPDATE cards SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(at, at, cardId);
    return result.changes > 0;
  }

  hardDelete(cardId: string): void {
    const tx = this.handle.transaction((id: string) => {
      this.handle.prepare('DELETE FROM versions WHERE card_id = ?').run(id);
      this.handle.prepare('DELETE FROM cards WHERE id = ?').run(id);
    });
    tx(cardId);
  }

  insertVersion(row: NewVersionRow): void {
    this.handle
      .prepare(
        `INSERT INTO versions (
          card_id, seq, commit_sha, blob_sha256, audit_sha256, audit_error, byte_size, message, author,
          kind, parent_commit, created_at, audit_generated_at, audit_error_count, audit_warning_count,
          audit_info_count, audit_exportable, meta_json
        ) VALUES (
          @cardId, @seq, @commit, @blobSha256, @auditSha256, @auditError, @byteSize, @message, @author,
          @kind, @parentCommit, @createdAt, @auditGeneratedAt, @errorCount, @warningCount,
          @infoCount, @exportable, @metaJson
        )`,
      )
      .run({
        cardId: row.cardId,
        seq: row.seq,
        commit: row.commit,
        blobSha256: row.blobSha256,
        auditSha256: row.auditSha256,
        auditError: row.auditError,
        byteSize: row.byteSize,
        message: row.message,
        author: row.author,
        kind: row.kind,
        parentCommit: row.parentCommit,
        createdAt: row.createdAt,
        auditGeneratedAt: row.auditGeneratedAt,
        errorCount: row.auditSummary?.error ?? null,
        warningCount: row.auditSummary?.warning ?? null,
        infoCount: row.auditSummary?.info ?? null,
        exportable: row.auditSummary ? (row.auditSummary.exportable ? 1 : 0) : null,
        metaJson: JSON.stringify(row.meta ?? {}),
      });
  }

  listVersions(cardId: string, options: { limit?: number; offset?: number } = {}): VersionRow[] {
    return this.handle
      .prepare(
        `SELECT * FROM versions WHERE card_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?`,
      )
      .all(cardId, options.limit ?? 200, options.offset ?? 0) as VersionRow[];
  }

  getVersion(cardId: string, seq: number): VersionRow | undefined {
    return this.handle
      .prepare('SELECT * FROM versions WHERE card_id = ? AND seq = ?')
      .get(cardId, seq) as VersionRow | undefined;
  }

  findVersionByCommit(cardId: string, commitPrefix: string): VersionRow | undefined {
    const rows = this.handle
      .prepare('SELECT * FROM versions WHERE card_id = ? AND commit_sha LIKE ? ORDER BY seq DESC')
      .all(cardId, `${commitPrefix.toLowerCase()}%`) as VersionRow[];
    return rows.length === 1 ? rows[0] : rows.length > 1 ? rows.find((row) => row.commit_sha === commitPrefix) : undefined;
  }

  countVersions(cardId: string): number {
    return (this.handle.prepare('SELECT COUNT(*) AS n FROM versions WHERE card_id = ?').get(cardId) as { n: number }).n;
  }

  /** 库内所有版本（用于统计与「无数据库恢复」校验） */
  allVersions(): VersionRow[] {
    return this.handle.prepare('SELECT * FROM versions ORDER BY card_id, seq').all() as VersionRow[];
  }

  appendEvent(event: {
    at: string;
    level: 'info' | 'warn' | 'error';
    action: string;
    cardId?: string | null;
    detail?: Record<string, unknown>;
  }): void {
    this.handle
      .prepare('INSERT INTO events (at, level, action, card_id, detail) VALUES (?, ?, ?, ?, ?)')
      .run(event.at, event.level, event.action, event.cardId ?? null, JSON.stringify(event.detail ?? {}));
  }

  listEvents(limit = 50): EventRow[] {
    return this.handle
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as EventRow[];
  }

  totals(): { cards: number; versions: number; bytes: number } {
    const cards = (this.handle.prepare('SELECT COUNT(*) AS n FROM cards WHERE deleted_at IS NULL').get() as { n: number }).n;
    const versions = (this.handle.prepare('SELECT COUNT(*) AS n FROM versions').get() as { n: number }).n;
    const bytes = (this.handle.prepare('SELECT COALESCE(SUM(byte_size), 0) AS n FROM versions').get() as { n: number }).n;
    return { cards, versions, bytes };
  }
}
