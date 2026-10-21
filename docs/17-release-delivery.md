# 交付说明：双 MSI + 端到端验证 + 发布检查（T6.9 / 阶段 8）

> 版本 0.1.0 · 2026-10-21>   
> 状态：阶段 6 全部完成（T6.1–T6.9），阶段 8 联调通过。>   
> 本文是**交付主文档**：安装、配置、使用、规则编写都在这里，配合各任务的详细文档使用。

---

## 1. 两枚安装包

| 产物                                            |                            体积 | sha256                                                             |
| --------------------------------------------- | ----------------------------: | ------------------------------------------------------------------ |
| `Tavern Card Studio_0.1.0_x64_en-US.msi`（客户端） |   **2,625,536 字节 / 2.50 MiB** | `6c1be00a5a594284e6ef69c22c015f74ee55deb0168143c93c919341e145c87e` |
| `TavernCardStudioServer-0.1.0.msi`（服务端）       | **32,441,368 字节 / 30.94 MiB** | `77a0e254900101841b5a206561dc32490079075b52ea490ce36911095a8211a5` |

体积构成对比（说明为什么差 12 倍）：

|       | 客户端                                    | 服务端                             |
| ----- | -------------------------------------- | ------------------------------- |
| 内容    | 壳 exe（内嵌压缩后的前端）+ `rules/`              | 自带 `node.exe` + 全部 JS 依赖 + 管理面板 |
| 依赖运行时 | 系统 WebView2（Win10/11 自带）               | Node 20+（已内置）                   |
| 增长历史  | 1.98 → 2.45（T6.1）→ 2.50 MiB（T6.2–T6.7） | —                               |

> 体积是**旁证**，不是判据。判据见 §5 的时间链。>   
> 客户端 MSI 从 1.98 涨到 2.50 MiB，与新增的编辑器/审计/规则/导出/同步模块量级吻合。

---

## 2. 安装

### 2.1 客户端

```powershell
# 需要管理员权限（WiX MSI 是 perMachine）
msiexec /i "Tavern Card Studio_0.1.0_x64_en-US.msi" /qn
```

- 安装位置：`C:\Program Files\Tavern Card Studio\`（`tcs-shell.exe` + `rules\`）
- 非管理员会报 **Error 1925**。Tauri 2.12 的 `wix` 段**没有** `installMode` 选项    
  （那是 NSIS 的），所以 MSI 必然是 perMachine —— 这是平台限制，不是配置遗漏。
- Win10 首次启动可能需联网补装 WebView2（`downloadBootstrapper` 策略）；    
  Win11 自带。离线分发可改 `webviewInstallMode` 为 `offlineInstaller`（体积 +约 130 MB）。

### 2.2 服务端

```powershell
# 推荐：MSI 安装（自带服务宿主，装完即为开机自启的 Windows 服务）
msiexec /i "TavernCardStudioServer-0.1.0.msi" /qn

# 绿色包方式：解压后先跑一次，再注册服务（需要有宿主，见下方说明）
release\server\start-server.cmd
powershell -ExecutionPolicy Bypass -File installer\tcs-service.ps1 -Action install -InstallDir release\server
```

安装位置 `C:\Program Files\Tavern Card Studio Server\`，数据在 `C:\ProgramData\TavernCardStudio\`，  
面板 `http://127.0.0.1:8731/`，API `http://127.0.0.1:8730/api`。

**要给局域网里的其他机器用，只改「API 监听地址」，不要动「管理面板监听地址」。**  
两者是独立字段（`host` / `controlHost`）：面板的静态页面（`/`、`/app.js`）是免鉴权的，  
早先共用 `host` 时「把 API 开到 `0.0.0.0`」会连带把管理界面暴露到局域网  
（实测从局域网 IP `GET /` 返回 200）。现在默认行为已安全：

```
host        = 0.0.0.0      →  0.0.0.0:8730      局域网可访问 API
controlHost = 127.0.0.1    →  127.0.0.1:8731    面板只在本机
```

升级老配置时 `controlHost` 自动落到 `127.0.0.1`（**不跟随 `host`**），不需要手动改。  
详见 [docs/08 §9.3](08-server-api.md)。

**服务由 WinSW 宿主托管，不是直接跑 node.exe。** 这是必须的：`node.exe` 不实现 Windows  
服务控制协议，直接注册会让服务停在 `Start Pending`，安装程序随之永久卡在  
`Please wait while Windows configures ...`（2026-10-21 实际发生，详见 [docs/18](18-server-service-fix.md)）。

**已验证**（2026-10-21 真机）：服务 `State=Running`、`PathName` 指向 `tcs-service-host.exe`、  
8730/8731 监听、面板 HTTP 200、`/api/health` 返回 ok，node 子进程跑在 session 0。

装完后服务应是 `Running`，否则先看日志：

```powershell
Get-Service TavernCardStudioServer | Format-List Status
Get-Content "C:\ProgramData\TavernCardStudio\logs\tcs-service-host.err.log" -Tail 30
```

首次启动会生成 `config.json` 与访问令牌。服务没有控制台，令牌会写进服务日志，  
也可以用 CLI 重取：

```
node "C:\Program Files\Tavern Card Studio Server\app\server\dist\index.js" token show --config "C:\ProgramData\TavernCardStudio\config.json"
```

> ⚠️ 令牌即**全权凭证**，客户端明文存于 `%APPDATA%\com.taverncardstudio.client\client-config.json`。>   
> 勿在不信任的机器保存；泄露后用 `token rotate` 轮换。

---

## 3. 配置

客户端「设置…」里填两项：**服务端地址**、**访问令牌**。

- 地址支持本机（`127.0.0.1:8730`）、局域网 IP（`192.168.1.20:8730`）、域名；省略 `http://` 会自动补
- 「测试连接」走两步：`/api/health` 判可达 → `/api/stats` 验令牌。    
  只测前者会给假阳性（它是公开路径，令牌错了也返 200）
- 未配置或连接失败时，**编辑 / 审计 / 导出全部照常**，仅同步按钮置灰

---

## 4. 使用

### 4.1 六板块编辑

- 左侧六个板块：基本信息 / 性格 / 其他设定 / 特殊设定 / 用户相关设定 / 世界书
- 折叠的板块**不占 DOM**（销毁编辑器），展开才创建 —— 六个 CodeMirror 实例常驻会拖慢输入
- 语法高亮来自高亮方案（规则资产），`{{char}}` / `{{user}}`、对话、属性等各有配色

### 4.2 实时提醒

- 编辑后 260ms 防抖重算，问题在编辑器内以波浪线标出，右侧审计面板同步列出
- 点击问题可定位到板块内偏移；**修正后标记立即消失**
- 面板支持按等级/类别/板块筛选、按板块或类别分组、关键字搜索
- 字数分布区分两个口径：**六板块合计**（268 字）与**落盘字段**（`description` 178 / `personality` 35 / `character_book` 55）    
  —— 平台长度规则用的是后者，只显示一个数会让人以为规则算错

### 4.3 导出

「导出…」→ 选 JSON / TXT：

- **JSON**：SillyTavern 原生结构，2 空格缩进 + 结尾换行（与服务端存储口径一致）
- **TXT**：按当前预设拼装标题与分隔符，世界书不写入（它是结构化字段）
- 有 error 级问题时**拦截**并逐条列出错误，可选「仍要导出」；焦点默认在「取消」防误按回车
- 写出后回执显示路径 / 字节数 / sha256 / **回读一致**（壳写后重算哈希比对）

### 4.4 同步

「上传到服务端 / 历史版本 / 回滚」三入口，未就绪时置灰。

- 上传内容与「导出 JSON」**同一份**，服务端按原始字节入库，版本 diff 无格式噪声
- 回滚前确认框提示「当前编辑内容将被覆盖，建议先另存」；回滚在服务端是**新建提交**，历史只增不改
- 版本列表显示 seq / kind / sha256 / 字节数 / 审计徽标；最新版的「回滚」置灰

### 4.5 预设与规则

「规则与预设…」三个分区：

| 分区     | 切换影响                   | 导入失败时         |
| ------ | ---------------------- | ------------- |
| 平台规则   | **立即重检**，结论随之变化        | 原子回退，原规则不动    |
| 高亮方案   | 立即重新着色                 | 必须能**编译**才算成功 |
| TXT 预设 | 选择只改导出格式；**应用预设**才重排原文 | —             |

**关键语义**：对**已有原文**的卡片，「选择预设」几乎不改变导出  
（`serializeStCard` 只替换 dirty 板块正文，标题与分隔符沿用原文）。  
只有「应用预设」会重排，且会先列出变更让你确认。

---

## 5. 规则编写指南

### 5.1 三种规则资产

| 类型     | 目录                       | 作用               | 规范                                   |
| ------ | ------------------------ | ---------------- | ------------------------------------ |
| 平台规则   | `rules/platforms/*.json` | 校验卡片是否符合某平台要求    | [docs/02](02-platform-rule-spec.md)  |
| 高亮方案   | `rules/highlight/*.json` | 编辑器着色的 scope 与配色 | [docs/03](03-highlight-rule-spec.md) |
| TXT 预设 | `rules/presets/*.json`   | 标题样式、板块顺序、分隔符    | [docs/05](05-preset-spec.md)         |

### 5.2 平台规则的最小可用骨架

```json
{
  "schemaVersion": 1,
  "id": "my-rule",
  "name": "我的规则",
  "version": "1.0.0",
  "extends": "sillytavern",
  "fields": [
    { "path": "meta.name", "label": "角色名", "required": true, "severity": "error" }
  ],
  "rules": [
    {
      "id": "no-halfwidth-brackets",
      "type": "pattern-forbid",
      "pattern": "\\[[^\\]]{1,20}\\]",
      "scope": "*",
      "severity": "warning",
      "message": "正文里出现了半角方括号",
      "hint": "改用全角【】"
    }
  ]
}
```

**支持的 `type` 只有这 7 种**（写错会报 `type "xxx" 不受支持`）：

`placeholder-min-count` · `placeholder-forbid` · `pattern-forbid` · `pattern-required` · `length` · `non-empty` · `forbidden-words`

> 注意：高亮方案里的 `match: { type: 'regex' }` 是**另一套**结构，不能照抄到平台规则里。>   
> 这个坑我做范例时踩过一次（见 §7）。

### 5.3 错误分级与位置

导入时若校验失败，错误会带**字段路径**并按组展示：

```
字段定义
  fields[0]  缺少 label
  fields[1]  required 必须是布尔值
继承
  extends    继承链无法解析：平台规则 "x" 不存在
```

分级语义：`error` 会阻止导出；`warning` 提示但可导出；`info` 仅建议。

可照抄的范例在 `examples/`（见 §6），全部经过 `npm run validate:examples` 校验。

---

## 6. 范例文件

`examples/` 下 10 个文件，全部由 `scripts/gen-examples.mjs` 从真实 shared 代码生成  
（不是手写 JSON，避免结构瑕疵），并由 `scripts/validate-examples.mjs` 逐个走真实解析链路校验。

| 文件                                       | 用途                       |
| ---------------------------------------- | ------------------------ |
| `cards/lin-wanzhao-v2.json`              | 完整 v2 卡片（六板块 + 2 条世界书）   |
| `cards/lin-wanzhao-v3.json`              | 同内容 v3 规格（验证规格切换）        |
| `cards/lin-wanzhao.txt`                  | 六板块 TXT（`【】` 标题 + 空行分隔）  |
| `cards/worldbook.txt`                    | 世界书 TXT v1.0（可直接粘进世界书板块） |
| `cards/minimal-v2.json`                  | 最小卡片（只有基本信息 + 性格）        |
| `cards/broken-missing-name.json`         | **故意缺必填字段**，用于演示导出拦截     |
| `rules/platform-sillytavern-strict.json` | 自定义平台规则（继承 + 追加 2 条检查）   |
| `rules/highlight-warm-paper.json`        | 自定义高亮方案（继承 + 改配色）        |
| `rules/broken-platform-rule.json`        | **故意坏**的规则，用于演示导入失败与原子回退 |
| `presets/hash-heading.json`              | 自定义预设（`##` 标题 + 空行分隔）    |

校验输出（可复跑 `npm run validate:examples`）：

```
范例卡片 9 项全过（含 v3 规格识别、坏样本 name 为空）
范例 TXT 5 项全过（可导入、世界书往返逐字一致）
自定义规则 7 项全过（schema、继承链、可编译、分隔符、标题前缀）
坏样本 3 项全过（规则被拒、报出 2 处错误、卡片 name 为空）
全部范例通过校验。
```

---

## 7. 端到端测试结果（阶段 8）

`scripts/verify-e2e.mjs` —— **36/36 项通过**。覆盖任务清单全链路：

| # | 环节       | 断言                                                | 结果 |
| - | -------- | ------------------------------------------------- | -- |
| 1 | TXT 分块编辑 | 六板块渲染、id 齐全（含 worldbook）、默认只挂 2 个编辑器、其余 4 块未进 DOM | ✔  |
| 2 | 语法高亮     | 8 段装饰、命中 placeholder/attribute/dialogue 三种 scope  | ✔  |
| 3 | 实时规则提醒   | 审计摘要、问题条目、字数分布 6 条                                | ✔  |
| 4 | 审计与拦截    | 注入后报出错误、顶栏与面板一致、拦截框提供「仍要导出/取消」                    | ✔  |
| 5 | 规则与预设    | 面板可开、三个下拉就绪、切 janitorai 立即重检、应用预设后当前预设同步          | ✔  |
| 6 | 导出       | JSON/TXT round-trip 双向通过                          | ✔  |
| 7 | 上传与回滚    | 连接就绪、上传新建、历史可读、回滚成功、**回滚后内容与目标版本一致**、历史只增不改       | ✔  |
| 8 | 截图归档     | 4 张图已生成                                           | ✔  |

### 7.1 证据边界（必须说清楚）

- 端到端跑的是 **`client/dist`**，与打进 MSI 的是**同一份产物** ——    
  由 `verify-build.ps1` 第 7 步的时间链断言保证（`shared/dist ≤ client/dist ≤ exe ≤ MSI`）。
- 「安装 → 启动」单独用冒烟测试验证：静默安装后进程存活、窗口标题 `Tavern Card Studio`、    
  窗口句柄非零、WebView2 子进程已加载、静置内存 77.6 MB。
- **没做**的是"安装后窗口内容截图"：WebView2 用 GPU 合成，GDI 截屏抓不到内容（纯白），    
  加 `--disable-gpu` 反而全黑；CDP 调试端口能连上 `/json` 但 WebSocket 握手被拒    
  （WebView2 限制，`--remote-allow-origins` 无效）。这是平台限制，不是应用问题。    
  因此截图验收用浏览器侧同一份 dist 完成（`e2e-*.png`）。

---

## 8. 发布检查清单逐项结果

| # | 项目      | 命令                        | 结果                                                                      |
| - | ------- | ------------------------- | ----------------------------------------------------------------------- |
| 1 | 单元测试    | `npm test`                | ✅ **240/240**                                                           |
| 2 | 配置与纪律校验 | `validate-config.mjs`     | ✅ **12/12**（schema / 权限 / 资源 / 禁 `@tauri-apps` / 禁 `innerHTML` / 决策表序号） |
| 3 | 决策表连续性  | `npm run check:decisions` | ✅ 22 条（#1–#22）严格递增                                                      |
| 4 | 构建与时间链  | `verify-build.ps1`        | ✅ **7/7 步**，四段断言全 OK                                                    |
| 5 | 截图验收    | 见 `e2e-*.png` / 各任务配图     | ✅ 已归档并人工过目                                                              |

时间链实测输出：

```
[INFO] 步骤 7/7：时间链断言（源 ≤ dist ≤ 交付物）
[INFO]   OK shared/src ≤ shared/dist（间隔 -15.7 秒）
[INFO]   OK 源 + shared/dist + rules ≤ client/dist（间隔 -467.5 秒）
[INFO]   OK client/dist ≤ tcs-shell.exe（间隔 -274.4 秒）
[INFO]   OK client/dist ≤ MSI（间隔 -268.9 秒）
[INFO]   交付物 Tavern Card Studio_0.1.0_x64_en-US.msi  2625536 字节
结论：通过
```

---

## 9. 本轮新增的固定动作（已写入 README）

1. **发布检查清单**五项，可逐条勾选（含 `Cargo.lock` 入库、时间链铁律、MSI 需管理员）。
2. **UI 任务收尾模板**：DOM 断言 → 截图 → 归档，三步固定。
3. **测试数据原则**：面板类测试用 shared 真实产物驱动，不手造数据结构。
4. **决策表序号校验**接入 validate 与 pre-commit。

---

## 10. 已知限制

| 项                       | 现状                        | 说明                                                                                  |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| MSI 需管理员                | perMachine                | Tauri 2.12 的 WiX 无 `installMode`；要免管理员需改 NSIS 打包（服务端 MSI 同样是 perMachine）            |
| 服务依赖 .NET Framework 4.x | WinSW 宿主                  | Win10/11 自带 4.8；Server Core 精简环境需先确认，否则服务起不来                                        |
| 服务宿主是第三方二进制             | WinSW v2.12.0，832 KiB，MIT | 已入库 `vendor/winsw/`，构建脚本校验 sha256。`node.exe` 自己无法当服务                                |
| 安装后 UI 无法截屏             | WebView2 GPU 合成           | 用浏览器侧同一份 dist 验收；冒烟测试单独验证进程与窗口                                                      |
| 客户端不自动更新                | 未实现                       | 需另做更新通道（Tauri updater）                                                              |
| 令牌明文存储                  | `plugin-store` 未加密        | 与"单令牌全权"的服务端模型一致；多用户需改凭据库                                                           |
| 导出不自动上传                 | 刻意                        | 避免误操作；同步面板手动上传                                                                      |
| 无撤销栈                    | 依赖"先另存"                   | 应用预设/回滚都会提示                                                                         |
| 管理面板无 HTTPS             | 明文 HTTP                   | 只应在本机回环访问；`controlHost` 默认 `127.0.0.1` 已隔离。若手工开到局域网做远程运维，流量含令牌，建议走 SSH 隧道或反向代理加 TLS |
| 版本列表上限 50               | 无分页 UI                    | 服务端支持 offset                                                                        |

---

## 11. 文档索引

| 文档                                                                                                                               | 内容                |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| [docs/00](00-tech-stack.md)                                                                                                      | 技术栈与阶段划分          |
| [docs/01](01-unified-card-model.md)                                                                                              | 统一卡片模型            |
| [docs/02](02-platform-rule-spec.md) / [03](03-highlight-rule-spec.md) / [04](04-worldbook-txt-spec.md) / [05](05-preset-spec.md) | 规则、高亮、世界书、预设 四份规范 |
| [docs/06](06-txt-import-mode.md)                                                                                                 | TXT 导入的严格/宽松两种模式  |
| [docs/07](07-audit-report-spec.md)                                                                                               | 审计报告与位置契约         |
| [docs/08](08-server-api.md) / [09](09-server-deploy.md)                                                                          | 服务端 API 与部署运维     |


| [docs/10](10-client-shell-assessment.md) / [11](11-shell-capability-contract.md) | 壳选型评估与能力契约 |
| [docs/12](12-t61-block-editor.md) | T6.1 六板块编辑器 |
| [docs/13](13-t68-client-settings.md) | T6.8 设置面板 |
| [docs/14](14-t64-t65-audit-panel.md) | T6.4/T6.5 实时提醒与审计面板 |
| [docs/15](15-t62-t63-preset-rules.md) | T6.2/T6.3 预设切换与规则管理 |
| [docs/16](16-t66-t67-export-sync.md) | T6.6/T6.7 导出与同步 |
| **docs/17（本文）** | **交付主文档：安装 / 配置 / 使用 / 规则编写 / 检查清单** |
