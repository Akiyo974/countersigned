# Contributing

Thanks for looking. countersigned is small on purpose; contributions that keep it that way are the most welcome. By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Node 22.18+ runs TypeScript directly, so there is nothing to build to hack on it:

```bash
npm install          # only typescript and @types/node, for type checking
npm test             # node --test
npm run typecheck
npm run demo
```

## Ground rules

- **Zero runtime dependencies** in the core. Adapters can live in separate packages.
- **Erasable TypeScript only** (no enums, namespaces or parameter properties) so Node can run the sources as is.
- **Every refusal is a `GateError` with a stable code** and a message written for the model reading it: say what happened and what to do next.
- **Safety behaviour needs a test that fails without it.** If you change apply, recheck, compensation or the ledger, add the scenario to `test/gate.test.ts`.
- Prefer refusing over guessing. If an outcome is unknown, report it.

## Good first contributions

- A `Store` for SQLite (`node:sqlite`) or Postgres
- An adapter for a system you know (Business Central OData, Odoo XML-RPC, Shopify, Stripe)
- An approval channel (Slack interactive message, small web inbox)
- More policy rules (time windows, per-tag quotas, two-person rule)

## Reporting a security issue

See [SECURITY.md](SECURITY.md). Please do not open a public issue for a bypass.
