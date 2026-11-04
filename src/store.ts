import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GENESIS, sealEntry } from "./ledger.ts";
import type { LedgerEntry, LedgerInput, Plan } from "./types.ts";

/**
 * Persistence for plans and the ledger. Async on purpose so a Postgres / SQLite / Redis
 * implementation can drop in without changing the gate.
 *
 * Contract: `appendLedger` must be atomic with respect to other appends (the chain depends on it),
 * and `updatePlan` must apply the mutator to the latest stored version under the same lock.
 */
export interface Store {
  createPlan(plan: Plan): Promise<void>;
  getPlan(id: string): Promise<Plan | undefined>;
  /** Read-modify-write under a lock. The mutator may throw to abort. */
  updatePlan(id: string, mutate: (plan: Plan) => Plan): Promise<Plan>;
  listPlans(filter?: { status?: Plan["status"] }): Promise<Plan[]>;
  appendLedger(entry: LedgerInput): Promise<LedgerEntry>;
  readLedger(filter?: { planId?: string }): Promise<LedgerEntry[]>;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  private plans = new Map<string, Plan>();
  private ledger: LedgerEntry[] = [];

  async createPlan(plan: Plan): Promise<void> {
    if (this.plans.has(plan.id)) throw new Error(`plan ${plan.id} already exists`);
    this.plans.set(plan.id, clone(plan));
  }
  async getPlan(id: string): Promise<Plan | undefined> {
    const p = this.plans.get(id);
    return p ? clone(p) : undefined;
  }
  async updatePlan(id: string, mutate: (plan: Plan) => Plan): Promise<Plan> {
    const current = this.plans.get(id);
    if (!current) throw new Error(`plan ${id} not found`);
    const next = mutate(clone(current));
    this.plans.set(id, clone(next));
    return clone(next);
  }
  async listPlans(filter?: { status?: Plan["status"] }): Promise<Plan[]> {
    return [...this.plans.values()].filter((p) => !filter?.status || p.status === filter.status).map(clone);
  }
  async appendLedger(entry: LedgerInput): Promise<LedgerEntry> {
    const last = this.ledger.at(-1);
    const sealed = sealEntry(entry, (last?.seq ?? 0) + 1, last?.hash ?? GENESIS);
    this.ledger.push(sealed);
    return clone(sealed);
  }
  async readLedger(filter?: { planId?: string }): Promise<LedgerEntry[]> {
    return this.ledger.filter((e) => !filter?.planId || e.planId === filter.planId).map(clone);
  }
  /** Test helper: direct access to raw entries. */
  rawLedger(): LedgerEntry[] {
    return this.ledger;
  }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Plain files, safe across processes on one machine (the agent's MCP server and the human's CLI
 * share it). Layout:
 *
 *   <dir>/plans/<id>.json   one file per plan, replaced atomically
 *   <dir>/ledger.jsonl      append-only, hash-chained
 *   <dir>/.lock             short-lived cross-process lock
 */
export class FileStore implements Store {
  readonly dir: string;
  private readonly plansDir: string;
  private readonly ledgerPath: string;
  private readonly lockPath: string;

  constructor(dir = ".tollgate") {
    this.dir = dir;
    this.plansDir = join(dir, "plans");
    this.ledgerPath = join(dir, "ledger.jsonl");
    this.lockPath = join(dir, ".lock");
    mkdirSync(this.plansDir, { recursive: true });
  }

  private withLock<T>(fn: () => T): T {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        closeSync(openSync(this.lockPath, "wx"));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > 30_000) rmSync(this.lockPath, { force: true });
        } catch {
          /* lock vanished between calls: retry */
        }
        if (Date.now() > deadline) throw new Error(`could not acquire ${this.lockPath} within 10s`);
        sleepSync(5);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(this.lockPath, { force: true });
    }
  }

  private planPath(id: string): string {
    if (!/^[a-z]+_[a-z0-9]+$/.test(id)) throw new Error(`invalid plan id: ${id}`);
    return join(this.plansDir, `${id}.json`);
  }

  private writeAtomic(path: string, data: string): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }

  private read(id: string): Plan | undefined {
    const path = this.planPath(id);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as Plan;
  }

  async createPlan(plan: Plan): Promise<void> {
    this.withLock(() => {
      const path = this.planPath(plan.id);
      if (existsSync(path)) throw new Error(`plan ${plan.id} already exists`);
      this.writeAtomic(path, JSON.stringify(plan, null, 2));
    });
  }

  async getPlan(id: string): Promise<Plan | undefined> {
    try {
      return this.read(id);
    } catch {
      return undefined;
    }
  }

  async updatePlan(id: string, mutate: (plan: Plan) => Plan): Promise<Plan> {
    return this.withLock(() => {
      const current = this.read(id);
      if (!current) throw new Error(`plan ${id} not found`);
      const next = mutate(current);
      this.writeAtomic(this.planPath(id), JSON.stringify(next, null, 2));
      return next;
    });
  }

  async listPlans(filter?: { status?: Plan["status"] }): Promise<Plan[]> {
    const files = readdirSync(this.plansDir).filter((f) => f.endsWith(".json")).sort();
    const plans: Plan[] = [];
    for (const f of files) {
      try {
        const p = JSON.parse(readFileSync(join(this.plansDir, f), "utf8")) as Plan;
        if (!filter?.status || p.status === filter.status) plans.push(p);
      } catch {
        /* skip half-written or foreign files */
      }
    }
    return plans;
  }

  private lastEntry(): LedgerEntry | undefined {
    if (!existsSync(this.ledgerPath)) return undefined;
    const text = readFileSync(this.ledgerPath, "utf8").trimEnd();
    if (!text) return undefined;
    const lastLine = text.slice(text.lastIndexOf("\n") + 1);
    return JSON.parse(lastLine) as LedgerEntry;
  }

  async appendLedger(entry: LedgerInput): Promise<LedgerEntry> {
    return this.withLock(() => {
      const last = this.lastEntry();
      const sealed = sealEntry(entry, (last?.seq ?? 0) + 1, last?.hash ?? GENESIS);
      appendFileSync(this.ledgerPath, `${JSON.stringify(sealed)}\n`);
      return sealed;
    });
  }

  async readLedger(filter?: { planId?: string }): Promise<LedgerEntry[]> {
    if (!existsSync(this.ledgerPath)) return [];
    return readFileSync(this.ledgerPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEntry)
      .filter((e) => !filter?.planId || e.planId === filter.planId);
  }
}
