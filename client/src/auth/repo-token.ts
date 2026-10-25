/**
 * 仓库令牌模式的纯逻辑（v0.1.3 / F5 后半）—— 不碰 DOM、不碰网络。
 *
 * ## 两套凭证路径的边界（这一批要讲清的核心）
 *
 *   · **账户登录** = 身份。用户名 + 密码换 access/refresh，能管"我自己的全部仓库
 *     与全部卡片"。它是"这是我"的证明。
 *   · **仓库令牌** = 受限授权。一把 `tcr_` 令牌只绑**一个仓库**、只有
 *     read/write/rollback 三档里的若干档，无续期、无账户管理能力。它是
 *     "允许你用这个仓库到这个程度"的凭证。
 *
 * 换句话说：账户令牌答的是"你是谁"，仓库令牌答的是"你能对这个仓库做什么"。
 * 所以这个模式下仓库选择器必然只有一个选项（令牌绑死），
 * 按钮可用性必然由 scope 决定（而不是由角色或偏好）—— 这些都不是界面偷懒，
 * 是凭证本身的形状决定的。
 *
 * ## scope → 能力
 *
 * 服务端 `requiredScope()` 定的是「操作需要什么范围」，这里是它在界面上的镜像：
 *
 *   | 操作           | 需要范围 |
 *   |---------------|---------|
 *   | 看列表/历史/内容 | read    |
 *   | 上传（新建版本）  | write   |
 *   | 回滚            | rollback |
 *   | 删除 / 移动      | write   |
 *
 * 镜像关系必须一一对应，否则会出现"按钮亮着但点了 403"。测试里有一条
 * 交叉断言：这里给出的每一条能力，都能在服务端口径上找到同一个 requiredScope。
 */

/** 令牌可做的动作（界面上对应一个按钮或一组按钮） */
export type RepoTokenAction = 'read' | 'upload' | 'rollback' | 'delete' | 'move';

/** 服务端的三档范围（与 `server/src/storage/repos.ts` 的 TokenScope 一致） */
export type RepoTokenScope = 'read' | 'write' | 'rollback';

export interface RepoTokenCapabilities {
  /** 只读：看列表、看历史、看版本内容 */
  canRead: boolean;
  /** 上传新版本（需要 write） */
  canUpload: boolean;
  /** 回滚（需要 rollback） */
  canRollback: boolean;
  /** 删除卡片（服务端把 delete 归到 write） */
  canDelete: boolean;
  /** 移动到别的仓库（需要 write；且单仓库模式下目标仓库本来也不存在别的） */
  canMove: boolean;
  /** 缺哪些范围（给界面解释"为什么灰的"，不要只说"无权限"） */
  missingFor: Record<Exclude<RepoTokenAction, 'read'>, RepoTokenScope | null>;
}

/**
 * 某个动作需要哪个范围。
 *
 * 与服务端 `requiredScope()` 逐条对应 —— 单点定义在这里，界面与文案都从这里取，
 * 避免"某处判 write、某处判 rollback"的口径分歧（服务端那边踩过，
 * 见 `repos.ts` 的注释）。
 */
export function requiredScopeFor(action: RepoTokenAction): RepoTokenScope {
  switch (action) {
    case 'read':
      return 'read';
    case 'upload':
      return 'write';
    case 'rollback':
      return 'rollback';
    // delete 归 write：需求只定义了三档，单独开一档会让现有三档令牌在删除时全部失效
    case 'delete':
      return 'write';
    case 'move':
      return 'write';
  }
}

/**
 * 由 scope 列表算出能力矩阵。
 *
 * 空列表 = 什么都不行（服务端也会拒），不特殊照顾。
 */
export function capabilitiesFor(scopes: readonly string[]): RepoTokenCapabilities {
  const has = (scope: RepoTokenScope): boolean => scopes.includes(scope);
  const can = (action: Exclude<RepoTokenAction, 'read'>): boolean => has(requiredScopeFor(action));
  return {
    canRead: has('read'),
    canUpload: can('upload'),
    canRollback: can('rollback'),
    canDelete: can('delete'),
    canMove: can('move'),
    missingFor: {
      upload: can('upload') ? null : 'write',
      rollback: can('rollback') ? null : 'rollback',
      delete: can('delete') ? null : 'write',
      move: can('move') ? null : 'write',
    },
  };
}

/** `tcr_` + 32 字节 base64url = 47 字符。与 `server/src/auth/repo-token-entry.ts` 同一形态 */
const REPO_TOKEN_SHAPE = /^tcr_[A-Za-z0-9_-]{43}$/;

/** 令牌前缀（服务端列表里给的展示用前缀是 12 字符） */
const PREFIX_LENGTH = 12;

export type RepoTokenShapeProblem =
  /** 空 */
  | 'empty'
  /** 前缀不对 */
  | 'prefix'
  /** 长度不对 */
  | 'length'
  /** 含非法字符 */
  | 'charset';

export interface RepoTokenShapeCheck {
  ok: boolean;
  /** 规范化后的值（去空白、去包裹引号） */
  value: string;
  problem: RepoTokenShapeProblem | null;
  /** 给用户看的一句话 —— 只说"格式哪不对"，不涉及令牌是否存在 */
  message: string;
}

/**
 * 本地形态校验。
 *
 * 只判「这串字符像不像一把令牌」，**不判它是否有效** —— 后者必须问服务端。
 * 这一步的价值是：明显残缺的输入不发请求（省一次往返，且能在输入时就给出提示），
 * 而不是替服务端下结论。
 *
 * 去引号与空白是必要的：用户从对话框复制时常把前后的空格/引号带进来，
 * 而服务端做的是精确哈希比对 —— 多一个空格就是另一把令牌。
 */
export function checkRepoTokenShape(input: string): RepoTokenShapeCheck {
  const value = input.trim().replace(/^["'`]|["'`]$/g, '').trim();

  if (value === '') {
    return { ok: false, value, problem: 'empty', message: '请粘贴仓库令牌' };
  }
  if (!value.startsWith('tcr_')) {
    return {
      ok: false,
      value,
      problem: 'prefix',
      message: '令牌应当以 tcr_ 开头 —— 这是「仓库令牌」，不是账户密码或全局访问令牌',
    };
  }
  if (value.length === PREFIX_LENGTH) {
    // 这是最常见的错：把列表里显示的前缀当成完整令牌
    return {
      ok: false,
      value,
      problem: 'length',
      message: '这只有 12 个字符，是令牌的「前缀」（用于在列表里认出是哪一把），不是完整令牌',
    };
  }
  if (!REPO_TOKEN_SHAPE.test(value)) {
    return {
      ok: false,
      value,
      problem: 'charset',
      message: `令牌格式不对：应当是 tcr_ 开头、共 47 个字符（当前 ${value.length} 个）`,
    };
  }
  return { ok: true, value, problem: null, message: '' };
}

/** 单仓库模式的标题文案：顶栏与同步面板共用 */
export function repoTokenModeLabel(repoName: string): string {
  const name = repoName.trim() === '' ? '（仓库名未知）' : repoName.trim();
  return `仓库令牌模式 · ${name}`;
}

/**
 * scope 的中文说明。
 *
 * 与 `sync/repo-select.ts` 的 `describeScopes` 有意区分：那个用于「签发出来的
 * 令牌列表」（要写明"含删除"这类隐含语义），这个用于**当前连接**的身份条，
 * 只讲"你现在能做什么"。两处文案不同但结论一致，测试里交叉断言。
 */
export function describeCapabilities(caps: RepoTokenCapabilities): string {
  const parts: string[] = [];
  if (caps.canRead) parts.push('查看');
  if (caps.canUpload) parts.push('上传');
  if (caps.canRollback) parts.push('回滚');
  if (caps.canDelete) parts.push('删除');
  if (parts.length === 0) return '无可用操作';
  return parts.join(' · ');
}

/**
 * 置灰按钮的悬浮说明。
 *
 * 必须点名"缺哪一档"，不能只说"无权限" —— 用户手上这把令牌是别人签的，
 * 他需要知道去找签发人要哪一档，而不是自己去猜。
 */
export function disabledReason(action: Exclude<RepoTokenAction, 'read'>, caps: RepoTokenCapabilities): string {
  const need = caps.missingFor[action];
  if (need === null) return '';
  const label: Record<RepoTokenScope, string> = { read: '读', write: '写', rollback: '回滚' };
  return `此令牌没有「${label[need]}」权限 —— 需要签发人给它加上 ${need} 范围`;
}
