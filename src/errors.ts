export type GateErrorCode =
  | "UNKNOWN_ACTION"
  | "INVALID_INPUT"
  | "PLAN_NOT_FOUND"
  | "PLAN_DENIED"
  | "NOT_APPROVED"
  | "ALREADY_DECIDED"
  | "EXPIRED"
  | "TAMPERED"
  | "STALE_STATE"
  | "SELF_APPROVAL"
  | "PRECONDITION_FAILED"
  | "INVALID_DEFINITION"
  | "LEDGER_CORRUPT";

/**
 * Every refusal carries a stable code (for programs) and a message written so that
 * an LLM reading it knows what to do next.
 */
export class GateError extends Error {
  readonly code: GateErrorCode;
  readonly details?: unknown;
  constructor(code: GateErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "GateError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Throw from `execute()` when you KNOW the side effect did not happen: the downstream system
 * rejected the write before applying it (HTTP 409 / 412 / 422, a failed `If-Match`, a version
 * conflict, a validation error). The gate then treats the step as cleanly failed instead of
 * "outcome unknown", compensates the earlier steps and leaves nothing for a human to check.
 *
 * Only throw it when you are sure. When in doubt (timeouts, 5xx, dropped connections),
 * throw a normal error: an unknown outcome is reported for a human, which is the safe default.
 */
export class NotAppliedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAppliedError";
  }
}
