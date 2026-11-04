# Changelog

## 0.1.0 (2026-11-04)

First release.

- `defineAction` with definition-time checks (reversibility vs compensation, naming, descriptions)
- `Tollgate.plan / approve / reject / apply / run`
- State drift detection between plan and apply
- Stable per-step idempotency keys, resume after crash without repeating finished steps
- Mandatory `verify()` with evidence in the report
- Saga compensation in reverse order, explicit `unrecoverable` list
- Plan hash pinning, expiry, self-approval refusal
- Policy rules: autoApprove, requireApproval, deny, irreversibleNeedsApproval, tagNeedsApproval, maxEffects, maxAutoSteps
- Hash-chained ledger with `verifyChain`
- `MemoryStore` and cross-process `FileStore`
- Dependency-free MCP server over stdio
- `tollgate` CLI: list, show, approve, reject, ledger, ledger verify
- Fake ERP example, narrated demo, 33 tests
- Repository: CI on 3 OS x 2 Node versions, CodeQL, Dependabot, npm release with provenance, issue and PR templates, Code of Conduct, security policy
