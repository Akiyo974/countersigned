/**
 * Everything printed here may contain text chosen by the agent. Strip anything that could move
 * the cursor, recolor, hide text or reorder it (C0/C1 controls, ANSI escapes, bidi overrides),
 * and make line breaks visible, so the human sees exactly what they approve.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
export const safe = (v: unknown): string => String(v ?? "").replace(/\r?\n/g, " \u23CE ").replace(UNSAFE, "\uFFFD");
