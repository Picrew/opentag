import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.OPENTAG_E2E_BASE_URL;

if (!baseURL) throw new Error("OPENTAG_E2E_BASE_URL is required");

export default defineConfig({
  testDir: "./e2e/specs",
  fullyParallel: false,
  forbidOnly: true,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: "../../test-results/control-plane",
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: "../../playwright-report/control-plane" }]]
    : "line",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
