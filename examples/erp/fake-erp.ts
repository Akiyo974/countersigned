import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * A deliberately annoying fake ERP, modelled on the things that bite in real ones
 * (Dynamics NAV / Business Central, SAP B1, Odoo...):
 *  - documents can be locked because a human has them open;
 *  - writes can silently not stick (a validation trigger, a replication lag, a bug);
 *  - outbound messages cannot be unsent.
 */

export interface Item {
  sku: string;
  description: string;
  onHand: number;
  reorderPoint: number;
}

export interface SalesOrder {
  no: string;
  customer: string;
  status: "Open" | "Released" | "Shipped";
  shipmentDate: string;
  /** Set when a user has the document open in the ERP client. */
  lockedBy?: string;
}

export interface Email {
  id: string;
  to: string;
  subject: string;
  body: string;
  /** External reference, used for dedupe: the ERP refuses two emails with the same ref. */
  ref: string;
  sentAt: string;
}

export interface ErpData {
  items: Record<string, Item>;
  orders: Record<string, SalesOrder>;
  outbox: Email[];
}

export function seed(): ErpData {
  return {
    items: {
      "FRIDGE-300": { sku: "FRIDGE-300", description: "Counter-depth fridge 30in", onHand: 4, reorderPoint: 3 },
      "WASH-120": { sku: "WASH-120", description: "Front-load washer", onHand: 11, reorderPoint: 5 },
    },
    orders: {
      "SO-1001": { no: "SO-1001", customer: "C-2001 Tremblay", status: "Released", shipmentDate: "2026-11-10" },
      "SO-1002": { no: "SO-1002", customer: "C-2002 Gagnon", status: "Open", shipmentDate: "2026-11-12", lockedBy: "JDOE" },
      "SO-1003": { no: "SO-1003", customer: "C-2003 Bouchard", status: "Shipped", shipmentDate: "2026-11-01" },
    },
    outbox: [],
  };
}

export class FakeErp {
  data: ErpData;
  /** Fault injection: when set, the next update to this SKU is accepted but silently dropped. */
  dropNextWriteFor?: string;
  private readonly file?: string;

  constructor(opts: { file?: string; data?: ErpData } = {}) {
    this.file = opts.file;
    if (opts.file && existsSync(opts.file)) this.data = JSON.parse(readFileSync(opts.file, "utf8")) as ErpData;
    else this.data = opts.data ?? seed();
    this.save();
  }

  private save(): void {
    if (this.file) writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  private reload(): void {
    if (this.file && existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, "utf8")) as ErpData;
  }

  getItem(sku: string): Item | undefined {
    this.reload();
    const i = this.data.items[sku];
    return i ? { ...i } : undefined;
  }

  setReorderPoint(sku: string, value: number): void {
    this.reload();
    const item = this.data.items[sku];
    if (!item) throw new Error(`Item ${sku} does not exist`);
    if (this.dropNextWriteFor === sku) {
      this.dropNextWriteFor = undefined;
      return; // the API said OK. Nothing happened.
    }
    item.reorderPoint = value;
    this.save();
  }

  getOrder(no: string): SalesOrder | undefined {
    this.reload();
    const o = this.data.orders[no];
    return o ? { ...o } : undefined;
  }

  setShipmentDate(no: string, date: string): void {
    this.reload();
    const o = this.data.orders[no];
    if (!o) throw new Error(`Sales order ${no} does not exist`);
    if (o.lockedBy) throw new Error(`Sales order ${no} is locked by user ${o.lockedBy}`);
    o.shipmentDate = date;
    this.save();
  }

  /** A human opens the document in the ERP client. */
  lock(no: string, user: string): void {
    this.reload();
    const o = this.data.orders[no];
    if (o) o.lockedBy = user;
    this.save();
  }

  sendEmail(msg: Omit<Email, "id" | "sentAt">): Email {
    this.reload();
    const existing = this.data.outbox.find((e) => e.ref === msg.ref);
    if (existing) return existing; // dedupe on external reference
    const email: Email = { ...msg, id: `EM-${this.data.outbox.length + 1}`, sentAt: new Date().toISOString() };
    this.data.outbox.push(email);
    this.save();
    return email;
  }

  findEmail(ref: string): Email | undefined {
    this.reload();
    return this.data.outbox.find((e) => e.ref === ref);
  }
}
