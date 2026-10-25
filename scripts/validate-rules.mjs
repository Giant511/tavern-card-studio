#!/usr/bin/env node
/**
 * 规则文件校验器（T7.3 的早期版本，阶段 0 起即可用）
 *
 * 用法：npm run validate:rules
 *
 * 校验内容：
 *  1. JSON 语法可解析；
 *  2. 通过 JSON Schema（rules/schema/*.schema.json）结构校验；
 *  3. 语义校验：
 *     - id 唯一（跨文件）
 *     - extends 指向的规则存在且不成环
 *     - 高亮规则引用的 scope 必须已定义
 *     - 规则引用的占位符 token 必须在 placeholders 中声明
 *     - 预设格式的 blockOrder 必须覆盖六个板块、标题别名互不冲突
 *     - 所有正则可编译
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 可以用 --rules-dir 指向别处（比如服务端包内的 rules），
// 用于验证「打进包里的那份规则同样合法」—— 包内的文件和仓库里的是两份拷贝，
// 只校验仓库那份等于没验装到用户机器上的那份。
const rulesDirArg = process.argv.find((arg) => arg.startsWith('--rules-dir='));
const RULES_DIR = rulesDirArg ? rulesDirArg.slice('--rules-dir='.length) : join(ROOT, 'rules');

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

const errors = [];
const warnings = [];

function fail(file, message) {
  errors.push(`${relative(ROOT, file)}: ${message}`);
}

function warn(file, message) {
  warnings.push(`${relative(ROOT, file)}: ${message}`);
}

async function readJson(file) {
  const text = await readFile(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(file, `JSON 解析失败 — ${error.message}`);
    return null;
  }
}

async function listJson(dir) {
  const names = await readdir(dir);
  return names.filter((name) => name.endsWith('.json')).map((name) => join(dir, name));
}

function compileRegex(file, ruleId, pattern, flags) {
  try {
    // 校验阶段去掉 g / y，避免 lastIndex 状态影响重复测试
    const cleanFlags = (flags ?? '').replace(/[gy]/g, '');
    return new RegExp(pattern, cleanFlags);
  } catch (error) {
    fail(file, `规则 "${ruleId}" 的正则无法编译：${error.message}`);
    return null;
  }
}

// ---------- 平台规则 ----------
async function validatePlatformRules() {
  const schema = await readJson(join(RULES_DIR, 'schema', 'platform-rule.schema.json'));
  const validate = ajv.compile(schema);

  const dir = join(RULES_DIR, 'platforms');
  const files = await listJson(dir);
  const byId = new Map();

  for (const file of files) {
    const data = await readJson(file);
    if (!data) continue;

    if (!validate(data)) {
      for (const error of validate.errors ?? []) {
        fail(file, `Schema: ${error.instancePath || '/'} ${error.message}`);
      }
      continue;
    }

    if (byId.has(data.id)) {
      fail(file, `规则 id "${data.id}" 与 ${relative(ROOT, byId.get(data.id).file)} 重复`);
    }
    byId.set(data.id, { file, data });

    const ruleIds = new Set();
    for (const rule of data.rules ?? []) {
      if (ruleIds.has(rule.id)) fail(file, `规则 id "${rule.id}" 在同一文件内重复`);
      ruleIds.add(rule.id);

      if (rule.type.startsWith('placeholder') || rule.token) {
        const token = rule.token ?? '';
        const declared =
          token === 'char' || token === 'user'
            ? true
            : token.startsWith('custom:')
              ? Boolean(data.placeholders.custom?.[token.slice(7)])
              : false;
        if (!declared) fail(file, `规则 "${rule.id}" 引用了未声明的占位符 token "${token}"`);
      }
      if (rule.pattern) compileRegex(file, rule.id, rule.pattern, rule.flags);
      if (typeof rule.min === 'number' && typeof rule.max === 'number' && rule.min > rule.max) {
        fail(file, `规则 "${rule.id}" 的 min(${rule.min}) 大于 max(${rule.max})`);
      }
    }

    for (const fix of data.autoFix ?? []) {
      if (fix.type === 'replace-regex') compileRegex(file, `autoFix:${fix.type}`, fix.pattern, fix.flags);
      if (fix.ruleId && !ruleIds.has(fix.ruleId) && !(data.extends ?? '')) {
        warn(file, `autoFix 引用的 ruleId "${fix.ruleId}" 不在本文件规则中（可能来自父规则）`);
      }
    }

    for (const field of data.fields ?? []) {
      if (field.pattern) compileRegex(file, `field:${field.path}`, field.pattern, field.flags);
    }
  }

  // extends 检查
  for (const [id, { file, data }] of byId) {
    if (!data.extends) continue;
    if (!byId.has(data.extends)) {
      fail(file, `extends 指向不存在的规则 "${data.extends}"`);
      continue;
    }
    const seen = new Set([id]);
    let cursor = data.extends;
    while (cursor) {
      if (seen.has(cursor)) {
        fail(file, `extends 形成环：${[...seen, cursor].join(' -> ')}`);
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.data.extends ?? null;
    }
  }

  return byId.size;
}

// ---------- 高亮规则 ----------
async function validateHighlightRules() {
  const schema = await readJson(join(RULES_DIR, 'schema', 'highlight-rule.schema.json'));
  const validate = ajv.compile(schema);

  const dir = join(RULES_DIR, 'highlight');
  const files = await listJson(dir);
  const byId = new Map();

  for (const file of files) {
    const data = await readJson(file);
    if (!data) continue;

    if (!validate(data)) {
      for (const error of validate.errors ?? []) {
        fail(file, `Schema: ${error.instancePath || '/'} ${error.message}`);
      }
      continue;
    }

    if (byId.has(data.id)) fail(file, `规则集 id "${data.id}" 重复`);
    byId.set(data.id, { file, data });

    const scopeIds = new Set(data.scopes.map((scope) => scope.id));
    const ruleIds = new Set();

    for (const rule of data.rules ?? []) {
      if (ruleIds.has(rule.id)) fail(file, `规则 id "${rule.id}" 在同一文件内重复`);
      ruleIds.add(rule.id);

      // 引用父级 scope 时留到继承链复核阶段判定（下面统一处理）
      if (!scopeIds.has(rule.scope) && !data.extends) {
        fail(file, `规则 "${rule.id}" 引用了未定义的 scope "${rule.scope}"`);
      }
      if (rule.match.type === 'regex') compileRegex(file, rule.id, rule.match.pattern, rule.match.flags);
      if (rule.match.type === 'word-list' && rule.match.words.some((word) => word.trim() === '')) {
        warn(file, `规则 "${rule.id}" 含空白关键字`);
      }
      for (const selector of [].concat(rule.appliesTo ?? [])) {
        if (!/^(\*|block:(basic|personality|settings|special|user|chat-examples|initial-scene|worldbook)|field:[a-z_]+)$/.test(selector)) {
          fail(file, `规则 "${rule.id}" 的 appliesTo "${selector}" 不是合法选择器`);
        }
      }
    }
  }

  // extends：目标必须存在、不成环；合并后所有 scope 引用必须可解析
  for (const [id, { file, data }] of byId) {
    if (!data.extends) continue;
    if (!byId.has(data.extends)) {
      fail(file, `extends 指向不存在的规则集 "${data.extends}"`);
      continue;
    }
    const seen = new Set([id]);
    let cursor = data.extends;
    let chain = [id];
    while (cursor) {
      if (seen.has(cursor)) {
        fail(file, `extends 形成环：${[...seen, cursor].join(' -> ')}`);
        break;
      }
      seen.add(cursor);
      chain.push(cursor);
      cursor = byId.get(cursor)?.data.extends ?? null;
    }
    if (cursor) continue;

    // 沿链（根 → 自身）合并 scope 后再复核引用
    const mergedScopes = new Set();
    for (const node of chain.reverse()) {
      for (const scope of byId.get(node)?.data.scopes ?? []) mergedScopes.add(scope.id);
    }
    for (const rule of data.rules ?? []) {
      if (!mergedScopes.has(rule.scope)) {
        fail(file, `规则 "${rule.id}" 引用了未定义的 scope "${rule.scope}"（继承链 ${chain.join(' -> ')} 中均未定义）`);
      }
    }
  }

  return byId.size;
}

// ---------- 预设格式 ----------
//
// 板块清单与中文名从 `shared/src/model/blocks.ts` **读源码**派生，而不是在这里再抄一份。
// 理由：本脚本刻意只依赖 Ajv（能在没构建过的干净 clone 里跑），
// 但"再抄一份板块表"就意味着加板块时要记得改这里 —— 那正是 F6 要消灭的那类副本。
// 从 BLOCK_IDS 与 BLOCK_DEFINITIONS 的字面量里解析，既零依赖，也只有一处真相。
const BLOCKS_SOURCE = await readFile(join(ROOT, 'shared/src/model/blocks.ts'), 'utf8');

function readBlockTable(source) {
  const arrayMatch = /export const BLOCK_IDS = \[([\s\S]*?)\] as const;/.exec(source);
  if (!arrayMatch) throw new Error('无法从 shared/src/model/blocks.ts 解析 BLOCK_IDS');
  const ids = [...arrayMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const labels = {};
  const headings = {};
  const definitionRe = /id: '([^']+)',\s*\n\s*label: '([^']+)',[\s\S]*?defaultHeading: '([^']+)'/g;
  for (const match of source.matchAll(definitionRe)) {
    labels[match[1]] = match[2];
    headings[match[1]] = match[3];
  }
  if (ids.length !== Object.keys(labels).length) {
    throw new Error(`板块表解析不一致：BLOCK_IDS ${String(ids.length)} 项，定义 ${String(Object.keys(labels).length)} 项`);
  }
  return { ids, labels, headings };
}

const { ids: ALL_BLOCK_IDS, headings: BLOCK_HEADINGS } = readBlockTable(BLOCKS_SOURCE);
const BLOCK_LABELS = BLOCK_HEADINGS;

/** 与 shared/src/format/description.ts 的 normalizeHeading 保持一致 */
function normalizeHeading(text) {
  return String(text)
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[:：]+$/u, '')
    .toLowerCase();
}

async function validatePresets() {
  const schema = await readJson(join(RULES_DIR, 'schema', 'preset.schema.json'));
  const validate = ajv.compile(schema);

  const dir = join(RULES_DIR, 'presets');
  const files = await listJson(dir);
  const byId = new Map();

  for (const file of files) {
    const data = await readJson(file);
    if (!data) continue;

    if (!validate(data)) {
      for (const error of validate.errors ?? []) {
        fail(file, `Schema: ${error.instancePath || '/'} ${error.message}`);
      }
      continue;
    }

    if (byId.has(data.id)) fail(file, `预设 id "${data.id}" 重复`);
    byId.set(data.id, { file, data });

    // 顺序：允许部分排列（旧预设兼容），但不得有重复项、不得超出板块集合
    const order = data.blockOrder ?? [];
    const seenOrder = new Set();
    for (const blockId of order) {
      if (!ALL_BLOCK_IDS.includes(blockId)) fail(file, `blockOrder 含未知板块 "${blockId}"`);
      if (seenOrder.has(blockId)) fail(file, `blockOrder 中板块 "${blockId}" 重复`);
      seenOrder.add(blockId);
    }

    // 别名：互相不冲突、包含板块默认标题（缺项由 runtime 补齐，这里不判"必须覆盖全部"）
    const aliasOwner = new Map();
    for (const [blockId, heading] of Object.entries(data.headings ?? {})) {
      const aliases = heading.aliases ?? [];
      if (!aliases.some((alias) => normalizeHeading(alias) === normalizeHeading(BLOCK_LABELS[blockId] ?? ''))) {
        warn(file, `板块 "${blockId}" 的别名表未包含默认标题「${BLOCK_LABELS[blockId]}」`);
      }
      for (const alias of aliases) {
        const key = normalizeHeading(alias);
        const owner = aliasOwner.get(key);
        if (owner && owner !== blockId) {
          fail(file, `标题别名「${alias}」同时属于 ${owner} 与 ${blockId}，解析会二义`);
        } else {
          aliasOwner.set(key, blockId);
        }
      }
    }

    // 分隔符若是单行文字（如 ---），提示解析时会从正文末尾剔除
    const separatorLines = String(data.separator ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (separatorLines.length === 1) {
      warn(file, `分隔符含文字行「${separatorLines[0]}」，解析时会从板块正文末尾剔除该行`);
    }
  }

  return byId.size;
}

const platformCount = await validatePlatformRules();
const highlightCount = await validateHighlightRules();
const presetCount = await validatePresets();

if (warnings.length > 0) {
  console.log(`\n⚠ 警告 ${warnings.length} 条：`);
  for (const message of warnings) console.log(`  - ${message}`);
}

if (errors.length > 0) {
  console.error(`\n✖ 校验失败：${errors.length} 个错误`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(
  `\n✔ 全部规则文件通过校验：平台规则 ${platformCount} 份，高亮规则 ${highlightCount} 份，预设格式 ${presetCount} 份`,
);
