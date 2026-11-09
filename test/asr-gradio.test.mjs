/**
 * Gradio 协议路线（v0.1.7 / 决策 #338）。
 *
 * ## 这组测试分两层，理由不同
 *
 * **① 纯逻辑层**（解析 / 拼地址 / 取结果）：钉住形状。
 * 这些函数出错不会抛异常，只会静默取到空或取错字段 ——
 * 比如把输出数组的 `[0]`（指标日志）当成转写文本，用户会看到
 * "⏱️ 转写耗时 3.2s" 被当成他刚说的话发出去。
 *
 * **② 全链路层**：起一个**最小 HTTP 桩**复现 `upload → call → poll`，
 * 让真实 `fetch` 真的跑一遍。这一层的价值是它能抓住
 * "单元测试全绿但两端拼不起来" —— 本项目已经吃过这个亏
 * （见 memory §66：`serde` 字段名两边各自对、拼起来每帧都被丢弃）。
 *
 * 桩的行为**照着 2026-11-01 真机探测结果写**：
 * `GET /config` 给 `api_prefix`、`GET {prefix}/info` 给参数表、
 * `POST {prefix}/upload` 回一个服务端路径数组、
 * `POST {prefix}/call/{name}` 回 `{event_id}`、
 * `GET {prefix}/call/{name}/{id}` 回 SSE（`event: complete` + 三元组数组）。
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  buildCallUrl,
  buildConfigUrl,
  buildFileData,
  buildGradioArgs,
  buildPollUrl,
  buildUploadUrl,
  classifyAsrFailure,
  extractGradioError,
  extractTranscript,
  findAsrPreset,
  GRADIO_BASE_URL_HINT,
  needsApiKey,
  normalizeGradioBase,
  parseGradioConfig,
  parseGradioInfo,
  parseSse,
  parseUploadResponse,
  pickTranscribeEndpoint,
  validateAsrConfig,
} from '@tcs/shared';

import { transcribe } from '../client/src/chat/asr-client.ts';

/* ═══════════════════════════════════════════════════════════
   ① 地址拼装
   ═══════════════════════════════════════════════════════════ */

test('★ 地址规整：尾斜杠、以及"用户把页面地址+前缀一起粘进来"', () => {
  /*
   * 三种输入都真实存在：
   * - 手打 `http://192.168.1.5:7860`
   * - 从浏览器复制 `http://192.168.1.5:7860/`
   * - 从开发者工具复制 `http://192.168.1.5:7860/gradio_api`
   *
   * 第三种的后果最隐蔽：不规整的话会拼成
   * `.../gradio_api/gradio_api/info` —— 一个必然 404 的地址，
   * 而用户会以为"服务没起来"。
   */
  assert.equal(normalizeGradioBase('http://192.168.1.5:7860'), 'http://192.168.1.5:7860');
  assert.equal(normalizeGradioBase('http://192.168.1.5:7860/'), 'http://192.168.1.5:7860');
  assert.equal(normalizeGradioBase('  http://192.168.1.5:7860//  '), 'http://192.168.1.5:7860');
  assert.equal(
    normalizeGradioBase('http://192.168.1.5:7860/gradio_api'),
    'http://192.168.1.5:7860',
  );
  assert.equal(
    normalizeGradioBase('http://192.168.1.5:7860/gradio_api/'),
    'http://192.168.1.5:7860',
  );
});

test('★ 不擅自补协议头（填了 https 就不该被降级成 http）', () => {
  assert.equal(normalizeGradioBase('https://asr.example.com'), 'https://asr.example.com');
  // 没写协议的保持原样，交给 fetch 报错 —— 我们不去猜
  assert.equal(normalizeGradioBase('192.168.1.5:7860'), '192.168.1.5:7860');
});

test('地址拼接不会出现双斜杠', () => {
  const base = 'http://192.168.1.5:7860/';
  assert.equal(buildConfigUrl(base), 'http://192.168.1.5:7860/config');
  assert.equal(buildUploadUrl(base, '/gradio_api'), 'http://192.168.1.5:7860/gradio_api/upload');
  assert.equal(
    buildCallUrl(base, '/gradio_api', 'transcribe_with_progress'),
    'http://192.168.1.5:7860/gradio_api/call/transcribe_with_progress',
  );
  // 端点名前导斜杠要给吃掉，否则拼出 `call//x`
  assert.equal(
    buildCallUrl(base, '/gradio_api', '/transcribe'),
    'http://192.168.1.5:7860/gradio_api/call/transcribe',
  );
  assert.equal(
    buildPollUrl(base, '/gradio_api', 'transcribe', 'evt-1'),
    'http://192.168.1.5:7860/gradio_api/call/transcribe/evt-1',
  );
});

/* ═══════════════════════════════════════════════════════════
   ② /config 与 /info 的解析
   ═══════════════════════════════════════════════════════════ */

test('/config 读 api_prefix（读不到用默认值，不抛错）', () => {
  assert.deepEqual(parseGradioConfig({ version: '6.2.0', api_prefix: '/gradio_api' }), {
    apiPrefix: '/gradio_api',
    version: '6.2.0',
  });
  assert.equal(parseGradioConfig({}).apiPrefix, '/gradio_api');
  assert.equal(parseGradioConfig(null).apiPrefix, '/gradio_api');
  // 前缀没带前导斜杠也要能用
  assert.equal(parseGradioConfig({ api_prefix: 'gradio_api' }).apiPrefix, '/gradio_api');
});

/** 真实 `/info` 的裁剪版（2026-11-01 从 10.9.0.3:7860 取的） */
const FUNASR_INFO = {
  named_endpoints: {
    '/update_model_dropdown': {
      parameters: [
        {
          label: '🤖 模型类型',
          parameter_has_default: true,
          parameter_default: 'fun-asr-nano',
          component: 'Dropdown',
        },
      ],
      returns: [{ component: 'Dropdown' }],
    },
    '/show_audio_info': {
      parameters: [{ label: '音频', component: 'Audio', parameter_has_default: false }],
      returns: [{ component: 'HTML' }],
    },
    '/transcribe_with_progress': {
      parameters: [
        { label: '点击上传或拖拽文件', component: 'Audio', parameter_has_default: false },
        { label: '🔗 或输入音频链接地址', component: 'Textbox', parameter_has_default: false },
        { label: '代理URL', component: 'Textbox', parameter_has_default: true, parameter_default: '' },
        { label: '用户名', component: 'Textbox', parameter_has_default: true, parameter_default: '' },
        { label: '密码', component: 'Textbox', parameter_has_default: true, parameter_default: '' },
        {
          label: '🤖 模型类型',
          component: 'Dropdown',
          parameter_has_default: true,
          parameter_default: 'fun-asr-nano',
        },
        {
          label: '📂 模型路径',
          component: 'Dropdown',
          parameter_has_default: true,
          parameter_default: './models\\Fun-ASR-Nano',
        },
        {
          label: '下载方式',
          component: 'Dropdown',
          parameter_has_default: true,
          parameter_default: 'requests',
        },
        { label: '⏱️ 开始时间（秒）', component: 'Number', parameter_has_default: false },
        { label: '⏱️ 结束时间（秒）', component: 'Number', parameter_has_default: false },
        {
          label: '📝 显示详细日志',
          component: 'Checkbox',
          parameter_has_default: true,
          parameter_default: false,
        },
      ],
      returns: [{ component: 'Textbox' }, { component: 'Textbox' }, { component: 'File' }],
    },
  },
};

test('★ 挑转写端点：有 Audio 输入 + 多路输出的那个，名字带 transcrib 优先', () => {
  const endpoints = parseGradioInfo(FUNASR_INFO);
  assert.equal(endpoints.length, 3);

  const picked = pickTranscribeEndpoint(endpoints);
  assert.ok(picked !== null);
  assert.equal(picked.name, 'transcribe_with_progress');

  /*
   * `/show_audio_info` 也有 Audio 输入，但**只有一路输出** ——
   * 它不是转写。只判"有 Audio"会挑中它，然后取 [1] 必然落空。
   */
  const audioOnly = endpoints.filter((ep) => ep.params.some((p) => p.component === 'Audio'));
  assert.equal(audioOnly.length, 2, '桩里有两个带 Audio 的端点（这正是判据要区分的）');
});

test('挑端点：指定名字就用指定的；没有 Audio 端点返回 null', () => {
  const endpoints = parseGradioInfo(FUNASR_INFO);
  assert.equal(pickTranscribeEndpoint(endpoints, 'show_audio_info')?.name, 'show_audio_info');
  assert.equal(pickTranscribeEndpoint(endpoints, 'no-such-endpoint'), null);

  const noAudio = parseGradioInfo({
    named_endpoints: {
      '/foo': { parameters: [{ component: 'Textbox' }], returns: [{}, {}] },
    },
  });
  assert.equal(pickTranscribeEndpoint(noAudio), null);
});

test('解析 /info：形状不对时给空数组（不抛错）', () => {
  assert.deepEqual(parseGradioInfo(null), []);
  assert.deepEqual(parseGradioInfo({}), []);
  assert.deepEqual(parseGradioInfo({ named_endpoints: null }), []);
});

/* ═══════════════════════════════════════════════════════════
   ③ 参数数组 —— 本路线最容易错得无声的地方
   ═══════════════════════════════════════════════════════════ */

test('★★ 参数数组按"组件类型 + 服务端默认值"填，不是按位置硬编码', () => {
  const endpoint = pickTranscribeEndpoint(parseGradioInfo(FUNASR_INFO));
  assert.ok(endpoint !== null);

  const args = buildGradioArgs(endpoint, {
    fileData: buildFileData('C:\\tmp\\gradio\\abc\\voice.wav', 'voice.wav'),
    model: 'fun-asr-nano',
    modelPath: './models/Fun-ASR-Nano',
  });

  assert.equal(args.length, 11, '参数个数必须与服务端一致');

  // [0] 音频：文件对象
  assert.equal(typeof args[0], 'object');
  assert.equal(args[0].path, 'C:\\tmp\\gradio\\abc\\voice.wav');
  assert.equal(args[0].meta._type, 'gradio.FileData');

  // [1] 音频链接：可选替代输入 → null（不是空串）
  assert.equal(args[1], null);

  // [2..4] 代理/账号/密码：用服务端默认值（空串）
  assert.deepEqual(args.slice(2, 5), ['', '', '']);

  // [5] 模型类型：用**用户配置**覆盖默认值
  assert.equal(args[5], 'fun-asr-nano');

  // [6] 模型路径：单独一个字段，不是把 model 覆盖两次
  assert.equal(args[6], './models/Fun-ASR-Nano');

  // [7] 下载方式：认不出来 → 用服务端默认值
  assert.equal(args[7], 'requests');

  // [8..9] 起止时间：无默认值 → null
  assert.deepEqual(args.slice(8, 10), [null, null]);

  // [10] 显示日志：无默认值的布尔 → false（服务端给的）
  assert.equal(args[10], false);
});

test('★ 用户改了 model 要生效（不能被服务端默认值吃掉）', () => {
  const endpoint = pickTranscribeEndpoint(parseGradioInfo(FUNASR_INFO));
  assert.ok(endpoint !== null);
  const args = buildGradioArgs(endpoint, {
    fileData: buildFileData('/tmp/x.wav', 'x.wav'),
    model: 'sensevoice',
  });
  assert.equal(args[5], 'sensevoice', '配置里选了 sensevoice 就必须发 sensevoice');
});

test('没配 modelPath 时用服务端默认值（不是空串）', () => {
  const endpoint = pickTranscribeEndpoint(parseGradioInfo(FUNASR_INFO));
  assert.ok(endpoint !== null);
  const args = buildGradioArgs(endpoint, {
    fileData: buildFileData('/tmp/x.wav', 'x.wav'),
    model: 'fun-asr-nano',
  });
  // 不传就落到 `hasDefault` 分支，服务端默认值原样带回去
  assert.equal(args[6], './models\\Fun-ASR-Nano');
});

/* ═══════════════════════════════════════════════════════════
   ④ upload 响应与 SSE 结果
   ═══════════════════════════════════════════════════════════ */

test('解析 upload 响应：字符串数组 / FileData 对象 / 单个值都认', () => {
  assert.equal(parseUploadResponse(['C:\\tmp\\a.wav']), 'C:\\tmp\\a.wav');
  assert.equal(parseUploadResponse([{ path: '/tmp/a.wav' }]), '/tmp/a.wav');
  assert.equal(parseUploadResponse('/tmp/a.wav'), '/tmp/a.wav');
  assert.equal(parseUploadResponse({ path: '/tmp/a.wav' }), '/tmp/a.wav');
  // 认不出来要给 null（让上层说"服务没有接受这个音频"），不许编一个路径
  assert.equal(parseUploadResponse([]), null);
  assert.equal(parseUploadResponse(null), null);
  assert.equal(parseUploadResponse([{ nope: 1 }]), null);
});

test('解析 SSE：按空行切块，event 缺失时按 message 处理', () => {
  const raw = [
    'event: generating',
    'data: [null, "你", null]',
    '',
    'event: complete',
    'data: [{"耗时":"3.2s"}, "你好世界", {"path":"/tmp/o.txt"}]',
    '',
  ].join('\n');

  const events = parseSse(raw);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'generating');
  assert.equal(events[1].event, 'complete');

  // 没有 event 行时不能丢数据
  assert.equal(parseSse('data: [1,2]\n\n')[0].event, 'message');
});

test('★★ 转写文本取三元组 [1]，不是"第一个字符串"', () => {
  /*
   * 这条是本路线最容易写错的地方：真机输出是 `[指标, 文本, 文件]`，
   * 而**指标在部分版本里也是字符串**（纯文本日志）。
   * 写成"找第一个字符串"就会把日志当成用户说的话发出去 ——
   * 功能看起来正常，内容全错。
   */
  const events = parseSse(
    'event: complete\ndata: [{"log":"转写耗时 3.2s"}, "这是转写文本", {"path":"/tmp/a.txt"}]\n\n',
  );
  assert.equal(extractTranscript(events), '这是转写文本');

  // 指标是字符串的版本：仍然必须取 [1]
  const stringy = parseSse('event: complete\ndata: ["转写耗时 3.2s", "真正的文本", null]\n\n');
  assert.equal(extractTranscript(stringy), '真正的文本');

  // 空串是**合法结果**（要交给"空转写"分流），不能返回 null
  const empty = parseSse('event: complete\ndata: [{"a":1}, "", null]\n\n');
  assert.equal(extractTranscript(empty), '');
});

test('没有 complete 时退到 generating 的最后一帧；都没有返回 null', () => {
  const generating = parseSse('event: generating\ndata: [null, "半句", null]\n\n');
  assert.equal(extractTranscript(generating), '半句');

  assert.equal(extractTranscript([]), null);
  assert.equal(extractTranscript(parseSse('event: heartbeat\ndata: {}\n\n')), null);
  // 不是数组 → null（不猜）
  assert.equal(extractTranscript(parseSse('event: complete\ndata: {"text":"x"}\n\n')), null);
});

test('服务端的 error 事件要原话带出来', () => {
  const events = parseSse('event: error\ndata: {"error": "模型未找到", "duration": 1.2}\n\n');
  assert.equal(extractGradioError(events), '模型未找到');

  // 不是 JSON 就用原文
  const plain = parseSse('event: error\ndata: CUDA out of memory\n\n');
  assert.equal(extractGradioError(plain), 'CUDA out of memory');

  // 没有任何说明时也要给一句话，不能给空串
  const blank = parseSse('event: error\ndata: {}\n\n');
  assert.equal(extractGradioError(blank), '服务端返回了错误但没有说明原因。');

  assert.equal(extractGradioError(parseSse('event: complete\ndata: [1,2]\n\n')), null);
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 预设与校验（key 可选）
   ═══════════════════════════════════════════════════════════ */

test('★ funasr-local 预设：协议 gradio、不需要 key、model 恒 fun-asr-nano', () => {
  const preset = findAsrPreset('funasr-local');
  assert.ok(preset !== null);
  assert.equal(preset.protocol, 'gradio');
  assert.equal(preset.requiresKey, false);
  assert.equal(preset.model, 'fun-asr-nano');
  assert.equal(preset.modelPath, './models/Fun-ASR-Nano');
  assert.equal(preset.baseUrl, '', '地址必须手填（服务在用户自己的机器上）');
  assert.equal(preset.advanced, false);
  // 提示语是需求原话
  assert.match(GRADIO_BASE_URL_HINT, /192\.168\.1\.x:7860/);
});

test('★ key 留空可以保存（不需要 key 的路线不拦）', () => {
  const result = validateAsrConfig({
    presetId: 'funasr-local',
    baseUrl: 'http://192.168.1.5:7860',
    model: 'fun-asr-nano',
    apiKey: '',
  });
  assert.deepEqual(result, { ok: true });

  // 但地址与模型还是必填
  const missing = validateAsrConfig({
    presetId: 'funasr-local',
    baseUrl: '',
    model: '',
    apiKey: '',
  });
  assert.deepEqual(missing, { ok: false, missing: ['baseUrl', 'model'] });
});

test('★ 需要 key 的路线仍然要 key（key 可选不是全局放宽）', () => {
  const result = validateAsrConfig({
    presetId: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    apiKey: '',
  });
  assert.deepEqual(result, { ok: false, missing: ['apiKey'] });
});

test('未知预设 id 按"需要 key"处理（保守）', () => {
  assert.equal(needsApiKey('funasr-local'), false);
  assert.equal(needsApiKey('groq'), true);
  assert.equal(needsApiKey('已下线的厂商'), true, '旧配置宁可多填一个字段，也不该以为不需要 key');
});

/* ═══════════════════════════════════════════════════════════
   ⑥ 错误分流：Gradio 的"连不上"要说到点子上
   ═══════════════════════════════════════════════════════════ */

test('★★ Gradio 不可达 → network 类，且文案包含防火墙与局域网互通', () => {
  /*
   * 需求原话：文案补一句"确认服务所在机器的防火墙已放行端口、手机与该机器网络互通"。
   *
   * 为什么这两句缺一不可：
   * - 只说"检查网络"，用户会去看手机有没有连 WiFi；
   * - 真实原因往往是那台机器（Windows）的防火墙拦了 7860，
   *   或者手机在 5G、机器在另一个网段。
   */
  const network = classifyAsrFailure({ errorKind: 'network', protocol: 'gradio' });
  assert.equal(network.kind, 'network');
  assert.match(network.message, /防火墙/);
  assert.match(network.message, /网络互通/);

  const timeout = classifyAsrFailure({ errorKind: 'timeout', protocol: 'gradio' });
  assert.equal(timeout.kind, 'network');
  assert.match(timeout.message, /防火墙/);
});

test('★ Gradio 的 502/503 归 network（worker 死了，不是我们配错）', () => {
  for (const status of [502, 503, 504]) {
    const failure = classifyAsrFailure({ status, protocol: 'gradio' });
    assert.equal(failure.kind, 'network', `${status} 在 gradio 上应当是 network`);
  }
  // OpenAI 兼容路线不跟着变：那边的 502 是上游问题，处置是换中转站
  assert.equal(classifyAsrFailure({ status: 502 }).kind, 'other');
});

test('★ Gradio 的 404 指向"地址/端口填错"，不是"该中转站不支持转写"', () => {
  const gradio = classifyAsrFailure({ status: 404, protocol: 'gradio' });
  assert.equal(gradio.kind, 'unsupported-endpoint');
  assert.match(gradio.message, /端口/);
  assert.doesNotMatch(gradio.message, /中转站/);

  // 原路线文案不变（定稿拍板过，不许被这次改动顺手带跑）
  const openai = classifyAsrFailure({ status: 404 });
  assert.match(openai.message, /中转站/);
});

/* ═══════════════════════════════════════════════════════════
   ⑦ 全链路：最小 HTTP 桩复现 upload / call / poll
   ═══════════════════════════════════════════════════════════ */

/** 一段最小的"WAV"（内容不重要，桩只验 mime 与字节数） */
function fakeWav() {
  return new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: 'audio/wav' });
}

/**
 * 起一个最小 Gradio 桩。
 *
 * ## 桩要复现到什么程度
 *
 * 只复现**协议**：路由、请求体形状、响应形状、SSE 分帧。
 * 不模拟推理、不模拟队列 —— 那些是服务端的事，我们要验的是
 * "我们发出去的东西对不对"与"服务端那样回的我们能读懂"。
 *
 * `state` 记录收到的请求，测试用它做**双向**断言：
 * 不只验"我们解析出了文本"，还验"我们发出去的参数数组是 11 个、位置对"。
 */
async function startFakeGradio(options = {}) {
  const state = {
    upload: null,
    callBody: null,
    callPath: '',
    pollPath: '',
    requests: [],
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.requests.push(`${req.method} ${req.url}`);

      if (req.url === '/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '6.2.0', api_prefix: '/gradio_api' }));
        return;
      }

      if (req.url === '/gradio_api/info') {
        if (options.infoStatus !== undefined && options.infoStatus !== 200) {
          res.writeHead(options.infoStatus, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(FUNASR_INFO));
        return;
      }

      if (req.url === '/gradio_api/upload' && req.method === 'POST') {
        const raw = body.toString('latin1');
        state.upload = {
          contentType: String(req.headers['content-type'] ?? ''),
          filename: /filename="([^"]*)"/.exec(raw)?.[1] ?? '',
          partType: /Content-Type:\s*([^\r\n]+)/i.exec(raw)?.[1] ?? '',
          bytes: body.length,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([options.serverPath ?? '/tmp/gradio/fake/voice.wav']));
        return;
      }

      const callMatch = /^\/gradio_api\/call\/([^/]+)$/.exec(req.url ?? '');
      if (callMatch !== null && req.method === 'POST') {
        state.callPath = callMatch[1];
        state.callBody = JSON.parse(body.toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ event_id: 'evt-123' }));
        return;
      }

      const pollMatch = /^\/gradio_api\/call\/([^/]+)\/([^/]+)$/.exec(req.url ?? '');
      if (pollMatch !== null && req.method === 'GET') {
        state.pollPath = pollMatch[2];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (options.sse !== undefined) {
          res.end(options.sse);
          return;
        }
        res.end(
          [
            'event: generating',
            'data: [null, "你", null]',
            '',
            'event: complete',
            `data: ${JSON.stringify([{ 耗时: '3.2s' }, options.text ?? '你好世界', { path: '/tmp/o.txt' }])}`,
            '',
          ].join('\n'),
        );
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('★★ 全链路：upload → call → poll 走通，转写文本正确取出', async () => {
  const fake = await startFakeGradio({ text: '今天天气不错' });
  try {
    const preset = findAsrPreset('funasr-local');
    assert.ok(preset !== null);

    const result = await transcribe({
      preset,
      baseUrl: fake.baseUrl,
      // 自建服务没有鉴权：**空 key 也必须能走通**
      apiKey: '',
      model: 'fun-asr-nano',
      modelPath: './models/Fun-ASR-Nano',
      audio: fakeWav(),
    });

    assert.equal(result.ok, true, result.ok ? '' : result.failure.message);
    if (result.ok) {
      assert.equal(result.text, '今天天气不错', '必须取三元组的 [1]，且不能带指标那一段');
    }

    /* —— 双向断言：不只是"我们读到了"，还要"我们发对了" —— */

    // ① 上传的是音频本体，且带正确 mime 与文件名
    assert.ok(fake.state.upload !== null, '应当真的上传过');
    assert.match(fake.state.upload.contentType, /multipart\/form-data/);
    assert.equal(fake.state.upload.filename, 'voice.wav');
    assert.match(fake.state.upload.partType, /audio\/wav/);

    // ② 调用的是探测出来的端点
    assert.equal(fake.state.callPath, 'transcribe_with_progress');

    // ③ 参数数组 11 个、位置对、音频是文件对象
    const args = fake.state.callBody.data;
    assert.equal(args.length, 11);
    assert.equal(typeof args[0], 'object');
    assert.equal(args[0].path, '/tmp/gradio/fake/voice.wav');
    assert.equal(args[5], 'fun-asr-nano');
    assert.equal(args[6], './models/Fun-ASR-Nano');
    assert.equal(args[8], null);
    assert.equal(args[10], false);

    // ④ 拉结果用的是同一个 event_id
    assert.equal(fake.state.pollPath, 'evt-123');

    // ⑤ 请求顺序：config → info → upload → call → poll
    assert.deepEqual(fake.state.requests, [
      'GET /config',
      'GET /gradio_api/info',
      'POST /gradio_api/upload',
      'POST /gradio_api/call/transcribe_with_progress',
      'GET /gradio_api/call/transcribe_with_progress/evt-123',
    ]);
  } finally {
    await fake.close();
  }
});

test('全链路：服务端 error 事件 → 原话报出来', async () => {
  const fake = await startFakeGradio({
    sse: 'event: error\ndata: {"error":"模型加载失败：权重目录不存在"}\n\n',
  });
  try {
    const preset = findAsrPreset('funasr-local');
    assert.ok(preset !== null);
    const result = await transcribe({
      preset,
      baseUrl: fake.baseUrl,
      apiKey: '',
      model: 'fun-asr-nano',
      audio: fakeWav(),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'other');
      assert.match(result.failure.message, /权重目录不存在/, '要带出服务端的原话，而不是我们猜的');
    }
  } finally {
    await fake.close();
  }
});

test('全链路：跑完但没有文字 → 失败文案指向"没人声/没有产出"', async () => {
  /*
   * ★ 2026-11-01 第八批：断言从「没有返回文字」改成「没有返回转写结果」。
   *
   * 不是为了让测试变绿而改 —— 是文案确实改进了两处：
   *
   * 1. 旧文案里那句「或服务端处理中断」**归因是错的**。服务端处理中断时
   *    流会被掐断，那种情况现在由 `truncated` 分支单独负责，并且说的是
   *    「连接被断开」而不是"跑完了"。把两件事塞进一句话，会让用户
   *    对着"服务跑完了"去查一件"服务没跑完"的事。
   * 2. 新文案带上了「收到 N 字节」—— 可核查的事实，用户能拿去对日志。
   *
   * 判据本身没放松：仍然要求"失败"且"文案指向内容/产出"。
   */
  const fake = await startFakeGradio({ sse: 'event: complete\ndata: [{}, null, null]\n\n' });
  try {
    const preset = findAsrPreset('funasr-local');
    assert.ok(preset !== null);
    const result = await transcribe({
      preset,
      baseUrl: fake.baseUrl,
      apiKey: '',
      model: 'fun-asr-nano',
      audio: fakeWav(),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.failure.message, /没有返回转写结果/);
      // 要带可核查的字节数，而不是只说"没有"
      assert.match(result.failure.message, /收到 \d+ 字节/);
      // 这种结局（流正常结束）**不该**说"连接被断开"
      assert.doesNotMatch(result.failure.message, /连接(被)?断开/);
    }
  } finally {
    await fake.close();
  }
});

test('全链路：空转写（""）算成功，交给上层走"空转写"分流', async () => {
  const fake = await startFakeGradio({ text: '' });
  try {
    const preset = findAsrPreset('funasr-local');
    assert.ok(preset !== null);
    const result = await transcribe({
      preset,
      baseUrl: fake.baseUrl,
      apiKey: '',
      model: 'fun-asr-nano',
      audio: fakeWav(),
    });
    /*
     * 这条边界很重要：`ok: true` + 空串 ≠ 失败。
     * 判失败会让"说了但没识别出来"和"服务坏了"混成同一句话。
     */
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.text, '');
  } finally {
    await fake.close();
  }
});

test('★★ 全链路：流被掐断时保留已收到的错误（真机踩过）', async () => {
  /*
   * 真机现象（2026-11-01）：推理中途 worker 死掉，SSE 流被直接关闭，
   * 没有结束块。`response.text()` 会抛 `TypeError: terminated`，
   * **已收到的内容全丢** —— 于是我们只能报"网络失败"，
   * 而服务端其实已经把原因发过来了。
   */
  const { createServer: create } = await import('node:http');
  const server = create((req, res) => {
    const onEnd = () => {
      if (req.url === '/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ api_prefix: '/gradio_api' }));
        return;
      }
      if (req.url === '/gradio_api/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(FUNASR_INFO));
        return;
      }
      if (req.url === '/gradio_api/upload') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(['/tmp/a.wav']));
        return;
      }
      if (req.url === '/gradio_api/call/transcribe_with_progress') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ event_id: 'evt-x' }));
        return;
      }
      // 拉结果：发一条 error 然后**直接掐断**（不写结束块）
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: error\ndata: {"error":"CUDA out of memory"}\n\n');
      setTimeout(() => res.socket?.destroy(), 30);
    };
    req.on('data', () => {});
    req.on('end', onEnd);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const preset = findAsrPreset('funasr-local');
    assert.ok(preset !== null);
    const result = await transcribe({
      preset,
      baseUrl: `http://127.0.0.1:${String(port)}`,
      apiKey: '',
      model: 'fun-asr-nano',
      audio: fakeWav(),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(
        result.failure.message,
        /CUDA out of memory/,
        '掐断前收到的错误必须保住 —— 否则用户只会看到"网络失败"',
      );
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('★ 全链路：/info 404 → 指向"端口填错了"，不是"服务没起来"', async () => {
  const fake = await startFakeGradio({ infoStatus: 404 });
  try {
    const preset = findAsrPreset('funasr-local');
    assert.ok(preset !== null);
    const result = await transcribe({
      preset,
      baseUrl: fake.baseUrl,
      apiKey: '',
      model: 'fun-asr-nano',
      audio: fakeWav(),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'unsupported-endpoint');
      assert.match(result.failure.message, /端口/);
    }
  } finally {
    await fake.close();
  }
});

test('★ 全链路：端口没人听 → network 类 + 防火墙提示', async () => {
  /*
   * 用一个**刚关掉的**端口（listen 后立刻 close）：
   * 这样确定没人听，且不会撞上别的进程。
   */
  const { createServer: create } = await import('node:http');
  const probe = create(() => {});
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const preset = findAsrPreset('funasr-local');
  assert.ok(preset !== null);
  const result = await transcribe({
    preset,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    apiKey: '',
    model: 'fun-asr-nano',
    audio: fakeWav(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.kind, 'network');
    assert.match(result.failure.message, /防火墙/);
  }
});
