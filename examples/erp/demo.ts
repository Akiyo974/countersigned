/**
 * Five ways an agent breaks a business system, and what the gate does about each.
 *
 *   node examples/erp/demo.ts
 */
import { MemoryStore, rules, Tollgate, TollgateError } from "../../src/index.ts";
import { describePlan, describeReport } from "../../src/mcp.ts";
import { erpActions } from "./actions.ts";
import { FakeErp } from "./fake-erp.ts";

const tty = process.stdout.isTTY;
const c = (n: number) => (s: string) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const [bold, dim, green, red, cyan] = [c(1), c(2), c(32), c(31), c(36)];
const hint = (id: string) => `tollgate approve ${id}`;
const indent = (s: string) => s.replace(/^/gm, "    ");

function fresh() {
  const erp = new FakeErp();
  const gate = new Tollgate({ store: new MemoryStore(), rules: [rules.irreversibleNeedsApproval()] }).register(...erpActions(erp));
  return { erp, gate };
}

function title(n: number, s: string) {
  console.log(`\n${bold(cyan(`${n}. ${s}`))}`);
}

async function expectRefusal(p: Promise<unknown>) {
  try {
    await p;
    console.log(red("    (no refusal?!)"));
  } catch (e) {
    if (!(e instanceof TollgateError)) throw e;
    console.log(red(indent(`[${e.code}] ${e.message}`)));
  }
}

console.log(bold("tollgate demo: an agent working on a (fake) ERP"));

{
  title(1, "The happy path: plan, a human approves the exact effects, apply verifies against the ERP");
  const { erp, gate } = fresh();
  const plan = await gate.plan(
    [
      { action: "reschedule_order", input: { orderNo: "SO-1001", shipmentDate: "2026-11-14", reason: "supplier is 4 days late" } },
      { action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } },
      { action: "email_supplier", input: { to: "po@acme.co", subject: "PO 4471 delay", body: "Confirming new delivery date: Nov 13." } },
    ],
    { intent: "Absorb the ACME delay without breaking customer promises", requestedBy: "agent" },
  );
  console.log(dim(indent(describePlan(plan, hint))));
  await gate.approve(plan.id, { by: "christen", note: "ok, warned the customer" });
  console.log(green(indent(describeReport(await gate.apply(plan.id)))));
  console.log(dim(`    ERP now: SO-1001 ships ${erp.getOrder("SO-1001")!.shipmentDate}, outbox has ${erp.data.outbox.length} email`));

  title(2, "The agent retries (timeout, crash, confused model): nothing happens twice");
  const again = await gate.apply(plan.id);
  console.log(green(`    status ${again.status}, outbox still has ${erp.data.outbox.length} email`));
}

{
  title(3, "A human edits the ERP between approval and apply (time-of-check vs time-of-use)");
  const { erp, gate } = fresh();
  const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "raise safety stock" });
  await gate.approve(plan.id, { by: "christen" });
  erp.setReorderPoint("FRIDGE-300", 5);
  console.log(dim("    (a buyer sets the reorder point to 5 in the ERP client)"));
  await expectRefusal(gate.apply(plan.id));
  console.log(dim(`    ERP keeps the buyer's value: ${erp.getItem("FRIDGE-300")!.reorderPoint}`));
}

{
  title(4, "The agent wants to touch a document someone has open: blocked at plan time");
  const { gate } = fresh();
  const plan = await gate.plan([{ action: "reschedule_order", input: { orderNo: "SO-1002", shipmentDate: "2026-11-20", reason: "batch with next truck" } }], {
    intent: "consolidate shipments",
  });
  console.log(red(indent(describePlan(plan, hint))));
}

{
  title(5, 'The ERP says "OK" but the write did not stick: verification catches it, earlier steps are rolled back');
  const { erp, gate } = fresh();
  const plan = await gate.plan(
    [
      { action: "reschedule_order", input: { orderNo: "SO-1001", shipmentDate: "2026-11-14", reason: "supplier is 4 days late" } },
      { action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } },
    ],
    { intent: "absorb delay" },
  );
  await gate.approve(plan.id, { by: "christen" });
  erp.dropNextWriteFor = "FRIDGE-300";
  console.log(red(indent(describeReport(await gate.apply(plan.id)))));
  console.log(dim(`    ERP: SO-1001 back to ${erp.getOrder("SO-1001")!.shipmentDate}, reorder point still ${erp.getItem("FRIDGE-300")!.reorderPoint}`));

  title(6, "Every step is in a hash-chained ledger");
  const entries = await gate.store.readLedger();
  for (const e of entries.slice(-6)) console.log(dim(`    #${e.seq} ${e.type}${e.step !== undefined ? ` step ${e.step}` : ""}  ${e.hash.slice(0, 12)}`));
  const check = await gate.verifyLedger();
  console.log(green(`    chain verified: ${check.ok}, ${check.entries} entries`));
}

console.log();
