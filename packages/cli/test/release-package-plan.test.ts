import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildPublicPackagePlan } from "../../../scripts/release/package-plan.mjs";

type PackageManifest = {
  name: string;
  version?: string;
  private?: boolean;
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
};

const temporaryRoots: string[] = [];

function createPackagesDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "opentag-release-package-plan-"));
  temporaryRoots.push(root);
  const packagesDirectory = join(root, "packages");
  mkdirSync(packagesDirectory);
  return packagesDirectory;
}

function writePackage(packagesDirectory: string, directory: string, manifest: PackageManifest): void {
  const packageDirectory = join(packagesDirectory, directory);
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ version: "0.5.0", ...manifest }, null, 2)}\n`
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("public release package plan", () => {
  it("rejects an empty public package set", () => {
    const packagesDirectory = createPackagesDirectory();

    expect(() => buildPublicPackagePlan(packagesDirectory)).toThrow(/no public packages/i);
  });

  it("discovers only packages whose publish access is public", () => {
    const packagesDirectory = createPackagesDirectory();
    writePackage(packagesDirectory, "core", {
      name: "@opentag/core",
      publishConfig: { access: "public" }
    });
    writePackage(packagesDirectory, "internal", {
      name: "@opentag/internal",
      private: true
    });
    writePackage(packagesDirectory, "restricted", {
      name: "@opentag/restricted",
      publishConfig: { access: "restricted" }
    });

    const plan = buildPublicPackagePlan(packagesDirectory);

    expect(plan.map((entry) => entry.packageJson.name)).toEqual(["@opentag/core"]);
    expect(plan.map((entry) => entry.directory)).toEqual(["core"]);
  });

  it("rejects a public package whose runtime OpenTag dependency is absent from the public set", () => {
    const packagesDirectory = createPackagesDirectory();
    writePackage(packagesDirectory, "cli", {
      name: "@opentag/cli",
      publishConfig: { access: "public" },
      dependencies: { "@opentag/internal-runtime": "workspace:*" }
    });
    writePackage(packagesDirectory, "internal-runtime", {
      name: "@opentag/internal-runtime",
      private: true
    });

    expect(() => buildPublicPackagePlan(packagesDirectory)).toThrow(
      /@opentag\/cli.*@opentag\/internal-runtime.*public/i
    );
  });

  it("orders public packages after their runtime OpenTag dependencies", () => {
    const packagesDirectory = createPackagesDirectory();
    writePackage(packagesDirectory, "cli", {
      name: "@opentag/cli",
      publishConfig: { access: "public" },
      dependencies: { "@opentag/client": "workspace:*" }
    });
    writePackage(packagesDirectory, "client", {
      name: "@opentag/client",
      publishConfig: { access: "public" },
      dependencies: { "@opentag/core": "workspace:*" }
    });
    writePackage(packagesDirectory, "core", {
      name: "@opentag/core",
      publishConfig: { access: "public" }
    });

    const plan = buildPublicPackagePlan(packagesDirectory);

    expect(plan.map((entry) => entry.packageJson.name)).toEqual([
      "@opentag/core",
      "@opentag/client",
      "@opentag/cli"
    ]);
  });

  it("rejects cycles in public runtime dependencies", () => {
    const packagesDirectory = createPackagesDirectory();
    writePackage(packagesDirectory, "client", {
      name: "@opentag/client",
      publishConfig: { access: "public" },
      dependencies: { "@opentag/runner": "workspace:*" }
    });
    writePackage(packagesDirectory, "runner", {
      name: "@opentag/runner",
      publishConfig: { access: "public" },
      dependencies: { "@opentag/client": "workspace:*" }
    });

    expect(() => buildPublicPackagePlan(packagesDirectory)).toThrow(/cycle/i);
  });

  it("rejects duplicate public package names", () => {
    const packagesDirectory = createPackagesDirectory();
    writePackage(packagesDirectory, "core-one", {
      name: "@opentag/core",
      publishConfig: { access: "public" }
    });
    writePackage(packagesDirectory, "core-two", {
      name: "@opentag/core",
      publishConfig: { access: "public" }
    });

    expect(() => buildPublicPackagePlan(packagesDirectory)).toThrow(/duplicate.*@opentag\/core/i);
  });

  it("rejects public packages with non-lockstep versions", () => {
    const packagesDirectory = createPackagesDirectory();
    writePackage(packagesDirectory, "core", {
      name: "@opentag/core",
      version: "0.5.0",
      publishConfig: { access: "public" }
    });
    writePackage(packagesDirectory, "client", {
      name: "@opentag/client",
      version: "0.5.1",
      publishConfig: { access: "public" },
      dependencies: { "@opentag/core": "workspace:*" }
    });

    expect(() => buildPublicPackagePlan(packagesDirectory)).toThrow(/lockstep.*0\.5\.0.*0\.5\.1/i);
  });

  it("reports malformed package manifests with their package directory", () => {
    const packagesDirectory = createPackagesDirectory();
    const malformedDirectory = join(packagesDirectory, "malformed");
    mkdirSync(malformedDirectory, { recursive: true });
    writeFileSync(join(malformedDirectory, "package.json"), "{ not-json\n");

    expect(() => buildPublicPackagePlan(packagesDirectory)).toThrow(/malformed.*package\.json/i);
  });

  it("discovers the repository's complete 17-package public release set", () => {
    const repositoryPackagesDirectory = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../packages"
    );

    const plan = buildPublicPackagePlan(repositoryPackagesDirectory);

    expect(plan.map((entry) => entry.packageJson.name).sort()).toEqual([
      "@opentag/cli",
      "@opentag/client",
      "@opentag/core",
      "@opentag/delivery-contract",
      "@opentag/discord",
      "@opentag/dispatcher",
      "@opentag/github",
      "@opentag/gitlab",
      "@opentag/governance",
      "@opentag/lark",
      "@opentag/linear",
      "@opentag/local-runtime",
      "@opentag/runner",
      "@opentag/slack",
      "@opentag/store",
      "@opentag/teams",
      "@opentag/telegram"
    ]);
  });
});
