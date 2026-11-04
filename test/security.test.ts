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
import { canonicalJson, FileStore, Gate, MemoryStore, t, verifyStore } from "../src/index.ts";
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
