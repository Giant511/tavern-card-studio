/**
 * 验证脚本清点登记表（single source of truth）。
 *
 * ## 这个文件解决什么问题
 *
 * 本仓库有一批"要手工跑"的验收脚本：`scripts/verify-*.mjs`、`scripts/smoke-*.mjs`、
 * 以及 `.ps1` 与 `.sh` 抓取脚本。它们**不在 `npm test` 链上**，于是可以长期红着
 * 或空跑而无人发现 —— 已经发生过两次：
 *
 *   1. `verify:e2e` 的所有场景都没带 `?sample=1`，快照全是空工作台，
 *      「六个板块已渲染」断言一直是 0 个（2026-10-25 发现）；
 *   2. `verify-export-roundtrip.mjs` 里写死了六板块清单，加板块后它照样全 PASS，
 *      因为它压根不检查新板块。
 *
 * 光"约定以后要挂进测试"没用，得让**漏登记变成红灯**。所以：
 *
 *   · 本表登记每一个脚本，标明它属于哪一类、为什么不能进 `npm test`；
 *   · `test/verify-inventory.test.mjs` 双向校验：
 *       磁盘上有、表里没有 → 红（新脚本必须表态）
 *       表里有、磁盘上没有 → 红（删了脚本要同步删登记）
 *       标 `offline` 的，必须真的被某个 `test/*.test.mjs` 导入 → 红
 *
 * ## 五个状态的含义
 *
 * | status | 含义 | 进 npm test？ |
 * |---|---|---|
 * | `offline` | 只读仓库文件 + 纯函数，无网络/无浏览器/无提权 | **是**（`test/offline-verifiers.test.mjs` 导入它的 run） |
 * | `browser-dump` | 断言读 DOM 快照，快照由 `capture-*.sh` 用 headless Chrome 抓 | 否（需要先抓快照；抓取在 `npm run capture:*`） |
 * | `live-browser` | 需要真实运行的浏览器/壳 + CDP 调试端口 | 否 |
 * | `live-server` | 需要真实服务端进程（含 TLS / 反代 / 多账户场景） | 否 |
 * | `elevated` | 需要管理员权限（安装/卸载/服务注册） | 否 |
 *
 * `why` 字段必须写**具体原因**（缺哪个前置条件），不写"不方便"。
 * `evidence` 写"什么时候、用什么命令跑过、结论是什么" —— 没有证据的脚本
 * 与没写一样。
 */

/** @typedef {'offline' | 'browser-dump' | 'live-browser' | 'live-server' | 'elevated'} VerifyStatus */

/**
 * @type {ReadonlyArray<{
 *   file: string,
 *   status: VerifyStatus,
 *   run: string,
 *   why: string,
 *   evidence: string,
 *   coveredBy?: string,
 * }>}
 */
export const VERIFY_INVENTORY = [
  // ── offline：已挂进 npm test ─────────────────────────────
  {
    file: 'scripts/verify-import-atomic.mjs',
    status: 'offline',
    run: 'node scripts/verify-import-atomic.mjs',
    why: '只读 rules/ 与 client/src（类型剥离），无网络无浏览器',
    evidence: '2026-10-25 跑通 18 项；由 test/offline-verifiers.test.mjs 每次 npm test 重跑',
    coveredBy: 'test/offline-verifiers.test.mjs',
  },
  {
    file: 'scripts/verify-export-roundtrip.mjs',
    status: 'offline',
    run: 'node scripts/verify-export-roundtrip.mjs',
    why: '只读 shared/dist 与 client/src，纯函数拼装',
    evidence: '2026-10-25 跑通 16 项（已改为从 BLOCK_IDS 派生，覆盖两个新板块）；由 test/offline-verifiers.test.mjs 重跑',
    coveredBy: 'test/offline-verifiers.test.mjs',
  },
  {
    file: 'scripts/verify-t1034-custom.mjs',
    status: 'offline',
    run: 'node scripts/verify-t1034-custom.mjs [--json]',
    why: '走界面背后同一批函数（parseCardText / checkWorldbookFormat / importWorldbookPreset）',
    evidence: '2026-10-25 跑通 26 项；由 test/offline-verifiers.test.mjs 重跑',
    coveredBy: 'test/offline-verifiers.test.mjs',
  },

  {
    file: 'scripts/verify-audit-dual-sample.mjs',
    status: 'offline',
    run: 'npm run build:server && node scripts/verify-audit-dual-sample.mjs',
    why: '同一张卡的两种导出形态分别过 AuditService.run(bytes)，不起 HTTP、不起浏览器',
    evidence: '2026-10-25 跑通 23 项（铁律 error=0 / 只一条 info / 两条反证）；由 test/offline-verifiers.test.mjs 每次 npm test 重跑',
    coveredBy: 'test/offline-verifiers.test.mjs',
  },
  {
    file: 'scripts/verify-repo-token-entry.mjs',
    status: 'live-server',
    run: 'npm run build:server && node scripts/verify-repo-token-entry.mjs',
    why: '要真起一个服务端进程：这条路验的正是 HTTP 层与 TokenGate 豁免列表（/api/auth/repo-token 必须免鉴权），纯函数测不到',
    evidence: '2026-10-25 跑通 24 项（免鉴权 / 四类原因 / 两把不存在令牌逐字节相同 / via=repo-token / 删仓库级联吊销）',
  },
  {
    file: 'scripts/verify-audit-http.mjs',
    status: 'live-server',
    run: 'npm run build:server && node scripts/verify-audit-http.mjs',
    why: '要真起 worker 把同一对样本 POST 到 /api/audit：验的是 HTTP 层（请求体解析 / 鉴权 / 报告序列化 / 响应头）有没有把离线结论原样送出来，纯进程内直调覆盖不到',
    evidence:
      '2026-10-25 跑通 11 项（旧卡 200 + legacy-six-block 恰好一条 info + error=0 + 可导出 + 不报板块缺失；新卡无 legacy 提示；空请求体 400）',
  },
  {
    file: 'scripts/verify-f4-tls.mjs',
    status: 'live-server',
    run: 'npm run build:server && node scripts/verify-f4-tls.mjs',
    why: '要真起 `serve`（supervisor + worker 两个进程）：验的是「面板保存 → 控制面调 worker → 监听真的换了」这条跨进程链路，任何单测都覆盖不到',
    evidence:
      '2026-10-25 跑通 46 项（off 起步 / off→selfsigned 热更并真连 https / 重新生成进 certs-backup / custom 不匹配 400 / custom 匹配热更 / 端口占用 409 回滚且原监听仍可连 / worker 停止时保存不谎报已热更）',
  },
  // ── browser-dump：断言读快照，抓取需要 headless Chrome ──
  {
    file: 'scripts/verify-v13-extras.mjs',
    status: 'browser-dump',
    run: 'npm run build:ui && bash scripts/capture-v13-dumps.sh && node scripts/verify-v13-extras.mjs',
    why: '三板块高亮（世界书 / 初始场景 / 对话示例）是否真的渲染进了编辑器：读 .verify/v13-dumps 的 DOM，按 class + data-rule 断言',
    evidence:
      '2026-10-25 跑通 17 项（世界书 5 条专用规则各归对 scope / scene-divider 只认 initial-scene / <START> 由 example-start-marker 接管且不再走 custom-macro / 三条专用规则互不泄漏）',
  },
  {
    file: 'scripts/verify-e2e.mjs',
    status: 'browser-dump',
    run: 'bash scripts/capture-e2e-dumps.sh && node scripts/verify-e2e.mjs',
    why: '输入是 .verify/e2e-dumps/*.html；抓取要 headless Chrome（本机 Node 不能 spawn）',
    evidence: '2026-10-25 修好 ?sample=1 后 60/60 通过',
  },
  {
    file: 'scripts/verify-t10x.mjs',
    status: 'browser-dump',
    run: 'bash scripts/capture-t10x.sh && node scripts/verify-t10x.mjs',
    why: '输入是 .verify/t10x-dumps/*.html（保全三样本的浏览器侧断言）',
    evidence: '2026-10-25 与 capture-t10x.sh 一起复跑通过（30 项）',
  },
  {
    file: 'scripts/verify-f5b-token-mode.mjs',
    status: 'browser-dump',
    run: 'bash scripts/capture-f5b-dumps.sh && node scripts/verify-f5b-token-mode.mjs',
    why: '读 .verify/f5b-dumps/*.html；抓取要真服务端（签三档 scope 的令牌）+ headless Chrome',
    evidence: '2026-10-25 跑通 40/40（三入口 / 三档 scope 矩阵 / 选择器隐藏 / 无「令牌不存在」字样）',
  },
  { file: 'scripts/capture-f5b-dumps.sh', status: 'browser-dump', run: 'bash scripts/capture-f5b-dumps.sh', why: '同上：verify-f5b-token-mode 的输入生成器（起临时服务端 + 签 3 把令牌）', evidence: '2026-10-25 生成 5 份快照' },
  { file: 'scripts/capture-f5b-token-mode.sh', status: 'browser-dump', run: 'bash scripts/capture-f5b-token-mode.sh', why: '交付截图生成器（assets/f5b-*.png）；要真服务端 + headless Chrome', evidence: '2026-10-25 生成 5 张截图，逐张人工核验' },
  { file: 'scripts/capture-v13-extras.sh', status: 'browser-dump', run: 'npm run build:ui && bash scripts/capture-v13-extras.sh', why: '交付截图生成器（assets/preset-*.png 两新区 + assets/highlight-*.png 三板块高亮）；只要静态 dist + headless Chrome，不需要服务端', evidence: '2026-10-25 生成 5 张（两新区 + 三板块），逐张人工核验；两新区用 560 高视口，否则两区块一屏装得下、两张图字节相同' },
  { file: 'scripts/capture-v13-dumps.sh', status: 'browser-dump', run: 'bash scripts/capture-v13-dumps.sh', why: '给 verify-v13-extras.mjs 抓三板块高亮的 DOM 快照（.verify/v13-dumps）', evidence: '2026-10-25 与 verify-v13-extras.mjs 一起复跑通过（17 项）' },
  { file: 'scripts/capture-f4-tls.sh', status: 'browser-dump', run: 'bash scripts/capture-f4-tls.sh', why: '传输安全的四态截图（assets/f4-*.png）；要真服务端（含真正热更出来的 HTTPS 监听）+ headless Chrome', evidence: '2026-10-25 生成 4 张截图（off 警告 / selfsigned 指纹 / custom 匹配 / custom 不匹配），逐张人工核验' },
  { file: 'scripts/capture-f3-account-purge.sh', status: 'browser-dump', run: 'bash scripts/capture-f3-account-purge.sh', why: '交付截图生成器（assets/f3-*.png）；要真服务端（serve，含面板）+ 真注销一次 + headless Chrome', evidence: '2026-10-25 生成 2 张截图（客户端确认弹窗含输入框、治理页注销审计），逐张人工核验' },
  { file: 'scripts/capture-e2e-dumps.sh', status: 'browser-dump', run: 'bash scripts/capture-e2e-dumps.sh', why: '抓取器本身不是断言脚本，是 verify-e2e 的输入生成器', evidence: '2026-10-25 生成 14 份快照 + 14 张截图' },
  { file: 'scripts/capture-t10x.sh', status: 'browser-dump', run: 'bash scripts/capture-t10x.sh', why: '同上：verify-t10x 的输入生成器', evidence: '2026-10-25 生成 3 份保全样本快照' },

  // ── live-browser：需要 CDP 调试端口 + 运行中的应用 ──────
  {
    file: 'scripts/verify-audit-panel.mjs',
    status: 'live-browser',
    run: 'node scripts/verify-audit-panel.mjs',
    why: '连 Chrome CDP 的 /json/list，需要已启动的调试实例',
    evidence: 'v0.1.2 期间跑过通过；v0.1.3 未复跑（八板块改动未触及该面板路径）',
  },
  {
    file: 'scripts/verify-beforeunload.mjs',
    status: 'live-browser',
    run: 'bash（先起 8899 静态服务 + headless Chrome）&& node scripts/verify-beforeunload.mjs',
    why: '要么连 CDP，要么读 dumps；两者都需要外部起浏览器',
    evidence: 'v0.1.2 期间通过；v0.1.3 未复跑',
  },
  {
    file: 'scripts/verify-f6.mjs',
    status: 'live-server',
    run: 'node scripts/verify-f6.mjs [CDP端口] [期望分支]',
    why: '要连真实服务端（8730/8731）+ 壳内 CDP，两个前置都缺一不可',
    evidence: 'v0.1.2 期间两个分支都验过；v0.1.3 未复跑',
  },
  {
    file: 'scripts/verify-highlight-live.mjs',
    status: 'live-browser',
    run: 'node scripts/verify-highlight-live.mjs [原版] [修正版]',
    why: '连 CDP 读实时 DOM 的高亮 span',
    evidence: 'F7 批次已用 scripts/shot-f7-theme.mjs 替代验证（同样断言颜色作用域）',
  },
  {
    file: 'scripts/verify-installed-app.mjs',
    status: 'live-browser',
    run: 'node scripts/verify-installed-app.mjs',
    why: '在**已安装**的客户端里跑（WebView2 远程调试），需要 MSI 安装 + 提权',
    evidence: '未在 v0.1.3 执行（本机无提权会话）',
  },
  { file: 'scripts/verify-t1020-ui.mjs', status: 'live-browser', run: 'node scripts/verify-t1020-ui.mjs', why: '需要 CDP + 真实服务端（26 项断言跨两侧）', evidence: 'v0.1.2 期间通过' },
  { file: 'scripts/verify-t107.mjs', status: 'live-browser', run: 'node scripts/verify-t107.mjs', why: '登录/注册入口的显隐只能在真实浏览器里看', evidence: 'v0.1.2 期间通过' },
  { file: 'scripts/verify-t108.mjs', status: 'live-browser', run: 'node scripts/verify-t108.mjs', why: '仓库联动 UI、令牌子申请、隔离提示消失 —— 全是界面行为', evidence: 'v0.1.2 期间通过' },
  { file: 'scripts/verify-t109.mjs', status: 'live-browser', run: 'node scripts/verify-t109.mjs', why: 'TXT 导入/世界书双向的界面侧行为', evidence: '保全逻辑已由 verify-t10x（browser-dump）覆盖' },
  { file: 'scripts/verify-t113-authgate.mjs', status: 'live-browser', run: 'node scripts/verify-t113-authgate.mjs', why: '凭证门槛顺序，需要 CDP + 四种凭证态 + 提权装客户端', evidence: 'v0.1.2 期间通过 30 项' },
  { file: 'scripts/verify-t914.mjs', status: 'live-browser', run: 'node scripts/verify-t914.mjs', why: '多卡链路的浏览器侧行为', evidence: 'v0.1.2 期间通过' },

  // ── live-server：需要真实服务端进程 ─────────────────────
  { file: 'scripts/verify-sync-live.mjs', status: 'live-server', run: 'node scripts/verify-sync-live.mjs', why: '要连真实服务端走上传→历史→回滚', evidence: 'v0.1.2 期间通过' },
  { file: 'scripts/verify-t110-matrix.mjs', status: 'live-server', run: 'node scripts/verify-t110-matrix.mjs', why: '两账户 × 两仓库 × 四种凭证的交叉矩阵', evidence: '194 格权限矩阵，v0.1.3 回归包中重跑（见 docs/42）' },
  { file: 'scripts/verify-t914-sync.mjs', status: 'live-server', run: 'node scripts/verify-t914-sync.mjs', why: '按 cardId 归档/分叉警告/历史按 ID 寻址，需要真实服务端', evidence: 'v0.1.2 期间通过' },
  { file: 'scripts/smoke-t104.mjs', status: 'live-server', run: 'node scripts/smoke-t104.mjs', why: '注册/登录/会话的真实服务端冒烟', evidence: 'v0.1.2 期间通过' },
  { file: 'scripts/smoke-t105.mjs', status: 'live-server', run: 'node scripts/smoke-t105.mjs', why: '三种 TLS 模式需要真的起进程', evidence: 'v0.1.2 期间通过' },
  { file: 'scripts/smoke-t106.mjs', status: 'live-server', run: 'node scripts/smoke-t106.mjs', why: '仓库 + 令牌的真实服务端流程（含越权拒绝）', evidence: 'v0.1.2 期间通过' },
  { file: 'scripts/smoke-t108.mjs', status: 'live-server', run: 'node scripts/smoke-t108.mjs', why: '按账户隔离 + legacy 降权，需要真实服务端', evidence: 'v0.1.2 期间通过' },
  { file: 'scripts/smoke-t110-custom-ca.mjs', status: 'live-server', run: 'node scripts/smoke-t110-custom-ca.mjs', why: '自定义证书的信任链需要真进程 + 真 CA', evidence: 'v0.1.2 期间通过' },
  { file: 'scripts/smoke-t110-deploy.mjs', status: 'live-server', run: 'node scripts/smoke-t110-deploy.mjs', why: '反代穿透 /api/token 回环门槛，需要同机反代', evidence: 'v0.1.2 期间通过' },

  // ── elevated：需要管理员权限 ───────────────────────────
  {
    file: 'scripts/verify-t1025-uninstall.ps1',
    status: 'elevated',
    run: 'powershell -ExecutionPolicy Bypass -File scripts/verify-t1025-uninstall.ps1 -Phase Guide|Setup|Check',
    why: '卸载流程要 msiexec + 服务删除，必须提权终端',
    evidence: '未在本机执行（会话非管理员，IsAdmin=False）；已挂账给用户按 docs/37 §5 手动跑',
  },

  // ── 非断言的诊断脚本（保留但不作为判据）────────────────
  { file: 'scripts/compare-highlight.mjs', status: 'browser-dump', run: 'node scripts/compare-highlight.mjs', why: '对比两套高亮方案的区间差异，给人看的诊断，不断言', evidence: '诊断工具，无通过/失败语义' },
  { file: 'scripts/diagnose-f6.mjs', status: 'live-browser', run: 'node scripts/diagnose-f6.mjs', why: 'F6 空白面板的现场诊断（读 CDP），不是判据', evidence: '诊断工具，无通过/失败语义' },
  { file: 'scripts/diagnose-rules.mjs', status: 'offline', run: 'node scripts/diagnose-rules.mjs', why: '打印规则加载过程，纯本地', evidence: '诊断工具，无通过/失败语义；不进 test（它不产出通过/失败）' },
  { file: 'scripts/probe-auth-timing.mjs', status: 'live-server', run: 'node scripts/probe-auth-timing.mjs', why: '登录限速/时序探测，需要真实服务端', evidence: '诊断工具' },
  { file: 'scripts/probe-shortsha.mjs', status: 'offline', run: 'node scripts/probe-shortsha.mjs', why: '短 sha256 碰撞概率的探索脚本，纯计算', evidence: '诊断工具' },
];

/** 需要出现在 `npm test` 里的（status === 'offline' 且有断言） */
export const OFFLINE_WITH_ASSERTIONS = VERIFY_INVENTORY.filter(
  (entry) => entry.status === 'offline' && entry.coveredBy !== undefined,
);
