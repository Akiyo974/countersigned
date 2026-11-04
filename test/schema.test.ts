import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalJson, hashValue, t, ValidationError } from "../src/index.ts";

describe("schema", () => {
  const s = t.object({
    name: t.string({ min: 2 }),
    qty: t.integer({ min: 0 }),
    tags: t.optional(t.array(t.enum(["a", "b"] as const))),
  });

  it("parses valid input", () => {
    assert.deepEqual(s.parse({ name: "ok", qty: 3 }), { name: "ok", qty: 3 });
    assert.deepEqual(s.parse({ name: "ok", qty: 3, tags: ["a"] }), { name: "ok", qty: 3, tags: ["a"] });
  });

  it("collects every issue, with paths", () => {
    try {
      s.parse({ name: "x", qty: 1.5, tags: ["c"], bogus: 1 });
      assert.fail("should throw");
    } catch (e) {
      assert.ok(e instanceof ValidationError);
      assert.deepEqual(
        e.issues.map((i) => i.path).sort(),
        ["bogus", "name", "qty", "tags[0]"],
      );
    }
  });

  it("produces JSON Schema for MCP clients", () => {
    assert.deepEqual(s.json, {
      type: "object",
      additionalProperties: false,
      required: ["name", "qty"],
      properties: {
        name: { type: "string", minLength: 2 },
        qty: { type: "integer", minimum: 0 },
        tags: { type: "array", items: { enum: ["a", "b"] } },
      },
    });
  });

  it("custom() adapts another validator", () => {
    const even = t.custom({ type: "integer" }, (v) => {
      if (typeof v !== "number" || v % 2) throw new Error("must be even");
      return v;
    });
    assert.equal(even.parse(4), 4);
    assert.throws(() => even.parse(3), /must be even/);
  });
});

describe("canonical hashing", () => {
  it("is independent of key order and undefined fields", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: undefined } }), '{"a":{"d":2},"b":1}');
    assert.equal(hashValue({ x: 1, y: 2 }), hashValue({ y: 2, x: 1 }));
    assert.notEqual(hashValue({ x: 1 }), hashValue({ x: "1" }));
  });
});
