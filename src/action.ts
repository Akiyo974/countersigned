import { TollgateError } from "./errors.ts";
import type { ActionDefinition } from "./types.ts";

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Declares an action. Purely a typed identity function plus definition-time checks,
 * so mistakes surface when the server boots, not when an agent is halfway through a plan.
 */
export function defineAction<I, S, R>(def: ActionDefinition<I, S, R>): ActionDefinition<I, S, R> {
  if (!NAME.test(def.name)) {
    throw new TollgateError("INVALID_DEFINITION", `Action name "${def.name}" must be snake_case (a-z, 0-9, _), max 64 chars.`);
  }
  if (!def.description || def.description.trim().length < 10) {
    throw new TollgateError("INVALID_DEFINITION", `Action "${def.name}" needs a real description: the model chooses tools by reading it.`);
  }
  const needsCompensation = def.reversibility === "reversible" || def.reversibility === "compensable";
  if (needsCompensation && typeof def.compensate !== "function") {
    throw new TollgateError(
      "INVALID_DEFINITION",
      `Action "${def.name}" is declared "${def.reversibility}" but has no compensate(). ` +
        `Write the way back when you write the way forward, or declare it "irreversible".`,
    );
  }
  if (def.reversibility === "irreversible" && def.compensate) {
    throw new TollgateError("INVALID_DEFINITION", `Action "${def.name}" is "irreversible" but defines compensate(). Pick "compensable" instead.`);
  }
  for (const fn of ["observe", "preview", "execute", "verify"] as const) {
    if (typeof def[fn] !== "function") {
      throw new TollgateError("INVALID_DEFINITION", `Action "${def.name}" is missing ${fn}().`);
    }
  }
  return def;
}
