import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleAssetApplication } from "../src/console-assets.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function createAssets() {
  const directory = await mkdtemp(join(tmpdir(), "opentag-console-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<main>OpenTag Console</main>");
  await writeFile(join(directory, "assets", "app.js"), "console.log('ok')");
  return directory;
}

describe("Node console asset application", () => {
  it("serves immutable assets and uses the SPA document for console routes", async () => {
    const assetsDirectory = await createAssets();
    const application = createConsoleAssetApplication({
      assetsDirectory,
      application: {
        fetch: async () => new Response("api", { status: 202 }),
      },
    });

    const asset = await application.fetch(
      new Request("http://control.test/assets/app.js"),
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await asset.text()).toBe("console.log('ok')");

    const consoleRoute = await application.fetch(
      new Request("http://control.test/runners/runner-1"),
    );
    expect(consoleRoute.status).toBe(200);
    expect(consoleRoute.headers.get("cache-control")).toBe("no-store");
    expect(consoleRoute.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(consoleRoute.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await consoleRoute.text()).toContain("OpenTag Console");
  });

  it("delegates APIs even when console assets are absent", async () => {
    const application = createConsoleAssetApplication({
      assetsDirectory: join(tmpdir(), "opentag-console-does-not-exist"),
      application: {
        fetch: async (request) => {
          const pathname = new URL(request.url).pathname;
          return pathname.startsWith("/v1/")
            ? Response.json({ pathname })
            : new Response(null, { status: 404 });
        },
      },
    });

    const response = await application.fetch(
      new Request("http://control.test/v1/relay/capabilities"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      pathname: "/v1/relay/capabilities",
    });

    const consoleRoute = await application.fetch(
      new Request("http://control.test/dashboard"),
    );
    expect(consoleRoute.status).toBe(404);
  });
});
