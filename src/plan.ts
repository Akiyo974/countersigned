import { GateError } from "./errors.ts";
import { hashValue } from "./hash.ts";
import type { Store } from "./store.ts";
import type { LedgerEntry, Plan } from "./types.ts";

/**
 * The plan hash covers everything that defines behaviour: what runs, with which input,
 * against which observed state, producing which effects, under which decision.
 * Status, approval and report are excluded: they describe the plan's life, not its content.
 */
export function computePlanHash(plan: Pick<Plan, "id" | "version" | "createdAt" | "expiresAt" | "intent" | "requestedBy" | "steps" | "decision" | "reasons">): string {
  return hashValue({
    id: plan.id,
    version: plan.version,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    intent: plan.intent,
    requestedBy: plan.requestedBy,
    steps: plan.steps,
    decision: plan.decision,
    reasons: plan.reasons,
  });
}

export function assertIntact(plan: Plan): void {
  const actual = computePlanHash(plan);
  if (actual !== plan.hash) {
    throw new GateError("TAMPERED", `Plan ${plan.id} was modified after it was created (hash mismatch). Create a new plan.`, {
      expected: plan.hash,
      actual,
    });
  }
  if (plan.approval && plan.approval.planHash !== plan.hash) {
    throw new GateError("TAMPERED", `Plan ${plan.id} differs from the version that was approved. Create a new plan and ask again.`);
  }
}

/** Remembers on the plan the latest ledger entry written for it (monotonic). */
export async function recordHead(store: Store, id: string, entry: LedgerEntry): Promise<void> {
  await store.updatePlan(id, (p) =>
    p.ledgerHead && p.ledgerHead.seq >= entry.seq ? p : { ...p, ledgerHead: { seq: entry.seq, hash: entry.hash } },
  );
}

export interface DecideOptions {
  by: string;
  note?: string;
  now?: Date;
}

async function loadPending(store: Store, id: string, now: Date): Promise<Plan> {
  const plan = await store.getPlan(id);
  if (!plan) throw new GateError("PLAN_NOT_FOUND", `No plan with id ${id}.`);
  assertIntact(plan);
  if (plan.status !== "pending_approval") {
    throw new GateError("ALREADY_DECIDED", `Plan ${id} is "${plan.status}", not waiting for approval.`);
  }
  if (now.getTime() > Date.parse(plan.expiresAt)) {
    await store.updatePlan(id, (p) => (p.status === "pending_approval" ? { ...p, status: "expired", updatedAt: now.toISOString() } : p));
    await recordHead(store, id, await store.appendLedger({ type: "plan.expired", planId: id, at: now.toISOString() }));
    throw new GateError("EXPIRED", `Plan ${id} expired at ${plan.expiresAt}. The agent must plan again against fresh state.`);
  }
  return plan;
}

/**
 * Human approval. Lives outside the gate on purpose: the CLI (or your web UI, or a Slack
 * button) approves using only the store, so the process the agent talks to never needs,
 * and never exposes, an "approve" capability.
 */
export async function approvePlan(store: Store, id: string, opts: DecideOptions): Promise<Plan> {
  const now = opts.now ?? new Date();
  const by = opts.by?.trim();
  if (!by) throw new GateError("NOT_APPROVED", "An approval must name who approves.");
  const plan = await loadPending(store, id, now);
  if (by === plan.requestedBy) {
    throw new GateError("SELF_APPROVAL", `"${by}" requested this plan and cannot approve it.`);
  }
  const updated = await store.updatePlan(id, (p) => {
    if (p.status !== "pending_approval") throw new GateError("ALREADY_DECIDED", `Plan ${id} was decided concurrently.`);
    return {
      ...p,
      status: "approved",
      approval: { by, at: now.toISOString(), note: opts.note, planHash: p.hash },
      updatedAt: now.toISOString(),
    };
  });
  await recordHead(store, id, await store.appendLedger({ type: "plan.approved", planId: id, at: now.toISOString(), data: { by, note: opts.note, planHash: plan.hash } }));
  return (await store.getPlan(id)) ?? updated;
}

export async function rejectPlan(store: Store, id: string, opts: DecideOptions & { reason: string }): Promise<Plan> {
  const now = opts.now ?? new Date();
  const by = opts.by?.trim();
  if (!by) throw new GateError("NOT_APPROVED", "A rejection must name who rejects.");
  await loadPending(store, id, now);
  const updated = await store.updatePlan(id, (p) => {
    if (p.status !== "pending_approval") throw new GateError("ALREADY_DECIDED", `Plan ${id} was decided concurrently.`);
    return { ...p, status: "rejected", rejection: { by, at: now.toISOString(), reason: opts.reason }, updatedAt: now.toISOString() };
  });
  await recordHead(store, id, await store.appendLedger({ type: "plan.rejected", planId: id, at: now.toISOString(), data: { by, reason: opts.reason } }));
  return (await store.getPlan(id)) ?? updated;
}
