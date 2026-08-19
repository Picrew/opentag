import type { OpenTagRunResult, WorkContextMutationRequest } from "@opentag/core";
import { EXECUTOR_REPORT_START, parseExecutorReport, renderExecutorReportSummary } from "./executor-report.js";

const MAX_EXECUTOR_SUMMARY_LENGTH = 50_000;
const MAX_ARTIFACT_SUMMARY_LENGTH = 1200;

type ResultArtifact = NonNullable<OpenTagRunResult["artifacts"]>[number];

const DIRECT_SOURCE_CONTROL_COMMAND_PATTERN = /^\s*(?:[-*]\s*)?(?:`{1,3})?\s*(?:git\s+(?:add|commit|push|checkout)|gh\s+pr\s+create)\b/i;

const GIT_HANDOFF_PATTERNS = [
  DIRECT_SOURCE_CONTROL_COMMAND_PATTERN,
  /\b(?:interactive user approval|permission system)\b.*\b(?:git|source-control|commit|push|pull request|pr)\b/i,
  /\b(?:git|source-control|commit|push|pull request|pr)\b.*\b(?:interactive user approval|permission system)\b/i,
  /(?=.*\b(?:git\s+(?:add|commit|push|checkout)|gh\s+pr\s+create|commit|push|pull request|pr)\b)(?=.*\b(?:approval|approve|manual|need|needs|cannot|can't|please|requires?|required|finish|next action|remaining work|blocked|blocker|permission)\b)/i
];

const HANDOFF_HEADING_PATTERN =
  /^(?:#{1,6}\s*)?(?:\*\*)?\s*(?:blocker|recommended next action|next action|remaining work|manual steps|to finish)\b.*\b(?:git|source-control|commit|push|pull request|pr)\b/i;

function looksLikeGitHandoff(line: string): boolean {
  return GIT_HANDOFF_PATTERNS.some((pattern) => pattern.test(line));
}

function stripGitHandoffTail(line: string): string {
  if (!looksLikeGitHandoff(line)) return line;
  return line
    .replace(/\s*(?:Blocker|Recommended next action|Next action|Remaining work|Manual steps|To finish)\s*:.*$/i, "")
    .trimEnd();
}

function cleanOrFallbackExecutorSummary(input: {
  executorName: string;
  output: string;
  changedFiles: string[];
}): string {
  const summary = cleanExecutorSummaryText(input.output);
  if (summary) return summary;

  if (input.changedFiles.length === 0) {
    return `${input.executorName} completed without file changes.`;
  }

  return `${input.executorName} changed ${input.changedFiles.length} file(s). Changed files: ${input.changedFiles.join(", ")}.`;
}

function cleanExecutorSummaryText(output: string): string | undefined {
  const normalizedOutput = output.replace(/\r\n/g, "\n");
  const sliceStart = Math.max(0, normalizedOutput.length - MAX_EXECUTOR_SUMMARY_LENGTH);
  let rawSummary = normalizedOutput.slice(sliceStart);
  if (sliceStart > 0 && normalizedOutput[sliceStart - 1] !== "\n") {
    const firstCompleteLine = rawSummary.indexOf("\n");
    rawSummary = firstCompleteLine >= 0 ? rawSummary.slice(firstCompleteLine + 1) : "";
  }
  const filteredLines: string[] = [];

  for (const rawLine of rawSummary.split("\n")) {
    const trimmed = rawLine.trim();
    if (HANDOFF_HEADING_PATTERN.test(trimmed)) continue;

    const withoutHandoffTail = stripGitHandoffTail(rawLine);
    if (looksLikeGitHandoff(withoutHandoffTail)) continue;
    if (withoutHandoffTail.trim().length === 0 && trimmed.length > 0) continue;

    filteredLines.push(withoutHandoffTail);
  }

  const summary = filteredLines
    .join("\n")
    .replace(/(?:^|\n)\s*(?:To finish|Manual steps):\s*\n```[^\n]*\n\s*```/gi, "\n")
    .replace(/```[^\n]*\n\s*```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return summary.length > 0 ? summary : undefined;
}

function executorAnswerBeforeReport(output: string): string | undefined {
  const startIndex = output.lastIndexOf(EXECUTOR_REPORT_START);
  if (startIndex < 0) return undefined;
  return cleanExecutorSummaryText(output.slice(0, startIndex));
}

function summaryWithExecutorAnswer(input: {
  executorName: string;
  output: string;
  changedFiles: string[];
  report: NonNullable<ReturnType<typeof parseExecutorReport>>;
}): string {
  const reportSummary = renderExecutorReportSummary(input);
  if (input.changedFiles.length > 0 || input.report.changes.length > 0) return reportSummary;

  const answer = executorAnswerBeforeReport(input.output);
  if (!answer || answer === reportSummary) return reportSummary;

  const hasReportDetails = Boolean(input.report.verification?.length || input.report.risks?.length);
  return hasReportDetails ? [answer, "", reportSummary].join("\n") : answer;
}

function runArtifactUri(runId: string, artifact: string): string {
  return `opentag://run/${encodeURIComponent(runId)}/${artifact}`;
}

function truncateArtifactText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_ARTIFACT_SUMMARY_LENGTH ? `${normalized.slice(0, MAX_ARTIFACT_SUMMARY_LENGTH - 1)}...` : normalized;
}

function dedupeArtifacts(artifacts: ResultArtifact[]): ResultArtifact[] {
  const seen = new Set<string>();
  const deduped: ResultArtifact[] = [];
  for (const artifact of artifacts) {
    const key = artifact.id ?? `${artifact.type ?? artifact.kind ?? "artifact"}:${artifact.uri}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(artifact);
  }
  return deduped;
}

function createRunArtifacts(input: {
  executorName: string;
  runId: string;
  branchName: string;
  baseBranch?: string;
  output: string;
  summary: string;
  changedFiles: string[];
  report?: NonNullable<ReturnType<typeof parseExecutorReport>>;
  extraArtifacts?: ResultArtifact[];
}): ResultArtifact[] {
  const generated: ResultArtifact[] = [];
  const createdAt = new Date().toISOString();
  if (input.changedFiles.length > 0) {
    generated.push({
      id: `${input.runId}:patch-summary`,
      type: "patch_summary",
      kind: "patch",
      title: "Generated patch",
      uri: input.branchName,
      summary: `${input.executorName} changed ${input.changedFiles.length} file(s) on branch ${input.branchName}.`,
      sourceRunId: input.runId,
      createdAt,
      metadata: {
        runId: input.runId,
        executor: input.executorName,
        branchName: input.branchName,
        baseBranch: input.baseBranch ?? "main",
        changedFiles: input.changedFiles
      }
    });
  }
  generated.push({
    id: `${input.runId}:diagnosis-report`,
    type: "diagnosis_report",
    kind: "report",
    title: "Run report",
    uri: runArtifactUri(input.runId, "report"),
    summary: truncateArtifactText(input.summary),
    sourceRunId: input.runId,
    createdAt,
    metadata: {
      runId: input.runId,
      executor: input.executorName,
      summary: truncateArtifactText(input.summary),
      changedFiles: input.changedFiles,
      ...(input.report ? { report: input.report } : {})
    }
  });
  generated.push({
    id: `${input.runId}:log-summary`,
    type: "log_summary",
    kind: "log_summary",
    title: "Log summary",
    uri: runArtifactUri(input.runId, "log-summary"),
    summary: truncateArtifactText(executorAnswerBeforeReport(input.output) ?? input.summary),
    sourceRunId: input.runId,
    createdAt,
    metadata: {
      runId: input.runId,
      executor: input.executorName,
      summary: truncateArtifactText(executorAnswerBeforeReport(input.output) ?? input.summary)
    }
  });

  return dedupeArtifacts([...generated, ...(input.report?.artifacts ?? []), ...(input.extraArtifacts ?? [])]);
}

export function createExecutorRunResult(input: {
  executorName: string;
  runId: string;
  branchName: string;
  baseBranch?: string;
  output: string;
  changedFiles: string[];
  extraArtifacts?: NonNullable<OpenTagRunResult["artifacts"]>;
}): OpenTagRunResult {
  const proposalId = `proposal_${input.runId}`;
  const report = parseExecutorReport(input.output);
  const summary = report ? summaryWithExecutorAnswer({ ...input, report }) : cleanOrFallbackExecutorSummary(input);
  const artifacts = createRunArtifacts({ ...input, summary, ...(report ? { report } : {}) });
  const suggestedChanges =
    input.changedFiles.length > 0
      ? [
          {
            proposalId,
            createdAt: new Date().toISOString(),
            sourceRunId: input.runId,
            summary: `${input.executorName} changed ${input.changedFiles.length} file(s) on branch ${input.branchName}.`,
            intents: [
              {
                intentId: `${proposalId}_create_pr`,
                domain: "pull_request" as const,
                action: "create_pull_request",
                summary: `Create a pull request for branch ${input.branchName}.`,
                params: {
                  title: `OpenTag run ${input.runId}`,
                  body: [
                    "## Summary",
                    "",
                    summary
                  ].join("\n"),
                  head: input.branchName,
                  base: input.baseBranch ?? "main",
                  changedFiles: input.changedFiles,
                  risks: ["Creates a pull request from the executor-produced branch; review the diff before merging."],
                  executorConditions: ["isolated branch exists"]
                }
              }
            ],
            preconditions: ["The local branch was generated from the checkout state available to the runner."]
          }
        ]
      : undefined;

  return {
    conclusion: "success",
    summary,
    changedFiles: input.changedFiles,
    artifacts,
    ...(suggestedChanges ? { suggestedChanges } : {}),
    nextAction:
      input.changedFiles.length > 0
        ? {
            summary: "Review the proposed pull request action and reply `apply 1` if the branch should become a PR.",
            hint: {
              kind: "create_pull_request",
              targetId: proposalId,
              selectedIntentIds: [`${proposalId}_create_pr`]
            }
          }
        : "No file changes were detected."
  };
}

export function createWorkContextMutationRunResult(input: {
  runId: string;
  requests: WorkContextMutationRequest[];
}): OpenTagRunResult {
  const proposalId = `proposal_${input.runId}`;
  const intents = input.requests.map((request, index) => {
    const intentId = `${proposalId}_${request.domain}_${index + 1}`;
    switch (request.domain) {
      case "priority": {
        const numeric = /^[0-4]$/.test(request.value) ? Number(request.value) : undefined;
        return {
          intentId,
          domain: "priority" as const,
          action: "set_priority",
          summary: `Set the issue priority to ${request.value}.`,
          params: { priority: numeric ?? request.value }
        };
      }
      case "status":
        return {
          intentId,
          domain: "status" as const,
          action: "set_status",
          summary: `Move the issue status to ${request.value}.`,
          params: { status: request.value }
        };
      case "assignee":
        return {
          intentId,
          domain: "assignee" as const,
          action: "set_assignee",
          summary: `Assign the issue to ${request.value}.`,
          params: { assignee: request.value }
        };
      case "label":
        return {
          intentId,
          domain: "label" as const,
          action: "set_labels",
          summary: `Add the label ${request.value}.`,
          params: { label: request.value }
        };
    }
  });
  const actionSummaries = intents.map((intent) => intent.summary).join(" ");

  return {
    conclusion: "needs_human",
    summary: `Prepared ${intents.length} issue update action(s) from the request without starting an executor. ${actionSummaries}`,
    suggestedChanges: [
      {
        proposalId,
        createdAt: new Date().toISOString(),
        sourceRunId: input.runId,
        summary: `Apply the requested issue update(s): ${actionSummaries}`,
        intents,
        preconditions: ["The work-item adapter resolves names through the discovered mutation mappings at apply time."]
      }
    ],
    nextAction: "Reply `apply 1` to apply the first action (`apply all` for every action), or `reject 1` to dismiss it."
  };
}
