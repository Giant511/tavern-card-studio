/**
 * 聊天参数配置的**字段规格**（v0.1.7 / 第三批问题二）。
 *
 * ## 这个文件为什么必须存在
 *
 * ST 的设置是一个**层级很深、命名不统一**的对象。2026-10-31 逐个核对
 * 本机 `D:\SillyTavern\default\content\settings.json` 得到的真实层级是：
 *
 * ```
 * oai_settings.temp_openai            = 1.0     ← 注意不是顶层 temp
 * oai_settings.top_p_openai           = 1       ← 不是 top_p
 * oai_settings.top_k_openai           = 0
 * oai_settings.openai_max_tokens      = 300
 * oai_settings.freq_pen_openai        = 0
 * oai_settings.repetition_penalty_openai
 * oai_settings.stream_openai          = true
 * power_user.trim_spaces              = true    ← 在子对象里，不在顶层
 * power_user.collapse_newlines        = false
 * power_user.trim_sentences           = false
 * power_user.quick_continue           = false
 * power_user.continue_on_send         = false
 * power_user.instruct.names_behavior  = 'force' ← 两层嵌套
 * ```
 *
 * **写错一个字母的后果是"保存成功但没生效"** —— 界面显示新值、ST 用的是旧值，
 * 而且不会报错。这类缺陷只能靠"字段表集中一处 + 名字逐个核对过"来防。
 *
 * ## 为什么用 `path` 数组而不是点号字符串
 *
 * `power_user.instruct.names_behavior` 里的键名不含点号，但**不保证以后不会有**。
 * 用数组就没有这个隐患，也不用写 split/join 两处转换。
 *
 * ## 三个分区对应聊天页设置里的前两项
 *
 * 用户要的四项是：AI 响应配置 / AI 回复格式化 / 世界书管理 / 用户设置。
 * 前三组字段（sampling / formatting）在本文件里；世界书走 `/api/worldinfo/*`，
 * 用户设置走 `power_user` 的 persona 相关键 —— 两者结构不同，各自单独处理。
 */

/** 一个可编辑字段的规格 */
export interface SettingField {
  /** 在 ST settings 对象里的路径（支持嵌套） */
  path: readonly string[];
  /** 显示名（用户看得懂的说法，不是 ST 的键名） */
  label: string;
  /** 一句话说明"改了会发生什么"。不写的话用户不知道为什么调它 */
  hint?: string;
  /**
   * `textarea` 是 2026-11-03 加的：作者注释 / 负面提示词这类**多行文本**
   * 用单行 input 编辑极难用（看不到换行、光标跳）。
   */
  kind: 'number' | 'boolean' | 'text' | 'textarea' | 'enum';
  /**
   * 同一页内的分组标题（2026-11-03 加）。
   *
   * 为什么需要：照 ST 原生的「AI 响应配置」截图补齐之后，这一页有 27 个字段。
   * 一条长列表从头滚到尾，用户找不到"温度在哪一段"。
   * 分组标题只是视觉分段，不改变字段的任何语义。
   */
  group?: string;
  /** 数值字段的范围与步长（`kind === 'number'` 时必填） */
  min?: number;
  max?: number;
  step?: number;
  /** 枚举字段的取值（`kind === 'enum'` 时必填） */
  options?: ReadonlyArray<{ value: string | number; label: string }>;
  /**
   * 本 App **暂不支持**这一项（2026-11-03，第二十七批）。
   *
   * ## 为什么要有这个标记，而不是直接把字段删掉
   *
   * 用户要求「两个 CFG 在 UI 上先标暂不支持，然后也不可配置」。
   * 删掉字段会让人以为"ST 里没这东西"；留着可编辑会让人以为"配了有用"——
   * 后者更糟：真机 10 次实测证明 CFG 缩放/反向提示**不进生成请求**，
   * 配了完全没效果，而界面看起来一切正常。
   *
   * 所以：**显示、禁用、写明原因**。
   *
   * 有值时渲染层必须：
   *   ① 控件 `disabled`
   *   ② 把这段文字显示在 hint 位置
   *   ③ 不把该字段纳入保存（避免用户以为改过）
   */
  unsupported?: string;

  /**
   * 字段缺失时用什么值显示。
   *
   * ★ 必须有：2026-10-31 核对发现**默认 settings.json 里并不是每个键都存在**
   * （`humanize_ids`、`continue_postfix` 就没有）。UI 直接读 `undefined`
   * 会显示成空白或 NaN，用户以为坏了。
   */
  fallback: number | boolean | string;

  /**
   * 这一项**会不会随生成请求发出去**（2026-11-03 加）。
   *
   * ## 为什么必须有这个标记
   *
   * ST 的 `/api/backends/chat-completions/generate` **完全从请求体读参数、
   * 不读 settings.json**（`docs/adapter-contract-st-v1.19.md:219`，
   * 本次又用 `chat-completions.js` 里 `request.body.*` 的出现次数核过一遍）。
   *
   * 而「AI 响应配置」那一页在 ST 原生里混了两类东西：
   *
   * | 类别 | 例子 | 我们的 App 里 |
   * |---|---|---|
   * | 真采样参数 | 温度 / Top P / 种子 | 拼进请求体 ⇒ **真生效** |
   * | ST 前端用的 | 角色名称行为 / 提示词 / 请求思维链 / 内嵌媒体 | **不生效**（前端已被我们替换） |
   *
   * 不加标记的后果是把后者也摆成可编辑 —— 用户改完保存成功、界面显示新值、
   * 生成结果一个字节都没变。这正是本项目反复吃亏的「假控件」。
   *
   * ## 约定
   *
   * · `sent` 省略 = `true`（默认随请求发出去）
   * · `sent: false` **必须**同时给 `storeOnlyReason`，否则判据会红
   *   （见 `test/chat-settings-schema.test.mjs`「每个字段要么有映射、要么写明为什么只存储」）
   */
  sent?: false;
  /** `sent: false` 时必填：为什么这一项在 App 里改了不起作用 */
  storeOnlyReason?: string;
  /**
   * **间接生效**：不进请求体，但会改变我们发出去的内容。
   *
   * ## 为什么需要这个标记（2026-11-04）
   *
   * 原先这套机制只有一个二分法：要么进请求体（`sent` 缺省 true），
   * 要么"只存不生效"（`sent: false`）。而「上下文长度」属于**第三种**：
   *
   * ```text
   *   openai_max_context 不进请求体
   *     ↓ 但 shell 读它得到 contextLimit
   *     ↓ computeBudget(contextLimit, …) 算出预算
   *     ↓ 决定丢弃多少条最旧的历史
   *   ⇒ 它实实在在影响模型看到什么
   * ```
   *
   * 上一版把它标成 `sent: false` 并写"App 不带这个上限"——**那是错的**，
   * 代码明明读了它。所以从"二元"改成"三元"，并要求：
   * 没有请求体映射的字段**必须**显式说明自己属于哪一种。
   *
   * 值是一句话描述生效路径（给判据看也给人看）。
   */
  indirect?: string;
}

/** 分区：一组相关字段 */
export interface SettingSection {
  id: string;
  title: string;
  /** 这一组是干什么的，一句人话 */
  intro: string;
  fields: readonly SettingField[];
}

/**
 * ① AI 响应配置 —— 影响"模型怎么生成"。
 *
 * ## 2026-11-03：照 ST 原生面板补齐（用户给了截图，要求"全都是原生的 ST 功能"）
 *
 * 原来只有 6 个字段，注释里写着"ST 原生有 20 多个，手机上全搬过来只会让人不敢动"。
 * 用户明确要全量，所以按截图逐项补齐到 27 个，并**分五组**。
 *
 * ## 字段名逐个核对过，不是猜的
 *
 * ST 的 `oai_settings` 与它的**预设文件**用两套名字（预设里叫 `temperature`，
 * 设置里叫 `temp_openai`）。对照表来自 `public/scripts/openai.js` 的
 * `settingsToUpdate`（103 条，其中 47 条非连接项），已程序化提取核对。
 *
 * ## ★★★ 这里只有**真的生效**的字段（2026-11-04 清理）
 *
 * 原先这一页有 36 个字段，其中 16 个分组在「仅存 ST（App 生成不使用）」里 ——
 * 意思是"改了没用"。用户明确要求：
 *
 * > 用户不需要知道 ST 是什么，只需要知道 APP 有完整聊天功能就行
 *
 * 而"摆一个改了没用的开关 + 解释它只保存到某个叫 SillyTavern 的地方"
 * 恰好是**两头都错**：既给了假控件，又把内部架构暴露给用户。
 *
 * 所以那 15 个真正不生效的字段**整块删掉**（不是隐藏），
 * 只留下确实会影响回复的 21 个。
 *
 * ## 关于 `sent` 标记
 *
 * 接口里仍保留 `sent` / `storeOnlyReason`，但目前**没有字段在用** ——
 * 保留下是因为将来若真要做"只存不生效"的功能，这套机制是对的。
 *
 * ★ 注意 `sent: false` 的语义是"不进请求体"，**不等于"不生效"**：
 * 「上下文长度」就不进请求体，但它决定我们发多少历史（`computeBudget`）。
 * 上一版把它错标成 `sent: false` 并在文案里说"App 不带这个上限"，
 * 而代码明明读了它 —— 这类"解释性注释腐烂"比没有注释更害人。
 */
export const SAMPLING_SECTION: SettingSection = {
  id: 'sampling',
  title: 'AI 响应配置',
  intro: '这些值决定模型怎么"想"和怎么写。改完对下一次回复生效。',
  fields: [
    {
      path: ['oai_settings', 'openai_max_tokens'],
      label: '最大回复长度（Token）',
      hint: '一条回复最多写多少 token。太小会写到一半被截断；推理模型要留足思维链的额度。',
      kind: 'number',
      group: '回复长度',
      min: 1,
      max: 32_000,
      step: 1,
      fallback: 800,
    },

    {
      path: ['oai_settings', 'freq_pen_openai'],
      label: '频率惩罚',
      hint: '调高会减少重复用词。太高会让句子变别扭。',
      kind: 'number',
      group: '采样',
      min: 0,
      max: 2,
      step: 0.05,
      fallback: 0,
    },

    {
      path: ['oai_settings', 'pres_pen_openai'],
      label: '存在惩罚',
      hint: '调高会让模型更愿意聊新话题。一般保持 0。',
      kind: 'number',
      group: '采样',
      min: -2,
      max: 2,
      step: 0.05,
      fallback: 0,
    },

    {
      path: ['oai_settings', 'top_p_openai'],
      label: 'Top P',
      hint: '只在最可能的这部分词里挑。一般是 1，调低会更保守。',
      kind: 'number',
      group: '采样',
      min: 0.01,
      max: 1,
      step: 0.01,
      fallback: 1,
    },

    {
      path: ['oai_settings', 'top_k_openai'],
      label: 'Top K',
      hint: '每一步只看最可能的 K 个词。0 表示不限。',
      kind: 'number',
      group: '采样',
      min: 0,
      max: 200,
      step: 1,
      fallback: 0,
    },

    {
      path: ['oai_settings', 'top_a_openai'],
      label: 'Top A',
      hint: '按概率动态裁剪候选。一般 0（关闭）。',
      kind: 'number',
      group: '采样',
      min: 0,
      max: 1,
      step: 0.01,
      fallback: 0,
    },

    {
      path: ['oai_settings', 'min_p_openai'],
      label: 'Min P',
      hint: '丢掉概率低于"最高概率 × 这个值"的词。一般 0（关闭）。',
      kind: 'number',
      group: '采样',
      min: 0,
      max: 1,
      step: 0.01,
      fallback: 0,
    },

    {
      path: ['oai_settings', 'repetition_penalty_openai'],
      label: '重复惩罚',
      hint: '另一种抑制重复的方式。一般是 1，超过 1.2 容易语句破碎。',
      kind: 'number',
      group: '采样',
      min: 1,
      max: 2,
      step: 0.01,
      fallback: 1,
    },

    /* ── 采样 ── */
    {
      path: ['oai_settings', 'temp_openai'],
      label: '温度',
      hint: '越高越天马行空，越低越稳。0.8 到 1.2 之间最常用。',
      kind: 'number',
      group: '采样',
      min: 0,
      max: 2,
      step: 0.05,
      fallback: 1,
    },

    /* ── 随机性 ── */
    {
      path: ['oai_settings', 'seed'],
      label: '种子',
      hint: '-1 表示每次随机。填固定值可以让相同输入尽量复现同一回复（模型不一定保证）。',
      kind: 'number',
      group: '随机性',
      min: -1,
      max: 2_147_483_647,
      step: 1,
      fallback: -1,
    },

    {
      path: ['oai_settings', 'reasoning_effort'],
      label: '推理强度',
      hint: '让模型想多深。auto 交给接口自己决定；越高越慢越贵。',
      kind: 'enum',
      /*
       * ★ 这一项**已经不在这个分组里渲染了**（2026-11-07）。
       *
       * 它被挪进了「思考」区块的「高级设置」折叠区 ——
       * 见 `client/src/chat/reasoning-section.ts`。
       * 设置页的字段循环遇到它直接 `continue`，所以它的 `group`
       * **不会产生任何标题**（`lastGroup` 也不更新）。
       *
       * 保留字段本身的原因：值仍要通过 `saveFields` 存进 ST 的
       * `oai_settings.reasoning_effort`，删掉字段就等于删掉这个存储位置。
       *
       * ## 为什么 group 跟着下面那一项（而不是单独立一组）
       *
       * 单独立一组会产生一个**永不渲染的孤儿组名** —— 而判据
       * 「分组必须连续」读的是 schema 里的组清单，于是它看到 6 个组、
       * 而页面只有 5 个标题，两边永远对不上。
       *
       * 跟着 `verbosity` 同组，组数保持 5，且跳到它时 `lastGroup`
       * 不变 ⇒ 「回复详略」标题只在 `verbosity` 那一行输出一次。
       */
      group: '回复详略',
      options: [
        { value: 'auto', label: '自动' },
        { value: 'min', label: '最低' },
        { value: 'low', label: '低' },
        { value: 'medium', label: '中' },
        { value: 'high', label: '高' },
        { value: 'max', label: '最高' },
      ],
      fallback: 'auto',
    },

    {
      path: ['oai_settings', 'verbosity'],
      label: '长度',
      hint: '让模型自己控制啰嗦程度（不是硬截断）。auto 表示不干预。',
      kind: 'enum',
      /*
       * ★ 分组名从「思维链」改成「回复详略」（2026-11-07）。
       *
       * 原来这一组有「推理强度」和「长度」两项，合称「思维链」是通的。
       * 但「推理强度」已挪进「思考」区块的「高级设置」，这一组只剩
       * `verbosity` 一项 —— 而 `verbosity` 控制的是**回复写多啰嗦**，
       * 跟「思维链」没有关系。继续叫「思维链」会让用户以为它影响思考。
       *
       * ## 为什么不叫「回复长度」
       *
       * 那个名字**已被占用**：`oai_settings.openai_max_tokens`
       * （label「最大回复长度（Token）」）就在「回复长度」组里。
       *
       * 而且两者语义确实不同，不该混：
       *
       * ```text
       *   openai_max_tokens   硬上限，超了直接截断
       *   verbosity           软性档位，让模型自己决定写多细
       * ```
       *
       * 判据「分组必须连续」当场抓到这次重名（它报的是"「回复长度」被
       * 10 个别的组的字段隔开"）—— 那正是重名的表现：同名两组分处文件
       * 两端，渲染出来会出现两个一模一样的标题。
       *
       * 「详略」对应选项「简短 / 适中 / 详细」，是准确的。
       */
      group: '回复详略',
      options: [
        { value: 'auto', label: '自动' },
        { value: 'low', label: '简短' },
        { value: 'medium', label: '适中' },
        { value: 'high', label: '详细' },
      ],
      fallback: 'auto',
    },

    /* ── 上下文预算 ── */
    {
      path: ['oai_settings', 'openai_max_context'],
      label: '上下文长度（Token）',
      /*
       * ★★★ 这一项**确实生效**（2026-11-04 核实）。
       *
       * 原文案写的是「仅存 ST。App 目前不带这个上限，会按需要发历史」——
       * **那是错的**。`shell.ts` 读 `openai_max_context` 得到 `contextLimit`，
       * 交给 `computeBudget(contextLimit, responseLimit)` 做上下文裁剪，
       * 再由 `assembleWithPrompts` 按预算丢弃最旧的消息。
       *
       * 所以它的生效路径不是"塞进请求体"，而是"决定我们发多少历史"。
       * 这也是为什么 `sent: false` 这个标记本身有误导性 ——
       * 它只说明"不进请求体"，不等于"不生效"。
       */
      hint: '最多带多少历史进上下文。超出的部分会从最旧的开始丢，最近几轮永远保留。',
      indirect: '决定上下文预算（computeBudget 读它后用 token-budget 裁剪最旧的历史）',
      kind: 'number',
      group: '上下文预算',
      min: 512,
      max: 2_000_000,
      step: 1,
      fallback: 4096,
    },

  ],
};

/**
 * ② AI 回复格式化 —— 影响"回复显示成什么样"。
 *
 * 这五个键真实位置是 `power_user.*`（**子对象**，不在顶层）。
 * 层级写错的典型症状：保存后 ST 界面上的开关不变。
 */
/**
 * 「聊天行为」分区的字段（2026-11-03 加）。
 *
 * ## 路径是**实测出来的**，不是从文档抄的
 *
 * 作者注释与 CFG 在 ST 里**不在** `oai_settings` / `power_user` 下，
 * 而在 `extension_settings` 里（它们本质是内置扩展）。真机上抓到的结构：
 *
 * ```text
 *   extension_settings.note = { chara: [], default: "", wiAddition: [] }
 *   extension_settings.cfg  = { chara: [], global: { guidance_scale: 1, negative_prompt: "" } }
 * ```
 *
 * ★ 我一开始按社区文档猜 `power_user.note_prompt` / `oai_settings.cfg_scale`，
 * 递归搜整个设置对象**一个都不存在** —— 猜路径这件事必须用真实数据核对。
 *
 * ## 为什么只暴露"全局"这一份
 *
 * `note.chara` / `cfg.chara` 是**按角色**覆盖的数组。App 里做角色级覆盖
 * 需要一个"角色 → 条目"编辑界面，而当前目录结构是"一条聊天一个角色"，
 * 全局默认值已经能覆盖绝大多数用法。写全局、不动 chara，是安全的子集。
 */
export const BEHAVIOR_SECTION: SettingSection = {
  id: 'behavior',
  title: '聊天行为',
  /*
   * ★ 文案里不提 CFG（2026-11-03）。
   *
   * 原文是「作者注释会按固定间隔插进上下文；CFG 缩放决定回复有多贴提示词。」
   * 而 CFG 两项已标为暂不支持、且控件禁用 —— 开头还写着它的作用，
   * 用户会先被承诺、再发现用不了。
   *
   * 这是同一天里第二次犯（上一次是"聊天操作"菜单副标题还写着"续写"）。
   * 教训：**把一个功能标为不可用时，要连同所有提到它的文案一起改。**
   */
  intro: '作者注释会按固定间隔插进上下文，用来反复提醒写作风格或剧情约束。',
  fields: [
    {
      path: ['extension_settings', 'note', 'default'],
      label: '作者注释',
      hint: '一段会被反复插入上下文的提示（通常用来提醒写作风格或剧情约束）。留空 = 不用。',
      kind: 'textarea',
      fallback: '',
    },
    {
      path: ['extension_settings', 'cfg', 'global', 'guidance_scale'],
      label: 'CFG 缩放',
      hint: '越大越死死贴住提示词、越小越自由。1 是默认值，超过 2 通常会让文风变硬。',
      /*
       * 2026-11-03 标为暂不支持（用户要求）。
       *
       * 真机 10 次实测 + 代码检查都确认：这一项**不进生成请求**。
       * CFG 需要对同一个提示发两次请求再做加权混合，等于每次回复
       * 花两倍额度 —— 在按次计费的账上不划算，所以暂不做。
       */
      unsupported: '暂不支持',
      kind: 'number',
      min: 0,
      max: 3,
      step: 0.05,
      fallback: 1,
    },
    {
      path: ['extension_settings', 'cfg', 'global', 'negative_prompt'],
      label: 'CFG 反向提示',
      hint: '不希望出现的内容（只在上面的缩放大于 1 时生效）。',
      /* 同上：它只在 CFG 缩放生效时才有意义，而缩放本身暂不支持 */
      unsupported: '暂不支持',
      kind: 'textarea',
      fallback: '',
    },
  ],
};

export const FORMATTING_SECTION: SettingSection = {
  id: 'formatting',
  title: 'AI 回复格式化',
  intro: '控制回复里的空白、动作描写和续写方式。改完对下一条回复生效。',
  fields: [
    {
      path: ['power_user', 'trim_spaces'],
      label: '去掉多余空格',
      hint: '把行首行尾的空格清掉，避免气泡里出现奇怪的缩进。',
      kind: 'boolean',
      fallback: true,
    },
    {
      path: ['power_user', 'collapse_newlines'],
      label: '合并连续空行',
      hint: '把多个连续空行压成一个，回复看起来更紧凑。',
      kind: 'boolean',
      fallback: false,
    },
    {
      path: ['power_user', 'trim_sentences'],
      label: '去掉不完整句子',
      hint: '回复被截断时，去掉最后那句没写完的。',
      kind: 'boolean',
      fallback: false,
    },
    {
      path: ['power_user', 'quick_continue'],
      label: '快速续写',
      hint: '点续写时不再弹出设置，直接接着写。',
      kind: 'boolean',
      fallback: false,
    },
    {
      path: ['power_user', 'continue_on_send'],
      label: '发送时自动续写',
      hint: '你发的内容结尾像没写完时，让模型接着补。',
      kind: 'boolean',
      fallback: false,
    },
  ],
};

/** 聊天页设置里的四项（顺序即显示顺序，与 ST 原生一致） */
/*
 * ★ 顺序：**ST 原生四项必须在最前，且保持 ST 里的相对顺序**。
 *
 * 用户的原话是「与 ST 原生一致」——判据不是"有几项"，而是
 * **熟悉 SillyTavern 的人打开就按记忆里的位置找得到东西**。
 * 所以 App 新增的「聊天行为」（作者注释 / CFG 缩放）排到最后：
 * 它是我们加的，插在中间会把原生四项全部顶下去一位。
 *
 * 判据在 `test/chat-settings-schema.test.mjs`「四项的顺序」一项里，
 * 写法是**子序列匹配**（原生四项按原序出现即可，允许中间插新分组），
 * 不是"恰好等于四个"——后者会在每次加功能时误红。
 */
/**
 * 聊天设置菜单（2026-11-04：「用户设置」改名「用户 UI 设置」并保留）。
 *
 * ## 原来那一项的两个问题
 *
 * 它和「卡片 → 用户设定管理」**指的是同一件事**，而那边已经是真功能，
 * 这边还是个"正在做"的空状态 —— 两个入口一个真一个假，用户点到假的那个
 * 会以为功能坏了。
 *
 * ## 为什么改名而不是删掉
 *
 * 对齐 ST 的原生布局（`public/index.html` 里一级抽屉只有四个）：
 *
 * ```text
 *   sys-settings-button        系统设置 = AI 响应配置 / API / 上下文
 *   user-settings-button       用户设置 = **界面外观**（配色、示例行为、power user）
 *   extensions-settings-button 扩展
 *   persona-management-button  persona 管理 ← **独立一级入口，不在任何设置里**
 * ```
 *
 * 也就是说 ST 的「用户设置」根本不是 persona，是"界面长什么样"的设置。
 * 我们把它当成 persona 入口，**一开始就对应错了语义**。
 *
 * ## 现在的处理
 *
 * · persona 只留在「卡片」Tab（对应 ST 那个独立入口），那边是真功能。
 * · 这一项改名「用户 UI 设置」回到它本来的语义。内容还没做，
 *   点进去只说「暂不支持」—— 不解释原因，那是开发阶段的文字。
 */
export const CHAT_SETTINGS_GROUPS = [
  { id: 'sampling', label: 'AI 响应配置', hint: '温度、采样、回复长度' },
  { id: 'formatting', label: 'AI 回复格式化', hint: '空格、空行、续写' },
  { id: 'worldbook', label: '世界书管理', hint: '查看、编辑、导入世界书' },
  /*
   * 界面外观（2026-11-04 改名并保留为占位）。
   *
   * ## 为什么它不是 persona
   *
   * ST 的 `user-settings-button` 装的是**界面外观** —— 配色、示例消息行为、
   * power user 那些。persona 在 ST 里是**另一个独立的一级入口**
   * （`persona-management-button`），不在任何设置菜单里。
   *
   * 原来这一项叫「用户设置」、副标题写"你在故事里的名字与设定"，
   * 与「卡片 → 用户设定管理」指同一件事 ⇒ 两个入口一个真一个假。
   * 现在改成它**本来该是的东西**：界面外观。
   *
   * ## 为什么留着而不是删掉
   *
   * 用户明确要求"作为后续功能加进去"。留着一个明确标「暂不支持」的入口，
   * 比删掉再在以后的版本里凭空冒出来更好 —— 用户能预期它会来。
   */
  { id: 'ui', label: '用户 UI 设置', hint: '配色、字号、示例消息行为' },
  { id: 'behavior', label: '聊天行为', hint: '作者注释、CFG 缩放' },
] as const;

export type ChatSettingsGroupId = (typeof CHAT_SETTINGS_GROUPS)[number]['id'];

/* ═══════════════════════════════════════════════════════════
   读写工具（纯函数，不碰网络）
   ═══════════════════════════════════════════════════════════ */

/**
 * 按路径读一个值，缺失时给 `fallback`。
 *
 * 不做类型强转：ST 里 `top_p_openai` 可能是 `1`（number）也可能是 `"1"`（string，
 * 从表单读回来的），强转会把 `"abc"` 变成 `NaN` 然后写回去污染设置。
 * 读不到就 fallback，读到什么就显示什么。
 */
export function readField(settings: Record<string, unknown>, field: SettingField): unknown {
  let cursor: unknown = settings;
  for (const key of field.path) {
    if (cursor === null || typeof cursor !== 'object') return field.fallback;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor === undefined ? field.fallback : cursor;
}

/**
 * 写一个值到 settings 的副本里（**不改原对象**）。
 *
 * 中间层缺失时自动建空对象 —— 因为 ST 的默认 settings.json 里
 * `oai_settings` 整个可能不存在（全新配置），不建就写不进去。
 */
export function writeField(
  settings: Record<string, unknown>,
  field: SettingField,
  value: unknown,
): Record<string, unknown> {
  const next = { ...settings } as Record<string, unknown>;

  let cursor = next;
  for (let i = 0; i < field.path.length - 1; i += 1) {
    const key = field.path[i] as string;
    const existing = cursor[key];
    const child =
      existing !== null && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cursor[key] = child;
    cursor = child;
  }

  cursor[field.path[field.path.length - 1] as string] = value;
  return next;
}

/**
 * 把一批字段的当前值读成一个 `{ 'a.b': value }` 的扁平表（给 UI 用）。
 *
 * 键用 `path.join('.')` —— 只用于**界面内部的 map 键**，不用来读写 settings，
 * 所以键名里带点号也不会出问题。
 */
export function readSectionValues(
  settings: Record<string, unknown>,
  section: SettingSection,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of section.fields) {
    out[field.path.join('.')] = readField(settings, field);
  }
  return out;
}

/**
 * 校验一个数值字段的输入，返回 `{ok}` 或 `{ok:false, reason}`。
 *
 * **为什么不在保存时静默夹紧到范围内**：用户填 5 但上限是 2，
 * 静默存成 2 会让他以为"填了没用"；明确告诉他"上限是 2"才对。
 */
export function validateNumber(
  field: SettingField,
  raw: string,
): { ok: true; value: number } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: `${field.label}不能为空` };

  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, reason: `${field.label}要填数字` };

  const min = field.min ?? Number.NEGATIVE_INFINITY;
  const max = field.max ?? Number.POSITIVE_INFINITY;
  if (value < min || value > max) {
    return { ok: false, reason: `${field.label}要在 ${String(min)} 到 ${String(max)} 之间` };
  }
  return { ok: true, value };
}
