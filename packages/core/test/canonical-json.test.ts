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
});
