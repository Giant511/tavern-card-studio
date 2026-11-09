/**
 * ASR 失败原因分流（v0.1.7 / T15.6，2026-10-29 定稿）。
 *
 * ## 为什么要把"失败"分成几类
 *
 * 需求 F4 点名禁止"静默置灰"，理由是用户无法区分"我没配"和"配了但坏了"。
 * 同一个道理适用于**错误提示**：一句"配置不可用"等于把四种完全不同的处置
 * 甩给用户自己猜 ——
 *
 * | 真实原因 | 用户该做什么 |
 * |---|---|
 * | 密钥无效 / 余额不足 | 换 key 或充值 —— **换厂商没用** |
 * | 中转站不支持转写接口 | 换中转站，或改用直连 —— **换 key 没用** |
 * | 网络不通 | 换网络 / 检查代理 —— **改配置没用** |
 * | 其它 | 不知道 |
 *
 * 第一类与第二类的处置是**相反**的。混成一句话，用户会去改错的那个东西。
 */

import type { AsrProtocol } from './preset-table.js';

/** 失败归类。`kind` 供程序判断，`message` 供显示 */
export interface AsrFailure {
  kind: 'auth' | 'unsupported-endpoint' | 'network' | 'rate-limit' | 'other';
  /** 给用户看的一句话。**每一条都要能指导下一步动作** */
  message: string;
}

/**
 * 把一次失败归类。
 *
 * ## 入参为什么是 `status` + `errorKind` 两个正交的东西
 *
 * 因为"超时"根本没有 HTTP 状态码（请求没到/没回来），
 * 而"401"一定有状态码。用 `status: number | undefined` 一个字段
 * 会让调用方写 `status === undefined` 去猜，而猜错的后果是
 * 把超时报成"密钥无效"。
 *
 * ## 为什么要知道 `protocol`（决策 #338）
 *
 * 同一个状态码在不同路线上的**含义完全不同**：
 *
 * | 状态 | OpenAI 兼容路线 | Gradio 路线 |
 * |---|---|---|
 * | 404 | 这个站没有 `/audio/transcriptions` | 地址填错了（`/info` 不存在） |
 * | 502/503 | 服务端挂了 | **网关在、后端 worker 死了**（很常见：模型 OOM） |
 * | 401 | key 不对 | 一般不会出现（自建服务没有鉴权） |
 *
 * 不给 `protocol` 就只能给一段对三条路线都含糊的话，而含糊的话
 * 等于没说 —— 用户看着"接口不存在"去换中转站，实际是他把端口填错了。
 */
export function classifyAsrFailure(input: {
  /** HTTP 状态码；网络层失败时没有 */
  status?: number;
  /** 网络层错误类型（fetch 抛异常时由调用方归类） */
  errorKind?: 'timeout' | 'network';
  /** 原始错误文本，仅用于兜底展示 */
  detail?: string;
  /** 协议路线。省略时按 OpenAI 兼容路线的口径给文案 */
  protocol?: AsrProtocol;
}): AsrFailure {
  const gradio = input.protocol === 'gradio';

  /*
   * 自建服务的提示必须包含**三句**：进程侧、机器侧（防火墙/端口）、网络侧（互通）。
   *
   * 只写"检查网络"没有用 —— 用户会去检查手机有没有连 WiFi，
   * 而真实原因往往是 Windows 防火墙拦了 7860，或两台机器不在同一网段。
   *
   * "服务还在跑"是第一句，来自实测：2026-11-01 那台机器 ping 得通（27ms），
   * 但 7860 直接连接被拒 —— 机器在、网络通，**进程没了**。
   * 而浏览器里的 `fetch` 分不出"连接被拒"和"超时"（都是 Failed to fetch），
   * 所以三句必须一起给，让用户按顺序排：进程 → 端口 → 网络。
   */
  const selfHostedHint =
    '请确认那台机器上的服务还在运行、防火墙已放行端口、手机与该机器网络互通。';

  // 网络层优先：没有状态码时下面的判断全部无意义
  if (input.status === undefined) {
    if (input.errorKind === 'timeout') {
      return {
        kind: 'network',
        message: gradio
          ? `连接超时。${selfHostedHint}服务在第一次加载模型时也可能较慢，可以再试一次。`
          : '连接超时。请检查网络，或确认这个地址在当前网络下可达。',
      };
    }
    return {
      kind: 'network',
      message: gradio
        ? `连不上这个地址。${selfHostedHint}`
        : '网络请求失败。请检查网络连接，或确认这个地址可达。',
    };
  }

  const status = input.status;

  /*
   * 502 / 503 / 504 —— **只在 Gradio 路线上归到 network**。
   *
   * 实测（2026-11-01，Fun-ASR 6.2.0）：模型加载或推理把后端 worker 压死时，
   * 前面那层仍然返回 502 —— 页面地址是通的，只是没人应答。
   * 此时对用户来说这就是"服务不可达"，处置是"去看那台机器"（重启服务、
   * 换更小的模型），**不是**"改 key"或"换厂商"。
   *
   * OpenAI 兼容路线不这么归：那边的 502 多半是中转站自己的上游挂了，
   * 文案沿用原来的"其它"更准确（换中转站才有效）。
   */
  if (gradio && (status === 502 || status === 503 || status === 504)) {
    return {
      kind: 'network',
      message:
        '服务没有正常响应（网关报错）。这通常是那台机器上的服务进程卡住或退出了 —— ' +
        '去看一下它的窗口/日志，重启服务再试。',
    };
  }

  /*
   * 401 / 403 —— 密钥或余额。
   *
   * 为什么把 403 归到这里而不是"无权限"：语音接口的 403 在实践中几乎
   * 全是"这个 key 没有该模型的权限"或"账户欠费"，两者对用户的动作一致
   * （换 key / 充值），分开报只会增加困惑。
   */
  if (status === 401 || status === 403) {
    return { kind: 'auth', message: '密钥无效或余额不足。' };
  }

  /*
   * 404 / 405 —— 接口不存在。
   *
   * 定稿给的文案是面向**中转站**的（"请更换中转站或使用直连厂商"），
   * 因为这是最常见的情形：中转站只转 chat 不转 `/audio/transcriptions`。
   *
   * ⚠️ 一个已注意到但**没有擅自改文案**的边界：直连厂商（Groq / OpenAI）
   * 如果 base_url 少了 `/v1` 也会 404，此时"更换中转站"这句话是错的指引。
   * 定稿文案已拍板，所以这里原样使用；要补直连场景的提示需要再定一次文案。
   *
   * Gradio 路线 404 的含义完全不同：**地址填错了**。自建服务的端口是
   * 用户随手起的（7860 / 7861 / 8000 都可能），填错一位就是 404。
   * 所以这里必须换成指向地址的文案，否则他会去怀疑"版本不对"。
   */
  if (status === 404 || status === 405) {
    if (gradio) {
      return {
        kind: 'unsupported-endpoint',
        message:
          '这个地址上找不到语音接口。请确认端口填对了（就是浏览器打开那个页面的地址），' +
          '且服务是 Gradio 4 以上版本。',
      };
    }
    return {
      kind: 'unsupported-endpoint',
      message:
        '该中转站不支持语音转写接口（/audio/transcriptions），' +
        '请更换中转站或使用直连厂商。',
    };
  }

  // 429 —— 限流。单独一类，因为处置是"等一会儿重试"，不是改配置
  if (status === 429) {
    return { kind: 'rate-limit', message: '请求太频繁或额度已用尽，请稍后重试。' };
  }

  const detail = typeof input.detail === 'string' && input.detail.trim() !== ''
    ? `（服务端返回 ${String(status)}：${input.detail.trim().slice(0, 120)}）`
    : `（服务端返回 ${String(status)}）`;
  return { kind: 'other', message: `语音服务返回了未能识别的问题${detail}。` };
}

/**
 * 转写结果为空时的判定。
 *
 * ## 为什么"空文本"要算失败
 *
 * 定稿要求「转写返回非空文本才允许启用」。空文本的真实成因有三种：
 * 音频里没人声、格式不被支持（服务端静默返回空）、密钥没问题但模型不对。
 * 三种都不能算"配置可用" —— 否则用户会在真正要说话的时候才发现它不工作。
 *
 * 这与"请求失败"是**两种不同的失败**：请求成功了但内容不可用。
 * 所以单独一个函数，返回的 kind 也不同。
 */
export function classifyEmptyTranscript(text: string): AsrFailure | null {
  if (text.trim() !== '') return null;
  return {
    kind: 'other',
    message: '测试音频没有转出任何文字。请确认服务正常，或检查模型名是否填对。',
  };
}
