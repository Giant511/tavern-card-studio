/**
 * 语音标记（v0.1.7 / T15.6 终版）。
 *
 * ## 为什么标记要写进消息的 `extra`，而不是只存在客户端
 *
 * 用户原话是「语音标记随消息走」。如果只在客户端内存或本地配置里记"哪几条是语音"，
 * 那么：换一台设备、回到桌面端的 ST、或者换个入口打开同一个聊天 —— 徽标就没了。
 * 而 `extra` 是**跟着消息一起被 ST 持久化**的（契约 §5.3：附加快照，必须原样保留），
 * 所以写在这里才真的"随消息走"。
 *
 * ## 为什么挂在 `extra.tcs` 这个命名空间下
 *
 * `extra` 是 ST 自己的字段，里面可能已经有别人的东西（扩展、正则脚本、
 * 未来 ST 版本新增的键）。直接写 `extra.voice = true` 是在跟整个生态抢顶层键，
 * 短期碰不上、长期一定会撞。套一层 `tcs` 前缀是成本最低的隔离。
 *
 * ## 一条硬约束：**不许抹掉别人的字段**
 *
 * `extra` 与 `extra.tcs` 都要做**浅合并**，不能整体替换。
 * 这不是洁癖 —— 契约 §5.3 的判据是"读进来再写回去，除自己改动的字段外必须逐字段不变"。
 * 一个 `extra: { tcs: { voice: true } }` 的写法就会把 ST 扩展塞在
 * `extra.tcs.cardId` 之类的东西全抹掉，而现象是"切设备后某功能坏了"，
 * 极难联想到是加语音标记引起的。
 *
 * 决策 #306。
 */

/** 语音标记所在的命名空间键 */
export const VOICE_EXTRA_NAMESPACE = 'tcs';

/** 命名空间里的字段名 */
export const VOICE_EXTRA_FIELD = 'voice';

/**
 * 命名空间里的**时长**字段名（毫秒）。
 *
 * 为什么需要它：2026-10-31 用户明确「语音气泡下是识别出来的文字」——
 * 发出去的语音消息要长成语音消息的样子（一条带时长的小音频条，下面才是文字），
 * 而不是"普通文字气泡 + 一个 🎤 徽标"。时长是那条音频条上唯一有信息量的东西。
 *
 * 为什么单独一个键、而不是把 `voice` 从布尔的 `true` 改成对象：
 * `extra.tcs.voice === true` 这个判据已经写进了 `isVoiceMsg`、写进了测试、
 * 也写进了**已经存在的聊天记录**。改成对象会让所有老消息变成"不是语音"，
 * 而它们确实是语音 —— 为了一个新字段去破坏历史数据不划算。
 * 加一个平级的可选键，两条判据各自独立、互不影响。
 */
export const VOICE_EXTRA_DURATION_FIELD = 'voiceMs';

/**
 * 能带 `extra` 的消息形状。
 *
 * 刻意不用 `StChatMessage` 具体类型：这个模块既服务 ST 消息，
 * 也可能被将来的本地消息模型用到。用结构类型（structural typing）即可，
 * 不需要为了一个布尔标记把两个模型绑在一起。
 */
export interface WithExtra {
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 从 `extra` 里取出 tcs 命名空间（不是对象就当没有） */
function readNamespace(extra: unknown): Record<string, unknown> {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {};
  const tcs = (extra as Record<string, unknown>)[VOICE_EXTRA_NAMESPACE];
  if (!tcs || typeof tcs !== 'object' || Array.isArray(tcs)) return {};
  return { ...(tcs as Record<string, unknown>) };
}

/**
 * 给消息打上/取消语音标记，**其余字段原样保留**。
 *
 * `voice = true` 时写入；`voice = false` 时**删除该键**而不是写 `false`。
 *
 * 为什么删除而不是写 false：`extra.tcs.voice === false` 与"没有这个键"在语义上
 * 完全一样（都表示不是语音），但前者会让每条非语音消息都带上一个冗余键，
 * 把 `extra` 越塞越大 —— 而 `extra` 是每个聊天文件的每一行都要存一份的。
 *
 * @param durationMs 录音时长（毫秒）。有值才写 `voiceMs`，供消息里的音频条显示。
 *   不传 = 不写这个键（历史语音消息、或调用方拿不到时长）。
 */
export function setVoiceFlag<T extends WithExtra>(
  message: T,
  voice = true,
  durationMs?: number,
): T {
  const tcs = readNamespace(message.extra);

  if (voice) {
    tcs[VOICE_EXTRA_FIELD] = true;
    /*
     * 时长只在"能说出一个合理数字"时才写。
     *
     * 判据卡三道：是有限数、非负、且不为 0 —— 0 毫秒的录音不存在
     * （至少也有一帧），写进去只会让消息上显示一个 `0"`。
     * 拿不到合理值就不写，消息里退化成"没有时长文案的音频条"，
     * 那比显示一个假数字诚实。
     */
    if (
      typeof durationMs === 'number' &&
      Number.isFinite(durationMs) &&
      durationMs > 0
    ) {
      tcs[VOICE_EXTRA_DURATION_FIELD] = Math.round(durationMs);
    } else {
      delete tcs[VOICE_EXTRA_DURATION_FIELD];
    }
  } else {
    delete tcs[VOICE_EXTRA_FIELD];
    // 取消语音标记时，时长也必须一起清 —— 否则会留下一个
    // "不是语音但有语音时长"的消息，导出时看着像数据坏了
    delete tcs[VOICE_EXTRA_DURATION_FIELD];
  }

  const nextExtra: Record<string, unknown> = {
    ...((message.extra as Record<string, unknown> | undefined) ?? {}),
  };

  // 命名空间空了就把键也删掉，别留一个空对象污染 extra
  if (Object.keys(tcs).length === 0) {
    delete nextExtra[VOICE_EXTRA_NAMESPACE];
  } else {
    nextExtra[VOICE_EXTRA_NAMESPACE] = tcs;
  }

  // extra 整体空了同样删掉 —— 与 createMessage "不预填空字段"的口径一致
  const next: T = { ...message };
  if (Object.keys(nextExtra).length === 0) {
    delete (next as WithExtra).extra;
  } else {
    next.extra = nextExtra;
  }
  return next;
}

/**
 * 这条消息是不是语音发的。
 *
 * 判据是 `=== true`，不是"真值"：`extra.tcs.voice` 可能被手改配置写成
 * `"true"`（字符串）或 `1`。字符串 `"true"` 是真值但**不是**我们写的，
 * 按真值判会显示徽标而实际没有语音语义 —— 宁可少显示也不要显示错的。
 */
export function isVoiceMsg(message: WithExtra): boolean {
  if (!message.extra || typeof message.extra !== 'object') return false;
  const tcs = (message.extra as Record<string, unknown>)[VOICE_EXTRA_NAMESPACE];
  if (!tcs || typeof tcs !== 'object') return false;
  return (tcs as Record<string, unknown>)[VOICE_EXTRA_FIELD] === true;
}

/**
 * 徽标文案。
 *
 * 单独抽出来是因为它**会出现在两处**（聊天气泡、导出/诊断），
 * 两处各写一个字符串迟早分叉。而且它是"给用户看的话"，
 * 按项目纪律必须能被 UI 文案体检扫到 —— 放在纯逻辑层里就是唯一真相。
 */
export const VOICE_BADGE_LABEL = '语音';

/**
 * 这条语音消息的时长（毫秒）。没有/不是有限正数 → `null`。
 *
 * 判据与写入侧同一套口径（有限、正、数字类型），这样"写进去的"和
 * "读出来的"不会出现"写了但读不到"。历史消息没有这个键 ⇒ 返回 null，
 * 调用方据此不显示时长文案（而不是显示 `0"` 或 `NaN"`）。
 */
export function voiceDurationMs(message: WithExtra): number | null {
  if (!isVoiceMsg(message)) return null;
  const tcs = (message.extra as Record<string, unknown>)[VOICE_EXTRA_NAMESPACE];
  const raw = (tcs as Record<string, unknown>)[VOICE_EXTRA_DURATION_FIELD];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}
