/**
 * 证书不受信任的确认框（2026-11-04，T15.2 阶段 A）。
 *
 * ## 为什么需要它
 *
 * 用户的需求写的是「https:// 不提示」—— 那是**基于"https 就是安全的"**
 * 这个前提。但有一类 https 是不安全的：**自签证书**。
 *
 * 自签证书意味着"这个加密通道对端是谁，没人担保"。浏览器/系统会直接拒绝，
 * 而拒绝的表现是 `SSLHandshakeException`，到界面上就是"连不上服务端"。
 *
 * 真机实测时正好撞上：测试服务端 `10.9.0.2:8443` 就是自签证书。
 *
 * ## 所以判定不能按协议，要按"证书到底行不行"
 *
 * ```text
 *   https + 受信任证书   → 不提示（绝大多数情况）
 *   https + 自签/错配    → 提示（这是真风险）
 *   http                 → 提示（已有明文风险框，逻辑不变）
 * ```
 *
 * 这样既满足"https 不打扰"，又覆盖了真实场景。
 *
 * ## 为什么这个框要在 body 上而不是页面里
 *
 * 请求是从外壳（`shell.ts`）发起的，而外壳拿不到页面内部的 DOM 引用。
 * 挂到 `document.body` 才能"任何时候、任何页面上"弹出来。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';

export const CERT_RISK_TITLE = '这个服务器的证书不受信任';

export const CERT_RISK_BODY =
  '连上了，但证书验证没过。这意味着无法确认对面真的是这台服务器 —— ' +
  '中间的任何人都有可能冒充它，看到你的账号、令牌和卡片内容。' +
  '如果这是你自己部署的服务且用了自签证书，可以继续。';

/**
 * 弹一个证书确认框，返回用户是否选择继续。
 *
 * ## 为什么返回 Promise 而不是回调
 *
 * 调用点在 `catch` 里，后面要"确认了就重试"——用 Promise 能写成
 *
 * ```ts
 * if (await askCertTrust(origin)) { ...重试... }
 * ```
 *
 * 而回调要拆成两段，重试逻辑会被塞进回调里，很难读。
 */
export function askCertTrust(doc: DocLike, origin: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const overlay = el(doc, 'div', 'nb-exit-overlay');
    overlay.setAttribute('data-role', 'repo-cert-risk-dialog');

    const card = el(doc, 'div', 'nb-exit-card');
    const title = el(doc, 'p', 'nb-exit-title');
    title.textContent = CERT_RISK_TITLE;

    const body = el(doc, 'p', 'nb-exit-subtitle');
    body.textContent = CERT_RISK_BODY;

    const target = el(doc, 'p', 'nb-note');
    target.setAttribute('data-role', 'repo-cert-risk-target');
    target.textContent = origin;

    const actions = el(doc, 'div', 'nb-exit-actions');

    const proceed = el(doc, 'button', 'nb-exit-leave');
    proceed.setAttribute('type', 'button');
    proceed.setAttribute('data-role', 'repo-cert-risk-continue');
    proceed.textContent = '我了解风险，继续';

    const cancel = el(doc, 'button', 'nb-exit-stay');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute('data-role', 'repo-cert-risk-cancel');
    cancel.textContent = '算了';

    const finish = (value: boolean): void => {
      overlay.remove();
      resolve(value);
    };

    proceed.addEventListener('click', () => finish(true));
    cancel.addEventListener('click', () => finish(false));
    overlay.addEventListener('click', (event) => {
      if ((event as { target?: unknown }).target === overlay) finish(false);
    });

    actions.append(proceed, cancel);
    card.append(title, body, target, actions);
    overlay.append(card);

    /* 挂到 body：外壳发起请求时任何页面都能弹出来 */
    const host = (doc as unknown as { body?: ElLike }).body;
    if (host !== undefined && host !== null) {
      host.append(overlay);
    }
  });
}

/**
 * 这个错误是不是"证书不受信任"。
 *
 * ## 为什么要按文案匹配
 *
 * 原生侧（`StBridge.httpRequest`）把 `SSLException` 转成了一句话，
 * 而错误穿过 JS 边界后只剩 message —— 没有结构化的错误码可用。
 *
 * 所以匹配几个关键词。宽一点没关系：误判的后果只是"多弹一次确认框"，
 * 而漏判的后果是"用户看到连不上，却不知道可以继续"。
 */
export function isCertificateError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('证书') ||
    text.includes('certificate') ||
    text.includes('ssl') ||
    text.includes('tls')
  );
}
