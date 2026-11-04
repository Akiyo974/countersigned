import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it } from "node:test";
import { approvePlan, FileStore } from "../src/index.ts";

/** Drives the example server as a real subprocess, exactly like an MCP client would. */
function startServer(dir: string) {
  const child = spawn(process.execPath, ["examples/erp/mcp-server.ts"], { env: { ...process.env, TOLLGATE_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (v: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line) as { id: number };
    pending.get(msg.id)?.(msg as Record<string, unknown>);
  });
  let id = 0;
  const rpc = (method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  const call = async (name: string, args: unknown) => {
    const res = (await rpc("tools/call", { name, arguments: args })).result as {
      content: { text: string }[];
      structuredContent?: Record<string, unknown>;
      isError: boolean;
    };
    return { text: res.content[0]!.text, data: res.structuredContent, isError: res.isError };
  };
  return { rpc, call, stop: () => child.kill() };
}

describe("MCP server (stdio)", () => {
  it("full loop: plan -> blocked -> human approves out of band -> apply verified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tollgate-mcp-"));
    const s = startServer(dir);
    try {
      const init = (await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } })).result as {
        protocolVersion: string;
      };
      assert.equal(init.protocolVersion, "2025-06-18");

      const tools = ((await s.rpc("tools/list")).result as { tools: { name: string }[] }).tools.map((t) => t.name);
      assert.deepEqual(tools, ["tollgate_list_actions", "tollgate_plan", "tollgate_get_plan", "tollgate_apply", "tollgate_get_item"]);
      assert.ok(!tools.some((n) => n.includes("approve")), "the agent never gets an approve tool");

      const item = await s.call("tollgate_get_item", { sku: "FRIDGE-300" });
      assert.match(item.text, /"reorderPoint": 3/);

      const planned = await s.call("tollgate_plan", {
        intent: "Supplier delay: push SO-1001 and warn the supplier",
        steps: [
          { action: "reschedule_order", input: { orderNo: "SO-1001", shipmentDate: "2026-11-14", reason: "supplier delay" } },
          { action: "email_supplier", input: { to: "po@acme.co", subject: "Delay on PO 4471", body: "We moved SO-1001 to Nov 14." } },
        ],
      });
      const planId = planned.data!.planId as string;
      assert.equal(planned.data!.status, "pending_approval");
      assert.match(planned.text, /ask them to run: node src\/cli\.ts approve pl_/);

      const early = await s.call("tollgate_apply", { planId });
      assert.equal(early.isError, true);
      assert.match(early.text, /\[NOT_APPROVED\]/);

      await approvePlan(new FileStore(dir), planId, { by: "christen" });

      const applied = await s.call("tollgate_apply", { planId });
      assert.equal(applied.isError, false, applied.text);
      assert.match(applied.text, /APPLIED/);
      assert.match(applied.text, /evidence=\{"shipmentDate":"2026-11-14"\}/);

      const small = await s.call("tollgate_plan", { intent: "tweak", steps: [{ action: "set_reorder_point", input: { sku: "WASH-120", reorderPoint: 6 } }] });
      assert.equal(small.data!.status, "approved", "small reorder change is allowed by the custom rule");

      const bad = await s.call("tollgate_plan", { intent: "x", steps: [{ action: "set_reorder_point", input: { sku: "WASH-120" } }] });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /\[INVALID_INPUT\].*reorderPoint is required/s);

      const unknown = await s.rpc("nope/nope");
      assert.equal((unknown.error as { code: number }).code, -32601);
    } finally {
      s.stop();
    }
  });
});
