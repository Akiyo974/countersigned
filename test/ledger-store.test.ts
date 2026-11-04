import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FakeErp } from "../examples/erp/fake-erp.ts";
import { erpActions } from "../examples/erp/actions.ts";
import { approvePlan, FileStore, MemoryStore, Gate, verifyChain } from "../src/index.ts";

describe("ledger", () => {
  it("records the full story of a plan, hash-chained", async () => {
    const store = new MemoryStore();
    const gate = new Gate({ store }).register(...erpActions(new FakeErp()));
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "x" });
    await gate.approve(plan.id, { by: "alice" });
    await gate.apply(plan.id);
    const types = (await store.readLedger({ planId: plan.id })).map((e) => e.type);
    assert.deepEqual(types, ["plan.created", "plan.approved", "apply.started", "step.intent", "step.succeeded", "apply.finished"]);
    assert.deepEqual(await gate.verifyLedger(), { ok: true, entries: 6 });
  });

  it("detects edited history", async () => {
    const store = new MemoryStore();
    const gate = new Gate({ store }).register(...erpActions(new FakeErp()));
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "x" });
    await gate.approve(plan.id, { by: "alice" });
    (store.rawLedger()[1]!.data as { by: string }).by = "mallory";
    const check = verifyChain(store.rawLedger());
    assert.equal(check.ok, false);
    assert.equal(check.brokenAt, 2);
  });

  it("detects deleted history", async () => {
    const store = new MemoryStore();
    const gate = new Gate({ store }).register(...erpActions(new FakeErp()));
    await gate.plan([{ action: "get_item", input: { sku: "FRIDGE-300" } }], { intent: "x" });
    await gate.plan([{ action: "get_item", input: { sku: "WASH-120" } }], { intent: "y" });
    store.rawLedger().splice(1, 1);
    assert.equal(verifyChain(store.rawLedger()).ok, false);
  });
});

describe("FileStore", () => {
  it("lets a separate process (the human's CLI) approve what the agent planned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "countersigned-"));
    const erp = new FakeErp();
    const agentSide = new Gate({ store: new FileStore(dir) }).register(...erpActions(erp));
    const plan = await agentSide.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "x" });

    await approvePlan(new FileStore(dir), plan.id, { by: "alice" }); // the human, elsewhere

    const report = await agentSide.apply(plan.id);
    assert.equal(report.status, "applied");
    const check = verifyChain(await new FileStore(dir).readLedger());
    assert.equal(check.ok, true);
    assert.ok(check.entries >= 6);
  });

  it("detects a tampered ledger file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "countersigned-"));
    const gate = new Gate({ store: new FileStore(dir) }).register(...erpActions(new FakeErp()));
    await gate.run("get_item", { sku: "FRIDGE-300" });
    const path = join(dir, "ledger.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replace('"plan.approved"', '"plan.rejected"'));
    assert.equal((await gate.verifyLedger()).ok, false);
  });

  it("keeps the chain intact under concurrent appends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "countersigned-"));
    const a = new FileStore(dir);
    const b = new FileStore(dir);
    await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).appendLedger({ type: "plan.created", planId: `pl_${i}` })));
    const check = verifyChain(await a.readLedger());
    assert.deepEqual(check, { ok: true, entries: 40 });
  });
});
