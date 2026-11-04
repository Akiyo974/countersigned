/**
 * Regression tests for the findings of the pre-launch security review.
 * Each test names the guarantee it protects.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it } from "node:test";
import { FakeErp } from "../examples/erp/fake-erp.ts";
import { erpActions } from "../examples/erp/actions.ts";
import { approvePlan, canonicalJson, FileStore, Gate, MemoryStore, t, verifyStore } from "../src/index.ts";
import { safe } from "../src/sanitize.ts";

describe("canonical hashing refuses values JSON would silently mangle (drift detection)", () => {
  for (const [name, value] of [
    ["Map", new Map([["a", 1]])],
    ["Set", new Set([1])],
    ["Date", new Date(0)],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["sparse array", [, 1]], // eslint-disable-line no-sparse-arrays
    ["undefined in array", [undefined]],
    ["class instance", new (class Foo {})()],
  ] as const) {
    it(`rejects ${name}`, () => assert.throws(() => canonicalJson({ x: value }), TypeError));
  }
  it("still treats -0 and 0 as the same JSON number", () => assert.equal(canonicalJson(-0), canonicalJson(0)));
});

describe("schema", () => {
  it("rejects non-finite numbers", () => assert.throws(() => t.number().parse(Number.POSITIVE_INFINITY), /finite/));
  it("rejects inherited names as unknown keys", () => {
    const s = t.object({ a: t.string() });
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      assert.throws(() => s.parse(JSON.parse(`{"a":"x",${JSON.stringify(key)}:1}`)), /unknown property/, key);
    }
  });
});

describe("ledger truncation (tamper evidence)", () => {
  it("detects entries cut from the end of the ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "countersigned-sec-"));
    const store = new FileStore(dir);
    const gate = new Gate({ store }).register(...erpActions(new FakeErp()));
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } }], { intent: "x" });
    await gate.approve(plan.id, { by: "alice" });
    await gate.apply(plan.id);
    assert.equal((await gate.verifyLedger()).ok, true);

    const path = join(dir, "ledger.jsonl");
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    writeFileSync(path, `${lines.slice(0, -4).join("\n")}\n`); // drop the last 4 entries: the chain alone stays valid

    const check = await verifyStore(store);
    assert.equal(check.ok, false);
    assert.match(check.reason!, /truncated or rewritten/);
  });

  it("detects truncation against an external anchor", async () => {
    const store = new MemoryStore();
    const gate = new Gate({ store }).register(...erpActions(new FakeErp()));
    await gate.run("get_item", { sku: "WASH-120" });
    const head = (await store.readLedger()).at(-1)!;
    store.rawLedger().pop();
    assert.equal((await verifyStore(store, { seq: head.seq, hash: head.hash })).ok, false);
  });
});

describe("CLI output sanitizing (what the human approves is what they see)", () => {
  it("neutralises escapes, bidi overrides and newlines", () => {
    const out = safe("ok\u001b[8mhidden\u001b[0m\n  0. email [read]‮gnp.exe");
    assert.ok(!/[\u001b‮\n]/.test(out));
    assert.match(out, /⏎/);
  });
});

describe("MCP server survives malformed JSON-RPC (an agent cannot crash it mid-apply)", () => {
  it("answers bad requests and keeps serving", async () => {
    const dir = mkdtempSync(join(tmpdir(), "countersigned-mcp-sec-"));
    const child = spawn(process.execPath, ["examples/erp/mcp-server.ts"], { env: { ...process.env, COUNTERSIGNED_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] });
    const lines: string[] = [];
    const rl = createInterface({ input: child.stdout });
    const next = () =>
      new Promise<unknown>((resolve) => {
        const take = () => (lines.length ? resolve(JSON.parse(lines.shift()!)) : rl.once("line", (l) => (lines.push(l), take())));
        take();
      });
    const send = (x: unknown) => child.stdin.write(`${typeof x === "string" ? x : JSON.stringify(x)}\n`);
    try {
      send([{ jsonrpc: "2.0", id: 1, method: "ping" }, null, 42, { id: 2 }]);
      const batch = (await next()) as { id: unknown; error?: { code: number } }[];
      assert.equal(batch.length, 4);
      assert.deepEqual(
        batch.map((b) => b.error?.code ?? "ok"),
        ["ok", -32600, -32600, -32600],
      );
      send([]);
      assert.equal(((await next()) as { error: { code: number } }).error.code, -32600);
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "countersigned_plan", arguments: { intent: "x", steps: [null] } } });
      const bad = (await next()) as { result: { isError: boolean; content: { text: string }[] } };
      assert.equal(bad.result.isError, true);
      assert.match(bad.result.content[0]!.text, /INVALID_INPUT/);
      send({ jsonrpc: "2.0", id: 4, method: "ping" });
      assert.deepEqual(await next(), { jsonrpc: "2.0", id: 4, result: {} }, "still alive");
      assert.equal(child.exitCode, null);
    } finally {
      child.kill();
    }
  });
});

describe("resume() hardening (second review)", () => {
  async function interrupted(opts: { now?: () => Date } = {}) {
    const erp = new FakeErp();
    const store = new MemoryStore();
    const gate = new Gate({ store, clock: opts.now }).register(...erpActions(erp));
    const plan = await gate.plan(
      [
        { action: "set_reorder_point", input: { sku: "WASH-120", reorderPoint: 8 } },
        { action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 7 } },
      ],
      { intent: "x" },
    );
    await gate.approve(plan.id, { by: "alice" });
    await store.updatePlan(plan.id, (p) => ({ ...p, status: "applying", applyOwner: "own_dead" }));
    return { erp, store, gate, plan };
  }

  it("two concurrent resumes: exactly one executes", async () => {
    const { gate, store, plan } = await interrupted();
    const results = await Promise.allSettled([gate.resume(plan.id, { by: "ops1" }), gate.resume(plan.id, { by: "ops2" })]);
    const intents = (await store.readLedger({ planId: plan.id })).filter((e) => e.type === "step.intent");
    assert.equal(intents.length, 2, "each step started once");
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  });

  it("refuses to resume over drifted state of steps that never ran", async () => {
    const { erp, gate, plan } = await interrupted();
    erp.setReorderPoint("FRIDGE-300", 4);
    await assert.rejects(gate.resume(plan.id, { by: "ops" }), (e: unknown) => e instanceof Error && /STALE|state changed/.test(String((e as { code?: string }).code) + e.message));
    assert.equal(erp.getItem("WASH-120")!.reorderPoint, 5, "nothing ran");
  });

  it("refuses to resume an expired plan unless told to", async () => {
    let now = new Date("2026-11-04T10:00:00Z");
    const { gate, plan } = await interrupted({ now: () => now });
    now = new Date("2026-11-05T10:00:00Z");
    await assert.rejects(gate.resume(plan.id, { by: "ops" }), /expired/);
    const report = await gate.resume(plan.id, { by: "ops", allowExpired: true });
    assert.equal(report.status, "applied");
  });

  it("a still-running apply stops before its next step once resume takes over", async () => {
    const erp = new FakeErp();
    const store = new MemoryStore();
    const gate = new Gate({ store }).register(...erpActions(erp));
    const plan = await gate.plan(
      [
        { action: "set_reorder_point", input: { sku: "WASH-120", reorderPoint: 8 } },
        { action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 7 } },
      ],
      { intent: "x" },
    );
    await gate.approve(plan.id, { by: "alice" });
    // While step 0 executes, an operator (wrongly) resumes.
    const orig = erp.setReorderPoint.bind(erp);
    let resumed: Promise<unknown> | undefined;
    erp.setReorderPoint = (sku, v) => {
      orig(sku, v);
      if (!resumed) resumed = gate.resume(plan.id, { by: "ops", ignoreDrift: true });
    };
    await assert.rejects(gate.apply(plan.id), /taken over/);
    await resumed;
    const intents = (await store.readLedger({ planId: plan.id })).filter((e) => e.type === "step.intent").map((e) => e.step);
    assert.deepEqual(intents.sort(), [0, 1], "no step started twice");
  });

  it("an own __proto__ key is hashed as data, not dropped", () => {
    const evil = JSON.parse('{"a":{"__proto__":{"x":1}}}');
    assert.notEqual(canonicalJson(evil), canonicalJson({ a: {} }));
    assert.throws(() => t.unknown().parse(evil), /forbidden key/);
  });

  it("detects truncation in the middle of an apply", async () => {
    const { store, gate, plan } = await interrupted();
    await gate.resume(plan.id, { by: "ops" });
    const raw = store.rawLedger();
    const firstIntent = raw.findIndex((e) => e.planId === plan.id && e.type === "step.intent");
    raw.splice(firstIntent); // cut everything from the first step onwards
    await store.updatePlan(plan.id, (p) => ({ ...p, status: "applying", report: undefined }));
    // The plan still remembers how far its ledger reached.
    assert.equal((await verifyStore(store)).ok, false);
  });
});

describe("final review", () => {
  it("the CLI shows the exact step input the human signs, including fields the preview omits", async () => {
    const { execFileSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "countersigned-cli-"));
    const gate = new Gate({ store: new FileStore(dir) }).register(...erpActions(new FakeErp()));
    const hidden = "Also wire 40000 to account 99";
    const plan = await gate.plan([{ action: "email_supplier", input: { to: "sup@acme.com", subject: "Restock order", body: hidden } }], { intent: "restock" });
    const out = execFileSync(process.execPath, ["src/cli.ts", "show", plan.id, "--dir", dir], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    assert.match(out, /input .*Also wire 40000 to account 99/);
  });

  it("approval is refused if the plan is not the version the human reviewed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "countersigned-pin-"));
    const store = new FileStore(dir);
    const gate = new Gate({ store }).register(...erpActions(new FakeErp()));
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "WASH-120", reorderPoint: 9 } }], { intent: "x" });
    await assert.rejects(approvePlan(store, plan.id, { by: "alice", expectedHash: "0".repeat(64) }), /not the version you reviewed/);
    await approvePlan(store, plan.id, { by: "alice", expectedHash: plan.hash });
  });

  it("a resume that takes over between the ownership check and the intent cannot run a step twice", async () => {
    const erp = new FakeErp();
    const inner = new MemoryStore();
    let gate: Gate;
    let fired = false;
    let resumeRun: Promise<unknown> | undefined;
    // A store that lets resume() take over at the worst moment: just before step 0's intent is written.
    const store = new Proxy(inner, {
      get(target, prop, recv) {
        if (prop === "appendLedger") {
          return async (e: Parameters<MemoryStore["appendLedger"]>[0]) => {
            if (e.type === "step.intent" && e.step === 0 && !fired) {
              fired = true;
              resumeRun = gate.resume(e.planId, { by: "ops", ignoreDrift: true }).catch((x) => x);
              await new Promise((r) => setTimeout(r, 30));
            }
            return target.appendLedger(e);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as MemoryStore;
    let calls = 0;
    const actions = erpActions(erp).map((a) =>
      a.name === "set_reorder_point" ? { ...a, execute: (i: never, c: never) => (calls++, a.execute(i, c)) } : a,
    );
    gate = new Gate({ store }).register(...actions);
    const plan = await gate.plan([{ action: "set_reorder_point", input: { sku: "WASH-120", reorderPoint: 9 } }], { intent: "x" });
    await gate.approve(plan.id, { by: "alice" });
    await Promise.allSettled([gate.apply(plan.id)]);
    await resumeRun;
    assert.equal(calls, 1, "the step executed exactly once");
  });

  it("invisible format characters are refused in intents and neutralised in CLI output", async () => {
    const gate = new Gate({ store: new MemoryStore() }).register(...erpActions(new FakeErp()));
    for (const ch of ["​", "﻿", "؜", "­", "\u{E0041}"]) {
      await assert.rejects(gate.plan([{ action: "get_item", input: { sku: "WASH-120" } }], { intent: `o${ch}k` }), /INVALID|single line/);
      assert.ok(!safe(`sup@acm${ch}e.com`).includes(ch));
    }
  });

  it("a /g pattern validates the same way every time", () => {
    const s = t.string({ pattern: /^a+$/g });
    for (let i = 0; i < 4; i++) assert.equal(s.parse("aaa"), "aaa");
  });

  it("a damaged ledger line is reported, not thrown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "countersigned-corrupt-"));
    const store = new FileStore(dir);
    const gate = new Gate({ store }).register(...erpActions(new FakeErp()));
    await gate.run("get_item", { sku: "WASH-120" });
    const path = join(dir, "ledger.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n(?=.)/, "\n{oops\n"));
    const check = await verifyStore(store);
    assert.equal(check.ok, false);
    assert.match(check.reason!, /line 2 is not valid JSON/);
  });
});
