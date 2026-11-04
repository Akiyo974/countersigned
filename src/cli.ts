#!/usr/bin/env node
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { GateError } from "./errors.ts";
import { short } from "./hash.ts";
import { verifyChain } from "./ledger.ts";
import { approvePlan, rejectPlan } from "./plan.ts";
import { FileStore } from "./store.ts";
import type { LedgerEntry, Plan, PlanStatus } from "./types.ts";

const tty = (process.stdout.isTTY || !!process.env.FORCE_COLOR) && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const cyan = paint(36);

const statusColor: Record<PlanStatus, (s: string) => string> = {
  pending_approval: yellow,
  approved: green,
  applying: cyan,
  applied: green,
  compensated: yellow,
  rejected: red,
  denied: red,
  failed: red,
  stale: red,
  expired: dim,
};

const HELP = `${bold("countersigned")}: the human side of the gate.

${bold("Usage")}
  countersigned list [--all]                     plans waiting for you (or every plan)
  countersigned show <planId>                    full plan: intent, state, effects, decision
  countersigned approve <planId> [--by NAME] [--note TEXT] [--yes]
  countersigned reject <planId> --reason TEXT [--by NAME]
  countersigned ledger [--plan <planId>] [--limit N]
  countersigned ledger verify                    check the hash chain end to end

${bold("Options")}
  --dir PATH   store directory (default: $COUNTERSIGNED_DIR or ./.countersigned)
`;

const fmt = (v: unknown) => (v === undefined ? dim("(none)") : JSON.stringify(v));

function ago(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 0) return `in ${Math.round(-s / 60)}m`;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function printPlan(p: Plan): void {
  const color = statusColor[p.status];
  console.log(`${bold(`Plan ${p.id}`)}  ${color(p.status.toUpperCase())}  ${dim(`hash ${short(p.hash)}`)}`);
  console.log(`  ${dim("intent")}     ${p.intent}`);
  console.log(`  ${dim("requested")}  ${p.requestedBy}, ${ago(p.createdAt)}`);
  if (p.status === "pending_approval") console.log(`  ${dim("expires")}    ${ago(p.expiresAt)}`);
  if (p.approval) console.log(`  ${dim("approved")}   ${p.approval.automatic ? "by policy" : `by ${p.approval.by}`}${p.approval.note ? ` (${p.approval.note})` : ""}`);
  if (p.rejection) console.log(`  ${dim("rejected")}   by ${p.rejection.by}: ${p.rejection.reason}`);
  console.log();
  for (const s of p.steps) {
    const rev = s.reversibility === "irreversible" ? red(bold("IRREVERSIBLE")) : s.reversibility === "read" ? dim("read") : s.reversibility;
    console.log(`  ${bold(`${s.index}.`)} ${bold(s.action)}  [${rev}]  ${dim(s.decision)}`);
    for (const e of s.effects) {
      const sym = e.op === "send" ? red(">") : e.op === "delete" ? red("-") : e.op === "create" ? green("+") : e.op === "read" ? dim("·") : yellow("~");
      console.log(`     ${sym} ${e.summary ?? `${e.op} ${e.target}`}`);
      if (e.before !== undefined || e.after !== undefined) console.log(dim(`       ${fmt(e.before)} -> ${fmt(e.after)}`));
    }
    for (const v of s.violations) console.log(`     ${red("blocked:")} ${v}`);
    for (const r of s.reasons) console.log(dim(`     why: ${r}`));
  }
  if (p.report) {
    console.log();
    console.log(`  ${bold("report")} ${p.report.message}`);
    for (const o of p.report.steps) console.log(`     ${o.index}. ${o.action}: ${o.status}${o.error ? red(` (${o.error})`) : ""}`);
    for (const u of p.report.unrecoverable) console.log(red(`     needs a human: step ${u.index} ${u.action}: ${u.reason}`));
  }
}

function printEntry(e: LedgerEntry): void {
  const step = e.step !== undefined ? ` step ${e.step}` : "";
  const data = e.data === undefined ? "" : dim(` ${JSON.stringify(e.data).slice(0, 140)}`);
  console.log(`${dim(String(e.seq).padStart(5))} ${dim(e.at)} ${cyan(e.type.padEnd(24))} ${e.planId}${step}${data}`);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      by: { type: "string" },
      note: { type: "string" },
      reason: { type: "string" },
      plan: { type: "string" },
      limit: { type: "string" },
      all: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg] = positionals;
  if (values.help || !cmd) {
    console.log(HELP);
    return cmd ? 0 : 1;
  }

  const store = new FileStore(values.dir ?? process.env.COUNTERSIGNED_DIR ?? ".countersigned");
  const by = values.by ?? process.env.COUNTERSIGNED_USER ?? userInfo().username;

  switch (cmd) {
    case "list": {
      const plans = await store.listPlans(values.all ? undefined : { status: "pending_approval" });
      if (!plans.length) {
        console.log(dim(values.all ? "No plans yet." : "Nothing waiting for approval."));
        return 0;
      }
      for (const p of plans.reverse()) {
        const effects = p.steps.reduce((n, s) => n + s.effects.length, 0);
        const irr = p.steps.some((s) => s.reversibility === "irreversible") ? red(" irreversible") : "";
        console.log(`${p.id}  ${statusColor[p.status](p.status.padEnd(16))} ${dim(ago(p.createdAt).padEnd(9))} ${p.steps.length} step(s), ${effects} effect(s)${irr}  ${p.intent}`);
      }
      return 0;
    }
    case "show": {
      if (!arg) throw new Error("usage: countersigned show <planId>");
      const p = await store.getPlan(arg);
      if (!p) throw new GateError("PLAN_NOT_FOUND", `No plan ${arg} in ${store.dir}`);
      printPlan(p);
      return 0;
    }
    case "approve": {
      if (!arg) throw new Error("usage: countersigned approve <planId>");
      const p = await store.getPlan(arg);
      if (!p) throw new GateError("PLAN_NOT_FOUND", `No plan ${arg} in ${store.dir}`);
      printPlan(p);
      console.log();
      if (!values.yes) {
        if (!process.stdin.isTTY) throw new Error("Not a terminal: pass --yes to approve non-interactively.");
        if (!(await confirm(`Approve exactly this plan as ${bold(by)}? [y/N] `))) {
          console.log("Not approved.");
          return 1;
        }
      }
      const approved = await approvePlan(store, arg, { by, note: values.note });
      console.log(green(`Approved ${approved.id} (hash ${short(approved.hash)}). The agent can now apply it.`));
      return 0;
    }
    case "reject": {
      if (!arg || !values.reason) throw new Error("usage: countersigned reject <planId> --reason TEXT");
      await rejectPlan(store, arg, { by, reason: values.reason });
      console.log(yellow(`Rejected ${arg}.`));
      return 0;
    }
    case "ledger": {
      const entries = await store.readLedger(values.plan ? { planId: values.plan } : undefined);
      if (arg === "verify") {
        const all = values.plan ? await store.readLedger() : entries;
        const check = verifyChain(all);
        if (check.ok) {
          console.log(green(`Ledger intact: ${check.entries} entries, chain verified.`));
          return 0;
        }
        console.log(red(`Ledger BROKEN at entry ${check.brokenAt}: ${check.reason}`));
        return 2;
      }
      const limit = Number(values.limit ?? 50);
      for (const e of entries.slice(-limit)) printEntry(e);
      return 0;
    }
    default:
      console.log(HELP);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    const msg = e instanceof GateError ? `[${e.code}] ${e.message}` : e instanceof Error ? e.message : String(e);
    console.error(red(msg));
    process.exit(1);
  },
);
