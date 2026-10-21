# 阶段 5 服务端演示记录

> 本文件由 `npm run demo:server` 自动生成，记录的是**真实 HTTP 请求**与真实落盘状态，不是手写示例。

- 生成时间：2026-10-21T05:41:48.602Z
- 运行环境：Node v22.22.2，服务端 v0.1.0，API v1
- 演示端口：API 19500，管理面板 19501（临时数据目录，演示结束自动清理）

## 1. 上传初版（原始字节直传）

```http
POST /api/cards?message=导入初版&author=演示脚本&filename=sample-card.json
Content-Type: application/json

<sample-card.json 的原始字节，共 3922 字节>
```

- 返回 **201**，卡片 id：`card-23a4e7`
- v1 sha256：`c3e85b1571b207d741fa55b80cc3d354a33bcb1cb1ee23e71aef26023d663b68`
- 与本地文件 sha256 一致：**true**

## 2. 下载 v1 并核对字节

```http
GET /api/cards/card-23a4e7/raw?version=1
```

- 响应头 `X-TCS-Sha256: c3e85b1571b207d741fa55b80cc3d354a33bcb1cb1ee23e71aef26023d663b68`
- 响应体与上传字节 `Buffer.equals` 比较：**true**

## 3. 提交 v2（只改一句文案）

```http
POST /api/cards/card-23a4e7/versions?message=调整叙述风格&author=演示脚本
```

- v2 sha256：`600f985d8edc5643a3b0e0f4f691fe5a8ad81377f31a92024af3ac2709a21057`，父提交 `2cee2f36`
- 字节长度变化：3922 → 3955（+33）

## 4. 版本历史

| 版本 | 提交 | 消息 | 作者 | 审计（error/warning/info） |
|---|---|---|---|---|
| v2 | `410944ab` | 调整叙述风格 | 演示脚本 | 0/0/2 |
| v1 | `2cee2f36` | 导入初版 | 演示脚本 | 0/0/2 |

## 5. 版本 diff

```json
{
  "identical": false,
  "bytes": {
    "fromSha256": "c3e85b1571b207d741fa55b80cc3d354a33bcb1cb1ee23e71aef26023d663b68",
    "toSha256": "600f985d8edc5643a3b0e0f4f691fe5a8ad81377f31a92024af3ac2709a21057",
    "sizeDelta": 33,
    "firstDiffOffset": 88
  },
  "lines": {
    "added": 2,
    "removed": 2,
    "hunks": [
      {
        "header": "@@ -2,7 +2,7 @@",
        "lines": 8
      },
      {
        "header": "@@ -56,7 +56,7 @@",
        "lines": 8
      }
    ]
  },
  "json": [
    {
      "path": "data.name",
      "kind": "changed",
      "before": "林晚照",
      "after": "林晚照（改）"
    },
    {
      "path": "data.extensions.depth_prompt.prompt",
      "kind": "changed",
      "before": "保持安静克制的叙述风格。",
      "after": "保持安静克制的叙述风格，句尾常用省略号。"
    }
  ]
}
```

行级 diff 首个 hunk（@@ -2,7 +2,7 @@）：

```diff
   "spec": "chara_card_v2",
   "spec_version": "2.0",
   "data": {
-    "name": "林晚照",
+    "name": "林晚照（改）",
     "description": "【基本信息】\n姓名：{{char}}\n年龄：24\n生日：11月3日\n身高：168cm　体重：52kg\n身份：旧城区「拾光」二手书店店主\n外貌：黑色长发常松松挽起，左耳一枚银质耳钉；惯穿米色粗针织开衫与帆布鞋\n\n【其他设定】\n聊天输出格式：以第三人称描写环境与动作，对话使用中文双引号；每次回复不超过 3 段。\n日常行为准则：营业时间 9:00-21:00；对熟客健谈、对陌生人礼貌但保持距离。\n\n【特殊设定】\n书店二楼不对客人开放。若{{user}}执意上楼，{{char}}会先沉默三秒，然后说「上面只是仓库」。\n\n【用户相关设定】\n{{user}}是常来淘旧书的熟客，{{char}}称呼{{user}}为「老位置」。",
     "personality": "安静、观察力强，习惯用具体物件表达情绪。被追问时会用玩笑话岔开话题，但从不撒谎。",
     "scenario": "深秋的午后，旧城区下着小雨，{{user}}推门走进「拾光」书店。",
```

## 6. 回滚到 v1

```http
POST /api/cards/card-23a4e7/rollback
Content-Type: application/json

{ "to": 1, "message": "回滚到初版（演示）" }
```

- 生成新版本 **v3**（不是删除 v2，历史只增不改）
- v3 sha256：`c3e85b1571b207d741fa55b80cc3d354a33bcb1cb1ee23e71aef26023d663b68`
- 与 v1 sha256 相同：**true**

## 7. 回滚后的逐字节校验

- 版本总数：3（v1、v2、v3 都在）
- v3 原始字节与 v1 `Buffer.equals`：**true**
- `GET /diff?from=1&to=3` → `identical = true`，`firstDiffOffset = null`

用 Git 对象层复核（裸仓库是标准 Git 仓库，可随时用 `git --git-dir <repo> log` 查看）：

```console
$ git --git-dir "<dataDir>/repos/<cardId>.git" log --oneline
39671db 回滚到初版（演示）
410944a 调整叙述风格
2cee2f3 导入初版
```

```console
$ git --git-dir "<dataDir>/repos/<cardId>.git" ls-tree -r HEAD
100644 blob 025ffcac39b89c76382d30d3cc011bfb655a33de	audit.json
100644 blob 3c9bf38cb5b3d875f9970c5bc597a056ed6e41c7	card.json
```

- HEAD 提交 `39671dbd215a9bb6508154a26828b1ec6ec568a3` 的 `card.json` blob oid：`3c9bf38cb5b3d875f9970c5bc597a056ed6e41c7`
- 用「blob 头 + 上传字节」独立算出的 Git blob oid：`3c9bf38cb5b3d875f9970c5bc597a056ed6e41c7`
- 两者一致：**true**；blob 内容与 v1 字节一致：**true**
- HEAD 同时包含审计快照 `audit.json`（blob `025ffcac39b89c76382d30d3cc011bfb655a33de`），说明审计是**提交的一部分**，与卡片字节同时被版本化。

对比提交之间（等价于 `git diff v1 v3 -- card.json`）：

```console
$ git --git-dir "<dataDir>/repos/<cardId>.git" diff 2cee2f3 39671db -- card.json
（无输出 —— 回滚提交与 v1 的 card.json 完全相同）
```

## 8. 审计随版本快照存储

| 版本 | 报告生成时间 | error | warning | info | 可导出 | 报告 sha256 |
|---|---|---|---|---|---|---|
| v1 | 2026-10-21T05:41:48.675Z | 0 | 0 | 2 | true | `7bb9bd172fc67172…` |
| v2 | 2026-10-21T05:41:48.966Z | 0 | 0 | 2 | true | `c4364b4a6297de86…` |

- v1 报告里的 `card.name` = `林晚照`；v2 = `林晚照（改）`（各版本保留当时的输入）
- v2 快照重复读取字节一致：**true**
- `refresh=true` 返回 `X-TCS-Audit-Source: recomputed`，并给出快照 sha256 = `c4364b4a6297de86…`
- 重算后再次读取 v2 快照：字节仍然一致 **true**（快照没有被覆盖）

v2 审计报告摘要（截取前 4 条问题）：

```json
{
  "schemaVersion": 1,
  "platformRule": {
    "id": "sillytavern",
    "name": "SillyTavern（原生）",
    "version": "1.0.0",
    "lineage": [
      "sillytavern"
    ]
  },
  "presetId": "default",
  "wordCount": {
    "total": {
      "chars": 394,
      "charsNoSpace": 378,
      "cjk": 251,
      "words": 17,
      "totalWords": 268
    },
    "blocks": [
      "基本信息=63",
      "性格=35",
      "其他设定=65",
      "特殊设定=32",
      "用户相关设定=18",
      "世界书=55"
    ]
  },
  "summary": {
    "error": 0,
    "warning": 0,
    "info": 2,
    "exportable": true
  },
  "issues": [
    {
      "severity": "info",
      "category": "platform-rule",
      "ruleId": "char-placeholder-suggested",
      "message": "正文中未出现 {{char}} 占位符，角色名硬编码后换卡易失效",
      "location": {
        "blockId": "settings",
        "field": "description",
        "start": 0,
        "end": 40,
        "line": 1,
        "column": 1,
        "lineText": "聊天输出格式：以第三人称描写环境与动作，对话使用中文双引号；每次回复不超过 3 段。",
        "excerpt": "聊天输出格式：以第三人称描写环境与动作，对话使用中文双引号；每次回复不超过 3 "
      }
    },
    {
      "severity": "info",
      "category": "format",
      "ruleId": "builtin:st-defaults-omitted",
      "message": "6 个字段未写出，导出时由目标平台按缺省值处理：话痨程度（talkativeness）、收藏标记（fav）、常驻（constant ×2）、选择性触发（selective ×2）、插入位置（position）、优先级（priority）",
      "location": {
        "blockId": null,
        "field": "file",
        "start": null,
        "end": null,
        "line": null,
        "column": null
      }
    }
  ]
}
```

## 9. 管理面板与服务控制（控制面独立于数据面）

- 面板地址：`http://127.0.0.1:19501/`（由 supervisor 提供，worker 停止时仍可访问）
- 当前 worker：`running`，pid 42252
- `POST /control/service/stop` → `stopped`；此时面板 `GET /` 仍返回 **200**，API `GET /api/cards` 返回 **503**（`SERVICE_UNAVAILABLE`）
- `POST /control/service/start` → `running`，数据仍在（版本总数 3）

## 10. 结论

1. 上传/下载/回滚三条路径的 sha256 完全一致，说明服务端没有对卡片 JSON 做任何重序列化；
2. 每个版本在 Git 裸仓库里都有 `card.json`（原始字节）与 `audit.json`（当时审计报告），可用原生 git 复核；
3. 回滚是新增提交，历史不重写；`diff identical=true` 与 `git diff` 空输出互相印证；
4. 审计快照随版本存储，`refresh=true` 只读重算，不改写历史结论。

