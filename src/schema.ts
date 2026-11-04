/**
 * A tiny, dependency-free schema builder.
 *
 * Every schema does two jobs:
 *  - `parse()` validates untrusted input coming from a model (strict: unknown keys are rejected,
 *    because a hallucinated parameter is a bug you want to see, not silently drop);
 *  - `json` is the JSON Schema handed to MCP clients so the model knows what to send.
 */

export type JsonSchema = Record<string, unknown>;

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ValidationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export interface Schema<T> {
  readonly json: JsonSchema;
  readonly optional: boolean;
  /** Returns the parsed value or pushes issues. Never throws. */
  check(value: unknown, path: string, issues: ValidationIssue[]): T;
  /** Parses or throws a ValidationError listing every problem at once. */
  parse(value: unknown): T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

function make<T>(json: JsonSchema, check: Schema<T>["check"], optional = false): Schema<T> {
  return {
    json,
    optional,
    check,
    parse(value: unknown): T {
      const issues: ValidationIssue[] = [];
      const out = check(value, "", issues);
      if (issues.length) throw new ValidationError(issues);
      return out;
    },
  };
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

const join = (path: string, key: string | number): string =>
  typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key;

interface StringOpts {
  min?: number;
  max?: number;
  pattern?: RegExp;
  description?: string;
}

function string(opts: StringOpts = {}): Schema<string> {
  const json: JsonSchema = { type: "string" };
  if (opts.min !== undefined) json.minLength = opts.min;
  if (opts.max !== undefined) json.maxLength = opts.max;
  if (opts.pattern) json.pattern = opts.pattern.source;
  if (opts.description) json.description = opts.description;
  return make(json, (v, path, issues) => {
    if (typeof v !== "string") {
      issues.push({ path, message: `expected string, got ${typeOf(v)}` });
      return v as string;
    }
    if (opts.min !== undefined && v.length < opts.min) issues.push({ path, message: `must be at least ${opts.min} characters` });
    if (opts.max !== undefined && v.length > opts.max) issues.push({ path, message: `must be at most ${opts.max} characters` });
    if (opts.pattern && !opts.pattern.test(v)) issues.push({ path, message: `must match ${opts.pattern}` });
    return v;
  });
}

interface NumberOpts {
  min?: number;
  max?: number;
  integer?: boolean;
  description?: string;
}

function number(opts: NumberOpts = {}): Schema<number> {
  const json: JsonSchema = { type: opts.integer ? "integer" : "number" };
  if (opts.min !== undefined) json.minimum = opts.min;
  if (opts.max !== undefined) json.maximum = opts.max;
  if (opts.description) json.description = opts.description;
  return make(json, (v, path, issues) => {
    if (typeof v !== "number" || Number.isNaN(v)) {
      issues.push({ path, message: `expected number, got ${typeOf(v)}` });
      return v as number;
    }
    if (opts.integer && !Number.isInteger(v)) issues.push({ path, message: "must be an integer" });
    if (opts.min !== undefined && v < opts.min) issues.push({ path, message: `must be >= ${opts.min}` });
    if (opts.max !== undefined && v > opts.max) issues.push({ path, message: `must be <= ${opts.max}` });
    return v;
  });
}

function integer(opts: Omit<NumberOpts, "integer"> = {}): Schema<number> {
  return number({ ...opts, integer: true });
}

function boolean(opts: { description?: string } = {}): Schema<boolean> {
  const json: JsonSchema = { type: "boolean" };
  if (opts.description) json.description = opts.description;
  return make(json, (v, path, issues) => {
    if (typeof v !== "boolean") issues.push({ path, message: `expected boolean, got ${typeOf(v)}` });
    return v as boolean;
  });
}

function enumOf<const V extends readonly (string | number)[]>(values: V, opts: { description?: string } = {}): Schema<V[number]> {
  const json: JsonSchema = { enum: [...values] };
  if (opts.description) json.description = opts.description;
  return make(json, (v, path, issues) => {
    if (!values.includes(v as V[number])) issues.push({ path, message: `must be one of ${values.map((x) => JSON.stringify(x)).join(", ")}` });
    return v as V[number];
  });
}

function array<T>(item: Schema<T>, opts: { min?: number; max?: number; description?: string } = {}): Schema<T[]> {
  const json: JsonSchema = { type: "array", items: item.json };
  if (opts.min !== undefined) json.minItems = opts.min;
  if (opts.max !== undefined) json.maxItems = opts.max;
  if (opts.description) json.description = opts.description;
  return make(json, (v, path, issues) => {
    if (!Array.isArray(v)) {
      issues.push({ path, message: `expected array, got ${typeOf(v)}` });
      return v as T[];
    }
    if (opts.min !== undefined && v.length < opts.min) issues.push({ path, message: `must contain at least ${opts.min} items` });
    if (opts.max !== undefined && v.length > opts.max) issues.push({ path, message: `must contain at most ${opts.max} items` });
    return v.map((x, i) => item.check(x, join(path, i), issues));
  });
}

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K]["optional"] extends true ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type ObjectOutput<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

function object<S extends Shape>(shape: S, opts: { description?: string } = {}): Schema<ObjectOutput<S>> {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, s] of Object.entries(shape)) {
    properties[key] = s.json;
    if (!s.optional) required.push(key);
  }
  const json: JsonSchema = { type: "object", properties, required, additionalProperties: false };
  if (opts.description) json.description = opts.description;
  return make(json, (v, path, issues) => {
    if (typeOf(v) !== "object") {
      issues.push({ path, message: `expected object, got ${typeOf(v)}` });
      return v as ObjectOutput<S>;
    }
    const input = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      if (!(key in shape)) issues.push({ path: join(path, key), message: "unknown property" });
    }
    for (const [key, s] of Object.entries(shape)) {
      if (input[key] === undefined) {
        if (!s.optional) issues.push({ path: join(path, key), message: "is required" });
        continue;
      }
      out[key] = s.check(input[key], join(path, key), issues);
    }
    return out as ObjectOutput<S>;
  });
}

function optional<T>(s: Schema<T>): Schema<T | undefined> & { readonly optional: true } {
  return { ...s, optional: true } as Schema<T | undefined> & { readonly optional: true };
}

/** Accepts any JSON value. Use sparingly: an agent with an `unknown` parameter can send anything. */
function unknown(opts: { description?: string } = {}): Schema<unknown> {
  const json: JsonSchema = {};
  if (opts.description) json.description = opts.description;
  return make(json, (v) => v);
}

/** Wraps an external validator (zod, valibot, ajv...) so you can keep the schema library you already use. */
function custom<T>(json: JsonSchema, validate: (value: unknown) => T): Schema<T> {
  return make(json, (v, path, issues) => {
    try {
      return validate(v);
    } catch (err) {
      issues.push({ path, message: err instanceof Error ? err.message : String(err) });
      return v as T;
    }
  });
}

export const t = { string, number, integer, boolean, enum: enumOf, array, object, optional, unknown, custom };
