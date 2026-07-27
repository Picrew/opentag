import type { OpenTagCliConfig } from "./config.js";

type LinearConfig = NonNullable<OpenTagCliConfig["platforms"]["linear"]>;

export type LinearBacklogChannelResolution =
  | { kind: "not-configured"; reason: "channels-missing" }
  | { kind: "unauthorized" }
  | { kind: "unsupported-connection"; connection: string }
  | {
      kind: "authorized";
      projectId: string;
      connection: "default";
      graphqlUrl?: string;
    };

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveLinearBacklogChannel(input: {
  linear?: LinearConfig;
  teamId: string;
  channelId: string;
  env?: NodeJS.ProcessEnv;
}): LinearBacklogChannelResolution {
  const channels = input.linear?.channels;
  if (!channels?.length) {
    return { kind: "not-configured", reason: "channels-missing" };
  }

  const mapping = channels.find((candidate) => candidate.teamId === input.teamId && candidate.channelId === input.channelId);
  if (!mapping) return { kind: "unauthorized" };

  const connection = mapping.connection ?? "default";
  if (connection !== "default") {
    return { kind: "unsupported-connection", connection };
  }

  const graphqlUrl = nonBlank(input.linear?.graphqlUrl) ?? nonBlank(input.env?.OPENTAG_LINEAR_GRAPHQL_URL);
  return {
    kind: "authorized",
    projectId: mapping.projectId,
    connection: "default",
    ...(graphqlUrl ? { graphqlUrl } : {})
  };
}

export function resolveDefaultLinearBacklogToken(input: {
  linear?: LinearConfig;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  return (
    nonBlank(input.linear?.connections?.default?.token) ??
    nonBlank(input.linear?.token) ??
    nonBlank(input.env?.OPENTAG_LINEAR_API_KEY) ??
    nonBlank(input.env?.OPENTAG_LINEAR_TOKEN)
  );
}

export type LinearBacklogConfigDiagnostic = {
  code: "legacy-project-id" | "unsupported-connection";
  message: string;
};

export function linearBacklogConfigDiagnostics(config: OpenTagCliConfig): LinearBacklogConfigDiagnostic[] {
  const linear = config.platforms.linear;
  if (!config.platforms.slack || !linear) return [];

  const diagnostics: LinearBacklogConfigDiagnostic[] = [];
  if (linear.projectId && !linear.channels?.length) {
    diagnostics.push({
      code: "legacy-project-id",
      message:
        "Linear /linear channel mapping is not configured: platforms.linear.projectId no longer authorizes Slack channels. Add platforms.linear.channels entries and restart OpenTag."
    });
  }

  const unsupportedConnections = [
    ...new Set(
      (linear.channels ?? [])
        .map((channel) => channel.connection)
        .filter((connection): connection is string => Boolean(connection && connection !== "default"))
    )
  ].sort();
  for (const connection of unsupportedConnections) {
    diagnostics.push({
      code: "unsupported-connection",
      message: `Linear workspace connection ${connection} is configured for /linear, but only the default connection is supported at runtime; those channels will remain unavailable.`
    });
  }
  return diagnostics;
}
