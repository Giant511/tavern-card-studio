/**
 * 运行期写安装目录自检（F14.3 / T10.24）的行为测试。
 *
 * 全部用真实文件系统：造目录、写文件、拍快照、比对。不 mock `fs` —— 这个模块的
 * 价值恰恰是"看文件系统的真实结果"，mock 掉 fs 就等于把它要证明的东西假设成真。
 *
 * 覆盖四类判据：
 *   1. 配置项：`dataDir` 落在安装目录内 → 告警；在外 → 不告警；`rulesDir` 在内 **不**告警
 *      （MSI 布局里它本来就在 `%BASE%\app\rules`，且只读）；
 *   2. 残留扫描：六类运行期生成物 → 告警；安装清单文件 → 不告警；
 *   3. 快照比对：新增/改写 → 告警；未变 → 不告警；删除 → 不告警；白名单 → 不告警；
 *   4. 监视器：真建文件能被发现、同一路径只报一次、stop() 之后不再报、
 *      onIssue 抛异常不能把服务带崩。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  checkDataDirOutsideInstallDir,
  checkInstallDirAtStartup,
  diffInstallDirSnapshot,
  installDirFromExecPath,
  isPathInside,
  relativeToInstallDir,
  scanInstallDirResidue,
  snapshotInstallDir,
  startInstallDirWatch,
} from '../server/dist/install-dir-watch.js';
import { normalizeConfig } from '../server/dist/config.js';

function makeTmp(prefix = 'tcs-idw-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 测试目录清不掉不影响结论
  }
}

/** 造一棵"装好的服务端"目录：有安装清单文件，也可以带运行期残留 */
function makeInstallDir({ residue = false } = {}) {
  const root = makeTmp();
  const write = (rel, content = 'x') => {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    return abs;
  };
  write('node.exe', 'MZ');
  write('tcs-service-host.exe');
  write('tcs-service-host.xml');
  write('install-layout.ini');
  write('app/server/dist/index.js', 'module');
  write('app/rules/platforms/character-card-v2.json', '{}');

  if (residue) {
    write('data/config.json', '{"port":8730}');
    write('logs/server.log', 'line');
    write('run.log', 'x');
  }
  return root;
}

// ────────────────────────────────────────── 1. 路径判定

test('isPathInside：前缀相同但目录不同的两个路径必须分开', () => {
  // 这是本模块最要紧的边界：`…\Server` 是 `…\Server.backup` 的前缀，
  // 但后者不在前者里面。用 startsWith 就会把它们混成一个。
  const parent = 'C:\\Program Files\\Tavern Card Studio Server';
  assert.equal(isPathInside(parent, 'C:\\Program Files\\Tavern Card Studio Server\\data'), true);
  assert.equal(isPathInside(parent, 'C:\\Program Files\\Tavern Card Studio Server'), true);
  assert.equal(isPathInside(parent, 'C:\\Program Files\\Tavern Card Studio Server.backup\\data'), false);
  assert.equal(isPathInside(parent, 'C:\\Program Files\\Other\\data'), false);
  // 大小写不敏感（Windows 语义）
  assert.equal(isPathInside(parent, 'c:\\program files\\tavern card studio server\\DATA'), true);
});

test('relativeToInstallDir：在里面给相对路径，在外面给 null', () => {
  const parent = 'C:\\App\\Server';
  assert.equal(relativeToInstallDir(parent, 'C:\\App\\Server\\data\\config.json'), 'data/config.json');
  assert.equal(relativeToInstallDir(parent, 'C:\\App\\Server'), '');
  assert.equal(relativeToInstallDir(parent, 'C:\\App\\ServerX\\a'), null);
});

// ────────────────────────────────────────── 2. 配置项检查

test('dataDir 落在安装目录内 → 告警，并指出后果', () => {
  const installDir = 'C:\\Program Files\\Tavern Card Studio Server';
  const issue = checkDataDirOutsideInstallDir(`${installDir}\\data`, installDir);
  assert.ok(issue, '应当告警');
  assert.equal(issue.kind, 'config-path');
  assert.match(issue.detail, /dataDir/);
  assert.match(issue.detail, /data/);
  assert.match(issue.hint, /ProgramData/, '建议里要给出正确方向');
});

test('dataDir 在安装目录外 → 不告警（默认布局就是这样）', () => {
  const installDir = 'C:\\Program Files\\Tavern Card Studio Server';
  assert.equal(checkDataDirOutsideInstallDir('C:\\ProgramData\\TavernCardStudio', installDir), null);
});

test('rulesDir 在安装目录内不算问题 —— MSI 布局本来如此，且它是只读的', () => {
  // 这不是"顺手放过"：如果把 rulesDir 也拿来判，MSI 装出来的每一台机器
  // 每次启动都会告警一条，而那条告警永远是噪音 —— 噪音的结局是没人看日志。
  const installDir = makeInstallDir();
  try {
    const issues = checkInstallDirAtStartup({
      installDir,
      dataDir: 'C:\\ProgramData\\TavernCardStudio',
    });
    assert.deepEqual(issues, [], `不该有任何告警，实际：${issues.map((i) => i.detail).join('; ')}`);
  } finally {
    cleanup(installDir);
  }
});

// ────────────────────────────────────────── 3. 残留扫描

test('安装目录里的六类运行期生成物都会被扫出来', () => {
  const installDir = makeInstallDir({ residue: true });
  try {
    const issues = scanInstallDirResidue(installDir);
    const names = issues.map((issue) => issue.path.toLowerCase().split('\\').pop()).sort();
    assert.deepEqual(names, ['data', 'logs', 'run.log']);
    for (const issue of issues) {
      assert.equal(issue.kind, 'residue');
      assert.match(issue.hint, /cleanup/, '建议里应指向 tcs-server cleanup');
    }
  } finally {
    cleanup(installDir);
  }
});

test('安装清单文件不会被当成残留（node.exe / app / 宿主）', () => {
  const installDir = makeInstallDir();
  try {
    assert.deepEqual(scanInstallDirResidue(installDir), []);
  } finally {
    cleanup(installDir);
  }
});

test('只扫顶层：app\\server\\data 这种嵌套同名目录不算残留', () => {
  const installDir = makeInstallDir();
  try {
    mkdirSync(join(installDir, 'app', 'server', 'data'), { recursive: true });
    mkdirSync(join(installDir, 'app', 'server', 'logs'), { recursive: true });
    assert.deepEqual(scanInstallDirResidue(installDir), [], '嵌套目录不是残留（那是安装清单的一部分）');
  } finally {
    cleanup(installDir);
  }
});

// ────────────────────────────────────────── 4. 快照比对

test('快照能看见嵌套文件；新增文件被判定为运行期写入', () => {
  const installDir = makeInstallDir();
  try {
    const before = snapshotInstallDir(installDir);
    assert.ok(before.has('node.exe'));
    assert.ok(before.has('app/server/dist/index.js'), '快照要递归进子目录');

    writeFileSync(join(installDir, 'data'), '', 'utf8'); // 先占位再换目录太绕，直接写文件
    const after = snapshotInstallDir(installDir);
    const issues = diffInstallDirSnapshot(before, after);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'runtime-write');
    assert.match(issues[0].detail, /运行期新增文件/);
  } finally {
    cleanup(installDir);
  }
});

test('新增目录里的文件也被抓（data\\config.json 这种典型残留）', () => {
  const installDir = makeInstallDir();
  try {
    const before = snapshotInstallDir(installDir);
    mkdirSync(join(installDir, 'data'), { recursive: true });
    writeFileSync(join(installDir, 'data', 'config.json'), '{"port":8730}', 'utf8');
    const issues = diffInstallDirSnapshot(before, snapshotInstallDir(installDir));
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, 'data/config.json');
  } finally {
    cleanup(installDir);
  }
});

test('内容被改写也能抓到（不只是新增）', () => {
  const installDir = makeInstallDir();
  try {
    const before = snapshotInstallDir(installDir);
    writeFileSync(join(installDir, 'tcs-service-host.xml'), '<service/>', 'utf8');
    const issues = diffInstallDirSnapshot(before, snapshotInstallDir(installDir));
    assert.equal(issues.length, 1);
    assert.match(issues[0].detail, /运行期改动了/);
  } finally {
    cleanup(installDir);
  }
});

test('未改动 → 不告警（这是"零噪音"的那条基线）', () => {
  const installDir = makeInstallDir();
  try {
    const before = snapshotInstallDir(installDir);
    assert.deepEqual(diffInstallDirSnapshot(before, snapshotInstallDir(installDir)), []);
  } finally {
    cleanup(installDir);
  }
});

test('删除不告警：本任务只关心"被写"，删文件是另一类问题', () => {
  const installDir = makeInstallDir();
  try {
    const before = snapshotInstallDir(installDir);
    rmSync(join(installDir, 'install-layout.ini'));
    assert.deepEqual(diffInstallDirSnapshot(before, snapshotInstallDir(installDir)), []);
  } finally {
    cleanup(installDir);
  }
});

test('白名单放行的路径不告警（有意把 dataDir 指进来时才用）', () => {
  const installDir = makeInstallDir();
  try {
    const before = snapshotInstallDir(installDir);
    mkdirSync(join(installDir, 'data'), { recursive: true });
    writeFileSync(join(installDir, 'data', 'config.json'), '{}', 'utf8');
    writeFileSync(join(installDir, 'other.txt'), 'x', 'utf8');

    const issues = diffInstallDirSnapshot(before, snapshotInstallDir(installDir), { allow: ['data'] });
    assert.equal(issues.length, 1, 'data 被放行，other.txt 仍要报');
    assert.equal(issues[0].path, 'other.txt');
  } finally {
    cleanup(installDir);
  }
});

test('默认白名单为空：写 data\\ 必须告警（否则就把检测目标排除了）', () => {
  const installDir = makeInstallDir();
  try {
    const before = snapshotInstallDir(installDir);
    mkdirSync(join(installDir, 'data'), { recursive: true });
    writeFileSync(join(installDir, 'data', 'state.db'), 'sqlite', 'utf8');
    const issues = diffInstallDirSnapshot(before, snapshotInstallDir(installDir));
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, 'data/state.db');
  } finally {
    cleanup(installDir);
  }
});

test('白名单是前缀匹配而不是子串匹配：dat 不该放行 data', () => {
  const installDir = makeInstallDir();
  try {
    const before = snapshotInstallDir(installDir);
    mkdirSync(join(installDir, 'data'), { recursive: true });
    writeFileSync(join(installDir, 'data', 'x.txt'), 'x', 'utf8');
    const issues = diffInstallDirSnapshot(before, snapshotInstallDir(installDir), { allow: ['dat'] });
    assert.equal(issues.length, 1, 'allow: dat 不能放行 data/…');
  } finally {
    cleanup(installDir);
  }
});

// ────────────────────────────────────────── 5. 监视器

test('监视器：真建一个文件能被发现，且只报一次', () => {
  const installDir = makeInstallDir();
  const reported = [];
  const events = [];
  const watch = startInstallDirWatch({
    installDir,
    intervalMs: 0, // 手动 poll
    onIssue: (issue) => reported.push(issue),
    writeEventLog: (message) => events.push(message),
  });
  try {
    mkdirSync(join(installDir, 'logs'), { recursive: true });
    writeFileSync(join(installDir, 'logs', 'server.log'), 'line', 'utf8');

    const first = watch.poll();
    assert.equal(first.length, 1);
    assert.equal(first[0].path, 'logs/server.log');
    assert.equal(events.length, 1, '每次告警要同时落一条事件日志');

    // 同一路径被再改一次：基线已前移，不该重复报
    writeFileSync(join(installDir, 'logs', 'server.log'), 'line2', 'utf8');
    const second = watch.poll();
    assert.equal(second.length, 0);
    assert.equal(reported.length, 1, '去重：同一路径只报一次');
  } finally {
    watch.stop();
    cleanup(installDir);
  }
});

test('监视器：stop() 之后不再比对', () => {
  const installDir = makeInstallDir();
  const reported = [];
  const watch = startInstallDirWatch({
    installDir,
    intervalMs: 0,
    onIssue: (issue) => reported.push(issue),
    writeEventLog: () => {},
  });
  try {
    watch.stop();
    writeFileSync(join(installDir, 'late.txt'), 'x', 'utf8');
    // stop 只停定时器；手动 poll 仍能工作（这是有意的：CLI/测试可以显式比对一次）
    assert.equal(watch.poll().length, 1);
    assert.equal(reported.length, 1);
  } finally {
    cleanup(installDir);
  }
});

test('监视器：onIssue 抛异常不能把进程带崩', () => {
  const installDir = makeInstallDir();
  const watch = startInstallDirWatch({
    installDir,
    intervalMs: 0,
    onIssue: () => {
      throw new Error('logger down');
    },
    writeEventLog: () => {
      throw new Error('eventcreate denied');
    },
  });
  try {
    writeFileSync(join(installDir, 'crash.txt'), 'x', 'utf8');
    // 两个告警通道都抛，poll 必须正常返回
    const issues = watch.poll();
    assert.equal(issues.length, 1);
  } finally {
    watch.stop();
    cleanup(installDir);
  }
});

test('监视器：安装目录不存在时不抛异常', () => {
  const reported = [];
  const watch = startInstallDirWatch({
    installDir: join(tmpdir(), 'tcs-definitely-missing-dir-xyz'),
    intervalMs: 0,
    onIssue: (issue) => reported.push(issue),
    writeEventLog: () => {},
  });
  try {
    assert.deepEqual(watch.poll(), []);
    assert.equal(watch.baselineSize(), 0);
  } finally {
    watch.stop();
  }
});

test('监视器：定时轮询真的会跑（interval 生效）', async () => {
  const installDir = makeInstallDir();
  const reported = [];
  const watch = startInstallDirWatch({
    installDir,
    intervalMs: 25,
    onIssue: (issue) => reported.push(issue),
    writeEventLog: () => {},
  });
  try {
    writeFileSync(join(installDir, 'from-timer.txt'), 'x', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(reported.length, 1, '定时器应当发现新增文件');
  } finally {
    watch.stop();
    cleanup(installDir);
  }
});

// ────────────────────────────────────────── 6. 组合与辅助

test('启动检查把"配置错"与"已有残留"一起报出来', () => {
  const installDir = makeInstallDir({ residue: true });
  try {
    const issues = checkInstallDirAtStartup({ installDir, dataDir: join(installDir, 'data') });
    const kinds = issues.map((issue) => issue.kind).sort();
    // 1 条配置 + 3 条残留
    assert.deepEqual(kinds, ['config-path', 'residue', 'residue', 'residue']);
  } finally {
    cleanup(installDir);
  }
});

test('installDirFromExecPath 取的是 node.exe 所在目录', () => {
  assert.equal(installDirFromExecPath('C:\\App\\Server\\node.exe'), 'C:\\App\\Server');
  assert.equal(installDirFromExecPath('/opt/tcs/node'), '/opt/tcs');
});

// ────────────────────────────────────────── 7. 配置项

test('配置：installDirWriteCheck 默认开；写成 "true" 字符串时**仍然开着**', () => {
  // 走错方向的安全含义不同：误开只是多一条告警，误关会让检测静默消失。
  // 所以非法值一律回默认（开），而不是当成 false。
  const defaults = normalizeConfig({});
  assert.equal(defaults.installDirWriteCheck, true);
  assert.deepEqual(defaults.installDirWriteAllow, []);

  assert.equal(normalizeConfig({ installDirWriteCheck: false }).installDirWriteCheck, false);
  assert.equal(normalizeConfig({ installDirWriteCheck: 'false' }).installDirWriteCheck, true, '字符串不是合法布尔 → 回默认开');
  assert.equal(normalizeConfig({ installDirWriteCheck: 0 }).installDirWriteCheck, true);
});

test('配置：允许清单一律过滤非字符串与空白项', () => {
  const config = normalizeConfig({ installDirWriteAllow: ['data', '', '  ', 42, null, 'logs/'] });
  assert.deepEqual(config.installDirWriteAllow, ['data', 'logs/']);
  assert.deepEqual(normalizeConfig({ installDirWriteAllow: 'data' }).installDirWriteAllow, [], '单字符串不是数组 → 回默认空');
});
