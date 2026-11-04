import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { InventoryApi } from "../examples/rest/inventory-api.ts";
import { restActions } from "../examples/rest/actions.ts";
import { MemoryStore, Gate } from "../src/index.ts";

describe("REST adapter with ETags and Idempotency-Key", () => {
  const api = new InventoryApi([
    { sku: "FRIDGE-300", price: 1299 },
    { sku: "WASH-120", price: 899 },
  ]);
  let gate: Gate;

  before(async () => {
    const url = await api.start();
    gate = new Gate({ store: new MemoryStore() }).register(...restActions(url));
  });
  after(() => api.stop());

  it("applies and verifies through the API", async () => {
    const plan = await gate.plan([{ action: "set_price", input: { sku: "FRIDGE-300", price: 1199 } }], { intent: "promo" });
    await gate.approve(plan.id, { by: "alice" });
    const report = await gate.apply(plan.id);
    assert.equal(report.status, "applied");
    assert.equal(api.items.get("FRIDGE-300")!.price, 1199);
  });

  it("closes the window between recheck and write: a last-instant edit is refused by the server, cleanly", async () => {
    const plan = await gate.plan(
      [
        { action: "set_price", input: { sku: "FRIDGE-300", price: 1099 } },
        { action: "set_price", input: { sku: "WASH-120", price: 849 } },
      ],
      { intent: "promo" },
    );
    await gate.approve(plan.id, { by: "alice" });
    // Step 0 goes through. Right before step 1 is written, a human edits WASH-120 elsewhere.
    let writes = 0;
    const realHook = () => {
      writes += 1;
      if (writes === 2) api.edit("WASH-120", 999);
      else api.beforeNextWrite = realHook;
    };
    api.beforeNextWrite = realHook;

    const report = await gate.apply(plan.id);
    assert.equal(report.status, "compensated", report.message);
    assert.deepEqual(report.unrecoverable, [], "a 412 means nothing happened: nothing for a human to chase");
    assert.match(report.steps[1]!.error!, /not applied: WASH-120 changed after approval \(412/);
    assert.equal(api.items.get("WASH-120")!.price, 999, "the human's edit is kept");
    assert.equal(api.items.get("FRIDGE-300")!.price, 1199, "step 0 was rolled back");
  });

  it("a rollback never overwrites a newer human edit", async () => {
    const plan = await gate.plan(
      [
        { action: "set_price", input: { sku: "FRIDGE-300", price: 1049 } },
        { action: "set_price", input: { sku: "WASH-120", price: 799 } },
      ],
      { intent: "promo" },
    );
    await gate.approve(plan.id, { by: "alice" });
    let n = 0;
    const hook = () => {
      n += 1;
      if (n === 2) {
        api.edit("FRIDGE-300", 1500); // someone edits step 0's item...
        api.edit("WASH-120", 777); // ...and step 1's item, so step 1 fails
      } else api.beforeNextWrite = hook;
    };
    api.beforeNextWrite = hook;
    const report = await gate.apply(plan.id);
    assert.equal(report.status, "failed");
    assert.equal(report.steps[0]!.status, "compensation_failed");
    assert.equal(api.items.get("FRIDGE-300")!.price, 1500, "the newer edit survives");
    assert.equal(report.unrecoverable.length, 1, "and a human is told");
  });

  it("Idempotency-Key makes a replayed request a no-op", async () => {
    const res = async () =>
      fetch(`${api.url}/items/WASH-120`, {
        method: "PATCH",
        headers: { "if-match": `"v${api.items.get("WASH-120")!.version}"`, "idempotency-key": "cs_same", "content-type": "application/json" },
        body: JSON.stringify({ price: 700 }),
      });
    const before = api.writes;
    const first = await res();
    const second = await res();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(api.writes, before + 1);
  });
});
