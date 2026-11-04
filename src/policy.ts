import type { Decision, Effect, Reversibility } from "./types.ts";

/** What a policy rule sees for each step. Plain data: rules must be pure and fast. */
export interface StepFacts {
  action: string;
  input: unknown;
  reversibility: Reversibility;
  tags: string[];
  effects: Effect[];
  violations: string[];
}

export interface PlanFacts {
  intent: string;
  requestedBy: string;
  steps: StepFacts[];
}

export interface RuleResult {
  decision: Decision;
  reason: string;
}

/** Return a result to have an opinion, or undefined to abstain. */
export type PolicyRule = (step: StepFacts, plan: PlanFacts) => RuleResult | undefined;

const rank: Record<Decision, number> = { allow: 0, require_approval: 1, deny: 2 };

export function strictest(a: Decision, b: Decision): Decision {
  return rank[a] >= rank[b] ? a : b;
}

/**
 * The safe default when no rule has an opinion:
 * reads run, anything that writes waits for a human.
 */
export function defaultDecision(step: StepFacts): RuleResult {
  if (step.reversibility === "read") return { decision: "allow", reason: "read-only action" };
  return { decision: "require_approval", reason: `${step.reversibility} action: a human signs off by default` };
}

/**
 * Evaluates every rule against a step. Strictest opinion wins; a `deny` can never be
 * relaxed by another rule. Business-rule violations always deny.
 */
export function decideStep(step: StepFacts, plan: PlanFacts, rules: PolicyRule[]): { decision: Decision; reasons: string[] } {
  if (step.violations.length) {
    return { decision: "deny", reasons: step.violations.map((v) => `precondition: ${v}`) };
  }
  const opinions = rules.map((r) => r(step, plan)).filter((r): r is RuleResult => r !== undefined);
  if (!opinions.length) {
    const d = defaultDecision(step);
    return { decision: d.decision, reasons: [d.reason] };
  }
  let decision: Decision = "allow";
  for (const o of opinions) decision = strictest(decision, o.decision);
  return { decision, reasons: opinions.filter((o) => o.decision === decision).map((o) => o.reason) };
}

type ActionMatcher = string | string[] | ((step: StepFacts) => boolean);

function matches(m: ActionMatcher, step: StepFacts): boolean {
  if (typeof m === "function") return m(step);
  return (Array.isArray(m) ? m : [m]).includes(step.action);
}

/** Ready-made rules. Compose freely; write your own as plain functions. */
export const rules = {
  /** Let these actions run without a human (still verified, still ledgered). */
  autoApprove(match: ActionMatcher, reason = "auto-approved by policy"): PolicyRule {
    return (step) => (matches(match, step) ? { decision: "allow", reason } : undefined);
  },

  /** Always require a human for these actions. */
  requireApproval(match: ActionMatcher, reason = "requires human approval by policy"): PolicyRule {
    return (step) => (matches(match, step) ? { decision: "require_approval", reason } : undefined);
  },

  /** Never allow these actions, whatever the plan says. */
  deny(match: ActionMatcher, reason = "denied by policy"): PolicyRule {
    return (step) => (matches(match, step) ? { decision: "deny", reason } : undefined);
  },

  /** Every irreversible step needs a human. Recommended in production. */
  irreversibleNeedsApproval(): PolicyRule {
    return (step) =>
      step.reversibility === "irreversible" ? { decision: "require_approval", reason: "irreversible: cannot be undone" } : undefined;
  },

  /** Steps carrying any of these tags need a human. */
  tagNeedsApproval(tags: string[]): PolicyRule {
    return (step) => {
      const hit = step.tags.filter((t) => tags.includes(t));
      return hit.length ? { decision: "require_approval", reason: `tagged ${hit.join(", ")}` } : undefined;
    };
  },

  /** Blast-radius guard: a single step touching more than `max` targets is denied. */
  maxEffects(max: number): PolicyRule {
    return (step) =>
      step.effects.length > max
        ? { decision: "deny", reason: `touches ${step.effects.length} targets (limit ${max}); split the plan` }
        : undefined;
  },

  /** Plans with more than `max` steps need a human, even if each step alone would be fine. */
  maxAutoSteps(max: number): PolicyRule {
    return (_step, plan) =>
      plan.steps.length > max
        ? { decision: "require_approval", reason: `plan has ${plan.steps.length} steps (auto limit ${max})` }
        : undefined;
  },
};
