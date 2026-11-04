import { createHash, randomBytes } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted, undefined dropped, no whitespace.
 * Two structurally equal values always produce the same string, which is what
 * lets us pin approvals and detect drift by hash.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    if (typeof value === "bigint") return value.toString();
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined && typeof v !== "function") out[key] = normalize(v);
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
