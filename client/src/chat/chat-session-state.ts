/**
 * 功能
 * 定义「当前聊天会话」这一组状态字段，供从 shell 拆出的模块共用。
 *
 * 注意事项
 * 只放状态，不放动作。动作（renderPage / persistSession 等）各模块用到的
 * 不一样，放进来会让接口越滚越大。各模块用自己的 `XxxHost extends
 * ChatSessionState` 补。
 *
 * 五个字段都可写，因为每一处都有真实写点：
 *   selectedCharacter     切角色、读卡后 adopt
 *   chatFileName          改名、另存为、删档
 *   chatSnapshot          改名时同步 fileName、删档时清空
 *   lastSavedFingerprint  改名或删档后置 null，强制下次重存
 *   chatSettingsRoute     进二级页、退回上级
 *
 * 踩过的坑
 * 拆到第三个模块时才发现这三个模块要读写的字段完全一样，此前各自抄了一遍
 * 接口声明。抄写的风险是漏一个 setter，而漏了不会报错：写入静默丢弃，
 * 表现为「改名成功但下次保存写回旧名」这种隔着几层才看得见的症状。
 */

import type { StChatMessage } from '@tcs/shared';

/** 当前角色。avatar 是 ST 里的头像文件名，同时用作角色目录名 */
export interface ChatCharacterRef {
  avatar: string;
  name: string;
}

export interface ChatSessionState {
  /** 当前角色；未选为 null */
  selectedCharacter: ChatCharacterRef | null;

  /** 当前聊天在 ST 里的文件名，不带扩展名 */
  chatFileName: string | null;

  /**
   * 聊天快照。
   *
   * 注意：`fileName` 必须与 `chatFileName` 同步。两者不一致时
   * 「这是不是当前这段」判不出来，改名会把内容写进旧文件。
   */
  chatSnapshot: {
    fileName: string | null;
    messages: StChatMessage[];
    scrollTop?: number;
  } | null;

  /** 上次保存时的内容指纹；null 表示下次必须重存 */
  lastSavedFingerprint: string | null;

  /** 「聊天设置」的二级路由；null 表示不在二级页 */
  chatSettingsRoute: string | null;
}
