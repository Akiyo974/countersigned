# tollgate

[![ci](https://github.com/Akiyo974/tollgate/actions/workflows/ci.yml/badge.svg)](https://github.com/Akiyo974/tollgate/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg) ![node: >=22.18](https://img.shields.io/badge/node-%3E%3D22.18-339933.svg)

**Terraform-style `plan` / `apply` for AI agent actions.**

Your agent can read anything. When it wants to *change* something, it proposes a plan: the current state is read, business rules are checked, the exact effects are previewed. A human (or a policy) approves that exact plan. Then `apply` re-checks that the world has not moved, executes with idempotency keys, **verifies every step against the real system**, rolls back in reverse if anything fails, and writes it all to a tamper-evident ledger.

Zero dependencies. TypeScript. Speaks MCP out of the box, so it works with Claude, Cursor, VS Code, OpenAI Agents and anything else that talks Model Context Protocol.

```
agent ──plan──▶ observe state · check rules · preview effects · policy decides
                      │
         human approves the exact plan hash (CLI, UI, chat button)   ◀── the agent has no "approve" tool
                      │
agent ──apply─▶ recheck state (drift? refuse) ─▶ execute(idempotencyKey) ─▶ verify against the system
                                                         │ failure
                                                         ▼
                                           compensate earlier steps, in reverse
                      every event ─▶ hash-chained ledger
```

## Why

Agents moved from *answering* to *doing*. Writing to real systems (an ERP, a CRM, a billing API, a database) breaks in ways a better prompt cannot fix:

| What goes wrong | What tollgate does |
| --- | --- |
| The agent acts on state that changed after the human said yes | Snapshot at plan time, re-observe before apply, refuse on drift (`STALE_STATE`) |
| A retry or a crash sends the email twice, books the order twice | Stable idempotency key per step, forwarded to your system; completed steps are never repeated |
| "Done!" says the agent. It was not. | `verify()` is mandatory and re-reads the source of truth; the report carries the evidence |
| Step 3 fails, steps 1 and 2 already changed things | Saga compensation in reverse order; irreversible leftovers are flagged for a human |
| The approved plan is not the plan that runs | Approval is pinned to a SHA-256 of the plan; any edit invalidates it |
| The agent approves itself | Approval lives outside the agent's process and tools; requester cannot approve |
| "What exactly happened at 3am?" | Append-only, hash-chained ledger; `tollgate ledger verify` detects edits and deletions |

Terraform solved this for infrastructure years ago. Nobody had generalized it to the rest of the systems agents now touch.

## See it

```bash
git clone https://github.com/Akiyo974/tollgate && cd tollgate
node examples/erp/demo.ts        # Node >= 22.18, no install needed
```

The demo runs an agent against a deliberately annoying fake ERP: documents locked by users, writes that report success but do not stick, emails that cannot be unsent. Excerpt:

```
5. The ERP says "OK" but the write did not stick: verification catches it, earlier steps are rolled back
    Plan pl_mw2gf0p3b5f8be729d: COMPENSATED
    Step 1 (set_reorder_point) failed: verification failed: ERP shows 3, expected 6.
    Every earlier effect was compensated; the system is back to its approved state.
      0. reschedule_order: compensated
      1. set_reorder_point: failed (verification failed: ERP shows 3, expected 6; compensated)
```

## Define an action

An action is five small functions. Writing them forces the questions that matter *before* the agent runs in production.

```ts
import { defineAction, t } from "tollgate";

export const setReorderPoint = defineAction({
  name: "set_reorder_point",
  description: "Change the reorder point of an inventory item. Reversible.",
  reversibility: "reversible", // read | reversible | compensable | irreversible
  input: t.object({ sku: t.string(), reorderPoint: t.integer({ min: 0 }) }),

  // 1. What state does this depend on? Snapshotted at plan time, re-checked before apply.
  observe: ({ sku }) => erp.getItem(sku),

  // 2. Business rules. Any violation denies the plan before a human is bothered.
  check: (input, item) => (item ? [] : ["item does not exist"]),

  // 3. What will change, in words a human can approve.
  preview: ({ sku, reorderPoint }, item) => [
    { target: `item:${sku}`, op: "update", before: item.reorderPoint, after: reorderPoint },
  ],

  // 4. Do it. Pass the idempotency key downstream.
  execute: ({ sku, reorderPoint }, { idempotencyKey }) => erp.update(sku, { reorderPoint }, idempotencyKey),

  // 5. Prove it. Re-read the system; never trust the return value alone.
  verify: ({ sku, reorderPoint }) => erp.getItem(sku)?.reorderPoint === reorderPoint,

  // The way back. Required for reversible and compensable actions.
  compensate: ({ sku }, _result, { before }) => erp.update(sku, { reorderPoint: before.reorderPoint }),
});
```

`defineAction` refuses, at boot, a writable action without a way back, an irreversible action pretending to have one, or a description too thin for a model to choose correctly.

Already using zod, valibot or ajv? Wrap it with `t.custom(jsonSchema, parse)`.

## Use it from code

```ts
import { FileStore, rules, Tollgate } from "tollgate";

const gate = new Tollgate({
  store: new FileStore(".tollgate"),
  rules: [rules.irreversibleNeedsApproval(), rules.autoApprove("set_reorder_point"), rules.maxEffects(20)],
}).register(setReorderPoint, rescheduleOrder, emailSupplier);

const plan = await gate.plan(steps, { intent: "absorb the supplier delay", requestedBy: "agent-42" });
// plan.status: "approved" (policy allowed) | "pending_approval" | "denied"

await gate.approve(plan.id, { by: "christen" });  // or from the CLI, or your UI
const report = await gate.apply(plan.id);        // safe to call again
```

## Use it as an MCP server

```ts
import { serveStdio } from "tollgate/mcp";
serveStdio(gate, { agentId: "claude-desktop" });
```

The agent sees `tollgate_list_actions`, `tollgate_plan`, `tollgate_get_plan`, `tollgate_apply`, plus every read-only action as a direct tool. It never sees an approve tool. Example config (Claude Desktop, Claude Code, Cursor):

```json
{
  "mcpServers": {
    "erp": { "command": "node", "args": ["/path/to/tollgate/examples/erp/mcp-server.ts"] }
  }
}
```

Then, in another terminal, the human side:

```bash
npx tollgate list                 # what is waiting
npx tollgate show pl_...          # intent, before/after, why it needs you
npx tollgate approve pl_...       # signs this exact plan hash
npx tollgate ledger verify        # chain intact?
```

## Policies

Rules are plain functions `(step, plan) => { decision, reason } | undefined`. Strictest opinion wins and `deny` can never be relaxed. With no rules: reads run, every write waits for a human.

Built in: `autoApprove`, `requireApproval`, `deny`, `irreversibleNeedsApproval`, `tagNeedsApproval`, `maxEffects` (blast radius), `maxAutoSteps`. A custom rule that lets small changes through:

```ts
(step) => step.action === "set_reorder_point" && Math.abs(after - before) <= 2
  ? { decision: "allow", reason: "change of 2 units or less" }
  : undefined
```

## Guarantees, and what is not guaranteed

Honest list, because safety tooling that oversells is worse than none.

- **Drift detection is as good as your `observe()`.** Observe exactly what the action depends on, from the source of truth.
- **The recheck is time-of-check.** A change between the recheck and the write is still possible; pass the idempotency key and use your system's own concurrency control (ETags, row versions) in `execute` to close that window.
- **Compensation is not a transaction.** It is a best effort correction. That is why reversibility is declared per action, and irreversible effects that already happened are reported as `unrecoverable` instead of hidden.
- **If `execute()` throws, the outcome is unknown.** tollgate does not guess: the step is reported for a human, the key lets you look it up.
- **On resume after a crash**, finished steps are skipped and the up-front recheck is not repeated (earlier steps legitimately changed the state).
- **FileStore is single-machine.** Plans and ledger are safe across processes on one host. For several hosts, implement the `Store` interface on your database (six async methods).
- **The ledger is tamper-evident, not tamper-proof.** Anyone who can rewrite the whole file can rewrite the chain. Anchor the latest hash somewhere else (a git commit, a log service) if that matters.

## Status

v0.1, working and tested (33 tests, including a real MCP client loop over stdio). APIs may still move before 1.0.

## Roadmap

- [ ] Python SDK with the same plan format, so one ledger serves both ecosystems
- [ ] Postgres and SQLite stores
- [ ] Approval channels: Slack / Teams buttons, a small web inbox, email links
- [ ] Multi-approver and role-based policies (two signatures over 10 000 $)
- [ ] Adapters: Dynamics 365 Business Central / NAV OData, Odoo, Shopify, Stripe, generic REST with ETags
- [ ] Remote MCP (Streamable HTTP) transport with OAuth
- [ ] OpenTelemetry export of ledger events
- [ ] Ledger anchoring (periodic hash published to git or a transparency log)

## Contributing

Issues, adapters and ideas are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Found a way around a safety guarantee? Please report it privately, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
