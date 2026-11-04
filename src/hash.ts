import { createHash, randomBytes } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted, no whitespace. Only plain JSON data is accepted.
 * Two values hash the same if and only if they are the same JSON document, which is what
 * lets us pin approvals and detect drift by hash.
 *
 * Anything that JSON would silently mangle (Map, Set, Date, class instances, NaN, Infinity,
 * bigint, functions, sparse arrays, undefined inside arrays) is rejected with a clear error
 * instead: a silent collision there would hide drift. Convert such values in observe() first.
 * Object properties set to undefined are dropped, exactly like JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, "$"));
}

function normalize(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path}: ${value} is not valid JSON; convert it explicitly`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new TypeError(`${path}: a ${typeof value} is not JSON data`);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value) || value[i] === undefined) throw new TypeError(`${path}[${i}]: holes and undefined are not JSON data`);
      out.push(normalize(value[i], `${path}[${i}]`));
    }
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const kind = (value as object).constructor?.name ?? "object";
    throw new TypeError(`${path}: a ${kind} is not plain JSON data; convert it (e.g. a Date to an ISO string, a Map to an object)`);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = normalize(v, `${path}.${key}`);
  }
  return out;
}

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Time sortable, collision resistant id: `pl_` + base36 time + random hex. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

/** Short human friendly form of a hash, for CLI output. */
export function short(hash: string): string {
  return hash.slice(0, 12);
}
