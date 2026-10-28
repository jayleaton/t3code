/** Compact model-facing objects only: typed readers need the full value, and array positions and meaningful falsy values stay intact. */
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
