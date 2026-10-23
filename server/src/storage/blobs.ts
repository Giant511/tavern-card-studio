/**
 * 内容寻址的原始字节仓库（T5.1 硬约束 1）。
 *
 * 角色卡上传的**原始字节**只经过这一条路径落盘：
 *   bytes → sha256 → blobs/<前两位>/<sha256>
 *
 * 这里不做任何解析、解码、格式化、换行归一化。解压后的路径与内容一旦写入就不再修改；
 * 相同内容重复上传得到相同 sha256（自然去重，也不会产生「同内容不同字节」的版本噪声）。
 * JSON 解析只发生在 `card-index`（建索引）与 `audit`（审计）里，回写永远走这份原始字节。
 */

import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { AppError } from '../errors.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface PutResult {
  sha256: string;
  size: number;
  /** 命中已有 blob（内容相同） */
  existed: boolean;
}

export interface BlobStats {
  count: number;
  bytes: number;
}

export class BlobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(this.root, { recursive: true });
  }

  static sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  pathFor(sha256: string): string {
    if (!SHA256_PATTERN.test(sha256)) {
      throw new AppError(500, 'BLOB_CORRUPTED', `非法的 blob 摘要：${sha256}`);
    }
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  has(sha256: string): boolean {
    return existsSync(this.pathFor(sha256));
  }

  /**
   * 删除一份 blob（T10.18 / purge 用）。
   *
   * **只在确认没有任何版本还引用它时调用** —— blob 是按内容去重的，
   * 同一份字节可能被多张卡、多个版本共享。调用点必须先查
   * `Db.countVersionsUsingBlob`，否则会删掉别人还在用的内容
   * （表现为"另一张卡突然读不出来"，而不是报错）。
   */
  remove(sha256: string): boolean {
    const path = this.pathFor(sha256);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  put(bytes: Uint8Array): PutResult {
    const sha256 = BlobStore.sha256(bytes);
    const target = this.pathFor(sha256);
    const dir = join(this.root, sha256.slice(0, 2));
    mkdirSync(dir, { recursive: true });

    if (existsSync(target)) {
      const size = statSync(target).size;
      if (size !== bytes.byteLength) {
        throw new AppError(500, 'BLOB_CORRUPTED', `blob 已存在但长度不符：${sha256}`, { expected: bytes.byteLength, actual: size });
      }
      return { sha256, size, existed: true };
    }

    const tmp = join(dir, `.${sha256}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, bytes);
    try {
      renameSync(tmp, target);
    } catch (error) {
      rmSync(tmp, { force: true });
      if (!existsSync(target)) throw error;
    }
    return { sha256, size: bytes.byteLength, existed: false };
  }

  /** 读取并校验摘要；任何不一致都视为存储损坏，绝不「尽量读出来」 */
  read(sha256: string, options: { verify?: boolean } = {}): Buffer {
    const path = this.pathFor(sha256);
    if (!existsSync(path)) {
      throw new AppError(500, 'BLOB_CORRUPTED', `blob 不存在：${sha256}`);
    }
    const bytes = readFileSync(path);
    if (options.verify !== false) {
      const actual = BlobStore.sha256(bytes);
      if (actual !== sha256) {
        throw new AppError(500, 'BLOB_CORRUPTED', `blob 摘要校验失败：期望 ${sha256}，实际 ${actual}`);
      }
    }
    return bytes;
  }

  size(sha256: string): number {
    return statSync(this.pathFor(sha256)).size;
  }

  stats(): BlobStats {
    let count = 0;
    let bytes = 0;
    for (const shard of readdirSync(this.root, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      const dir = join(this.root, shard.name);
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile() || file.name.endsWith('.tmp')) continue;
        count += 1;
        bytes += statSync(join(dir, file.name)).size;
      }
    }
    return { count, bytes };
  }

  /** 流式读取（下载大文件时避免整块进内存）；调用方负责校验 sha256 */
  stream(sha256: string): ReturnType<typeof createReadStream> {
    const path = this.pathFor(sha256);
    if (!existsSync(path)) {
      throw new AppError(500, 'BLOB_CORRUPTED', `blob 不存在：${sha256}`);
    }
    return createReadStream(path);
  }
}
