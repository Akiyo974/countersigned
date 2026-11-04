/**
 * A scripted "agent" for the README demo. Each command is one thing an agent would do;
 * the human side uses the real CLI against the same store.
 *
 *   node examples/erp/agent.ts plan      propose a plan (nothing changes)
 *   node examples/erp/agent.ts apply     apply the last plan
 *   node examples/erp/agent.ts flaky     a plan where the ERP silently drops a write
 *
 * State lives in $COUNTERSIGNED_DIR (default ./.countersigned).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileStore, rules, Gate, GateError } from "../../src/index.ts";
import { describePlan, describeReport } from "../../src/mcp.ts";
import { erpActions } from "./actions.ts";
import { FakeErp } from "./fake-erp.ts";

const color = process.stdout.isTTY || !!process.env.FORCE_COLOR;
const c = (n: number) => (s: string) => (color ? `\x1b[${n}m${s}\x1b[0m` : s);
const [bold, dim, red, green, yellow] = [c(1), c(2), c(31), c(32), c(33)];

const dir = process.env.COUNTERSIGNED_DIR ?? ".countersigned";
mkdirSync(dir, { recursive: true });
const erp = new FakeErp({ file: join(dir, "erp.json") });
const gate = new Gate({ store: new FileStore(dir), rules: [rules.irreversibleNeedsApproval()] }).register(...erpActions(erp));
const lastFile = join(dir, "last-plan");
const hint = (id: string) => `countersigned approve ${id}`;

function paintPlan(text: string): string {
  return text
    .split("\n")
    .map((l) =>
      /PENDING_APPROVAL/.test(l) ? yellow(bold(l))
      : /^Plan .*: (APPLIED)/.test(l) ? green(bold(l))
      : /^Plan .*: COMPENSATED/.test(l) ? yellow(bold(l))
      : /^Plan .*: (FAILED|DENIED)/.test(l) ? red(bold(l))
      : /irreversible/.test(l) ? red(l)
      : /succeeded|All .* verified/.test(l) ? green(l)
      : /failed|compensated|NEEDS A HUMAN/.test(l) ? yellow(l)
      : /^ {7}/.test(l) ? l
      : /^(Intent|A human|Approval expires|Allowed)/.test(l) ? dim(l)
      : l,
    )
    .join("\n");
}

async function main(cmd: string | undefined): Promise<void> {
  switch (cmd) {
    case "plan": {
      const plan = await gate.plan(
        [
          { action: "reschedule_order", input: { orderNo: "SO-1001", shipmentDate: "2026-11-14", reason: "supplier 4 days late" } },
          { action: "email_supplier", input: { to: "po@acme.co", subject: "PO 4471 delay", body: "Confirming the new delivery date: Nov 13." } },
        ],
        { intent: "Absorb the ACME delay", requestedBy: "agent" },
      );
      writeFileSync(lastFile, plan.id);
      console.log(paintPlan(describePlan(plan, hint).replace(/\nApproval expires.*/, "")));
      return;
    }
    case "flaky": {
      const plan = await gate.plan(
        [
          { action: "reschedule_order", input: { orderNo: "SO-1001", shipmentDate: "2026-11-17", reason: "carrier strike" } },
          { action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } },
        ],
        { intent: "Carrier strike: push the order, raise safety stock", requestedBy: "agent" },
      );
      await gate.approve(plan.id, { by: "christen" });
      erp.dropNextWriteFor = "FRIDGE-300"; // the ERP will answer OK and do nothing
      console.log(dim("(plan approved; the ERP will silently drop the reorder point write)"));
      console.log(paintPlan(describeReport(await gate.apply(plan.id))));
      console.log(dim(`ERP: SO-1001 ships ${erp.getOrder("SO-1001")!.shipmentDate}, reorder point ${erp.getItem("FRIDGE-300")!.reorderPoint}`));
      return;
    }
    case "apply": {
      if (!existsSync(lastFile)) throw new Error("no plan yet: run `plan` first");
      const report = await gate.apply(readFileSync(lastFile, "utf8").trim());
      console.log(paintPlan(describeReport(report)));
      console.log(dim(`ERP outbox: ${erp.data.outbox.length} email`));
      return;
    }
    default:
      console.log("usage: agent.ts plan | apply | flaky");
  }
}

main(process.argv[2]).catch((e) => {
  console.log(red(e instanceof GateError ? `[${e.code}] ${e.message}` : String(e)));
  process.exitCode = 1;
});
