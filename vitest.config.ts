import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    globals: false,
    testTimeout: process.env.CI ? 15_000 : 5_000
  },
  resolve: {
    conditions: ["development"]
  }
});
