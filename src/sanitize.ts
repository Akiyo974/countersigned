/**
 * Everything printed here may contain text chosen by the agent. Strip anything that could move
 * the cursor, recolor, hide text or reorder it (C0/C1 controls, ANSI escapes, bidi overrides, zero-width and other invisible format characters),
 * and make line breaks visible, so the human sees exactly what they approve.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
export const safe = (v: unknown): string => String(v ?? "").replace(/\r?\n/g, " \u23CE ").replace(UNSAFE, "\uFFFD");
