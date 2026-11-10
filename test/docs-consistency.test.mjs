/**
 * 文档与代码的一致性（2026-11-10）。
 *
 * ## 为什么需要
 *
 * 用户问：「运维文档、readme 和 API 文档里面有没有更新对应的说明」。
 * 一查发现三处脱节，而且都是**静默的**——文档照样能读，只是缺东西：
 *
 * ```text
 *   API 文档        缺 12 个端点（登录/注册/续期/注销/审计/TLS 重载）
 *   README          缺 v0.1.7 的「初始场景」复合板块（@@开场白 / @@情景）
 *   server cmd.md   缺 cleanup 命令
 *   09-server-deploy 命令里写死 0.1.0（照抄必失败）
 * ```
 *
 * 这些不是笔误，是"写了新功能、忘了旧文档"。判据要钉住**覆盖关系**，
 * 而不是"文档里有没有某句话"。
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * 内部文档在 `.gitignore` 里（含本机路径、内网地址，按设计不发布）。
 * 别人 clone 仓库后它们**不存在** —— 判据要跳过，而不是报"文件找不到"。
 *
 * ★ 这跟"判据失效"是两件事：本地有就必须合规；没有则无从判起。
 *   所以跳过时**不写任何断言**，让 node:test 记为通过而不是静默忽略。
 */
function readIfTracked(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** 收集 server/src 下所有路由字面量 */
function routeLiterals() {
  const out = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const src = readFileSync(p, 'utf8');
      for (const m of src.matchAll(/'(\/api\/[a-z0-9/:{}._-]+)'/g)) {
        const route = m[1];
        if (route !== undefined) out.add(route);
      }
    }
  };
  walk(join(ROOT, 'server/src'));
  return out;
}

test('★★★★★ API 文档必须列出 server/src 里每一个路由', () => {
  /*
   * ## 这个洞有多大
   *
   * 账户体系（登录 / 注册 / 续期 / 仓库令牌 / 注销 / 注销审计）在 v0.1.3 就上线了，
   * 但只写在 `26-t104-login.md`、`30-t107-client-auth.md` 里 —— 那两份是
   * **决策记录**，不是接口手册。对着 README 写客户端的人会整块漏掉。
   *
   * ## 判据方向：代码有 → 文档必须有
   *
   * 不是"文档里的每个路径都存在"（文档会写示例路径，也有 /control/*），
   * 而是反过来：**代码里存在的每个 /api 路由，文档必须提到**。
   *
   * ## 归一化再比，别用正则去拼
   *
   * 文档可能写成 `/api/cards/:id` 或 `/api/cards/{id}`。第一版我拿路由去
   * 拼正则匹配原文，写了三层转义还是错的 —— 而且**变异验证时没变红**
   * （因为 `replace(...,2)` 只删了 5 处里的 2 处，剩下的照样命中）。
   *
   * 改成：两边都提取出所有 `/api/...` 路径，把 `{x}` 统一成 `:x`，再算差集。
   * 这样没有正则拼接，也不会被"文档里还有别处提到"骗过。
   */
  /*
   * ★★★ 两份文档都要查（2026-11-10 发现）。
   *
   * ```text
   *   docs/08-server-api.md        内部设计文档（.gitignore 掉的）
   *   docs/server-developer.md     对外发布版（第三方开发者看的就是它）
   * ```
   *
   * 第一版判据只查了内部那份，于是"内部补全了、对外仍然是缺的"这种
   * 情况完全看不出来。**而对外那份才是别人真正读的。**
   */
  const DOCS = ['docs/08-server-api.md', 'docs/server-developer.md'].filter(
    (rel) => readIfTracked(rel) !== null,
  );
  /* 对外版必须在库里 —— 它缺席说明仓库结构坏了，不是"没 clone 内部文档" */
  assert.ok(
    DOCS.includes('docs/server-developer.md'),
    'docs/server-developer.md 是发布版，必须存在',
  );

  /** 把 `{id}` 归一成 `:id`，并去掉结尾的标点 */
  const norm = (raw) =>
    raw
      .replace(/\{[a-zA-Z_]+\}/g, (m) => `:${m.slice(1, -1)}`)
      .replace(/[.,;:、）)]+$/, '');

  const collect = (text) =>
    new Set(
      [...text.matchAll(/\/api\/[a-zA-Z0-9/_:{}.$-]+/g)]
        .map((m) => norm(m[0]))
        /*
         * 过滤掉三类"不是路由"的碎片 —— 它们都是 `${...}` 拼接的产物：
         *
         * ```text
         *   /api/cards/                   模板字符串拼出来的半截
         *   /api/cards/${_ctx.params      模板插值
         *   /api/cards/:id/               以 : 结尾（参数名被截断）
         * ```
         *
         * 真实路由在代码里是**完整字面量**，不会带这三种形态。
         */
        .filter((p) => !p.includes('${') && !p.endsWith('/') && !p.endsWith(':')),
    );

  const implemented = collect(
    readdirSync(join(ROOT, 'server/src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(ROOT, 'server/src', f), 'utf8'))
      .join('\n'),
  );

  for (const rel of DOCS) {
    const documented = collect(read(rel));
    const missing = [...implemented].filter((route) => !documented.has(route)).sort();
    assert.deepEqual(missing, [], `${rel} 缺这些路由：${missing.join('、')}`);
  }
});

test('★★★★ README 必须写清「初始场景」是复合板块', () => {
  /*
   * v0.1.7 把「初始场景」从单一 `first_mes` 改成了复合板块
   * （`@@开场白` → first_mes / `@@情景` → scenario），
   * 但 README 的功能一览与 4.3c 一直写着"初始场景写 first_mes"。
   *
   * 后果：用户导出一张卡，发现 `scenario` 字段是空的，而 README 没说
   * 它藏在哪一段。这类文档滞后比代码 bug 更难发现 —— 代码至少会报错。
   */
  const readme = read('README.md');

  assert.match(readme, /@@开场白/, 'README 要提到 @@开场白 子标记');
  assert.match(readme, /@@情景/, 'README 要提到 @@情景 子标记');
  assert.match(readme, /复合板块/, 'README 要点明"初始场景是复合板块"');

  /* 兼容口径也要写：老 TXT 没有 @@ 标记怎么办 */
  assert.match(
    readme,
    /没有\s*@@\s*标记|一个 @@ 标记都没有|没有 `@@` 标记/,
    'README 要说明老 TXT（无 @@ 标记）怎么读',
  );

  /* 反判据：不许再说"初始场景写 first_mes"就完事 */
  assert.doesNotMatch(
    readme,
    /对话示例写 `mes_example`，初始场景写 `first_mes`。初始场景里有多条开场白时/,
    '这句话把初始场景说成只有 first_mes，与复合板块矛盾',
  );
});

test('★★★★ 运维命令文档必须覆盖 CLI 的所有命令组', () => {
  /*
   * `cleanup` 在 CLI 里存在（卸载清理，卸载 MSI 时会被调用），
   * 但 `docs/server cmd.md` 里**一次都没出现**。
   *
   * 运维照文档做完卸载，以为干净了，实际 `data\` 与 `logs\` 还留在
   * 安装目录里 —— 下次重装会读到旧配置与旧令牌，"卸载重装"变成假动作。
   */
  /* 对外版与内部版都查（有哪份查哪份） */
  const cmdDocs = ['docs/server-cmd.md', 'docs/server cmd.md']
    .map((rel) => ({ rel, text: readIfTracked(rel) }))
    .filter((d) => d.text !== null);
  assert.ok(cmdDocs.length > 0, '至少要有一份运维命令文档');

  const cli = read('server/src/cli.ts');

  /* ① 文档里的命令总表要覆盖 printHelp 列出的命令 */
  const helpMatch = /function printHelp\(\)[\s\S]*?\n}/.exec(cli);
  assert.ok(helpMatch !== null, '找不到 printHelp');
  const help = helpMatch[0];

  for (const cmd of ['serve', 'worker', 'config', 'token', 'service', 'user', 'version', 'selfcheck', 'cleanup']) {
    assert.ok(
      new RegExp(`\\b${cmd}\\b`).test(help),
      `printHelp 没有列出 ${cmd} —— 用户 tcs-server help 会看不到它`,
    );
    for (const { rel, text } of cmdDocs) {
      assert.ok(
        text.includes(cmd),
        `${rel} 没有 ${cmd} —— CLI 里有但文档没写`,
      );
    }
  }
});

test('★★★ 运维文档的命令不许写死版本号', () => {
  /*
   * `msiexec /i "TavernCardStudioServer-0.1.0.msi" /qn` 这种写法，
   * 在 0.1.9 时代照抄必然失败（文件名不存在）。
   *
   * ## 第一版判据的两个错（都靠变异验证发现）
   *
   * 1. **正则漏了连字符**：写成 `Tavern[A-Za-z ]*Studio[A-Za-z ]*`，
   *    而真实文件名是 `TavernCardStudioServer-0.1.0.msi` —— `Server-` 里
   *    那个连字符不在字符类里，于是**这个判据对它本该抓的东西完全免疫**。
   *    表现是变异验证"改了却不红"，一查才知道正则从没匹配上。
   *
   * 2. 因此漏掉了 `copy "TavernCardStudioServer-0.1.2.msi" ...` 这句。
   *
   * ⇒ 字符类要包含 `-`、`.`、空格。
   *
   * ## 允许什么
   *
   * 正文叙述里"v0.1.9 实测 32.8 MiB"这种带版本的事实陈述是合法的 ——
   * 只查**代码围栏内**的可执行行。
   */
  const files = ['docs/09-server-deploy.md', 'docs/33-cloud-deploy.md', 'docs/server-cmd.md', 'docs/Cloud Deployment Manual.md'].filter(
    (rel) => readIfTracked(rel) !== null,
  );

  /* 文件名里可以有空格、连字符、点 */
  const HARDCODED = /Tavern[A-Za-z .-]*\d+\.\d+\.\d+[A-Za-z ._-]*\.(?:msi|apk)/i;

  for (const rel of files) {
    const text = read(rel);
    const blocks = [...text.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]);

    const bad = [];
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        /* 注释行不算（`# 例如 0.1.9` 这种说明） */
        if (/^\s*(#|\/\/)/.test(line)) continue;
        if (HARDCODED.test(line)) bad.push(line.trim());
      }
    }

    assert.deepEqual(
      bad,
      [],
      `${rel} 的代码块里写死了版本号（照抄会失败）：\n${bad.join('\n')}`,
    );
  }
});
