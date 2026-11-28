/**
 * 功能
 * 两个跨模块复用的小工具：错误转人话、从卡 JSON 里取 `tcs.cardId`。
 *
 * 注意事项
 * `describeError` 优先读 `ShellError.code`（壳返回的结构化错误），
 * 没有才退回 `Error.message`。别改成只看 message —— 会丢掉错误码。
 *
 * `readCardIdFromCardJson` 不跑完整 schema 校验：它只取一个标识，
 * 而"文件坏了"这件事本身也需要知道它属于谁。
 *
 * 踩过的坑
 * 原来的名字是 `describe`，与测试框架的 `describe` 同名。搬进独立文件后
 * 改叫 `describeError`：否则在测试里 import 时两家会互相遮蔽，
 * 而报错会指向"describe is not a function"这种完全指不到原因的地方。
 */

import type { ShellError } from '../contract';

export function describeError(error: unknown): string {
  const shellError = error as Partial<ShellError>;
  if (typeof shellError?.code === 'string') {
    return `[${shellError.code}] ${shellError.message ?? ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 从卡 JSON 里取 `extensions.tcs.cardId`，取不到返回**空串**。
 *
 * 为什么返回空串而不是 null：调用方（`decideFaceDrop`）把"空串"当作
 * "没有身份"处理，与 null 同义；而顶层用 string 能少一层 ?? 判断。
 *
 * 为什么不直接用卡模型的类型：`parsePngCard` 返回的是 `unknown`
 * （它刻意不做 schema 校验，见 `shared/src/png-card.ts`），这里只是
 * 取一个**标识**，不该为此跑一遍完整校验 —— 一个损坏的卡也要能读出
 * 它属于谁，否则用户就会在"这份文件坏了"之外再收到"不知道它是谁的"。
 */
export function readCardIdFromCardJson(json: unknown): string {
  if (typeof json !== 'object' || json === null) return '';
  const extensions = (json as { extensions?: unknown }).extensions;
  if (typeof extensions !== 'object' || extensions === null) return '';
  const tcs = (extensions as { tcs?: unknown }).tcs;
  if (typeof tcs !== 'object' || tcs === null) return '';
  const cardId = (tcs as { cardId?: unknown }).cardId;
  return typeof cardId === 'string' ? cardId : '';
}

/**
 * 取第一条校验问题的话术。
 *
 * 导入失败时 `issues` 里第一条通常就是根因（后续是连锁），全塞进启动警告会变成
 * 一堵墙。完整清单在「规则」面板里能看到。
 */
export function firstIssue(issues: readonly { message: string }[]): string {
  return issues[0]?.message ?? '格式校验未通过';
}
