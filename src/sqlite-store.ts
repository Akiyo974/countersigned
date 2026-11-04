import { DatabaseSync } from "node:sqlite";
import { GENESIS, sealEntry } from "./ledger.ts";
import type { Store } from "./store.ts";
import type { LedgerEntry, LedgerInput, Plan } from "./types.ts";

/**
 * SQLite store on Node's built-in `node:sqlite`: still zero dependencies, but transactional
 * and safe for several processes on one machine (SQLite file locking + WAL).
 *
 *   import { SqliteStore } from "countersigned/sqlite";
 *   const store = new SqliteStore("countersigned.db");
 *
 * Imported from its own entry point so the core never loads `node:sqlite` unless you ask for it.
 */
export class SqliteStore implements Store {
  readonly db: DatabaseSync;

  constructor(path = "countersigned.db") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 10000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS plans (
        id         TEXT PRIMARY KEY,
        status     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS plans_status ON plans(status);
      CREATE TABLE IF NOT EXISTS ledger (
        seq     INTEGER PRIMARY KEY,
        plan_id TEXT NOT NULL,
        hash    TEXT NOT NULL UNIQUE,
        data    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_plan ON ledger(plan_id);
    `);
  }

  /** BEGIN IMMEDIATE takes the write lock up front, so read-modify-write cannot interleave across processes. */
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async createPlan(plan: Plan): Promise<void> {
    this.db.prepare("INSERT INTO plans (id, status, created_at, data) VALUES (?, ?, ?, ?)").run(plan.id, plan.status, plan.createdAt, JSON.stringify(plan));
  }

  async getPlan(id: string): Promise<Plan | undefined> {
    const row = this.db.prepare("SELECT data FROM plans WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Plan) : undefined;
  }

  async updatePlan(id: string, mutate: (plan: Plan) => Plan): Promise<Plan> {
    return this.tx(() => {
      const row = this.db.prepare("SELECT data FROM plans WHERE id = ?").get(id) as { data: string } | undefined;
      if (!row) throw new Error(`plan ${id} not found`);
      const next = mutate(JSON.parse(row.data) as Plan);
      this.db.prepare("UPDATE plans SET status = ?, data = ? WHERE id = ?").run(next.status, JSON.stringify(next), id);
      return next;
    });
  }

  async listPlans(filter?: { status?: Plan["status"] }): Promise<Plan[]> {
    const rows = (
      filter?.status
        ? this.db.prepare("SELECT data FROM plans WHERE status = ? ORDER BY created_at, id").all(filter.status)
        : this.db.prepare("SELECT data FROM plans ORDER BY created_at, id").all()
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Plan);
  }

  async appendLedger(entry: LedgerInput): Promise<LedgerEntry> {
    return this.tx(() => {
      const last = this.db.prepare("SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | undefined;
      const sealed = sealEntry(entry, (last?.seq ?? 0) + 1, last?.hash ?? GENESIS);
      this.db.prepare("INSERT INTO ledger (seq, plan_id, hash, data) VALUES (?, ?, ?, ?)").run(sealed.seq, sealed.planId, sealed.hash, JSON.stringify(sealed));
      return sealed;
    });
  }

  async readLedger(filter?: { planId?: string }): Promise<LedgerEntry[]> {
    const rows = (
      filter?.planId
        ? this.db.prepare("SELECT data FROM ledger WHERE plan_id = ? ORDER BY seq").all(filter.planId)
        : this.db.prepare("SELECT data FROM ledger ORDER BY seq").all()
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as LedgerEntry);
  }

  close(): void {
    this.db.close();
  }
}
