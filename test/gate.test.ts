import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeErp } from "../examples/erp/fake-erp.ts";
import { erpActions } from "../examples/erp/actions.ts";
import { defineAction, MemoryStore, rules, t, Gate, GateError } from "../src/index.ts";

function setup(opts: { rules?: Parameters<typeof rules.autoApprove>[0] extends never ? never : ReturnType<typeof rules.autoApprove>[]; now?: () => Date } = {}) {
  const erp = new FakeErp();
  const store = new MemoryStore();
  const gate = new Gate({ store, rules: opts.rules, clock: opts.now }).register(...erpActions(erp));
  return { erp, store, gate };
}

const code = (c: string) => (e: unknown) => e instanceof GateError && e.code === c;

describe("plan", () => {
  it("previews effects without changing anything", async () => {
    const { erp, gate } = setup();
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "raise safety stock" });
    assert.equal(plan.status, "pending_approval");
    assert.equal(plan.steps[0]!.effects[0]!.summary, "reorder point of FRIDGE-300: 3 -> 6");
    assert.equal(erp.getItem("FRIDGE-300")!.reorderPoint, 3);
  });

  it("auto-approves reads by default", async () => {
    const { gate } = setup();
    const plan = await gate.plan([{ action: "get_item", input: { sku: "WASH-120" } }], { intent: "check stock" });
    assert.equal(plan.status, "approved");
    assert.equal(plan.approval?.automatic, true);
  });

  it("reports every invalid step at once", async () => {
    const { gate } = setup();
    await assert.rejects(
      gate.plan(
        [
          { action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: -1, extra: true } },
          { action: "launch_rockets", input: {} },
        ],
        { intent: "x" },
      ),
      (e: unknown) => {
        assert.ok(e instanceof GateError && e.code === "INVALID_INPUT");
        assert.match(e.message, /step 0.*reorderPoint must be >= 0/s);
        assert.match(e.message, /extra unknown property/);
        assert.match(e.message, /step 1.*Unknown action "launch_rockets"/s);
        return true;
      },
    );
  });

  it("denies plans whose preconditions fail, before any human is bothered", async () => {
    const { gate } = setup();
    const plan = await gate.plan([{ action: "reschedule_order", input: { orderNo: "SO-1002", shipmentDate: "2026-11-20", reason: "supplier delay" } }], {
      intent: "push order",
    });
    assert.equal(plan.status, "denied");
    assert.match(plan.reasons.join(), /open in the ERP by user JDOE/);
    await assert.rejects(gate.apply(plan.id), code("PLAN_DENIED"));
  });

  it("policy rules: strictest wins and deny cannot be relaxed", async () => {
    const { gate } = setup({ rules: [rules.autoApprove("email_supplier"), rules.deny("email_supplier", "no emails on Fridays")] });
    const plan = await gate.plan([{ action: "email_supplier", input: { to: "a@b.co", subject: "hello", body: "hello there, friend" } }], { intent: "x" });
    assert.equal(plan.status, "denied");
    assert.deepEqual(plan.reasons, ["step 0 email_supplier: no emails on Fridays"]);
  });
});

describe("approval", () => {
  it("cannot apply before a human approves", async () => {
    const { gate } = setup();
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "x" });
    await assert.rejects(gate.apply(plan.id), (e: unknown) => code("NOT_APPROVED")(e) && /countersigned approve/.test((e as Error).message));
  });

  it("the requester cannot approve its own plan", async () => {
    const { gate } = setup();
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "x", requestedBy: "agent-7" });
    await assert.rejects(gate.approve(plan.id, { by: "agent-7" }), code("SELF_APPROVAL"));
  });

  it("refuses a plan edited after creation", async () => {
    const { gate, store } = setup();
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "x" });
    await store.updatePlan(plan.id, (p) => {
      (p.steps[0]!.input as { reorderPoint: number }).reorderPoint = 9999;
      return p;
    });
    await assert.rejects(gate.approve(plan.id, { by: "alice" }), code("TAMPERED"));
  });

  it("refuses a plan edited after approval", async () => {
    const { gate, store } = setup();
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "x" });
    await gate.approve(plan.id, { by: "alice" });
    await store.updatePlan(plan.id, (p) => ({ ...p, intent: "something else entirely" }));
    await assert.rejects(gate.apply(plan.id), code("TAMPERED"));
  });

  it("approvals expire", async () => {
    let now = new Date("2026-11-04T10:00:00Z");
    const { gate } = setup({ now: () => now });
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "x" });
    now = new Date("2026-11-04T10:20:00Z");
    await assert.rejects(gate.approve(plan.id, { by: "alice" }), code("EXPIRED"));
    assert.equal((await gate.get(plan.id)).status, "expired");
  });

  it("rejection is final", async () => {
    const { gate } = setup();
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "x" });
    await gate.reject(plan.id, { by: "alice", reason: "wrong item" });
    await assert.rejects(gate.apply(plan.id), (e: unknown) => code("NOT_APPROVED")(e) && /wrong item/.test((e as Error).message));
    await assert.rejects(gate.approve(plan.id, { by: "bob" }), code("ALREADY_DECIDED"));
  });
});

describe("apply", () => {
  it("executes, verifies against the system and returns evidence", async () => {
    const { erp, gate } = setup();
    const plan = await gate.plan(
      [
        { action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } },
        { action: "reschedule_order", input: { orderNo: "SO-1001", shipmentDate: "2026-11-14", reason: "supplier delay" } },
      ],
      { intent: "absorb supplier delay" },
    );
    await gate.approve(plan.id, { by: "alice" });
    const report = await gate.apply(plan.id);
    assert.equal(report.status, "applied");
    assert.deepEqual(report.steps[0]!.evidence, { reorderPoint: 6 });
    assert.equal(erp.getOrder("SO-1001")!.shipmentDate, "2026-11-14");
  });

  it("refuses when the world changed between approval and apply (TOCTOU)", async () => {
    const { erp, gate } = setup();
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "x" });
    await gate.approve(plan.id, { by: "alice" });
    erp.setReorderPoint("FRIDGE-300", 4); // a buyer edits the item in the ERP meanwhile
    await assert.rejects(gate.apply(plan.id), (e: unknown) => {
      assert.ok(code("STALE_STATE")(e));
      const d = (e as GateError).details as { approved: unknown; current: unknown }[];
      assert.deepEqual(d[0]!.current, { exists: true, reorderPoint: 4, onHand: 4 });
      return true;
    });
    assert.equal(erp.getItem("FRIDGE-300")!.reorderPoint, 4, "nothing was written");
    assert.equal((await gate.get(plan.id)).status, "stale");
  });

  it("refuses when a precondition broke after approval", async () => {
    const { erp, gate } = setup();
    const plan = await gate.plan([{ action: "reschedule_order", input: { orderNo: "SO-1001", shipmentDate: "2026-11-14", reason: "supplier delay" } }], {
      intent: "x",
    });
    await gate.approve(plan.id, { by: "alice" });
    erp.lock("SO-1001", "MTREMBLAY");
    await assert.rejects(gate.apply(plan.id), code("STALE_STATE"));
  });

  it("is idempotent: applying twice does not act twice", async () => {
    const { erp, gate } = setup();
    const plan = await gate.plan([{ action: "email_supplier", input: { to: "po@acme.co", subject: "PO 4471", body: "Please confirm delivery." } }], {
      intent: "x",
    });
    await gate.approve(plan.id, { by: "alice" });
    const a = await gate.apply(plan.id);
    const b = await gate.apply(plan.id);
    assert.deepEqual(a, b);
    assert.equal(erp.data.outbox.length, 1);
  });

  it("resumes after a crash without redoing finished steps", async () => {
    const { erp, gate, store } = setup();
    const plan = await gate.plan(
      [
        { action: "email_supplier", input: { to: "po@acme.co", subject: "PO 4471", body: "Please confirm delivery." } },
        { action: "set_reorder_point", input: { sku: "WASH-120", reorderPoint: 8 } },
      ],
      { intent: "x" },
    );
    await gate.approve(plan.id, { by: "alice" });
    // Simulate a crash right after step 0 succeeded: the ledger has it, the plan says "applying".
    const actions = erpActions(erp);
    await store.updatePlan(plan.id, (p) => ({ ...p, status: "applying" }));
    const key = (await import("../src/hash.ts")).sha256(`${plan.hash}:0`).slice(0, 32);
    const sent = await actions[3]!.execute(plan.steps[0]!.input, { planId: plan.id, step: 0, idempotencyKey: `cs_${key}`, before: null });
    await store.appendLedger({ type: "step.succeeded", planId: plan.id, step: 0, key: `cs_${key}`, data: { result: sent } });

    const report = await gate.apply(plan.id);
    assert.equal(report.status, "applied");
    assert.equal(report.steps[0]!.status, "skipped_already_done");
    assert.equal(erp.data.outbox.length, 1);
    assert.equal(erp.getItem("WASH-120")!.reorderPoint, 8);
  });

  it("catches a write that reported success but did not happen, and rolls back earlier steps", async () => {
    const { erp, gate } = setup();
    const plan = await gate.plan(
      [
        { action: "reschedule_order", input: { orderNo: "SO-1001", shipmentDate: "2026-11-14", reason: "supplier delay" } },
        { action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } },
      ],
      { intent: "x" },
    );
    await gate.approve(plan.id, { by: "alice" });
    erp.dropNextWriteFor = "FRIDGE-300";
    const report = await gate.apply(plan.id);
    assert.equal(report.status, "compensated");
    assert.match(report.steps[1]!.error!, /verification failed: ERP shows 3, expected 6/);
    assert.equal(report.steps[0]!.status, "compensated");
    assert.equal(erp.getOrder("SO-1001")!.shipmentDate, "2026-11-10", "order date restored");
  });

  it("flags irreversible effects that cannot be compensated", async () => {
    const { erp, gate } = setup();
    const plan = await gate.plan(
      [
        { action: "email_supplier", input: { to: "po@acme.co", subject: "PO 4471", body: "Please confirm delivery." } },
        { action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } },
      ],
      { intent: "x" },
    );
    await gate.approve(plan.id, { by: "alice" });
    erp.dropNextWriteFor = "FRIDGE-300";
    const report = await gate.apply(plan.id);
    assert.equal(report.status, "failed");
    assert.deepEqual(
      report.unrecoverable.map((u) => u.action),
      ["email_supplier"],
    );
  });

  it("an execute() that throws leaves the step in doubt and compensates the rest", async () => {
    const { erp, gate } = setup();
    const plan = await gate.plan(
      [
        { action: "set_reorder_point", input: { sku: "WASH-120", reorderPoint: 9 } },
        { action: "reschedule_order", input: { orderNo: "SO-1001", shipmentDate: "2026-11-14", reason: "supplier delay" } },
      ],
      { intent: "x" },
    );
    await gate.approve(plan.id, { by: "alice" });
    // Locking right before execution is invisible to the recheck if it happens after it: simulate with a one-shot lock.
    const orig = erp.setShipmentDate.bind(erp);
    erp.setShipmentDate = () => {
      erp.setShipmentDate = orig;
      throw new Error("ERP timeout");
    };
    const report = await gate.apply(plan.id);
    assert.equal(report.status, "failed");
    assert.equal(report.steps[0]!.status, "compensated");
    assert.equal(erp.getItem("WASH-120")!.reorderPoint, 5);
    assert.match(report.unrecoverable[0]!.reason, /effect is unknown/);
  });
});

describe("run()", () => {
  it("returns data for allowed actions and refuses the rest", async () => {
    const { gate } = setup();
    const item = (await gate.run("get_item", { sku: "WASH-120" })) as { onHand: number };
    assert.equal(item.onHand, 11);
    await assert.rejects(gate.run("set_reorder_point", { sku: "WASH-120", reorderPoint: 9 }), code("NOT_APPROVED"));
  });
});

describe("defineAction", () => {
  it("refuses a writable action without a way back", () => {
    assert.throws(
      () =>
        defineAction({
          name: "delete_customer",
          description: "Deletes a customer record.",
          reversibility: "reversible",
          input: t.object({}),
          observe: () => null,
          preview: () => [],
          execute: () => null,
          verify: () => true,
        }),
      code("INVALID_DEFINITION"),
    );
  });
});
