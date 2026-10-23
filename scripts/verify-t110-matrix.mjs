/**
 * T10.10 ③ 多账户隔离交叉剧本：两账户 × 两仓库 × 四种凭证。
 *
 * 为什么单独写这个脚本：`smoke-t108` 证的是"两条规则各自成立"，
 * 而多租户的事故几乎都发生在**交叉点**上 —— 一个凭证在自己仓库里读得到、
 * 换个仓库读不到、写不进去、但换个 cardId 又能写进去，这些组合没人一条条走过。
 * 这里把「谁 × 在哪 × 用什么」排成矩阵，逐格断言四件事：
 * 本仓可见、本仓可写、跨仓不可见、跨账户不可见。
 *
 * 判据表（本脚本内置的**规格**，实现必须与它一致）：
 *
 * | 凭证 | 同账户同仓库 | 同账户跨仓库 | 跨账户 | 未归属卡片 |
 * |---|---|---|---|---|
 * | 账户令牌（jwt） | 读 + 写 | 读 + 写（jwt 覆盖账户全部仓库） | 不可见 | 不可见 |
 * | 仓库令牌（read） | 只读 | 不可见 | 不可见 | 不可见 |
 * | 仓库令牌（read+write） | 读 + 写 | 不可见 | 不可见 | 不可见 |
 * | legacy 全局令牌 | 不可见 | 不可见 | 不可见 | 读 + 写 |
 *
 * 三个"不可见"必须是 **404**（不是 403），而且响应体除回显的 cardId 之外
 * 逐字节相同 —— 否则它就是一个卡片 id 枚举器（docs/29 §2.1）。
 * 唯一该出现 403 的地方是"看得见但权限不够"：仓库只读令牌对自己仓库执行写。
 *
 * 用法：node scripts/verify-t110-matrix.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  if (!ok || process.env['TCS_VERBOSE'] === '1') {
    console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
  }
};

const work = mkdtempSync(join(tmpdir(), 'tcs-t110-m-'));
const port = 21500 + Math.floor(Math.random() * 200);
const legacyToken = 't110-matrix-legacy-aaaaaaaaaaaaaaaaaaaa';

writeFileSync(
  join(work, 'config.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      port,
      controlPort: port + 1,
      host: '127.0.0.1',
      controlHost: '127.0.0.1',
      dataDir: join(work, 'store'),
      rulesDir: 'rules',
      defaultPlatformRule: 'sillytavern',
      defaultPreset: 'default',
      maxUploadBytes: 33554432,
      logLevel: 'error',
      auth: {
        token: legacyToken,
        require: true,
        publicPaths: ['/api/health'],
        // 账户经由注册接口创建，只为让剧本自包含；生产部署推荐 admin-only（见 docs/33）
        registerMode: 'open',
        jwtSecret: 't110-matrix-jwt-secret-aaaaaaaaaaaaaaaaaaaa',
      },
      tls: { mode: 'off', httpsPort: port + 1000, certPath: '', keyPath: '' },
      service: { mode: 'process', name: 'T110M', displayName: 'T110M', autoStart: false },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

const child = spawn(process.execPath, ['server/dist/index.js', 'worker', '--config', join(work, 'config.json')], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => {
  const text = String(d);
  if (!/ExperimentalWarning|DeprecationWarning/.test(text)) process.stderr.write(`[srv] ${text}`);
});

const base = `http://127.0.0.1:${String(port)}`;

async function call(path, { method = 'GET', body, token, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const cardTemplate = readFileSync(join(REPO, 'test', 'fixtures', 'sample-card.json'), 'utf8');
const cardWithName = (name) => cardTemplate.replace('"name": "林晚照"', `"name": "${name}"`);

/** 把响应体里回显的 cardId 归一化：两次不同 id 的 404 才能比较结构 */
const normalize = (text, ...ids) => ids.reduce((acc, id) => acc.split(id).join('<ID>'), text);

const ACCOUNTS = [
  { name: 'alice', password: 'alice-matrix-pw-1' },
  { name: 'bob', password: 'bob-matrix-pw-1' },
];
const REPOS = ['default', 'work'];

/** 客户端凭证：由账户令牌 / 仓库令牌（两种范围） / legacy 组成 */
const credentials = [];
const cards = []; // { id, account, repo }

try {
  // ── 0. 等服务端 ───────────────────────────────────────────
  let up = false;
  for (let i = 0; i < 160; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* 还没起 */
    }
    await delay(150);
  }
  check('服务端就绪', up, base);
  if (!up) throw new Error('服务端没起来，后续断言无法进行');

  // ── 1. 两账户 + 各自两个仓库 ──────────────────────────────
  for (const account of ACCOUNTS) {
    const reg = await call('/api/auth/register', {
      method: 'POST',
      body: { username: account.name, password: account.password },
    });
    check(`注册账户 ${account.name}`, reg.status === 201, `status=${String(reg.status)}`);
    account.jwt = reg.json?.accessToken ?? '';

    const repos = await call('/api/repos', { token: account.jwt });
    const defaultRepo = (repos.json?.items ?? []).find((item) => item.isDefault);
    check(`${account.name} 自动拥有默认仓库`, defaultRepo !== undefined, defaultRepo?.name ?? '(无)');
    account.repos = { default: defaultRepo };

    const created = await call('/api/repos', {
      method: 'POST',
      body: { name: 'work', description: '交叉剧本用的第二个仓库' },
      token: account.jwt,
    });
    check(`${account.name} 建第二个仓库 work`, created.status === 201, `status=${String(created.status)}`);
    account.repos.work = created.json;
  }

  // ── 2. 四张卡（账户 × 仓库）+ 一张 legacy 未归属卡 ──────────
  for (const account of ACCOUNTS) {
    for (const repo of REPOS) {
      const cardId = `${account.name}-${repo}`;
      const res = await call(`/api/cards?cardId=${cardId}${repo === 'default' ? '' : `&repo=${repo}`}`, {
        method: 'POST',
        body: cardWithName(`${account.name} 的 ${repo} 卡`),
        token: account.jwt,
        raw: true,
      });
      check(`上传 ${cardId}`, res.status === 201, `status=${String(res.status)} repo=${res.json?.card?.repoName ?? '?'}`);
      check(
        `${cardId} 落在正确的仓库`,
        res.json?.card?.repoName === (repo === 'default' ? account.repos.default?.name : 'work'),
        `repoName=${String(res.json?.card?.repoName)}`,
      );
      cards.push({ id: cardId, account: account.name, repo });
    }
  }

  const orphan = await call('/api/cards?cardId=legacy-orphan', {
    method: 'POST',
    body: cardWithName('legacy 未归属卡'),
    token: legacyToken,
    raw: true,
  });
  check('legacy 上传一张未归属卡', orphan.status === 201, `status=${String(orphan.status)}`);
  cards.push({ id: 'legacy-orphan', account: null, repo: null });
  const CARD_IDS = cards.map((card) => card.id);

  // ── 3. 仓库令牌：每个账户每个仓库各签一把只读、一把读写 ────
  for (const account of ACCOUNTS) {
    for (const repo of REPOS) {
      const repoId = account.repos[repo]?.id;
      for (const [kind, scopes] of [
        ['read', ['read']],
        ['rw', ['read', 'write']],
      ]) {
        const issued = await call(`/api/repos/${String(repoId)}/tokens`, {
          method: 'POST',
          body: { name: `${repo}-${kind}`, scopes },
          token: account.jwt,
        });
        check(
          `签发 ${account.name}/${repo} ${kind} 令牌`,
          issued.status === 201 && typeof issued.json?.token === 'string',
          `status=${String(issued.status)}`,
        );
        credentials.push({
          label: `${account.name}/${repo} 仓库令牌(${kind})`,
          kind: 'repo',
          account: account.name,
          repo,
          scopes: kind === 'read' ? ['read'] : ['read', 'write'],
          token: issued.json?.token ?? '',
        });
      }
    }
  }

  for (const account of ACCOUNTS) {
    credentials.push({ label: `${account.name} 账户令牌`, kind: 'jwt', account: account.name, repo: null, token: account.jwt });
  }
  credentials.push({ label: 'legacy 全局令牌', kind: 'legacy', account: null, repo: null, token: legacyToken });

  // ── 4. 规格：给定凭证 × 卡片，期望的可访问级别 ─────────────
  //
  // 这是**唯一的判据来源**。下面所有断言都拿它和真实响应比，
  // 不在这里逐条硬编码，避免"期望值写错了两边一起错"。
  function expectedLevel(cred, card) {
    if (card.account === null) {
      // 未归属卡片：只有 legacy 能碰
      return cred.kind === 'legacy' ? 'rw' : '-';
    }
    if (cred.kind === 'legacy') return '-';
    if (cred.account !== card.account) return '-';
    if (cred.kind === 'jwt') return 'rw';
    // 仓库令牌：出仓库即不可见；再看范围决定能不能写
    if (cred.repo !== card.repo) return '-';
    return cred.scopes.includes('write') ? 'rw' : 'r';
  }

  // ── 5. 逐格探针：读一次、写一次 ───────────────────────────
  const observed = new Map(); // `${credLabel}|${cardId}` -> 'rw' | 'r' | '-'
  const writeStatuses = new Map();

  for (const cred of credentials) {
    // 这把凭证是否具备"写"这一能力（与目标无关）
    const canWrite = cred.kind !== 'repo' || cred.scopes.includes('write');
    for (const card of cards) {
      const expected = expectedLevel(cred, card);

      const read = await call(`/api/cards/${card.id}`, { token: cred.token });
      // 写：往已有 cardId 追加一个版本（真实的"能不能改这张卡"）
      const write = await call(`/api/cards?cardId=${card.id}`, {
        method: 'POST',
        body: cardWithName(`${card.id} 被 ${cred.label} 改过`),
        token: cred.token,
        raw: true,
      });

      let level;
      if (read.status === 200) level = write.status === 201 || write.status === 200 ? 'rw' : 'r';
      else level = '-';

      observed.set(`${cred.label}|${card.id}`, level);
      writeStatuses.set(`${cred.label}|${card.id}`, write.status);

      check(
        `${cred.label} × ${card.id}：读到 ${String(read.status)}，写到 ${String(write.status)}（期望 ${expected}）`,
        level === expected,
        level === expected ? '' : `实际 ${level}`,
      );

      // 可见但权限不足 → 必须是 403，不能是 404（否则又把"存在"藏起来了）
      if (level === 'r' && expected === 'r') {
        check(
          `${cred.label} × ${card.id}：写出 403（只读令牌）而不是 404`,
          write.status === 403,
          `status=${String(write.status)}`,
        );
      }
      // 不可见的写：有写权限时必须是 404（不能借写来探存在性）；
      // 只读令牌则在**权限前置检查**处就 403 —— 这与目标是否存在无关，
      // 不泄露信息，但必须单独验证"确实与目标无关"（见 §5.1）。
      if (expected === '-' && canWrite) {
        check(
          `${cred.label} × ${card.id}：写不可见目标一律 404`,
          write.status === 404,
          `status=${String(write.status)}`,
        );
      }
      if (expected === '-' && !canWrite) {
        check(
          `${cred.label} × ${card.id}：只读令牌的写被前置拒绝（403）`,
          write.status === 403,
          `status=${String(write.status)}`,
        );
      }
    }
  }

  // ── 5.1 只读令牌的 403 必须与「目标是谁」无关 ──────────────
  //
  // 这是上一条的补充证明。只读令牌的写请求在范围检查处就被拒（403），
  // 早于任何资源查找 —— 于是它对"自己的卡 / 别人的卡 / 根本不存在的 id"
  // 三种目标必然给出同一个响应。如果哪天有人把范围检查挪到查找之后，
  // 这里立刻变成「自己的卡 403、别人的卡 404」，重新长出枚举面。
  const readOnly = credentials.find((c) => c.label === 'alice/default 仓库令牌(read)');
  const probeOwn = await call('/api/cards?cardId=alice-default', {
    method: 'POST',
    body: cardWithName('只读探针'),
    token: readOnly.token,
    raw: true,
  });
  const probeOther = await call('/api/cards?cardId=bob-default', {
    method: 'POST',
    body: cardWithName('只读探针'),
    token: readOnly.token,
    raw: true,
  });
  const probeAbsent = await call('/api/cards?cardId=never-existed-probe', {
    method: 'POST',
    body: cardWithName('只读探针'),
    token: readOnly.token,
    raw: true,
  });
  check(
    '只读令牌写自己的卡 / 别人的卡 / 不存在的 id → 三者状态码一致（403）',
    probeOwn.status === 403 && probeOther.status === 403 && probeAbsent.status === 403,
    `own=${String(probeOwn.status)} other=${String(probeOther.status)} absent=${String(probeAbsent.status)}`,
  );
  check(
    '只读令牌的 403 响应体逐字节相同（不因目标不同而夹带信息）',
    probeOwn.text === probeAbsent.text && probeOther.text === probeAbsent.text,
    probeOwn.text.replace(/\s+/g, ' ').slice(0, 90),
  );

  // ── 6. 矩阵汇总（人眼看这一张就够）────────────────────────
  console.log('\n访问矩阵（行=凭证，列=卡片；r=只读，rw=读写，-=404）\n');
  const header = ['凭证'.padEnd(26), ...CARD_IDS.map((id) => id.padEnd(16))].join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const cred of credentials) {
    const row = [cred.label.padEnd(26)];
    for (const card of cards) {
      const level = observed.get(`${cred.label}|${card.id}`) ?? '?';
      const expected = expectedLevel(cred, card);
      row.push(`${level === expected ? ' ' : '✗'}${level}`.padEnd(16));
    }
    console.log(row.join(''));
  }
  const cells = credentials.length * cards.length;
  const wrong = credentials.reduce(
    (acc, cred) => acc + cards.filter((card) => observed.get(`${cred.label}|${card.id}`) !== expectedLevel(cred, card)).length,
    0,
  );
  check(`矩阵 ${String(credentials.length)} 凭证 × ${String(cards.length)} 卡 = ${String(cells)} 格全部符合规格`, wrong === 0, `不符 ${String(wrong)} 格`);

  // ── 7. 404 结构一致性抽测（四种"看不见"必须同形）──────────
  //
  // 归一化掉回显的 id 后，四个来源的 404 必须逐字节相同：
  //   ① 跨账户（alice 账户令牌 → bob 的卡）
  //   ② 跨仓库（alice 只读仓库令牌 → alice 另一仓库的卡）
  //   ③ legacy → 账户的卡
  //   ④ 根本不存在的 id
  const crossAccount = await call('/api/cards/bob-default', { token: ACCOUNTS[0].jwt });
  const crossRepo = await call('/api/cards/alice-work', {
    token: credentials.find((c) => c.label === 'alice/default 仓库令牌(read)').token,
  });
  const legacyPeek = await call('/api/cards/alice-default', { token: legacyToken });
  const absent = await call('/api/cards/no-such-card-404-probe', { token: ACCOUNTS[0].jwt });

  for (const [name, res] of [
    ['跨账户', crossAccount],
    ['跨仓库', crossRepo],
    ['legacy 读账户卡', legacyPeek],
  ]) {
    check(`${name} → 404`, res.status === 404, `status=${String(res.status)}`);
    check(
      `${name} 的 404 与「不存在」除回显 id 外逐字节相同`,
      normalize(res.text, 'bob-default', 'alice-work', 'alice-default') ===
        normalize(absent.text, 'no-such-card-404-probe'),
      res.text.replace(/\s+/g, ' ').slice(0, 90),
    );
  }

  // 版本 / 原文两个子资源也要一致（只测主资源会漏掉旁路）
  for (const [label, path, id] of [
    ['版本', '/versions', 'bob-default'],
    ['原文', '/raw', 'bob-default'],
  ]) {
    const peek = await call(`/api/cards/${id}${path}`, { token: ACCOUNTS[0].jwt });
    const missing = await call(`/api/cards/no-such-card-404-probe${path}`, { token: ACCOUNTS[0].jwt });
    check(`跨账户读${label} → 404`, peek.status === 404, `status=${String(peek.status)}`);
    check(
      `跨账户读${label}的 404 与「不存在」同形`,
      normalize(peek.text, id) === normalize(missing.text, 'no-such-card-404-probe'),
      '',
    );
  }

  // ── 8. 列表 / 统计口径必须跟着凭证走 ─────────────────────
  for (const cred of credentials) {
    const visible = cards.filter((card) => expectedLevel(cred, card) !== '-').map((card) => card.id);
    const list = await call('/api/cards?limit=200', { token: cred.token });
    const ids = (list.json?.items ?? []).map((item) => item.cardId).sort();
    check(
      `${cred.label}：列表恰好是可见集合`,
      JSON.stringify(ids) === JSON.stringify([...visible].sort()),
      `看到 ${JSON.stringify(ids)}，期望 ${JSON.stringify([...visible].sort())}`,
    );
    check(
      `${cred.label}：total 与条数一致`,
      list.json?.total === ids.length,
      `total=${String(list.json?.total)} items=${String(ids.length)}`,
    );
    const stats = await call('/api/stats', { token: cred.token });
    check(`${cred.label}：stats.cards 与可见集合一致`, stats.json?.cards === visible.length,
      `cards=${String(stats.json?.cards)} 期望=${String(visible.length)}`);
    check(`${cred.label}：stats 标注了隔离已生效`, stats.json?.isolationEnforced === true,
      String(stats.json?.isolationEnforced));
  }

  // ── 9. 边界：仓库令牌不能越界写、不能管仓库与令牌 ──────────
  const workRw = credentials.find((c) => c.label === 'alice/work 仓库令牌(rw)');
  const escape = await call('/api/cards?cardId=alice-escape&repo=default', {
    method: 'POST',
    body: cardWithName('想借 repo 参数逃出 work'),
    token: workRw.token,
    raw: true,
  });
  check('仓库令牌上传时忽略 repo 参数（不能写到别的仓库）', escape.status === 201,
    `status=${String(escape.status)}`);
  check('该卡仍落在令牌绑定的 work 仓库', escape.json?.card?.repoName === 'work',
    `repoName=${String(escape.json?.card?.repoName)}`);
  const escapeRead = await call('/api/cards/alice-escape', {
    token: credentials.find((c) => c.label === 'alice/default 仓库令牌(read)').token,
  });
  check('默认仓库的令牌看不到这张卡（它确实在 work）', escapeRead.status === 404, `status=${String(escapeRead.status)}`);

  const listingRepos = await call('/api/repos', { token: workRw.token });
  check('仓库令牌不能列仓库（403）', listingRepos.status === 403, `status=${String(listingRepos.status)}`);
  const legacyRepos = await call('/api/repos', { token: legacyToken });
  check('legacy 不能列仓库（403，无账户身份）', legacyRepos.status === 403, `status=${String(legacyRepos.status)}`);
  const bobRepos = await call('/api/repos', { token: ACCOUNTS[1].jwt });
  check('bob 只看到自己的 2 个仓库', (bobRepos.json?.items ?? []).length === 2,
    String((bobRepos.json?.items ?? []).length));
  const stealRepo = await call(`/api/repos/${String(ACCOUNTS[1].repos.default?.id)}/tokens`, {
    method: 'POST',
    body: { name: '偷签', scopes: ['read'] },
    token: ACCOUNTS[0].jwt,
  });
  check('alice 不能在 bob 的仓库上签令牌（404）', stealRepo.status === 404, `status=${String(stealRepo.status)}`);
  const renameTheirs = await call(`/api/repos/${String(ACCOUNTS[1].repos.work?.id)}`, {
    method: 'PATCH',
    body: { name: '被改名了' },
    token: ACCOUNTS[0].jwt,
  });
  check('alice 不能改 bob 的仓库（404）', renameTheirs.status === 404, `status=${String(renameTheirs.status)}`);

  // 无效凭证必须是 401，不能被当成"没权限"混进 403
  const bogus = await call('/api/cards', { token: 'tcr_definitely-not-a-real-token-000000000000' });
  check('伪造令牌 → 401', bogus.status === 401, `status=${String(bogus.status)}`);

  // ── 10. 写入确实生效，且没有串到别人的卡上 ─────────────────
  //
  // "可写"不能只看回执：矩阵里同一张卡被多把凭证轮流写过，
  // 所以这里最后做一次受控写入 —— 先记下 bob 的卡当前内容，
  // 再用 alice 的账户令牌写自己的卡，断言 bob 的卡一字未变。
  const bobBefore = await call('/api/cards/bob-work', { token: ACCOUNTS[1].jwt });
  const finalWrite = await call('/api/cards?cardId=alice-work', {
    method: 'POST',
    body: cardWithName('最终写入-A'),
    token: ACCOUNTS[0].jwt,
    raw: true,
  });
  check('alice 账户令牌能写自己的卡', finalWrite.status === 201 || finalWrite.status === 200,
    `status=${String(finalWrite.status)}`);
  const aliceFinal = await call('/api/cards/alice-work', { token: ACCOUNTS[0].jwt });
  check('alice/work 读回来就是刚写入的内容', aliceFinal.json?.name === '最终写入-A', String(aliceFinal.json?.name));
  const bobAfter = await call('/api/cards/bob-work', { token: ACCOUNTS[1].jwt });
  check('bob 的卡一字未变（alice 的写没有串过去）', bobAfter.json?.name === bobBefore.json?.name,
    `${String(bobBefore.json?.name)} → ${String(bobAfter.json?.name)}`);
} finally {
  child.kill();
  await delay(300);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用 */
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n合计 ${String(results.length)} 项，失败 ${String(failed.length)} 项`);
  if (failed.length > 0) {
    console.log('\n失败项：');
    for (const item of failed) console.log(`  ✘ ${item.name}${item.detail ? ' —— ' + item.detail : ''}`);
    process.exitCode = 1;
  }
}
