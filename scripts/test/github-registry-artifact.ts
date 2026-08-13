import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;
const TRUSTED_NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";

type PackageJson = {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
  main?: unknown;
  exports?: unknown;
};

type PackageLock = {
  packages?: Record<string, {
    version?: unknown;
    resolved?: unknown;
    integrity?: unknown;
  }>;
};

export type GitHubRegistryRuntimeArtifact = {
  expectedVersion: string;
  package: "@opentag/cli";
  version: string;
  registry: string;
  resolved: string;
  integrity: string;
  sourceNormalizer: {
    package: "@opentag/github";
    version: string;
    resolved: string;
    integrity: string;
  };
  eventSchema: {
    package: "@opentag/core";
    version: string;
    resolved: string;
    integrity: string;
  };
};

export type RegistryCliArtifactInspection = {
  runtimeArtifact: GitHubRegistryRuntimeArtifact;
  installation: {
    cliPackageRoot: string;
    githubEntrypoint: string;
    coreEntrypoint: string;
  };
};

export type RegistryPackageReceipt = {
  package: string;
  version: string;
  registry: string;
  resolved: string;
  integrity: string;
};

export type RegistryCliPackageSetInspection = {
  expectedVersion: string;
  executable: RegistryPackageReceipt;
  packages: Record<string, RegistryPackageReceipt>;
};

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function isSha512Integrity(value: string): boolean {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  return Boolean(match?.[1] && Buffer.from(match[1], "base64").byteLength === 64);
}

async function findPackageRoot(entrypoint: string, expectedName: string): Promise<string> {
  let current = dirname(await realpath(entrypoint));
  while (true) {
    try {
      const manifest = object(await readJson(join(current, "package.json")), `${expectedName} package manifest`);
      if (manifest["name"] === expectedName) return current;
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not find the ${expectedName} package root for ${entrypoint}.`);
}

function packageLockKey(installRoot: string, packageRoot: string): string {
  return relative(installRoot, packageRoot).split(sep).join("/");
}

async function findLockfileEntry(packageRoot: string, expectedName: string) {
  let current = packageRoot;
  while (true) {
    try {
      const lock = object(await readJson(join(current, "package-lock.json")), "npm package lock") as PackageLock;
      const key = packageLockKey(current, packageRoot);
      const entry = lock.packages?.[key];
      if (entry) return { installRoot: current, entry };
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not find npm lockfile provenance for ${expectedName}.`);
}

function packageNameSegments(packageName: string): string[] {
  return packageName.split("/").filter(Boolean);
}

async function resolveInstalledDependencyRoot(fromPackageRoot: string, packageName: string): Promise<string> {
  let current = fromPackageRoot;
  while (true) {
    const candidate = join(current, "node_modules", ...packageNameSegments(packageName));
    try {
      const manifest = object(await readJson(join(candidate, "package.json")), `${packageName} package manifest`);
      if (manifest["name"] === packageName) return candidate;
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not resolve installed dependency ${packageName} from @opentag/cli.`);
}

async function packageImportEntrypoint(packageRoot: string, packageName: string): Promise<string> {
  const manifest = object(await readJson(join(packageRoot, "package.json")), `${packageName} package manifest`) as PackageJson;
  let entrypoint: unknown;
  if (typeof manifest.exports === "string") {
    entrypoint = manifest.exports;
  } else if (manifest.exports && typeof manifest.exports === "object" && !Array.isArray(manifest.exports)) {
    const rootExport = (manifest.exports as JsonObject)["."];
    if (typeof rootExport === "string") {
      entrypoint = rootExport;
    } else if (rootExport && typeof rootExport === "object" && !Array.isArray(rootExport)) {
      const conditions = rootExport as JsonObject;
      entrypoint = conditions["import"] ?? conditions["default"];
    }
  }
  entrypoint ??= manifest.main;
  return realpath(resolve(packageRoot, string(entrypoint, `${packageName} import entrypoint`)));
}

async function inspectInstalledPackage(
  entrypoint: string,
  expectedName: string,
  expectedVersion: string
): Promise<{
  packageRoot: string;
  version: string;
  registry: string;
  resolved: string;
  integrity: string;
}> {
  const packageRoot = await findPackageRoot(entrypoint, expectedName);
  const manifest = object(await readJson(join(packageRoot, "package.json")), `${expectedName} package manifest`) as PackageJson;
  const name = string(manifest.name, `${expectedName} package name`);
  const version = string(manifest.version, `${expectedName} package version`);
  if (name !== expectedName) throw new Error(`Resolved ${name}; expected ${expectedName}.`);
  if (version !== expectedVersion) throw new Error(`${expectedName} is ${version}; expected ${expectedVersion}.`);

  const { entry } = await findLockfileEntry(packageRoot, expectedName);
  const lockedVersion = string(entry.version, `${expectedName} lockfile version`);
  const resolvedUrl = string(entry.resolved, `${expectedName} resolved artifact`);
  const integrity = string(entry.integrity, `${expectedName} lockfile integrity`);
  if (lockedVersion !== version) {
    throw new Error(`${expectedName} lockfile version ${lockedVersion} does not match installed version ${version}.`);
  }
  if (!isSha512Integrity(integrity)) {
    throw new Error(`${expectedName} lockfile integrity must be a sha512 receipt.`);
  }
  const parsedUrl = new URL(resolvedUrl);
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`${expectedName} resolved artifact must use HTTPS.`);
  }
  if (parsedUrl.origin !== TRUSTED_NPM_REGISTRY_ORIGIN) {
    throw new Error(`${expectedName} resolved artifact must use the trusted npm registry.`);
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error(`${expectedName} resolved artifact URL must not contain credentials, query parameters, or fragments.`);
  }
  return {
    packageRoot,
    version,
    registry: parsedUrl.origin,
    resolved: resolvedUrl,
    integrity
  };
}

function executableVersion(cliBin: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(cliBin, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...(env ?? process.env), NODE_OPTIONS: "" }
    }, (error, stdout) => {
      if (error) {
        reject(new Error(`Installed OpenTag CLI --version failed: ${error.message}`));
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

export async function inspectRegistryCliPackageSet(input: {
  cliBin: string;
  expectedVersion: string;
  packageNames: string[];
  executableEnv?: NodeJS.ProcessEnv;
}): Promise<RegistryCliPackageSetInspection> {
  const expectedVersion = string(input.expectedVersion, "expected registry CLI version");
  const cliBin = await realpath(resolve(input.cliBin));
  const cli = await inspectInstalledPackage(cliBin, "@opentag/cli", expectedVersion);
  const manifest = object(await readJson(join(cli.packageRoot, "package.json")), "@opentag/cli package manifest") as PackageJson;
  const bin = object(manifest.bin, "@opentag/cli bin map");
  const expectedEntrypoint = await realpath(resolve(cli.packageRoot, string(bin["opentag"], "@opentag/cli bin entry")));
  if (expectedEntrypoint !== cliBin) {
    throw new Error("Installed OpenTag executable does not match the @opentag/cli bin entry.");
  }
  const reportedVersion = await executableVersion(cliBin, input.executableEnv);
  if (reportedVersion !== expectedVersion) {
    throw new Error(`Installed OpenTag executable reports ${reportedVersion}; expected ${expectedVersion}.`);
  }

  const packages: Record<string, RegistryPackageReceipt> = {};
  for (const packageName of [...new Set(input.packageNames)]) {
    if (!packageName.startsWith("@opentag/") || packageName === "@opentag/cli") {
      throw new Error(`Registry provider package must be an @opentag/* dependency other than @opentag/cli: ${packageName}`);
    }
    const packageRoot = await resolveInstalledDependencyRoot(cli.packageRoot, packageName);
    const entrypoint = await packageImportEntrypoint(packageRoot, packageName);
    const inspected = await inspectInstalledPackage(entrypoint, packageName, expectedVersion);
    packages[packageName] = {
      package: packageName,
      version: inspected.version,
      registry: inspected.registry,
      resolved: inspected.resolved,
      integrity: inspected.integrity
    };
  }

  return {
    expectedVersion,
    executable: {
      package: "@opentag/cli",
      version: cli.version,
      registry: cli.registry,
      resolved: cli.resolved,
      integrity: cli.integrity
    },
    packages
  };
}

export async function inspectRegistryInstalledDependency(input: {
  cliBin: string;
  packageName: string;
  expectedVersion?: string;
}): Promise<RegistryPackageReceipt> {
  const packageName = string(input.packageName, "registry dependency package name");
  const segments = packageNameSegments(packageName);
  if (
    segments.length === 0 ||
    segments.length > 2 ||
    segments.some((segment) => segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/u.test(segment))
  ) {
    throw new Error(`Invalid registry dependency package name: ${packageName}`);
  }
  const cliBin = await realpath(resolve(input.cliBin));
  const cliRoot = await findPackageRoot(cliBin, "@opentag/cli");
  const packageRoot = await resolveInstalledDependencyRoot(cliRoot, packageName);
  const manifest = object(await readJson(join(packageRoot, "package.json")), `${packageName} package manifest`) as PackageJson;
  const version = string(manifest.version, `${packageName} package version`);
  const expectedVersion =
    input.expectedVersion === undefined
      ? version
      : string(input.expectedVersion, `expected ${packageName} package version`);
  const entrypoint = await packageImportEntrypoint(packageRoot, packageName);
  const inspected = await inspectInstalledPackage(entrypoint, packageName, expectedVersion);
  return {
    package: packageName,
    version: inspected.version,
    registry: inspected.registry,
    resolved: inspected.resolved,
    integrity: inspected.integrity
  };
}

export async function inspectRegistryCliArtifact(input: {
  cliBin: string;
  expectedVersion: string;
}): Promise<RegistryCliArtifactInspection> {
  const expectedVersion = string(input.expectedVersion, "expected registry CLI version");
  const cliBin = await realpath(resolve(input.cliBin));
  const cli = await inspectInstalledPackage(cliBin, "@opentag/cli", expectedVersion);
  const manifest = object(await readJson(join(cli.packageRoot, "package.json")), "@opentag/cli package manifest") as PackageJson;
  const bin = object(manifest.bin, "@opentag/cli bin map");
  const expectedEntrypoint = await realpath(resolve(cli.packageRoot, string(bin["opentag"], "@opentag/cli bin entry")));
  if (expectedEntrypoint !== cliBin) {
    throw new Error(`Installed OpenTag executable does not match the @opentag/cli bin entry.`);
  }
  const reportedVersion = await executableVersion(cliBin);
  if (reportedVersion !== expectedVersion) {
    throw new Error(`Installed OpenTag executable reports ${reportedVersion}; expected ${expectedVersion}.`);
  }

  const githubRoot = await resolveInstalledDependencyRoot(cli.packageRoot, "@opentag/github");
  const coreRoot = await resolveInstalledDependencyRoot(cli.packageRoot, "@opentag/core");
  const githubEntrypoint = await packageImportEntrypoint(githubRoot, "@opentag/github");
  const coreEntrypoint = await packageImportEntrypoint(coreRoot, "@opentag/core");
  const github = await inspectInstalledPackage(githubEntrypoint, "@opentag/github", expectedVersion);
  const core = await inspectInstalledPackage(coreEntrypoint, "@opentag/core", expectedVersion);

  return {
    runtimeArtifact: {
      expectedVersion,
      package: "@opentag/cli",
      version: cli.version,
      registry: cli.registry,
      resolved: cli.resolved,
      integrity: cli.integrity,
      sourceNormalizer: {
        package: "@opentag/github",
        version: github.version,
        resolved: github.resolved,
        integrity: github.integrity
      },
      eventSchema: {
        package: "@opentag/core",
        version: core.version,
        resolved: core.resolved,
        integrity: core.integrity
      }
    },
    installation: {
      cliPackageRoot: cli.packageRoot,
      githubEntrypoint,
      coreEntrypoint
    }
  };
}

export async function normalizeRegistryGitHubFactorySourceEvent(
  inspection: RegistryCliArtifactInspection,
  input: unknown
): Promise<unknown> {
  const github = await import(pathToFileURL(inspection.installation.githubEntrypoint).href) as {
    normalizeGitHubIssueComment?: (value: unknown) => unknown;
  };
  const core = await import(pathToFileURL(inspection.installation.coreEntrypoint).href) as {
    OpenTagEventSchema?: { parse(value: unknown): unknown };
  };
  if (typeof github.normalizeGitHubIssueComment !== "function") {
    throw new Error("Installed @opentag/github does not export normalizeGitHubIssueComment.");
  }
  if (!core.OpenTagEventSchema || typeof core.OpenTagEventSchema.parse !== "function") {
    throw new Error("Installed @opentag/core does not export OpenTagEventSchema.");
  }
  const event = github.normalizeGitHubIssueComment(input);
  if (!event) throw new Error("GitHub factory source comment does not contain a valid @opentag command.");
  return core.OpenTagEventSchema.parse(event);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function main(argv: string[]): Promise<void> {
  const [command, first, second, third, ...rest] = argv;
  if (rest.length > 0 || !first || !second || !third || (command !== "inspect" && command !== "event")) {
    throw new Error(
      "Usage: github-registry-artifact.ts inspect <cli-bin> <expected-version> <output.json> | event <inspection.json> <input.json> <output.json>"
    );
  }
  if (command === "inspect") {
    await writePrivateJson(third, await inspectRegistryCliArtifact({ cliBin: first, expectedVersion: second }));
    return;
  }
  const inspection = await readJson(first) as RegistryCliArtifactInspection;
  await writePrivateJson(third, await normalizeRegistryGitHubFactorySourceEvent(inspection, await readJson(second)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
