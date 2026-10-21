/**
 * 服务宿主配置的一致性测试。
 *
 * 背景：Windows 服务由 WinSW 托管（node.exe 自己当不了服务，见 docs/18）。
 * 现在有两份 XML —— MSI 用 installer/ServiceHost.xml，绿色包用
 * scripts/service-host-template.mjs 生成的版本。两者**只应在数据目录上不同**。
 *
 * 这类"两份配置靠人同步"的东西必然会漂移：改了 MSI 那份忘了绿色包，
 * 结果同一份服务在两种部署下重启策略/停止超时不一样，排障时会被误判成产品缺陷。
 * 所以用测试钉住。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { buildBundleServiceHostXml, sharedServiceHostFields } from '../scripts/service-host-template.mjs';

const REPO = join(import.meta.dirname, '..');
const MSI_XML = readFileSync(join(REPO, 'installer', 'ServiceHost.xml'), 'utf8');
const BUNDLE_XML = buildBundleServiceHostXml();

/**
 * 最小 XML 良构性检查（不引第三方依赖）。
 *
 * 为什么需要它：之前只用正则比对"关键字段存不存在"，结果漏掉了一类致命错误 ——
 * installer/ServiceHost.xml 的注释里有一行用连字符做的分隔线。XML 规范禁止注释内
 * 出现两个连续连字符，于是整份文件非法，WinSW 报
 *   "The configuration file cound not be loaded. XML comment cannot contain a double hyphen"
 * 并在写任何日志之前退出，SCM 等到 7009 超时，MSI 以 1920 回滚。
 *
 * 覆盖范围（够用即可，不做完整 XML 解析）：
 *   1. XML 声明存在
 *   2. 注释成对闭合，且注释内不含连续连字符、不以单个连字符结尾
 *   3. 标签成对（自闭合算已闭合）
 *
 * @returns {string[]} 问题列表，空数组表示良构
 */
function checkWellFormedXml(xml) {
  const problems = [];

  const opens = (xml.match(/<!--/g) ?? []).length;
  const closes = (xml.match(/-->/g) ?? []).length;
  if (opens !== closes) problems.push(`注释未闭合（开 ${opens} / 闭 ${closes}）`);

  for (const match of xml.matchAll(/<!--([\s\S]*?)-->/g)) {
    const body = match[1];
    if (body.includes('--')) problems.push('注释内含连续连字符（XML 规范禁止，WinSW 会拒绝加载）');
    if (body.endsWith('-')) problems.push('注释以单个连字符结尾（XML 规范禁止）');
  }

  if (!/^\s*<\?xml\s/.test(xml)) problems.push('缺少 XML 声明');

  // 标签配对：先剥注释，避免注释里的示例标签干扰
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, '');
  const tagRe = /<(\/?)([A-Za-z][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const stack = [];
  for (const tag of stripped.matchAll(tagRe)) {
    const [, closing, name, , selfClosing] = tag;
    if (closing) {
      const top = stack.pop();
      if (top !== name) problems.push(`标签不匹配：期望 </${top}>，实际 </${name}>`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  if (stack.length > 0) problems.push(`未闭合标签：${stack.join(', ')}`);

  return problems;
}

test('良构性检查器本身有效：能抓到用连字符做分隔线的注释', () => {
  // 这条自测很关键 —— 一个从不失败的检查等于没有检查。
  // 这段样本故意复刻 2026-10-21 导致服务起不来的真实写法。
  const broken = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<service>',
    '<!--',
    '  Why this exists',
    '  --------------------',
    '-->',
    '  <id>x</id>',
    '</service>',
  ].join('\n');
  const problems = checkWellFormedXml(broken);
  assert.ok(problems.length > 0, '应当判定为非法 XML');
  assert.ok(
    problems.some((p) => p.includes('连续连字符')),
    `应指出连字符问题，实际：${problems.join('; ')}`,
  );
});

test('MSI 用的配置是良构 XML（WinSW 能加载的前提）', () => {
  const problems = checkWellFormedXml(MSI_XML);
  assert.deepEqual(problems, [], `installer/ServiceHost.xml 不是良构 XML：\n  ${problems.join('\n  ')}`);
});

test('绿色包用的配置也是良构 XML', () => {
  const problems = checkWellFormedXml(BUNDLE_XML);
  assert.deepEqual(problems, [], `绿色包配置不是良构 XML：\n  ${problems.join('\n  ')}`);
});

test('两份配置的顶层元素都是 <service> 且含必需的运行字段', () => {
  for (const [name, xml] of [
    ['installer/ServiceHost.xml', MSI_XML],
    ['绿色包配置', BUNDLE_XML],
  ]) {
    assert.match(xml, /<service>/, `${name} 顶层元素应为 <service>`);
    for (const required of ['<id>', '<executable>', '<arguments>', '<logpath>', '<startmode>']) {
      assert.ok(xml.includes(required), `${name} 缺少必需元素 ${required}`);
    }
  }
});

test('两份服务配置都声明了同一个服务标识', () => {
  const fields = sharedServiceHostFields().filter((f) => f.label === 'service id');
  for (const { label, pattern } of fields) {
    assert.match(MSI_XML, pattern, `installer/ServiceHost.xml 缺少或不匹配：${label}`);
    assert.match(BUNDLE_XML, pattern, `绿色包配置缺少或不匹配：${label}`);
  }
});

test('运行语义字段在两份配置中完全一致', () => {
  const mismatches = [];
  for (const { label, pattern } of sharedServiceHostFields()) {
    const inMsi = pattern.test(MSI_XML);
    const inBundle = pattern.test(BUNDLE_XML);
    if (!inMsi || !inBundle) {
      mismatches.push(`${label}（MSI=${inMsi} 绿色包=${inBundle}）`);
    }
  }
  assert.deepEqual(mismatches, [], `以下字段不一致，请同步两份配置：\n  ${mismatches.join('\n  ')}`);
});

test('数据目录有意不同：MSI 用 ProgramData，绿色包用 %BASE%\\data', () => {
  // 这是唯一允许（且必须）不同的地方。若有人"顺手统一"，两个部署会互相覆盖数据库。
  assert.match(
    MSI_XML,
    /--config\s+"C:\\ProgramData\\TavernCardStudio\\config\.json"/,
    'MSI 配置的 --config 应指向 ProgramData',
  );
  assert.match(
    BUNDLE_XML,
    /--config\s+"%BASE%\\data\\config\.json"/,
    '绿色包配置的 --config 应指向 %BASE%\\data',
  );

  assert.match(MSI_XML, /<logpath>C:\\ProgramData\\TavernCardStudio\\logs<\/logpath>/);
  assert.match(BUNDLE_XML, /<logpath>%BASE%\\data\\logs<\/logpath>/);
});

test('两份配置都不能出现会编译失败的写法', () => {
  // 先剥掉 XML 注释再判断：注释里出现 <delayedAutoStart> 是在解释"为什么不能用它"，
  // 不是真的用了。不剥就会出现假阳性（本测试第一版就栽在这里）。
  const stripComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');

  for (const [name, raw] of [
    ['installer/ServiceHost.xml', MSI_XML],
    ['绿色包配置', BUNDLE_XML],
  ]) {
    const xml = stripComments(raw);
    // WinSW v2 不认 <delayedAutoStart> 独立元素（它是 v2.9+ 的 startmode 属性），
    // 未知元素会导致宿主直接退出，服务表现为"启动了但立刻停"。
    assert.doesNotMatch(xml, /<delayedAutoStart>/, `${name} 混入了 WinSW v2 不支持的 <delayedAutoStart>`);
    // 必须自己声明 executable，否则宿主不知道要拉起什么。
    assert.match(xml, /<executable>/, `${name} 缺少 <executable>`);
    // 参数里不能再用 node.exe 当宿主（这是被修掉的那个缺陷）
    assert.match(xml, /node\.exe/, `${name} 应通过 <executable> 调用 node.exe`);
  }
});

test('绿色包配置里不写死机器上的绝对路径', () => {
  // 出现 D:\ 或 C:\Users 之类，说明有人调试时把临时路径带进了模板，
  // 打出来的绿色包换台机器就起不来。
  assert.doesNotMatch(BUNDLE_XML, /[A-Z]:\\Users\\/i, '不要写死用户目录');
  assert.doesNotMatch(BUNDLE_XML, /"[A-Z]:\\Claw\\/i, '不要写死开发机路径');
});
