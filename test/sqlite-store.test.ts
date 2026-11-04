import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FakeErp } from "../examples/erp/fake-erp.ts";
import { erpActions } from "../examples/erp/actions.ts";
import { approvePlan, Gate, verifyChain } from "../src/index.ts";
import { SqliteStore } from "../src/sqlite-store.ts";

const tmpDb = () => join(mkdtempSync(join(tmpdir(), "countersigned-sqlite-")), "test.db");

describe("SqliteStore", () => {
  it("runs the full plan / approve / apply cycle, with a separate connection approving", async () => {
    const path = tmpDb();
    const erp = new FakeErp();
    const gate = new Gate({ store: new SqliteStore(path) }).register(...erpActions(erp));
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "x" });
    assert.equal((await gate.store.listPlans({ status: "pending_approval" })).length, 1);

    await approvePlan(new SqliteStore(path), plan.id, { by: "alice" });

    const report = await gate.apply(plan.id);
    assert.equal(report.status, "applied");
    assert.equal(erp.getItem("FRIDGE-300")!.reorderPoint, 6);
    assert.equal((await gate.verifyLedger()).ok, true);
  });

  it("detects a ledger row edited directly in the database", async () => {
    const path = tmpDb();
    const store = new SqliteStore(path);
    const gate = new Gate({ store }).register(...erpActions(new FakeErp()));
    await gate.run("get_item", { sku: "WASH-120" });
    store.db.exec(`UPDATE ledger SET data = replace(data, '"plan.approved"', '"plan.rejected"') WHERE seq = 2`);
    assert.equal((await gate.verifyLedger()).ok, false);
  });

  it("keeps the chain intact when several processes append at once", async () => {
    const path = tmpDb();
    const worker = join(mkdtempSync(join(tmpdir(), "countersigned-worker-")), "worker.ts");
    writeFileSync(
      worker,
      `import { SqliteStore } from ${JSON.stringify(new URL("../src/sqlite-store.ts", import.meta.url).href)};
       const s = new SqliteStore(process.argv[2]);
       for (let i = 0; i < 25; i++) await s.appendLedger({ type: "plan.created", planId: "pl_w" + process.argv[3] + "x" + i });
       s.close();`,
    );
    await Promise.all(
      [1, 2, 3, 4].map(
        (n) =>
          new Promise<void>((resolve, reject) => {
            const p = fork(worker, [path, String(n)], { execArgv: ["--no-warnings"] });
            p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${n} exited ${code}`))));
          }),
      ),
    );
    const check = verifyChain(await new SqliteStore(path).readLedger());
    assert.deepEqual(check, { ok: true, entries: 100 });
  });
});
