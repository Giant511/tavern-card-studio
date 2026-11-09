/**
 * 开屏视图（v0.1.7 / 第九批）。
 *
 * ## 它解决的具体问题
 *
 * 用户反馈原话：
 *
 * > 如果是冷启动，那为什么不在启动的时候放一个开屏跑进度条的动画
 * > （符合APP的UI风格），配字就写正在加载世界中，等ST服务稳定
 * > 然后再尝试读取配置（依然有重试机制）进入聊天页
 *
 * 冷启动时引擎要 7–57 秒才起。那段时间原来的界面是**空聊天页**，
 * 看起来像"记录丢了"。开屏把这段等待显式化，并且给了进度反馈。
 *
 * ## 视觉上为什么长这样
 *
 * 全部用 `--nb-*` 变量（`nebula-tokens.css` 是单一真相），
 * 和 `chat.css` 里其余部分同一套。**一个裸色值都没有** ——
 * 写死颜色就会在换主题时变成一块突兀的色块。
 *
 * 进度条用 `--nb-grad-primary`（主渐变），与按钮同一套视觉语言。
 *
 * ## 为什么不放 logo
 *
 * 项目里没有品牌图形（`card-face-default.png` 是卡片底图，不是 logo）。
 * 拿一张卡面当开屏 logo 会让人以为"这是那张卡"。
 * 所以用**文字 + 进度条**，不编一个不存在的品牌资产。
 */

import type { DocLike, ElLike } from '../chat/chat-view.ts';
import { describeBootPhase, phasePercent, type BootPhase } from '@tcs/shared';

/** `doc.createElement` 的最小助手（与 `chat-view.ts` 里同一个形状） */
function el(doc: DocLike, tag: string, className: string): ElLike {
  const node = doc.createElement(tag);
  node.className = className;
  return node;
}

export class BootSplash {
  private readonly doc: DocLike;
  private readonly root: ElLike;
  private readonly fill: ElLike;
  private readonly label: ElLike;
  private readonly hint: ElLike;
  /** 当前显示的百分比（用于只往前进、不回退） */
  private shown = 0;

  constructor(doc: DocLike) {
    this.doc = doc;

    const root = el(doc, 'div', 'nb-splash');
    root.setAttribute('data-role', 'boot-splash');

    /*
     * 三颗缓慢呼吸的光点。
     *
     * 不画旋转的 spinner：进度条已经在动，再加一个转圈会让画面有两个
     * 互不同步的运动源，看起来像两侧各转各的。
     */
    const orbit = el(doc, 'div', 'nb-splash-orbit');
    for (let i = 0; i < 3; i += 1) {
      orbit.append(el(doc, 'span', 'nb-splash-dot'));
    }
    root.append(orbit);

    const title = el(doc, 'p', 'nb-splash-title');
    title.textContent = '正在加载世界';
    root.append(title);

    const track = el(doc, 'div', 'nb-splash-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', '0');
    const fill = el(doc, 'div', 'nb-splash-fill');
    track.append(fill);
    root.append(track);

    const label = el(doc, 'p', 'nb-splash-label');
    label.setAttribute('data-role', 'boot-phase');
    root.append(label);

    /*
     * 提示行单独一个元素，初始为空但**保留高度**（`min-height` 在 CSS 里）——
     * 否则提示出现时会把上面整块顶上去，看起来像跳了一下。
     */
    const hint = el(doc, 'p', 'nb-splash-hint');
    hint.setAttribute('data-role', 'boot-hint');
    root.append(hint);

    this.root = root;
    this.fill = fill;
    this.label = label;
    this.hint = hint;

    this.setPhase('starting');
  }

  /** 挂到容器上 */
  mount(container: ElLike): void {
    container.append(this.root);
  }

  /** 更新阶段（文案 + 进度） */
  setPhase(phase: BootPhase): void {
    const target = phasePercent(phase);

    /*
     * 进度**只进不退**（失败除外）。
     *
     * 阶段是离散的，可能在"解包 25%"与"启动 55%"之间来回采样
     * （引擎的 `unpacked` 标记写入有延迟）。让它回退会让进度条抖动。
     */
    if (phase === 'failed') {
      this.shown = 0;
    } else if (target > this.shown) {
      this.shown = target;
    }

    /*
     * 用 `transform: scaleX()` 表达进度，**不用 width**。
     *
     * `transition: width` 每帧触发布局（layout），被走查 6 禁止；
     * transform 走合成层。0–100 映射到 0–1。
     *
     * CSS 里 `width` 恒为 100%、`transform-origin: left` ——
     * 所以 scaleX(0.4) 看起来就是"填了 40%"。
     */
    this.fill.style.setProperty('transform', `scaleX(${String(this.shown / 100)})`);
    const track = this.root.children[1]?.children[0];
    if (track !== undefined) {
      track.setAttribute('aria-valuenow', String(this.shown));
    }

    this.label.textContent = describeBootPhase(phase);
    /* 失败时把进度条染成警示色，避免"满了但没进去"的误解 */
    this.root.setAttribute('data-state', phase);
  }

  /** 一行附加提示（超时 / 引擎报错时用） */
  setHint(text: string): void {
    this.hint.textContent = text;
  }

  /** 退出动画后移除自己 */
  dismiss(): void {
    this.root.setAttribute('data-leaving', 'true');
    /*
     * 等过渡结束再摘掉。
     *
     * 不用 `transitionend`：那要求元素真的产生了过渡（如果浏览器
     * 把动画禁用 / 元素已被摘走，事件永远不来，节点就留在 DOM 里）。
     * 固定延时更笨但**一定发生**。
     */
    setTimeout(() => {
      this.root.remove();
    }, 260);
  }
}
