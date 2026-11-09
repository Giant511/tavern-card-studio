/**
 * 聊天参数字段规格（v0.1.7 / 第三批问题二）。
 *
 * ## 这组测试为什么最有价值
 *
 * 字段路径写错的症状是**"保存成功但没生效"** —— 界面显示新值、
 * ST 用的还是旧值，不报错、不抛异常、单测也不会红（因为测的是"写进去了"）。
 *
 * 2026-10-31 核对真实 ST 时，第一版想当然写过这些错：
 *   · `temp`（真实是 `oai_settings.temp_openai`）
 *   · `top_p`（真实是 `oai_settings.top_p_openai`）
 *   · `trim_spaces` 放顶层（真实在 `power_user` 子对象里）
 *
 * 所以这里做两件事：
 *   1. **有真 ST 数据就用真数据对拍**（`D:\SillyTavern\default\content\settings.json`）
 *   2. 没有真数据的机器上，用一份**按真实结构手抄的样本**继续守
 *
 * 第 2 条不是退让：CI/别的机器上不该依赖本机有没有装 ST。
 * 样本里带注释说明它是从真文件抄的。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  CHAT_SETTINGS_GROUPS,
  FORMATTING_SECTION,
  SAMPLING_SECTION,
  readField,
  readSectionValues,
  validateNumber,
  writeField,
} from '../shared/src/chat/settings-schema.ts';

/** 本机 ST 的真实配置（有就读，没有就跳过那几条） */
const REAL_ST_SETTINGS = 'D:/SillyTavern/default/content/settings.json';

/**
 * 按真实结构手抄的样本。
 *
 * 与 `D:\SillyTavern\default\content\settings.json` 的层级**逐字一致**：
 * `oai_settings` 是子对象、格式化键在 `power_user` 下。
 * 少抄了无关字段（themes / extensions 等），那些不参与本模块。
 */
const SAMPLE = {
  oai_settings: {
    temp_openai: 1,
    top_p_openai: 1,
    top_k_openai: 0,
    openai_max_tokens: 300,
    freq_pen_openai: 0,
    // ★ 故意不放 repetition_penalty_openai：真实默认 settings.json 里也没有它，
    // 这样能顺带测到 fallback 分支
  },
  power_user: {
    trim_spaces: true,
    collapse_newlines: false,
    trim_sentences: false,
    quick_continue: false,
    continue_on_send: false,
  },
};

/* ═══════════════════════════════════════════════════════════
   一、路径必须命中真实 ST 结构
   ═══════════════════════════════════════════════════════════ */

test('★ 每一个字段路径都能在 ST 结构里走通（或按设计走 fallback）', () => {
  const settings = existsSync(REAL_ST_SETTINGS)
    ? JSON.parse(readFileSync(REAL_ST_SETTINGS, 'utf8'))
    : SAMPLE;

  const usingReal = existsSync(REAL_ST_SETTINGS);
  console.log(`  数据来源：${usingReal ? '本机真实 settings.json' : '手抄样本'}`);

  const problems = [];

  for (const section of [SAMPLING_SECTION, FORMATTING_SECTION]) {
    for (const field of section.fields) {
      // 手动走一遍路径，判断"键到底在不在"
      let cursor = settings;
      let pathExists = true;
      for (const key of field.path) {
        if (cursor !== null && typeof cursor === 'object' && key in cursor) {
          cursor = cursor[key];
        } else {
          pathExists = false;
          break;
        }
      }

      const viaApi = readField(settings, field);

      if (pathExists) {
        // 键在 ⇒ readField 必须原样返回，不许走 fallback
        if (viaApi !== cursor) {
          problems.push(`${field.path.join('.')}：键存在但读出 ${JSON.stringify(viaApi)}（真实 ${JSON.stringify(cursor)}）`);
        }
      } else {
        // 键不在 ⇒ 必须给 fallback（而不是 undefined / NaN）
        if (viaApi !== field.fallback) {
          problems.push(`${field.path.join('.')}：键不存在时应给 fallback ${JSON.stringify(field.fallback)}，实际 ${JSON.stringify(viaApi)}`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], `字段路径有问题：\n  ${problems.join('\n  ')}`);
});

test('★ 采样字段名必须是 ST 真实存在的键（不许凭印象起名）', () => {
  /*
   * 这条守的是"有人凭印象加字段"。
   *
   * ## 为什么从「_openai 后缀正则」改成「真实键名白名单」
   *
   * 原判据要求每个采样字段名以 `_openai` 结尾（或就是 `openai_max_tokens`）。
   * 这个规律对**纯采样参数**成立（`temp_openai` / `top_p_openai`…），
   * 但 2026-11-03 照 ST 原生面板补齐之后，`oai_settings` 里合法却
   * **不带 `_openai` 后缀**的键出现了很多：
   *
   * ```text
   *   oai_settings.max_context_unlocked
   *   oai_settings.openai_max_context
   *   oai_settings.n / seed / names_behavior / show_thoughts
   *   oai_settings.continue_nudge_prompt / function_calling / media_inlining
   * ```
   *
   * 它们都是真的（`public/scripts/openai.js` 的 `settingsToUpdate` 里有），
   * 所以正则红了而代码是对的 —— 又是"判据钉实现特征"。
   *
   * ## 新判据更强
   *
   * 不再猜"名字长什么样"，而是要求**每个键都在一张从 ST 源码抄下来的清单里**。
   * 有人瞎编一个 `oai_settings.temperature`（短名，ST 里没有）时照样红。
   */
  const ST_OAI_KEYS = new Set([
    // 采样
    'temp_openai',
    'freq_pen_openai',
    'pres_pen_openai',
    'top_p_openai',
    'top_k_openai',
    'top_a_openai',
    'min_p_openai',
    'repetition_penalty_openai',
    // 长度 / 上下文
    'openai_max_tokens',
    'openai_max_context',
    'max_context_unlocked',
    'n',
    'stream_openai',
    // 随机性 / 思维链
    'seed',
    'show_thoughts',
    'reasoning_effort',
    'verbosity',
    // ST 前端专用
    'names_behavior',
    'continue_nudge_prompt',
    'continue_prefill',
    'assistant_prefill',
    'squash_system_messages',
    'function_calling',
    'tool_call_recurse_limit',
    'tool_reasoning_mode',
    'media_inlining',
    'inline_image_quality',
    'custom_prompt_post_processing',
  ]);

  for (const field of [...SAMPLING_SECTION.fields, ...FORMATTING_SECTION.fields]) {
    assert.ok(field.path.length >= 2, `${field.path.join('.')} 是裸顶层键，ST 里没有这种`);
  }

  for (const field of SAMPLING_SECTION.fields) {
    const path = field.path.join('.');
    assert.match(path, /^oai_settings\./, `采样字段必须在 oai_settings 下，实际：${path}`);
    const key = field.path[1];
    assert.ok(
      ST_OAI_KEYS.has(key),
      `${path} 不在 ST 的 oai_settings 真实键名清单里（凭印象起的名字？核对 public/scripts/openai.js 的 settingsToUpdate）`,
    );
  }
});

test('★ 每个字段都要有 fallback（默认 settings.json 并非每个键都存在）', () => {
  /*
   * 2026-10-31 实测：默认 settings.json 里**没有** `repetition_penalty_openai`，
   * 也没有 `humanize_ids` / `continue_postfix`。UI 直接读 undefined 会显示空值。
   */
  for (const section of [SAMPLING_SECTION, FORMATTING_SECTION]) {
    for (const field of section.fields) {
      assert.notEqual(field.fallback, undefined, `${field.path.join('.')} 缺 fallback`);
      assert.notEqual(field.fallback, null, `${field.path.join('.')} 的 fallback 不许是 null`);
    }
  }
});

test('★ 数值字段必须写清 min/max/step（否则滑条没法约束）', () => {
  for (const section of [SAMPLING_SECTION, FORMATTING_SECTION]) {
    for (const field of section.fields) {
      if (field.kind !== 'number') continue;
      assert.equal(typeof field.min, 'number', `${field.path.join('.')} 缺 min`);
      assert.equal(typeof field.max, 'number', `${field.path.join('.')} 缺 max`);
      assert.equal(typeof field.step, 'number', `${field.path.join('.')} 缺 step`);
      assert.ok(
        field.min < field.max,
        `${field.path.join('.')} 的 min 必须小于 max`,
      );
      // fallback 必须落在范围内，否则打开页面就显示一个"越界值"
      assert.ok(
        field.fallback >= field.min && field.fallback <= field.max,
        `${field.path.join('.')} 的 fallback ${String(field.fallback)} 不在 [${String(field.min)}, ${String(field.max)}] 内`,
      );
    }
  }
});

/* ═══════════════════════════════════════════════════════════
   二、写入不许污染原对象，且要能建中间层
   ═══════════════════════════════════════════════════════════ */


/**
 * 按路径取一个字段。
 *
 * ## 为什么不用 `fields[0]`
 *
 * 这几条判据原本写 `SAMPLING_SECTION.fields[0]`，而它以前恰好是「温度」。
 * 2026-11-03 照 ST 原生面板补齐字段之后，第一项变成了「解锁上下文上限」
 * （还是布尔），于是 `writeField(original, field, 1.5)` 之类的断言全红 ——
 * **红的原因不是 writeField 坏了，是判据依赖了数组下标**。
 *
 * 按路径取就没有这个隐患：字段顺序怎么调都不影响这几条语义断言。
 */
function fieldAt(pathKey) {
  const hit = SAMPLING_SECTION.fields.find((f) => f.path.join('.') === pathKey);
  assert.ok(hit !== undefined, `SAMPLING_SECTION 里找不到 ${pathKey}`);
  return hit;
}

const TEMP_PATH = 'oai_settings.temp_openai';

test('★ writeField 不改原对象（保存失败时内存状态不能被改掉）', () => {
  const original = JSON.parse(JSON.stringify(SAMPLE));
  const field = fieldAt(TEMP_PATH);
  const next = writeField(original, field, 1.5);

  assert.notEqual(next, original, '必须返回新对象');
  assert.equal(readField(original, field), 1, '原对象不该被改');
  assert.equal(readField(next, field), 1.5);
});

test('★ writeField 在中间层缺失时自动建（全新配置里 oai_settings 可能不存在）', () => {
  const empty = {};
  const field = fieldAt(TEMP_PATH);
  const next = writeField(empty, field, 0.7);

  assert.equal(readField(next, field), 0.7);
  assert.equal(
    next['oai_settings']?.['temp_openai'],
    0.7,
  );
});

test('★ writeField 不破坏兄弟字段（这是"整份覆盖"最容易踩的地方）', () => {
  /*
   * 写 `oai_settings.temp_openai` 时，如果实现是
   * `next.oai_settings = { temp_openai: v }`，那 top_p/top_k/max_tokens **全没了**。
   * 而 `applySettingsUpdate` 的"顶层键减少"检查**拦不住这个** ——
   * `oai_settings` 这个顶层键还在，只是里面被掏空了。
   */
  const field = fieldAt(TEMP_PATH);
  const next = writeField(SAMPLE, field, 1.2);

  assert.deepEqual(
    Object.keys(next['oai_settings']).sort(),
    Object.keys(SAMPLE.oai_settings).sort(),
    'oai_settings 的子键一个都不能少',
  );
  assert.equal(next['oai_settings']['top_p_openai'], 1, '兄弟字段的值要保持原样');
  assert.equal(next['oai_settings']['openai_max_tokens'], 300);
});

test('★ 深层路径（三层）也能正确写入', () => {
  const deep = { power_user: { instruct: { names_behavior: 'force', other: 1 } } };
  const field = {
    path: ['power_user', 'instruct', 'names_behavior'],
    label: '示例',
    kind: 'enum',
    fallback: 'force',
  };
  const next = writeField(deep, field, 'none');

  assert.equal(next['power_user']['instruct']['names_behavior'], 'none');
  assert.equal(next['power_user']['instruct']['other'], 1, '同层其它键要保留');
  assert.equal(deep['power_user']['instruct']['names_behavior'], 'force', '原对象不该被改');
});

/* ═══════════════════════════════════════════════════════════
   三、读成扁平表给 UI 用
   ═══════════════════════════════════════════════════════════ */

test('readSectionValues 给出每个字段一个值，缺的走 fallback', () => {
  const values = readSectionValues(SAMPLE, SAMPLING_SECTION);

  assert.equal(Object.keys(values).length, SAMPLING_SECTION.fields.length);
  assert.equal(values['oai_settings.temp_openai'], 1);
  // 这个键样本里故意没有
  assert.equal(
    values['oai_settings.repetition_penalty_openai'],
    SAMPLING_SECTION.fields.find((f) => f.path.join('.') === 'oai_settings.repetition_penalty_openai')
      ?.fallback,
  );
});

/* ═══════════════════════════════════════════════════════════
   四、数值校验：不静默夹紧，要明确说原因
   ═══════════════════════════════════════════════════════════ */

test('★ 越界要报错并说明范围，不许静默夹紧', () => {
  /*
   * 静默把 5 存成 2 会让用户以为"填了没用"。
   * 说清"要在 0 到 2 之间"，他才知道该改什么。
   */
  const temp = fieldAt(TEMP_PATH); // temp_openai, 0..2
  const r = validateNumber(temp, '5');

  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /0/);
    assert.match(r.reason, /2/);
  }
});

test('空值 / 非数字 / 合法值三种输入', () => {
  const temp = fieldAt(TEMP_PATH);

  const empty = validateNumber(temp, '   ');
  assert.equal(empty.ok, false);

  const nan = validateNumber(temp, 'abc');
  assert.equal(nan.ok, false);
  if (!nan.ok) assert.match(nan.reason, /数字/);

  const good = validateNumber(temp, '1.25');
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.value, 1.25);
});

/* ═══════════════════════════════════════════════════════════
   五、四项菜单与 ST 原生一致
   ═══════════════════════════════════════════════════════════ */

test('★ 聊天设置原生四项的顺序（用户要求与 ST 原生一致）', () => {
  /*
   * 需求原文：这四项「与 ST 原生一致」。
   *
   * ## 为什么判据从 `deepEqual(全部 id, 四项)` 改掉
   *
   * 原写法要求**恰好只有四项**，于是用户要求把「聊天设置里再加点东西」
   * 落进来之后它必然变红 —— 而红的原因不是"违反了用户要求"，
   * 是"判据把项目数也当成了需求"。
   *
   * ## 需求真正要求的是什么
   *
   * 是**熟悉 SillyTavern 的人打开就按记忆里的位置找得到东西**。
   * 拆成三条可验的：
   *   ① 四项都在，标题与 ST 里叫法一致；
   *   ② 相对顺序没变；
   *   ③ 第一项仍是「AI 响应配置」——新分组只能往**后面**追加。
   *
   * 这样加功能不会误红，而"把 AI 响应配置挪到第三位"这种真错仍然抓得住。
   */
  const ids = CHAT_SETTINGS_GROUPS.map((g) => g.id);

  const NATIVE = [
    ['sampling', 'AI 响应配置'],
    ['formatting', 'AI 回复格式化'],
    ['worldbook', '世界书管理'],
    /*
      * 原为 `['persona', '用户设置']`（2026-11-04 改）。
      *
      * 那一项其实**对应错了语义**：ST 的 `user-settings-button` 装的是
      * 界面外观（配色、示例消息行为、power user），persona 在 ST 里是
      * 独立的一级入口 `persona-management-button`。
      *
      * 而且它和「卡片 → 用户设定管理」重复。用户要求保留但改名 ——
      * 于是变成 `ui` / 「用户 UI 设置」，内容标「暂不支持」。
      */
    ['ui', '用户 UI 设置'],
  ];

  for (const [id, label] of NATIVE) {
    const group = CHAT_SETTINGS_GROUPS.find((g) => g.id === id);
    assert.ok(group !== undefined, `原生分组「${id}」不见了`);
    assert.equal(group.label, label, `原生分组「${id}」的标题被改了（ST 里就叫「${label}」）`);
  }

  const positions = NATIVE.map(([id]) => ids.indexOf(id));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(
      positions[i] > positions[i - 1],
      `原生分组相对顺序被打乱：${ids.join(' → ')}`,
    );
  }

  assert.equal(positions[0], 0, `第一项必须是「AI 响应配置」，实际是「${String(ids[0])}」`);
});

test('每个菜单项都有 hint（不写的话用户不知道点进去是什么）', () => {
  for (const g of CHAT_SETTINGS_GROUPS) {
    assert.ok(g.hint.length > 0, `${g.id} 缺 hint`);
  }
});

test('★★ 分组必须连续：同一个 group 的字段不许被别的组隔开', () => {
  /*
   * ## 这个缺陷长什么样（2026-11-03 真机抓到的）
   *
   * 页面渲染器是"看到 group 变了就插一个标题"。于是字段顺序如果是
   *
   * ```text
   *   仅存ST, 仅存ST, 回复长度, 仅存ST, 仅存ST, 采样, …
   * ```
   *
   * 就会渲染出 **8 个分组标题**，其中「仅存 ST（App 生成不使用）」出现 4 次。
   * 真机实测的 `data-group-head` 列表：
   *
   * ```text
   *   ["仅存 ST", "回复长度", "仅存 ST", "采样", "随机性", "仅存 ST", "思维链", "仅存 ST"]
   * ```
   *
   * 它的后果不是报错，是**页面看起来像坏了**：同一段说明重复四次，
   * 用户以为设置项丢了又在后面重复出现。
   *
   * ## 为什么单测原先抓不到
   *
   * 所有单测都按 key 取字段（`fieldAt()`）或遍历整个数组 ——
   * **顺序**从来没有被断言过。而这个缺陷的成因**只有顺序**。
   *
   * ## 判据
   *
   * 每个 group 出现的位置必须是**一段连续的区间**：
   * 取每个 group 第一次与最后一次出现的下标，中间不许夹别的组。
   */
  const seen = new Map();
  const order = [];
  for (const [index, field] of SAMPLING_SECTION.fields.entries()) {
    const group = field.group;
    assert.equal(typeof group, 'string', `${field.path.join('.')} 没有 group`);
    if (!seen.has(group)) {
      seen.set(group, { first: index, last: index });
      order.push(group);
    } else {
      seen.get(group).last = index;
    }
  }

  const problems = [];
  for (const [group, span] of seen) {
    const inside = SAMPLING_SECTION.fields.slice(span.first, span.last + 1);
    const others = inside.filter((f) => f.group !== group);
    if (others.length > 0) {
      problems.push(
        `「${group}」被 ${String(others.length)} 个别的组的字段隔开（例如 ${others[0].path.join('.')}）`,
      );
    }
  }

  assert.deepEqual(problems, [], `分组不连续，页面会渲染出重复的分组标题：\n  ${problems.join('\n  ')}`);
  /*
   * 分组顺序（2026-11-04 更新，2026-11-07 改名）。
   *
   * 原来最后一项是「仅存 ST（App 生成不使用）」—— 那个组里有 15 个
   * "改了没用"的字段，已按要求整块删除（用户不该看见内部架构，
   * 更不该看见假控件）。剩下的「上下文预算」只有一项，放在最后：
   * 它是"发多少历史"的上限，属于全局约束，不是单次回复的调参。
   *
   * ## 2026-11-07：第 4 项「思维链」→「回复详略」
   *
   * 这一组原来有「推理强度」+「长度」两项，合称「思维链」是通的。
   * 「推理强度」被挪进「思考」区块的「高级设置」后，这组只剩
   * `verbosity`（控制回复写多啰嗦），跟思维链没关系了 ——
   * 用户会以为它影响思考。
   *
   * ★ 为什么不是「回复长度」：那个名字**已被占用**
   *   （`openai_max_tokens` 那一组），而且两者语义不同 ——
   *   那是硬上限（超了截断），这是软档位（模型自己决定多细）。
   *   重名会让渲染出两个一模一样的标题，`problems` 那半段会直接抓到。
   *
   * ★ 顺序与组数都**没变**（仍是 5 个），只是第 4 个换了名字。
   *   这条判据的意图是"别改变用户的阅读路径"，改名不动路径 ⇒
   *   同步期望值是符合意图的，不是把判据改软。
   */
  assert.deepEqual(
    order,
    ['回复长度', '采样', '随机性', '回复详略', '上下文预算'],
    '分组顺序变了（会改变用户的阅读路径）',
  );
});
