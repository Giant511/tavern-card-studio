/**
 * 极简路由器：`/api/cards/:id/versions/:rev` 形式的段匹配。
 *
 * 不引第三方框架（Express 等）的原因：
 *   · 服务端要被塞进 MSI 离线安装，依赖越少越好；
 *   · 需要精确控制原始字节的读取（不能被 body-parser 提前 JSON.parse 掉）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  /** 原始请求体（仅在需要时读取） */
  body: Buffer;
}

export type Handler = (ctx: RouteContext) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export interface MatchResult {
  handler: Handler;
  params: Record<string, string>;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter((segment) => segment !== ''),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  put(pattern: string, handler: Handler): this {
    return this.add('PUT', pattern, handler);
  }

  /** PATCH：用于"只改部分字段"的资源（仓库改名、令牌改权限范围） */
  patch(pattern: string, handler: Handler): this {
    return this.add('PATCH', pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  match(method: string, pathname: string): MatchResult | null {
    const parts = pathname.split('/').filter((segment) => segment !== '');
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const expected = route.segments[index]!;
        const actual = parts[index]!;
        if (expected.startsWith(':')) {
          params[expected.slice(1)] = decodeURIComponent(actual);
        } else if (expected !== actual) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  /** 允许的方法集合（405 响应用） */
  allowedMethods(pathname: string): string[] {
    const parts = pathname.split('/').filter((segment) => segment !== '');
    const methods = new Set<string>();
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      let ok = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const expected = route.segments[index]!;
        if (!expected.startsWith(':') && expected !== parts[index]) {
          ok = false;
          break;
        }
      }
      if (ok) methods.add(route.method);
    }
    return [...methods];
  }

  /**
   * 全部已注册的方法（CORS 预检的兜底集合）。
   *
   * 存在的理由见 `app.ts` 的 OPTIONS 分支：允许方法**必须从路由表派生**。
   * 手写字符串那一版漏了 PATCH，于是壳里（`tauri://localhost` → 跨域）
   * 改名必然失败，而浏览器同源测试全绿 —— 见决策 #159。
   */
  allMethods(): string[] {
    return [...new Set(this.routes.map((route) => route.method))];
  }
}
