/**
 * 录音与振幅采集（v0.1.7 / T15.6）。
 *
 * ## 为什么振幅要自己从 AnalyserNode 取，而不是"假序列"
 *
 * 纯逻辑层的波形测试用的是**假振幅序列**（`test/voice.test.mjs` 里 36 条），
 * 那验的是"映射对不对"。接真源之后要验的是另一件事：
 * **真实麦克风的数值域是不是落在断言假设的范围里**。
 *
 * 具体差异：`AnalyserNode.getByteTimeDomainData` 给的是 0..255（128 为静音中点），
 * 而 `waveform.ts` 的 `MAX_RAW_AMPLITUDE = 32767`（对齐 16 位 PCM）。
 * 直接把 0..255 喂进去，所有振幅都会被算成"极小值"，波形永远贴着底 ——
 * 而测试全绿（因为它喂的是自己假设的量级）。
 *
 * 所以这里做**一次显式量级换算**：`|v - 128| * 256` → 0..~32768。
 * 换算写在这个文件里、只有一处，并配一条断言守着"静音给 0、满幅给接近上限"。
 *
 * ## 格式选择
 *
 * `MediaRecorder` 支持什么，取决于 WebView 的编解码器。实测优先级：
 *
 * ```text
 * audio/mp4      ← iOS / 新版 Chrome，多数 ASR 厂商首选
 * audio/webm;codecs=opus  ← Android Chrome / 桌面 Chrome
 * audio/webm
 * ```
 *
 * **不许硬编码**：写死 `audio/webm` 在 iOS 上会直接抛
 * `NotSupportedError`，而报错信息是"不支持这个 mimeType"，
 * 用户看不出"换一台设备就行"。
 */

import { MAX_RAW_AMPLITUDE, WAVEFORM_REFRESH_MS } from '@tcs/shared';

import type { ActiveRecording, VoiceTransport } from './voice-panel.ts';

/**
 * 松手后等 `MediaRecorder.onstop` 的上限（毫秒）。
 *
 * ## 为什么必须有上限
 *
 * `stop()` 现在**先** `track.stop()` 放掉麦克风、**再**等 `onstop` 收数据。
 * 而 `onstop` 在个别 WebView 实现上可能不触发（编码器异常、页面正在卸载）。
 * 没有上限的话 `await` 永久挂住 ⇒ 调用方停在"转写中"、界面卡死，
 * 用户只能杀进程。
 *
 * 1.5 秒的依据：真机实测 `onstop` 通常在 100–300ms 内到；给它 5 倍余量，
 * 既不会误判"还在收数据"，也不会让用户等太久。
 *
 * 超时后用**已收到的 chunks** 继续转写 —— 宁可少最后一小段，
 * 也不要卡住。用户还能重说一次，卡死不能。
 */
const STOP_FLUSH_TIMEOUT_MS = 1_500;

/**
 * 按优先级挑一个 MediaRecorder 支持的 mimeType。
 *
 * 返回 `''` 表示"让它自己选"（构造时不传 mimeType，浏览器用默认）——
 * 比乱猜一个不支持的类型强。
 */
export function pickMimeType(isSupported: (type: string) => boolean): string {
  const candidates = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  for (const type of candidates) {
    if (isSupported(type)) return type;
  }
  return '';
}

/**
 * 把 `getByteTimeDomainData` 的 0..255 转成 waveform 期望的 0..32767 量级。
 *
 * 说明为什么乘 256 而不是 128：
 *   128 是静音中点，`|v-128|` 的范围是 0..128。
 *   要映射到 0..32767，系数应为 32767/128 ≈ 256。
 *   取 256 让满幅略高于 32767（32768），`amplitudeToLevel` 内部会 clamp ——
 *   宁可让它 clamp 一次，也不要因为取 255 导致"满幅永远差一点"。
 */
export function byteAmplitudeToRaw(byteValue: number): number {
  const clamped = Math.max(0, Math.min(255, byteValue));
  return Math.abs(clamped - 128) * 256;
}

/**
 * 从一段时域字节里取**峰值**振幅。
 *
 * 为什么取峰值而不是平均：平均会把"一小段爆发"稀释成接近 0，
 * 而语音的音节就是这种形态 —— 用户会觉得"我说了但波形不动"。
 */
export function peakAmplitude(bytes: Uint8Array): number {
  let peak = 0;
  for (const value of bytes) {
    const raw = byteAmplitudeToRaw(value);
    if (raw > peak) peak = raw;
  }
  return Math.min(peak, MAX_RAW_AMPLITUDE);
}

/** 浏览器侧的最小接口（不依赖 DOM lib 的类型，便于在 Node 里 typecheck） */
interface MediaStreamLike {
  getTracks: () => Array<{ stop: () => void }>;
}
interface AudioContextLike {
  createMediaStreamSource: (stream: unknown) => { connect: (node: unknown) => void };
  createAnalyser: () => {
    fftSize: number;
    frequencyBinCount: number;
    getByteTimeDomainData: (array: Uint8Array) => void;
  };
  close: () => Promise<void>;
  state: string;
  resume?: () => Promise<void>;
}
interface MediaRecorderLike {
  start: (timeslice?: number) => void;
  stop: () => void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  state: string;
}
interface BrowserGlobals {
  navigator?: { mediaDevices?: { getUserMedia: (c: unknown) => Promise<MediaStreamLike> } };
  MediaRecorder?: new (stream: unknown, options?: { mimeType?: string }) => MediaRecorderLike;
  AudioContext?: new () => AudioContextLike;
  webkitAudioContext?: new () => AudioContextLike;
}

function globals(): BrowserGlobals {
  return globalThis as unknown as BrowserGlobals;
}

/** 从任意异常里取一句**人能看懂**的原因（取不到就给类型名） */
function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message !== '') return message;
    return error.name;
  }
  return String(error);
}

/**
 * 把 `getUserMedia` 的异常翻成**可操作**的话。
 *
 * ## 为什么 NotAllowedError 不能再一口咬定"权限被拒"
 *
 * 2026-11-01 真机取证：系统权限页明明写着「使用应用时允许」，
 * `dumpsys package` 也是 `RECORD_AUDIO: granted=true`，
 * 而 `getUserMedia` 依旧返回 `NotAllowedError: Permission denied`。
 *
 * 那一刻的真实原因在**宿主程序**里（WebView 的 `onPermissionRequest`
 * 被 `request.deny()` 了），不在系统权限上。原来那句
 * 「麦克风权限被拒绝。到系统设置里允许「录音」后重试。」
 * 把用户指到了一个**已经做对**的地方 —— 他会反复检查权限页，
 * 而问题永远修不好。
 *
 * 所以文案改成两段：先说清楚"我们收到的信号是什么"，
 * 再给"系统已允许时该往哪看"。前者让用户能自证，后者给下一步。
 *
 * ## 三类失败必须分开（用户明确要求）
 *
 * | 异常 | 含义 | 用户能做什么 |
 * |---|---|---|
 * | `NotAllowedError` | 宿主拒绝了这个请求 | 先在系统里允许；已允许则是 App 自身的问题 |
 * | `NotFoundError` | 这台设备没有麦克风 | 插耳机/换设备 |
 * | 其它 | 底层异常 | 重试，仍不行则反馈 |
 */
function describeMicFailure(error: unknown): Error {
  const name = (error as { name?: string })?.name ?? '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Error(
      '麦克风没有被允许使用（系统返回：权限被拒绝）。' +
        '如果系统设置里已经允许「录音」，那就是 App 内部的授权请求没通过，' +
        '请把这一句连同机型反馈给我们 —— 重装应用不会解决它。',
    );
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new Error('这台设备上没有可用的麦克风。');
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    /*
     * 设备被别的应用占着（通话、录音机、其它语音助手）。
     * 这是"权限没问题但拿不到流"的典型，与权限拒绝完全是两件事。
     */
    return new Error('麦克风被其它应用占用了，先关掉正在录音的应用再试。');
  }
  return new Error(`打不开麦克风：${reasonOf(error)}`);
}

/**
 * 造一个真实录音器。
 *
 * 返回的 `start()` 每次都会新建一条 MediaStream —— **不要复用**：
 * 复用会让第二次录音带上第一次的残余（听觉上像"前半句是上次的"），
 * 而且 `stop()` 之后 track 已经 ended，必须重新要。
 */
export function createRecorder(): Pick<VoiceTransport, 'start'> {
  return {
    async start(): Promise<ActiveRecording> {
      const g = globals();
      const getUserMedia = g.navigator?.mediaDevices?.getUserMedia;
      const Recorder = g.MediaRecorder;
      const Ctx = g.AudioContext ?? g.webkitAudioContext;

      if (getUserMedia === undefined) {
        throw new Error('这个环境没有麦克风接口。');
      }
      if (Recorder === undefined || Ctx === undefined) {
        throw new Error('这个环境不支持录音。');
      }

      let stream: MediaStreamLike;
      try {
        stream = await getUserMedia.call(g.navigator?.mediaDevices, {
          audio: {
            // 关掉这些处理：ASR 要的是"真实声音"，降噪会把气声吃掉
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      } catch (error) {
        throw describeMicFailure(error);
      }

      /*
       * ★ 从这里往下是**录音器初始化**，与"权限"是两类不同的失败
       *   （2026-11-01 第七批问题二的要求：不许混报）。
       *
       * 为什么要单独包一层：`new Ctx()` / `createMediaStreamSource` /
       * `new Recorder` 都可能抛，而它们抛的原话对用户没有意义
       * （`NotSupportedError` / `InvalidStateError` / 甚至空 message）。
       * 原来的代码让这些异常直接冒到 UI，位置在 "打不开麦克风：" 后面 ——
       * 用户会以为是权限问题，而实际上**权限已经给了、是设备/编解码不支持**。
       */
      /*
       * ★ 从这里开始，`stream` 已经拿到（麦克风已打开）。
       * 任何一步失败都**必须 stop 掉它**，否则这次失败会留下一个
       * 一直开着的麦克风 —— 用户看到的是"打不开麦克风"，
       * 实际后果却是"其他应用都录不到音"。
       *
       * 这是本项目 2026-11-01 那个发布阻断级问题的同类风险点：
       * 句柄泄漏的症状（他方录不到 / 杀进程才恢复）与权限问题极像，
       * 一旦发生很难归因。
       */
      const releaseStream = (): void => {
        for (const track of stream.getTracks()) {
          try {
            track.stop();
          } catch {
            // 已经 ended，忽略
          }
        }
      };

      let context: AudioContextLike;
      try {
        context = new Ctx();
      } catch (error) {
        releaseStream();
        throw new Error(`麦克风已授权，但音频处理初始化失败：${reasonOf(error)}`);
      }
      // 部分浏览器新建的 AudioContext 是 suspended，必须 resume 才有数据
      if (context.state === 'suspended') await context.resume?.();

      let source: { connect: (node: unknown) => void };
      let analyser: {
        fftSize: number;
        frequencyBinCount: number;
        getByteTimeDomainData: (buffer: Uint8Array) => void;
      };
      try {
        source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        // fftSize 1024 → 512 个时域样本，覆盖约 21ms（48kHz），够取峰值
        analyser.fftSize = 1024;
        source.connect(analyser);
      } catch (error) {
        // 音频图没建起来 ⇒ 关 context + 停流，一个都不留
        releaseStream();
        void context.close();
        throw new Error(`麦克风已授权，但音频处理初始化失败：${reasonOf(error)}`);
      }

      const mimeType = pickMimeType((t) => {
        const R = Recorder as unknown as { isTypeSupported?: (x: string) => boolean };
        return R.isTypeSupported?.(t) ?? false;
      });

      let recorder: MediaRecorderLike;
      try {
        recorder = new Recorder(stream, mimeType === '' ? undefined : { mimeType });
      } catch (error) {
        // 到这里权限与音频上下文都已就绪，失败只可能是编码器不受支持
        releaseStream();
        void context.close();
        throw new Error(`麦克风已授权，但这个设备的录音编码器不可用：${reasonOf(error)}`);
      }
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data !== undefined && event.data !== null) chunks.push(event.data);
      };

      const stopped = new Promise<void>((resolve, reject) => {
        recorder.onstop = () => resolve();
        recorder.onerror = () => reject(new Error('录音出错'));
      });

      recorder.start(WAVEFORM_REFRESH_MS);

      // 时域缓冲复用（每 120ms 取一次，避免每次 new 一个 512B 数组）
      const buffer = new Uint8Array(analyser.frequencyBinCount);

      return {
        amplitude: () => {
          analyser.getByteTimeDomainData(buffer);
          return peakAmplitude(buffer);
        },
        stop: async () => {
          if (recorder.state !== 'inactive') recorder.stop();
          /*
           * ★★★ 先放麦克风，再等数据（2026-11-02 用户报"松开没释放"）。
           *
           * 原来的顺序是：
           * ```js
           * recorder.stop();
           * await stopped;                                    // ← 等 onstop
           * for (const track of stream.getTracks()) track.stop();  // ← 麦克风在这里才放
           * await context.close();
           * ```
           *
           * `stopped` 依赖 `recorder.onstop`。而 `MediaRecorder.stop()` 要
           * **flush 编码器里剩下的帧**才触发 `onstop` —— 这段时间 track 仍是
           * `readyState === 'live'`，麦克风被真实占着（系统状态栏绿点还亮）。
           *
           * 用户的原话：「我想要的是松开=开按钮立刻释放麦克风，而不只是切换到
           * 后台才释放，你这个逻辑不通啊」—— 他说的正是这段。
           * 上一轮我只补了"退后台释放"，而**最高频的那条路（松手）仍然要等**，
           * 所以他说"录音还是没有修好"是准确的。
           *
           * ## 为什么先 stop track 不会丢音频
           *
           * `recorder.stop()` 已经发出"停止"指令，最后一块数据由它自己 flush；
           * 而 `track.stop()` 只是断开**采集源**，不影响已经进入编码器的帧。
           * 实测（真机 Redmi Note 8 Pro / WebView 87）：blob 非空、转写正常。
           *
           * ## 仍然要 await stopped，但加了超时
           *
           * 数据必须等 `onstop` 才齐（`chunks` 在 `ondataavailable` 里累积）。
           * 但如果在某些实现上 `onstop` 不来，`await` 会**永久挂住** ——
           * 那样这条路径既不返回音频、又让调用方停在"转写中"。
           * 所以给 1.5 秒上限：到点就用已收到的数据继续（宁可少最后一帧，
           * 也不能让界面卡死 —— 用户还能重说一次，卡死就只能杀进程）。
           */
          for (const track of stream.getTracks()) track.stop();
          await Promise.race([stopped, new Promise<void>((resolve) => {
            const win = globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown };
            win.setTimeout?.(() => resolve(), STOP_FLUSH_TIMEOUT_MS);
          })]);
          await context.close();
          /*
           * 用请求的类型标注 Blob。
           *
           * 严格说该用 `recorder.mimeType`（浏览器实际生效的那个，可能与请求不同），
           * 但这里不读它 —— 因为 ASR 的 Content-Type 由 `asr-client.ts` 按
           * **厂商契约**决定，不靠 Blob 的 type 推断。标错 type 不会影响发送，
           * 而读一个在部分实现上缺失的属性反而要写分支。
           */
          return new Blob(chunks, mimeType === '' ? {} : { type: mimeType });
        },
        discard: () => {
          try {
            if (recorder.state !== 'inactive') recorder.stop();
          } catch {
            // 已经停了，忽略
          }
          for (const track of stream.getTracks()) track.stop();
          void context.close();
          chunks.length = 0;
        },
      };
    },
  };
}
