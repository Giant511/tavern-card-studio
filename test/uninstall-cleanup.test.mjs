/**
 * 卸载清理（F14.2 / T10.23）的行为测试。
 *
 * 这里**不读源文件、不 grep 字符串**，而是真的建一棵安装目录、真的跑一遍清理、
 * 真的把日志读回来断言。理由是这一类代码的坏法都很安静：
 *   · 白名单匹配写宽了 → 删掉用户文件，程序照样"成功"；
 *   · 字节数算错     → 日志里的证据是假的；
 *   · 删失败没记原因 → 用户只看到"清干净了"，实际留了一堆；
 *   · 日志落点在数据目录里 → 勾了"删数据"之后日志跟着消失，连痕迹都没有。
 * 静态断言一条也抓不到上面这些。
 *
 * 用真文件系统的另一个好处：`rmSync` 在 Windows 上对"目录/文件"的行为差异
 * （`recursive` 传错会直接抛）能被真实覆盖，不需要 mock。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CLEANUP_WHITELIST,
  classifyEntry,
  formatBytes,
  formatCleanupLog,
  previewUninstallCleanup,
  resolveLogPath,
  runUninstallCleanup,
} from '../server/dist/uninstall-cleanup.js';

/** 造一棵"装过一段时间"的安装目录：既有安装清单内的文件，也有各种残留 */
function makeInstallDir() {
  const root = mkdtempSync(join(tmpdir(), 'tcs-cleanup-'));
  const write = (relPath, content = 'x') => {
    const abs = join(root, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    return abs;
  };

  // 安装清单内的东西（MSI 自己删，清理动作必须一个都不碰）
  write('node.exe', 'MZ fake node');
  write('tcs-service-host.exe');
  write('app/server/dist/index.js');
  write('app/server/public/index.html');

  // 运行期残留（白名单内的）
  write('data/config.json', '{"port":8730}');
  write('data/state.db', 'sqlite bytes');
  write('data/store/blobs/aa', 'blob');
  write('logs/server.log', 'log line');
  write('cache/x.bin', 'cache');
  write('tmp/scratch.tmp', 'tmp');
  write('foreground.log', 'started');

  // 用户自己放的文件（白名单外，必须保住）
  write('user-notes.txt', 'my notes');

  return root;
}

function cleanupTmp(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // 测试目录清不掉不影响结论
  }
}

test('白名单内的删掉，白名单外的一律保留', () => {
  const installDir = makeInstallDir();
  const dataDir = mkdtempSync(join(tmpdir(), 'tcs-data-'));
  try {
    const result = runUninstallCleanup({ installDir, dataDir });

    // 删掉的
    for (const relPath of ['data', 'logs', 'cache', 'tmp', 'foreground.log']) {
      assert.equal(existsSync(join(installDir, relPath)), false, `${relPath} 应当被删`);
    }

    // 保住的 —— 这一组是"误删防线"，负向验证的核心
    for (const relPath of ['user-notes.txt', 'node.exe', 'tcs-service-host.exe', 'app/server/dist/index.js', 'app/server/public/index.html']) {
      assert.equal(existsSync(join(installDir, relPath)), true, `${relPath} 不该被删`);
    }

    const kept = result.kept.map((entry) => entry.path).sort();
    assert.deepEqual(kept, ['app', 'node.exe', 'tcs-service-host.exe', 'user-notes.txt']);
    assert.equal(result.failed, 0);
  } finally {
    cleanupTmp(installDir);
    cleanupTmp(dataDir);
  }
});

test('字节数按实际大小累计，目录算它下面所有文件', () => {
  const installDir = makeInstallDir();
  const dataDir = mkdtempSync(join(tmpdir(), 'tcs-data-'));
  try {
    const result = runUninstallCleanup({ installDir, dataDir });
    const dataEntry = result.entries.find((entry) => entry.path === 'data');
    assert.ok(dataEntry, '缺少 data 条目');
    // '{"port":8730}' 13 + 'sqlite bytes' 12 + 'blob' 4
    assert.equal(dataEntry.bytes, 13 + 12 + 4);
    assert.equal(dataEntry.files, 3);

    const logEntry = result.entries.find((entry) => entry.path === 'foreground.log');
    assert.ok(logEntry);
    assert.equal(logEntry.bytes, 'started'.length);
    assert.equal(logEntry.files, 1);

    // 合计 = 各白名单条目之和
    const sum = result.entries.reduce((total, entry) => total + entry.bytes, 0);
    assert.equal(result.removedBytes, sum);
  } finally {
    cleanupTmp(installDir);
    cleanupTmp(dataDir);
  }
});

test('删不掉的文件：记录原因、继续删别的、不抛异常', () => {
  const installDir = makeInstallDir();
  const dataDir = mkdtempSync(join(tmpdir(), 'tcs-data-'));
  const busy = join(installDir, 'data');
  try {
    const result = runUninstallCleanup({
      installDir,
      dataDir,
      // 注入一个"删 data 就 EBUSY"的删除器，模拟文件被服务/杀软占着
      remove: (absPath, isDirectory) => {
        if (absPath === busy) {
          const error = new Error('resource busy or locked');
          error.code = 'EBUSY';
          throw error;
        }
        assert.ok(isDirectory !== undefined);
        rmSync(absPath, { recursive: isDirectory, force: false });
      },
    });

    const dataEntry = result.entries.find((entry) => entry.path === 'data');
    assert.ok(dataEntry);
    assert.equal(dataEntry.removed, false);
    assert.match(dataEntry.reason ?? '', /EBUSY/);
    assert.match(dataEntry.reason ?? '', /resource busy/);
    assert.equal(result.failed, 1);

    // 其余条目照删（一个失败不能中断整轮清理）
    for (const relPath of ['logs', 'cache', 'tmp', 'foreground.log']) {
      assert.equal(existsSync(join(installDir, relPath)), false, `${relPath} 应当仍被删掉`);
    }
    assert.equal(existsSync(busy), true, '被占的目录应该还在');

    // 日志里必须出现原因 —— 这是"哪些删不掉及原因"这条需求的落点
    const log = readFileSync(result.logPath, 'utf8');
    assert.match(log, /FAILED\s+data/);
    assert.match(log, /reason: EBUSY: resource busy or locked/);
    assert.match(log, /failed 1 item/);
  } finally {
    cleanupTmp(installDir);
    cleanupTmp(dataDir);
  }
});

test('日志：写进数据目录、列出删了什么与保住了什么', () => {
  const installDir = makeInstallDir();
  const dataDir = mkdtempSync(join(tmpdir(), 'tcs-data-'));
  try {
    const result = runUninstallCleanup({ installDir, dataDir, now: new Date('2026-10-24T00:00:00Z') });
    assert.equal(result.logPath, join(dataDir, 'logs', 'uninstall-cleanup.log'));
    const log = readFileSync(result.logPath, 'utf8');

    assert.match(log, /=== Tavern Card Studio uninstall cleanup — 2026-10-24T00:00:00.000Z ===/);
    assert.match(log, /policy {6}: whitelist only/);
    assert.match(log, /DELETED\s+data/);
    assert.match(log, /DELETED\s+foreground\.log/);
    assert.match(log, /kept \(not on the whitelist/);
    assert.match(log, /KEPT\s+user-notes\.txt/);
    assert.match(log, /KEPT\s+node\.exe/);
    assert.match(log, /summary: deleted 7 file\(s\)/);
    // 用户文件绝不能出现在"已删"行里
    assert.doesNotMatch(log, /DELETED\s+user-notes\.txt/);
  } finally {
    cleanupTmp(installDir);
    cleanupTmp(dataDir);
  }
});

test('数据目录已被删时，日志改写到备用位置，且绝不重建数据目录', () => {
  const installDir = makeInstallDir();
  // 模拟"勾了同时删除数据"：dataDir 路径存在但它刚刚被 rmdir 掉了
  const ghostDataDir = join(mkdtempSync(join(tmpdir(), 'tcs-ghost-')), 'TavernCardStudio');
  const fallback = join(mkdtempSync(join(tmpdir(), 'tcs-fb-')), 'uninstall-cleanup.log');
  try {
    assert.equal(existsSync(ghostDataDir), false);
    const result = runUninstallCleanup({ installDir, dataDir: ghostDataDir, fallbackLogPath: fallback });

    assert.equal(result.logPath, fallback, '数据目录不在时必须退回备用落点');
    assert.equal(existsSync(ghostDataDir), false, '清理动作绝不能重建数据目录（否则"卸载后全清"是假的）');
    assert.equal(existsSync(fallback), true);
    assert.match(readFileSync(fallback, 'utf8'), /DELETED\s+data/);
  } finally {
    cleanupTmp(installDir);
    cleanupTmp(fallback.replace(/uninstall-cleanup\.log$/, ''));
    cleanupTmp(ghostDataDir.replace(/TavernCardStudio$/, ''));
  }
});

test('日志落点决策：数据目录存在才写它下面', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tcs-data-'));
  const fallback = join(tmpdir(), 'somewhere-else.log');
  try {
    assert.equal(resolveLogPath({ dataDir }), join(dataDir, 'logs', 'uninstall-cleanup.log'));
    // 数据目录不存在 → 用备用路径（并且不创建那个目录）
    const missing = join(dataDir, 'nope');
    assert.equal(resolveLogPath({ dataDir: missing, fallbackLogPath: fallback }), fallback);
    assert.equal(existsSync(missing), false);
  } finally {
    cleanupTmp(dataDir);
  }
});

test('干跑：不删任何东西、不写日志，但报告同样的清单', () => {
  const installDir = makeInstallDir();
  const dataDir = mkdtempSync(join(tmpdir(), 'tcs-data-'));
  try {
    const { text, result } = previewUninstallCleanup({ installDir, dataDir });

    for (const relPath of ['data', 'logs', 'cache', 'tmp', 'foreground.log', 'user-notes.txt', 'node.exe']) {
      assert.equal(existsSync(join(installDir, relPath)), true, `干跑不该动 ${relPath}`);
    }
    assert.equal(existsSync(join(dataDir, 'logs', 'uninstall-cleanup.log')), false, '干跑不写日志');
    assert.match(text, /dry-run — nothing was deleted/);
    assert.match(text, /data/);
    assert.equal(result.removedFiles, 0);
  } finally {
    cleanupTmp(installDir);
    cleanupTmp(dataDir);
  }
});

test('顶层才算：app\\server\\data\\ 这种"名字像残留"的路径不在白名单内', () => {
  const root = mkdtempSync(join(tmpdir(), 'tcs-scope-'));
  try {
    const nested = join(root, 'app', 'server', 'data');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'config.json'), '{}', 'utf8');

    const dataDir = mkdtempSync(join(tmpdir(), 'tcs-data-'));
    try {
      const result = runUninstallCleanup({ installDir: root, dataDir });
      assert.equal(existsSync(nested), true, '嵌套的同名目录不该被删（只认安装目录顶层）');
      assert.equal(result.entries.length, 0);
      assert.deepEqual(result.kept.map((entry) => entry.path), ['app']);
    } finally {
      cleanupTmp(dataDir);
    }
  } finally {
    cleanupTmp(root);
  }
});

test('白名单本身：只有六类，且每类都说明了理由', () => {
  assert.equal(CLEANUP_WHITELIST.length, 6);
  for (const rule of CLEANUP_WHITELIST) {
    assert.ok(rule.note.length > 10, `${rule.category} 缺少说明`);
    assert.ok(['dir', 'file'].includes(rule.kind));
  }
  const categories = CLEANUP_WHITELIST.map((rule) => rule.category).sort();
  assert.deepEqual(categories, ['cache', 'data', 'logfile', 'logs', 'temp', 'tmpfile']);
});

test('分类：大小写不敏感，目录名不会被当成文件匹配', () => {
  assert.equal(classifyEntry('DATA', true)?.category, 'data');
  // 名字叫 data 的文件不删（不是目录）
  assert.equal(classifyEntry('data', false), null);
  // .log 结尾的目录不删（不是文件）
  assert.equal(classifyEntry('old.log', true), null);
  assert.equal(classifyEntry('old.log', false)?.category, 'logfile');
  assert.equal(classifyEntry('notes.txt', false), null);
  assert.equal(classifyEntry('unins000.exe', false), null);
});

test('安装目录不存在：不抛、记一条 missingDir、日志仍落盘', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tcs-data-'));
  try {
    const result = runUninstallCleanup({ installDir: join(dataDir, 'no-such-dir'), dataDir });
    assert.equal(result.missingDir, true);
    assert.equal(result.removedFiles, 0);
    assert.match(readFileSync(result.logPath, 'utf8'), /does not exist/);
  } finally {
    cleanupTmp(dataDir);
  }
});

test('重复执行是安全的（第一次已把残留删光）', () => {
  const installDir = makeInstallDir();
  const dataDir = mkdtempSync(join(tmpdir(), 'tcs-data-'));
  try {
    const first = runUninstallCleanup({ installDir, dataDir });
    const second = runUninstallCleanup({ installDir, dataDir });
    assert.ok(first.entries.length > 0);
    assert.equal(second.entries.length, 0, '第二遍不该再找到白名单条目');
    assert.equal(second.failed, 0);
    // 追加写：两遍都要留痕
    const log = readFileSync(second.logPath, 'utf8');
    assert.equal(log.match(/=== Tavern Card Studio uninstall cleanup/g)?.length, 2);
  } finally {
    cleanupTmp(installDir);
    cleanupTmp(dataDir);
  }
});

test('事件日志失败只记录，不影响清理结果', () => {
  const installDir = makeInstallDir();
  const dataDir = mkdtempSync(join(tmpdir(), 'tcs-data-'));
  try {
    const result = runUninstallCleanup({
      installDir,
      dataDir,
      eventLog: true,
      writeEventLog: () => {
        throw new Error('access denied');
      },
    });
    assert.match(result.eventLog, /^failed: access denied$/);
    assert.equal(result.failed, 0, '事件日志失败不算清理失败');
    assert.match(readFileSync(result.logPath, 'utf8'), /event log: failed: access denied/);
  } finally {
    cleanupTmp(installDir);
    cleanupTmp(dataDir);
  }
});

test('事件日志成功时记录一行摘要，且摘要里带数量与体积', () => {
  const installDir = makeInstallDir();
  const dataDir = mkdtempSync(join(tmpdir(), 'tcs-data-'));
  const lines = [];
  try {
    const result = runUninstallCleanup({
      installDir,
      dataDir,
      eventLog: true,
      writeEventLog: (message) => lines.push(message),
    });
    assert.equal(result.eventLog, 'written');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /deleted 7 file\(s\) \/ \d+ B/);
    assert.match(lines[0], /failed 0/);
  } finally {
    cleanupTmp(installDir);
    cleanupTmp(dataDir);
  }
});

test('字节格式化：日志要人能读', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 3.5), '3.5 MB');
});

test('日志正文在没有残留、没有保留项时也自洽', () => {
  const text = formatCleanupLog(
    {
      installDir: 'C:\\X',
      logPath: 'C:\\L.log',
      entries: [],
      kept: [],
      removedBytes: 0,
      removedFiles: 0,
      failed: 0,
      eventLog: 'skipped',
    },
    new Date('2026-10-24T00:00:00Z'),
  );
  assert.match(text, /whitelisted leftovers: none/);
  assert.match(text, /deleted 0 file\(s\)/);
});
