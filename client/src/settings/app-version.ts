/**
 * 应用版本（**唯一实现**）。
 *
 * ## 为什么从 package.json 读，不写常量
 *
 * 硬编码的版本号一定会漂：诊断日志里版本错了等于白导，设置页里版本错了会让
 * 用户以为装错了包（v0.1.5 的真实事故：包名 v0.1.5、服务端内部 v0.1.3、
 * 安装说明页 0.1.2）。`client/package.json` 的 version 由 Vite 在构建期内联进来，
 * 与 MSI 的 ProductVersion 同源（`check:version` 断言两者与根 package.json 一致）。
 *
 * 为什么不用 `<html data-version>`：那要在构建期改写 index.html，而内联脚本会被
 * CSP 的 `script-src 'self'` 拦掉（本项目刻意不开 unsafe-inline）。
 *
 * 为什么抽成模块而不是各留一份：设置页要显示它、诊断导出要写它、测试要断言它。
 * 三处各写一遍的话，某天只会有一处被改对（本项目在"同一件事写两遍"上踩过多次）。
 */

import clientPackage from '../../package.json';

/** 形如 `0.1.6`；读不到时返回 `未知`（宁可显示未知，也不猜一个数） */
export function appVersion(): string {
  const version = (clientPackage as { version?: unknown }).version;
  return typeof version === 'string' && version !== '' ? version : '未知';
}
