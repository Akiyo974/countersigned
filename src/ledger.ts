import { canonicalJson, sha256 } from "./hash.ts";
import type { LedgerEntry, LedgerInput } from "./types.ts";

export const GENESIS = "0".repeat(64);

/** Each entry commits to the previous one, so editing or deleting history breaks the chain. */
export function sealEntry(input: LedgerInput, seq: number, prevHash: string): LedgerEntry {
  const body = {
    seq,
    at: input.at ?? new Date().toISOString(),
    type: input.type,
    planId: input.planId,
    step: input.step,
    key: input.key,
    data: input.data,
    prevHash,
  };
  return { ...body, hash: sha256(canonicalJson(body)) };
}

export interface ChainCheck {
  ok: boolean;
  entries: number;
  /** First broken position, if any. */
  brokenAt?: number;
  reason?: string;
}

export function verifyChain(entries: LedgerEntry[]): ChainCheck {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq !== i + 1) return { ok: false, entries: entries.length, brokenAt: i + 1, reason: `expected seq ${i + 1}, found ${e.seq}` };
    if (e.prevHash !== prev) return { ok: false, entries: entries.length, brokenAt: e.seq, reason: "prevHash does not match previous entry" };
    const { hash, ...body } = e;
    if (sha256(canonicalJson(body)) !== hash) return { ok: false, entries: entries.length, brokenAt: e.seq, reason: "entry content was modified" };
    prev = hash;
  }
  return { ok: true, entries: entries.length };
}
