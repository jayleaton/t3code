/**
 * Drops object properties that hold `null`, `undefined`, or an empty array, at
 * any depth. For text a model reads, where an absent field costs nothing and
 * reads like an empty one; typed readers keep the full value. `false`, `0`,
 * `""`, and `{}` stay because they can mean something, and array elements stay
 * so positions keep their meaning.
 */
export function compactJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compactJson) as T;
  if (typeof value !== "object" || value === null || !isPlainObject(value)) return value;
  const compacted: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === null || field === undefined) continue;
    if (Array.isArray(field) && field.length === 0) continue;
    compacted[key] = compactJson(field);
  }
  return compacted as T;
}

// Class instances (dates, buffers, schema classes) serialize through their own toJSON.
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
