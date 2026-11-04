# Security policy

## Supported versions

While the project is below 1.0, only the latest minor release receives fixes.

## Reporting a vulnerability

tollgate is a safety layer, so a bypass is a serious bug. Examples of what counts:

- applying a plan that was not approved, or that differs from the approved hash
- an agent obtaining approval through the MCP server, or approving its own plan
- a step executing twice for the same plan
- a ledger edit that `verifyChain` does not detect
- apply proceeding despite observed drift or broken preconditions
- path traversal or injection through plan ids, action input or MCP messages

**Do not open a public issue.** Report privately at
<https://github.com/Akiyo974/tollgate/security/advisories/new>
(Security tab, "Report a vulnerability").

What to expect:

- acknowledgement within 72 hours;
- an assessment and a fix plan within 7 days;
- a coordinated release and a published advisory, with credit unless you prefer otherwise.

## Threat model

- **Untrusted:** the agent and everything it sends (tool arguments, plan content, retries).
- **Trusted:** the operator, the host running the store, and the code of registered actions.
- Out of scope: an attacker who already controls the host or can write the store directly. The ledger is tamper-evident, not tamper-proof; see the README for anchoring.

## Hardening checklist for deployments

- Run the MCP server with credentials scoped to the actions you registered, nothing more.
- Keep the store directory out of the agent's reach (a coding agent with shell access must not be able to write `.tollgate/`).
- Use `rules.irreversibleNeedsApproval()` and `rules.maxEffects()` in production.
- Forward idempotency keys to downstream systems and use their concurrency control (ETags, row versions) in `execute()`.
