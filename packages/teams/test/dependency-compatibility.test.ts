import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Teams transitive dependency compatibility", () => {
  it("publishes the maintained JWT verifier without the vulnerable Bot Framework UUID graph", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    expect(packageJson.dependencies?.["botframework-connector"]).toBeUndefined();
    expect(packageJson.dependencies?.jose).toBe("^6.2.7");
    expect(packageJson.devDependencies?.jose).toBeUndefined();
  });
});
