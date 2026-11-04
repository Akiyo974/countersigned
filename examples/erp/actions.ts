import { defineAction, t, type AnyAction } from "../../src/index.ts";
import type { FakeErp } from "./fake-erp.ts";

const sku = t.string({ min: 1, max: 40, description: "Item number, e.g. FRIDGE-300" });
const orderNo = t.string({ pattern: /^SO-\d+$/, description: "Sales order number, e.g. SO-1001" });
const isoDate = t.string({ pattern: /^\d{4}-\d{2}-\d{2}$/, description: "Date as YYYY-MM-DD" });

export function erpActions(erp: FakeErp): AnyAction[] {
  const getItem = defineAction({
    name: "get_item",
    description: "Read an inventory item: quantity on hand and reorder point. Read-only.",
    reversibility: "read",
    input: t.object({ sku }),
    observe: () => null,
    preview: ({ sku }) => [{ target: `item:${sku}`, op: "read", summary: `read item ${sku}` }],
    execute: ({ sku }) => {
      const item = erp.getItem(sku);
      if (!item) throw new Error(`Item ${sku} does not exist`);
      return item;
    },
    verify: (_i, item) => ({ ok: item !== undefined }),
  });

  const setReorderPoint = defineAction({
    name: "set_reorder_point",
    description:
      "Change the reorder point of an inventory item (the stock level that triggers replenishment). " +
      "Reversible: the previous value is restored if anything later in the plan fails.",
    reversibility: "reversible",
    tags: ["inventory"],
    input: t.object({
      sku,
      reorderPoint: t.integer({ min: 0, max: 10_000, description: "New reorder point" }),
    }),
    observe: ({ sku }) => {
      const item = erp.getItem(sku);
      return item ? { exists: true, reorderPoint: item.reorderPoint, onHand: item.onHand } : { exists: false };
    },
    check: ({ reorderPoint }, s) => {
      if (!s.exists) return ["item does not exist"];
      if (s.reorderPoint === reorderPoint) return [`reorder point is already ${reorderPoint}`];
    },
    preview: ({ sku, reorderPoint }, s) => [
      {
        target: `item:${sku}`,
        op: "update",
        before: { reorderPoint: s.reorderPoint },
        after: { reorderPoint },
        summary: `reorder point of ${sku}: ${s.reorderPoint} -> ${reorderPoint}`,
      },
    ],
    execute: ({ sku, reorderPoint }, { before }) => {
      erp.setReorderPoint(sku, reorderPoint);
      return { previous: before.reorderPoint };
    },
    // Re-read the ERP. The API returning OK is not evidence.
    verify: ({ sku, reorderPoint }) => {
      const now = erp.getItem(sku)?.reorderPoint;
      return { ok: now === reorderPoint, reason: `ERP shows ${now}, expected ${reorderPoint}`, evidence: { reorderPoint: now } };
    },
    compensate: ({ sku }, _result, { before }) => {
      erp.setReorderPoint(sku, before.reorderPoint as number);
    },
  });

  const rescheduleOrder = defineAction({
    name: "reschedule_order",
    description:
      "Move the shipment date of a sales order. Refused if the order is shipped or currently open by a user in the ERP " +
      "(writing to a locked document blocks that user). Compensable: the original date is restored on rollback.",
    reversibility: "compensable",
    tags: ["customer-facing"],
    input: t.object({ orderNo, shipmentDate: isoDate, reason: t.string({ min: 5, max: 200 }) }),
    observe: ({ orderNo }) => {
      const o = erp.getOrder(orderNo);
      return o ? { exists: true, status: o.status, shipmentDate: o.shipmentDate, lockedBy: o.lockedBy ?? null } : { exists: false };
    },
    check: ({ shipmentDate }, s) => {
      if (!s.exists) return ["order does not exist"];
      const v: string[] = [];
      if (s.status === "Shipped") v.push("order is already shipped");
      if (s.lockedBy) v.push(`order is open in the ERP by user ${s.lockedBy}; writing now would block their session`);
      if (s.shipmentDate === shipmentDate) v.push(`shipment date is already ${shipmentDate}`);
      return v;
    },
    preview: ({ orderNo, shipmentDate, reason }, s) => [
      {
        target: `order:${orderNo}`,
        op: "update",
        before: { shipmentDate: s.shipmentDate },
        after: { shipmentDate },
        summary: `ship ${orderNo} on ${shipmentDate} instead of ${s.shipmentDate} (${reason})`,
      },
    ],
    execute: ({ orderNo, shipmentDate }) => {
      erp.setShipmentDate(orderNo, shipmentDate);
      return { orderNo };
    },
    verify: ({ orderNo, shipmentDate }) => {
      const now = erp.getOrder(orderNo)?.shipmentDate;
      return { ok: now === shipmentDate, reason: `ERP shows ${now}`, evidence: { shipmentDate: now } };
    },
    compensate: ({ orderNo }, _r, { before }) => {
      erp.setShipmentDate(orderNo, before.shipmentDate as string);
    },
  });

  const emailSupplier = defineAction({
    name: "email_supplier",
    description: "Send an email to a supplier from the ERP outbox. IRREVERSIBLE: an email cannot be unsent.",
    reversibility: "irreversible",
    tags: ["external"],
    input: t.object({
      to: t.string({ pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, description: "Supplier email address" }),
      subject: t.string({ min: 3, max: 120 }),
      body: t.string({ min: 10, max: 4000 }),
    }),
    observe: () => null,
    preview: ({ to, subject }) => [{ target: `email:${to}`, op: "send", after: { subject }, summary: `send "${subject}" to ${to}` }],
    // The idempotency key becomes the ERP's external reference: a retry cannot send twice.
    execute: (input, { idempotencyKey }) => erp.sendEmail({ ...input, ref: idempotencyKey }),
    verify: (_i, _sent, { idempotencyKey }) => {
      const found = erp.findEmail(idempotencyKey);
      return { ok: !!found, reason: "email not found in outbox", evidence: found && { id: found.id, sentAt: found.sentAt } };
    },
  });

  return [getItem, setReorderPoint, rescheduleOrder, emailSupplier];
}
