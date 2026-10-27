/**
 * F15 / T13.5 的推送链路（端到端，但不碰壳）。
 *
 * 需求 T13.7 允许"本机没有 ST 就用临时目录伪造最小 ST 结构（package.json + server.js
 * 起个 8000 端口的迷你 http 服务）走全流程" —— 这个文件就是那条路。
 *
 * 走的是**真实管线**，不是替身：
 *   卡（`test/fixtures/sample-card.json`）→ `buildExportAsync(…, 'json')`
 *   （与「导出 JSON」「上传服务端」同一个函数）→ 落盘到 `<fakeST>/data/default-user/characters`
 *   → 用 `parseStCard` 读回来 → 逐字段比对。
 *
 * 为什么这一段值得写成测试而不是靠手点：推送的失败模式全是"看起来成功了"——
 *   文件写进去了但内容少一段（世界书丢了）、同名覆盖了别人的卡、
 *   回读自证被跳过（`verified` 恒 true）。这三件事在界面上都显示"推送完成"。
 *
 * 壳那侧的能力（`probe_paths` / `spawn_detached` / `extract_zip_to`）在
 * `cargo test --lib`（22 例）与 `test/contract-st.test.mjs` 里覆盖 ——
 * Node 里调不到 `AppHandle`，这里不重复造它们的替身。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parsePngCard, parseStCard } from '../shared/dist/index.js';
import { buildExportAsync } from '../client/src/export/export-card.ts';
import {
  judgeStInstall,
  probeStState,
  stCharactersDir,
  stPushFileName,
  ST_BASE_URL,
} from '../client/src/session/st-install.ts';
import { createConnection } from 'node:net';

/**
 * 真 TCP 探测（等价壳侧 `probe_st_alive`）。
 *
 * 为什么测试里要自己实现一份而不是桩掉：这条判据的价值就在于"真的去连一次"，
 * 桩掉之后测的就只剩 `classifyStProbe` 的分支，而"能不能连上"恰恰是线上那一层。
 */
function tcpProbe(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (facts) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(facts);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => done({ alive: true, errorKind: null, errorMessage: null }));
    socket.once('timeout', () =>
      done({ alive: false, errorKind: 'TimedOut', errorMessage: 'connect timeout' }),
    );
    socket.once('error', (error) =>
      done({ alive: false, errorKind: error.code === 'ECONNREFUSED' ? 'ConnectionRefused' : error.code, errorMessage: error.message }),
    );
  });
}

const ROOT = join(import.meta.dirname, '..');
const SAMPLE_JSON = readFileSync(join(ROOT, 'test', 'fixtures', 'sample-card.json'), 'utf8');
/** 卡面夹具（64×64 的真 PNG）：推送必须有封面，与真实链路一致 */
const FACE = new Uint8Array(readFileSync(join(ROOT, 'test', 'fixtures', 'png', 'fixture-v2.png')));

/** 造一个"最小 ST"目录：package.json + server.js（判据要的正是这两样） */
function makeFakeSt() {
  const home = mkdtempSync(join(tmpdir(), 'tcs-fakest-'));
  const root = join(home, 'SillyTavern');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'sillytavern', scripts: { start: 'node server.js' } }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(join(root, 'server.js'), "require('http').createServer((q,s)=>s.end('st')).listen(8000)\n", 'utf8');
  return { home, root, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** 从磁盘读回判据需要的事实（等价壳侧 probe_paths + readTextExact 的结果） */
function readFacts(root) {
  let packageJsonText = null;
  let hasPackageJson = false;
  try {
    packageJsonText = readFileSync(join(root, 'package.json'), 'utf8');
    hasPackageJson = true;
  } catch {
    hasPackageJson = false;
  }
  let hasServerJs = false;
  try {
    hasServerJs = readFileSync(join(root, 'server.js')) !== null;
  } catch {
    hasServerJs = false;
  }
  return { root, hasPackageJson, packageJsonText, hasServerJs };
}

/**
 * 等价 `write_binary_file_atomic` 的语义：临时文件 → rename → 回读比摘要。
 *
 * G8 起推送产物是 PNG（字节），所以这条辅助函数也必须按**字节**处理：
 * 按 utf8 写会把二进制读坏 —— 而那正是"文件看着在、ST 打不开"的经典成因。
 */
function writeAtomicBytes(target, bytes) {
  const temp = `${target}.tmp`;
  writeFileSync(temp, bytes);
  writeFileSync(target, readFileSync(temp));
  rmSync(temp);
  const expected = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
  return { sha256: actual, verified: actual === expected };
}

/*
 * 推送全流程（G8 起是 **PNG**，决策 #212）。
 *
 * 上一版这里走的是 `buildExportAsync(…, 'json')`：落盘正确、也能被 `parseStCard`
 * 读回来，**但它守的路径在 ST 里根本不生效** —— 角色目录扫描不读 .json。
 * 现在改成 PNG 之后，这条用例才能真正代表"用户能不能看到卡"。
 */
test('推送全流程：卡 → PNG 角色卡 → 落盘 → 读回，卡与世界书都在', async () => {
  const fake = makeFakeSt();
  try {
    // ① 判据：这个假目录必须被认成"已安装"（否则后面全是空转）
    const verdict = judgeStInstall(readFacts(fake.root));
    assert.equal(verdict.installed, true, '假 ST 目录没通过判据');
    assert.ok(verdict.evidence.includes('scripts.start 非空'));

    // ② 走真实导出管线（与「导出 PNG」「另存为 PNG」同一个函数）
    const parsed = parseStCard(SAMPLE_JSON);
    const artifact = await buildExportAsync(parsed.card, null, 'png', undefined, FACE);
    assert.equal(artifact.format, 'png', '推送产物必须是 PNG');
    assert.match(artifact.fileName, /\.png$/);

    // ③ 落盘到 characters 目录（目录由 stCharactersDir 推导，不是手拼的）
    const charactersDir = stCharactersDir(fake.root);
    mkdirSync(charactersDir, { recursive: true });
    const fileName = stPushFileName(parsed.card.meta.name, readdirSync(charactersDir));
    assert.match(fileName, /\.png$/);
    const target = join(charactersDir, fileName);
    const receipt = writeAtomicBytes(target, artifact.png);
    assert.equal(receipt.verified, true, '回读自证必须通过');
    assert.equal(receipt.sha256, artifact.sha256, '落盘摘要必须与内存产物一致');

    // ④ 读回来：ST 从目录里扫到的就是这张卡（PNG 解码 → 卡 JSON → UnifiedCard）
    const reread = parsePngCard(new Uint8Array(readFileSync(target)));
    assert.equal(reread.kind, 'card', 'ST 扫这个文件时读不出卡数据');
    const back = parseStCard(reread.jsonText).card;
    assert.equal(back.meta.name, parsed.card.meta.name);
    assert.ok(back.blocks.find((b) => b.id === 'initial-scene').text.trim().length > 0);
    assert.equal(
      back.worldbook.entries.length,
      parsed.card.worldbook.entries.length,
      '世界书条目数必须原样保留（character_book 随卡内嵌）',
    );

    // ⑤ 数据块里的 JSON 确实有 character_book（不是靠内存对象"看起来有"）
    const raw = JSON.parse(reread.jsonText);
    assert.ok(raw.data?.character_book, 'PNG 里的卡 JSON 没有 character_book');
    assert.equal(raw.spec, 'chara_card_v2');
  } finally {
    fake.cleanup();
  }
});

test('同名再推一次加序号，不覆盖已有文件', async () => {
  const fake = makeFakeSt();
  try {
    const parsed = parseStCard(SAMPLE_JSON);
    const charactersDir = stCharactersDir(fake.root);
    mkdirSync(charactersDir, { recursive: true });
    const artifact = await buildExportAsync(parsed.card, null, 'png', undefined, FACE);

    const first = stPushFileName(parsed.card.meta.name, readdirSync(charactersDir));
    writeAtomicBytes(join(charactersDir, first), artifact.png);
    // 把第一份内容改掉（追加一个字节），用来证明第二份没覆盖它
    const marker = Buffer.concat([Buffer.from(artifact.png), Buffer.from([0])]);
    writeFileSync(join(charactersDir, first), marker);

    const second = stPushFileName(parsed.card.meta.name, readdirSync(charactersDir));
    assert.notEqual(second, first, '同名必须换一个名字');
    assert.match(second, /\(2\)\.png$/);

    writeAtomicBytes(join(charactersDir, second), artifact.png);
    assert.equal(readdirSync(charactersDir).length, 2, '两次推送应当得到两个文件');
    assert.ok(
      readFileSync(join(charactersDir, first)).equals(marker),
      '先推的那份必须原样保留（不覆盖是红线）',
    );
  } finally {
    fake.cleanup();
  }
});

test('运行状态探测：真实 http 服务可达即"运行中"，关掉即"没运行"', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('sillytavern');
  });

  // 需求写死 8000；被占用时退到临时端口（同一段探测逻辑，判据不变）
  let port = 8000;
  const started = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(8000, '127.0.0.1', () => resolve(true));
  });
  if (!started) {
    port = 0;
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  }
  const actualPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${actualPort}`;

  try {
    const alive = await probeStState({ tcpProbe: tcpProbe, baseUrl });
    assert.equal(alive.outcome, 'running', '有服务应答时应当判为运行中');

    await new Promise((resolve) => server.close(resolve));
    const dead = await probeStState({ tcpProbe: tcpProbe, baseUrl });
    assert.equal(dead.outcome, 'no-answer', '服务关掉后应当判为没有应答');
    assert.equal(
      dead.tcp.errorKind,
      'ConnectionRefused',
      '必须把原始的 io::ErrorKind 带出来（生产缺陷里就是靠它区分"没人听"与"被挡"）',
    );
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }

  // 需求把端口写死成 8000：常量一旦被改动，UI 与文档会一起错
  assert.equal(ST_BASE_URL, 'http://127.0.0.1:8000');
});

test('判据：只有 server.js 没有 package.json 的目录不算 ST（不会被推送）', () => {
  const home = mkdtempSync(join(tmpdir(), 'tcs-fakest-broken-'));
  try {
    const root = join(home, 'RandomFolder');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'server.js'), '// nope\n', 'utf8');

    const verdict = judgeStInstall(readFacts(root));
    assert.equal(verdict.installed, false);
    assert.equal(verdict.reason, 'no-package-json');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
