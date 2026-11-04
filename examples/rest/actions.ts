import { defineAction, NotAppliedError, t, type AnyAction } from "../../src/index.ts";

/**
 * Actions over a REST API that supports ETags and Idempotency-Key.
 *
 * The pattern closes the last gap between "approved" and "written":
 *   observe   GET the item, keep its ETag. The ETag is part of the observed state, so any
 *             change before apply is caught by the gate's drift check.
 *   execute   PATCH with If-Match: <the approved ETag>. A change that slips in AFTER the gate's
 *             recheck is refused by the server itself (412). Nothing happened, so we throw
 *             NotAppliedError and the gate rolls back cleanly instead of reporting "unknown".
 *             Idempotency-Key: <the step key> makes a retried request a no-op.
 *   verify    GET again and compare.
 *   compensate PATCH back, again guarded by If-Match, so a rollback never overwrites
 *             someone else's newer edit.
 */

interface Snapshot {
  price: number;
  etag: string;
}

async function getItem(base: string, sku: string): Promise<Snapshot> {
  const res = await fetch(`${base}/items/${encodeURIComponent(sku)}`);
  if (!res.ok) throw new Error(`GET ${sku}: HTTP ${res.status}`);
  const body = (await res.json()) as { price: number };
  return { price: body.price, etag: res.headers.get("etag") ?? "" };
}

async function patchItem(base: string, sku: string, price: number, ifMatch: string, key: string): Promise<Snapshot> {
  let res: Response;
  try {
    res = await fetch(`${base}/items/${encodeURIComponent(sku)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "if-match": ifMatch, "idempotency-key": key },
      body: JSON.stringify({ price }),
    });
  } catch (e) {
    // Network failure: the request may or may not have reached the server. Unknown outcome.
    throw new Error(`PATCH ${sku}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // The server refused before applying anything: safe to say "not applied".
  if (res.status === 412) throw new NotAppliedError(`${sku} changed after approval (412 Precondition Failed)`);
  if (res.status === 409 || res.status === 422 || res.status === 428) {
    throw new NotAppliedError(`${sku} rejected by the API (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`PATCH ${sku}: HTTP ${res.status}`); // 5xx and friends: unknown
  const body = (await res.json()) as { price: number };
  return { price: body.price, etag: res.headers.get("etag") ?? "" };
}

export function restActions(base: string): AnyAction[] {
  const setPrice = defineAction({
    name: "set_price",
    description: "Change the selling price of an item through the inventory API. Reversible: the previous price is restored on rollback.",
    reversibility: "reversible",
    tags: ["pricing"],
    input: t.object({
      sku: t.string({ min: 1, max: 40 }),
      price: t.number({ min: 0, max: 1_000_000, description: "New price in dollars" }),
    }),
    observe: ({ sku }) => getItem(base, sku),
    check: ({ price }, s) => (s.price === price ? [`price is already ${price}`] : []),
    preview: ({ sku, price }, s) => [
      { target: `item:${sku}`, op: "update", before: { price: s.price }, after: { price }, summary: `price of ${sku}: ${s.price} -> ${price}` },
    ],
    execute: ({ sku, price }, { before, idempotencyKey }) => patchItem(base, sku, price, before.etag, idempotencyKey),
    verify: async ({ sku, price }) => {
      const now = await getItem(base, sku);
      return { ok: now.price === price, reason: `API shows ${now.price}`, evidence: now };
    },
    compensate: async ({ sku }, result, { before, idempotencyKey }) => {
      // Guarded by the ETag our own write produced: never clobber a newer human edit.
      const current = result?.etag ? result : await getItem(base, sku);
      await patchItem(base, sku, before.price, current.etag, `${idempotencyKey}:undo`);
    },
  });

  return [setPrice];
}
