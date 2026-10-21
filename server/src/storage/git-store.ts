/**
 * 每个角色卡一个 Git 裸仓库（`dataDir/repos/<cardId>.git`）。
 *
 * 为什么既要 blob 仓库又要 Git：
 *   · blob 仓库是**事实源**：上传字节原样存放，读出来逐字节相等；
 *   · Git 仓库是**版本图**：提交、父提交、消息、作者、审计快照，天然支持 `git log` / `git fsck` 外部核验。
 *
 * 提交内容：
 *   card.json   —— 上传的原始字节（不解析、不美化、不重排键序）
 *   audit.json  —— 该次提交的审计报告（硬约束 2：审计随版本快照存储）
 *
 * 这里刻意不用 `git.commit()`（它需要工作区、会经过 status/index）；直接写
 * blob → tree → commit → ref，路径最短，不可能对内容做任何变换。
 */

import fs, { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import git from 'isomorphic-git';

const AUTHOR_EMAIL = 'server@tavern-card-studio.local';

export interface CommitInput {
  cardId: string;
  /** 卡片原始字节 */
  bytes: Uint8Array;
  /** 审计报告字节（可选：解析失败时没有报告） */
  auditBytes?: Uint8Array | null;
  message: string;
  author: string;
  /** 父提交；首次提交传 null */
  parent?: string | null;
  /** Unix 秒 */
  timestamp?: number;
  timezoneOffset?: number;
}

export interface CommitResult {
  commit: string;
  cardBlobOid: string;
  auditBlobOid: string | null;
  tree: string;
}

export interface GitCommitInfo {
  oid: string;
  message: string;
  author: string;
  timestamp: number;
  parent: string | null;
  tree: string;
}

export class GitStore {
  readonly root: string;
  private readonly ready = new Set<string>();

  constructor(root: string) {
    this.root = root;
    mkdirSync(this.root, { recursive: true });
  }

  repoDir(cardId: string): string {
    return join(this.root, `${cardId}.git`);
  }

  async ensureRepo(cardId: string): Promise<string> {
    const dir = this.repoDir(cardId);
    if (!this.ready.has(dir)) {
      if (!existsSync(dir)) {
        await git.init({ fs, dir, gitdir: dir, bare: true, defaultBranch: 'main' });
      }
      this.ready.add(dir);
    }
    return dir;
  }

  /** 提交一份快照；返回 git 对象 id（供外部 `git cat-file` 核验） */
  async commitSnapshot(input: CommitInput): Promise<CommitResult> {
    const dir = await this.ensureRepo(input.cardId);
    const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
    const author = {
      name: input.author,
      email: AUTHOR_EMAIL,
      timestamp,
      timezoneOffset: input.timezoneOffset ?? -new Date().getTimezoneOffset(),
    };

    const cardBlobOid = await git.writeBlob({ fs, dir, gitdir: dir, blob: input.bytes });
    const entries: Array<{ mode: '100644'; path: string; oid: string; type: 'blob' }> = [
      { mode: '100644', path: 'card.json', oid: cardBlobOid, type: 'blob' },
    ];

    let auditBlobOid: string | null = null;
    if (input.auditBytes && input.auditBytes.byteLength > 0) {
      auditBlobOid = await git.writeBlob({ fs, dir, gitdir: dir, blob: input.auditBytes });
      entries.push({ mode: '100644', path: 'audit.json', oid: auditBlobOid, type: 'blob' });
    }

    const tree = await git.writeTree({ fs, dir, gitdir: dir, tree: entries });
    const commit = await git.writeCommit({
      fs,
      dir,
      gitdir: dir,
      commit: {
        tree,
        parent: input.parent ? [input.parent] : [],
        message: input.message,
        author,
        committer: author,
      },
    });
    await git.writeRef({ fs, dir, gitdir: dir, ref: 'refs/heads/main', value: commit, force: true });

    return { commit, cardBlobOid, auditBlobOid, tree };
  }

  /** 读取某次提交里的原始卡片字节（与上传字节逐字节相等） */
  async readCardBytes(cardId: string, commitOid: string): Promise<Buffer> {
    const dir = await this.ensureRepo(cardId);
    const { commit } = await git.readCommit({ fs, dir, gitdir: dir, oid: commitOid });
    const { tree } = await git.readTree({ fs, dir, gitdir: dir, oid: commit.tree });
    const entry = tree.find((item) => item.path === 'card.json');
    if (!entry) {
      throw new Error(`提交 ${commitOid} 中没有 card.json`);
    }
    const { blob } = await git.readBlob({ fs, dir, gitdir: dir, oid: entry.oid });
    return Buffer.from(blob);
  }

  async readAuditBytes(cardId: string, commitOid: string): Promise<Buffer | null> {
    const dir = await this.ensureRepo(cardId);
    const { commit } = await git.readCommit({ fs, dir, gitdir: dir, oid: commitOid });
    const { tree } = await git.readTree({ fs, dir, gitdir: dir, oid: commit.tree });
    const entry = tree.find((item) => item.path === 'audit.json');
    if (!entry) return null;
    const { blob } = await git.readBlob({ fs, dir, gitdir: dir, oid: entry.oid });
    return Buffer.from(blob);
  }

  /** 历史（新 → 旧）；用于测试与 `git log` 交叉验证 */
  async log(cardId: string, depth = 100): Promise<GitCommitInfo[]> {
    const dir = await this.ensureRepo(cardId);
    try {
      const entries = await git.log({ fs, dir, gitdir: dir, ref: 'main', depth });
      return entries.map((entry) => ({
        oid: entry.oid,
        message: entry.commit.message.trimEnd(),
        author: entry.commit.author.name,
        timestamp: entry.commit.author.timestamp,
        parent: entry.commit.parent[0] ?? null,
        tree: entry.commit.tree,
      }));
    } catch {
      return [];
    }
  }

  removeRepo(cardId: string): void {
    const dir = this.repoDir(cardId);
    this.ready.delete(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}
