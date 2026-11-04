import { GateError, NotAppliedError } from "./errors.ts";
import { hashValue, newId, sha256 } from "./hash.ts";
import { verifyChain, type ChainCheck } from "./ledger.ts";
import { approvePlan, assertIntact, computePlanHash, rejectPlan, type DecideOptions } from "./plan.ts";
import { decideStep, strictest, type PlanFacts, type PolicyRule, type StepFacts } from "./policy.ts";
import { ValidationError } from "./schema.ts";
import { MemoryStore, type Store } from "./store.ts";
import type {
  ActionInfo,
  AnyAction,
  ApplyReport,
  Decision,
  LedgerEntry,
  Plan,
  PlanStep,
  StepOutcome,
  StepRequest,
  Verdict,
} from "./types.ts";

export interface GateOptions {
  store?: Store;
  /** Policy rules. With none, reads run and every write waits for a human. */
  rules?: PolicyRule[];
  /** How long an approval request stays valid. Default 15 minutes. */
  approvalTtlMs?: number;
  /** Max steps per plan. Default 25. */
  maxSteps?: number;
  /** Injectable clock, for tests and simulations. */
  clock?: () => Date;
}

export interface PlanOptions {
  /** What the agent is trying to achieve, in its own words. Shown to the approver. */
  intent: string;
  /** Who asks: an agent id, a session id. Cannot approve its own plans. */
  requestedBy?: string;
}

export interface Drift {
  step: number;
  action: string;
  approved: unknown;
  current: unknown;
}

const normalizeVerdict = (v: Verdict): { ok: boolean; reason?: string; evidence?: unknown } =>
  typeof v === "boolean" ? { ok: v } : v;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The gate between an agent and the systems it acts on.
 *
 *   plan()    observe state, validate, preview effects, decide by policy. Nothing changes.
 *   approve() a human signs the exact plan hash (or policy auto-approves).
 *   apply()   recheck state for drift, execute with idempotency keys, verify every step
 *             against the real system, compensate in reverse on failure, ledger everything.
 */
export class Gate {
  readonly store: Store;
  private readonly registry = new Map<string, AnyAction>();
  private readonly rules: PolicyRule[];
  private readonly ttl: number;
  private readonly maxSteps: number;
  private readonly clock: () => Date;

  constructor(opts: GateOptions = {}) {
    this.store = opts.store ?? new MemoryStore();
    this.rules = opts.rules ?? [];
    this.ttl = opts.approvalTtlMs ?? 15 * 60_000;
    this.maxSteps = opts.maxSteps ?? 25;
    this.clock = opts.clock ?? (() => new Date());
  }

  register(...actions: AnyAction[]): this {
    for (const a of actions) {
      if (this.registry.has(a.name)) throw new GateError("INVALID_DEFINITION", `Action "${a.name}" is registered twice.`);
      this.registry.set(a.name, a);
    }
    return this;
  }

  actions(): ActionInfo[] {
    return [...this.registry.values()].map((a) => ({
      name: a.name,
      description: a.description,
      reversibility: a.reversibility,
      tags: a.tags ?? [],
      inputSchema: a.input.json,
    }));
  }

  private action(name: string): AnyAction {
    const a = this.registry.get(name);
    if (!a) {
      throw new GateError("UNKNOWN_ACTION", `Unknown action "${name}". Available: ${[...this.registry.keys()].join(", ") || "(none)"}.`);
    }
    return a;
  }

  // ---------------------------------------------------------------- plan

  async plan(requests: StepRequest[], opts: PlanOptions): Promise<Plan> {
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new GateError("INVALID_INPUT", "A plan needs at least one step.");
    }
    if (requests.length > this.maxSteps) {
      throw new GateError("INVALID_INPUT", `A plan can have at most ${this.maxSteps} steps; split the work.`);
    }
    const intent = (opts.intent ?? "").trim();
    if (!intent) throw new GateError("INVALID_INPUT", "Say what you are trying to achieve in `intent`: the approver reads it.");

    // Validate everything first and report every problem at once: one round-trip for the model.
    const problems: string[] = [];
    const parsed: { action: AnyAction; input: unknown }[] = [];
    requests.forEach((r, i) => {
      try {
        const action = this.action(r.action);
        parsed.push({ action, input: action.input.parse(r.input ?? {}) });
      } catch (e) {
        const detail = e instanceof ValidationError ? e.issues.map((x) => `${x.path || "input"} ${x.message}`).join("; ") : errMsg(e);
        problems.push(`step ${i} (${r.action}): ${detail}`);
      }
    });
    if (problems.length) {
      throw new GateError("INVALID_INPUT", `Plan rejected before anything ran. Fix and resend:\n- ${problems.join("\n- ")}`, problems);
    }

    const id = newId("pl");
    const now = this.clock();
    const facts: StepFacts[] = [];
    const drafts: Omit<PlanStep, "decision" | "reasons">[] = [];

    for (let i = 0; i < parsed.length; i++) {
      const { action, input } = parsed[i]!;
      const ctx = { planId: id, step: i };
      const before = await action.observe(input, ctx);
      const violations = (await action.check?.(input, before)) ?? [];
      const effects = violations.length ? [] : action.preview(input, before);
      const draft = {
        index: i,
        action: action.name,
        input,
        reversibility: action.reversibility,
        tags: action.tags ?? [],
        stateHash: hashValue(before),
        before,
        effects,
        violations: [...violations],
      };
      drafts.push(draft);
      facts.push({ action: draft.action, input, reversibility: draft.reversibility, tags: draft.tags, effects, violations: draft.violations });
    }

    const requestedBy = opts.requestedBy?.trim() || "agent";
    const planFacts: PlanFacts = { intent, requestedBy, steps: facts };
    let decision = "allow" as Decision;
    const steps: PlanStep[] = drafts.map((d, i) => {
      const r = decideStep(facts[i]!, planFacts, this.rules);
      decision = strictest(decision, r.decision);
      return { ...d, decision: r.decision, reasons: r.reasons };
    });
    // The plan-level reasons explain the decisive steps only.
    const reasons = steps
      .filter((s) => s.decision === decision)
      .flatMap((s) => s.reasons.map((r) => `step ${s.index} ${s.action}: ${r}`));

    const base = {
      id,
      version: 1 as const,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttl).toISOString(),
      intent,
      requestedBy,
      steps,
      decision,
      reasons,
    };
    const hash = computePlanHash(base);
    const status = decision === "deny" ? "denied" : decision === "allow" ? "approved" : "pending_approval";
    const plan: Plan = {
      ...base,
      hash,
      status,
      updatedAt: now.toISOString(),
      ...(decision === "allow" ? { approval: { by: "policy", at: now.toISOString(), planHash: hash, automatic: true } } : {}),
    };

    await this.store.createPlan(plan);
    await this.store.appendLedger({
      type: "plan.created",
      planId: id,
      at: plan.createdAt,
      data: { intent, requestedBy, hash, decision, steps: steps.map((s) => ({ action: s.action, stateHash: s.stateHash })) },
    });
    if (decision === "deny") await this.store.appendLedger({ type: "plan.denied", planId: id, at: plan.createdAt, data: { reasons: plan.reasons } });
    if (decision === "allow") await this.store.appendLedger({ type: "plan.approved", planId: id, at: plan.createdAt, data: { by: "policy", automatic: true, planHash: hash } });
    return plan;
  }

  // ---------------------------------------------------------------- decide

  approve(id: string, opts: Omit<DecideOptions, "now">): Promise<Plan> {
    return approvePlan(this.store, id, { ...opts, now: this.clock() });
  }

  reject(id: string, opts: Omit<DecideOptions, "now"> & { reason: string }): Promise<Plan> {
    return rejectPlan(this.store, id, { ...opts, now: this.clock() });
  }

  async get(id: string): Promise<Plan> {
    const plan = await this.store.getPlan(id);
    if (!plan) throw new GateError("PLAN_NOT_FOUND", `No plan with id ${id}.`);
    return plan;
  }

  // ---------------------------------------------------------------- apply

  async apply(id: string): Promise<ApplyReport> {
    const plan = await this.get(id);

    if (plan.report && ["applied", "compensated", "failed"].includes(plan.status)) return plan.report;

    switch (plan.status) {
      case "denied":
        throw new GateError("PLAN_DENIED", `Plan ${id} was denied by policy: ${plan.reasons.join("; ")}`);
      case "pending_approval":
        throw new GateError("NOT_APPROVED", `Plan ${id} is waiting for a human. Tell the user to run: countersigned approve ${id}`);
      case "rejected":
        throw new GateError("NOT_APPROVED", `Plan ${id} was rejected by ${plan.rejection?.by}: ${plan.rejection?.reason}`);
      case "stale":
        throw new GateError("STALE_STATE", `Plan ${id} is stale: the world changed since approval. Plan again.`);
      case "expired":
        throw new GateError("EXPIRED", `Plan ${id} expired. Plan again.`);
    }

    assertIntact(plan);
    if (!plan.approval) throw new GateError("NOT_APPROVED", `Plan ${id} has no approval.`);

    const now = this.clock();
    const resuming = plan.status === "applying";

    if (!resuming) {
      if (now.getTime() > Date.parse(plan.expiresAt)) {
        await this.store.updatePlan(id, (p) => ({ ...p, status: "expired", updatedAt: now.toISOString() }));
        await this.store.appendLedger({ type: "plan.expired", planId: id, at: now.toISOString() });
        throw new GateError("EXPIRED", `Plan ${id} expired at ${plan.expiresAt} before it was applied. Plan again.`);
      }
      await this.recheck(plan);
      await this.store.updatePlan(id, (p) => {
        if (p.status !== "approved") throw new GateError("ALREADY_DECIDED", `Plan ${id} is already being applied by another process.`);
        return { ...p, status: "applying", updatedAt: now.toISOString() };
      });
      await this.store.appendLedger({ type: "apply.started", planId: id, at: now.toISOString() });
    }

    return this.execute(plan);
  }

  /** Time-of-check vs time-of-use: refuse if any observed state moved since the plan was made. */
  private async recheck(plan: Plan): Promise<void> {
    const drifts: Drift[] = [];
    const violations: string[] = [];
    for (const step of plan.steps) {
      const action = this.action(step.action);
      const input = action.input.parse(step.input);
      const current = await action.observe(input, { planId: plan.id, step: step.index });
      if (hashValue(current) !== step.stateHash) {
        drifts.push({ step: step.index, action: step.action, approved: step.before, current });
      }
      for (const v of (await action.check?.(input, current)) ?? []) violations.push(`step ${step.index} ${step.action}: ${v}`);
    }
    if (!drifts.length && !violations.length) return;

    const at = this.clock().toISOString();
    await this.store.updatePlan(plan.id, (p) => ({ ...p, status: "stale", updatedAt: at }));
    await this.store.appendLedger({ type: "plan.stale", planId: plan.id, at, data: { drifts, violations } });
    if (drifts.length) {
      const which = drifts.map((d) => `step ${d.step} (${d.action})`).join(", ");
      throw new GateError(
        "STALE_STATE",
        `Refused: state changed since plan ${plan.id} was approved, at ${which}. Nothing was executed. Re-read the state and plan again.`,
        drifts,
      );
    }
    throw new GateError("PRECONDITION_FAILED", `Refused: preconditions no longer hold. Nothing was executed.\n- ${violations.join("\n- ")}`, violations);
  }

  private async execute(plan: Plan): Promise<ApplyReport> {
    const ledger = await this.store.readLedger({ planId: plan.id });
    const succeeded = new Map<number, LedgerEntry>();
    for (const e of ledger) if (e.type === "step.succeeded" && e.step !== undefined) succeeded.set(e.step, e);

    const outcomes: StepOutcome[] = plan.steps.map((s) => ({ index: s.index, action: s.action, status: "not_run" }));
    const done: { index: number; result: unknown }[] = [];
    let failure: { index: number; error: string; result?: unknown; executed: boolean; notApplied?: boolean } | undefined;

    for (const step of plan.steps) {
      const action = this.action(step.action);
      const input = action.input.parse(step.input);
      const key = `cs_${sha256(`${plan.hash}:${step.index}`).slice(0, 32)}`;
      const ctx = { planId: plan.id, step: step.index, idempotencyKey: key, before: step.before };
      const outcome = outcomes[step.index]!;

      const prior = succeeded.get(step.index);
      if (prior) {
        const d = prior.data as { result?: unknown; evidence?: unknown } | undefined;
        Object.assign(outcome, { status: "skipped_already_done", result: d?.result, evidence: d?.evidence });
        done.push({ index: step.index, result: d?.result });
        continue;
      }

      // Write-ahead: the intent is on record before the side effect can happen.
      await this.store.appendLedger({ type: "step.intent", planId: plan.id, step: step.index, key, data: { action: step.action, input } });

      let result: unknown;
      try {
        result = await action.execute(input, ctx);
      } catch (e) {
        const notApplied = e instanceof NotAppliedError;
        outcome.status = "failed";
        outcome.error = notApplied ? `not applied: ${errMsg(e)}` : errMsg(e);
        await this.store.appendLedger({ type: "step.failed", planId: plan.id, step: step.index, key, data: { error: outcome.error, notApplied } });
        failure = { index: step.index, error: outcome.error, executed: false, notApplied };
        break;
      }

      let verdict: { ok: boolean; reason?: string; evidence?: unknown };
      try {
        verdict = normalizeVerdict(await action.verify(input, result, ctx));
      } catch (e) {
        verdict = { ok: false, reason: `verify() threw: ${errMsg(e)}` };
      }

      if (!verdict.ok) {
        outcome.status = "failed";
        outcome.result = result;
        outcome.evidence = verdict.evidence;
        outcome.error = `verification failed: ${verdict.reason ?? "postcondition not met"}`;
        await this.store.appendLedger({
          type: "step.verify_failed",
          planId: plan.id,
          step: step.index,
          key,
          data: { result, reason: verdict.reason, evidence: verdict.evidence },
        });
        failure = { index: step.index, error: outcome.error, result, executed: true };
        break;
      }

      Object.assign(outcome, { status: "succeeded", result, evidence: verdict.evidence });
      await this.store.appendLedger({ type: "step.succeeded", planId: plan.id, step: step.index, key, data: { result, evidence: verdict.evidence } });
      done.push({ index: step.index, result });
    }

    const unrecoverable: ApplyReport["unrecoverable"] = [];
    let status: Plan["status"] = "applied";
    let message = `All ${plan.steps.length} step(s) executed and verified against the real system.`;

    if (failure) {
      // Saga: undo in reverse order. The failed step is compensated only if it reported a result
      // (so it ran, but reality does not match). If execute() threw, its effect is unknown.
      const toUndo: { index: number; result: unknown }[] = [...done].reverse();
      if (failure.executed) toUndo.unshift({ index: failure.index, result: failure.result });
      else if (!failure.notApplied && plan.steps[failure.index]!.reversibility !== "read") {
        unrecoverable.push({
          index: failure.index,
          action: plan.steps[failure.index]!.action,
          reason: `execute() threw (${failure.error}); the effect is unknown. Check the system using idempotency key, then retry or fix by hand.`,
        });
      }

      for (const u of toUndo) {
        const step = plan.steps[u.index]!;
        const action = this.action(step.action);
        const outcome = outcomes[u.index]!;
        if (step.reversibility === "read") continue;
        if (!action.compensate) {
          unrecoverable.push({ index: u.index, action: step.action, reason: "irreversible step already took effect" });
          continue;
        }
        const key = `cs_${sha256(`${plan.hash}:${u.index}`).slice(0, 32)}`;
        try {
          await action.compensate(action.input.parse(step.input), u.result, {
            planId: plan.id,
            step: u.index,
            idempotencyKey: key,
            before: step.before,
          });
          if (u.index !== failure.index) outcome.status = "compensated";
          else outcome.error = `${outcome.error}; compensated`;
          await this.store.appendLedger({ type: "step.compensated", planId: plan.id, step: u.index, key });
        } catch (e) {
          outcome.status = "compensation_failed";
          outcome.error = `compensation failed: ${errMsg(e)}`;
          unrecoverable.push({ index: u.index, action: step.action, reason: outcome.error });
          await this.store.appendLedger({ type: "step.compensation_failed", planId: plan.id, step: u.index, key, data: { error: errMsg(e) } });
        }
      }

      status = unrecoverable.length ? "failed" : "compensated";
      message = unrecoverable.length
        ? `Step ${failure.index} (${plan.steps[failure.index]!.action}) failed: ${failure.error}. Some effects could not be undone: a human must review.`
        : `Step ${failure.index} (${plan.steps[failure.index]!.action}) failed: ${failure.error}. Every earlier effect was compensated; the system is back to its approved state.`;
    }

    const report: ApplyReport = { planId: plan.id, status, steps: outcomes, unrecoverable, message };
    const at = this.clock().toISOString();
    await this.store.updatePlan(plan.id, (p) => ({ ...p, status, report, updatedAt: at }));
    await this.store.appendLedger({ type: "apply.finished", planId: plan.id, at, data: { status, unrecoverable } });
    return report;
  }

  // ---------------------------------------------------------------- shortcuts

  /**
   * Plan and apply in one call, for actions the policy allows without a human (typically reads).
   * Throws NOT_APPROVED with the plan id if a human is needed.
   */
  async run(action: string, input: unknown, opts: Partial<PlanOptions> = {}): Promise<unknown> {
    const plan = await this.plan([{ action, input }], { intent: opts.intent ?? `run ${action}`, requestedBy: opts.requestedBy });
    if (plan.status === "denied") throw new GateError("PLAN_DENIED", `Denied: ${plan.reasons.join("; ")}`, plan);
    if (plan.status !== "approved") {
      throw new GateError("NOT_APPROVED", `"${action}" needs a human. Plan ${plan.id} is waiting: countersigned approve ${plan.id}`, plan);
    }
    const report = await this.apply(plan.id);
    if (report.status !== "applied") throw new GateError("PRECONDITION_FAILED", report.message, report);
    return report.steps[0]?.result;
  }

  async verifyLedger(): Promise<ChainCheck> {
    return verifyChain(await this.store.readLedger());
  }
}
