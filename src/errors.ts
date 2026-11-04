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
