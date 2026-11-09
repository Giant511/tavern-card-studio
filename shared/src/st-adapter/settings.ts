/**
 * 设置的读改写（v0.1.7 / T15.4）。
 *
 * ## 这个模块存在的唯一理由：把"整份覆盖"这件事锁在一个入口里
 *
 * `/api/settings/save` **没有 patch 语义**：服务端直接
 * `JSON.stringify(request.body)` 写盘（`settings.js:209`）。
 * 也就是说，只要有人传了 `{ openai_model: "x" }`，其它所有设置（主题、语言、
 * 上下文长度、API key 槽位引用…）**当场被清空**。
 *
 * 这是全项目最容易造成用户数据丢失的一处，而它不会报错 ——
 * 用户只会在某天发现"我的设置全变默认值了"。
 *
 * 所以对外只暴露 `mutateSettings(updater)`：内部强制 GET → 改 → POST 全量。
 * 渲染层拿不到"直接 POST settings/save"的路径（HTTP 层不导出那个端点）。
 */

import type { StSettings } from './types.js';

/** 读设置返回的包裹形状（`settings.js:219`、`:269`） */
export interface SettingsEnvelope {
  settings?: unknown;
  [key: string]: unknown;
}

/**
 * 把 `/api/settings/get` 的返回解成对象（契约陷阱 #5）。
 *
 * `settings` 字段是**字符串**（服务端读文件后原样放入），要二次 `JSON.parse`。
 * 直接当对象用会得到一堆 `undefined` —— 表现为"读到了设置但每个字段都空"。
 *
 * ## 解析失败返回 `{ok:false}` 而不是抛异常
 *
 * 因为失败原因必须能显示给用户（"设置文件可能损坏"）。
 * 抛异常的话，上层 catch 之后通常只剩一句"加载失败"，用户不知道要不要修。
 */
export function parseSettingsEnvelope(
  envelope: unknown,
): { ok: true; settings: StSettings } | { ok: false; reason: string } {
  if (envelope === null || typeof envelope !== 'object') {
    return { ok: false, reason: '服务端返回的设置格式无法识别' };
  }
  const raw = (envelope as SettingsEnvelope).settings;

  // 已经是对象就直接用（防御未来 ST 改成对象返回）
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ok: true, settings: raw as StSettings };
  }

  if (typeof raw !== 'string') {
    return { ok: false, reason: '服务端返回的设置里没有 settings 字段' };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: '设置内容不是对象结构' };
    }
    return { ok: true, settings: parsed as StSettings };
  } catch {
    return { ok: false, reason: '设置文件解析失败（可能已损坏，或 ST 版本不兼容）' };
  }
}

/**
 * 应用一次修改，产出要 POST 回去的**完整设置对象**。
 *
 * ## 为什么 updater 返回新对象而不是原地改
 *
 * 原地改会让"改到一半抛异常"变成半截状态，而它紧接着会被整份写盘 ——
 * 等于把半成品存进用户文件。返回新对象则要么全成、要么全不写。
 *
 * ## 为什么 updater 抛错要**拦住**
 *
 * 见上：异常往上冒到 HTTP 层时，很多人会 catch 之后继续保存（"尽力而为"）。
 * 这里直接把结果定成 `{ok:false}`，让"保存"从根本上不发生。
 */
export function applySettingsUpdate(
  current: StSettings,
  updater: (settings: StSettings) => StSettings,
): { ok: true; next: StSettings } | { ok: false; reason: string } {
  let next: StSettings;
  try {
    next = updater({ ...current });
  } catch (error) {
    return {
      ok: false,
      reason: `修改设置时出错，已取消保存：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (next === null || typeof next !== 'object' || Array.isArray(next)) {
    return { ok: false, reason: '修改后的设置不是对象结构，已取消保存' };
  }
  /*
   * 防"改完比原来少了字段"的粗心。
   *
   * 不拦数组与嵌套删除（那是合法的），只拦**顶层键减少** ——
   * 那是"updater 里用了 `{...} ` 重建对象但漏了展开"的典型形态，
   * 而它的后果正是把一堆设置清空。
   */
  const lost = Object.keys(current).filter((key) => !(key in next));
  if (lost.length > 0) {
    return {
      ok: false,
      reason:
        `修改后的设置比原来少了 ${String(lost.length)} 个字段（${lost.slice(0, 3).join('、')}…）。` +
        '这通常意味着保存逻辑写错了，为避免清空你的设置，本次已取消。',
    };
  }
  return { ok: true, next };
}

/**
 * 保存成功的判据（契约陷阱 #7）。
 *
 * `/api/settings/save` **异常时也返回 HTTP 200**，错误在响应体里。
 * 所以判据是响应体的 `result === "ok"`，不是状态码。
 */
export function isSaveOk(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  return (payload as Record<string, unknown>)['result'] === 'ok';
}

/* ═══════════════════════════════════════════════════════════
   ★ 编排层：mutateSettings（2026-10-31 第三批补）

   本文件开头的注释一直写着"对外只暴露 `mutateSettings(updater)`"，
   但**它此前从未被实现** —— 只有下面三个纯函数（parse / apply / isSaveOk）。
   也就是说那句注释描述的是一个计划，不是一个事实。

   这个缺口是 2026-10-31 做「聊天参数配置」时撞出来的：
   要读写 ST 设置，按注释去找 `mutateSettings`，grep 全库零结果。

   为什么把它放在 `shared` 而不是 `client`：
   它是**协议级**的约束（"整份覆盖 + 必须 GET 后改"），
   不是某个界面的偏好。放在 shared 里，将来服务端或别的客户端也能复用
   同一份实现 —— 同一件事写两遍必然分叉，而这里分叉的代价是清空用户设置。
   ═══════════════════════════════════════════════════════════ */

/** 编排层需要的两个能力（由调用方注入，`shared` 不直接依赖 Tauri / fetch） */
export interface SettingsTransport {
  /** 读原始响应（`/api/settings/get` 的响应体原文） */
  getRaw: () => Promise<string>;
  /** 整份写入（body 就是 settings 对象本身，陷阱 #6） */
  save: (settings: StSettings) => Promise<string>;
}

export type MutateSettingsResult =
  | { ok: true; settings: StSettings }
  | { ok: false; reason: string };

/**
 * 读 → 改 → 整份写回。**修改 ST 设置的唯一入口。**
 *
 * ## 这个函数存在的全部理由
 *
 * `/api/settings/save` 没有 patch 语义：服务端直接 `JSON.stringify(body)` 写盘。
 * 有人传 `{ openai_model: 'x' }` 就当场清空其它所有设置（主题、语言、上下文、
 * key 槽位引用…），而且**不报错** —— 用户只会在某天发现"设置全变默认值了"。
 *
 * ## 三道防线，缺一不可
 *
 * 1. `parseSettingsEnvelope` 解析失败 ⇒ 不写（宁可不保存，也不拿半个对象去覆盖）；
 * 2. `applySettingsUpdate` 拦住"顶层键减少"（`{...}` 漏展开的典型形态）；
 * 3. `isSaveOk` 判响应体 `result === 'ok'`，不信 HTTP 200（陷阱 #7）。
 *
 * ## 为什么失败时返回 reason 而不是抛异常
 *
 * 每种失败要给用户不同的话：设置文件坏了 / 保存逻辑写错了 / 服务端拒绝了。
 * 抛异常的话上层 catch 完只剩一句"保存失败"，用户不知道该不该重试。
 */
export async function mutateSettings(
  transport: SettingsTransport,
  updater: (settings: StSettings) => StSettings,
): Promise<MutateSettingsResult> {
  const raw = await transport.getRaw();

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw === '' ? '{}' : raw);
  } catch {
    return { ok: false, reason: '服务端返回的设置不是有效的 JSON，本次未保存' };
  }

  const parsed = parseSettingsEnvelope(envelope);
  if (!parsed.ok) {
    // 读不到当前设置就**绝不写** —— 否则就是拿半个对象覆盖真实设置
    return { ok: false, reason: `${parsed.reason}。为避免覆盖原有设置，本次未保存` };
  }

  const applied = applySettingsUpdate(parsed.settings, updater);
  if (!applied.ok) return { ok: false, reason: applied.reason };

  const saveRaw = await transport.save(applied.next);

  let savePayload: unknown;
  try {
    savePayload = JSON.parse(saveRaw === '' ? '{}' : saveRaw);
  } catch {
    // 响应读不懂 = 不知道成没成。此时说"成功"会掩盖真实问题
    return { ok: false, reason: '保存请求已发出，但服务端的回应无法识别，请刷新后再确认' };
  }

  if (!isSaveOk(savePayload)) {
    const detail =
      (savePayload as Record<string, unknown>)['message'] ??
      (savePayload as Record<string, unknown>)['error'] ??
      '';
    const suffix = typeof detail === 'string' && detail !== '' ? `：${detail}` : '';
    return { ok: false, reason: `服务端拒绝了这次保存${suffix}` };
  }

  return { ok: true, settings: applied.next };
}
