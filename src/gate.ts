import { GateError, NotAppliedError } from "./errors.ts";
import { hashValue, newId, sha256 } from "./hash.ts";
import { verifyStore, type ChainCheck } from "./ledger.ts";
import { approvePlan, assertIntact, computePlanHash, recordHead, rejectPlan, type DecideOptions } from "./plan.ts";
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
    if (intent.length > 1000) throw new GateError("INVALID_INPUT", "`intent` is limited to 1000 characters.");
    // Control characters could rewrite what the human sees in a terminal. Refuse them outright.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(intent)) {
      throw new GateError("INVALID_INPUT", "`intent` must be a single line of plain text (no control or direction-override characters).");
    }

    // Validate everything first and report every problem at once: one round-trip for the model.
    const problems: string[] = [];
    const parsed: { action: AnyAction; input: unknown }[] = [];
    requests.forEach((r, i) => {
      try {
        if (r === null || typeof r !== "object" || typeof r.action !== "string") throw new Error("each step must be an object with an `action` string and an `input` object");
        const action = this.action(r.action);
        parsed.push({ action, input: action.input.parse(r.input ?? {}) });
      } catch (e) {
        const detail = e instanceof ValidationError ? e.issues.map((x) => `${x.path || "input"} ${x.message}`).join("; ") : errMsg(e);
        problems.push(`step ${i} (${(r as StepRequest | null)?.action ?? "?"}): ${detail}`);
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
    const created = await this.store.appendLedger({
      type: "plan.created",
      planId: id,
      at: plan.createdAt,
      data: { intent, requestedBy, hash, decision, steps: steps.map((s) => ({ action: s.action, stateHash: s.stateHash })) },
    });
    let last: LedgerEntry | undefined = created;
    if (decision === "deny") last = await this.store.appendLedger({ type: "plan.denied", planId: id, at: plan.createdAt, data: { reasons: plan.reasons } });
    if (decision === "allow") last = await this.store.appendLedger({ type: "plan.approved", planId: id, at: plan.createdAt, data: { by: "policy", automatic: true, planHash: hash } });
    if (last) await recordHead(this.store, id, last);
    return (await this.store.getPlan(id)) ?? plan;
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

    // "applying" means another apply is running, or one was interrupted. Never resume implicitly:
    // an agent able to crash the process must not be able to re-run steps or skip the checks.
    if (plan.status === "applying") {
      throw new GateError(
        "APPLY_IN_PROGRESS",
        `Plan ${id} is being applied, or a previous apply was interrupted. Nothing was run again. ` +
          `An operator must inspect it and call resume() once the original process is confirmed stopped.`,
      );
    }

    if (now.getTime() > Date.parse(plan.expiresAt)) {
      await this.store.updatePlan(id, (p) => (p.status === "approved" ? { ...p, status: "expired", updatedAt: now.toISOString() } : p));
      const e = await this.store.appendLedger({ type: "plan.expired", planId: id, at: now.toISOString() });
      await recordHead(this.store, id, e);
      throw new GateError("EXPIRED", `Plan ${id} expired at ${plan.expiresAt} before it was applied. Plan again.`);
    }
    await this.recheck(plan);
    // Compare-and-set: exactly one caller moves approved -> applying and becomes the owner.
    // Every other concurrent apply is refused.
    const owner = newId("own");
    await this.store.updatePlan(id, (p) => {
      if (p.status !== "approved") throw new GateError("APPLY_IN_PROGRESS", `Plan ${id} is already being applied by another caller.`);
      return { ...p, status: "applying", applyOwner: owner, updatedAt: now.toISOString() };
    });
    await this.head(id, await this.store.appendLedger({ type: "apply.started", planId: id, at: now.toISOString() }));

    return this.execute(plan, owner);
  }

  /**
   * Operator-only: continue a plan whose apply was interrupted (crash, kill, power loss).
   * Not exposed over MCP. Call it only once you know the original process is gone.
   *
   * Finished steps are skipped. A step that started but has no recorded outcome is "in doubt":
   * its verify() is asked against the real system. If it confirms, the step counts as done;
   * otherwise it is NOT run again and is reported for a human.
   */
  async resume(id: string, opts: { by: string; ignoreDrift?: boolean; allowExpired?: boolean }): Promise<ApplyReport> {
    const by = opts.by?.trim();
    if (!by) throw new GateError("NOT_APPROVED", "resume() must name the operator.");
    const plan = await this.get(id);
    if (plan.status !== "applying") {
      if (plan.report) return plan.report;
      throw new GateError("ALREADY_DECIDED", `Plan ${id} is "${plan.status}", there is nothing to resume.`);
    }
    assertIntact(plan);

    const now = this.clock();
    if (now.getTime() > Date.parse(plan.expiresAt) && !opts.allowExpired) {
      throw new GateError(
        "EXPIRED",
        `Plan ${id} expired at ${plan.expiresAt}. Resuming would act on an approval that has lapsed; pass { allowExpired: true } if you have checked it.`,
      );
    }

    // Steps that never started must still match the approved state, as in a normal apply.
    const ledger = await this.store.readLedger({ planId: id });
    const started = new Set(ledger.filter((e) => e.type === "step.intent").map((e) => e.step));
    if (!opts.ignoreDrift) {
      const drifts: Drift[] = [];
      for (const step of plan.steps.filter((s) => !started.has(s.index))) {
        const action = this.action(step.action);
        const current = await action.observe(action.input.parse(step.input), { planId: id, step: step.index });
        if (hashValue(current) !== step.stateHash) drifts.push({ step: step.index, action: step.action, approved: step.before, current });
      }
      if (drifts.length) {
        throw new GateError(
          "STALE_STATE",
          `Not resumed: state changed for steps that have not run yet (${drifts.map((d) => `step ${d.step} ${d.action}`).join(", ")}). ` +
            `If the change comes from earlier steps of this same plan, pass { ignoreDrift: true }.`,
          drifts,
        );
      }
    }

    // Take ownership atomically from whoever held it. A second resume, or the original apply if it
    // is in fact still alive, sees the owner change and stops before its next step.
    const previous = plan.applyOwner;
    const owner = newId("own");
    await this.store.updatePlan(id, (p) => {
      if (p.status !== "applying" || p.applyOwner !== previous) {
        throw new GateError("APPLY_IN_PROGRESS", `Plan ${id} was taken over by another caller while resuming.`);
      }
      return { ...p, applyOwner: owner, updatedAt: now.toISOString() };
    });
    await this.head(id, await this.store.appendLedger({ type: "apply.resumed", planId: id, at: now.toISOString(), data: { by, ignoreDrift: !!opts.ignoreDrift, allowExpired: !!opts.allowExpired } }));
    return this.execute(plan, owner, true);
  }

  private async head(id: string, entry: LedgerEntry): Promise<void> {
    await recordHead(this.store, id, entry);
  }

  /** True while `owner` still owns the apply. Checked before every step. */
  private async stillOwner(id: string, owner: string): Promise<boolean> {
    const p = await this.store.getPlan(id);
    return p?.status === "applying" && p.applyOwner === owner;
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
    // Only an approved plan becomes stale; never overwrite a status another caller has moved on.
    let moved = false;
    await this.store.updatePlan(plan.id, (p) => {
      if (p.status !== "approved") return p;
      moved = true;
      return { ...p, status: "stale", updatedAt: at };
    });
    if (moved) await this.head(plan.id, await this.store.appendLedger({ type: "plan.stale", planId: plan.id, at, data: { drifts, violations } }));
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

  private async execute(plan: Plan, owner: string, resuming = false): Promise<ApplyReport> {
    const ledger = resuming ? await this.store.readLedger({ planId: plan.id }) : [];
    const succeeded = new Map<number, LedgerEntry>();
    const started = new Set<number>();
    const ended = new Map<number, LedgerEntry>();
    for (const e of ledger) {
      if (e.step === undefined) continue;
      if (e.type === "step.succeeded") succeeded.set(e.step, e);
      else if (e.type === "step.intent") started.add(e.step);
      else if (e.type === "step.failed" || e.type === "step.verify_failed") ended.set(e.step, e);
    }

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

      // Resume only: a step whose failure was already recorded is not retried.
      const priorFailure = ended.get(step.index);
      if (priorFailure) {
        const d = priorFailure.data as { error?: string; reason?: string; result?: unknown; notApplied?: boolean } | undefined;
        const verifyFailed = priorFailure.type === "step.verify_failed";
        outcome.status = "failed";
        outcome.error = verifyFailed ? `verification failed: ${d?.reason ?? "postcondition not met"}` : (d?.error ?? "failed");
        failure = { index: step.index, error: outcome.error, result: d?.result, executed: verifyFailed, notApplied: d?.notApplied };
        break;
      }

      // Resume only: started, no outcome recorded. Ask the system, never re-execute blindly.
      if (started.has(step.index)) {
        let verdict: { ok: boolean; reason?: string; evidence?: unknown };
        try {
          verdict = normalizeVerdict(await action.verify(input, undefined, ctx));
        } catch (e) {
          verdict = { ok: false, reason: `verify() threw: ${errMsg(e)}` };
        }
        if (verdict.ok) {
          Object.assign(outcome, { status: "succeeded", evidence: verdict.evidence });
          await this.head(plan.id, await this.store.appendLedger({ type: "step.succeeded", planId: plan.id, step: step.index, key, data: { reconciled: true, evidence: verdict.evidence } }));
          done.push({ index: step.index, result: undefined });
          continue;
        }
        outcome.status = "failed";
        outcome.error = `in doubt after interruption: verify() could not confirm the effect (${verdict.reason ?? "no reason"}); not re-executed`;
        await this.store.appendLedger({ type: "step.failed", planId: plan.id, step: step.index, key, data: { error: outcome.error, inDoubt: true } });
        failure = { index: step.index, error: outcome.error, executed: false };
        break;
      }

      if (!(await this.stillOwner(plan.id, owner))) {
        throw new GateError("APPLY_IN_PROGRESS", `Plan ${plan.id} was taken over by resume(); this caller stopped before step ${step.index}.`);
      }
      // Write-ahead: the intent is on record (and anchored on the plan) before the side effect can happen.
      await this.head(plan.id, await this.store.appendLedger({ type: "step.intent", planId: plan.id, step: step.index, key, data: { action: step.action, input } }));

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
      await this.head(plan.id, await this.store.appendLedger({ type: "step.succeeded", planId: plan.id, step: step.index, key, data: { result, evidence: verdict.evidence } }));
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
    await this.store.updatePlan(plan.id, (p) => {
      if (p.applyOwner !== owner) throw new GateError("APPLY_IN_PROGRESS", `Plan ${plan.id} was taken over by resume() before this caller finished.`);
      return { ...p, status, report, updatedAt: at };
    });
    const e = await this.store.appendLedger({ type: "apply.finished", planId: plan.id, at, data: { status, unrecoverable } });
    await recordHead(this.store, plan.id, e);
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

  /** Checks the hash chain AND that every plan's last recorded entry is still present (catches truncation). */
  async verifyLedger(): Promise<ChainCheck> {
    return verifyStore(this.store);
  }
}
