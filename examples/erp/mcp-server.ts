/**
 * A real MCP server over the fake ERP. Point Claude Desktop, Claude Code, Cursor... at it:
 *
 *   node examples/erp/mcp-server.ts
 *
 * State lives in ./.tollgate (plans + ledger) and ./.tollgate/erp.json (the fake ERP),
 * so you can approve from another terminal with:  node src/cli.ts approve <planId>
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FileStore, rules, Tollgate } from "../../src/index.ts";
import { serveStdio } from "../../src/mcp.ts";
import { erpActions } from "./actions.ts";
import { FakeErp } from "./fake-erp.ts";

const dir = process.env.TOLLGATE_DIR ?? ".tollgate";
mkdirSync(dir, { recursive: true });
const erp = new FakeErp({ file: join(dir, "erp.json") });

const gate = new Tollgate({
  store: new FileStore(dir),
  rules: [
    rules.irreversibleNeedsApproval(),
    rules.tagNeedsApproval(["customer-facing"]),
    // Small inventory tweaks are routine: let them through, still verified and ledgered.
    (step) => {
      if (step.action !== "set_reorder_point") return undefined;
      const e = step.effects[0];
      const before = (e?.before as { reorderPoint?: number } | undefined)?.reorderPoint ?? 0;
      const after = (e?.after as { reorderPoint?: number } | undefined)?.reorderPoint ?? 0;
      return Math.abs(after - before) <= 2 ? { decision: "allow", reason: "change of 2 units or less" } : undefined;
    },
  ],
}).register(...erpActions(erp));

serveStdio(gate, {
  name: "tollgate-erp-demo",
  agentId: "mcp-agent",
  approveHint: (id) => `node src/cli.ts approve ${id}`,
});
