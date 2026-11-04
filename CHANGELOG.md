# Changelog

## Unreleased

### Security (pre-launch adversarial review)

- An interrupted apply is no longer resumed by the next `apply()` call: it is refused with `APPLY_IN_PROGRESS`. New operator-only `gate.resume(id, { by })` asks `verify()` about steps that started without a recorded outcome and never re-executes them blindly. Previously an agent able to crash the MCP server mid-apply could get a step executed twice and skip the drift and expiry checks.
- Concurrent `apply()` calls on one plan: exactly one executes, the others get `APPLY_IN_PROGRESS`.
- MCP server validates every JSON-RPC message, runs batch entries sequentially and caps message size; malformed input can no longer crash it.
- CLI neutralises control characters, ANSI escapes and bidi overrides in agent-supplied text; `plan()` rejects them in `intent`.
- Canonical hashing rejects values JSON would silently mangle (Map, Set, Date, NaN, Infinity, bigint, sparse arrays), which could hide drift.
- `t.number()` requires finite numbers; object schemas no longer accept inherited names such as `__proto__` as keys.
- Ledger truncation is detected: plans record their last ledger entry, checked by `verifyStore()` and `countersigned ledger verify`. New `ledger head` and `ledger verify --head` for external anchoring.
- FileStore breaks stale locks atomically.
- Second review: `resume()` takes ownership with a compare-and-set (a concurrent resume or a still-running apply stops before its next step), re-checks drift and expiry for steps that never started, plans record their ledger head after every step, an own `__proto__` key is hashed as data, and `t.unknown()` refuses prototype keys.

### Added

- `NotAppliedError`: let `execute()` say "the system refused, nothing happened" so the gate rolls back cleanly instead of reporting an unknown outcome
- `examples/rest`: ETag / If-Match and Idempotency-Key pattern that closes the window between recheck and write, with tests against a real HTTP server
- `SqliteStore` (`countersigned/sqlite`) on Node's built-in `node:sqlite`, safe across processes

## 0.1.0 (2026-11-04)

First release.

- `defineAction` with definition-time checks (reversibility vs compensation, naming, descriptions)
- `Gate.plan / approve / reject / apply / run`
- State drift detection between plan and apply
- Stable per-step idempotency keys, resume after crash without repeating finished steps
- Mandatory `verify()` with evidence in the report
- Saga compensation in reverse order, explicit `unrecoverable` list
- Plan hash pinning, expiry, self-approval refusal
- Policy rules: autoApprove, requireApproval, deny, irreversibleNeedsApproval, tagNeedsApproval, maxEffects, maxAutoSteps
- Hash-chained ledger with `verifyChain`
- `MemoryStore` and cross-process `FileStore`
- Dependency-free MCP server over stdio
- `countersigned` CLI: list, show, approve, reject, ledger, ledger verify
- Fake ERP example, narrated demo, 33 tests
- Repository: CI on 3 OS x 2 Node versions, CodeQL, Dependabot, npm release with provenance, issue and PR templates, Code of Conduct, security policy
