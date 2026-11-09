/**
 * 「用户不该知道有没有 SillyTavern」（2026-11-04，第三十一批）。
 *
 * ## 用户原话
 *
 * > 用户不需要知道 ST 是什么，只需要知道 APP 有完整聊天功能就行，
 * > 即 ST 和 APP 在用户看来是一个整体而不是割裂的，
 * > 因为客户按照的时候就只装了一个安装包
 *
 * ## 为什么这件事必须用判据守
 *
 * 这不是"改一次就完"的活。只要有人新增一条错误提示、一句说明，
 * 就会顺口写上"保存到 SillyTavern"——因为**在代码里它就叫这个名字**。
 * 写的人不觉得有问题（那是内部真实名称），看的人却第一次听说这个词。
 *
 * 所以判据要扫**所有面向用户的字符串**，而不只是"我这次改过的那几处"。
 *
 * ## 判据怎么区分"注释"与"用户能看到的文案"
 *
 * 用**字符串字面量**做判据：
 *
 * ```ts
 * // 注释里写 SillyTavern 是给开发者看的 —— 不该管，也管不住
 * el.textContent = '保存到 SillyTavern';   // ← 这才要拦
 * ```
 *
 * 简单办法：把源码里所有单/双引号、反引号包起来的内容抽出来检查。
 * 注释里的内容通常不打引号，所以天然被排除。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** 面向用户的源码（桌面编辑器不在内 —— 那是给作者用的工具，术语可保留） */
const UI_FILES = [
  'client/src/chat/shell.ts',
  'client/src/chat/api-page.ts',
  'client/src/chat/voice-settings.ts',
  'client/src/chat/chat-settings.ts',
  'client/src/chat/chat-actions-page.ts',
  'client/src/chat/character-picker.ts',
  /* v0.1.8：本地卡导入的文案（"PNG 卡或 JSON 卡"这类提示都面向用户） */
  'client/src/chat/card-import-local.ts',
  'client/src/chat/busy-button.ts',
  /* v0.1.8：卡面（"这张图读不出来，换一张 PNG 或 JPG"这类都是用户文案） */
  'client/src/chat/card-face.ts',
  'client/src/chat/persona-page.ts',
  'client/src/chat/chat-panel.ts',
  'client/src/chat/select-popover.ts',
  'client/src/chat/chat-prompts-page.ts',
  'client/src/chat/keyboard-inset.ts',
  'client/src/mobile/main.ts',
  'shared/src/chat/bridge-error.ts',
  'shared/src/chat/engine-status.ts',
  'shared/src/chat/prompt-toggle.ts',
  'shared/src/chat/settings-schema.ts',
  'shared/src/chat/persona.ts',
];

/**
 * 抽取一段源码里所有**字符串字面量**的内容。
 *
 * 为什么要抽而不是直接搜整份文件：注释里出现 SillyTavern 是正常的
 * （那是内部模块的真实名字，写下来有助于以后维护）。
 * 只有**用户会看到的那部分**才是问题。
 *
 * 这是个不太严谨的词法扫描（不处理嵌套模板字符串），但足够用来抓
 * "把内部术语写进界面文案"这类问题 —— 过度严谨会让判据本身变得难懂。
 */
function stringLiterals(source) {
  const out = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];

    /* 行注释：跳到行尾 */
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
      continue;
    }

    /* 块注释：跳到结束 */
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let buf = '';
      while (j < n) {
        if (source[j] === '\\') {
          buf += source[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (source[j] === quote) break;
        /* 模板字符串里的 ${...} 直接跳过（里面是表达式，不是文案） */
        if (quote === '`' && source[j] === '$' && source[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (source[j] === '{') depth += 1;
            if (source[j] === '}') depth -= 1;
            j += 1;
          }
          buf += ' ';
          continue;
        }
        buf += source[j];
        j += 1;
      }
      out.push({ text: buf, index: i });
      i = j + 1;
      continue;
    }

    i += 1;
  }

  return out;
}

/**
 * JS 语言关键字 / 类型名。
 *
 * 这些出现在字符串字面量里是**语言用法**（`typeof x !== 'undefined'`），
 * 不是给用户看的文案。判据不该管它们。
 */
const JS_KEYWORDS = new Set([
  'undefined', 'null', 'true', 'false', 'object', 'string', 'number', 'boolean',
  'function', 'symbol', 'bigint',
]);

/** 把字面量的位置换成行号，报错时能直接跳过去 */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/* ═══════════════════════════════════════════════════════════
   一、界面文案里不许出现内部术语
   ═══════════════════════════════════════════════════════════ */

test('★★★ 面向用户的文案里不许出现 SillyTavern', () => {
  const offenders = [];

  for (const rel of UI_FILES) {
    let source;
    try {
      source = readFileSync(join(REPO, rel), 'utf8');
    } catch {
      continue; /* 文件可能改名了，跳过而不是让判据崩 */
    }

    for (const literal of stringLiterals(source)) {
      if (/SillyTavern/i.test(literal.text)) {
        offenders.push(`${rel}:${String(lineOf(source, literal.index))} → ${literal.text.slice(0, 70)}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `界面文案里出现了 SillyTavern（用户不知道那是什么）：\n  ${offenders.join('\n  ')}\n` +
      '改成「聊天服务」「服务器」等中性说法；只在注释里保留原名。',
  );
});

test('★★★ 面向用户的文案里不许出现单独一个 ST', () => {
  /*
   * ## 这是上一轮漏掉的一种（2026-11-04 截图抓到）
   *
   * 上一轮只抓 `SillyTavern` 全称和「仅存 ST」。而真机上还有：
   *
   * ```text
   *   预设是 ST 的一整套参数。
   *   之后可在 ST 里加其他成员
   *   在 ST 里填「上下文长度」后才会按预算裁剪
   * ```
   *
   * `ST` 作为缩写，用户更看不懂 —— 全称至少还像个产品名。
   *
   * ★ 为什么用 `(?<![A-Za-z])ST(?![A-Za-z])` 而不是 `/ST/`
   *
   * 后者会命中 `ST_UNAVAILABLE`、`POSITION_BY_ST_VALUE` 这类代码常量。
   * 前后不接字母才是"独立出现的缩写"。
   *
   * ★ 也不能用 `\bST\b`：`\b` 把下划线当单词字符，
   * 所以 `ST_UNAVAILABLE` 里的 ST 也有词边界，照样误报。
   *
   * ★ 前后要排除的是 `[A-Za-z_]` 而不是 `[A-Za-z]` ——
   * 我第一版漏了下划线，于是 `ST_UNAVAILABLE` 这类代码常量被当成文案抓出来
   * （`_` 不是字母，`(?![A-Za-z])` 就满足了）。
   */
  const offenders = [];

  for (const rel of UI_FILES) {
    let source;
    try {
      source = readFileSync(join(REPO, rel), 'utf8');
    } catch {
      continue;
    }

    for (const literal of stringLiterals(source)) {
      /*
       * ★ 跳过纯技术性字符串（2026-11-04 抓到的假阳性）。
       *
       * `typeof Headers !== 'undefined'` 是标准类型守卫写法，
       * 而 `'undefined'` 里的 `undefined` 含 `ST`？不 —— 它含的是
       * "undefined"，被这条判据抓到是因为 `native-fetch.ts` 里那个
       * 字符串字面量恰好是 JS 关键字。
       *
       * 判据的目的是"抓内部产品名出现在界面上"，不该管语言关键字。
       */
      if (JS_KEYWORDS.has(literal.text.trim())) continue;
      if (/(?<![A-Za-z_])ST(?![A-Za-z_])/.test(literal.text)) {
        offenders.push(`${rel}:${String(lineOf(source, literal.index))} → ${literal.text.slice(0, 70)}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `界面文案里出现了 ST（用户不知道这个缩写）：\n  ${offenders.join('\n  ')}`,
  );
});

test('★★★ 面向用户的文案里不许出现「酒馆引擎」这类拆件说法', () => {
  /*
   * 「引擎」「中转」这些词在用户眼里意味着"这个 App 里还有别的部件"。
   * 「口袋酒馆」是 App 自己的名字（通知栏那条），可以保留。
   */
  const banned = [/SillyTavern/i, /酒馆引擎/, /ST 引擎/];
  const offenders = [];

  for (const rel of UI_FILES) {
    let source;
    try {
      source = readFileSync(join(REPO, rel), 'utf8');
    } catch {
      continue;
    }
    for (const literal of stringLiterals(source)) {
      for (const pattern of banned) {
        if (pattern.test(literal.text)) {
          offenders.push(`${rel}:${String(lineOf(source, literal.index))} → ${literal.text.slice(0, 70)}`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], `出现了拆件说法：\n  ${offenders.join('\n  ')}`);
});

test('★★ 「仅存 ST」这种分组标题必须消失', () => {
  /*
   * 那个分组里原本有 15 个"改了没用"的字段，已整块删除。
   * 分组标题如果还在，说明有人又把假控件加回来了。
   */
  const schema = readFileSync(join(REPO, 'shared/src/chat/settings-schema.ts'), 'utf8');

  for (const literal of stringLiterals(schema)) {
    assert.ok(
      !/仅存\s*ST/.test(literal.text),
      `设置页还有「仅存 ST」的分组或说明：${literal.text.slice(0, 60)}`,
    );
  }
});

/* ═══════════════════════════════════════════════════════════
   二、界面上的字段必须真的能生效
   ═══════════════════════════════════════════════════════════ */

test('★★★ 采样页的每个字段都必须说明生效路径', async () => {
  /*
   * 三种：进请求体（有映射）/ 间接生效（`indirect`）/ 只存不生效（`sent:false`）。
   *
   * 第三种现在**一个都不许有** —— 那正是用户要求删掉的东西。
   * 这条判据与 `sampling-migration.test.mjs` 的 a3/a3b 互补：
   * 那边管"机制对不对"，这里管"结果里没有死字段"。
   */
  const { SAMPLING_SECTION } = await import('../shared/dist/chat/settings-schema.js');
  const { SAMPLING_PATH_TO_PARAM } = await import('../shared/dist/chat/sampling-bridge.js');

  for (const field of SAMPLING_SECTION.fields) {
    const path = field.path.join('.');
    const hasMapping = SAMPLING_PATH_TO_PARAM[path] !== undefined;
    const isIndirect = field.indirect !== undefined;

    assert.ok(
      hasMapping || isIndirect,
      `${path} 既没进请求体、也没标 indirect —— 改了大概率不生效却摆在界面上`,
    );
    assert.ok(
      !(hasMapping && isIndirect),
      `${path} 既在映射表里又标了 indirect，两处说法矛盾`,
    );
  }
});

test('★★★ 「上下文长度」必须标成间接生效（不是只存）', async () => {
  /*
   * 这是这一批最容易搞错的一项：它**不进请求体**，所以看起来像"只存"，
   * 但它决定我们发多少历史（`computeBudget`）—— 改了会实实在在地
   * 改变模型看到的上下文。
   *
   * 上一版把它标成 `sent: false` 并写"App 不带这个上限"，而代码明明读了它。
   */
  const { SAMPLING_SECTION } = await import('../shared/dist/chat/settings-schema.js');

  const field = SAMPLING_SECTION.fields.find(
    (one) => one.path.join('.') === 'oai_settings.openai_max_context',
  );
  assert.ok(field !== undefined, '「上下文长度」字段不见了');
  assert.equal(field.sent, undefined, '它不该标 sent:false（那是"不生效"的意思）');
  assert.ok(
    typeof field.indirect === 'string' && field.indirect !== '',
    '它必须标 indirect 并说明生效路径',
  );
});

test('★★★ 界面文案里不许承诺「只保存到某处」', () => {
  /*
   * 这类话（"这一项目前只保存到 SillyTavern"）同时犯了两个错：
   * 承认了有个隐藏界面 + 承认了这里的控件是假的。
   */
  const offenders = [];
  for (const rel of UI_FILES) {
    let source;
    try {
      source = readFileSync(join(REPO, rel), 'utf8');
    } catch {
      continue;
    }
    for (const literal of stringLiterals(source)) {
      /*
       * 只抓"只保存到 **某个内部来源**"这类。
       *
       * 「只保存到本机，没同步到服务」是**正当的失败反馈** ——
       * 用户需要知道保存没成事。要抓的是"只保存到 SillyTavern / 引擎"
       * 这种"承认有个你看不见的地方"。
       */
      if (/只保存到\s*(SillyTavern|ST|酒馆|引擎)/i.test(literal.text) || /仅在.{0,8}(界面|引擎)里/.test(literal.text) || /不参与生成/.test(literal.text)) {
        offenders.push(`${rel}:${String(lineOf(source, literal.index))} → ${literal.text.slice(0, 70)}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `这些文案在承认"这个控件是假的"：\n  ${offenders.join('\n  ')}\n` +
      '做不了的功能应该从界面拿掉，而不是留着开关再解释它没用。',
  );
});

test('★★★ 多行输入框的圆角必须小于它的高度（否则画成椭圆）', () => {
  /*
   * ## 这个缺陷在真机上活了两批（2026-11-04 截图抓到）
   *
   * `.nb-input` 用 `border-radius: var(--nb-radius-pill)`（约 20px），
   * 单行输入框高 40px，圆角刚好是半高 —— 看起来像胶囊，正常。
   *
   * 但 `.nb-input--multiline`（textarea）`min-height: 72px`，
   * 同一个 pill 半径下四个角几乎相交，整个框被画成**椭圆/圆形**，
   * 文字挤在中间、左右大量留白。用户设定描述那一栏就是这样。
   *
   * ## 为什么判据要这么写
   *
   * 光断言"多行框不许用 pill"是死的（将来可能有人用别的变量名）。
   * 断言**语义**更稳：多行框必须显式声明一个非 pill 的圆角 ——
   * 因为它的高度是可变的，任何"按高度一半取半径"的写法都会随内容撑开而失控。
   */
  const css = readFileSync(join(REPO, 'client/src/chat/chat.css'), 'utf8');
  const start = css.indexOf('.nb-input--multiline');
  assert.ok(start > 0, '找不到 .nb-input--multiline');
  const end = css.indexOf('}', start);
  /*
   * ★ 先剥掉注释再判。
   *
   * 这段注释里**刻意**写着 `border-radius: var(--nb-radius-pill)` 来解释
   * 原来错在哪 —— 不剥的话判据会被自己的说明文字命中（"注释骗判据"，
   * 这个项目已经踩过四五次）。
   */
  const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');

  assert.match(
    block,
    /border-radius:\s*var\(--nb-radius-(sm|md|lg)\)/,
    '多行输入框必须显式声明较小的圆角（不能继承 .nb-input 的 pill）',
  );
  assert.ok(
    !/border-radius:\s*var\(--nb-radius-pill\)/.test(block),
    '多行输入框用了胶囊圆角 —— 高框会被画成椭圆',
  );
});
