import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RunnerLocalitySchema } from "../src/routing.js";

describe("public Zod schemas", () => {
  it("compose with the package's Zod 4 dependency", () => {
    const composed = z.object({ locality: RunnerLocalitySchema });

    expect(composed.parse({ locality: "local" })).toEqual({ locality: "local" });
    expect(() => RunnerLocalitySchema.parse("invalid")).toThrow(z.ZodError);
  });
});
