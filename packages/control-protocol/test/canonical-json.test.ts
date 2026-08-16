import { describe, expect, it } from "vitest";
import { canonicalJsonStringify } from "../src/canonical-json.js";

describe("canonical JSON", () => {
  it("preserves lexical code-unit order for integer-like object keys", () => {
    expect(canonicalJsonStringify({ "10": "ten", "2": "two", a: "letter" }))
      .toBe('{"10":"ten","2":"two","a":"letter"}');
  });
});
