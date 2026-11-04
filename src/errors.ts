export type TollgateErrorCode =
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
export class TollgateError extends Error {
  readonly code: TollgateErrorCode;
  readonly details?: unknown;
  constructor(code: TollgateErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "TollgateError";
    this.code = code;
    this.details = details;
  }
}
