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
 * 合法的 status 值，**运行时也要校验**。
 *
 * 只有 JSDoc 类型是不够的：这个文件是纯 JS，类型注释不参与运行。
 * 2026-10-27 我给它写了一个 `needs-browser`（表里根本没有这个值），
 * 而测试与清点校验**全都绿**—— 因为它既不是 `offline`（不要求被导入），
 * 也不在任何 filter 的匹配范围内，等于静默地什么都不检查。
 * 那一格本该写 `live-browser`（需要真实浏览器 + CDP）。
 */
export const VERIFY_STATUSES = new Set([
  'offline',
  'browser-dump',
  'live-browser',
  'live-server',
  'elevated',
]);

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
  {
    file: 'scripts/verify-g1-rename.mjs',    status: 'live-server',
    run: 'npm run build:server && node scripts/verify-g1-rename.mjs',
    why: '要真起 worker 才能看到 CORS 预检（Allow-Methods 是按路由表派生的，纯函数测不到）与真实的 403/网络错误分层：三态文案必须在真响应码上验，mock 出来的 403 无法证明服务端真的拒了',
    evidence:
      '2026-10-26 跑通 28 项（8 个方法×路径组合的预检均允许 / 改名路径预检含 PATCH / 中英文改名各一次且列表读回新名 / 只读仓库令牌改名为 403 FORBIDDEN 且文案不含「无法连接」/ 端口无人监听时才是 NETWORK「无法连接服务端」/ 三态文案两两不等）',
  },
  {
    file: 'scripts/fake-st.mjs',
    status: 'offline',
    run: 'node scripts/fake-st.mjs --port 8000',
    why:
      '最小的假 SillyTavern（页面 + WS 回显 + SSE 分片 + Host 回显），不发任何 CORS 头。' +
      '它不是断言脚本而是**回归样本与排障工具**：真机验内嵌面板时不必先装一份真 ST；' +
      'T14.7 改端口链路要有"8001 上确实有服务"才证明得了；WS/SSE 两条路径需要可断开可控的上游',
    evidence:
      '2026-10-27 与 proxy.rs 的 10 条边界单测配套使用；真机验收时由用户手动起在 8000/8001 两个端口',
  },
  // ── browser-dump：断言读快照，抓取需要 headless Chrome ──
  {
    file: 'scripts/verify-t140-st-address.mjs',
    status: 'offline',
    run: 'node scripts/verify-t140-st-address.mjs',
    why: '纯本地：只连回环（自己起一个监听、连一个刚释放的端口），不碰网络服务也不碰浏览器。它不是"断言脚本"而是"取证脚本" —— 打印四种探测结论对应的面板文案，给人核对',
    evidence:
      '2026-10-27 跑出四态（ok 4ms / refused ECONNREFUSED / timeout 注入 TimedOut 1501ms / other PermissionDenied），与 test/st-address.test.mjs 的 20 条断言互为印证',
  },
  {
    file: 'scripts/verify-f15-probe.mjs',
    status: 'browser-dump',
    run: 'node scripts/verify-f15-probe.mjs',
    why: '要真实浏览器的跨源行为：四种 fetch 写法对"不发 CORS 头"的目标各是什么结果，Node 里没有 CORS 强制，模拟不出来。自己起目标服务与页面（页面源用 tauri.localhost，靠 --host-resolver-rules 解析）',
    evidence:
      '2026-10-26 跑通 4 项（no-cors 与 no-cors+no-store 均拿到 opaque 响应 / 默认 cors 与默认写法均 TypeError: Failed to fetch）—— 结论：CORS 头缺失不构成 no-cors 失败，线上"ST 在跑却判未运行"不是 CORS 造成的，见决策 #207/#208',
  },
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
  {
    file: 'scripts/capture-v14-faces.sh',    status: 'browser-dump',
    run: 'npm run build:ui && bash scripts/capture-v14-faces.sh',
    why:
      '交付截图生成器（assets/face-0{1,2,3}-*.png 卡面选择三态）；只要静态 dist + headless Chrome。' +
      '**注意它证明的是布局，不是读盘**：浏览器里没有壳，图库与原图必然是空的，' +
      '脚本用 ?faceDemo= 注入候选并在 UI 上打「演示」角标；真实读盘由 test/contract-binary、' +
      'test/png-roundtrip 与 cargo test 证明',
    evidence:
      '2026-10-26 生成 3 张（默认 690558 / 图库 722627 / 原图 718066 字节，三张字节互不相同），' +
      '逐张核验；期间抓到两个真缺陷：角标与占位符重复渲染成「默认卡面默认」、' +
      'refresh 拿初始 choice 当记忆值导致「原图态预选成默认卡面」',
  },
  {
    file: 'scripts/capture-v15-g3.sh',
    status: 'browser-dump',
    run: 'npm run build:ui && bash scripts/capture-v15-g3.sh',
    why:
      'G3 三项缺陷的取证截图（assets/g3-0{1,2,3}-*.png）；只要静态 dist + headless Chrome。' +
      '**它证明的是界面行为，不是数据正确性**：世界书那两张通过 ?wbDemo= 走真实的 ' +
      'session.setBlockText（解析器/脏标记/闸门都真跑），数据级结论由 ' +
      'test/g3-regressions.test.mjs 与 .verify/g3-export-regression.mjs 负责',
    evidence:
      '2026-10-26 生成 3 张（legacy 412627 / 阻断 685111 / 对照 605308），逐张核验；' +
      '**抓到一次误拦**：第一版闸门用 text !== renderWorldbookText(entries) 判断，' +
      '对照组（格式完全正确）也被拦 —— 正常编辑必然让两者字形不同。改成"重新解析有没有 error"后才正确',
  },
  {
    file: 'scripts/capture-v15-save-format.sh',
    status: 'browser-dump',
    run: 'npm run build:ui && bash scripts/capture-v15-save-format.sh',
    why:
      'G6 另存为格式对话框的两张取证截图（assets/g6-0{1,2}-*.png）：默认态 + PNG 禁用态。' +
      '**必须走 http:// 不能用 file://** —— file 协议下模块脚本受 CORS 限制，start() 跑不完，' +
      '截出来是"加载中…"的初始页，看起来像功能没实现（第一版就是这么错的）',
    evidence:
      '2026-10-26 生成 2 张（默认 395550 / 禁用 405183 字节，哈希不同）；' +
      '默认态三选项齐全且 JSON 预选、按钮文字随选择联动；禁用态 PNG 变灰并写明原因',
  },
  {
    file: 'scripts/capture-v15-g7.sh',
    status: 'browser-dump',
    run: 'npm run build:ui && bash scripts/capture-v15-g7.sh',
    why:
      'G7 世界书常驻误报的取证截图（assets/g7-0{1,2}-*.png）：同一份 19 条用户数据，' +
      '只差规则条件。**依赖本地用户文件**（D:/Desktop/桌面文件/temp 下的世界书预设与平台规则、' +
      '.verify/xiao-worldbook.txt）—— 那是成人向用户内容，按设计不入库、不进包，' +
      '脚本找不到输入时会以退出码 2 明确报缺',
    evidence:
      '2026-10-26 生成 2 张（修复前 432988 / 修复后 446874 字节，哈希不同）：' +
      '世界书域 29 条 → 15 条，正好少 14（7 条用户规则 + 7 条内置 builtin:worldbook-no-trigger）',
  },
  {
    file: 'scripts/gen-g7-fixtures.mjs',
    status: 'browser-dump',
    run: 'node scripts/gen-g7-fixtures.mjs',
    why:
      'capture-v15-g7.sh 的输入生成器：把用户真实世界书与两份预设写成 ' +
      'client/dist/g7/{before,after}.json 供 ?auditDemo= 读取。' +
      '**只写进 dist**（build:client 第 0 步会清掉），确保用户内容不进仓库、不进 MSI',
    evidence: '2026-10-26 生成 before 16427 / after 16829 字节；缺输入时退出码 2',
  },

  {
    file: 'scripts/capture-v16-arrival.sh',
    status: 'browser-dump',
    run: 'npm run build:ui && bash scripts/capture-v16-arrival.sh',
    why:
      'v0.1.6 缺陷一的取证截图（assets/v016-0{1,2}-arrival-*.png）：同一张标准格式卡 + ' +
      '同一个自定义世界书预设，只差"有没有做到达规范化"。样本卡取自仓库自带的 ' +
      'examples/cards/lin-wanzhao-v3.json（公开样本，不是用户内容），运行时复制进 ' +
      'client/dist/arrival/ 供 ?arrivalDemo= fetch；需要本机 Chrome 与 http.server',
    evidence:
      '2026-10-27 生成 2 张，字节不同（脚本自带哈希唯一性断言）：' +
      'before 世界书错误 1 条（worldbook-no-entry-marker）、after 0 条',
    coveredBy: 'test/arrival.test.mjs',
  },

  {
    file: 'scripts/capture-v16-pane-collapse.sh',
    status: 'browser-dump',
    run: 'npm run build:ui && bash scripts/capture-v16-pane-collapse.sh',
    why:
      'v0.1.6 真机缺陷四（收起后无法展开）的取证截图（assets/v016-0{3,4}-pane-*.png）：' +
      '两张图走同一个按钮的两种状态。第二张由 ?collapseRoundTrip=1 触发，走的是**真实 click**' +
      '（不是直接调 setCollapsed）—— 缺陷就是按钮绑定写死方向，绕过按钮等于绕过缺陷。' +
      '需要本机 Chrome 与 http.server',
    evidence:
      '2026-10-27 生成 2 张，字节不同（401177 / 450564，脚本自带哈希唯一性断言）：' +
      '状态栏原文「折叠宽 56（符号「⟨」）→ 点击后 已展开，宽 460（记忆值 460）」',
    coveredBy: 'test/st-pane-collapse.test.mjs',
  },

  {
    file: 'scripts/capture-v16-iframe-xfo.sh',
    status: 'browser-dump',
    run: 'bash scripts/capture-v16-iframe-xfo.sh',
    why:
      'v0.1.6 缺陷二**真因**的取证截图（assets/v016-0{5,6}-iframe-xfo-*.png）：' +
      'ST 响应带 X-Frame-Options: SAMEORIGIN，面板 iframe 与之不同源 ⇒ 浏览器拒绝渲染，' +
      '错误页写作「127.0.0.1 拒绝连接」。两张图同机同 ST，只差反代有没有剥这个头：' +
      'blocked 是灰底空白、stripped 是完整的 SillyTavern 1.19.0 界面。' +
      '脚本自己先断言"对照组有头、实验组没头"，再截图并断言两图哈希不同 —— ' +
      '否则截出来的可能只是两个都失败的页面。需要本机 ST 在 8000、Chrome 与 python',
    evidence:
      '2026-10-27 生成 4 张：v016-0{5,6} 为 XFO 对照（6 693 / 83 765 字节）；' +
      'v016-0{7,8} 为会话 cookie 对照（74 625 / 24 033 字节）—— 后者 base 组卡在' +
      '「正在初始化…」、fix 组渲染出 ST 欢迎页。CDP 侧对照：保留 XFO 时 ' +
      'net::ERR_BLOCKED_BY_RESPONSE blocked=other，剥掉后无失败事件；' +
      '日志侧对照：base 组 POST /api/settings/get cookie=NO -> 403、' +
      'fix 组 cookie=yes -> 200（脚本对这两行直接断言）',
    coveredBy:
      'client/src-tauri/src/proxy.rs（strip_frame_blockers 3 条 + relax_cookie_same_site 3 条单测）',
  },

  {
    file: 'scripts/verify-card-info-e2e.mjs',
    status: 'live-browser',
    run: 'npm run build:ui && python -m http.server 8892 --bind 127.0.0.1 -d client/dist && node scripts/verify-card-info-e2e.mjs',
    why:
      'v0.1.6 卡片信息的端到端验收：用户报的是「导出后这里明显不对」，' +
      '所以判据只能是**导出 JSON 里的字段**。脚本走真实入口（openCardInfo、真实「保存」按钮）' +
      '与真实导出链路（buildExportForTest → buildExportAsync），断言六个字段' +
      '「改之前是示例卡的值、改之后是用户的值」—— 两个方向都验，' +
      '否则一个"永远返回空串"的实现也能通过',
    evidence:
      '2026-10-27 跑通：before = Tavern Card Studio / 1.0 / 示例卡片… / 拾光书店 / [日常,治愈,书店]；' +
      'after = 我的笔名 / 3.1 / 这是我自己写的创作说明。 / 临海城 / [赛博朋克,悬疑]',
    coveredBy: 'test/card-info.test.mjs（26 条纯函数测试）',
  },

  {
    file: 'scripts/verify-ui-copy.mjs',
    status: 'offline',
    run: 'node scripts/verify-ui-copy.mjs .',
    why:
      'v0.1.6 用户两次指明：面向用户的界面里不许出现测试性 / 开发性措辞。' +
      '这类问题功能全对、只有措辞是给开发者看的 —— 单元测试抓不到（不检查文案），' +
      '功能验收也抓不到（能点、能用）。只有把"措辞"本身当判据才会红。' +
      '扫 client/src + server/public + client/index.html 里被引号包住的中文，' +
      '排除注释；豁免靠精确文本与行内 `// ui-copy-allow: 理由`，不靠行号（行号会漂）',
    evidence:
      '2026-10-27 首轮跑出 132 处疑似，人工确认后改掉：卡片信息对话框 11 处（JSON 字段名、' +
      '示例卡、字段）、导出回执的 sha256 与「回读」、审计面板的英文字段名、' +
      'ST 面板的「壳侧 TCP」、服务端面板的「Electron」（本项目是 Tauri）、' +
      'app.ts 20 处验收入口文案。最终 72 个文件 0 命中',
    coveredBy: 'test/offline-verifiers.test.mjs',
  },

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
