/* 管理面板（无构建、无外部依赖，离线可用）。 */
(() => {
  'use strict';

  const TOKEN_KEY = 'tcs.token';
  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    status: null,
    view: 'overview',
    timer: null,
    logTimer: null,
    visibleToken: false,
    /** 治理登录的账户信息（只用于显示"你是谁"） */
    govUser: null,
  };

  const $ = (id) => document.getElementById(id);

  // ── HTTP ─────────────────────────────────────────────
  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { ...options, headers });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    if (!response.ok) {
      const message = payload && payload.error ? payload.error.message : `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function toast(message, isError = false) {
    const box = $('toast');
    box.textContent = message;
    box.classList.toggle('err', isError);
    box.hidden = false;
    clearTimeout(box._timer);
    box._timer = setTimeout(() => { box.hidden = true; }, 4200);
  }

  function fmtBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
  }

  function fmtDuration(ms) {
    if (typeof ms !== 'number' || ms < 0) return '—';
    const sec = Math.floor(ms / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    if (m > 0) return `${m} 分 ${s} 秒`;
    return `${s} 秒`;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /**
   * 归属显示：`用户名（uid）`（v0.1.3 / F2）。
   *
   * 为什么不是只显示用户名：**用户名可改、可重名**，治理页要按人辨认、
   * 审计要能回指"同一个人"，都需要一个不变的锚点 —— 那就是 uid。
   * 为什么不是只显示 uid：光看 `usr_ab12cd34` 认不出是谁。
   *
   * 查不到账户（历史仓库的 owner 被删过）时显示占位符，不回退到截断的内部 id ——
   * 那个 id 对管理员没有任何意义。
   */
  function formatOwner(item) {
    if (!item || !item.ownerId) return '—';
    if (!item.ownerUsername) return '（账户已不存在）';
    return item.ownerUid ? `${item.ownerUsername}（${item.ownerUid}）` : item.ownerUsername;
  }

  const STATE_TEXT = {
    stopped: '已停止',
    starting: '启动中',
    running: '运行中',
    stopping: '停止中',
    crashed: '异常退出',
  };
  const STATE_CLASS = { running: 'ok', stopped: 'bad', crashed: 'bad', starting: 'warn', stopping: 'warn' };

  // ── 登录 ─────────────────────────────────────────────
  function showLogin(hint) {
    $('app').hidden = true;
    $('login').hidden = false;
    $('login-hint').textContent = hint || '令牌保存在本机 localStorage，不会上传到任何地方。';
    $('login-token').focus();
  }

  async function enterApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    await refreshStatus();
    await loadConfigForm();
    switchView('overview');
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = $('login-token').value.trim();
    if (!token) return;
    state.token = token;
    try {
      await api('/control/status');
      localStorage.setItem(TOKEN_KEY, token);
      $('login-token').value = '';
      await enterApp();
    } catch (error) {
      state.token = '';
      $('login-hint').textContent = error.status === 401 ? '令牌不正确，请重试。' : `连接失败：${error.message}`;
    }
  });

  $('logout').addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    state.token = '';
    state.status = null;
    stopTimers();
    showLogin();
  });

  // ── 状态 ─────────────────────────────────────────────
  function stopTimers() {
    if (state.timer) clearInterval(state.timer);
    if (state.logTimer) clearInterval(state.logTimer);
    state.timer = null;
    state.logTimer = null;
  }

  async function refreshStatus() {
    let status;
    try {
      status = await api('/control/status');
    } catch (error) {
      if (error.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        state.token = '';
        stopTimers();
        showLogin('令牌已失效（可能被轮换），请重新输入。');
        return;
      }
      $('worker-pill').textContent = '连接中断';
      $('worker-pill').className = 'pill bad';
      return;
    }
    state.status = status;
    renderStatus(status);
    if (!state.timer) state.timer = setInterval(refreshStatus, 3000);
  }

  function renderStatus(status) {
    const worker = status.worker;
    const running = worker.state === 'running';
    $('clock').textContent = fmtTime(new Date().toISOString());
    $('foot-version').textContent = `v${status.version} · ${status.node}`;

    $('worker-pill').textContent = `worker ${STATE_TEXT[worker.state] || worker.state}`;
    $('worker-pill').className = `pill ${STATE_CLASS[worker.state] || ''}`;
    $('side-state').textContent = running ? '已连接 · 运行中' : `已连接 · ${STATE_TEXT[worker.state] || ''}`;
    $('side-state').className = `pill ${STATE_CLASS[worker.state] || ''}`;

    $('ov-state').textContent = STATE_TEXT[worker.state] || worker.state;
    $('ov-api').textContent = worker.url;
    $('ov-panel').textContent = status.urls.panel;
    $('ov-data').textContent = status.config.dataDir;
    renderProxyTrust(status.config.trustProxy ?? []);
    $('ov-exit').textContent = worker.lastExit
      ? `${fmtTime(worker.lastExit.at)}（code=${worker.lastExit.code ?? '—'}${worker.lastExit.expected ? '，预期' : ''}）`
      : '—';
    $('ov-hint').textContent = worker.lastError || '';

    $('stat-uptime').textContent = worker.uptimeMs == null ? '—' : fmtDuration(worker.uptimeMs);
    $('stat-pid').textContent = worker.pid ? `pid ${worker.pid}` : 'pid —';

    $('svc-state').textContent = STATE_TEXT[worker.state] || worker.state;
    $('svc-state').className = `big-state ${STATE_CLASS[worker.state] || ''}`;
    $('svc-pid').textContent = worker.pid ?? '—';
    $('svc-started').textContent = fmtTime(worker.startedAt);
    $('svc-restarts').textContent = String(worker.restarts);
    $('svc-health').textContent = worker.health
      ? `OK · ${worker.health.version} · ${fmtDuration(worker.health.uptimeMs)}`
      : '不可达';
    $('svc-start').disabled = running || worker.state === 'starting';
    $('svc-stop').disabled = !worker.pid;
    $('svc-restart').disabled = false;

    if (running) void refreshStats();
    else {
      $('stat-cards').textContent = '—';
      $('stat-versions').textContent = '—';
      $('stat-bytes').textContent = '—';
      $('stat-blobs').textContent = 'blob —';
    }
  }

  async function refreshStats() {
    try {
      const stats = await api('/api/stats');
      $('stat-cards').textContent = String(stats.cards);
      $('stat-versions').textContent = String(stats.versions);
      $('stat-bytes').textContent = fmtBytes(stats.bytes);
      $('stat-blobs').textContent = `blob ${stats.blobs.count} 个 · ${fmtBytes(stats.blobs.bytes)}`;
      // 「已生效代理」= 真正匹配上并改写过身份的对端地址数（不是配置条数）。
      // 配置写了但地址写错时，这里会是 0 —— 这正是我们想让管理员看到的信号。
      if (stats.proxy) {
        const hits = stats.proxy.trustedProxies ?? [];
        const detail = hits.map((item) => `${item.address} × ${item.hits}`).join('、');
        $('ov-proxy').textContent = stats.proxy.entries === 0
          ? '未信任任何代理（忽略代理头）'
          : `${hits.length} 个已生效 / 共 ${stats.proxy.entries} 条规则${detail ? ` · ${detail}` : ''}`;
      }
    } catch {
      /* worker 刚重启时可能短暂失败 */
    }
  }

  // ── 服务控制 ─────────────────────────────────────────
  async function serviceAction(action) {
    const buttons = [$('svc-start'), $('svc-stop'), $('svc-restart')];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const result = await api(`/control/service/${action}`, { method: 'POST' });
      toast(`已${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}：${STATE_TEXT[result.worker.state] || result.worker.state}`);
      await refreshStatus();
    } catch (error) {
      toast(error.message, true);
      await refreshStatus();
    }
  }

  $('svc-start').addEventListener('click', () => serviceAction('start'));
  $('svc-stop').addEventListener('click', () => serviceAction('stop'));
  $('svc-restart').addEventListener('click', () => serviceAction('restart'));

  // ── 配置 ─────────────────────────────────────────────
  // F7.3：面板监听地址旁的安全提示。非回环时常驻显示（不是一次性 toast），
  // 因为风险是"配置本身持续存在"，提示也该持续可见。
  const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
  function updateControlHostWarning() {
    const input = $('cfg-controlHost');
    const warn = $('cfg-controlHost-warn');
    if (!input || !warn) return;
    const value = input.value.trim();
    warn.hidden = LOOPBACK.includes(value);
  }

  // ── 注册策略（F12）────────────────────────────────────
  //
  // 这一段是"把配置文件里的一个枚举变成一个能安全点击的开关"。要点有三个：
  //   ① 切到「开放」必须先过确认框，且默认焦点在取消上 —— 这是唯一会让
  //      服务端对全网敞开的选项，不能靠"手滑点一下就开"；
  //   ② 风险说明是**常驻**的（改完仍显示），不是关掉就忘的 toast；
  //   ③ 「最近注册账户」只在开放时出现 —— 平时它只是噪音，开放时它是
  //      唯一的可视性来源。
  const REGISTER_MODE_LABEL = { closed: '关闭自助注册', 'admin-only': '仅管理员创建', open: '开放自助注册' };
  const REGISTER_MODE_HINT = {
    closed: '客户端不会出现注册入口。新账户只能由管理员在命令行创建。',
    'admin-only': '注册入口只对已登录的管理员显示；普通用户看不到——管理员在客户端里可以替别人建号。',
    open: '客户端会显示注册入口：任何能访问到这个 API 地址的人都能自行创建账户。',
  };

  function registerModeValue() {
    const checked = document.querySelector('input[name="cfg-registerMode"]:checked');
    return checked ? checked.value : 'closed';
  }

  function setRegisterMode(mode) {
    const inputs = Array.from(document.querySelectorAll('input[name="cfg-registerMode"]'));
    for (const input of inputs) input.checked = input.value === mode;
    updateRegisterModeUi();
  }

  function updateRegisterModeUi() {
    const mode = registerModeValue();
    const hint = $('regmode-hint');
    if (hint) hint.textContent = REGISTER_MODE_HINT[mode] || '';
    const pill = $('regmode-pill');
    if (pill) {
      pill.textContent = REGISTER_MODE_LABEL[mode] || mode;
      pill.className = `pill ${mode === 'open' ? 'warn' : mode === 'closed' ? '' : 'ok'}`;
    }
    const hostEl = $('regmode-host');
    if (hostEl) hostEl.textContent = state.status ? state.status.config.host : '—';
    const warn = $('regmode-open-warn');
    if (warn) warn.hidden = mode !== 'open';
    const wrap = $('recent-accounts-wrap');
    if (wrap) wrap.hidden = mode !== 'open';
  }

  /**
   * 切到「开放」时的确认框。
   *
   * 为什么不用 window.confirm 的一句话版本：风险有三条，而 confirm 只显示一行
   * 短文本时用户会条件反射地点确定。这里把三条风险拼成多行，并在结尾明确
   * 问一次；取消则**把选择退回去**（不留下"看起来已选开放、其实没保存"的假象）。
   */
  function confirmOpenRegistration() {
    const host = state.status ? state.status.config.host : '（未知）';
    const lines = [
      '开放自助注册有风险：',
      '',
      '1. 任何能访问到本服务端 API 的人都可以自行创建账户，不需要审核；',
      '2. 服务端按账户隔离数据，但「谁能进来」从此由网络边界决定；',
      `3. 当前 API 监听 ${host}${host === '127.0.0.1' ? '（仅本机，风险较小）' : '（非回环，公网可达）'}。`,
      '',
      '建议只在内网使用，或配合邀请制 / 代理层 IP 白名单。',
      '确定要开放自助注册吗？',
    ];
    return window.confirm(lines.join('\n'));
  }

  function wireRegisterModeInputs() {
    const inputs = Array.from(document.querySelectorAll('input[name="cfg-registerMode"]'));
    for (const input of inputs) {
      input.addEventListener('change', () => {
        if (input.value === 'open' && input.checked && !confirmOpenRegistration()) {
          // 退回上一个已保存的状态：不要在界面上留下"看起来已开放"的假象
          setRegisterMode(state.status ? state.status.config.auth.registerMode : 'closed');
          return;
        }
        updateRegisterModeUi();
      });
    }
  }

  async function loadRecentAccounts() {
    const body = $('recent-accounts-body');
    if (!body) return;
    body.replaceChildren();
    const placeholder = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'muted';
    cell.textContent = '读取中…';
    placeholder.append(cell);
    body.append(placeholder);
    try {
      const result = await api('/control/accounts?limit=20');
      body.replaceChildren();
      const items = result.items || [];
      if (items.length === 0) {
        const row = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 6;
        td.className = 'muted';
        td.textContent = '还没有任何账户。';
        row.append(td);
        body.append(row);
        return;
      }
      for (const item of items) {
        const row = document.createElement('tr');
        if (item.status === 'disabled') row.className = 'row-disabled';
        for (const text of [item.username, item.role === 'admin' ? '管理员' : '普通', item.status === 'disabled' ? '已禁用' : '启用', fmtTime(item.createdAt), item.lastLoginAt ? fmtTime(item.lastLoginAt) : '—']) {
          const td = document.createElement('td');
          td.textContent = text;
          row.append(td);
        }
        const actionCell = document.createElement('td');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `btn btn-small ${item.status === 'disabled' ? '' : 'btn-danger'}`;
        button.textContent = item.status === 'disabled' ? '启用' : '禁用';
        button.addEventListener('click', () => void setAccountStatus(item, button.textContent === '禁用' ? 'disabled' : 'active'));
        actionCell.append(button);
        row.append(actionCell);
        body.append(row);
      }
    } catch (error) {
      body.replaceChildren();
      const row = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'muted';
      td.textContent = `读取失败：${error.message}`;
      row.append(td);
      body.append(row);
    }
  }

  async function setAccountStatus(item, status) {
    const verb = status === 'disabled' ? '禁用' : '启用';
    if (!window.confirm(`${verb}账户「${item.username}」？${status === 'disabled' ? '该账户将立即无法登录（数据保留）。' : ''}`)) return;
    try {
      await api(`/control/accounts/${encodeURIComponent(item.id)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      toast(`已${verb}「${item.username}」`);
      await loadRecentAccounts();
    } catch (error) {
      // 「最后一个管理员」这类拒绝要原样展示：它解释的是"为什么点不动"
      toast(error.message, true);
    }
  }

  function fillConfigForm(config) {
    $('cfg-port').value = config.port;
    $('cfg-controlPort').value = config.controlPort;
    $('cfg-host').value = config.host;
    // 老服务端可能还没有这个字段；没有就显示默认回环，而不是留空。
    $('cfg-controlHost').value = config.controlHost || '127.0.0.1';
    updateControlHostWarning();
    $('cfg-maxUploadBytes').value = config.maxUploadBytes;
    $('cfg-dataDir').value = config.dataDir;
    $('cfg-rulesDir').value = config.rulesDir;
    $('cfg-defaultPlatformRule').value = config.defaultPlatformRule;
    $('cfg-defaultPreset').value = config.defaultPreset;
    $('cfg-logLevel').value = config.logLevel;
    $('cfg-serviceMode').value = config.service.mode;
    $('cfg-serviceName').value = config.service.name;
    $('cfg-serviceDisplayName').value = config.service.displayName;
    $('cfg-autoStart').checked = Boolean(config.service.autoStart);
    $('cfg-authRequire').checked = Boolean(config.auth.require);
    // 注册策略（F12）：回显 + 立刻刷新提示与"最近注册"区块的显隐。
    // 不回显的话保存会把 registerMode 写成 undefined → 服务端按"保持原值"处理，
    // 界面上却显示成"关闭自助注册"，管理员会以为自己的选择没生效。
    setRegisterMode(config.auth.registerMode || 'closed');
    // 每行一条：与输入框的提示文案一致，用户按回车换行不会被悄悄当成一个字符串
    $('cfg-trustProxy').value = (config.trustProxy ?? []).join('\n');
    updateTrustProxyWarning();

    /*
     * 传输安全的**兜底回显**（v0.1.3 / F4）。
     *
     * 正常路径是 `/control/tls/status` 回填（它多带证书路径与运行时指纹），
     * 但那个端点如果失败，单选框会一个都不选中 —— 而"没选中"在保存时
     * 会变成"不改 mode"（见 tlsModeValue 的注释）。这里用 configSummary 里
     * 的 tls 再兜一层，保证表单至少有值。
     */
    if (config.tls) {
      setTlsMode(config.tls.mode || 'off');
      $('cfg-tls-httpsPort').value = config.tls.httpsPort ?? 8443;
    }
  }

  /**
   * 「反代部署但没登记代理」的提示。
   *
   * 判据刻意用"面板是从哪访问的"：如果管理员正通过非回环地址打开面板
   * （说明前面有代理或直接暴露），而 trustProxy 又是空的，那大概率漏配了。
   * 本机 127.0.0.1 打开时不提示 —— 那是单人本机使用的正常形态，
   * 每次都弹一条黄色警告只会训练用户忽略提示。
   */
  function updateTrustProxyWarning() {
    const box = $('cfg-trustProxy-warn');
    if (!box) return;
    const entries = $('cfg-trustProxy').value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    const viaProxy = !/^(127\.|localhost$|\[::1\]$)/.test(location.hostname) || location.protocol === 'https:';
    box.hidden = !(entries.length === 0 && viaProxy);
  }

  function renderProxyTrust(entries) {
    const list = Array.isArray(entries) ? entries : [];
    $('ov-proxy').textContent = list.length === 0
      ? '未信任任何代理（忽略代理头）'
      : `${list.length} 条规则：${list.join('、')}`;
  }

  async function loadConfigForm() {
    try {
      const result = await api('/control/config');
      fillConfigForm(result.config);
    } catch {
      /* 状态接口里也有配置，忽略 */
    }
  }

  // ── 传输安全（v0.1.3 / F4）────────────────────────────────
  //
  // 前端在这里只做三件事：**回显**服务端状态、**调用**服务端校验、**门控**保存按钮。
  // 所有判据（什么算公网暴露、什么算证书不可用）都在服务端 —— 面板重写一遍
  // 就会出现"日志说公网暴露、面板说仅限内网"这种自相矛盾。

  const TLS_MODE_LABEL = { off: '明文（HTTP）', selfsigned: '自签证书', custom: '自定义证书' };

  /** /control/tls/status 的最近一次结果（面板上多处要用） */
  let tlsStatus = null;
  /** custom 的即时校验是否通过 —— 决定保存按钮能不能点 */
  let tlsCustomOk = true;
  let tlsCheckTimer = null;
  /** 保存请求进行中：期间一律禁用保存按钮，别让门控把它误解锁 */
  let savingConfig = false;

  /**
   * 当前选中的模式；**一个都没选中时返回空串**。
   *
   * 返回 'off' 会让"表单没回显成功"变成"保存时把 HTTPS 关掉" —— 一次读取失败
   * 就静默降级到明文，是这个模块最不该有的失败方式。空串在服务端等于
   * "mode 不合法 → 保持原值"，也就是什么都不改。
   */
  function tlsModeValue() {
    const picked = document.querySelector('input[name="cfg-tls-mode"]:checked');
    return picked === null ? '' : picked.value;
  }

  function setTlsMode(mode) {
    for (const input of document.querySelectorAll('input[name="cfg-tls-mode"]')) {
      input.checked = input.value === mode;
    }
    applyTlsModeUi();
  }

  function applyTlsModeUi() {
    const mode = tlsModeValue();
    $('tls-selfsigned-box').hidden = mode !== 'selfsigned';
    $('tls-custom-box').hidden = mode !== 'custom';
    updateTlsSaveGate();
  }

  /**
   * 保存按钮的门控。
   *
   * 需求第 1 条：不匹配**禁止保存**。前端禁用只是 UX，真正的判据在
   * `PUT /control/config` 里（同一段 inspect 实现再拦一次）——
   * 只做前端等于把安全交给浏览器。
   */
  function updateTlsSaveGate() {
    const blocked = savingConfig || (tlsModeValue() === 'custom' && tlsCustomOk !== true);
    $('cfg-save').disabled = blocked;
    if (!savingConfig && tlsModeValue() === 'custom' && tlsCustomOk !== true) {
      $('cfg-save').title = '自定义证书未通过校验：请先修正证书与私钥（下方有具体原因）';
    } else {
      $('cfg-save').removeAttribute('title');
    }
  }

  function renderTlsBanners(banners) {
    const box = $('tls-banners');
    box.replaceChildren();
    const list = Array.isArray(banners) ? banners : [];
    box.hidden = list.length === 0;
    for (const banner of list) {
      const wrap = document.createElement('div');
      wrap.className = `tls-banner ${banner.level === 'danger' ? 'is-danger' : 'is-warn'}`;
      wrap.dataset.code = banner.code;
      const title = document.createElement('p');
      title.className = 'tls-banner-title';
      title.textContent = banner.level === 'danger' ? `⚠ ${banner.title}` : banner.title;
      const body = document.createElement('p');
      body.className = 'tls-banner-body';
      body.textContent = banner.body;
      wrap.append(title, body);
      box.append(wrap);
    }
  }

  /**
   * 监听状态行。
   *
   * 必须带"数据来源 + 采样时间"（需求第 1 条明确要求）：面板是快照，
   * 用户可能开着页面去改配置、去点重启，回来看到的还是十分钟前的状态。
   * 没有时间戳，"HTTPS 未监听"分不清是现在还是十分钟前。
   */
  function renderTlsListen(status) {
    const box = $('tls-listen');
    box.replaceChildren();
    const row = (label, value, tone) => {
      const line = document.createElement('div');
      line.className = 'tls-listen-row';
      const tag = document.createElement('span');
      tag.className = 'tls-listen-label';
      tag.textContent = label;
      const text = document.createElement('span');
      text.className = tone ? `tls-listen-value is-${tone}` : 'tls-listen-value';
      text.textContent = value;
      line.append(tag, text);
      box.append(line);
    };

    const listening = status.listening || {};
    const http = listening.http || null;
    const https = listening.https || null;
    row('HTTP', http ? `监听中 ${http.host}:${http.port}` : '状态未知（数据面未运行）', http ? 'ok' : 'bad');
    row('HTTPS', https ? `监听中 ${https.host}:${https.port}` : '未监听', https ? 'ok' : 'idle');
    row(
      '数据来源',
      `${status.source === 'none' ? '无（数据面未运行）' : status.source} · 采样时间 ${fmtTime(status.sampledAt)}`,
    );
    if (status.note) row('说明', status.note, 'idle');
  }

  function renderTlsSelfSigned(status) {
    const runtime = status.runtime || null;
    const fingerprint = runtime && runtime.fingerprint ? runtime.fingerprint : '';
    $('tls-fingerprint').textContent = fingerprint === '' ? '—（还没有证书）' : fingerprint;
    $('tls-days').textContent =
      runtime && typeof runtime.daysUntilExpiry === 'number' ? String(runtime.daysUntilExpiry) : '—';
    $('tls-notafter').textContent = runtime && runtime.notAfter ? fmtTime(runtime.notAfter) : '—';
    $('tls-cert-subject').textContent = runtime && runtime.subject ? runtime.subject : '';
    $('tls-backup-hint').textContent = status.config && status.config.backupDir
      ? `重新生成时，旧证书与私钥会自动备份到 ${status.config.backupDir}（文件名含时间戳）。`
      : '';
  }

  /**
   * 把服务端状态刷到面板上。
   *
   * `overwriteForm=false` 用于"保存后刷新"以外的场景：用户可能正在输入路径，
   * 无条件回填会把他刚敲的字符冲掉（体验上与"点了没反应"一样糟）。
   */
  function applyTlsStatus(status, overwriteForm) {
    tlsStatus = status;
    const config = status.config || {};
    $('tls-mode-pill').textContent = TLS_MODE_LABEL[config.mode] || config.mode || '—';
    $('tls-mode-pill').dataset.mode = config.mode || '';
    renderTlsBanners(status.banners);
    renderTlsListen(status);
    renderTlsSelfSigned(status);

    if (overwriteForm === true) {
      setTlsMode(config.mode || 'off');
      $('cfg-tls-httpsPort').value = config.httpsPort ?? 8443;
      $('cfg-tls-certPath').value = config.certPath || '';
      $('cfg-tls-keyPath').value = config.keyPath || '';
      // 已经是 custom 且服务端认这份证书：不要一上电就显示"未通过校验"
      tlsCustomOk = config.mode !== 'custom' || config.customConfigured === true;
      if (config.mode === 'custom') {
        void checkTlsCustom();
      } else {
        $('tls-check').className = 'tls-check';
        $('tls-check').textContent = '—';
        updateTlsSaveGate();
      }
    }
  }

  async function loadTlsStatus(overwriteForm) {
    try {
      const status = await api('/control/tls/status');
      applyTlsStatus(status, overwriteForm === true);
    } catch (error) {
      $('tls-listen').textContent = `读取传输安全状态失败：${error.message}`;
    }
  }

  async function checkTlsCustom() {
    const box = $('tls-check');
    box.className = 'tls-check is-checking';
    box.textContent = '正在检查证书与私钥是否匹配…';
    try {
      const check = await api('/control/tls/inspect', {
        method: 'POST',
        body: JSON.stringify({
          mode: 'custom',
          certPath: $('cfg-tls-certPath').value.trim(),
          keyPath: $('cfg-tls-keyPath').value.trim(),
        }),
      });
      tlsCustomOk = check.canSave === true;
      box.className = `tls-check is-${check.level}`;
      box.replaceChildren();
      const head = document.createElement('p');
      head.className = 'tls-check-title';
      head.textContent = `${check.canSave ? '✔' : '✘'} ${check.message}`;
      box.append(head);
      if (Array.isArray(check.problems) && check.problems.length > 0) {
        const list = document.createElement('ul');
        list.className = 'bullets';
        for (const line of check.problems) {
          const item = document.createElement('li');
          item.textContent = line;
          list.append(item);
        }
        box.append(list);
      }
      if (check.canSave && check.certPath) {
        const pathLine = document.createElement('p');
        pathLine.className = 'hint';
        pathLine.textContent = `实际读取：${check.certPath}`;
        box.append(pathLine);
      }
    } catch (error) {
      tlsCustomOk = false;
      const details = error.payload && error.payload.error ? error.payload.error.details : null;
      box.className = 'tls-check is-bad';
      box.textContent = `检查失败：${error.message}${
        details && Array.isArray(details.problems) ? `（${details.problems.join('；')}）` : ''
      }`;
    }
    updateTlsSaveGate();
  }

  /** 输入路径时 debounce 检查：每敲一个字就发一次请求既没用也吵 */
  function scheduleTlsCheck() {
    tlsCustomOk = false;
    updateTlsSaveGate();
    clearTimeout(tlsCheckTimer);
    tlsCheckTimer = setTimeout(() => void checkTlsCustom(), 400);
  }

  for (const input of document.querySelectorAll('input[name="cfg-tls-mode"]')) {
    input.addEventListener('change', () => {
      applyTlsModeUi();
      if (tlsModeValue() === 'custom') void checkTlsCustom();
    });
  }
  $('cfg-tls-certPath').addEventListener('input', scheduleTlsCheck);
  $('cfg-tls-keyPath').addEventListener('input', scheduleTlsCheck);

  /*
   * 重新生成：**两步确认**，不用 `window.confirm`。
   *
   * 换证书会让所有客户端下次连接看到"证书变了"，属于不可轻率的操作；
   * 而原生 confirm 在无头截图里完全看不见（F3 决策 #143 已经踩过）。
   * 第一次点把按钮变成"确认"，6 秒内不点就自动收回。
   */
  let regenTimer = null;
  function resetRegenerateButton() {
    const button = $('tls-regenerate');
    button.dataset.armed = '0';
    button.textContent = '重新生成证书';
  }
  $('tls-regenerate').addEventListener('click', async () => {
    const button = $('tls-regenerate');
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1';
      button.textContent = '确认：立刻换新证书？';
      clearTimeout(regenTimer);
      regenTimer = setTimeout(resetRegenerateButton, 6000);
      return;
    }
    clearTimeout(regenTimer);
    resetRegenerateButton();
    button.disabled = true;
    $('tls-regenerate-msg').textContent = '正在生成…';
    try {
      const result = await api('/control/tls/regenerate', { method: 'POST' });
      const reloadNote =
        result.reload && result.reload.attempted
          ? result.reload.ok
            ? '已热更（服务未重启）'
            : `热更失败：${result.reload.error || ''}`
          : result.note || '';
      /*
       * ACL 收紧失败是**降级提示**，不是失败：证书已经生成好、HTTPS 可用，
       * 只是私钥可能对同机其他用户可读。显示服务端给的脱敏原因
       * （不再显示 icacls 的原始 stderr —— 那是内部路径 + 控制台编码乱码）。
       */
      const aclWarn =
        Array.isArray(result.warnings) && result.warnings.length > 0
          ? ` · 注意：${String(result.warnings[0])}`
          : '';
      $('tls-regenerate-msg').textContent = `新指纹 ${String(result.info.fingerprint).slice(0, 23)}… · ${reloadNote}${aclWarn}`;
      toast(aclWarn === '' ? '已重新生成自签证书' : '证书已生成，但私钥权限未能收紧（详见提示）');
      await loadTlsStatus(false);
    } catch (error) {
      // 服务端已把消息脱敏（去掉 Command failed 前缀与绝对路径）
      $('tls-regenerate-msg').textContent = `生成失败：${error.message}`;
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  applyTlsModeUi();

  $('cfg-controlHost').addEventListener('input', updateControlHostWarning);
  wireRegisterModeInputs();
  $('recent-refresh').addEventListener('click', () => void loadRecentAccounts());
  $('cfg-trustProxy').addEventListener('input', updateTrustProxyWarning);

  $('cfg-save').addEventListener('click', async () => {
    const payload = {
      port: Number($('cfg-port').value),
      controlPort: Number($('cfg-controlPort').value),
      host: $('cfg-host').value.trim(),
      controlHost: $('cfg-controlHost').value.trim(),
      maxUploadBytes: Number($('cfg-maxUploadBytes').value),
      dataDir: $('cfg-dataDir').value.trim(),
      rulesDir: $('cfg-rulesDir').value.trim(),
      defaultPlatformRule: $('cfg-defaultPlatformRule').value.trim(),
      defaultPreset: $('cfg-defaultPreset').value.trim(),
      logLevel: $('cfg-logLevel').value,
      // 显式传数组：即使是空数组也要传（"清空 trustProxy"是一个合法意图，
      // 不传会让服务端按"字段缺席＝保持原值"处理，用户就清不掉了）
      trustProxy: $('cfg-trustProxy').value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter((item) => item !== ''),
      service: {
        mode: $('cfg-serviceMode').value,
        name: $('cfg-serviceName').value.trim(),
        displayName: $('cfg-serviceDisplayName').value.trim(),
        autoStart: $('cfg-autoStart').checked,
      },
      auth: {
        require: $('cfg-authRequire').checked,
        registerMode: registerModeValue(),
      },
      /*
       * 传输安全（v0.1.3 / F4）。
       *
       * 路径**只在 custom 模式下发**：off / selfsigned 下那两个输入框是隐藏的，
       * 发空串会把用户之前配好的证书路径清掉。服务端对 tls 的语义是
       * "字段缺席＝保持原值"，正是为这种分模式表单设计的。
       */
      tls: {
        mode: tlsModeValue(),
        httpsPort: Number($('cfg-tls-httpsPort').value),
        ...(tlsModeValue() === 'custom'
          ? {
              certPath: $('cfg-tls-certPath').value.trim(),
              keyPath: $('cfg-tls-keyPath').value.trim(),
            }
          : {}),
      },
    };
    savingConfig = true;
    updateTlsSaveGate();
    try {
      const result = await api('/control/config', { method: 'PUT', body: JSON.stringify(payload) });
      fillConfigForm(result.config);
      $('cfg-msg').textContent = result.note || '已保存';
      const hotReloaded = result.tlsReload && result.tlsReload.attempted && result.tlsReload.ok;
      toast(hotReloaded ? '已保存并热更（服务未重启）' : '配置已保存');
      await refreshStatus();
      // 保存后重读一次：证书指纹 / 监听端口 / 警告都可能刚变
      await loadTlsStatus(true);
      // 保存后刷新一次：换了策略时"最近注册账户"的显隐要立刻跟着变
      if (registerModeValue() === 'open') await loadRecentAccounts();
    } catch (error) {
      toast(error.message, true);
      /*
       * 证书类错误要把逐条原因显示出来（需求：不匹配时"回显原因"）。
       * 只显示一句"自定义证书不可用"等于让用户自己去猜是哪个文件的问题。
       */
      const details = error.payload && error.payload.error ? error.payload.error.details : null;
      const extra = details && Array.isArray(details.problems) ? `：${details.problems.join('；')}` : '';
      $('cfg-msg').textContent = `${error.message}${extra}`;
    } finally {
      savingConfig = false;
      updateTlsSaveGate();
    }
  });

  // ── 日志 ─────────────────────────────────────────────
  async function refreshLogs() {
    try {
      const result = await api('/control/logs?lines=300');
      const box = $('log-box');
      const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
      box.textContent = result.worker.length ? result.worker.join('\n') : '（暂无日志）';
      if (stick) box.scrollTop = box.scrollHeight;
      $('log-path').textContent = state.status ? `完整日志：${state.status.paths.logFile}` : '';
    } catch (error) {
      $('log-box').textContent = `读取日志失败：${error.message}`;
    }
  }

  $('logs-refresh').addEventListener('click', refreshLogs);
  $('logs-auto').addEventListener('change', () => {
    if (state.logTimer) clearInterval(state.logTimer);
    state.logTimer = null;
    if ($('logs-auto').checked) state.logTimer = setInterval(refreshLogs, 4000);
  });

  // ── 令牌 ─────────────────────────────────────────────
  $('token-show').addEventListener('click', async () => {
    if (state.visibleToken) {
      state.visibleToken = false;
      $('token-input').value = '（已隐藏，点击显示）';
      return;
    }
    try {
      const result = await api('/control/token/reveal', { method: 'POST' });
      state.visibleToken = true;
      $('token-input').value = result.token;
    } catch (error) {
      toast(error.message, true);
    }
  });

  $('token-copy').addEventListener('click', async () => {
    try {
      const value = state.visibleToken ? $('token-input').value : '';
      if (!value) { toast('先点「显示」再复制'); return; }
      await navigator.clipboard.writeText(value);
      toast('令牌已复制');
    } catch {
      toast('复制失败，请手动选择文本', true);
    }
  });

  $('token-rotate').addEventListener('click', async () => {
    if (!confirm('轮换后旧令牌立即失效，并会重启后台服务。继续？')) return;
    try {
      const result = await api('/control/token/rotate', { method: 'POST' });
      state.token = result.token;
      localStorage.setItem(TOKEN_KEY, result.token);
      state.visibleToken = true;
      $('token-input').value = result.token;
      toast('令牌已轮换，新令牌已填入上方输入框');
      await refreshStatus();
    } catch (error) {
      toast(error.message, true);
    }
  });

  // ── 全站治理（F13 / T10.20）──────────────────────────
  //
  // 这里的请求**不能**复用 api()：那个函数总是带面板的访问令牌，
  // 而治理需要管理员账户的 JWT（全局令牌已被降权，看不到别人账户的卡片）。
  // 所以单独一个 govApi()，只带治理令牌，并且只放在 sessionStorage。
  const GOV_KEY = 'tcs.gov.token';
  let govToken = sessionStorage.getItem(GOV_KEY) || '';

  async function govApi(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (govToken) headers.Authorization = `Bearer ${govToken}`;
    if (options.body) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { ...options, headers });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    if (!response.ok) {
      const message = payload && payload.error ? payload.error.message : `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function govLoggedIn() {
    return govToken !== '';
  }

  function renderGovGate() {
    $('gov-login-card').hidden = govLoggedIn();
    $('gov-panel').hidden = !govLoggedIn();
    if (govLoggedIn() && state.govUser) {
      $('gov-who').textContent = `已登录：${state.govUser.username}（${state.govUser.role === 'admin' ? '管理员' : '普通账户'}）`;
    }
  }

  async function govLogin() {
    const username = $('gov-username').value.trim();
    const password = $('gov-password').value;
    if (username === '' || password === '') {
      $('gov-login-msg').textContent = '请填写用户名与密码';
      return;
    }
    $('gov-login').disabled = true;
    $('gov-login-msg').textContent = '登录中…';
    try {
      // 登录走 worker 的免鉴权端点（不需要面板令牌）
      const result = await govApi('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      govToken = result.accessToken;
      sessionStorage.setItem(GOV_KEY, govToken);
      state.govUser = result.user || { username, role: 'admin' };
      $('gov-password').value = '';
      $('gov-login-msg').textContent = '';
      renderGovGate();
      await loadGovernance();
    } catch (error) {
      // 失败原因照服务端原话显示（INVALID_CREDENTIALS 之类），不本地化：
      // 服务端刻意把"用户不存在/密码错/被锁"合并成一句，前端再拆就是帮倒忙
      $('gov-login-msg').textContent = `登录失败：${error.message}`;
    } finally {
      $('gov-login').disabled = false;
    }
  }

  function govLogout() {
    govToken = '';
    state.govUser = null;
    sessionStorage.removeItem(GOV_KEY);
    renderGovGate();
  }

  async function loadGovernance() {
    if (!govLoggedIn()) return;
    await Promise.all([loadGovAccounts(), loadGovRepos(), loadGovCards(), loadGovAudit()]);
  }

  async function loadGovAccounts() {
    const body = $('gov-accounts');
    try {
      const result = await api('/control/accounts?limit=200');
      const items = result.items || [];
      renderGovTable(body, 7, items, (item) => {
        const cells = [item.username, item.uid || '—', item.role === 'admin' ? '管理员' : '普通', item.status === 'disabled' ? '已禁用' : '启用', fmtTime(item.createdAt), item.lastLoginAt ? fmtTime(item.lastLoginAt) : '—'];
        const action = document.createElement('span');
        action.className = 'btn-group';
        const statusButton = document.createElement('button');
        statusButton.type = 'button';
        statusButton.className = `btn btn-small ${item.status === 'disabled' ? '' : 'btn-danger'}`;
        statusButton.textContent = item.status === 'disabled' ? '启用' : '禁用';
        statusButton.addEventListener('click', async () => {
          const verb = item.status === 'disabled' ? '启用' : '禁用';
          if (!window.confirm(`${verb}账户「${item.username}」？`)) return;
          try {
            await api(`/control/accounts/${encodeURIComponent(item.id)}/status`, {
              method: 'POST',
              body: JSON.stringify({ status: item.status === 'disabled' ? 'active' : 'disabled' }),
            });
            toast(`已${verb}「${item.username}」`);
            await loadGovAccounts();
          } catch (error) {
            toast(error.message, true);
          }
        });
        action.append(statusButton);

        /*
         * 注销账户（v0.1.3 / F3，需求 2）。
         *
         * 走 govApi（管理员 JWT 直连 worker 的 /api/accounts/:id），
         * 不走 `/control/accounts/...` —— 那个控制端口只打开 users 表，
         * 删不掉卡片、版本、令牌与 git 仓库。
         *
         * 二次确认**必须输入用户名**：`window.confirm` 那种单点确定
         * 对一个物理删除操作是不够的（手滑一下就没了）。
         */
        const purgeButton = document.createElement('button');
        purgeButton.type = 'button';
        purgeButton.className = 'btn btn-small btn-danger';
        purgeButton.textContent = '注销…';
        purgeButton.dataset.role = 'gov-account-purge';
        purgeButton.dataset.accountId = item.id;
        purgeButton.addEventListener('click', () => void govPurgeAccount(item));
        action.append(purgeButton);
        return { cells, action };
      });
    } catch (error) {
      body.replaceChildren(govMessageRow(7, `读取失败：${error.message}`));
    }
  }

  /**
   * 注销审计（v0.1.3 / F3，需求 3）。
   *
   * 走 `/api/audit/account-purges` 而不是拉 `/api/events?all=true` 再前端筛：
   * 分页 + 前端过滤会漏 —— 最近 50 条里可能一条注销事件都没有，
   * 于是"查过了，没有"这个结论是假的。服务端在 SQL 里筛，分页边界才对。
   */
  async function loadGovAudit() {
    const body = $('gov-audit');
    try {
      const result = await govApi('/api/audit/account-purges?limit=50');
      const items = result.items || [];
      if (result.retentionDays) {
        $('gov-audit-hint').textContent =
          `审计事件保留 ${result.retentionDays} 天；账户注销后这些记录仍然保留，` +
          '用于追溯"谁在什么时候注销了谁"。';
      }
      if (items.length === 0) {
        body.replaceChildren(govMessageRow(6, '还没有任何账户被注销'));
        return;
      }
      renderGovTable(body, 6, items, (item) => {
        const detail = item.counts
          ? `${item.counts.cards ?? 0} 卡 / ${item.counts.versions ?? 0} 版本 / ${item.counts.repos ?? 0} 仓库 / ${item.counts.repoTokens ?? 0} 令牌`
          : '—';
        const target = item.targetUsername
          ? `${item.targetUsername}（${item.targetUid || '—'}）`
          : item.targetUid || '—';
        return {
          cells: [
            fmtTime(item.at),
            item.actor || '—',
            target,
            item.path === 'admin' ? '管理员' : item.path === 'self' ? '自助' : '—',
            item.ip || '—',
            detail,
          ],
          action: null,
        };
      });
    } catch (error) {
      body.replaceChildren(govMessageRow(6, `读取失败：${error.message}`));
    }
  }

  // ── 注销账户（v0.1.3 / F3，需求 2）──────────────────────────
  //
  // 与客户端那条路径同一套交互：警告 → 统计"将删除什么" → 必须手打用户名 → 实心危险按钮。
  // 二次确认放在这里而不是 window.confirm，是因为后者只有一个"确定"按钮，
  // 而这是物理删除（没有回收站）。
  let purgeTarget = null; // { id, username, uid }

  function purgeMatches() {
    const typed = $('gov-purge-confirm-username').value.trim();
    if (!purgeTarget || typed === '') return false;
    return typed.toLowerCase() === purgeTarget.username.toLowerCase();
  }

  function purgeResync() {
    $('gov-purge-submit').disabled = !purgeMatches();
    if (purgeMatches()) $('gov-purge-msg').textContent = '';
  }

  function closeGovPurge() {
    $('gov-purge-overlay').hidden = true;
    $('gov-purge-confirm-username').value = '';
    $('gov-purge-msg').textContent = '';
    purgeTarget = null;
  }

  async function govPurgeAccount(item) {
    purgeTarget = { id: item.id, username: item.username, uid: item.uid || '' };
    $('gov-purge-overlay').hidden = false;
    $('gov-purge-expect').textContent = item.username;
    $('gov-purge-confirm-username').value = '';
    $('gov-purge-msg').textContent = '';
    $('gov-purge-submit').disabled = true;
    $('gov-purge-summary').textContent = '正在统计该账户下的数据…';

    /*
     * 统计走 `/api/accounts/:id/summary`（管理员版），一次请求拿全。
     *
     * 为什么不在前端用 `/api/cards?all=true` 自己数：CardSummary **不含 ownerId**，
     * 前端没有可靠办法把卡归到某个账户（第一版就是这么写的，数出来恒为 0）。
     * 而且这个端点与客户端那条路径共用服务端的 `summarizeAccount`，
     * 口径与真正删除时完全一致。
     */
    try {
      const stats = await govApi(`/api/accounts/${encodeURIComponent(item.id)}/summary`);
      $('gov-purge-summary').textContent =
        `将永久删除：${stats.cards} 张角色卡（含回收站）、${stats.versions} 个历史版本、` +
        `${stats.repos} 个仓库、${stats.repoTokens} 个仓库令牌。` +
        `${stats.sessions} 个登录会话会同时失效。`;
    } catch (error) {
      // 读不到就明说，不编数字（"将删除 0 张卡"是最危险的谎）
      $('gov-purge-summary').textContent =
        `无法读取数据统计（${error.message}）—— 注销仍会删除该账户的全部数据`;
    }
    $('gov-purge-confirm-username').focus();
  }

  async function submitGovPurge() {
    if (!purgeTarget || !purgeMatches()) return;
    const button = $('gov-purge-submit');
    button.disabled = true;
    button.textContent = '正在注销…';
    try {
      const result = await govApi(`/api/accounts/${encodeURIComponent(purgeTarget.id)}`, { method: 'DELETE' });
      const counts = result.counts || {};
      toast(`已注销「${result.username}」：${counts.cards ?? 0} 张卡、${counts.repos ?? 0} 个仓库已清除`);
      closeGovPurge();
      await loadGovernance();
    } catch (error) {
      // 服务端原话：可能是"最后一名管理员""管理员不能注销自己"这类规则拒绝
      $('gov-purge-msg').textContent = `注销失败：${error.message}`;
    } finally {
      button.textContent = '永久注销';
      purgeResync();
    }
  }

  $('gov-purge-confirm-username').addEventListener('input', purgeResync);
  $('gov-purge-cancel').addEventListener('click', closeGovPurge);
  $('gov-purge-close').addEventListener('click', closeGovPurge);
  $('gov-purge-submit').addEventListener('click', () => void submitGovPurge());
  $('gov-purge-overlay').addEventListener('click', (event) => {
    if (event.target === $('gov-purge-overlay')) closeGovPurge();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('gov-purge-overlay').hidden) closeGovPurge();
  });

  async function loadGovRepos() {    const body = $('gov-repos');
    try {
      const result = await govApi('/api/repos?all=true');
      const items = result.items || [];
      renderGovTable(body, 5, items, (item) => {
        const cells = [item.name, formatOwner(item), `${item.cardCount} 张`, item.isDefault ? '默认' : ''];
        const action = document.createElement('span');
        if (item.isDefault) {
          action.className = 'muted';
          action.textContent = '默认仓库不可删';
        } else {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn btn-small btn-danger';
          button.textContent = '删除…';
          button.addEventListener('click', () => void govDeleteRepo(item));
          action.append(button);
        }
        return { cells, action };
      });
    } catch (error) {
      body.replaceChildren(govMessageRow(5, `读取失败：${error.message}`));
    }
  }

  async function govDeleteRepo(repo) {
    let transferTo = null;
    if (repo.cardCount > 0) {
      const target = window.prompt(
        `「${repo.name}」里有 ${repo.cardCount} 张卡，输入目标仓库 id（转移后再删）：`,
      );
      if (target === null) return;
      transferTo = target.trim();
      if (transferTo === '') return;
    }
    if (!window.confirm(`删除仓库「${repo.name}」？${transferTo ? '卡片会先转移。' : ''}`)) return;
    try {
      const result = await govApi(`/api/repos/${encodeURIComponent(repo.id)}`, {
        method: 'DELETE',
        body: JSON.stringify({ transferTo, reason: '管理面板治理' }),
      });
      toast(`已删除「${repo.name}」（转移 ${result.movedCards} 张，吊销 ${result.revokedTokens} 个令牌）`);
      await loadGovernance();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function loadGovCards() {
    const body = $('gov-cards');
    try {
      const [cards, repos] = await Promise.all([
        /*
         * `includeDeleted=true` 是**必须**的：治理页的「彻底清除」绝大多数时候
         * 对象正是回收站里的卡。不列出来的话，管理员在面板上根本够不到它们 ——
         * 而这是 purge 唯一的图形入口（测试实测表里找不到那行）。
         */
        govApi('/api/cards?all=true&includeDeleted=true&limit=200'),
        govApi('/api/repos?all=true'),
      ]);
      const repoOptions = repos.items || [];
      renderGovTable(body, 7, cards.items || [], (item) => {
        // 回收站里的卡要显式标注：否则它在表里和正常卡长得一样，
        // 管理员会以为"这张卡好好的，为什么要清除"
        const state = item.deletedAt ? '回收站' : '正常';
        const cells = [item.name, item.id, item.repoName || '—', `v${item.latestSeq ?? 0}`, state, fmtTime(item.updatedAt)];
        const wrap = document.createElement('span');

        const moveButton = document.createElement('button');
        moveButton.type = 'button';
        moveButton.className = 'btn btn-small';
        moveButton.textContent = '移动…';
        moveButton.addEventListener('click', async () => {
          const options = repoOptions.map((repo, index) => `${index + 1}. ${repo.name}（${formatOwner(repo)}）`).join('\n');
          const answer = window.prompt(`把「${item.name}」移到哪个仓库？输入编号：\n\n${options}`, '1');
          if (answer === null) return;
          const target = repoOptions[Number.parseInt(answer.trim(), 10) - 1];
          if (!target) {
            toast('没有选中有效的仓库', true);
            return;
          }
          const reason = window.prompt('移动原因（会写进审计，可留空）：', '') ?? '';
          try {
            const result = await govApi(`/api/cards/${encodeURIComponent(item.id)}/move`, {
              method: 'POST',
              body: JSON.stringify({ repo: target.id, reason }),
            });
            toast(result.crossOwner ? '已跨账户移动（归属已转）' : '已移动');
            await loadGovernance();
          } catch (error) {
            toast(error.message, true);
          }
        });

        const purgeButton = document.createElement('button');
        purgeButton.type = 'button';
        purgeButton.className = 'btn btn-small btn-danger';
        purgeButton.textContent = '彻底清除';
        purgeButton.addEventListener('click', async () => {
          // 两次确认：这是唯一不可逆的卡片操作
          if (!window.confirm(`彻底清除「${item.name}」？\n\n将物理删除索引、Git 仓库与无引用的内容块。`)) return;
          if (!window.confirm(`再确认一次：清除后无法恢复，也没有回收站。继续？`)) return;
          try {
            const result = await govApi(`/api/cards/${encodeURIComponent(item.id)}/purge`, { method: 'POST' });
            toast(`已清除（释放 ${result.freedBlobs} 个内容块）`);
            await loadGovernance();
          } catch (error) {
            toast(error.message, true);
          }
        });

        wrap.append(moveButton, document.createTextNode(' '), purgeButton);
        return { cells, action: wrap };
      });
    } catch (error) {
      body.replaceChildren(govMessageRow(7, `读取失败：${error.message}`));
    }
  }

  function govMessageRow(cols, text) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = cols;
    cell.className = 'muted';
    cell.textContent = text;
    row.append(cell);
    return row;
  }

  /** 统一的表格渲染：cells 是文本数组，action 是最后一个单元格里的节点 */
  function renderGovTable(body, cols, items, build) {
    body.replaceChildren();
    if (items.length === 0) {
      body.append(govMessageRow(cols, '（没有数据）'));
      return;
    }
    for (const item of items) {
      const row = document.createElement('tr');
      const { cells, action } = build(item);
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        row.append(td);
      }
      /*
       * action 为 null 表示这张表没有操作列（例如注销审计：它是只读记录）。
       *
       * 不能无条件 append：`Node.append(null)` 会把 null 转成**字符串 "null"**
       * 塞进单元格 —— 于是审计表最后一列会显示一个 "null"。
       * 更不能反正都是空就 append 一个空 td：那会让列数与 thead 对不上，
       * 表格整体右移一格。
       */
      if (action !== null && action !== undefined) {
        const last = document.createElement('td');
        last.append(action);
        row.append(last);
      }
      body.append(row);
    }
  }

  // 审计卡片的刷新按钮：如果不绑，它是一个点了没反应的按钮（比不摆更糟）
  $('gov-audit-refresh').addEventListener('click', () => void loadGovAudit());

  $('gov-login').addEventListener('click', () => void govLogin());
  $('gov-password').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void govLogin();
  });
  $('gov-logout').addEventListener('click', () => govLogout());
  $('gov-refresh').addEventListener('click', () => void loadGovernance());

  // ── 视图切换 ─────────────────────────────────────────
  const TITLES = {
    overview: ['总览', '本地部署 · 数据不出机器'],
    service: ['服务控制', '启动 / 停止 / 重启数据面进程'],
    config: ['参数配置', '端口、路径、鉴权与服务注册信息'],
    logs: ['运行日志', 'worker 输出与错误'],
    api: ['API 与令牌', '客户端接入所需的信息'],
    governance: ['全站治理', '所有账户的仓库、卡片与账户状态'],
  };

  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.nav-item').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.view === view);
    });
    document.querySelectorAll('.view').forEach((section) => {
      section.hidden = section.dataset.view !== view;
    });
    const [title, sub] = TITLES[view] || ['', ''];
    $('view-title').textContent = title;
    $('view-sub').textContent = sub;

    if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
    if (view === 'logs') {
      void refreshLogs();
      if ($('logs-auto').checked) state.logTimer = setInterval(refreshLogs, 4000);
    }
    if (view === 'config') {
      void loadConfigForm().then(() => {
        if (registerModeValue() === 'open') void loadRecentAccounts();
      });
      /*
       * 传输安全状态走**独立的控制面端点**（`/control/tls/status`），
       * 因为证书全路径只在控制面下发（`configSummary` 会随 `/api/stats`
       * 发给任何已鉴权客户端）。每次进入这个视图都重读一次：
       * 面板是快照，用户切走再回来时监听状态可能已经变了。
       */
      void loadTlsStatus(true);
    }
    if (view === 'api') { state.visibleToken = false; $('token-input').value = '（已隐藏，点击显示）'; }
    if (view === 'governance') {
      renderGovGate();
      if (govLoggedIn()) void loadGovernance();
    }
  }

  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });

  // ── 启动 ─────────────────────────────────────────────
  // 支持 #token=<token>&view=config 形式的深链（截图 / 本机快捷入口用）。
  // 放在 hash 里不会发往服务端，也不会进访问日志；解析后立即从地址栏清除。
  let initialView = 'overview';
  /*
   * hash 里的参数要**先存下来**再用。
   *
   * `history.replaceState` 会把 hash 清掉，之后 `location.search` 里根本没有
   * 那些参数 —— 第一版把自动登录参数也塞进了 hash（`#token=…&gov=1`），
   * 结果 `replaceState` 之后 `debugParams.get('gov')` 恒为 null，
   * 治理页停在"需要管理员登录"，截出来是一张登录页。
   *
   * 所以这里把解析结果留一份给后面的自动登录用。
   */
  let hashParams = new URLSearchParams();
  if (location.hash.length > 1) {
    hashParams = new URLSearchParams(location.hash.slice(1));
    const hashToken = hashParams.get('token');
    if (hashToken) {
      state.token = hashToken.trim();
      localStorage.setItem(TOKEN_KEY, state.token);
    }
    initialView = hashParams.get('view') || 'overview';
    history.replaceState(null, '', location.pathname);
  }

  /*
   * 截图/联调入口：`?gov=1&govUser=…&govPassword=…` 自动登录治理页。
   *
   * 走的是**真实登录**（同一个 `govLogin` 那条路径，只是预填了输入框），
   * 不是伪造身份 —— 否则截出来的治理页可能与真实状态不一致，
   * 而截图验收的意义正在于"这就是用户会看到的界面"。
   *
   * 只在带参数时生效，正常访问不受影响。
   */
  /*
   * 自动登录参数可能来自 search（`?gov=1`）或 hash（`#gov=1`，与面板令牌一起传）。
   * 两处都查：截图脚本为了少写一个 URL 入口，把它们都放进了 hash。
   */
  const debugParams = new URLSearchParams(location.search);
  const readParam = (key) => debugParams.get(key) ?? hashParams.get(key);
  const govAutoLogin = readParam('gov') === '1';

  if (state.token) {
    enterApp()
      .then(() => {
        if (initialView !== 'overview') switchView(initialView);
        if (govAutoLogin) return autoGovLogin(readParam);
        return undefined;
      })
      /*
       * 截图入口的错误**就地吞掉并打日志**，不要落到下面的 `.catch(showLogin)`：
       * 那会把它显示成登录页，于是"脚本摆错了状态"看起来像"面板坏了"。
       */
      .then(() =>
        runTlsDemo(readParam).catch((error) => {
          console.error('tlsDemo 失败：', error);
        }),
      )
      .catch(() => showLogin());
  } else {
    showLogin();
    if (govAutoLogin) void autoGovLogin(readParam);
  }

  async function autoGovLogin(params) {
    const user = params('govUser') || '';
    const password = params('govPassword') || '';
    if (user === '' || password === '') return;
    switchView('governance');
    $('gov-username').value = user;
    $('gov-password').value = password;
    await govLogin();
  }

  /**
   * 截图/联调入口：`?tlsDemo=off|selfsigned|custom-ok|custom-bad`。
   *
   * 为什么需要它：四种状态里有一种（**不匹配拦截**）必须"先填两个路径再看结果"，
   * 而 `chrome --screenshot` 不能点也不能打字。这个入口只做"把表单摆成那个状态"，
   * 之后的校验仍然走真实的 `POST /control/tls/inspect`、状态仍然来自
   * `/control/tls/status` —— 截出来的界面与用户自己操作时完全一致。
   *
   * 不伪造任何返回值：`custom-bad` 用的是**真实的**一对不匹配文件，
   * 服务端真的会拒。
   */
  async function runTlsDemo(params) {
    const mode = params('tlsDemo');
    if (mode === null) return;
    if (state.view !== 'config') switchView('config');
    // switchView 里的 loadTlsStatus 是"发射即忘"，这里要等它回填完再动表单，
    // 否则后续 setTlsMode 会被回填覆盖（顺序竞赛）
    await loadTlsStatus(true);

    if (mode === 'custom-ok' || mode === 'custom-bad') {
      setTlsMode('custom');
      $('cfg-tls-certPath').value = params('certPath') || '';
      $('cfg-tls-keyPath').value = params('keyPath') || '';
      await checkTlsCustom();
    } else if (mode === 'off' || mode === 'selfsigned') {
      setTlsMode(mode);
    }
    /*
     * 只在**卡片没完整露出来**时才滚动。
     *
     * 前两版无条件 `scrollIntoView`（先 start、再 center），在 headless 下
     * 都会让侧边栏与整块布局一起下移、上方留一片空白 —— 截出来的图看起来
     * 像布局坏了，而其实是滚动位置的问题。截图脚本把视口调得足够高
     * （1460×1560，配置页整屏可见），于是正常情况下这里根本不用滚。
     *
     * 试过再加一个"滚到底"的开关去拍变灰的保存按钮，结果同样错位 ——
     * 所以那条路走不通，改用 `--dump-dom` 断言按钮的 `disabled`（见
     * scripts/capture-f4-tls.sh 的断言段）：机器核对比让肉眼在一张小图里找灰色按钮可靠。
     */
    const rect = $('tls-card').getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      window.scrollTo({ top: window.scrollY + rect.top - 16 });
    }
  }
})();
