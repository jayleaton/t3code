import * as SchemaAST from "effect/SchemaAST";

/**
 * Drops object properties that hold `null`, `undefined`, or an empty array, at
 * any depth. Agents re-read every tool result on each later turn, so an absent
 * field must cost nothing; readers treat a missing field like an empty one.
 * `false`, `0`, `""`, and `{}` stay because they can mean something, and array
 * elements stay so positions keep their meaning.
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

/**
 * The inverse of {@link compactJson} for a reader that decodes with a schema
 * requiring those keys: each required key the schema lets be `null` or an
 * array comes back as `null` or `[]`.
 */
export function expandCompactJson(
  schema: { readonly ast: SchemaAST.AST },
  value: unknown,
): unknown {
  return expand(SchemaAST.toEncoded(schema.ast), value);
}

function expand(ast: SchemaAST.AST, value: unknown): unknown {
  switch (ast._tag) {
    case "Suspend":
      return expand(ast.thunk(), value);
    case "Arrays":
      return Array.isArray(value)
        ? value.map((element, index) => {
            const elementAst = ast.elements[index] ?? ast.rest[0];
            return elementAst === undefined ? element : expand(elementAst, element);
          })
        : value;
    case "Union": {
      const member = ast.types.find((candidate) => fits(resolve(candidate), value));
      return member === undefined ? value : expand(member, value);
    }
    case "Objects": {
      if (!isRecord(value)) return value;
      const expanded: Record<string, unknown> = { ...value };
      for (const { name, type } of ast.propertySignatures) {
        if (typeof name !== "string") continue;
        if (name in expanded) expanded[name] = expand(type, expanded[name]);
        else if (!SchemaAST.isOptional(type)) {
          const empty = emptyValue(type);
          if (empty !== undefined) expanded[name] = empty;
        }
      }
      return expanded;
    }
    default:
      return value;
  }
}

/**
 * Whether a union member can describe `value`: anything but an object fits a
 * non-object member, and an object fits when every key it cannot have dropped
 * is present with a matching literal, which picks the member of a tagged union.
 */
function fits(ast: SchemaAST.AST, value: unknown): boolean {
  if (ast._tag === "Null") return value === null;
  if (ast._tag === "Arrays") return Array.isArray(value);
  if (ast._tag === "Union") return ast.types.some((member) => fits(resolve(member), value));
  if (ast._tag !== "Objects") return !isRecord(value) && value !== null && !Array.isArray(value);
  if (!isRecord(value)) return false;
  return ast.propertySignatures.every(({ name, type }) => {
    if (typeof name !== "string") return true;
    if (!(name in value)) return SchemaAST.isOptional(type) || emptyValue(type) !== undefined;
    const resolved = resolve(type);
    return resolved._tag !== "Literal" || resolved.literal === value[name];
  });
}

function emptyValue(ast: SchemaAST.AST): null | [] | undefined {
  const resolved = resolve(ast);
  const members = resolved._tag === "Union" ? resolved.types.map(resolve) : [resolved];
  if (members.some((member) => member._tag === "Null")) return null;
  if (members.some((member) => member._tag === "Arrays")) return [];
  return undefined;
}

function resolve(ast: SchemaAST.AST): SchemaAST.AST {
  return ast._tag === "Suspend" ? resolve(ast.thunk()) : ast;
}

// Class instances (dates, buffers, schema classes) serialize through their own toJSON.
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
