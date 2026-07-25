import { describe, expect, it } from "vitest";
import {
  createActionReceiptPresentation,
  createDoctorSummaryPresentation,
  createFinalSummaryPresentation,
  createRunStatusPresentation,
  createSourceThreadStatusPresentation,
  OpenTagApprovalPromptPresentationSchema,
  OpenTagFinalSummaryPresentationSchema,
  OpenTagPresentationSchema,
  presentationDeliveryTier,
  renderOpenTagPresentationPlainText
} from "../src/presentation.js";
import { sanitizeCredentialLikeValue } from "../src/credential-safety.js";

describe("OpenTagPresentation", () => {
  it("models a provider-neutral approval prompt", () => {
    const presentation = OpenTagApprovalPromptPresentationSchema.parse({
      kind: "approval_prompt",
      runId: "run_approval_1",
      approvalId: "approval_1",
      proposalId: "proposal_1",
      intentId: "intent_action_1",
      actionId: "action_1",
      proposalHash: "sha256:abc123",
      approvalEpoch: "epoch_1",
      title: "Deploy the verified build?",
      summary: "This will update the production service.",
      target: { provider: "deploy", connectionId: "deploy:prod", operation: "update", resource: "service:web", resourceVersion: "build-42" },
      runScope: { provider: "deploy", connectionId: "deploy:prod", operation: "update", grantScope: { environment: "production", services: "*" } },
      decisions: ["allow_once", "allow_run", "deny"]
    });

    expect(OpenTagPresentationSchema.parse(presentation)).toEqual(presentation);
    expect(renderOpenTagPresentationPlainText(presentation)).toContain("Deploy the verified build?");
    expect(renderOpenTagPresentationPlainText(presentation)).toContain('grantScope={"environment":"production","services":"*"}');
  });

  it("rejects credential-bearing approval snapshots before channel rendering", () => {
    const base = {
      kind: "approval_prompt" as const,
      runId: "run_unsafe",
      approvalId: "approval_unsafe",
      proposalId: "proposal_unsafe",
      intentId: "intent_unsafe",
      actionId: "action_unsafe",
      proposalHash: "sha256:unsafe",
      approvalEpoch: "epoch_unsafe",
      title: "Allow publish?",
      summary: "Publish the package.",
      target: { provider: "npm", connectionId: "npm:team", operation: "publish", resource: "@acme/report" },
      runScope: { provider: "npm", targetConstraints: { environment: "staging" } },
      decisions: ["allow_once", "allow_run", "deny"] as const
    };
    expect(() => OpenTagApprovalPromptPresentationSchema.parse({ ...base, title: "Publish ghp\x5fabcdefghijklmnopqrstuvwxyz123456" })).toThrow();
    expect(() => OpenTagApprovalPromptPresentationSchema.parse({ ...base, runScope: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" } })).toThrow();
  });

  it("creates a provider-neutral final summary presentation", () => {
    const presentation = createFinalSummaryPresentation({
      result: {
        conclusion: "success",
        summary: "Updated the failing test.",
        changedFiles: ["packages/core/test/demo.test.ts"],
        artifacts: [
          { kind: "patch", title: "Generated patch", uri: "opentag/run_1.patch" },
          { kind: "report", title: "Run report", uri: "opentag/run_1-report.md" },
          { kind: "screenshot", title: "UI screenshot", uri: "opentag/run_1.png" },
          { kind: "log_summary", title: "Log summary", uri: "opentag/run_1-log.md" },
          { kind: "pull_request", title: "Pull request", uri: "https://github.com/acme/demo/pull/1" }
        ],
        verification: [{ command: "pnpm test", outcome: "passed" }]
      },
      auditRunId: "run_1"
    });

    expect(OpenTagPresentationSchema.parse(presentation)).toEqual(presentation);
    expect(presentation).toMatchObject({
      kind: "final_summary",
      outcome: "success",
      summary: "Updated the failing test.",
      changedFiles: ["packages/core/test/demo.test.ts"],
      artifacts: [
        { kind: "patch", title: "Generated patch", uri: "opentag/run_1.patch" },
        { kind: "report", title: "Run report", uri: "opentag/run_1-report.md" },
        { kind: "screenshot", title: "UI screenshot", uri: "opentag/run_1.png" },
        { kind: "log_summary", title: "Log summary", uri: "opentag/run_1-log.md" },
        { kind: "pull_request", title: "Pull request", uri: "https://github.com/acme/demo/pull/1" }
      ],
      verification: [{ command: "pnpm test", outcome: "passed" }],
      auditRunId: "run_1"
    });
    expect(JSON.stringify(presentation)).not.toContain("blocks");
    expect(JSON.stringify(presentation)).not.toContain("mrkdwn");
    const rendered = renderOpenTagPresentationPlainText(presentation);
    expect(rendered).toContain("Artifacts:");
    expect(rendered).toContain("- Generated patch: opentag/run_1.patch");
    expect(rendered).toContain("- Run report: opentag/run_1-report.md");
    expect(rendered).toContain("- UI screenshot: opentag/run_1.png");
    expect(rendered).toContain("- Log summary: opentag/run_1-log.md");
    expect(rendered).toContain("- Pull request: https://github.com/acme/demo/pull/1");
    expect(rendered).toContain("Audit: opentag status --run run_1");
  });

  it("rejects credential-bearing final presentation fields and accepts the centrally sanitized shape", () => {
    const raw = "xoxb\x2d1234567890-abcdefghijklmnopqrstuvwxyz";
    const unsafe = {
      kind: "final_summary" as const,
      outcome: "success",
      summary: `finished with ${raw}`,
      artifacts: [{ title: "Report", uri: "workspace/report.md", metadata: { accessToken: "opaque-secret" } }],
      verification: [{ command: "check", outcome: "passed" as const, excerpt: `Bearer ${raw}` }],
      result: {
        conclusion: "success" as const,
        summary: `finished with ${raw}`,
        artifacts: [{ title: "Report", uri: "workspace/report.md", metadata: { accessToken: "opaque-secret" } }],
        verification: [{ command: "check", outcome: "passed" as const, excerpt: `Bearer ${raw}` }]
      }
    };

    expect(() => OpenTagFinalSummaryPresentationSchema.parse(unsafe)).toThrow();
    expect(() => OpenTagFinalSummaryPresentationSchema.parse(sanitizeCredentialLikeValue(unsafe))).not.toThrow();
  });

  it("carries action receipt semantics without provider-native UI fields", () => {
    const presentation = createFinalSummaryPresentation({
      result: {
        conclusion: "needs_human",
        summary: "Prepared a proposal.",
        suggestedChanges: [
          {
            proposalId: "proposal_1",
            createdAt: "2026-06-24T00:00:00.000Z",
            summary: "Move issue forward.",
            intents: [
              {
                intentId: "intent_label_1",
                domain: "labels",
                action: "add_label",
                summary: "Add the bug label.",
                params: { label: "bug" }
              }
            ]
          }
        ]
      },
      receiptContext: {
        capabilityByIntentId: {
          intent_label_1: {
            state: "ready_to_apply",
            targetLabel: "GitHub labels",
            visibleDecisions: ["apply", "reject"],
            primaryDecision: "apply"
          }
        }
      },
      auditRunId: "run_receipt_1"
    });

    expect(presentation.actionReceiptTitle).toBe("Ready to apply");
    expect(presentation.actions).toEqual([
      {
        index: 1,
        proposalId: "proposal_1",
        intentId: "intent_label_1",
        title: "Add the bug label.",
        state: "ready_to_apply",
        targetLabel: "GitHub labels",
        impact: "Writes label metadata on the source work item.",
        capabilityState: "Adapter capability and preflight allow direct apply for this target.",
        approvalRequirement: "Review impact, then use `apply 1` to approve and apply, or `reject 1`.",
        safeNextAction: "`apply 1` is the safe apply path after reviewing this receipt.",
        visibleDecisions: ["apply", "reject"],
        primaryDecision: "apply",
        details: [
          "Impact: Writes label metadata on the source work item.",
          "Capability/preflight: Adapter capability and preflight allow direct apply for this target.",
          "Approval: Review impact, then use `apply 1` to approve and apply, or `reject 1`.",
          "Safe next action: `apply 1` is the safe apply path after reviewing this receipt."
        ],
        detailRows: [
          { label: "Target", value: "GitHub labels" },
          { label: "Impact", value: "Writes label metadata on the source work item." },
          { label: "Capability / preflight", value: "Adapter capability and preflight allow direct apply for this target." },
          { label: "Required approval", value: "Review impact, then use `apply 1` to approve and apply, or `reject 1`." },
          { label: "Safe next action", value: "`apply 1` is the safe apply path after reviewing this receipt." }
        ]
      }
    ]);
    expect(JSON.stringify(presentation)).not.toContain("button");
    expect(JSON.stringify(presentation)).not.toContain("action_id");
    const rendered = renderOpenTagPresentationPlainText(presentation);
    expect(rendered).toContain("Finished: needs_human");
    expect(rendered).toContain("Ready to apply");
    expect(rendered).toContain("1. Add the bug label.");
    expect(rendered).toContain("Target: GitHub labels");
    expect(rendered).toContain("Impact: Writes label metadata on the source work item.");
    expect(rendered).toContain("Capability/preflight: Adapter capability and preflight allow direct apply for this target.");
    expect(rendered).toContain("Approval: Review impact, then use `apply 1` to approve and apply, or `reject 1`.");
    expect(rendered).toContain("Safe next action: `apply 1` is the safe apply path after reviewing this receipt.");
    expect(rendered).toContain("Actions: apply 1, reject 1");
    expect(rendered).toContain("Audit: opentag status --run run_receipt_1");
  });

  it("carries provider-neutral action details for native renderers", () => {
    const presentation = createFinalSummaryPresentation({
      result: {
        conclusion: "needs_human",
        summary: "Prepared a PR proposal.",
        suggestedChanges: [
          {
            proposalId: "proposal_pr",
            createdAt: "2026-06-24T00:00:00.000Z",
            summary: "Create a pull request.",
            intents: [
              {
                intentId: "intent_create_pr",
                domain: "pull_request",
                action: "create_pull_request",
                summary: "Create a pull request.",
                params: {
                  head: "opentag/run_1",
                  base: "main",
                  changedFiles: ["src/demo.ts"]
                }
              }
            ],
            preconditions: ["The branch still exists."]
          }
        ]
      }
    });

    expect(presentation.actions?.[0]).toMatchObject({
      proposalId: "proposal_pr",
      intentId: "intent_create_pr",
      details: [
        "Impact: Creates a pull request from `opentag/run_1` into `main` with 1 changed file.",
        "Capability/preflight: External write is withheld until a human records approval.",
        "Approval: Use `approve 1` to record approval without applying yet, or `reject 1`.",
        "Safe next action: `approve 1` records human approval; OpenTag will not silently apply.",
        "Branch: `opentag/run_1` -> `main`",
        "Changed files: `src/demo.ts`",
        "Preconditions: 1 check(s) in the audit log."
      ],
      detailRows: [
        { label: "Target", value: "GitHub pull request" },
        { label: "Impact", value: "Creates a pull request from `opentag/run_1` into `main` with 1 changed file." },
        { label: "Capability / preflight", value: "External write is withheld until a human records approval." },
        { label: "Required approval", value: "Use `approve 1` to record approval without applying yet, or `reject 1`." },
        { label: "Safe next action", value: "`approve 1` records human approval; OpenTag will not silently apply." },
        { label: "Branch", value: "`opentag/run_1` -> `main`" },
        { label: "Changed files", value: "`src/demo.ts`" },
        { label: "Preconditions", value: "The branch still exists." }
      ]
    });
    const rendered = renderOpenTagPresentationPlainText(presentation);
    expect(rendered).toContain("Branch: `opentag/run_1` -> `main`");
    expect(rendered).toContain("Changed files: `src/demo.ts`");
    expect(rendered).toContain("Preconditions: 1 check(s) in the audit log.");
    expect(rendered).toContain("Safe next action: `approve 1` records human approval; OpenTag will not silently apply.");
    expect(JSON.stringify(presentation)).not.toContain("blocks");
    expect(JSON.stringify(presentation)).not.toContain("action_id");
  });

  it("renders Linear issue create action receipt details", () => {
    const presentation = createFinalSummaryPresentation({
      result: {
        conclusion: "needs_human",
        summary: "Prepared a Linear issue proposal.",
        suggestedChanges: [
          {
            proposalId: "proposal_issue",
            createdAt: "2026-06-24T00:00:00.000Z",
            summary: "Create a Linear issue.",
            intents: [
              {
                intentId: "intent_create_issue",
                domain: "issue",
                action: "create_issue",
                summary: "Create a Linear issue for the OAuth callback error.",
                params: {
                  title: "Fix OAuth callback error",
                  body: "Created from a Slack thread.",
                  teamKey: "ENG",
                  priority: "high",
                  labels: ["bug"]
                }
              }
            ]
          }
        ]
      },
      receiptContext: {
        capabilityByIntentId: {
          intent_create_issue: { state: "ready_to_apply" }
        }
      }
    });

    expect(presentation.actions?.[0]).toMatchObject({
      title: "Create a Linear issue for the OAuth callback error.",
      targetLabel: "Linear issue",
      details: expect.arrayContaining([
        "Impact: Creates a new Linear issue titled `Fix OAuth callback error` for team `ENG`.",
        "Title: `Fix OAuth callback error`",
        "Team: `ENG`",
        "Labels: `bug`"
      ]),
      detailRows: expect.arrayContaining([
        { label: "Target", value: "Linear issue" },
        { label: "Title", value: "Fix OAuth callback error" },
        { label: "Team", value: "`ENG`" },
        { label: "Priority", value: "`high`" },
        { label: "Labels", value: "`bug`" },
        { label: "Description", value: "Created from a Slack thread." }
      ])
    });
    expect(renderOpenTagPresentationPlainText(presentation)).toContain("Actions: apply 1, reject 1");
  });

  it("renders standalone action receipts with command and audit fallback", () => {
    const presentation = createActionReceiptPresentation({
      auditRunId: "run_receipt_1",
      result: {
        conclusion: "needs_human",
        summary: "Prepared a proposal.",
        suggestedChanges: [
          {
            proposalId: "proposal_1",
            createdAt: "2026-06-24T00:00:00.000Z",
            summary: "Move issue forward.",
            intents: [
              {
                intentId: "intent_label_1",
                domain: "labels",
                action: "add_label",
                summary: "Add the bug label.",
                params: { label: "bug" }
              }
            ]
          }
        ]
      },
      receiptContext: {
        capabilityByIntentId: {
          intent_label_1: {
            state: "ready_to_apply",
            visibleDecisions: ["apply", "reject"]
          }
        }
      }
    });

    expect(presentation).toMatchObject({
      kind: "action_receipt",
      title: "Ready to apply",
      auditRunId: "run_receipt_1"
    });
    expect(JSON.stringify(presentation)).not.toContain("blocks");
    expect(JSON.stringify(presentation)).not.toContain("button");
    expect(renderOpenTagPresentationPlainText(presentation!)).toBe(
      [
        "Ready to apply",
        "1. Add the bug label.",
        "Target: GitHub labels",
        "Impact: Writes label metadata on the source work item.",
        "Capability/preflight: Adapter capability and preflight allow direct apply for this target.",
        "Approval: Review impact, then use `apply 1` to approve and apply, or `reject 1`.",
        "Safe next action: `apply 1` is the safe apply path after reviewing this receipt.",
        "Actions: apply 1, reject 1",
        "Audit: opentag status --run run_receipt_1"
      ].join("\n")
    );
  });

  it("can represent interrupted run status without provider-native UI fields", () => {
    const presentation = createRunStatusPresentation({
      runId: "run_interrupted",
      state: "interrupted",
      nextAction: "Inspect audit logs before retrying."
    });

    expect(OpenTagPresentationSchema.parse(presentation)).toEqual({
      kind: "run_status",
      runId: "run_interrupted",
      state: "interrupted",
      nextAction: "Inspect audit logs before retrying."
    });
    expect(JSON.stringify(presentation)).not.toContain("blocks");
  });

  it("treats structured human waiting as attention-required status", () => {
    const presentation = createRunStatusPresentation({
      runId: "run_needs_human",
      state: "waiting_for_human",
      message: "Choose a deployment target.",
      nextAction: "Resolve escalation_1 from this source thread."
    });

    expect(OpenTagPresentationSchema.parse(presentation)).toEqual(presentation);
    expect(presentationDeliveryTier(presentation)).toBe("attention_required");
  });

  it("creates a provider-neutral doctor summary presentation", () => {
    const presentation = createDoctorSummaryPresentation({
      title: "OpenTag doctor (redacted)",
      checks: [
        { status: "ok", name: "dispatcher", message: "reachable" },
        { status: "warn", name: "runner", message: "registration not found" },
        { status: "fail", name: "executor", message: "codex missing" }
      ]
    });

    expect(OpenTagPresentationSchema.parse(presentation)).toEqual({
      kind: "doctor_summary",
      title: "OpenTag doctor (redacted)",
      checks: [
        { status: "ok", name: "dispatcher", message: "reachable" },
        { status: "warn", name: "runner", message: "registration not found" },
        { status: "fail", name: "executor", message: "codex missing" }
      ]
    });
    expect(JSON.stringify(presentation)).not.toContain("blocks");
    expect(JSON.stringify(presentation)).not.toContain("mrkdwn");
    expect(JSON.stringify(presentation)).not.toContain("button");
    expect(renderOpenTagPresentationPlainText(presentation)).toBe(
      [
        "OpenTag doctor (redacted)",
        "OK dispatcher: reachable",
        "WARN runner: registration not found",
        "FAIL executor: codex missing"
      ].join("\n")
    );
  });

  it("creates a provider-neutral source-thread status presentation", () => {
    const presentation = createSourceThreadStatusPresentation({
      title: "OpenTag status",
      sourceContainer: "lark:tenant_1/oc_chat",
      projectTarget: "github:acme/demo",
      bindingState: "bound",
      activeRun: { id: "run_active", status: "running", updatedAt: "2026-06-24T00:01:00.000Z" },
      queuedFollowUps: [{ id: "follow_up_1", status: "queued", command: "update the docs" }],
      queuedFollowUpsTotal: 3,
      currentCommand: "fix the failing test",
      nextAction: "wait for the final reply, send a follow-up, or request cancellation with /stop.",
      stopHint: "cancellation is explicit and is not reported as successful completion.",
      detailHint: "use `opentag status --run run_active` locally for audit detail."
    });

    expect(OpenTagPresentationSchema.parse(presentation)).toEqual({
      kind: "source_thread_status",
      title: "OpenTag status",
      sourceContainer: "lark:tenant_1/oc_chat",
      projectTarget: "github:acme/demo",
      bindingState: "bound",
      activeRun: { id: "run_active", status: "running", updatedAt: "2026-06-24T00:01:00.000Z" },
      queuedFollowUps: [{ id: "follow_up_1", status: "queued", command: "update the docs" }],
      queuedFollowUpsTotal: 3,
      currentCommand: "fix the failing test",
      nextAction: "wait for the final reply, send a follow-up, or request cancellation with /stop.",
      stopHint: "cancellation is explicit and is not reported as successful completion.",
      detailHint: "use `opentag status --run run_active` locally for audit detail."
    });
    expect(JSON.stringify(presentation)).not.toContain("blocks");
    expect(JSON.stringify(presentation)).not.toContain("mrkdwn");
    expect(JSON.stringify(presentation)).not.toContain("button");
    expect(renderOpenTagPresentationPlainText(presentation)).toBe(
      [
        "OpenTag status",
        "Source container: lark:tenant_1/oc_chat",
        "Project Target: github:acme/demo",
        "Active run: run_active (running), updated 2026-06-24T00:01:00.000Z",
        "Command: fix the failing test",
        "Queued follow-ups: 3 (follow_up_1 (queued): update the docs, +2 more)",
        "Next action: wait for the final reply, send a follow-up, or request cancellation with /stop.",
        "Stop/timeout: cancellation is explicit and is not reported as successful completion.",
        "Details: use `opentag status --run run_active` locally for audit detail."
      ].join("\n")
    );
  });
});
