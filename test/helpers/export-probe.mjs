/**
 * 测试辅助：从导出产物里读角色名。
 *
 * 单独抽出来是为了让"断言的口径"只有一份实现 —— 如果每个测试各写一套解析，
 * 出现过"测试通过了但导出其实是错的"。这里刻意走完整的 JSON.parse，
 * 而不是正则抠字符串：正则会把转义、嵌套同名键都搞错。
 */

/** 从导出的 JSON 文本里读顶层 name */
export function parseCardNameExport(text) {
  const payload = JSON.parse(text);
  if (typeof payload.name === 'string') return payload.name;
  if (payload?.data && typeof payload.data.name === 'string') return payload.data.name;
  return null;
}

/** 从导出的 JSON 文本里读角色卡 ID（extensions.tcs.cardId） */
export function parseCardIdExport(text) {
  const payload = JSON.parse(text);
  const ext = payload?.data?.extensions;
  if (!ext || typeof ext !== 'object') return null;
  const tcs = ext.tcs;
  if (!tcs || typeof tcs !== 'object') return null;
  return typeof tcs.cardId === 'string' ? tcs.cardId : null;
}
