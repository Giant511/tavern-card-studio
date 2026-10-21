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
  function fillConfigForm(config) {
    $('cfg-port').value = config.port;
    $('cfg-controlPort').value = config.controlPort;
    $('cfg-host').value = config.host;
    // 老服务端可能还没有这个字段；没有就显示默认回环，而不是留空。
    $('cfg-controlHost').value = config.controlHost || '127.0.0.1';
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
  }

  async function loadConfigForm() {
    try {
      const result = await api('/control/config');
      fillConfigForm(result.config);
    } catch {
      /* 状态接口里也有配置，忽略 */
    }
  }

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
      service: {
        mode: $('cfg-serviceMode').value,
        name: $('cfg-serviceName').value.trim(),
        displayName: $('cfg-serviceDisplayName').value.trim(),
        autoStart: $('cfg-autoStart').checked,
      },
      auth: { require: $('cfg-authRequire').checked },
    };
    $('cfg-save').disabled = true;
    try {
      const result = await api('/control/config', { method: 'PUT', body: JSON.stringify(payload) });
      fillConfigForm(result.config);
      $('cfg-msg').textContent = result.note || '已保存';
      toast(result.workerRestartRequired ? '配置已保存，重启后台服务后生效' : '配置已保存');
      await refreshStatus();
    } catch (error) {
      toast(error.message, true);
      $('cfg-msg').textContent = error.message;
    } finally {
      $('cfg-save').disabled = false;
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

  // ── 视图切换 ─────────────────────────────────────────
  const TITLES = {
    overview: ['总览', '本地部署 · 数据不出机器'],
    service: ['服务控制', '启动 / 停止 / 重启数据面进程'],
    config: ['参数配置', '端口、路径、鉴权与服务注册信息'],
    logs: ['运行日志', 'worker 输出与错误'],
    api: ['API 与令牌', '客户端接入所需的信息'],
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
    if (view === 'config') void loadConfigForm();
    if (view === 'api') { state.visibleToken = false; $('token-input').value = '（已隐藏，点击显示）'; }
  }

  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });

  // ── 启动 ─────────────────────────────────────────────
  // 支持 #token=<token>&view=config 形式的深链（截图 / 本机快捷入口用）。
  // 放在 hash 里不会发往服务端，也不会进访问日志；解析后立即从地址栏清除。
  let initialView = 'overview';
  if (location.hash.length > 1) {
    const params = new URLSearchParams(location.hash.slice(1));
    const hashToken = params.get('token');
    if (hashToken) {
      state.token = hashToken.trim();
      localStorage.setItem(TOKEN_KEY, state.token);
    }
    initialView = params.get('view') || 'overview';
    history.replaceState(null, '', location.pathname);
  }

  if (state.token) {
    enterApp()
      .then(() => { if (initialView !== 'overview') switchView(initialView); })
      .catch(() => showLogin());
  } else {
    showLogin();
  }
})();
