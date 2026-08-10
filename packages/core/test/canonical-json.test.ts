import { describe, expect, it } from "vitest";
import { canonicalJsonStringify } from "../src/canonical-json.js";

describe("canonicalJsonStringify", () => {
  it("sorts nested object keys by code unit while preserving array order", () => {
    expect(
      canonicalJsonStringify({
        z: [{ b: 2, a: 1 }, "second"],
        a: { y: true, x: null },
      })
    ).toBe('{"a":{"x":null,"y":true},"z":[{"a":1,"b":2},"second"]}');
  });

  it("produces the same canonical JSON for object insertion-order permutations", () => {
    const left = {
      requestId: "req_1",
      expected: { credentialId: "credential_1", generation: 2 },
    };
    const right = {
      expected: { generation: 2, credentialId: "credential_1" },
      requestId: "req_1",
    };

    expect(canonicalJsonStringify(left)).toBe(canonicalJsonStringify(right));
  });

  it("rejects JavaScript-only values instead of silently changing digest input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = Array.from({ length: 1 });
    delete sparse[0];

    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      new Date("2026-08-08T00:00:00.000Z"),
      new Map([["key", "value"]]),
      { missing: undefined },
      { executable: () => undefined },
      cyclic,
      sparse,
    ]) {
      expect(() => canonicalJsonStringify(value)).toThrow(/finite, acyclic JSON data tree/iu);
    }
  });

  it("rejects array accessors without invoking them", () => {
    const accessor: unknown[] = [];
    let invoked = false;
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return "value";
      },
    });
    accessor.length = 1;

    expect(() => canonicalJsonStringify(accessor)).toThrow(
      /finite, acyclic JSON data tree/iu
    );
    expect(invoked).toBe(false);
  });

  it("rejects non-enumerable array indexes and extra own properties", () => {
    const nonEnumerable = ["value"];
    Object.defineProperty(nonEnumerable, "0", {
      enumerable: false,
      value: "value",
    });
    const named = ["value"] as unknown[] & { metadata?: string };
    named.metadata = "extra";
    const symbol = ["value"];
    Object.defineProperty(symbol, Symbol("extra"), { value: "extra" });

    for (const value of [nonEnumerable, named, symbol]) {
      expect(() => canonicalJsonStringify(value)).toThrow(
        /finite, acyclic JSON data tree/iu
      );
    }
  });

  it("does not collapse canonically distinct Unicode strings", () => {
    expect(canonicalJsonStringify({ value: "\u00e9" })).not.toBe(
      canonicalJsonStringify({ value: "e\u0301" })
    );
  });
});
