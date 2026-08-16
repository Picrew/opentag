import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path: string) => readFile(resolve(repositoryRoot, path), "utf8");

describe("Control Plane deployment contract", () => {
  it("uses one OCI image for migrations, bootstrap, HTTP, and durable jobs", async () => {
    const compose = await read("deploy/compose/compose.yaml");
    expect(compose).toContain("postgres:");
    expect(compose).toContain("migrate:");
    expect(compose).toContain("bootstrap-admin:");
    expect(compose).toContain("control-plane:");
    expect(compose).toContain("jobs:");
    expect(compose.match(/image: opentag-control-plane:local/gu)).toHaveLength(4);
    expect(compose).toContain('["node", "apps/control-plane/dist/index.js", "migrate"]');
    expect(compose).toContain('["node", "apps/control-plane/dist/index.js", "jobs"]');
    expect(compose).toContain("<<: *control-plane-environment");
    expect(compose).toContain("${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}");
    expect(compose).not.toContain("local-only-change-me");
    expect(compose).toContain("${OPENTAG_BIND_ADDRESS:-127.0.0.1}");
    expect(
      compose.match(/^\s+OPENTAG_BOOTSTRAP_ADMIN_PASSWORD:/gmu),
    ).toHaveLength(1);
    expect(compose.indexOf("OPENTAG_BOOTSTRAP_ADMIN_PASSWORD:")).toBeGreaterThan(
      compose.indexOf("bootstrap-admin:"),
    );
  });

  it("makes the PostgreSQL lifecycle corpus mandatory in CI", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    expect(workflow).toContain("postgres:17-alpine");
    expect(workflow).toContain("OPENTAG_REQUIRE_TEST_DATABASE: \"1\"");
    expect(workflow).toContain("OPENTAG_TEST_DATABASE_URL:");
  });

  it("builds a Node image without Cloudflare, SQLite, Redis, or a broker", async () => {
    const [dockerfile, packageJson] = await Promise.all([
      read("apps/control-plane/Dockerfile"),
      read("apps/control-plane/package.json"),
    ]);
    expect(dockerfile).toContain("FROM node:22");
    expect(dockerfile).toContain("USER opentag");
    expect(dockerfile).toContain("--ignore-scripts");
    expect(dockerfile).toContain("pnpm rebuild esbuild");
    expect(dockerfile).toContain(
      "npm pkg delete devDependencies --prefix apps/control-plane",
    );
    expect(dockerfile).toContain("deploy --prod --no-optional /output");
    expect(dockerfile).toContain("/output/node_modules");
    expect(dockerfile).toContain(
      "COPY packages/client/package.json packages/client/package.json",
    );
    expect(dockerfile).toContain(
      "COPY packages/core/package.json packages/core/package.json",
    );
    expect(dockerfile).toContain('CMD ["node", "apps/control-plane/dist/index.js", "serve"]');
    for (const forbidden of ["cloudflare", "wrangler", "sqlite", "redis", "kafka"] ) {
      expect(`${dockerfile}\n${packageJson}`.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("keeps private app metadata and workspace references aligned", async () => {
    const [rootPackage, appPackage, clientTsconfig, protocolTsup] =
      await Promise.all([
        read("package.json"),
      read("apps/control-plane/package.json"),
      read("packages/client/tsconfig.json"),
      read("packages/control-protocol/tsup.config.ts"),
      ]);
    const root = JSON.parse(rootPackage) as {
      devDependencies: Record<string, string>;
      pnpm: { overrides: Record<string, string> };
    };
    const app = JSON.parse(appPackage) as {
      devDependencies: Record<string, string>;
      version: string;
    };
    expect(app.version).toBe("0.0.0");
    expect(app.devDependencies.vite).toBe("^8.2.1");
    expect(root.devDependencies.vite).toBe("^6.4.3");
    expect(root.pnpm.overrides.vite).toBeUndefined();
    expect(root.pnpm.overrides["vite@<8"]).toBe("^6.4.3");
    expect(clientTsconfig).toContain('{ "path": "../control-protocol" }');
    expect(protocolTsup).not.toContain('entry: ["src/**/*.ts"]');
    expect(protocolTsup).toContain('"src/canonical-json.ts"');
    expect(protocolTsup).toContain('"src/completion.ts"');
    expect(protocolTsup).toContain('"src/credential-safety.ts"');
  });

  it("advertises the exact private Control Plane package version", async () => {
    const [runtime, packageJson] = await Promise.all([
      read("apps/control-plane/src/runtime.ts"),
      read("apps/control-plane/package.json"),
    ]);
    const version = (JSON.parse(packageJson) as { version: string }).version;
    expect(runtime).toContain(`packageVersion: "${version}"`);
  });

  it("documents the production fencing and login-throttle configuration", async () => {
    const [
      configuration,
      deployment,
      composeReadme,
      appReadme,
      compose,
      browserE2e,
    ] =
      await Promise.all([
        read("docs/configuration.md"),
        read("docs/control-plane-deployment.md"),
        read("deploy/compose/README.md"),
        read("apps/control-plane/README.md"),
        read("deploy/compose/compose.yaml"),
        read("scripts/test/control-plane-browser-e2e.mjs"),
      ]);

    for (const variable of [
      "OPENTAG_FENCING_TOKEN_SECRET",
      "OPENTAG_LOGIN_THROTTLE_SECRET",
      "OPENTAG_LOGIN_NETWORK_THROTTLE_MODE",
      "OPENTAG_LOGIN_MAX_FAILURES",
      "OPENTAG_LOGIN_WINDOW_MS",
      "OPENTAG_LOGIN_LOCKOUT_MS",
    ]) {
      expect(configuration).toContain(variable);
      expect(deployment).toContain(variable);
      expect(compose).toContain(variable);
    }
    expect(configuration).toContain("OpenTag Control Plane");
    expect(deployment).toContain("fencing-token digest");
    expect(composeReadme).toContain(
      "independently generated fencing-token and login-throttle secrets",
    );
    expect(appReadme).toMatch(/never\s+persists the live fencing token/u);
    expect(browserE2e).toContain(
      "`OPENTAG_FENCING_TOKEN_SECRET=${fencingTokenSecret}`",
    );
    expect(browserE2e).toContain(
      "`OPENTAG_LOGIN_THROTTLE_SECRET=${loginThrottleSecret}`",
    );
  });
});
