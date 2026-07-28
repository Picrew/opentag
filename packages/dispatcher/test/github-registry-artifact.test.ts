import { createHash } from "node:crypto";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  inspectRegistryCliArtifact,
  inspectRegistryCliPackageSet,
  normalizeRegistryGitHubFactorySourceEvent
} from "../../../scripts/test/github-registry-artifact.js";

const integrity = `sha512-${createHash("sha512").update("registry-artifact-fixture").digest("base64")}`;

async function createRegistryInstall(
  version = "0.8.0",
  lockPackageRoot = "node_modules",
  registryOrigin = "https://registry.npmjs.org"
) {
  const root = await mkdtemp(join(tmpdir(), "opentag-registry-artifact-"));
  const cliRoot = join(root, "node_modules", "@opentag", "cli");
  const githubRoot = join(root, "node_modules", "@opentag", "github");
  const coreRoot = join(root, "node_modules", "@opentag", "core");
  const slackRoot = join(root, "node_modules", "@opentag", "slack");
  const linearRoot = join(root, "node_modules", "@opentag", "linear");
  const binRoot = join(root, "node_modules", ".bin");
  await Promise.all([
    mkdir(join(cliRoot, "dist"), { recursive: true }),
    mkdir(join(githubRoot, "dist"), { recursive: true }),
    mkdir(join(coreRoot, "dist"), { recursive: true }),
    mkdir(join(slackRoot, "dist"), { recursive: true }),
    mkdir(join(linearRoot, "dist"), { recursive: true }),
    mkdir(binRoot, { recursive: true })
  ]);

  await writeFile(join(cliRoot, "package.json"), JSON.stringify({
    name: "@opentag/cli",
    version,
    type: "module",
    bin: { opentag: "./dist/index.js" },
    dependencies: {
      "@opentag/core": version,
      "@opentag/github": version,
      "@opentag/linear": version,
      "@opentag/slack": version
    }
  }));
  await writeFile(
    join(cliRoot, "dist", "index.js"),
    `#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log(${JSON.stringify(version)});\n`
  );
  await chmod(join(cliRoot, "dist", "index.js"), 0o755);

  await writeFile(join(githubRoot, "package.json"), JSON.stringify({
    name: "@opentag/github",
    version,
    type: "module",
    main: "./dist/index.js",
    exports: { ".": "./dist/index.js" }
  }));
  await writeFile(
    join(githubRoot, "dist", "index.js"),
    "export const normalizeGitHubIssueComment = (input) => ({ id: `registry_${input.id}`, marker: 'registry-github' });\n"
  );

  await writeFile(join(coreRoot, "package.json"), JSON.stringify({
    name: "@opentag/core",
    version,
    type: "module",
    main: "./dist/index.js",
    exports: { ".": "./dist/index.js" }
  }));
  await writeFile(
    join(coreRoot, "dist", "index.js"),
    "export const OpenTagEventSchema = { parse: (value) => ({ ...value, marker: `${value.marker}+registry-core` }) };\n"
  );

  for (const [packageRoot, packageName] of [
    [slackRoot, "@opentag/slack"],
    [linearRoot, "@opentag/linear"]
  ] as const) {
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: packageName,
      version,
      type: "module",
      main: "./dist/index.js",
      exports: { ".": "./dist/index.js" }
    }));
    await writeFile(join(packageRoot, "dist", "index.js"), "export const registryFixture = true;\n");
  }

  await symlink("../@opentag/cli/dist/index.js", join(binRoot, "opentag"));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({
    name: "registry-fixture",
    lockfileVersion: 3,
    packages: {
      [`${lockPackageRoot}/@opentag/cli`]: {
        version,
        resolved: `${registryOrigin}/@opentag/cli/-/cli-${version}.tgz`,
        integrity
      },
      [`${lockPackageRoot}/@opentag/github`]: {
        version,
        resolved: `${registryOrigin}/@opentag/github/-/github-${version}.tgz`,
        integrity
      },
      [`${lockPackageRoot}/@opentag/core`]: {
        version,
        resolved: `${registryOrigin}/@opentag/core/-/core-${version}.tgz`,
        integrity
      },
      [`${lockPackageRoot}/@opentag/slack`]: {
        version,
        resolved: `${registryOrigin}/@opentag/slack/-/slack-${version}.tgz`,
        integrity
      },
      [`${lockPackageRoot}/@opentag/linear`]: {
        version,
        resolved: `${registryOrigin}/@opentag/linear/-/linear-${version}.tgz`,
        integrity
      }
    }
  }));

  return { root, cliBin: join(binRoot, "opentag") };
}

describe("GitHub registry artifact acceptance", () => {
  it("binds the executable, source normalizer, and event schema to registry lockfile integrity", async () => {
    const fixture = await createRegistryInstall();
    const previousNodeOptions = process.env["NODE_OPTIONS"];
    process.env["NODE_OPTIONS"] = "--conditions=development";
    let inspection: Awaited<ReturnType<typeof inspectRegistryCliArtifact>>;
    try {
      inspection = await inspectRegistryCliArtifact({
        cliBin: fixture.cliBin,
        expectedVersion: "0.8.0"
      });
    } finally {
      if (previousNodeOptions === undefined) delete process.env["NODE_OPTIONS"];
      else process.env["NODE_OPTIONS"] = previousNodeOptions;
    }

    expect(inspection.runtimeArtifact).toMatchObject({
      expectedVersion: "0.8.0",
      package: "@opentag/cli",
      version: "0.8.0",
      registry: "https://registry.npmjs.org",
      integrity,
      sourceNormalizer: {
        package: "@opentag/github",
        version: "0.8.0",
        integrity
      },
      eventSchema: {
        package: "@opentag/core",
        version: "0.8.0",
        integrity
      }
    });

    await expect(normalizeRegistryGitHubFactorySourceEvent(inspection, { id: "100" }))
      .resolves.toMatchObject({ id: "registry_100", marker: "registry-github+registry-core" });
  });

  it("binds an arbitrary installed OpenTag provider set to the same registry version and lockfile", async () => {
    const fixture = await createRegistryInstall("0.9.0");

    const inspection = await inspectRegistryCliPackageSet({
      cliBin: fixture.cliBin,
      expectedVersion: "0.9.0",
      packageNames: ["@opentag/slack", "@opentag/linear", "@opentag/core"]
    });

    expect(inspection).toMatchObject({
      expectedVersion: "0.9.0",
      executable: {
        package: "@opentag/cli",
        version: "0.9.0",
        registry: "https://registry.npmjs.org",
        integrity
      },
      packages: {
        "@opentag/slack": { version: "0.9.0", integrity },
        "@opentag/linear": { version: "0.9.0", integrity },
        "@opentag/core": { version: "0.9.0", integrity }
      }
    });
  });

  it("fails closed for a stale installed candidate", async () => {
    const fixture = await createRegistryInstall("0.7.0");

    await expect(inspectRegistryCliArtifact({
      cliBin: fixture.cliBin,
      expectedVersion: "0.8.0"
    })).rejects.toThrow(/expected 0\.8\.0/u);
  });

  it("rejects an arbitrary executable without npm package provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "opentag-arbitrary-cli-"));
    const cliBin = join(root, "opentag");
    await writeFile(cliBin, "#!/usr/bin/env node\nconsole.log('0.8.0');\n");
    await chmod(cliBin, 0o755);

    await expect(inspectRegistryCliArtifact({ cliBin, expectedVersion: "0.8.0" }))
      .rejects.toThrow(/package root/u);
  });

  it("rejects a same-version lockfile entry for a different install path", async () => {
    const fixture = await createRegistryInstall(
      "0.8.0",
      "node_modules/unrelated/node_modules"
    );

    await expect(inspectRegistryCliArtifact({
      cliBin: fixture.cliBin,
      expectedVersion: "0.8.0"
    })).rejects.toThrow(/lockfile provenance/u);
  });

  it("rejects an artifact resolved from an untrusted HTTPS registry", async () => {
    const fixture = await createRegistryInstall(
      "0.8.0",
      "node_modules",
      "https://packages.example.test"
    );

    await expect(inspectRegistryCliArtifact({
      cliBin: fixture.cliBin,
      expectedVersion: "0.8.0"
    })).rejects.toThrow(/trusted npm registry/u);
  });
});
