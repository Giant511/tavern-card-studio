/**
 * 通用 JSON 值类型与安全读写工具（零依赖，供 shared 内部使用）。
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 深拷贝（仅支持 JSON 值），用于避免模型与原始 JSON 共享引用。 */
export function cloneJson<T extends JsonValue>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) out[key] = cloneJson(item);
  return out as T;
}

/** 按路径读取，缺失时返回 undefined。路径形如 "data.extensions.foo"。 */
export function getPath(root: JsonValue, path: string): JsonValue | undefined {
  let cursor: JsonValue | undefined = root;
  for (const segment of path.split('.')) {
    if (cursor === undefined || cursor === null) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as JsonObject)[segment];
  }
  return cursor;
}
