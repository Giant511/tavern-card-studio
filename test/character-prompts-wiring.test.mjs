/**
 * 「提示词跟随角色」的**接线判据**（2026-11-15，v0.2.0 第 1 步）。
 *
 * ## 为什么与 `character-prompts.test.mjs` 分开
 *
 * 那个文件测的是 `shared` 里的纯函数（解析 / 叠加 / 写回 / 上限），
 * 算错会被它抓住。
 *
 * 这里测的是**另一类风险**：
 *
 * ```text
 *   算得对，但没接上         → 用户改了没反应（§70.3 / §71.2 / §88 同源）
 *   接上了，但接在错的函数里  → 重启就失效（§130，作者注释那次）
 *   接了，但有一处漏改       → 只在"那种角色"上错（本次最大的风险）
 * ```
 *
 * 第三条是这次的核心：`this.promptConfig` 原本在 5 个地方被赋值，
 * 引入"全局 ⊕ 角色"两层之后，**任一处漏改**都会产生
 * 「切角色带着上一个角色的提示词」或「改完开关本角色的定制全没了」。
 * 这两种表现都不报错、不崩、界面看着正常。
 *
 * 对付它的办法不是"再测一遍行为"（行为要真机、要引擎），
 * 而是**把写入点收成唯一一个**，然后用判据钉死它。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  applyCharacterPrompts,
  combineGlobalAndCharacter,
  emptyCharacterPrompts,
  parseCharacterPrompts,
} from '../shared/dist/chat/index.js';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** 去注释（理由见 `test/chat-list-fields.test.mjs`：注释会让两类断言都失真） */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * 把注释**替换成等长空白**（保留换行）。
 *
 * 与 `stripComments` 的区别：长度与行号完全不变。
 *
 * 为什么需要这个：下面几条判据失败时会报"第 N 行"给开发看。
 * 用 `stripComments` 后的文本算行号，N 是**去掉注释后**的行号 ——
 * 而这个文件的注释比代码多得多，偏差能到几十行。
 *
 * ```text
 *   报错说"第 3723 行有一处多余的赋值"
 *   → 开发跳到 3723 行，那里是段无关的注释
 *   → 他会认为判据是坏的，然后把它删掉
 * ```
 *
 * 给出错误位置比不给位置更糟。所以这里保住行号。
 */
const blankComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (one) => one.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (one) => one.replace(/[^\n]/g, ' '));

/* ═══════════════════════════════════════════════════════════
   造数据的小工具
   ═══════════════════════════════════════════════════════════ */

/** 一条预设提示词 */
const prompt = (identifier, content, extra = {}) => ({
  identifier,
  name: identifier,
  content,
  role: 'system',
  systemPrompt: true,
  marker: false,
  injectionPosition: 0,
  injectionDepth: 4,
  injectionOrder: 100,
  ...extra,
});

/** 一份解析好的预设配置 */
const configOf = (prompts) => ({
  prompts,
  order: prompts.map((one) => ({ identifier: one.identifier, enabled: true })),
  orderSource: 'global',
  warnings: [],
});

/** 一份角色覆盖 */
const overlayOf = (overrideOrder, own = []) => ({
  version: 1,
  overrideOrder,
  own,
});

/* ═══════════════════════════════════════════════════════════
   一、合成规则（`combineGlobalAndCharacter`）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 全局为 null 时角色配置**整体不生效**（不许只剩 own）', () => {
  /*
   * 这条是整个功能最危险的一个分支，值得单独钉住。
   *
   * `promptConfig === null` 的语义是"用户没导入预设"，此时聊天面板走
   * `assembleContext` 的**固定拼装**（角色描述 / 人设 / 世设 / 历史，
   * 顺序硬编码）。
   *
   * 如果这时把角色覆盖接上去，面板会看到 `prompts.length > 0` 而切到
   * 提示词管理器模式 —— 那套拼装**依赖预设里的槽位**
   * （charDescription / chatHistory / worldInfoBefore …）。
   *
   * ```text
   *   没有预设的槽 ⇒ 角色描述没了、聊天历史没了
   *                ⇒ 模型不知道在扮演谁，也不记得刚才说了什么
   * ```
   *
   * 也就是说：为了让"卡片自带的一条提示词"生效，会把整个上下文打穿。
   * 那不是"少生效一点"，是**比不生效严重得多**。所以宁可不生效。
   */
  const overlay = overlayOf({}, [
    { id: 'tcs-1', name: '卡片自带', content: '只在特定场景说方言', role: 'system', enabled: true },
  ]);

  assert.equal(
    combineGlobalAndCharacter(null, overlay),
    null,
    '全局为 null 时必须返回 null（回退固定拼装），不能拿 own 单独撑一份配置',
  );

  /* 空配置的全局（prompts 为 0 条）与 null 同义 —— 都代表"没有可用预设" */
  assert.equal(
    combineGlobalAndCharacter(configOf([]), overlay),
    null,
    '全局有对象但 0 条提示词，等价于没预设',
  );
});

test('★★★★ 角色没配过时**原样返回全局那个对象**（引用相等，零迁移）', () => {
  /*
   * 零迁移的技术保证：98% 的角色没有 `tcs.prompts`，此时输出必须与
   * v0.1.10 完全一致。
   *
   * 钉**引用相等**而不是"内容相等"：内容相等可以通过"深拷贝一遍"达成，
   * 而那会让面板每次切角色都拿到新对象 ⇒ 触发不必要的重渲染，
   * 且将来某个模块用 `===` 做缓存判断时会莫名其妙失效。
   */
  const global = configOf([prompt('main', '你是 {{char}}'), prompt('chatHistory', '')]);

  assert.equal(combineGlobalAndCharacter(global, null), global, 'overlay 为 null 要原样返回');
  assert.equal(
    combineGlobalAndCharacter(global, emptyCharacterPrompts()),
    global,
    '空配置（overrideOrder 与 own 都空）也要原样返回',
  );
});

test('★★★★ 两层都有值时真的叠上去（正文覆盖 + 开关覆盖 + 追加 own）', () => {
  const global = configOf([prompt('main', '全局版'), prompt('jailbreak', '全局越狱'), prompt('chatHistory', '')]);
  const overlay = overlayOf(
    { main: { content: '这个角色的版本' }, jailbreak: { enabled: false } },
    [{ id: 'tcs-9', name: '方言', content: '说话带四川口音', role: 'system', enabled: true }],
  );

  const merged = combineGlobalAndCharacter(global, overlay);
  assert.notEqual(merged, null);
  assert.notEqual(merged, global, '叠过之后必须是新对象');

  const byId = new Map(merged.prompts.map((one) => [one.identifier, one]));
  assert.equal(byId.get('main').content, '这个角色的版本', '正文覆盖要生效');
  assert.equal(byId.get('jailbreak').content, '全局越狱', '只改开关时正文不动');

  const orderById = new Map(merged.order.map((one) => [one.identifier, one.enabled]));
  assert.equal(orderById.get('jailbreak'), false, '开关覆盖要生效');
  assert.equal(orderById.get('tcs-9'), true, 'own 项要进顺序表且按自己的 enabled');

  /* 入参不许被改（`applyCharacterPrompts` 的契约） */
  assert.equal(global.prompts[0].content, '全局版', '全局配置不能被改');
  assert.equal(overlay.overrideOrder.main.content, '这个角色的版本', '覆盖对象不能被改');
});

test('★★★ 合成结果与直接 apply 完全一致（不许在这里长第二套规则）', () => {
  /*
   * `combineGlobalAndCharacter` 只该做"该不该叠"的判断，
   * 叠加本身必须完全交给 `applyCharacterPrompts`。
   *
   * 一旦它自己动手（例如顺手过滤几条、补个默认值），就会出现
   * "直接调 apply 的结果"与"走合成链路的结果"不同 —— 而两处都有人调。
   */
  const global = configOf([prompt('main', 'A'), prompt('nsfw', 'B')]);
  const overlay = overlayOf({ main: { content: 'a' } }, [
    { id: 'tcs-1', name: 'x', content: 'y', role: 'user', enabled: false },
  ]);

  assert.deepEqual(
    combineGlobalAndCharacter(global, overlay),
    applyCharacterPrompts(global, overlay),
    '合成函数不许在 apply 之外再加工',
  );
});

/* ═══════════════════════════════════════════════════════════
   二、写入点唯一（真机能踩、单测踩不到的漏改）
   ═══════════════════════════════════════════════════════════ */

/*
 * 用 `blankComments` 而不是 `stripComments`：下面几条判据失败时会报行号，
 * 而报出的行号必须是**真文件中**的行号（见上面 `blankComments` 的注释）。
 */
const shellSrc = blankComments(read('client/src/chat/shell.ts'));

/** 数一个模式在源码里出现几次（带行号，失败时能直接跳过去看） */
function occurrences(src, pattern) {
  const re = new RegExp(pattern, 'g');
  const out = [];
  let match;
  while ((match = re.exec(src)) !== null) {
    const line = src.slice(0, match.index).split('\n').length;
    out.push({ line, text: match[0] });
  }
  return out;
}

test('★★★★★ `this.promptConfig` 全文件只有一个写入点', () => {
  /*
   * ★ 这是本文件最有价值的一条。
   *
   * 引入两层之后，正确写法是"任何变化都调 `rebuildPromptConfig()`"。
   * 只要有人图省事直接写一句 `this.promptConfig = fresh`，
   * 就会**静默丢掉角色覆盖** —— 表现是：
   *
   * ```text
   *   用户给角色 A 改了一条提示词 → 生效了
   *   用户随手切一下预设（或改个开关）→ 定制全没了
   *   切到角色 B 再切回 A → 又还在（因为读卡会重建）
   * ```
   *
   * 这种"时好时坏、要靠特定操作顺序复现"的缺陷，靠真机走查基本抓不到。
   * 钉住"只有一个写入点"之后，漏改会在 CI 就红。
   */
  const writes = occurrences(shellSrc, String.raw`this\.promptConfig\s*=[^=]`);
  assert.equal(
    writes.length,
    1,
    `this.promptConfig 只允许在 rebuildPromptConfig() 里写一次，实际 ${String(writes.length)} 处：` +
      writes.map((one) => `第 ${String(one.line)} 行`).join('、') +
      '。要改全局那份请改 globalPromptConfig 再调 rebuildPromptConfig()。',
  );

  /* 且那唯一一次必须就在 rebuildPromptConfig 里面（不是别的方法里恰好也只写一次） */
  const rebuilt = shellSrc.slice(shellSrc.indexOf('private rebuildPromptConfig('));
  const body = rebuilt.slice(0, rebuilt.indexOf('\n  }'));
  assert.match(body, /this\.promptConfig = merged/, '唯一写入点要在 rebuildPromptConfig 内');
  assert.match(body, /combineGlobalAndCharacter\(/, '要经合成函数，不能绕过');
});

test('★★★★★ `this.loadedCard` 全文件只有一个写入点（必须连带清提示词）', () => {
  /*
   * `loadedCard` 与 `characterPrompts` 是**同一张卡的两个切面**。
   * 只换卡不清提示词 ⇒ 切到读卡失败的角色时，会按上一个角色的提示词发消息。
   * 而读卡失败是**正常时序**（引擎没起），不是异常。
   */
  const writes = occurrences(shellSrc, String.raw`this\.loadedCard\s*=[^=]`);
  assert.equal(
    writes.length,
    1,
    `this.loadedCard 只允许在 adoptLoadedCard() 里写一次，实际 ${String(writes.length)} 处：` +
      writes.map((one) => `第 ${String(one.line)} 行`).join('、'),
  );

  const adopt = shellSrc.slice(shellSrc.indexOf('private adoptLoadedCard('));
  const body = adopt.slice(0, adopt.indexOf('\n  }'));
  assert.match(body, /this\.loadedCard = card/, '收卡要在这个方法里');
  assert.match(
    body,
    /parseCharacterPrompts\(card\['extensions'\]\)/,
    '收卡必须同时从 extensions 解析角色提示词',
  );
  assert.match(body, /this\.rebuildPromptConfig\(\)/, '收卡后要重算生效配置');
});

test('★★★★ `loadCharacterCard` 的四条分支全部走 adoptLoadedCard', () => {
  /*
   * 原来这里有 4 处裸赋值：读卡成功 / PNG 不是卡 / JSON 不是对象 / catch。
   * 只在"成功"那一支加解析，另外三支就会把上一个角色的提示词留在原地。
   *
   * 判的是"这个函数体里一次裸赋值都没有" —— 而不是"有几处 adopt"：
   * 将来加了第五条失败分支（例如超时），只要它也用 adopt 就是对的，
   * 判据不该因为数字变化而假红。
   */
  const start = shellSrc.indexOf('private async loadCharacterCard(');
  assert.ok(start > 0, '找不到 loadCharacterCard');
  const body = shellSrc.slice(start, shellSrc.indexOf('private adoptLoadedCard(', start));

  assert.doesNotMatch(
    body,
    /this\.loadedCard\s*=/,
    'loadCharacterCard 里不许再出现裸赋值 —— 一律走 adoptLoadedCard({})',
  );
  assert.match(body, /this\.adoptLoadedCard\(\{\}\)/, '失败分支要清空卡（连带清提示词）');
});

test('★★★★ 三条"预设变了"的路径都重算生效配置', () => {
  /*
   * 预设变了三处：冷启动播种、改完开关写回预设、切换预设。
   * 任何一处漏了 `rebuildPromptConfig()`，表现都是"改了但没生效"。
   *
   * 这条与上面"唯一写入点"是互补的：那条防"绕过合成"，
   * 这条防"合成完忘了算"。
   */
  assert.match(
    shellSrc,
    /this\.globalPromptConfig = config\.prompts\.length > 0 \? config : null;\s*\n\s*this\.rebuildPromptConfig\(\)/,
    'seedPromptConfig 里解析完要立刻重算',
  );
  assert.match(
    shellSrc,
    /this\.globalPromptConfig = fresh\.prompts\.length > 0 \? fresh : null;\s*\n\s*this\.rebuildPromptConfig\(\)/,
    '写回预设后要立刻重算',
  );
  assert.match(
    shellSrc,
    /this\.globalPromptConfig = nextConfig\.prompts\.length > 0 \? nextConfig : null;\s*\n\s*this\.rebuildPromptConfig\(\)/,
    '切换预设后要立刻重算',
  );
});

test('★★★★ 重算之后必须把结果推给面板（不推 = 面板一直用旧的）', () => {
  /*
   * 本项目最反复的缺陷类型：算对了、存对了，就是没推给消费者。
   * 作者注释那条（§130）就是"实现存在，但接在了错的函数里"。
   */
  const start = shellSrc.indexOf('private rebuildPromptConfig(');
  const body = shellSrc.slice(start, shellSrc.indexOf('\n  }', start));
  assert.match(
    body,
    /this\.chatPanel\?\.setContext\(\{ promptConfig: merged \}\)/,
    'rebuildPromptConfig 里要 setContext 推给面板',
  );
});

/* ═══════════════════════════════════════════════════════════
   三、真链路上的端到端（不碰网络，纯函数走一遍）
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 从卡片 extensions 一路到生效配置（模拟切角色）', () => {
  /*
   * 把外壳里的三步手工串起来跑一遍：
   *
   * ```text
   *   卡 PNG 里的 data.extensions  →  parseCharacterPrompts
   *   全局预设                     →  parsePromptConfig（这里用现成对象代替）
   *   两者                         →  combineGlobalAndCharacter
   * ```
   *
   * 这一步能抓到的错误：两边的接口不匹配（例如解析出来的是 `tcs` 那一层
   * 而不是 `prompts` 那一层），而类型检查看不出来 —— 因为两边都是 unknown。
   */
  const extensions = {
    /* 别的工具留的键，必须原样留住（V2 MUST NOT destroy unknown keys） */
    depth_prompt: { prompt: '深度提示', depth: 4, role: 'system' },
    tcs: {
      cardId: 'abc123',
      prompts: {
        version: 1,
        overrideOrder: { main: { content: '四川话版' } },
        own: [{ id: 'tcs-1', name: '方言', content: '说话带四川口音', role: 'system', enabled: true }],
      },
    },
  };

  const overlay = parseCharacterPrompts(extensions);
  assert.notEqual(overlay, null, '要从 extensions 里解析出配置');

  const global = configOf([prompt('main', '普通话版'), prompt('chatHistory', '')]);
  const merged = combineGlobalAndCharacter(global, overlay);

  const byId = new Map(merged.prompts.map((one) => [one.identifier, one]));
  assert.equal(byId.get('main').content, '四川话版');
  assert.ok(byId.has('tcs-1'), 'own 项要出现在生效配置里');
  assert.ok(
    merged.order.some((one) => one.identifier === 'tcs-1'),
    'own 项要进顺序表 —— 不进就等于没发出去',
  );
});

test('★★★★ 切到没配过提示词的角色，必须干净退回全局', () => {
  /*
   * 反向的那一半：A 角色有定制，切到 B（没有任何 tcs.prompts）。
   * `parseCharacterPrompts` 对空 extensions 返回 null ⇒ 合成退回全局。
   *
   * 这条对应的真机现象是"切到 B，B 却按 A 的定制说话" ——
   * 用户无法解释，我们也无法归因（因为两边的卡看起来都正常）。
   */
  const overlayA = parseCharacterPrompts({
    tcs: { prompts: { version: 1, overrideOrder: { main: { content: 'A 的版本' } }, own: [] } },
  });
  assert.notEqual(overlayA, null);

  const overlayB = parseCharacterPrompts({});
  assert.equal(overlayB, null, '没配过的角色要解析成 null');

  const global = configOf([prompt('main', '全局版')]);
  const mergedA = combineGlobalAndCharacter(global, overlayA);
  const mergedB = combineGlobalAndCharacter(global, overlayB);

  assert.equal(mergedA.prompts[0].content, 'A 的版本');
  assert.equal(mergedB, global, 'B 必须与全局是同一个对象（完全不受 A 影响）');
});
