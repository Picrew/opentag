import { createOpenTagClient } from "@opentag/client";
import { expect, signIn, test } from "../fixtures.js";

const runId = process.env.OPENTAG_E2E_RUN_ID!;
const runnerId = `runner_e2e_${runId}`;
const targetId = `target_e2e_${runId}`;
const bindingId = `binding_e2e_${runId}`;
const apiKeyLabel = `browser-e2e-${runId}`;

test("protects the console and authenticates the bootstrapped owner", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/u);
  await expect(page.getByRole("heading", {
    name: /Operate your runners without moving their workspaces/u,
  })).toBeVisible();

  await page.getByLabel("Email").fill(process.env.OPENTAG_E2E_ADMIN_EMAIL!);
  await page.getByLabel("Password").fill("wrong password value");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(
    "The email, password, or organization was not accepted.",
  )).toBeVisible();

  await signIn(page);
  const workspace = page.getByRole("main");
  for (const metric of ["Runners", "Ready", "Active runs", "Terminal runs", "Pending jobs"]) {
    await expect(workspace.getByText(metric, { exact: true })).toBeVisible();
  }

  await page.reload();
  await expect(page.getByRole("heading", { name: "System overview" })).toBeVisible();
  await page.getByRole("link", { name: "Profile" }).click();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(page.getByRole("main").getByText(
    process.env.OPENTAG_E2E_ADMIN_EMAIL!,
  )).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/u);
  await page.goto("/security");
  await expect(page).toHaveURL(/\/login$/u);
});

test("creates, persists, and revokes an API key through the real console", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("link", { name: "API keys" }).click();
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

  await page.getByLabel("Key label").fill(apiKeyLabel);
  await page.getByLabel("Allow governed permission decisions").check();
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith("/api/console/api-keys")
      && response.request().method() === "POST"
      && response.status() === 201),
    page.getByRole("button", { name: "Create API key" }).click(),
  ]);
  await expect(page.getByText("Copy this token now.")).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: apiKeyLabel });
  await expect(row).toContainText("permission:resolve");
  await expect(row).toContainText("active");

  await page.reload();
  await expect(page.getByText("Copy this token now.")).toHaveCount(0);
  const persistedRow = page.getByRole("row").filter({ hasText: apiKeyLabel });
  await expect(persistedRow).toContainText("active");
  await persistedRow.getByRole("button", { name: "Revoke" }).click();
  await expect(persistedRow).toContainText("revoked");
});

test("pairs a real runner and declares a persistent target and GitHub binding", async ({
  page,
  request,
}) => {
  const client = createOpenTagClient({
    dispatcherUrl: process.env.OPENTAG_E2E_BASE_URL!,
    controlCredential: {
      kind: "bootstrap_pairing",
      token: process.env.OPENTAG_E2E_PAIRING_TOKEN!,
    },
  });
  const registered = await client.registerRunnerControlV1({
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.registration.v1"],
    requestId: `request_e2e_${runId}`,
    operationId: `operation_e2e_${runId}`,
    runnerId,
    capabilities: [
      "relay.claim-fence.v1",
      "relay.hosted-admission.v1",
      "relay.hosted-claim.v1",
      "relay.lifecycle.v1",
      "relay.readiness.v1",
    ],
  });
  expect(registered.replayed).toBe(false);

  await signIn(page);
  await page.getByRole("link", { name: "Runners" }).click();
  await expect(page.getByRole("row").filter({ hasText: runnerId })).toContainText(
    "not reported",
  );

  await page.getByRole("link", { name: "Targets" }).click();
  await page.getByLabel("Target ID").fill(targetId);
  await page.getByLabel("Runner ID").fill(runnerId);
  await page.getByLabel("Repository owner").fill("e2e-owner");
  await page.getByLabel("Repository name").fill("e2e-repo");
  await page.getByLabel("Binding digest").fill(`sha256:${"a".repeat(64)}`);
  await page.getByLabel("Default executor").fill("executor_acp");
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith("/api/console/project-targets")
      && response.request().method() === "POST"
      && response.status() === 201),
    page.getByRole("button", { name: "Declare Project Target" }).click(),
  ]);
  await expect(page.getByRole("row").filter({ hasText: targetId })).toContainText(
    "e2e-owner/e2e-repo",
  );

  await page.getByLabel("Binding ID").fill(bindingId);
  await page.getByLabel("GitHub repository ID").fill(`9${runId.replaceAll(/\D/gu, "").slice(-8) || "1"}`);
  await page.getByLabel("Allowed actor IDs").fill("1001, 1002");
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith("/api/console/github-bindings")
      && response.request().method() === "POST"
      && response.status() === 201),
    page.getByRole("button", { name: "Create enabled binding" }).click(),
  ]);
  await expect(page.getByText("Copy the webhook secret now.")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: bindingId })).toContainText(
    "enabled",
  );

  await page.reload();
  await expect(page.getByText("Copy the webhook secret now.")).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: bindingId })).toContainText(
    "enabled",
  );

  const rejected = await request.post("/api/console/api-keys", {
    headers: { origin: "https://untrusted.example" },
    data: { label: "forbidden", scopes: ["run:read"] },
  });
  expect(rejected.status()).toBe(403);
  expect(await rejected.json()).toEqual({ error: "forbidden_origin" });
});
