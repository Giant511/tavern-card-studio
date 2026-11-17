/**
 * 原生 HTTP 通道（桌面壳）——把 Tauri 命令包装成 `HttpTransport` 并注册。
 *
 * ## 为什么单独一个文件
 *
 * `net/http-transport.ts` 是**纯逻辑**（Node 里跑单测），不能 import 契约层
 * （契约层依赖 `@tauri-apps/api`，Node 的类型剥离解析不了它的 `.js` 后缀
 * import）。而这个文件必须 import 契约层才能调 `server_http_request`。
 *
 * 所以拆开：纯层放接口，壳侧放实现，由本文件在加载时完成注册。
 *
 * ## 注册这件事**必须有人做**
 *
 * 桌面入口 `editor/app.ts` 顶部 import 本文件（副作用注册）。
 * 忘了的话 `defaultTransport()` 在壳里会**抛错**而不是退回 fetch ——
 * 见那边的注释（静默降级比报错危险）。
 */

import { serverHttpRequest } from '../contract/shell.ts';
import { ShellError } from '../contract/errors.ts';
import type { ServerHttpErrorKind } from '../contract/types.ts';
import {
  registerNativeTransport,
  type HttpOutcome,
  type HttpTransport,
} from './http-transport.ts';

/**
 * 从 `ShellError` 的 `details.kind` 取分类。
 *
 * 取不到就当 `'other'` —— **不用文案猜**。文案会随版本变，
 * 而 `cert` 如果猜错就会给出一个"确认后仍然连不上"的假出口。
 */
function kindOf(error: unknown): ServerHttpErrorKind {
  if (error instanceof ShellError && error.code === 'NET_REQUEST_FAILED') {
    const kind = error.details['kind'];
    if (kind === 'cert' || kind === 'connect' || kind === 'timeout' || kind === 'other') {
      return kind;
    }
  }
  return 'other';
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 走原生命令发一次请求 */
export function createNativeTransport(): HttpTransport {
  return async (spec) => {
    try {
      const response = await serverHttpRequest({
        url: spec.url,
        method: spec.method ?? 'GET',
        headers: Object.entries(spec.headers ?? {}),
        ...(spec.body === undefined ? {} : { body: spec.body }),
        timeoutMs: spec.timeoutMs,
        ...(spec.allowInvalidCert === true ? { allowInvalidCert: true } : {}),
      });
      const outcome: HttpOutcome = {
        status: response.status,
        contentType: response.contentType,
        text: response.bodyText,
        base64: response.bodyBase64,
        elapsedMs: response.elapsedMs,
        errorKind: null,
        error: null,
      };
      return outcome;
    } catch (error) {
      return {
        status: null,
        contentType: '',
        text: null,
        base64: null,
        elapsedMs: 0,
        errorKind: kindOf(error),
        error: messageOf(error),
      };
    }
  };
}

/*
 * 模块加载即注册。
 *
 * 用副作用注册而不是"调用方显式调一次"：漏调一次就少一层保护，
 * 而这类漏调在浏览器里测不出来（那边走 fetch，行为正常）。
 */
registerNativeTransport(createNativeTransport);
