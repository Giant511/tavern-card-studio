/**
 * 取回组装后的 PNG 卡要落盘时，**目标路径已有同名文件**怎么办（v0.1.7 增补三）。
 *
 * ## 一句话原则
 *
 * **cardId 身份优先于文件名。** 这条在本项目已经用到第六次了
 * （推送修订一、仓库审计、取回、…），每次的诱惑都是"同名就当同一张" ——
 * 而那个假设在"两张卡都叫西奥"时立刻出事：一张覆盖掉另一张。
 *
 * ## 为什么"本地文件有没有 cardId"是分水岭
 *
 * 我们自己导出的 PNG 卡里一定嵌着 `chara`/`ccv3`，里面有 `extensions.tcs.cardId`。
 * 但目标文件可能是：
 *   · 更早版本导出的（那时还没有 cardId）；
 *   · 用户从别处下回来、手工重命名的；
 *   · 根本不是我们导出的 PNG（只是重名）。
 *
 * 这三种情况我们都**没有资格**判断它是不是同一张卡 —— 所以不覆盖、**问人**。
 * 这里最容易犯的错是"没有 cardId 就当作不同卡，另存一份"：那会在用户
 * 反复取回同一张老卡时堆出一串 `(2) (3) (4)`，而每一个都可能是他唯一的那张。
 *
 * ## 与"标签占用"的关系
 *
 * 同名文件正被某个标签打开时，**不走本文件的覆盖逻辑**：编辑器里那份内容
 * 还没落盘，绕过去写磁盘会让内存状态与磁盘不一致。需求要求复用既有的
 * "导入替换当前卡"确认流程，所以这里只返回一个信号，由调用方转交。
 */

/** 落盘决策 */
export type FaceDropDecision =
  /** 目标不存在：直接写 */
  | { kind: 'write' }
  /** 目标被打开的标签占用：交给既有"导入替换当前卡"流程，不在这里弹窗 */
  | { kind: 'defer-to-open-tab'; reason: string }
  /** 目标没有 cardId：问用户，不自动覆盖 */
  | { kind: 'ask-unknown'; reason: string }
  /** 同一张卡且本地有未保存修改 / 内容较新：三选 */
  | { kind: 'ask-dirty'; reason: string }
  /** 同一张卡且本地干净：直接覆盖 */
  | { kind: 'overwrite'; reason: string }
  /** 另一张卡占了同名：加序号另存 */
  | { kind: 'save-as'; reason: string };

export interface FaceDropInput {
  /** 目标路径上是否已有文件 */
  targetExists: boolean;
  /** 目标文件里读到的 cardId；null = 文件没有 cardId（老卡 / 外部导入 / 不是我们的卡） */
  localCardId: string | null;
  /** 这次要落盘的卡 id */
  incomingCardId: string;
  /** 目标文件正被某个标签打开 */
  openInTab: boolean;
  /** 目标文件对应的编辑器有未保存修改 */
  localDirty: boolean;
  /** 目标文件比要落盘的内容更新（mtime 更晚） */
  localNewer: boolean;
}

/**
 * 判定顺序不是需求列表的顺序，而是**风险的顺序**：
 * 先处理"写了会出事"的（标签占用），再处理"写了可能丢数据"的（无身份 / 脏），
 * 最后才是能安全推进的（覆盖 / 另存）。
 */
export function decideFaceDrop(input: FaceDropInput): FaceDropDecision {
  if (!input.targetExists) return { kind: 'write' };

  /*
   * 标签占用最先判：它跟"是不是同一张卡"无关 —— 哪怕确定是同一张卡，
   * 磁盘先写、内存后改也会让用户看到"文件变了但编辑器还是旧内容"。
   * 交给既有的导入替换流程，那里本来就有"要不要替换当前卡"的确认。
   */
  if (input.openInTab) {
    return {
      kind: 'defer-to-open-tab',
      reason: '同名文件已在编辑器里打开，将按「导入替换当前卡」确认。',
    };
  }

  /*
   * 拿不到本地身份 ⇒ 不猜。
   *
   * 注意这里**不**退化成"当不同卡、另存一份"：用户反复取回同一张老卡时
   * 会堆出一串 `(2)(3)(4)`，而他根本分不清哪个是自己的。
   */
  if (input.localCardId === null || input.localCardId === '') {
    return {
      kind: 'ask-unknown',
      reason: '本地已有同名文件，但它没有卡片标识（可能是较早版本导出的或外部导入的），需要你决定怎么处理。',
    };
  }

  /*
   * **我方也没有身份**（这张卡还没上传过、没有 cardId）⇒ 同样不能判同卡。
   *
   * 少了这一条会出一个很隐蔽的 bug：空串与空串"相等"，于是被当成同一张卡、
   * 直接覆盖 —— 而两个都没有 cardId 的文件恰恰是最不该判等的一对
   * （两张从 TXT 起手、同名、都还没上传过的卡）。
   */
  if (input.incomingCardId === '') {
    return {
      kind: 'ask-unknown',
      reason: '这张卡还没有卡片标识，无法确认本地同名文件是不是它，需要你决定怎么处理。',
    };
  }

  // 身份明确：同卡 / 异卡
  if (input.localCardId === input.incomingCardId) {
    /*
     * 同卡 + 干净 ⇒ 直接覆盖。
     *
     * 需求原话是"工作副本保持唯一，不产生编号垃圾"。这是**常态路径**：
     * 用户改完设定取回一份，就应该覆盖掉他自己那份，而不是多出 `西奥 (2)`。
     */
    if (!input.localDirty && !input.localNewer) {
      return { kind: 'overwrite', reason: '同一张卡，本地没有未保存的修改，直接覆盖。' };
    }
    /*
     * 同卡但不干净：**不能**静默覆盖。
     *
     * `localNewer` 也算进来：文件比远端新，说明用户可能手工改过（或用别的工具
     * 编辑过），覆盖掉同样是丢数据。
     */
    return {
      kind: 'ask-dirty',
      reason: input.localDirty
        ? '本地这份有未保存的修改，覆盖会丢掉它们。'
        : '本地这份比要取回的更新，覆盖会丢掉较新的内容。',
    };
  }

  // 异卡撞名：加序号另存，不动对方
  return {
    kind: 'save-as',
    reason: '本地已有同名文件，但它是另一张卡，将另存一份（编号）。',
  };
}

/**
 * 三选弹窗的选项（顺序即按钮顺序）。
 *
 * 把"查看差异"放最后而不是中间：它是**查看**动作，点错也只是多看一眼；
 * 前两个是**写**动作，越靠前越容易被顺手点。
 */
export const DIRTY_CHOICES = [
  { id: 'overwrite', label: '覆盖本地', danger: true },
  { id: 'save-as', label: '另存为' },
  { id: 'diff', label: '查看差异' },
] as const;

export type DirtyChoiceId = (typeof DIRTY_CHOICES)[number]['id'];

/**
 * 弹窗里"另存为 西奥 (2).png"那句要怎么显示。
 *
 * 单独成一个函数是为了让 UI 不必自己拼文件名后缀 —— 拼错了（比如把 `.png`
 * 写在括号里）用户就拿不到一个能被识别的文件名。
 */
export function saveAsLabel(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return `另存为 ${fileName} (2)`;
  return `另存为 ${fileName.slice(0, dot)} (2)${fileName.slice(dot)}`;
}
