# v0.1.7 进度报告（2026-10-31 11:10）

> **替代 2026-10-30 17:40 版**（旧版备份在 `PROGRESS-v0.1.7-20261030.md.bak`）。
> 数据全部来自仓库实测，不是回忆。每条状态后面都写了「怎么验证的」，你可以自己复跑。
>
> 位置说明：放在 `reports/` 而不是 `release/` —— 后者被 `.gitignore` 整目录忽略，
> 报告放那里就没有版本历史。
>
> 状态四种：**✅ 已完成并有证据** / **🔄 部分完成** / **⏸ 未开始** / **🔴 阻塞**。
> 「写完代码」和「验证通过」分开计 —— 这一版里这两件事被混淆过三次，每次代价都不小（§七）。

---

## 一、一句话

**桌面端可以发**（功能齐、测试全绿、双 MSI 已打）。
**安卓端今天从"完全不能交付"变成"能装能跑、但还不能干活"** ——
APK 打通了、移动端 UI 接上了、真机能启动，但**它连不上 ST，聊天用不了**。
这是最关键的那道缺口。

---

## 二、总体状态

| 块 | 状态 | 能交付吗 |
|---|---|---|
| **桌面端 0.1.7** | ✅ 功能全部完成；双 MSI 已打；服务端 MSI 真装真卸 PASS 27/27 | **可以发布**（客户端 MSI 仍未实际安装，§六） |
| **安卓端 0.1.7** | 🔄 APK 能构建/能装/能启动；移动端 UI 已接入且三处真机反馈已修；**但 ST 起不来，聊天不可用** | **不能**，缺 T15.3 主体 |
| **发布动作** | ⏸ 未 push、未发 Release | 等你决定 |

### 规模

```text
65 个提交，10-27 09:18 → 10-30 23:41（之后的改动尚未提交）
234 个文件，+36,341 / −879 行
201 个任务全部 completed（0 pending）
决策表 337 条（v0.1.7 占 78 条）
测试 2,241 项 / 154 个文件 / 0 失败（8 skipped）
```

验证命令：`npm test`、`node scripts/check-decision-table.mjs`、`node scripts/check-version-literal.mjs`

---

## 三、安卓端（现在的重点）

### 3.1 今天真正打通的四件事

| # | 事情 | 判据（可复跑） |
|---|---|---|
| 1 | **APK 首次构建成功** | `bash scripts/build-android.sh --release` → 39 MB，三个 `.so` 全 ELF 且大小正确 |
| 2 | **真机安装 + 启动** | Redmi Note 8 Pro / Android 11，`adb install` Success，进程常驻 RSS 287 MB，无 `UnsatisfiedLinkError` |
| 3 | **移动端 UI 接进入口** | `bash scripts/verify-mobile-entry.sh` → **14 项全过**；四 Tab 截图 `assets/android/10..13` |
| 4 | **正式签名可分发** | `apksigner verify` 退出码 0，证书 `CN=Tavern Card Studio`（与 MSI 同一套 keystore） |

产物：

```text
release/android/tavern-card-studio-0.1.7-arm64-release.apk
40,273,617 B (39 MB)   sha256 73ddc48481e196d50668be924e8a0e88a10dfc4dc54534528bc152e9745f6335
```

### 3.2 移动端 UI 现在长什么样

四 Tab：**聊天 / 卡片 / 仓库 / 我的**，夜航深色主题。

- **聊天页**：空状态给"还没有对话，点右上角选角色"（不是"暂无数据"）；
  有语音按钮（按住说话、上滑切模式、下滑取消）；
- **我的页**：完整的 API 连接页，六个后端可选，采样参数在请求体里；
- **卡片 / 仓库页**：明确说"这些还在桌面客户端做，后续版本提供"。

截图：`assets/android/10-mobile-chat.png`、`11-mobile-cards.png`、
`12-mobile-repo.png`、`13-mobile-me.png`

这是 T15.5 做完就该有的东西 —— 但此前从来没有入口页，详见 §七 教训 1。

### 3.2b 真机反馈的三处 UI 问题已修（2026-10-31 12:30）

用户报了三条，**修复过程中对着截图逐项核对，又抓出三个同级缺陷**。
六个里有四个属于同一族：**代码在跑、测试全绿、用户看到的是错的**。

| # | 现象 | 根因（一句话） | 判据 |
|---|---|---|---|
| 1 | 输入区悬浮在页面中部 | `.nb-chat` 在 CSS 里**零定义**（`flexGrow:0`），高度被内容撑成 501 / 父 743 | `composer.bottom === tabbar.top`（修后 gap = 0） |
| 2 | 接口源点了没反馈 | `aria-pressed` 写对了，**CSS 零规则** ⇒ 状态有、表达无 | 点第二项后该项 `pressed/expanded=true`，其余 false |
| 3 | 语音配置没入口 | `voice-settings.ts` 448 行导出完整，**除自身外零引用**（两端都没挂） | 展开后 11 个 `data-role` 齐全 |
| 4 | **输入框根本不在 DOM 里** | `mount()` 建了 `textarea.nb-input` 但**忘了 append** | `querySelector('.nb-input') !== null` |
| 5 | **消息永远不贴底** | `renderMessageList()` 总新建一层 `.nb-msglist`，滚动被内层接管、贴底滚外层 | 最后一条气泡 `bottom` < 输入区 `top` |
| 6 | **麦克风是灰方块** | `<button>` 的 UA 默认外观没覆盖（`radius:0` / `bg:rgb(107,107,107)`） | 与 `.nb-send` 的 radius/bg/border 逐字相同 |
| 7 | 「我的」页内容被截断 | `.nb-page` 没有 `overflow-y`，展开后内容 1558px / 可视 690px | `.nb-scroll` 的 `scrollHeight > clientHeight` |

截图对比：`assets/android/fix-20261031/`（`before-*` / `after-*` + `COMPARE.png` 拼图）
取证报告：`.verify/t1500-evidence/ROOT-CAUSE.md`（两轮，含全部数字）

### 3.2c 🔴 关于 #4 和 #5 要多说一句

这两个不是用户报的，是**按"截图对比验收"时自己看出来的**，但都比用户报的三条严重：

- **#4 意味着真机上没法打字**（输入区只剩麦克风和发送两个按钮）；
- **#5 意味着新收到的回复被输入区盖住 297px**，用户看不到。

它们能活到真机，是因为 **`grep -rn "new ChatPanel" test/` 零结果** ——
此前所有"移动端 UI"断言都是**读源码做正则**，只能证明"代码里写了这句话"，
不能证明"跑起来生成了这个元素"。

已补 `test/chat-panel-mount.test.mjs`（真的 mount 一次，在生成的树上找），
并做变异验证：删 `composer.append(input)` ⇒ 3 条变红；删 `syncSubtitle()` ⇒ 1 条变红。

### 3.3 🔴 最关键的缺口：聊天用不了

安卓上聊天的链路：

```text
聊天面板 ──▶ StChatBridge（Tauri 命令）──▶ ST HTTP（127.0.0.1:8000）
                                              ▲
                                              └── 需要 App 内先把 ST 跑起来
```

**第三段是断的。** 现状核实：

| 检查 | 结果 |
|---|---|
| `gen/android/.../java/com/taverncardstudio/client/` 只有 `MainActivity.kt` + `generated/` | ✔ |
| 全目录 grep `ForegroundService` / `startForeground` / `unpackNode` / `libnode.so` | **零结果** |
| 含义 | **App 内没有任何"启动 Node / 解包 ST / 起前台服务"的代码** |

纯逻辑层已写好（`shared/src/android/st-lifecycle.ts`，26 条测试），
但没有 Java 侧去调用它。**这是 T15.3 的主体，还没写。**

### 3.4 安卓端完整状态表

| 子项 | 状态 | 证据 |
|---|---|---|
| Spike ①：Node 22 跑起 ST 1.19 | ✅ | 真机四判据全过，首页 734,837 字节 |
| Spike ②：ST 端点契约 | ✅ | `docs/adapter-contract-st-v1.19.md` |
| T15.1 夜航 token + 四 Tab | ✅ | `nebula-tokens.css`、`chat.css`，走查 13 项 |
| T15.4 HTTP 层 `st_api.rs` | ✅ | 含流式 `post_stream`（不读 Content-Type，避陷阱 #10） |
| T15.5 聊天面板 | ✅ **代码 + 入口都通了**（含真机反馈 3 处与自查 3 处修复，见 §3.2b） | `chat-panel-mount.test.mjs` 9 条真 mount + 布局数字 |
| T15.6 语音 | ✅ 三条路径 | 录屏 14 帧，15 条判据全绿 |
| **T15.3 Android 主体** | **🔴 未写** | 见 §3.3 |
| T15.2 卡片/仓库页移植 | ⏸ | 移动端这两页是空状态说明 |
| W^X「APK 内真跑」 | ⏸ | 只有 shell 侧验过，没在 App 沙箱里验 |
| 真机五条件（T15.5 §七） | ⏸ | 缺 ST 跑不起来，无法验 |

---

## 四、桌面端（可以发）

| 项 | 状态 |
|---|---|
| 功能 | ✅ 八板块编辑、审计、导入导出（TXT / ST JSON / PNG）、预设库、仓库同步、ST 面板 |
| 双 MSI | ✅ 客户端 4.3 MB、服务端 33.9 MB（均 0.1.7） |
| 版本号载体 | ✅ `check-version-literal` 全绿（10 个载体一致） |
| 服务端 MSI 真装真卸 | ✅ PASS 27/27（T10.25） |
| **客户端 MSI 实际安装** | ⚠️ **没验过** —— T10.25 只跑了服务端那条 |

最后一条要说清：客户端 MSI 打出来了、体积正常、内容核验过，
但**没有一次"装到机器上、打开、卸载"的完整记录**。要发布建议补这一步。

---

## 五、安卓兼容性（你的目标：2018 年后大部分手机）

| 项 | 实测 | 判断 |
|---|---|---|
| Android 版本 | `minSdk 24`（7.0） | ✅ 18 年后手机最低 8.0，全覆盖 |
| CPU 架构 | 仅 `arm64-v8a` | 🔄 约 90%，缺 32 位入门机 |
| **16KB 页对齐** | 三个 `.so` **全是 4KB** | 🔴 Android 15+ 启用 16KB 页的新机会 `dlopen` 失败 |

### 16KB 这条要单独说

Google 已规定 2025-11 起新提交必须支持 16KB。你的目标里"新机"权重更高，
而新机正朝 16KB 走。**这是当前最该处理的一项。**

**但修它的成本和补 32 位是同一件事**：两者都必须**重编 `libnode.so`**
（约 17 小时 + 一台 Linux 机器，Windows 编不了）。

> 决策点：**要投那 17 小时，就一次把「16KB + 32 位」一起解决。**

只修 16KB 不重编 libnode 是白修 —— 三个 `.so` 有一个是 4KB 就加载不了。

详细依据：`docs/android-compat-matrix.md`

---

## 六、没做 / 做不了的（直说）

| 项 | 为什么没做 |
|---|---|
| **T15.3 Android 主体**（前台服务、ST 解包、`--dataRoot`、生命周期） | 安卓端能不能用的分水岭，工作量最大的一块 |
| **窄屏布局真机截图** | `adb` 一直 `offline`（USB 层），`screencap` 回来是截断 PNG。代码改了、也打进包了，但**没有真机图** |
| 客户端 MSI 实际安装验证 | 要人操作 |
| AAB | 现在只出 APK，上架 Play 才需要 |
| 真机五条件 | 依赖 ST，见 §3.3 |
| 16KB / 32 位 | 见 §五 |

---

## 七、这一版我犯的错（记下来，别重犯）

三条，都不是"能力不够"，是**方法有问题**。

### 教训 1：做完了不等于交付了 —— 移动端 UI 从没进过产物

T15.5 把四 Tab + 夜航聊天页全做完了，`shell.ts`、`chat.css`、`chat-panel.ts` 一应俱全。但：

- `index.html` 一直是**桌面编辑器**；
- `chat/demo.html` 只用于截图，**不进产物**；
- `chat/` 目录**没有被任何非 chat 文件 import 过**。

⇒ 装到手机上是桌面编辑器。**你那句"感觉只是把电脑客户端完全打包进去了"，
就是当时产物的准确描述。**

根因：我所有断言都在验"组件对不对"，没有一条验「**产物入口是哪个 UI**」。
现在 `verify-mobile-entry.sh` 补上了，其中三条是"桌面元素必须不存在"。

### 教训 2：手上一直有对照样本，却先去猜

你报"release 缺开发者证书"时，我判定是缺 v1 签名，试了四种：

| 尝试 | 结果 |
|---|---|
| 事后 `apksigner --v1-signing-enabled true` | 仍 `v1: false` |
| 加 `--min-sdk-version 21` | 仍 `v1: false` |
| gradle `enableV1Signing = true` | 仍 `v1: false` |
| 降 `minSdk` 到 23 强制 v1 | **硬报错**（dialog 插件要求 24） |

四次都不成立 ⇒ 前提错了。回头一对照才发现：

**你装成功过的 debug 包，签名方案跟 release 一模一样**（`v1: false, v2: true`）。
所以 `v1: false` 不阻碍安装 —— 那是 apksigner 在 minSdk≥24 时的**展示逻辑**。
真因是**签名冲突**：debug 证书 `CN=Android Debug` vs release `CN=Tavern Card Studio`，
**包名相同**。

**教训**：「换个方向试试」之前先问 —— **手上有没有一个"已知能跑"的样本可比？**
有的话五分钟能定位；没有才该靠试。

### 教训 3：判据在跑，但它看的不是那个东西

这一版里这类错出现了 **9 次**：

| 判据 | 问题 |
|---|---|
| `if [ "$?" -eq 0 ]`（前面隔了个 `echo`） | `$?` 变成 echo 的退出码，核验永远通过 |
| 在 `.so` 还是 0 字节时 grep 前端文件名 | 永远判"过期"，每轮白跑 17 分钟编译 |
| `grep '^Verifies'` 判断签名 | 那行只在加 `--verbose` 时才有，签名成功却报失败 |
| `[ -x apksigner.bat ]` | Windows 上 `.bat` 没有执行位，判假 ⇒ 静默跳过签名 |
| `lastElementChild` 取"最后一条消息" | 草稿卡永远挂末尾，取到的是草稿卡 |
| 再 fire 一次 `pointerup` 验不重复通知 | 已被 `if (stage !== 'recording') return` 挡掉，没跑到被测代码 |
| 明文 grep `.so` 找 `nb-tabbar` | Tauri 把资源**压缩**后嵌入，明文必然找不到 |
| 截图核对"146 ≤ 180 通过" | 约束（`max-width`）根本没生效，只是这次没顶到上限 |
| 漏了 `resolveStAddress` 纪律（今天刚修） | 在 `mobile/main.ts` 硬写 `127.0.0.1:8000`，被两条静态断言抓住 |

**归纳成一句**：判据要看**退出码与文件字节**，不要看"输出里有没有某段文字"；
要问"**约束在不在**"，不要看"这次的值有没有越界"。

---

## 八、建议的下一步（按价值排）

### 优先级 1：让安卓端真的能用（T15.3 主体）

唯一挡住"交付"的东西。具体要写：

1. **前台服务** —— 用户随时切走，没前台服务 ST 立刻被杀。
   纯逻辑已备好（`shouldRestartService`、`foregroundNoticeText`）；
2. **首次启动解包 ST** —— 从 `assets` 解到 `filesDir`，带进度
   （`unpackProgress` 已写好，封顶 0.99）；
3. **`--dataRoot=filesDir` 启动 Node** —— 参数必须显式传，否则写只读目录；
4. **W^X 落地** —— `libnode.so` 走 `jniLibs` + `extractNativeLibs`（已配好），
   执行时用 `nativeLibraryDir` 的路径。

完成判据：**App 内点"开始聊天"→ ST 起来 → 能发一条消息并收到回复**。

### 优先级 2：补两个验证缺口

- **真机截图**：移动端四 Tab + 窄屏布局。注意**先卸载旧版**再装 release（签名冲突）。
- **客户端 MSI 实际安装**：装一次、开一次、卸一次，留日志。

### 优先级 3：兼容性（取决于你的目标用户）

- 只面向主流机型 → 现在够用，可以发；
- 要覆盖 2024+ 新机 → 必须处理 16KB（重编 libnode，17 小时）；
- 要覆盖低端机 → 同时补 32 位（**同一次编译窗口**）。

---

## 九、需要你做两个动作

1. **USB 弄回来**：解锁屏幕 → 拔插数据线 → 手机上点"允许 USB 调试" →
   USB 模式选"传输文件"。
   现在设备是**整条从 adb 列表消失**（不是离线），所以不只是息屏。

2. **装新 APK 前先卸载旧版**：`adb uninstall com.taverncardstudio.client`，
   或手机上手动卸载。否则会因签名不一致被拒（vivo 报"缺乏开发者证书"）。

两者都做完，我可以立刻补上"移动端真机截图"和"客户端 MSI 安装验证"。

---

## 附：本报告的数据来源

```bash
git branch --show-current                # rel/v0.1.7
git log main..HEAD --oneline | wc -l     # 65
git diff --shortstat main..HEAD          # 234 files, +36341 / -879
npm test                                 # 2216 tests, 0 fail
node scripts/check-decision-table.mjs    # 337 条连续
node scripts/check-version-literal.mjs   # 载体全部一致
bash scripts/verify-mobile-entry.sh      # 14/14
bash scripts/build-android.sh --release  # 39 MB, 核验通过
```
