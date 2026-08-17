import {
  expect,
  test as base,
  type ConsoleMessage,
  type Page,
} from "@playwright/test";

type BrowserDiagnostics = {
  browserDiagnostics: void;
};

const describeResponse = (response: {
  status(): number;
  request(): { method(): string };
  url(): string;
}) => `${response.request().method()} ${response.status()} ${response.url()}`;

export const test = base.extend<BrowserDiagnostics>({
  browserDiagnostics: [async ({ page }, use, testInfo) => {
    const failures: string[] = [];
    const baseOrigin = new URL(process.env.OPENTAG_E2E_BASE_URL!).origin;
    const onConsole = (message: ConsoleMessage) => {
      const expectedSessionRejection = message.text().startsWith(
        "Failed to load resource: the server responded with a status of 401",
      ) && message.location().url.endsWith("/api/console/session");
      if (expectedSessionRejection) return;
      if (message.type() === "error" || message.type() === "warning") {
        failures.push(`console.${message.type()}: ${message.text()}`);
      }
    };
    const onPageError = (error: Error) => failures.push(`pageerror: ${error.message}`);
    const onResponse = (response: Parameters<typeof describeResponse>[0]) => {
      if (new URL(response.url()).origin === baseOrigin && response.status() >= 500) {
        failures.push(`network: ${describeResponse(response)}`);
      }
    };

    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("response", onResponse);
    await use();
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("response", onResponse);

    if (failures.length > 0) {
      await testInfo.attach("browser-diagnostics", {
        body: failures.join("\n"),
        contentType: "text/plain",
      });
    }
    expect(failures, "browser console/page/network diagnostics").toEqual([]);
  }, { auto: true }],
});

export { expect };

export async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.OPENTAG_E2E_ADMIN_EMAIL!);
  await page.getByLabel("Password").fill(process.env.OPENTAG_E2E_ADMIN_PASSWORD!);
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith("/api/console/session")
      && response.request().method() === "POST"
      && response.status() === 200),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole("heading", { name: "System overview" })).toBeVisible();
}
