import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny REST API with the two features that make agent writes safe end to end:
 *
 *  - ETags + If-Match: every item has a version. A write must name the version it was based on;
 *    if someone changed the item in between, the write is refused with 412 and nothing happens.
 *  - Idempotency-Key: a retried write with the same key returns the first response and does
 *    not apply twice.
 *
 * Most serious APIs offer at least one of these (Stripe, Shopify, Business Central OData, any
 * database with row versions). This server exists so the example and tests need no network.
 */

export interface Item {
  sku: string;
  price: number;
  version: number;
}

export class InventoryApi {
  readonly items = new Map<string, Item>();
  private readonly idempotency = new Map<string, { status: number; body: unknown; etag?: string }>();
  private server?: Server;
  url = "";
  /** Test hook: runs right before the next write is evaluated, to simulate a concurrent edit. */
  beforeNextWrite?: () => void;
  writes = 0;

  constructor(items: Omit<Item, "version">[]) {
    for (const i of items) this.items.set(i.sku, { ...i, version: 1 });
  }

  /** Simulates a human editing the item in another app. */
  edit(sku: string, price: number): void {
    const item = this.items.get(sku);
    if (!item) throw new Error(`no item ${sku}`);
    item.price = price;
    item.version += 1;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private send(res: ServerResponse, status: number, body: unknown, etag?: string): void {
    res.writeHead(status, { "content-type": "application/json", ...(etag ? { etag } : {}) });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = /^\/items\/([A-Za-z0-9-]+)$/.exec(req.url ?? "");
    const item = match ? this.items.get(match[1]!) : undefined;
    if (!item) return this.send(res, 404, { error: "not found" });
    const etag = `"v${item.version}"`;

    if (req.method === "GET") return this.send(res, 200, { sku: item.sku, price: item.price }, etag);

    if (req.method === "PATCH") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const key = req.headers["idempotency-key"];
      if (typeof key === "string" && this.idempotency.has(key)) {
        const prior = this.idempotency.get(key)!;
        return this.send(res, prior.status, prior.body, prior.etag);
      }
      const hook = this.beforeNextWrite;
      this.beforeNextWrite = undefined;
      hook?.();
      const current = this.items.get(item.sku)!;
      const currentTag = `"v${current.version}"`;
      const ifMatch = req.headers["if-match"];
      if (!ifMatch) return this.send(res, 428, { error: "If-Match required" });
      if (ifMatch !== currentTag) return this.send(res, 412, { error: "version changed", current: currentTag });

      const patch = JSON.parse(raw || "{}") as { price?: number };
      if (typeof patch.price !== "number" || patch.price < 0) return this.send(res, 422, { error: "invalid price" });
      current.price = patch.price;
      current.version += 1;
      this.writes += 1;
      const out = { status: 200, body: { sku: current.sku, price: current.price }, etag: `"v${current.version}"` };
      if (typeof key === "string") this.idempotency.set(key, out);
      return this.send(res, out.status, out.body, out.etag);
    }
    return this.send(res, 405, { error: "method not allowed" });
  }
}
