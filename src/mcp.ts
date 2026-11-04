import { createInterface } from "node:readline";
import { GateError } from "./errors.ts";
import type { Gate } from "./gate.ts";
import type { JsonSchema } from "./schema.ts";
import type { ApplyReport, Plan } from "./types.ts";

/**
 * A dependency-free Model Context Protocol server (JSON-RPC 2.0 over stdio).
 *
 * What the agent gets:   list_actions, plan, get_plan, apply, plus every read-only action as a direct tool.
 * What the agent never gets: approve. Approval happens out of band (CLI, UI, chat button),
 * against the exact plan hash. That separation is the whole point.
 */

export interface McpOptions {
  name?: string;
  version?: string;
  /** Prefix for every tool name. Default "countersigned_". */
  toolPrefix?: string;
  /** Identity recorded as requester of every plan made through this server. */
  agentId?: string;
  /** Command shown to the agent when a human must approve. */
  approveHint?: (planId: string) => string;
  /** Largest accepted JSON-RPC message, in bytes. Default 1 MiB. */
  maxMessageBytes?: number;
}

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: Record<string, boolean | string>;
  call(args: Record<string, unknown>): Promise<{ text: string; data?: unknown; isError?: boolean }>;
}

const fmt = (v: unknown) => (v === undefined ? "?" : JSON.stringify(v));

export function describePlan(plan: Plan, approveHint: (id: string) => string): string {
  const lines = [`Plan ${plan.id}: ${plan.status.toUpperCase()}`, `Intent: ${plan.intent}`];
  for (const s of plan.steps) {
    lines.push(`  ${s.index}. ${s.action} [${s.reversibility}] -> ${s.decision}`);
    for (const e of s.effects) lines.push(`       ${e.summary ?? `${e.op} ${e.target}: ${fmt(e.before)} -> ${fmt(e.after)}`}`);
    for (const v of s.violations) lines.push(`       BLOCKED: ${v}`);
  }
  switch (plan.status) {
    case "approved":
      lines.push(plan.approval?.automatic ? "Allowed by policy. Call apply with this planId." : `Approved by ${plan.approval?.by}. Call apply with this planId.`);
      break;
    case "pending_approval":
      lines.push(
        `A human must approve before anything happens. Show the user the effects above and ask them to run: ${approveHint(plan.id)}`,
        `Approval expires at ${plan.expiresAt}. Then call get_plan or apply. Do not try to work around this step.`,
      );
      break;
    case "denied":
      lines.push(`Denied: ${plan.reasons.join("; ")}. Nothing ran. Change the plan or explain the blocker to the user.`);
      break;
    case "rejected":
      lines.push(`Rejected by ${plan.rejection?.by}: ${plan.rejection?.reason}`);
      break;
    case "stale":
      lines.push("Stale: the system changed after approval. Nothing ran. Re-read the state and make a new plan.");
      break;
    default:
      if (plan.report) lines.push(plan.report.message);
  }
  return lines.join("\n");
}

export function describeReport(r: ApplyReport): string {
  const lines = [`Plan ${r.planId}: ${r.status.toUpperCase()}`, r.message];
  for (const s of r.steps) {
    const showEvidence = (s.status === "succeeded" || s.status === "skipped_already_done") && s.evidence !== undefined;
    const extra = s.error ? ` (${s.error})` : showEvidence ? ` evidence=${fmt(s.evidence)}` : "";
    lines.push(`  ${s.index}. ${s.action}: ${s.status}${extra}`);
  }
  for (const u of r.unrecoverable) lines.push(`  NEEDS A HUMAN: step ${u.index} ${u.action}: ${u.reason}`);
  return lines.join("\n");
}

export function createMcpServer(gate: Gate, opts: McpOptions = {}) {
  const prefix = opts.toolPrefix ?? "countersigned_";
  const agentId = opts.agentId ?? "mcp-agent";
  const approveHint = opts.approveHint ?? ((id: string) => `npx countersigned approve ${id}`);
  const actions = gate.actions();
  const names = actions.map((a) => a.name);

  const tools: Tool[] = [
    {
      name: `${prefix}list_actions`,
      title: "List available actions",
      description: "List every action you can plan, with its input schema and how reversible it is.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      async call() {
        const text = actions
          .map((a) => `- ${a.name} [${a.reversibility}]: ${a.description}\n  input: ${JSON.stringify(a.inputSchema)}`)
          .join("\n");
        return { text, data: { actions } };
      },
    },
    {
      name: `${prefix}plan`,
      title: "Propose a plan",
      description:
        "Propose one or more actions to change the system. NOTHING is executed: the current state is read, " +
        "business rules are checked and the exact effects are previewed. Depending on policy the plan is allowed, " +
        "denied, or waits for a human. Group related changes in one plan: if a later step fails, earlier ones are rolled back.\n" +
        `Actions: ${actions.map((a) => `${a.name} (${a.reversibility})`).join(", ")}. Call ${prefix}list_actions for input schemas.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["intent", "steps"],
        properties: {
          intent: { type: "string", minLength: 3, description: "What you are trying to achieve and why, for the human approver." },
          steps: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["action", "input"],
              properties: { action: { enum: names }, input: { type: "object", description: "Arguments, per the action's schema." } },
            },
          },
        },
      },
      annotations: { readOnlyHint: true },
      async call(args) {
        const plan = await gate.plan(args.steps as { action: string; input: unknown }[], { intent: String(args.intent ?? ""), requestedBy: agentId });
        return { text: describePlan(plan, approveHint), data: { planId: plan.id, status: plan.status, hash: plan.hash, steps: plan.steps } };
      },
    },
    {
      name: `${prefix}get_plan`,
      title: "Get plan status",
      description: "Get the current status of a plan (pending, approved, applied...) and its report if it ran.",
      inputSchema: { type: "object", required: ["planId"], additionalProperties: false, properties: { planId: { type: "string" } } },
      annotations: { readOnlyHint: true },
      async call(args) {
        const plan = await gate.get(String(args.planId));
        return { text: describePlan(plan, approveHint), data: { planId: plan.id, status: plan.status, report: plan.report } };
      },
    },
    {
      name: `${prefix}apply`,
      title: "Apply an approved plan",
      description:
        "Execute an approved plan exactly as approved. The system state is re-checked first: if anything changed since " +
        "approval, nothing runs. Each step is verified against the real system; on failure earlier steps are compensated. " +
        "Safe to call again: completed steps are never repeated.",
      inputSchema: { type: "object", required: ["planId"], additionalProperties: false, properties: { planId: { type: "string" } } },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      async call(args) {
        const report = await gate.apply(String(args.planId));
        return { text: describeReport(report), data: report, isError: report.status !== "applied" };
      },
    },
  ];

  for (const a of actions.filter((x) => x.reversibility === "read")) {
    tools.push({
      name: `${prefix}${a.name}`,
      title: a.name,
      description: `${a.description} (Read-only. Runs immediately if policy allows.)`,
      inputSchema: a.inputSchema,
      annotations: { readOnlyHint: true },
      async call(args) {
        const result = await gate.run(a.name, args, { requestedBy: agentId, intent: `read: ${a.name}` });
        return { text: JSON.stringify(result, null, 2), data: { result } };
      },
    });
  }

  async function handle(raw: unknown): Promise<Record<string, unknown> | undefined> {
    const invalid = (message: string) => ({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Invalid Request: ${message}` } });
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid("expected an object");
    const req = raw as JsonRpcRequest;
    if (typeof req.method !== "string") return invalid("missing method");
    if (req.id !== undefined && req.id !== null && typeof req.id !== "string" && typeof req.id !== "number") return invalid("bad id");
    if (req.params !== undefined && (req.params === null || typeof req.params !== "object" || Array.isArray(req.params))) {
      return { jsonrpc: "2.0", id: req.id ?? null, error: { code: -32602, message: "Invalid params: expected an object" } };
    }
    const isNotification = req.id === undefined || req.id === null;
    const reply = (result: unknown) => (isNotification ? undefined : { jsonrpc: "2.0", id: req.id, result });
    const fail = (code: number, message: string) => (isNotification ? undefined : { jsonrpc: "2.0", id: req.id, error: { code, message } });

    switch (req.method) {
      case "initialize": {
        const requested = String(req.params?.protocolVersion ?? "");
        return reply({
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: opts.name ?? "countersigned", version: opts.version ?? "0.1.0" },
          instructions:
            "Every change to the business system goes through a plan. Read freely; to change anything, call plan, " +
            "show the user the previewed effects, and wait for human approval when required. Then call apply. " +
            "Never claim a change is done unless apply reports it verified.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
        });
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const tool = tools.find((x) => x.name === name);
        if (!tool) return fail(-32602, `Unknown tool: ${name}`);
        const rawArgs = req.params?.arguments ?? {};
        if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return fail(-32602, "arguments must be an object");
        const args = rawArgs as Record<string, unknown>;
        try {
          const out = await tool.call(args);
          return reply({
            content: [{ type: "text", text: out.text }],
            ...(out.data !== undefined ? { structuredContent: out.data } : {}),
            isError: out.isError ?? false,
          });
        } catch (e) {
          const text = e instanceof GateError ? `[${e.code}] ${e.message}` : `Error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 2000);
          return reply({ content: [{ type: "text", text }], isError: true });
        }
      }
      default:
        if (req.method.startsWith("notifications/")) return undefined;
        return fail(-32601, `Method not found: ${req.method}`);
    }
  }

  return { tools, handle };
}

/** Serve over stdio. stdout carries protocol messages only; diagnostics go to stderr. */
export function serveStdio(gate: Gate, opts: McpOptions = {}): void {
  const server = createMcpServer(gate, opts);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  // Requests are handled in arrival order so plan -> apply sequences from one client stay ordered.
  let queue = Promise.resolve();
  const maxBytes = opts.maxMessageBytes ?? 1_048_576;
  rl.on("line", (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      if (Buffer.byteLength(line) > maxBytes) {
        write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Invalid Request: message larger than ${maxBytes} bytes` } });
        return;
      }
      let req: unknown;
      try {
        req = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      const isBatch = Array.isArray(req);
      const batch: unknown[] = isBatch ? (req as unknown[]) : [req];
      if (isBatch && batch.length === 0) {
        write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: empty batch" } });
        return;
      }
      // Requests in a batch run one after another, never concurrently.
      const out: Record<string, unknown>[] = [];
      for (const r of batch) {
        try {
          const res = await server.handle(r);
          if (res) out.push(res);
        } catch (e) {
          const id = r !== null && typeof r === "object" && "id" in r ? ((r as { id?: unknown }).id ?? null) : null;
          out.push({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
          process.stderr.write(`[countersigned] internal error: ${e instanceof Error ? e.stack : String(e)}\n`);
        }
      }
      if (out.length) write(isBatch ? out : out[0]);
    }).catch((e) => {
      process.stderr.write(`[countersigned] ${String(e)}\n`);
    });
  });
  process.stderr.write(`[countersigned] MCP server ready on stdio (${server.tools.length} tools)\n`);
}
