import type { JsonSchema, Schema } from "./schema.ts";

/**
 * How bad is it if this action turns out to be wrong?
 *
 * - `read`         no side effect at all.
 * - `reversible`   `compensate` restores the exact previous state (update a field, toggle a flag).
 * - `compensable`  `compensate` issues a correction, but the world remembers (reschedule back, refund).
 * - `irreversible` no way back once it ran (send an email, ship a pallet, call the customer).
 */
export type Reversibility = "read" | "reversible" | "compensable" | "irreversible";

export type Decision = "allow" | "require_approval" | "deny";

/** One observable change, shown to the human approver before anything happens. */
export interface Effect {
  /** What is touched, e.g. `item:ACME-42` or `email:supplier@acme.com`. */
  target: string;
  op: "create" | "update" | "delete" | "send" | "call" | "read";
  before?: unknown;
  after?: unknown;
  /** One line, plain language. Shown first in the CLI. */
  summary?: string;
}

export type Verdict = boolean | { ok: boolean; reason?: string; evidence?: unknown };

export interface ActionContext {
  planId: string;
  step: number;
}

export interface ExecuteContext<S> extends ActionContext {
  /**
   * Stable for this plan step across retries and process restarts.
   * Forward it to the downstream system (an Idempotency-Key header, an external reference
   * field, a dedupe column) so a retried call can never act twice.
   */
  idempotencyKey: string;
  /** The state observed and approved at plan time (and rechecked just before apply). */
  before: S;
}

export interface VerifyContext<S> extends ActionContext {
  idempotencyKey: string;
  before: S;
}

export interface CompensateContext<S> extends ActionContext {
  idempotencyKey: string;
  before: S;
}

export interface ActionDefinition<I, S, R> {
  /** snake_case, unique inside a gate. Becomes part of the tool contract the model sees. */
  name: string;
  /** Written for the model: what it does, when to use it, what it will not do. */
  description: string;
  input: Schema<I>;
  reversibility: Reversibility;
  /**
   * Read the authoritative state this action depends on, and nothing else.
   * Called at plan time and again right before apply: if the two snapshots differ,
   * the world moved since the human approved, and the plan is refused as stale.
   */
  observe(input: I, ctx: ActionContext): Promise<S> | S;
  /** Business preconditions. Return human readable violations; any violation blocks the plan. */
  check?(input: I, state: S): Promise<string[] | void> | string[] | void;
  /** Describe the change. This is what the approver reads, so make it honest and concrete. */
  preview(input: I, state: S): Effect[];
  /** Do the thing. Receives a stable idempotency key: pass it downstream. */
  execute(input: I, ctx: ExecuteContext<S>): Promise<R> | R;
  /**
   * Check, against the real system, that the effect actually happened.
   * Never trust the return value of `execute` alone: re-read the source of truth.
   * Mandatory, because "the agent said it's done" is not evidence.
   */
  verify(input: I, result: R, ctx: VerifyContext<S>): Promise<Verdict> | Verdict;
  /** Undo or correct the effect. Required unless reversibility is `read` or `irreversible`. */
  compensate?(input: I, result: R | undefined, ctx: CompensateContext<S>): Promise<void> | void;
  /** Free form tags usable by policies, e.g. `["finance", "customer-facing"]`. */
  tags?: string[];
}

// The registry stores actions with erased generics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAction = ActionDefinition<any, any, any>;

export interface StepRequest {
  action: string;
  input: unknown;
}

export interface PlanStep {
  index: number;
  action: string;
  input: unknown;
  reversibility: Reversibility;
  tags: string[];
  /** Hash of the observed state. Drift detection compares against this. */
  stateHash: string;
  /** The observed state itself, kept so compensation and humans can see the "before". */
  before: unknown;
  effects: Effect[];
  violations: string[];
  decision: Decision;
  reasons: string[];
}

export type PlanStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "denied"
  | "applying"
  | "applied"
  | "compensated"
  | "failed"
  | "stale"
  | "expired";

export interface Approval {
  by: string;
  at: string;
  note?: string;
  /** The exact plan hash that was looked at. Apply refuses anything else. */
  planHash: string;
  automatic?: boolean;
}

export interface StepOutcome {
  index: number;
  action: string;
  status: "succeeded" | "skipped_already_done" | "failed" | "compensated" | "compensation_failed" | "not_run";
  result?: unknown;
  evidence?: unknown;
  error?: string;
}

export interface ApplyReport {
  planId: string;
  status: PlanStatus;
  steps: StepOutcome[];
  /** Effects that happened and could not be undone. A human must look at these. */
  unrecoverable: { index: number; action: string; reason: string }[];
  message: string;
}

export interface Plan {
  id: string;
  version: 1;
  createdAt: string;
  expiresAt: string;
  /** What the agent says it is trying to achieve. Shown to the approver. */
  intent: string;
  requestedBy: string;
  steps: PlanStep[];
  decision: Decision;
  reasons: string[];
  /** sha256 over everything that defines behaviour. Approval is pinned to it. */
  hash: string;
  status: PlanStatus;
  approval?: Approval;
  rejection?: { by: string; at: string; reason: string };
  report?: ApplyReport;
  updatedAt: string;
  /**
   * The last ledger entry recorded for this plan. Lets verifyStore() detect a ledger whose
   * tail was cut off, which a hash chain alone cannot notice. Not covered by the plan hash.
   */
  ledgerHead?: { seq: number; hash: string };
}

export type LedgerEventType =
  | "plan.created"
  | "plan.denied"
  | "plan.approved"
  | "plan.rejected"
  | "plan.expired"
  | "plan.stale"
  | "apply.started"
  | "apply.resumed"
  | "step.intent"
  | "step.succeeded"
  | "step.verify_failed"
  | "step.failed"
  | "step.compensated"
  | "step.compensation_failed"
  | "apply.finished";

export interface LedgerEntry {
  seq: number;
  at: string;
  type: LedgerEventType;
  planId: string;
  step?: number;
  key?: string;
  data?: unknown;
  prevHash: string;
  hash: string;
}

export type LedgerInput = Omit<LedgerEntry, "seq" | "prevHash" | "hash" | "at"> & { at?: string };

export interface ActionInfo {
  name: string;
  description: string;
  reversibility: Reversibility;
  tags: string[];
  inputSchema: JsonSchema;
}
