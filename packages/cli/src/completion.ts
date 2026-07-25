import { createOpenTagClient, type BoundedCompletionWaiverInput, type OpenTagClient } from "@opentag/client";
import type { HumanEscalation, PolicyScope } from "@opentag/core";
import {
  defaultConfigPath,
  readCliConfig
} from "./config.js";
import { formatCompletionExplanation } from "./status.js";

const POLICY_SCOPES: PolicyScope[] = [
  "organization_default",
  "work_context_owner_container",
  "work_item_override"
];

type CompletionCommandDependencies = {
  fetchImpl?: typeof fetch;
  now?: () => string;
  log?: (message: string) => void;
};

function completionGovernanceClient(options: { config?: string }, dependencies: CompletionCommandDependencies): OpenTagClient {
  const configPath = options.config ?? defaultConfigPath();
  const config = readCliConfig(configPath);
  const pairingToken = config.daemon.pairingToken;
  if (!pairingToken) {
    throw new Error("Completion governance requires daemon.pairingToken; a runner token cannot authorize human decisions.");
  }
  return createOpenTagClient({
    dispatcherUrl: config.daemon.dispatcherUrl,
    pairingToken,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {})
  });
}

function humanEscalationLines(escalation: HumanEscalation): string[] {
  return [
    `${escalation.id}: ${escalation.class}/${escalation.state}${escalation.blocking ? " blocking" : ""}`,
    `  Audience: ${escalation.audience}`,
    `  Summary: ${escalation.summary}`,
    `  Reason: ${escalation.reason}`,
    `  Subject: ${escalation.subjectRef}`,
    ...(escalation.expiresAt ? [`  Expires: ${escalation.expiresAt}`] : []),
    ...(escalation.options?.length
      ? ["  Options:", ...escalation.options.map((option) => `    ${option.id}: ${option.label} - ${option.consequence}`)]
      : []),
    ...(escalation.resolution
      ? [`  Resolved by: ${escalation.resolution.actor.provider}:${escalation.resolution.actor.providerUserId} at ${escalation.resolution.resolvedAt}`]
      : [])
  ];
}

export type CompletionEscalationsCommandOptions = { config?: string; run: string };

export async function runCompletionEscalationsCommand(
  options: CompletionEscalationsCommandOptions,
  dependencies: CompletionCommandDependencies = {}
): Promise<void> {
  const result = await completionGovernanceClient(options, dependencies).listHumanEscalations({ runId: options.run });
  const log = dependencies.log ?? console.log;
  log([
    `Human escalations for ${options.run}:`,
    ...(result.escalations.length ? result.escalations.flatMap(humanEscalationLines) : ["  none"]),
    ...(result.resolutionUnavailableReason ? [`Resolution unavailable: ${result.resolutionUnavailableReason}`] : [])
  ].join("\n"));
}

export type CompletionEscalationActorOptions = {
  config?: string;
  escalation: string;
  actorProvider: string;
  actorId: string;
  actorHandle?: string;
};

export async function runCompletionAcknowledgeCommand(
  options: CompletionEscalationActorOptions & { acknowledgedAt?: string },
  dependencies: CompletionCommandDependencies = {}
): Promise<void> {
  const result = await completionGovernanceClient(options, dependencies).acknowledgeHumanEscalation({
    escalationId: options.escalation,
    actor: {
      provider: options.actorProvider,
      providerUserId: options.actorId,
      ...(options.actorHandle ? { handle: options.actorHandle } : {})
    },
    acknowledgedAt: options.acknowledgedAt ?? dependencies.now?.() ?? new Date().toISOString()
  });
  (dependencies.log ?? console.log)([
    `Human escalation acknowledgement: ${result.outcome}`,
    ...humanEscalationLines(result.escalation),
    "The escalation remains blocking until it is resolved or expires."
  ].join("\n"));
}

export async function runCompletionResolveCommand(
  options: CompletionEscalationActorOptions & { option?: string; reason?: string; resolvedAt?: string },
  dependencies: CompletionCommandDependencies = {}
): Promise<void> {
  const result = await completionGovernanceClient(options, dependencies).resolveHumanEscalation({
    escalationId: options.escalation,
    actor: {
      provider: options.actorProvider,
      providerUserId: options.actorId,
      ...(options.actorHandle ? { handle: options.actorHandle } : {})
    },
    ...(options.option ? { optionId: options.option } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    resolvedAt: options.resolvedAt ?? dependencies.now?.() ?? new Date().toISOString()
  });
  (dependencies.log ?? console.log)([
    `Human escalation resolution: ${result.outcome}`,
    ...humanEscalationLines(result.escalation),
    `Resume required: ${result.resume.required ? "yes" : "no"}`,
    `Next action: ${result.resume.nextAction}`
  ].join("\n"));
}

export type CompletionWaiveCommandOptions = {
  config?: string;
  run: string;
  gate: string[];
  reason: string;
  actorProvider: string;
  actorId: string;
  actorHandle?: string;
  scope: string;
  policyScope: string;
  waivedAt?: string;
  expiresAt?: string;
};

export async function runCompletionWaiveCommand(
  options: CompletionWaiveCommandOptions,
  dependencies: CompletionCommandDependencies = {}
): Promise<void> {
  if (options.scope !== "selected_gates") {
    throw new Error("--scope must be selected_gates for a bounded Phase 1 completion waiver.");
  }
  if (!POLICY_SCOPES.includes(options.policyScope as PolicyScope)) {
    throw new Error(`--policy-scope must be one of: ${POLICY_SCOPES.join(", ")}.`);
  }
  const gateIds = [...new Set(options.gate.map((gateId) => gateId.trim()).filter(Boolean))].sort();
  if (gateIds.length === 0) throw new Error("At least one non-empty --gate is required.");
  const waivedAt = options.waivedAt ?? dependencies.now?.() ?? new Date().toISOString();
  const client = completionGovernanceClient(options, dependencies);
  const waiver: BoundedCompletionWaiverInput = {
    actor: {
      provider: options.actorProvider,
      providerUserId: options.actorId,
      ...(options.actorHandle ? { handle: options.actorHandle } : {})
    },
    reason: options.reason,
    scope: "selected_gates",
    policyScope: options.policyScope as PolicyScope,
    gateIds,
    waivedAt,
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {})
  };
  const result = await client.waiveCompletion({ runId: options.run, waiver });
  const log = dependencies.log ?? console.log;
  log([
    `Completion waiver: ${result.outcome}`,
    `Waiver: ${result.waiver.id}`,
    `Actor: ${result.waiver.actor.provider}:${result.waiver.actor.providerUserId}`,
    `Reason: ${result.waiver.reason}`,
    `Gates: ${result.waiver.gateIds.join(", ")}`,
    ...formatCompletionExplanation(result.completion)
  ].join("\n"));
}
