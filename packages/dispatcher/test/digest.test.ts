import { describe, expect, it } from "vitest";
import { sha256Digest } from "../src/digest.js";

describe("dispatcher durable digests", () => {
  it("uses stable code-unit ordering across hosts", () => {
    expect(sha256Digest({ z: 1, "ä": 2, a: 3, "😀": 4 })).toBe(
      "sha256:fb215dbd6cdd5ce98f4e77b27ba82bf88b6376d244e0dbc9323c496101653081"
    );
  });
});
