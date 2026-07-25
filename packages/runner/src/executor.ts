import {
  contextPointerLabel,
  type ExecutorCapabilityContract,
  type ContextPacket,
  type ContextPointer,
  type OpenTagCommand,
  type OpenTagReplyTargetRef,
  type OpenTagRunResult,
  type OpenTagRunSourceRef,
  type OpenTagRunTargets,
  type PermissionGrant
} from "@opentag/core";
import type { AgentSessionProfile } from "./session-profile.js";

export type ExecutorEvent = {
  type: "executor.started" | "executor.progress" | "executor.completed" | "executor.failed";
  message: string;
  at: string;
};

export type ExecutorEventSink = {
  emit(event: ExecutorEvent): Promise<void>;
};

export type ExecutorWorkspace =
  | { kind: "repository"; path: string }
  | { kind: "scratch"; path: string };

export type ExecutorPermissionRequest = {
  toolCallId: string;
  title: string;
  kind?: string | null;
  provider: string;
  connectionId: string;
  operation: string;
  resource?: string;
  resourceVersion?: string;
  targetFingerprint?: string;
  targetConstraints?: Record<string, unknown>;
  grantScope?: Record<string, unknown>;
  permissionScopes: string[];
};

export type ExecutorPermissionResolution = {
  actionId: string;
  decision: "allow_once" | "allow_run" | "deny";
  reconciled?: boolean;
  receipt?: { receiptRef: string; outcome: "succeeded" | "failed" | "unknown" };
  material?: boolean;
};

export type ExecutorMaterialActionReport = {
  actionId: string;
  toolCallId: string;
  provider: string;
  receiptRef: string;
  outcome: "succeeded" | "failed" | "unknown";
  reportedOutcome?: "completed" | "failed";
};

export type ExecutorRunInput = {
  runId: string;
  attemptId?: string;
  workspace: ExecutorWorkspace;
  command: OpenTagCommand;
  source?: OpenTagRunSourceRef;
  targets?: OpenTagRunTargets;
  replyTo?: OpenTagReplyTargetRef[];
  context: ContextPointer[];
  contextPacket?: ContextPacket;
  permissions?: PermissionGrant[];
  baseBranch?: string;
  worktreeRoot?: string;
  keepWorktree?: "always" | "on_failure" | "never";
  metadata?: Record<string, unknown>;
  sessionProfile?: AgentSessionProfile;
  permissionResolver?: (request: ExecutorPermissionRequest) => Promise<ExecutorPermissionResolution>;
  materialActionReporter?: (report: ExecutorMaterialActionReport) => Promise<void>;
};

export function executorWorkspacePath(input: ExecutorRunInput): string {
  return input.workspace.path;
}

export function renderContextPacketForPrompt(packet?: ContextPacket): string[] {
  if (!packet) return [];

  const lines = ["OpenTag context packet:", `- summary: ${packet.summary}`];

  if (packet.intent) {
    lines.push(`- intent: ${packet.intent.normalizedIntent}`);
    lines.push(`- requested by: ${packet.intent.requestedBy.provider}:${packet.intent.requestedBy.providerUserId}`);
  }

  if (packet.sources?.length) {
    lines.push("- selected sources:");
    for (const source of packet.sources) {
      lines.push(`  - [${source.role}] ${contextPointerLabel(source.pointer)}: ${source.pointer.uri}`);
      lines.push(`    reason: ${source.reason}`);
    }
  }

  if (packet.facts?.length) {
    lines.push("- facts:");
    for (const fact of packet.facts) {
      lines.push(`  - ${fact.text}`);
    }
  }

  if (packet.exclusions?.length) {
    lines.push("- exclusions:");
    for (const exclusion of packet.exclusions) {
      lines.push(`  - ${exclusion}`);
    }
  }

  return lines;
}

export type ExecutorReadiness = {
  ready: boolean;
  reason?: string;
};

export type ExecutorSecretRequirement = {
  id: string;
  label: string;
  required: boolean;
  description?: string;
  env?: string;
};

export type ExecutorCompletionSignal = {
  type: "process_exit" | "hook_event" | "stream_event";
  required: boolean;
  description: string;
};

export type ExecutorProgressEventMode = "none" | "audit" | "human";
export type ExecutorApprovalMode = "none" | "opentag_policy" | "executor_managed";
export type ExecutorContextAccess = "context_packet" | "context_pointers" | "workspace";
export type ExecutorPromptAssembly = "opentag" | "executor_adapter" | "external_runtime";
export type ExecutorWriteAccess = "none" | "workspace" | "external";
export type ExecutorConversationAccess = "none" | "request" | "thread_transcript";
export type ExecutorPromptMutation = "none" | "append" | "replace";
export type ExecutorWriteActionAccess = "none" | "propose" | "execute";
export type ExecutorWorkspaceCwdConformance = "declared" | "unverified";

export type { ExecutorCapabilityContract } from "@opentag/core";

export type ExecutorAdapter = {
  id: string;
  displayName: string;
  capability?: ExecutorCapabilityContract;
  canRun(input: ExecutorRunInput): Promise<ExecutorReadiness>;
  run(input: ExecutorRunInput, sink: ExecutorEventSink): Promise<OpenTagRunResult>;
  cancel(runId: string, attemptId?: string): Promise<void>;
};
