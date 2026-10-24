/**
 * 规则/预设校验错误的结构化拆分（T10.30 从 client 上移到 shared）。
 *
 * 为什么要上移：`preset-library` 是纯逻辑（可单测），它需要把
 * `"fields[2].path: 缺少 path"` 拆成 `{ where, message }` 才能让界面显示"哪个字段"。
 * 留在 client 目录里会让它只能通过相对路径 import，而 Node 的类型剥离
 * 要求显式扩展名、TS 又禁止 `.ts` 扩展名 —— 两边都不满足。
 * 移到 shared 之后 client 与测试拿到的是同一份实现（re-export，不复制）。
 */

export interface RuleIssue {
  /** 字段路径（空串 = 文件级错误） */
  where: string;
  message: string;
  /** 粗分组的字段名，便于按字段归并展示，如 `fields` / `rules` / `target` */
  group: string;
  /** 序号（从 `[n]` 里取），无序号为 null */
  index: number | null;
}

const WHERE_PATTERN = /^([A-Za-z_$][\w$]*(?:\[\d+\])*(?:\.[A-Za-z_$][\w$]*(?:\[\d+\])*)*)\s*[:：]\s*(.+)$/;

/**
 * 把 `"fields[0].path: 缺少 path"` 拆成 `{ where, message }`。
 * 拆不出前缀时整体当 message（`where` 空）。
 */
export function splitRuleError(raw: string): RuleIssue {
  const trimmed = raw.trim();
  const match = WHERE_PATTERN.exec(trimmed);
  if (!match) {
    return { where: '', message: trimmed, group: '', index: null };
  }

  const where = match[1] ?? '';
  const message = (match[2] ?? trimmed).trim();
  const groupName = where.split(/[.[]/)[0] ?? '';
  const indexMatch = /\[(\d+)\]/.exec(where);

  return {
    where,
    message,
    group: groupName,
    index: indexMatch ? Number(indexMatch[1]) : null,
  };
}

/** 按 `group` 归并错误，UI 里一组一个问题块更好读 */
export function groupRuleIssues(issues: readonly RuleIssue[]): Array<{
  group: string;
  title: string;
  items: RuleIssue[];
}> {
  const GROUP_TITLES: Record<string, string> = {
    '': '文件级',
    fields: '字段定义',
    rules: '内容规则',
    target: '目标平台',
    placeholders: '占位符',
    extends: '继承',
    scopes: '作用域',
    theme: '主题',
  };

  const buckets = new Map<string, RuleIssue[]>();
  for (const issue of issues) {
    const list = buckets.get(issue.group);
    if (list) list.push(issue);
    else buckets.set(issue.group, [issue]);
  }

  return [...buckets.entries()].map(([group, items]) => ({
    group,
    title: GROUP_TITLES[group] ?? group,
    items,
  }));
}
