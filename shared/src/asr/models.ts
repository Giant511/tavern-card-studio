/**
 * 中转站的「获取模型列表」（v0.1.7 / T15.6，2026-10-29 定稿）。
 *
 * ## 这个功能的定位：**锦上添花，不许妨碍主流程**
 *
 * 定稿原文：
 *
 * ```text
 * "获取模型列表"按钮：GET {base_url}/models（带 key），
 * 成功 → 模型名下拉框；失败（401/404）→ 静默降级保持手填，
 * 不报错打扰（不是所有站都开 /models）
 * ```
 *
 * 这里的"静默"是**刻意的**，而且与"不许静默置灰"那条原则不冲突 ——
 * 两者的区别在于**主流程是否还能继续**：
 *
 * | 场景 | 静默是否可接受 | 为什么 |
 * |---|---|---|
 * | 麦克风按钮静默置灰 | ❌ | 用户不知道这功能存在/为什么点不动 |
 * | 获取模型列表失败 | ✅ | 手填模型名一直都可用，这个按钮只是省事 |
 *
 * ## 为什么 401 在这里也静默
 *
 * 直觉上 401 该报"密钥无效"。但定稿明确要求静默，理由站得住：
 * `GET /models` 需要**额外的权限范围**，很多站的 key 允许转写但不允许列模型 ——
 * 此时 401 完全不说明转写不可用。**真正的判据是那段 3 秒测试音频**，
 * 它在保存时会跑，那个才是权威。
 *
 * 如果在这里因为 401 弹"密钥无效"，用户会去换一个本来好用的 key。
 */

export interface AsrModelOption {
  id: string;
  /** 归属方（`owned_by`），部分站不返回 */
  ownedBy?: string;
}

/**
 * 拼 `/models` 的地址。
 *
 * ## 为什么要处理末尾斜杠与已有路径
 *
 * 三段真实输入：
 * - `https://api.groq.com/openai/v1` → `.../v1/models`
 * - `https://api.groq.com/openai/v1/` → 同上（多一个斜杠会变成 `//models`，
 *   部分网关直接 404）
 * - `https://my-relay.com/v1/audio/transcriptions` → 用户把**接口全路径**贴进来了。
 *   这时不能在后面接 `/models`，要先退到 `/v1`。
 *
 * 第三条是真实会发生的：很多中转站的文档给的是完整 endpoint，
 * 用户会整段复制。
 */
export function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === '') return '';

  // 去掉末尾斜杠（可能多个）
  let base = trimmed.replace(/\/+$/, '');

  /*
   * 如果用户贴的是完整接口路径，退到它的根：
   *   .../v1/audio/transcriptions → .../v1
   *   .../v1/chat/completions     → .../v1
   *   .../v1/audio/transcriptions?x=1 → .../v1
   */
  base = base.replace(/\?.*$/, '');
  base = base.replace(/\/(audio\/transcriptions|chat\/completions|audio\/speech|models)$/, '');

  /*
   * 万一用户贴的是根域名（没有 /v1），不擅自补 ——
   * 因为有的站是 `/api/v1`、有的是 `/openai/v1`，猜错比不补更糟。
   * 直接接 `/models`，让服务端返回 404，然后静默降级。
   */
  return `${base}/models`;
}

/**
 * 解析 `/models` 的响应。
 *
 * OpenAI 兼容站的标准形状是 `{ data: [{ id, owned_by }, ...] }`，
 * 但也有站直接返回数组，或把 `data` 写成对象。
 * 三种都认 —— 这个功能不值得因为形状差异而失败。
 *
 * 返回 `{ ok: false }` 而不是抛错：调用方一律走"静默降级"，
 * 抛错只会逼每个调用点写 try/catch。
 */
export function parseModelsResponse(
  payload: unknown,
): { ok: true; models: AsrModelOption[] } | { ok: false } {
  const raw = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object'
      ? (payload as Record<string, unknown>)['data']
      : null;

  if (!Array.isArray(raw)) return { ok: false };

  const models: AsrModelOption[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim() !== '') {
      models.push({ id: item.trim() });
      continue;
    }
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = record['id'] ?? record['name'] ?? record['model'];
    if (typeof id !== 'string' || id.trim() === '') continue;
    const ownedBy = record['owned_by'];
    models.push({
      id: id.trim(),
      ...(typeof ownedBy === 'string' && ownedBy !== '' ? { ownedBy } : {}),
    });
  }

  if (models.length === 0) return { ok: false };
  // 去重并按名字排序：下拉框里重复项会让用户以为"有两个同名模型"
  const seen = new Set<string>();
  const unique = models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
  unique.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, models: unique };
}

/**
 * 一次「获取模型列表」尝试的结论。
 *
 * ## `fallback` 与 `failed` 是**同一个界面结果**（都保持手填），
 * 但分开命名是为了让代码读起来不误导：
 * 这不是错误，是"这个站没开这个接口"这种正常情况。
 */
export type ModelsFetchOutcome =
  | { kind: 'ok'; models: AsrModelOption[] }
  | { kind: 'fallback'; reason: string };

/**
 * 把 HTTP 结果折算成结论。
 *
 * 注意：**任何失败都转成 `fallback`，不产生错误提示。**
 * `reason` 只用于日志与调试，界面上不展示（定稿要求"不报错打扰"）。
 */
export function interpretModelsResponse(input: {
  status: number;
  payload: unknown;
}): ModelsFetchOutcome {
  if (input.status === 401 || input.status === 403) {
    return {
      kind: 'fallback',
      // 只进日志：这个站的 key 可能只是没有列模型的权限
      reason: '密钥无权列出模型（该站可能只允许转写），保持手填',
    };
  }
  if (input.status === 404 || input.status === 405) {
    return { kind: 'fallback', reason: '该站没有开放 /models 接口，保持手填' };
  }
  if (input.status < 200 || input.status >= 300) {
    return { kind: 'fallback', reason: `服务端返回 ${String(input.status)}，保持手填` };
  }
  const parsed = parseModelsResponse(input.payload);
  if (!parsed.ok) {
    return { kind: 'fallback', reason: '返回内容里没有可用的模型列表，保持手填' };
  }
  return { kind: 'ok', models: parsed.models };
}
