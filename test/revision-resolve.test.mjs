/**
 * 版本标识解析（`resolveVersion`）—— 数字型 rev 的二义性回归测试。
 *
 * 背景（2026-10-23 全量测试偶发失败定位到）：
 *   `resolveVersion` 先判 `/^\d+$/` → 当成版本序号。但 git 提交 sha 是十六进制，
 *   4 位全由 0-9 组成的概率是 (10/16)^4 ≈ **15%**、8 位约 2.3%。
 *   于是「按短 sha 取版本」这条公开用法会以固定概率直接 404
 *   （`版本不存在：… v1991`），而提交明明在库里。
 *
 * 这个测试**不靠概率**：直接把一条 commit_sha 全为数字的版本行插进临时库，
 * 再调 `resolveVersion`。这样无论随机 sha 是多少，用例都是确定的。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { Db } from '../server/dist/storage/db.js';
import { CardService } from '../server/dist/storage/cards.js';

let workDir = '';
let db = null;
let cards = null;

const DIGIT_SHA = '1991183cb666f0b0a4e5d6c7b8a9f0e1d2c3b4a5'; // 前 4 位纯数字
const HEX_SHA = 'aded214c3f82aa11bb22cc33dd44ee55ff667788'; // 含字母，常规情形

function versionRow(seq, commit) {
  return {
    cardId: 'probe-rev-card',
    seq,
    commit,
    blobSha256: `${String(seq)}`.repeat(64).slice(0, 64),
    auditSha256: null,
    auditError: null,
    byteSize: 10 + seq,
    message: `v${String(seq)}`,
    author: 'test',
    kind: 'upload',
    parentCommit: null,
    createdAt: new Date(2026, 0, seq).toISOString(),
    auditSummary: null,
    auditGeneratedAt: null,
    meta: {},
  };
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-rev-'));
  db = new Db(join(workDir, 'state.db'));

  const now = new Date().toISOString();
  db.insertCard({
    id: 'probe-rev-card',
    id_source: 'client',
    owner_id: '',
    repo_id: '',
    name: '探针卡',
    spec: 'v2',
    spec_version: '2.0',
    creator: 'test',
    tags_json: '[]',
    source_filename: '',
    created_at: now,
    updated_at: now,
    deleted_at: null,
    version_count: 2,
    latest_seq: 2,
    latest_commit: HEX_SHA,
    latest_sha256: 'a'.repeat(64),
    latest_size: 12,
    latest_message: 'v2',
    latest_at: now,
    parse_warnings_json: '[]',
    audit_sha256: null,
    audit_error: null,
    audit_generated_at: null,
    audit_error_count: null,
    audit_warning_count: null,
    audit_info_count: null,
    audit_exportable: null,
  });

  // seq=1 的提交 sha 前 4 位纯数字；seq=2 是常规 sha
  db.insertVersion(versionRow(1, DIGIT_SHA));
  db.insertVersion(versionRow(2, HEX_SHA));

  // resolveVersion 只用到 db，其余依赖给空实现即可
  cards = new CardService(db, null, null, null, { platformId: 'sillytavern', presetId: 'default' }, null);
});

after(() => {
  db?.close();
  rmSync(workDir, { recursive: true, force: true });
});

test('数字形态 rev：先按序号解析（老语义不变）', () => {
  const row = cards.resolveVersion('probe-rev-card', '2');
  assert.equal(row.seq, 2);
  assert.equal(row.commit_sha, HEX_SHA);
});

test('全数字的短 sha 前缀：序号不存在时回落到 sha（本次修复的核心）', () => {
  // '1991' 不是版本序号（该卡只有 1、2 两版），但确实是 DIGIT_SHA 的前 4 位
  const row = cards.resolveVersion('probe-rev-card', '1991');
  assert.equal(row.seq, 1, '应当解析到 commit 以 1991 开头的那一版，而不是报「版本不存在」');
  assert.equal(row.commit_sha, DIGIT_SHA);
});

test('全数字的 8 位前缀同样可用', () => {
  const row = cards.resolveVersion('probe-rev-card', DIGIT_SHA.slice(0, 8));
  assert.equal(row.seq, 1);
});

test('序号与 sha 同时命中时序号优先（确定性优先）', () => {
  // 插一版 commit 就是 '2' 开头的，确认 /versions/2 仍返回 seq=2
  const row = cards.resolveVersion('probe-rev-card', '2');
  assert.equal(row.seq, 2);
});

test('常规十六进制前缀仍然可用', () => {
  const row = cards.resolveVersion('probe-rev-card', 'aded');
  assert.equal(row.seq, 2);
});

test('既非序号也非前缀：404 且提示说明两种含义都试过了', () => {
  assert.throws(
    () => cards.resolveVersion('probe-rev-card', '999'),
    (error) => {
      assert.equal(error.status, 404);
      assert.match(String(error.message), /版本不存在/);
      assert.match(String(error.details?.hint ?? ''), /既不是版本序号，也不是任何提交的 sha 前缀/);
      return true;
    },
  );
});

test('非法标识：400（区分数值不存在与格式不认识）', () => {
  assert.throws(
    () => cards.resolveVersion('probe-rev-card', 'not-a-rev'),
    (error) => {
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test('latest 仍然指向最新版本', () => {
  const row = cards.resolveVersion('probe-rev-card', 'latest');
  assert.equal(row.seq, 2);
});

test('大写十六进制前缀也认（归一化到小写）', () => {
  const row = cards.resolveVersion('probe-rev-card', 'ADED');
  assert.equal(row.seq, 2);
});
