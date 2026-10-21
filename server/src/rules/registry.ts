/**
 * 规则资产加载（平台规则 / TXT 预设）。
 *
 * 服务端只读 `rulesDir`，不做规则编辑（规则编辑属于客户端 T6 的范围）。
 * 每次审计前用「文件名 + mtime + size」做一次轻量签名比对，签名变化才重新解析，
 * 这样运维把新规则拷进规则目录后无需重启服务。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  findPreset,
  loadPlatformRules,
  loadPresets,
  resolvePlatformRule,
  type PlatformRuleFile,
  type ResolvedPlatformRule,
  type TxtPreset,
} from '@tcs/shared';

interface Signature {
  key: string;
  at: number;
}

function signatureOf(dir: string, ext: string): Signature {
  let key = '';
  let at = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(ext)).sort();
  } catch {
    return { key: '', at: 0 };
  }
  for (const name of names) {
    try {
      const stat = statSync(join(dir, name));
      key += `${name}:${stat.size}:${stat.mtimeMs};`;
      at = Math.max(at, stat.mtimeMs);
    } catch {
      // 文件在扫描过程中被删除，忽略
    }
  }
  return { key, at };
}

export interface RuleSummary {
  id: string;
  name: string;
  version: string;
  extends?: string;
}

export class RuleRegistry {
  readonly rulesDir: string;
  private platformSignature: Signature = { key: '', at: 0 };
  private presetSignature: Signature = { key: '', at: 0 };
  private platforms: PlatformRuleFile[] = [];
  private presets: TxtPreset[] = [];
  private platformErrors: string[] = [];
  private presetErrors: string[] = [];

  constructor(rulesDir: string) {
    this.rulesDir = rulesDir;
    this.refresh();
  }

  private readDir(sub: string): Array<{ name: string; json: unknown }> {
    const dir = join(this.rulesDir, sub);
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const out: Array<{ name: string; json: unknown }> = [];
    for (const name of names) {
      try {
        out.push({ name, json: JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown });
      } catch (error) {
        out.push({ name, json: null });
        this.platformErrors.push(`${sub}/${name}: ${(error as Error).message}`);
      }
    }
    return out;
  }

  refresh(): void {
    const platformSig = signatureOf(join(this.rulesDir, 'platforms'), '.json');
    if (platformSig.key !== this.platformSignature.key) {
      const inputs = this.readDir('platforms');
      const result = loadPlatformRules(inputs.map((item) => item.json));
      this.platforms = result.rules;
      this.platformErrors = result.errors.map((error) => `${error.id ?? `#${error.index}`}: ${error.errors.join('; ')}`);
      this.platformSignature = platformSig;
    }

    const presetSig = signatureOf(join(this.rulesDir, 'presets'), '.json');
    if (presetSig.key !== this.presetSignature.key) {
      const inputs = this.readDir('presets');
      const result = loadPresets(inputs.map((item) => item.json));
      this.presets = result.presets;
      this.presetErrors = result.errors.map((error) => `${error.id ?? `#${error.index}`}: ${error.errors.join('; ')}`);
      this.presetSignature = presetSig;
    }
  }

  listPlatforms(): RuleSummary[] {
    this.refresh();
    return this.platforms.map((rule) => ({
      id: rule.id,
      name: rule.name,
      version: rule.version,
      ...(rule.extends ? { extends: rule.extends } : {}),
    }));
  }

  listPresets(): Array<{ id: string; name: string; version: string }> {
    this.refresh();
    return this.presets.map((preset) => ({ id: preset.id, name: preset.name, version: preset.version }));
  }

  resolvePlatform(id: string): ResolvedPlatformRule | null {
    this.refresh();
    return resolvePlatformRule(id, this.platforms);
  }

  findPreset(id: string): TxtPreset | null {
    this.refresh();
    return findPreset(this.presets, id);
  }

  loadErrors(): { platforms: string[]; presets: string[] } {
    this.refresh();
    return { platforms: [...this.platformErrors], presets: [...this.presetErrors] };
  }
}
