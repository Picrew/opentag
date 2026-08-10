import { describe, expect, it } from "vitest";
import { createActionReceiptPresentation, createDoctorSummaryPresentation, createFinalSummaryPresentation, createSourceThreadStatusPresentation, OpenTagApprovalPromptPresentationSchema } from "@opentag/core";
import {
  createSlackActionReceiptBlocks,
  createSlackApprovalPromptBlocks,
  createSlackDoctorSummaryBlocks,
  createSlackFinalSummaryBlocks,
  parseSlackSuggestedActionButtonValue,
  createSlackFinalResultBlocks,
  createSlackPostMessagePayload,
  createSlackReactionPayload,
  createSlackSourceThreadStatusBlocks,
  createSlackUpdateMessagePayload,
  markdownToSlackMrkdwn,
  renderSlackActionReceiptPresentation,
  renderSlackAcknowledgement,
  renderSlackFinalSummaryPresentation,
  renderSlackFinalResult,
  slackSourceReceiptReactionName
} from "../src/render.js";

describe("Slack callback rendering", () => {
  it("renders immutable governed permission choices as native buttons", () => {
    const prompt = OpenTagApprovalPromptPresentationSchema.parse({
      kind: "approval_prompt",
      runId: "run_1",
      approvalId: "approval_action_1",
      proposalId: "proposal_action_1",
      intentId: "intent_action_1",
      actionId: "action_1",
      proposalHash: "hash_1",
      approvalEpoch: "epoch_1",
      title: "Allow publish?",
      summary: "Publish the package.",
      target: { provider: "npm", connectionId: "npm:team", operation: "publish", resource: "@acme/report", resourceVersion: "next" },
      runScope: {
        provider: "npm",
        connectionId: "npm:team",
        operation: "publish",
        grantScope: { package: "@acme/report", versions: "*" },
        targetConstraints: { queryMode: "canonical", reuse: "exact", urlQuery: { environment: "staging", force: "false" } }
      },
      decisions: ["allow_once", "allow_run", "deny"]
    });
    const blocks = createSlackApprovalPromptBlocks(prompt);
    expect(JSON.stringify(blocks)).toContain("npm / npm:team / publish / @acme/report / next");
    expect(JSON.stringify(blocks)).toContain('grantScope={\\"package\\":\\"@acme/report\\",\\"versions\\":\\"*\\"}');
    expect(JSON.stringify(blocks)).toContain("Allow for run applies only to the Run scope shown above");
    expect(JSON.stringify(blocks)).toContain('\\"urlQuery\\":{\\"environment\\":\\"staging\\",\\"force\\":\\"false\\"}');
    const actions = blocks.find((block) => block.type === "actions");
    expect(actions).toMatchObject({
      type: "actions",
      elements: [
        { text: { text: "Allow once" }, style: "primary" },
        { text: { text: "Allow for run" } },
        { text: { text: "Deny" }, style: "danger" }
      ]
    });
    if (!actions || actions.type !== "actions") throw new Error("expected actions");
    expect(actions.elements.map((button) => parseSlackSuggestedActionButtonValue(button.value))).toEqual([
      expect.objectContaining({ command: "approve 1", permissionDecision: "allow_once", proposalHash: "hash_1", actionId: "action_1" }),
      expect.objectContaining({ command: "approve 1", permissionDecision: "allow_run", proposalHash: "hash_1", actionId: "action_1" }),
      expect.objectContaining({ command: "reject 1", permissionDecision: "deny", proposalHash: "hash_1", actionId: "action_1" })
    ]);
  });
  it("renders Slack-friendly acknowledgement messages", () => {
    expect(renderSlackAcknowledgement("run_1")).toBe("Working on it.");
  });

  it("uses Slack mrkdwn for final results", () => {
    const text = renderSlackFinalResult({
      conclusion: "success",
      summary: "Echoed **OpenTag** command: [introduce yourself](https://example.com/cmd)",
      artifacts: [
        { kind: "patch", title: "Generated patch", uri: "opentag/run_1.patch" },
        { kind: "report", title: "Run report", uri: "opentag/run_1-report.md" }
      ],
      verification: [{ command: "echo '<tag>' & check", outcome: "passed" }],
      nextAction: "Open [thread](https://example.com/thread) & follow up"
    });

    expect(text).toBe(
      "*Finished: success.*\nEchoed *OpenTag* command: <https://example.com/cmd|introduce yourself>\nVerified: `echo '&lt;tag&gt;' &amp; check` passed\nArtifacts: Patch: Generated patch, Report: Run report. Details in audit/status.\nNext: Open <https://example.com/thread|thread> &amp; follow up"
    );
    expect(text).not.toContain("**success**");
  });

  it("keeps the text fallback when suggested changes render no receipts", () => {
    const text = renderSlackFinalResult({
      conclusion: "needs_human",
      summary: "Prepared a follow-up.",
      nextAction: "Reply continue 1 to refresh.",
      suggestedChanges: [
        {
          proposalId: "proposal_empty",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "No visible actions.",
          intents: []
        }
      ]
    });

    expect(text).toContain("Next: Reply continue 1 to refresh.");
  });

  it("keeps audit detail in the text fallback", () => {
    const text = renderSlackFinalResult(
      {
        conclusion: "success",
        summary: "Done."
      },
      { auditRunId: "run_1" }
    );

    expect(text).toContain("Audit: `opentag status --run run_1`");
  });

  it("converts common Markdown to Slack mrkdwn", () => {
    expect(markdownToSlackMrkdwn("**bold** and [docs](https://example.com)")).toBe("*bold* and <https://example.com|docs>");
    expect(markdownToSlackMrkdwn("Use <tag> & [docs & api](https://example.com?a=1&b=2)")).toBe(
      "Use &lt;tag&gt; &amp; <https://example.com?a=1&b=2|docs &amp; api>"
    );
  });

  it("preserves a long unmatched Markdown link prefix", () => {
    const text = `${"[".repeat(4_096)}tail`;
    expect(markdownToSlackMrkdwn(text)).toBe(text);
  });

  it("builds Slack post and update payloads", () => {
    expect(createSlackPostMessagePayload({ channelId: "C123", threadTs: "171.001", text: "**hello**" })).toEqual({
      channel: "C123",
      text: "*hello*",
      thread_ts: "171.001"
    });
    expect(createSlackUpdateMessagePayload({ channelId: "C123", messageTs: "172.001", text: "[docs](https://example.com)" })).toEqual({
      channel: "C123",
      text: "<https://example.com|docs>",
      ts: "172.001"
    });
  });

  it("builds lightweight source receipt reaction payloads", () => {
    expect(slackSourceReceiptReactionName("received")).toBe("eyes");
    expect(slackSourceReceiptReactionName("running")).toBe("hourglass_flowing_sand");
    expect(createSlackReactionPayload({ channelId: "C123", messageTs: "171.001", name: "eyes" })).toEqual({
      channel: "C123",
      timestamp: "171.001",
      name: "eyes"
    });
  });

  it("builds Block Kit sections for final results", () => {
    const blocks = createSlackFinalResultBlocks({
      conclusion: "success",
      summary: "See [PR](https://example.com/pr)",
      verification: [{ command: "echo '<tag>'", outcome: "passed" }]
    });

    expect(blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Finished: success.*\nSee <https://example.com/pr|PR>"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Verified: `echo '&lt;tag&gt;'` passed"
        }
      }
    ]);
  });

  it("keeps escaped final summaries within Slack section text limits", () => {
    const blocks = createSlackFinalResultBlocks({
      conclusion: "success",
      summary: "&<>".repeat(1000)
    });

    const summaryBlock = blocks[0];
    if (summaryBlock?.type !== "section") throw new Error("expected summary section");
    expect(summaryBlock.text.text).toContain("&amp;&lt;&gt;");
    expect(summaryBlock.text.text.length).toBeLessThanOrEqual(3000);
    expect(summaryBlock.text.text.split("\n", 2)[1]?.length).toBeLessThanOrEqual(2500);
    expect(summaryBlock.text.text.endsWith("…")).toBe(true);
  });

  it("preserves final-summary paragraphs while normalizing CRLF and lone CR", () => {
    const blocks = createSlackFinalResultBlocks({
      conclusion: "success",
      summary: "first paragraph\r\n\r\nsecond paragraph\rthird line"
    });

    const summaryBlock = blocks[0];
    if (summaryBlock?.type !== "section") throw new Error("expected summary section");
    expect(summaryBlock.text.text).toBe("*Finished: success.*\nfirst paragraph\n\nsecond paragraph\nthird line");
  });

  it("keeps truncated final summaries as well-formed Unicode", () => {
    const blocks = createSlackFinalResultBlocks({
      conclusion: "success",
      summary: "😀".repeat(1300)
    });

    const summaryBlock = blocks[0];
    if (summaryBlock?.type !== "section") throw new Error("expected summary section");
    const summaryText = summaryBlock.text.text.split("\n", 2)[1] ?? "";
    expect(summaryText.isWellFormed()).toBe(true);
    expect(summaryText.length).toBeLessThanOrEqual(2500);
    expect(summaryText.endsWith("…")).toBe(true);
  });

  it("keeps compact one-line fields collapsed", () => {
    const text = renderSlackFinalResult({
      conclusion: "success",
      summary: "Done.",
      nextAction: "open the thread\r\nthen\tfollow up"
    });

    expect(text).toContain("Next: open the thread then follow up");
    expect(text).not.toContain("open the thread\nthen");
  });

  it("builds Block Kit sections for source-thread status", () => {
    const blocks = createSlackSourceThreadStatusBlocks(
      createSourceThreadStatusPresentation({
        title: "OpenTag status:",
        sourceContainer: "slack:T123/C123",
        projectTarget: "github:acme/demo",
        bindingState: "bound",
        activeRun: { id: "run_active", status: "running", updatedAt: "2026-06-24T00:02:00.000Z" },
        currentCommand: "fix **this**",
        queuedFollowUps: [{ id: "follow_1", status: "queued", command: "update the docs" }],
        queuedFollowUpsTotal: 3,
        nextAction: "wait for final reply or run `opentag status --run run_active`.",
        stopHint: "cancellation is explicit.",
        detailHint: "audit detail stays local."
      })
    );

    const rendered = JSON.stringify(blocks);
    expect(blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "*OpenTag status:*" }
    });
    expect(rendered).toContain("Project Target: `github:acme/demo`");
    expect(rendered).toContain("*Active run:* run_active (running), updated 2026-06-24T00:02:00.000Z");
    expect(rendered).toContain("*Command:* fix *this*");
    expect(rendered).toContain("*Queued follow-ups:* 3 (follow_1 (queued): update the docs, +2 more)");
  });

  it("builds Block Kit sections for doctor summaries", () => {
    const blocks = createSlackDoctorSummaryBlocks(
      createDoctorSummaryPresentation({
        title: "OpenTag doctor (redacted):",
        checks: [
          { status: "ok", name: "Dispatcher", message: "reachable" },
          { status: "warn", name: "Runtime readiness", message: "service status degraded" }
        ]
      })
    );

    const rendered = JSON.stringify(blocks);
    expect(blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "*OpenTag doctor (redacted):*" }
    });
    expect(rendered).toContain("*OK Dispatcher*");
    expect(rendered).toContain("*WARN Runtime readiness*");
    expect(rendered).not.toContain("blocks");
  });

  it("adds the quiet audit context even when no receipts render", () => {
    const blocks = createSlackFinalResultBlocks({
      conclusion: "success",
      summary: "Done."
    }, {
      auditRunId: "run_without_receipts"
    });

    expect(blocks.at(-1)).toEqual({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Audit: `opentag status --run run_without_receipts`"
        }
      ]
    });
  });

  it("adds Block Kit buttons for suggested source-thread actions", () => {
    const blocks = createSlackFinalResultBlocks({
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
    }, {
      auditRunId: "run_receipt_1",
      receiptContext: {
        capabilityByIntentId: {
          intent_label_1: { state: "ready_to_apply" }
        }
      }
    });

    const rendered = JSON.stringify(blocks);
    expect(rendered).toContain("Ready to apply");
    expect(rendered).toContain("1. *Add the bug label.*");
    expect(rendered).toContain("Reply: `apply 1` / `reject 1`");
    expect(rendered).not.toContain("Full action details stay in OpenTag audit/status.");
    expect(rendered).not.toContain("Target: GitHub labels");
    expect(rendered).toContain("Audit: `opentag status --run run_receipt_1`");
    expect(rendered).not.toContain("Proposal:");
    expect(rendered).not.toContain("Intent ID:");

    const actionsBlock = blocks.find((block) => block.type === "actions");
    expect(blocks.at(-1)).toEqual({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Audit: `opentag status --run run_receipt_1`"
        }
      ]
    });
    expect(actionsBlock).toMatchObject({
      type: "actions",
      block_id: "opentag_compact_actions_1",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Apply 1" }, action_id: "opentag:apply:1", style: "primary" },
        { type: "button", text: { type: "plain_text", text: "Reject 1" }, action_id: "opentag:reject:1", style: "danger" }
      ]
    });

    if (actionsBlock?.type !== "actions") throw new Error("expected actions block");
    expect(actionsBlock.elements.map((element) => parseSlackSuggestedActionButtonValue(element.value))).toEqual([
      {
        version: 1,
        command: "apply 1",
        proposalId: "proposal_1",
        intentId: "intent_label_1"
      },
      {
        version: 1,
        command: "reject 1",
        proposalId: "proposal_1",
        intentId: "intent_label_1"
      }
    ]);
  });

  it("does not duplicate reply commands when only reject is available", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_slack_reject_only",
      result: {
        conclusion: "needs_human",
        summary: "Prepared a reject-only action.",
        suggestedChanges: [
          {
            proposalId: "proposal_reject_only",
            createdAt: "2026-06-24T00:00:00.000Z",
            summary: "Reject-only follow-up.",
            intents: [
              {
                intentId: "intent_reject_only",
                domain: "follow_up",
                action: "record_decision",
                summary: "Reject this generated follow-up."
              }
            ]
          }
        ]
      },
      receiptContext: {
        capabilityByIntentId: {
          intent_reject_only: {
            state: "needs_approval",
            primaryDecision: "none",
            visibleDecisions: ["reject"]
          }
        }
      }
    });

    const text = renderSlackFinalSummaryPresentation(presentation);
    const blocks = createSlackFinalSummaryBlocks(presentation);
    const renderedBlocks = JSON.stringify(blocks);

    expect(text).toContain("Reply: `reject 1`");
    expect(text).not.toContain("Reply: `reject 1` / `reject 1`");
    expect(renderedBlocks).toContain("Reply: `reject 1`");
    expect(renderedBlocks).not.toContain("Reply: `reject 1` / `reject 1`");

    const actionsBlock = blocks.find((block) => block.type === "actions");
    if (actionsBlock?.type !== "actions") throw new Error("expected actions block");
    expect(actionsBlock.elements).toHaveLength(1);
    expect(actionsBlock.elements).toMatchObject([
      { type: "button", text: { type: "plain_text", text: "Reject 1" }, action_id: "opentag:reject:1" }
    ]);
  });

  it("renders standalone action receipt presentations with Block Kit buttons", () => {
    const presentation = createActionReceiptPresentation({
      auditRunId: "run_receipt_standalone",
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
          intent_label_1: { state: "ready_to_apply" }
        }
      }
    });
    if (!presentation) throw new Error("expected action receipt presentation");

    const text = renderSlackActionReceiptPresentation(presentation);
    const blocks = createSlackActionReceiptBlocks(presentation);

    expect(text).toContain("*Ready to apply*");
    expect(text).toContain("1. *Add the bug label.*");
    expect(text).toContain("Audit: `opentag status --run run_receipt_standalone`");
    expect(JSON.stringify(blocks)).toContain("Choose an action in this thread");
    expect(blocks.at(-1)).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Audit: `opentag status --run run_receipt_standalone`" }]
    });

    const actionsBlock = blocks.find((block) => block.type === "actions");
    if (actionsBlock?.type !== "actions") throw new Error("expected actions block");
    expect(actionsBlock.elements.map((element) => parseSlackSuggestedActionButtonValue(element.value))).toEqual([
      {
        version: 1,
        command: "apply 1",
        proposalId: "proposal_1",
        intentId: "intent_label_1"
      },
      {
        version: 1,
        command: "reject 1",
        proposalId: "proposal_1",
        intentId: "intent_label_1"
      }
    ]);
  });

  it("renders interactive Slack actions from semantic final summary presentation", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_semantic_1",
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
                summary: "Create a pull request for branch opentag/run_1.",
                params: {
                  head: "opentag/run_1",
                  base: "main",
                  changedFiles: ["src/demo.ts"]
                }
              }
            ]
          }
        ]
      },
      receiptContext: {
        capabilityByIntentId: {
          intent_create_pr: { state: "ready_to_apply" }
        }
      }
    });

    const text = renderSlackFinalSummaryPresentation(presentation);
    const blocks = createSlackFinalSummaryBlocks(presentation);

    expect(text).toContain("*Actions*");
    expect(text).toContain("Ready to apply");
    expect(text).toContain("1. *Create a pull request*");
    expect(text).toContain("Reply: `apply 1` / `reject 1`");
    expect(text).not.toContain("Branch: `opentag/run_1` -> `main`");
    expect(text).not.toContain("Changed files: `src/demo.ts`");
    expect(text).toContain("Audit: `opentag status --run run_semantic_1`");
    expect(JSON.stringify(blocks)).toContain("Create a pull request");
    expect(JSON.stringify(blocks)).not.toContain("Create a pull request for branch opentag/run_1.");
    expect(JSON.stringify(blocks)).not.toContain("Branch: `opentag/run_1` -> `main`");
    expect(JSON.stringify(blocks)).not.toContain("Proposal:");
    expect(JSON.stringify(blocks)).not.toContain("Intent ID:");

    const actionsBlock = blocks.find((block) => block.type === "actions");
    if (actionsBlock?.type !== "actions") throw new Error("expected actions block");
    expect(actionsBlock.elements.map((element) => parseSlackSuggestedActionButtonValue(element.value))).toEqual([
      {
        version: 1,
        command: "apply 1",
        proposalId: "proposal_pr",
        intentId: "intent_create_pr"
      },
      {
        version: 1,
        command: "reject 1",
        proposalId: "proposal_pr",
        intentId: "intent_create_pr"
      }
    ]);
  });

  it("renders interactive Slack actions for Linear issue creation", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_linear_issue_1",
      result: {
        conclusion: "needs_human",
        summary: "Prepared a Linear issue proposal.",
        suggestedChanges: [
          {
            proposalId: "proposal_linear_issue",
            createdAt: "2026-06-24T00:00:00.000Z",
            summary: "Create a Linear issue.",
            intents: [
              {
                intentId: "intent_create_linear_issue",
                domain: "issue",
                action: "create_issue",
                summary: "Create a Linear issue for the OAuth callback error.",
                params: {
                  title: "Fix OAuth callback error",
                  body: "Created from a Slack thread.",
                  teamKey: "ENG"
                }
              }
            ]
          }
        ]
      },
      receiptContext: {
        capabilityByIntentId: {
          intent_create_linear_issue: { state: "ready_to_apply" }
        }
      }
    });

    const text = renderSlackFinalSummaryPresentation(presentation);
    const blocks = createSlackFinalSummaryBlocks(presentation);

    expect(text).toContain("Ready to apply");
    expect(text).toContain("1. *Create a Linear issue for the OAuth callback error.*");
    expect(text).toContain("Reply: `apply 1` / `reject 1`");
    expect(text).not.toContain("Description: Created from a Slack thread.");
    expect(JSON.stringify(blocks)).toContain("Create a Linear issue");
    const actionsBlock = blocks.find((block) => block.type === "actions");
    if (actionsBlock?.type !== "actions") throw new Error("expected actions block");
    expect(actionsBlock.elements.map((element) => parseSlackSuggestedActionButtonValue(element.value))).toEqual([
      {
        version: 1,
        command: "apply 1",
        proposalId: "proposal_linear_issue",
        intentId: "intent_create_linear_issue"
      },
      {
        version: 1,
        command: "reject 1",
        proposalId: "proposal_linear_issue",
        intentId: "intent_create_linear_issue"
      }
    ]);
  });

  it("groups mixed action receipts and keeps Slack text fallback readable", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_slack_mixed",
      result: {
        conclusion: "success",
        summary:
          "What changed:\n- `opentag-smoke/slack-live.txt`: Created new file with exactly one line: Slack source-thread live E2E.",
        suggestedChanges: [
          {
            proposalId: "proposal_mixed",
            createdAt: "2026-06-24T00:00:00.000Z",
            summary: "Move Slack source-thread smoke forward.",
            preconditions: ["Executor completed successfully."],
            intents: [
              {
                intentId: "intent_create_pr",
                domain: "pull_request",
                action: "create_pull_request",
                summary: "Create a pull request for branch opentag/run_slack.",
                params: {
                  head: "opentag/run_slack",
                  base: "main",
                  changedFiles: ["opentag-smoke/"]
                }
              },
              {
                intentId: "intent_link_branch",
                domain: "artifact_links",
                action: "link_artifact",
                summary: "Link the run branch to the work item.",
                params: {}
              },
              {
                intentId: "intent_request_review",
                domain: "review",
                action: "request_review",
                summary: "Request human review of the generated code changes.",
                params: {}
              }
            ]
          }
        ]
      },
      receiptContext: {
        capabilityByIntentId: {
          intent_create_pr: { state: "ready_to_apply" },
          intent_link_branch: {
            state: "unsupported",
            setupReason: "This action is audit-only for now; continue if a follow-up run should handle it."
          },
          intent_request_review: {
            state: "needs_setup",
            setupReason: "Direct apply for Slack actions is not configured on this dispatcher."
          }
        }
      }
    });

    const text = renderSlackFinalSummaryPresentation(presentation);
    const blocks = createSlackFinalSummaryBlocks(presentation);
    expect(presentation.actionReceiptTitle).toBe("1 action ready to apply, 1 action needs setup, 1 action needs attention");
    expect(text).toContain("*Actions*");
    expect(text).toContain("1 action ready to apply, 1 action needs setup, 1 action needs attention");
    expect(text).toContain("1. *Create a pull request*");
    expect(text).toContain("2. *Link the run branch*");
    expect(text).toContain("Needs attention: Audit-only for now; use audit/status for details.");
    expect(text).toContain("3. *Request human review of the generated code changes.*");
    expect(text).toContain("Needs setup: Direct apply for Slack actions is not configured on this dispatcher.");
    expect(text).not.toContain("more action(s) in audit/status.");
    expect(text).not.toContain("*Ready to apply*\n\n1.");
    expect(text).not.toContain("*Needs setup*\n\n3.");
    expect(text).not.toContain("*Needs attention*\n\n2.");
    expect(text).not.toContain("Preconditions: 1 check(s) in the audit log.");
    expect(text).not.toContain("Some actions need setup");
    expect(text).not.toContain("audit log.1.");
    expect(text).not.toContain("audit log.2.");

    const actionSummarySections = blocks
      .filter((block) => block.type === "section")
      .map((block) => block.text.text)
      .filter((text) => text.startsWith("*Actions*"));
    expect(actionSummarySections).toEqual(["*Actions*\n1 action ready to apply, 1 action needs setup, 1 action needs attention"]);

    const compactActionSections = blocks
      .filter((block) => block.type === "section")
      .map((block) => block.text.text)
      .filter((text) => /^\d+\. \*/u.test(text));
    expect(compactActionSections).toEqual([
      "1. *Create a pull request*\nReply: `apply 1` / `reject 1`",
      "2. *Link the run branch*\nNeeds attention: Audit-only for now; use audit/status for details.\nReply: `continue 2` / `reject 2`",
      "3. *Request human review of the generated code changes.*\nNeeds setup: Direct apply for Slack actions is not configured on this dispatcher.\nReply: `continue 3` / `reject 3`"
    ]);
    expect(compactActionSections.join("\n")).not.toContain("Branch: `opentag/run_slack` -> `main`");

    const compactActionButtonBlocks = blocks
      .filter((block) => block.type === "actions")
      .map((block) => ({ block_id: block.block_id, labels: block.elements.map((element) => element.text.text) }));
    expect(compactActionButtonBlocks).toEqual([
      { block_id: "opentag_compact_actions_1", labels: ["Apply 1", "Reject 1"] },
      { block_id: "opentag_compact_actions_2", labels: ["Continue 2", "Reject 2"] },
      { block_id: "opentag_compact_actions_3", labels: ["Continue 3", "Reject 3"] }
    ]);
  });

  it("does not show Apply when receipt capability is not proven", () => {
    const blocks = createSlackFinalResultBlocks({
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
    });

    const rendered = JSON.stringify(blocks);
    expect(rendered).toContain("Needs approval");
    expect(rendered).not.toContain("Apply 1");
    expect(rendered).not.toContain("opentag:apply:1");
    expect(rendered).not.toContain('"command":"apply 1"');
    expect(rendered).toContain("Approve 1");
    expect(rendered).toContain("Reject 1");
  });

  it("caps suggested action blocks to stay under Slack's Block Kit limit", () => {
    const result = {
      conclusion: "needs_human" as const,
      summary: "Prepared many proposals.",
      suggestedChanges: Array.from({ length: 30 }, (_item, index) => ({
        proposalId: `proposal_${index + 1}`,
        createdAt: "2026-06-24T00:00:00.000Z",
        summary: `Move item ${index + 1}.`,
        intents: [
          {
            intentId: `intent_${index + 1}`,
            domain: "labels",
            action: "add_label",
            summary: `Add label ${index + 1}.`,
            params: { label: `label-${index + 1}` }
          }
        ]
      }))
    };
    const blocks = createSlackFinalResultBlocks(result, {
      receiptContext: {
        capabilityByIntentId: Object.fromEntries(
          result.suggestedChanges.flatMap((snapshot) => snapshot.intents.map((intent) => [intent.intentId, { state: "ready_to_apply" as const }]))
        )
      }
    });

    const rendered = JSON.stringify(blocks);
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(rendered).toContain("Apply 1");
    expect(rendered).toContain("Apply 2");
    expect(rendered).toContain("Apply 3");
    expect(rendered).not.toContain("Apply 4");
    expect(rendered).not.toContain("Apply 20");
    expect(rendered).not.toContain("Apply 21");
    expect(rendered).toContain("+27 more action(s) in audit/status.");
  });
});
