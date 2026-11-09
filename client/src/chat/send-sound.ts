/**
 * 语音发送成功的提示音（2026-11-02 用户要求）。
 *
 * > 还有就是语音发送成功后需要有提示音，最好是 QQ 那种
 *
 * ## 为什么用 WebAudio 合成，而不是放一个音频文件
 *
 * 三条路都试过了（见 memory §79.7）：
 *
 * | 做法 | 结果 |
 * |---|---|
 * | `<audio src="data:...">` | WebView 报 `Failed to load because no supported source` |
 * | `<audio src="http://…">` | Tauri 报 `Media load rejected by URL safety check` |
 * | 打包 mp3/ogg 进 assets | 要引静态资源，且多一个"资源没打进包"的失败面 |
 *
 * WebAudio **合成**不需要任何资源：一个振荡器 + 一个包络，十几行代码，
 * 体积为零、没有加载失败的可能。
 *
 * ## 为什么必须先 `warmup()`
 *
 * WebAudio 的 `AudioContext` 在**没有用户手势**时是 `suspended` 状态，
 * 播放不会出声。而语音发送发生在"松手 → 转写 1~2 秒 → 发送"之后，
 * 那时已经脱离手势上下文了。
 *
 * 所以要在**按住大圆的那一刻**（明确的手势）先把 context 建好并 `resume()`，
 * 之后随时播放都能响。
 *
 * ## 音色
 *
 * QQ 的发送音是"短促、音高先高后低、极快衰减"。这里用
 * `sine 1200Hz → 700Hz / 90ms`，总长 160ms —— 短到不打断连续操作，
 * 又足够让人确认"发出去了"。
 */

/** 模块级单例：多次播放复用同一个 context（每次新建会耗资源，且更容易被挂起） */
let shared: AudioContext | null = null;

/** 取 context；环境不支持时返回 null（老 WebView / 单测 stub） */
function contextOrNull(): AudioContext | null {
  if (shared !== null) return shared;
  const g = globalThis as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (Ctor === undefined) return null;
  try {
    shared = new Ctor();
  } catch {
    return null;
  }
  return shared;
}

/**
 * 预热：在**用户手势**里调一次，把 context 从 `suspended` 拉起来。
 *
 * 漏了这一步的表现很隐蔽：代码没报错、`playSendSound()` 也执行了，
 * 但一点声音都没有 —— 因为 context 还挂着。
 */
export function warmupSendSound(): void {
  const ac = contextOrNull();
  if (ac === null) return;
  if (ac.state === 'suspended') void ac.resume();
}

/**
 * 播一声"已发送"。
 *
 * 全程 `try/catch`：提示音是**锦上添花**，绝不能因为它让发送流程抛错。
 * 用户宁可没声音，也不能因为"播放失败"而收不到自己发的消息。
 */
export function playSendSound(): void {
  try {
    const ac = contextOrNull();
    if (ac === null) return;
    if (ac.state === 'suspended') void ac.resume();

    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();

    osc.type = 'sine';
    /* 先高后低：下滑音比单音更像"嗖"，也更像 QQ */
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(700, t + 0.09);

    /*
     * 包络：`exponentialRampToValueAtTime` 不能到 0（会抛），
     * 所以两端都用 0.0001 当"静音"。
     *
     * 起音 8ms（太慢会闷、太快会"啪"），衰减 152ms。
     */
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);

    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.18);
  } catch {
    /* 静默失败：提示音不该影响发送 */
  }
}
