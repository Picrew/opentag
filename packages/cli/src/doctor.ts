import { createDoctorSummaryPresentation, renderOpenTagPresentationPlainText } from "@opentag/core";
import { doctorHasFailures, executorsFromConfig, runDoctor, type DoctorCheck } from "@opentag/local-runtime";
import { formatConfiguredCapabilities } from "./catalogs/capabilities.js";
import type { PlatformId } from "./catalogs/platforms.js";
import { defaultConfigPath, readCliConfig, readRedactedCliConfig, redactedCliConfig } from "./config.js";
import { linearBacklogConfigDiagnostics } from "./linear-backlog-config.js";
import { relaySecurityChecksFromConfig } from "./relay-security.js";
import { formatSecretReadiness } from "./secret-readiness.js";

export type DoctorCommandOptions = {
  config?: string;
};

function credentialSourcesCheck(secretConfig: unknown): DoctorCheck {
  return {
    status: "ok",
    name: "credential sources",
    message: formatSecretReadiness(secretConfig).slice(1).join("; ")
  };
}

export function appendCliDoctorChecks(config: ReturnType<typeof readCliConfig>, checks: DoctorCheck[], secretConfig: unknown = redactedCliConfig(config)): DoctorCheck[] {
  const platforms = Object.entries(config.platforms)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key as PlatformId);
  const capabilityLines = formatConfiguredCapabilities({
    platforms,
    executors: config.daemon.repositories.map((repository) => repository.defaultExecutor)
  }).slice(1);
  return [
    ...checks,
    credentialSourcesCheck(secretConfig),
    {
      status: "ok",
      name: "capability catalog",
      message: capabilityLines.join("; ")
    },
    ...relaySecurityChecksFromConfig(config).map((check) => ({
      status: check.status,
      name: check.name,
      message: check.message
    })),
    ...linearBacklogConfigDiagnostics(config).map((diagnostic) => ({
      status: "warn" as const,
      name: diagnostic.code === "legacy-project-id" ? "Linear /linear channel mapping" : "Linear workspace connection",
      message: diagnostic.message
    }))
  ];
}

export function formatCliDoctorChecks(checks: DoctorCheck[]): string {
  return renderOpenTagPresentationPlainText(
    createDoctorSummaryPresentation({
      title: "OpenTag doctor",
      checks
    })
  );
}

export async function runDoctorCommand(options: DoctorCommandOptions): Promise<void> {
  const configPath = options.config ?? defaultConfigPath();
  let config: ReturnType<typeof readCliConfig>;
  let secretConfig: unknown;
  try {
    secretConfig = readRedactedCliConfig(configPath);
    config = readCliConfig(configPath);
  } catch (error) {
    const checks: DoctorCheck[] = [
      {
        status: "fail",
        name: "credential resolution",
        message: error instanceof Error ? error.message : String(error)
      }
    ];
    if (secretConfig !== undefined) {
      checks.unshift(credentialSourcesCheck(secretConfig));
    }
    console.log(formatCliDoctorChecks(checks));
    process.exitCode = 1;
    return;
  }
  const checks = appendCliDoctorChecks(
    config,
    await runDoctor({
      config: config.daemon,
      executors: executorsFromConfig(config.daemon)
    }),
    secretConfig
  );
  console.log(formatCliDoctorChecks(checks));
  if (doctorHasFailures(checks)) {
    process.exitCode = 1;
  }
}
