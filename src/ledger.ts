import { canonicalJson, sha256 } from "./hash.ts";
import type { Store } from "./store.ts";
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

/**
 * Full integrity check of a store: the chain itself, plus every plan's recorded `ledgerHead`
 * must still be in the ledger with the same hash. A hash chain alone cannot see entries cut
 * from its end; the plans remember where it reached. For protection against someone rewriting
 * both, also anchor the latest head outside the host (see `countersigned ledger head`).
 */
export async function verifyStore(store: Store, anchor?: { seq: number; hash: string }): Promise<ChainCheck> {
  let entries: LedgerEntry[];
  try {
    entries = await store.readLedger();
  } catch (e) {
    const line = (e as { line?: number }).line;
    return { ok: false, entries: 0, brokenAt: line, reason: `ledger unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const chain = verifyChain(entries);
  if (!chain.ok) return chain;
  const bySeq = new Map(entries.map((e) => [e.seq, e.hash]));
  for (const p of await store.listPlans()) {
    const h = p.ledgerHead;
    if (h && bySeq.get(h.seq) !== h.hash) {
      return { ok: false, entries: entries.length, brokenAt: h.seq, reason: `plan ${p.id} records entry #${h.seq}, which is missing or different: the ledger was truncated or rewritten` };
    }
  }
  if (anchor && bySeq.get(anchor.seq) !== anchor.hash) {
    return { ok: false, entries: entries.length, brokenAt: anchor.seq, reason: `anchored entry #${anchor.seq} is missing or different` };
  }
  return chain;
}
