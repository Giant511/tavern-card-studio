/**
 * 手势方向（2026-11-02 用户明确要求）+ 秘钥掩码。
 *
 * ## 用户原话（这一轮的核心诉求）
 *
 * > 我想实现的是QQ那样，按住按钮并且**左滑到左边的按钮**识别为内心、动作，
 * > 按住按钮**右滑到一个按钮**为消息，按住按钮**上滑一段距离**取消
 *
 * 而当时的实现是：左右滑切档（对）、**下滑**取消（错）、
 * 提示文字写"上滑切换模式，下滑取消"（**两个方向都错**）。
 *
 * 用户看到的是"提示说上滑切模式，我上滑了却没变"，自然会认为没按他说的改。
 *
 * ## 这组判据守什么
 *
 * 1. 上滑才取消（不是下滑）
 * 2. 纵向必须占优（否则左滑时的自然上抬会被误判成取消 —— 那是"想发内心却一句没发出去"）
 * 3. 秘钥掩码的三种状态与"掩码绝不入值"
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CANCEL_SLIDE_PX,
  KEY_MASK,
  MODE_SLIDE_PX,
  initialKeyState,
  isCancelSlide,
  keyFieldPlaceholder,
  keyFieldType,
  keyFieldValue,
  keyStateOnBlur,
  keyStateOnFocus,
  keyToSave,
  modeByHorizontalSlide,
} from '@tcs/shared';

/* ═══════════════════════════════════════════════════════════
   一、上滑取消
   ═══════════════════════════════════════════════════════════ */

const START = { x: 200, y: 600 };

test('★★★ 上滑超过阈值 = 取消（用户要的方向）', () => {
  assert.equal(
    isCancelSlide(START, { x: 200, y: 600 - CANCEL_SLIDE_PX }),
    true,
    '正好上滑一个阈值就该算取消（边界要含等号）',
  );
  assert.equal(isCancelSlide(START, { x: 200, y: 600 - CANCEL_SLIDE_PX - 20 }), true);
});

test('★★★ 下滑再多也不算取消（旧方向必须彻底失效）', () => {
  /*
   * 这条是**反向**判据：如果谁把方向改回去，它会立刻红。
   * 用户握手机按住底部按钮时，往下滑会滑出屏幕/压到导航栏 ——
   * 那条路他从来用不上，也是他说"没按我说的改"的原因之一。
   */
  assert.equal(isCancelSlide(START, { x: 200, y: 600 + 200 }), false, '下滑不是取消');
  assert.equal(isCancelSlide(START, { x: 200, y: 600 + CANCEL_SLIDE_PX * 3 }), false);
});

test('★★ 上抬不够阈值不取消（拇指自然抖动）', () => {
  assert.equal(isCancelSlide(START, { x: 200, y: 600 - 20 }), false);
  assert.equal(isCancelSlide(START, { x: 200, y: 600 - CANCEL_SLIDE_PX + 1 }), false);
});

test('★★★ 横向占优时不算取消（左滑时拇指会自然上抬）', () => {
  /*
   * 这是"纵向占优"那条规则的存在理由：
   * 用户左滑选「内心/动作」，拇指走弧线，天然带一点上抬。
   * 只看纵向的话，一次想发内心独白的操作会被判成取消 ——
   * 结果一句话都没发出去，而且界面上没有任何东西能解释为什么。
   */
  assert.equal(
    isCancelSlide(START, { x: 200 - 80, y: 600 - 65 }),
    false,
    '左滑 80 同时上抬 65：横向占优，不是取消',
  );
  assert.equal(
    isCancelSlide(START, { x: 200 + 80, y: 600 - 65 }),
    false,
    '右滑 80 同时上抬 65：同样不是取消',
  );
});

test('★★ 纯上滑（无横向位移）一定成立', () => {
  assert.equal(isCancelSlide(START, { x: 200, y: 600 - 100 }), true);
});

test('★★ 左右滑选档：方向与视觉位置一致', () => {
  /*
   * 用户要「左滑到左边的按钮识别为内心/动作，右滑到一个按钮为消息」。
   * 判定是横向位移，而界面上的胶囊顺序也必须是 内心/动作 | 说话 | 消息
   * （见 voice-panel 的 CHIP_DISPLAY_ORDER），否则手指底下和结果是反的。
   */
  assert.equal(modeByHorizontalSlide(START, { x: 200 - MODE_SLIDE_PX, y: 600 }), 'inner');
  assert.equal(modeByHorizontalSlide(START, { x: 200 + MODE_SLIDE_PX, y: 600 }), 'message');
  assert.equal(modeByHorizontalSlide(START, { x: 200 + 10, y: 600 }), 'speak');
  assert.equal(modeByHorizontalSlide(START, { x: 200, y: 600 - 200 }), 'speak', '纯上滑不改档位（那条路是取消）');
});

/* ═══════════════════════════════════════════════════════════
   二、秘钥掩码
   ═══════════════════════════════════════════════════════════ */

test('★★★ 配过就显示掩码，没配过是空的', () => {
  assert.equal(initialKeyState(true), 'masked');
  assert.equal(initialKeyState(false), 'empty');
  assert.equal(keyFieldValue('masked'), KEY_MASK);
  assert.equal(keyFieldValue('empty'), '');
  assert.equal(keyFieldValue('editing'), '');
});

test('★★★ 掩码要用 text 才看得见是星号', () => {
  /*
   * 用 `password` 的话浏览器会把圆点再掩一层，用户看到的是若干个点，
   * 分不清"这是占位"还是"我真有一个 12 位的 key"—— 那就没达到
   * "让他知道自己配过"的目的。
   */
  assert.equal(keyFieldType('masked'), 'text');
  assert.equal(keyFieldType('editing'), 'password', '真要输入时不能明文显示');
  assert.equal(keyFieldType('empty'), 'password');
});

test('★★★ 掩码串绝不能被当成 key 保存', () => {
  /*
   * 这是本轮唯一会造成**数据损坏**的分支：把 `'••••••••••••'` 写进
   * SillyTavern 会把用户真实 key 覆盖成一串圆点 ⇒ 之后所有请求 401，
   * 而错误只显示"鉴权失败"，没人能想到原因。
   */
  assert.equal(keyToSave(KEY_MASK), null, '掩码必须被拦住');
  assert.equal(keyToSave(''), null, '空 = 不改');
  assert.equal(keyToSave('   '), null, '空白 = 不改');
  assert.equal(keyToSave('  sk-abc  '), 'sk-abc', '真值要去掉首尾空白');
});

test('★★ 聚焦掩码框会清空并切到编辑态', () => {
  assert.equal(keyStateOnFocus('masked'), 'editing');
  assert.equal(keyStateOnFocus('empty'), 'empty');
  assert.equal(keyStateOnFocus('editing'), 'editing');
});

test('★★ 失焦时没输入就退回原状（不许凭空变成"已配置"）', () => {
  /*
   * 从没配过 key 的用户点一下框再点走，界面不能变成"已配置"——
   * 那是明确的撒谎，而且会让他以为能用了。
   */
  assert.equal(keyStateOnBlur('editing', '', false), 'empty', '没配过 + 没输入 → 空');
  assert.equal(keyStateOnBlur('editing', '', true), 'masked', '配过 + 没输入 → 回到掩码');
  assert.equal(keyStateOnBlur('editing', 'sk-new', true), 'editing', '输入了内容就保持编辑态（保存要读它）');
});

test('★ 编辑态的提示语要说清"留空 = 不改"', () => {
  assert.match(keyFieldPlaceholder('editing'), /留空/, '不说清用户会以为清空就是删掉 key');
  assert.ok(!keyFieldPlaceholder('masked').includes('留空'), '掩码态不该提留空（他已经配好了）');
});
