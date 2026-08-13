import { describe, expect, it } from "vitest";
import { createActionReceiptPresentation, createDoctorSummaryPresentation, createSourceThreadStatusPresentation } from "@opentag/core";
import { createDefaultProviderPresentation } from "../src/presentation.js";

describe("default callback presentation", () => {
  it("uses platform liveness capability to decide callback acknowledgements", () => {
    const presentation = createDefaultProviderPresentation();

    expect(presentation.shouldDeliverAcknowledgement("lark")).toBe(false);
    expect(presentation.shouldDeliverAcknowledgement("slack")).toBe(false);
    expect(presentation.shouldDeliverAcknowledgement("telegram")).toBe(true);
    expect(presentation.shouldDeliverAcknowledgement("github")).toBe(true);
    expect(presentation.shouldDeliverAcknowledgement("custom")).toBe(true);
  });

  it("uses platform liveness capability to decide callback status and progress delivery", () => {
    const presentation = createDefaultProviderPresentation();

    expect(presentation.shouldDeliverStatusUpdate("slack")).toBe(true);
    expect(presentation.shouldDeliverStatusUpdate("lark")).toBe(true);
    expect(presentation.shouldDeliverStatusUpdate("telegram")).toBe(true);
    expect(presentation.shouldDeliverStatusUpdate("github")).toBe(true);
    expect(presentation.shouldDeliverStatusUpdate("custom")).toBe(true);
    expect(presentation.shouldDeliverRunStatusUpdate?.({ provider: "lark", state: "running" })).toBe(true);
    expect(presentation.shouldDeliverRunStatusUpdate?.({ provider: "lark", state: "queued" })).toBe(true);
    expect(presentation.shouldDeliverRunStatusUpdate?.({ provider: "github", state: "running" })).toBe(true);

    expect(presentation.shouldDeliverProgress("slack")).toBe(false);
    expect(presentation.shouldDeliverProgress("lark")).toBe(false);
    expect(presentation.shouldDeliverProgress("telegram")).toBe(true);
    expect(presentation.shouldDeliverProgress("github")).toBe(true);
    expect(presentation.shouldDeliverProgress("custom")).toBe(true);
  });

  it("renders the same queued and running Run Card semantics for native Slack and Lark channels", () => {
    const presentation = createDefaultProviderPresentation();

    expect(presentation.shouldDeliverStatusUpdate("slack")).toBe(true);
    expect(presentation.shouldDeliverStatusUpdate("lark")).toBe(true);
    expect(presentation.shouldDeliverProgress("slack")).toBe(false);
    expect(presentation.shouldDeliverProgress("lark")).toBe(false);

    for (const state of ["queued", "running"] as const) {
      const semantic = presentation.runStatusPresentation({
        runId: "run_channel_parity",
        state,
        message: state === "queued" ? "Queued for the configured agent." : "Running with the configured agent.",
        nextAction: "Wait for the next meaningful milestone.",
        detailVisibility: "source_thread"
      });
      const slack = presentation.render({ provider: "slack", presentation: semantic });
      const lark = presentation.render({ provider: "lark", presentation: semantic });

      expect(slack.blocks?.length).toBeGreaterThan(0);
      expect(JSON.stringify(slack.blocks)).toContain("run_channel_parity");
      expect(JSON.stringify(slack.blocks)).toContain(state === "queued" ? "Queued" : "Running");
      expect(lark.rich?.provider).toBe("lark");
      expect(JSON.stringify(lark.rich)).toContain("run_channel_parity");
      expect(JSON.stringify(lark.rich)).toContain(state === "queued" ? "Queued" : "Running");
    }
  });

  it("renders GitHub and Slack with provider-specific markup", () => {
    const presentation = createDefaultProviderPresentation();
    const result = {
      conclusion: "success" as const,
      summary: "done",
      verification: [{ command: "echo", outcome: "passed" as const }]
    };

    expect(presentation.acknowledgement({ provider: "github", runId: "run_1" })).toBe("OpenTag picked this up. Run: `run_1`");
    expect(presentation.acknowledgement({ provider: "slack", runId: "run_1" })).toBe(
      "*OpenTag: Received*\nRun: `run_1`",
    );
    expect(presentation.acknowledgement({ provider: "lark", runId: "run_1" })).toBe(
      ["Received. OpenTag is working.", "Run: run_1", "Use /status here for queue state; audit locally with opentag status --run run_1."].join("\n")
    );
    expect(presentation.acknowledgement({ provider: "telegram", runId: "run_1" })).toBe(
      ["<b>OpenTag picked this up</b>", "Run: <code>run_1</code>", "Status: <b>received</b>"].join("\n")
    );
    expect(presentation.final({ provider: "github", result })).toEqual({
      body: "OpenTag finished with **success**.\n\ndone\n\nVerification:\n- `echo`: passed"
    });
    expect(presentation.final({ provider: "slack", result })).toEqual({
      body: "*Finished: success.*\ndone\nVerified: `echo` passed",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Finished: success.*\ndone"
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Verified: `echo` passed"
          }
        }
      ]
    });
    expect(presentation.final({ provider: "telegram", result })).toEqual({
      body: ["<b>OpenTag finished</b>", "Status: <b>success</b>", "Summary: done", "Verification: echo: passed"].join("\n"),
      rich: {
        provider: "telegram",
        payload: { parseMode: "HTML" }
      }
    });
    expect(presentation.final({ provider: "lark", result })).toMatchObject({
      body: "Finished with success.\n\ndone\n\nVerification\n- echo: passed",
      rich: {
        provider: "lark",
        payload: {
          header: {
            template: "green",
            title: { content: "Finished: success" }
          }
        }
      }
    });
  });

  it("produces semantic presentations before provider rendering", () => {
    const presentation = createDefaultProviderPresentation();
    const acknowledgement = presentation.acknowledgementPresentation({ runId: "run_1" });
    const final = presentation.finalPresentation({
      runId: "run_1",
      result: {
        conclusion: "success" as const,
        summary: "done"
      }
    });

    expect(acknowledgement).toMatchObject({
      kind: "run_status",
      runId: "run_1",
      state: "received",
      detailVisibility: "source_thread"
    });
    expect(final).toMatchObject({
      kind: "final_summary",
      outcome: "success",
      summary: "done",
      auditRunId: "run_1"
    });
    expect(presentation.render({ provider: "github", presentation: acknowledgement }).body).toBe("OpenTag picked this up. Run: `run_1`");
    expect(presentation.render({ provider: "slack", presentation: final }).body).toBe(
      "*Finished: success.*\ndone\n\nAudit: `opentag status --run run_1`"
    );
  });

  it("renders lightweight run-status liveness states through semantic presentations", () => {
    const presentation = createDefaultProviderPresentation();
    const queued = presentation.runStatusPresentation({
      runId: "run_queued",
      state: "queued",
      message: "Queued behind an active run.",
      nextAction: "Use /status for queue details.",
      detailVisibility: "source_thread"
    });
    const waiting = presentation.runStatusPresentation({
      runId: "run_waiting",
      state: "waiting_for_approval",
      message: "Waiting for approval.",
      nextAction: "Approve or reject in the source thread.",
      detailVisibility: "source_thread"
    });

    expect(queued).toMatchObject({
      kind: "run_status",
      runId: "run_queued",
      state: "queued",
      detailVisibility: "source_thread"
    });
    expect(presentation.render({ provider: "github", presentation: queued }).body).toBe(
      "OpenTag progress for `run_queued`: Queued behind an active run."
    );
    expect(presentation.render({ provider: "lark", presentation: queued }).body).toBe(
      ["Queued behind an active run.", "Run: run_queued", "Use /status here for queue details."].join("\n")
    );
    expect(presentation.runStatus({ provider: "github", runId: "run_running", state: "running", message: "Running with codex." })).toEqual({
      body: "OpenTag progress for `run_running`: Running with codex."
    });
    expect(presentation.render({ provider: "telegram", presentation: waiting })).toMatchObject({
      body: ["<b>OpenTag is working</b>", "Run: <code>run_waiting</code>", "Status: <b>running</b>", "", "Waiting for approval."].join("\n"),
      rich: {
        provider: "telegram",
        payload: {
          parseMode: "HTML",
          replyMarkup: {
            inline_keyboard: [
              [
                { text: "Copy run id", copy_text: { text: "run_waiting" } },
                { text: "Copy audit", copy_text: { text: "opentag status --run run_waiting" } }
              ]
            ]
          }
        }
      }
    });
  });

  it("renders doctor summaries through semantic fallback and provider-native UI where supported", () => {
    const presentation = createDefaultProviderPresentation();
    const doctor = createDoctorSummaryPresentation({
      title: "OpenTag doctor (redacted)",
      checks: [
        { status: "ok", name: "dispatcher", message: "reachable" },
        { status: "warn", name: "runner registration", message: "runner_not_found" },
        { status: "fail", name: "executor", message: "codex missing" }
      ]
    });

    const fallback = [
      "OpenTag doctor (redacted)",
      "OK dispatcher: reachable",
      "WARN runner registration: runner_not_found",
      "FAIL executor: codex missing"
    ].join("\n");

    expect(presentation.render({ provider: "github", presentation: doctor })).toEqual({ body: fallback });
    expect(presentation.render({ provider: "telegram", presentation: doctor })).toEqual({ body: fallback });
    expect(presentation.render({ provider: "custom", presentation: doctor })).toEqual({ body: fallback });
    const slackDoctor = presentation.render({ provider: "slack", presentation: doctor });
    expect(slackDoctor.body).toBe(fallback);
    expect(slackDoctor.blocks?.[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*OpenTag doctor (redacted)*"
      }
    });
    expect(JSON.stringify(slackDoctor.blocks)).toContain("codex missing");
    expect(presentation.render({ provider: "lark", presentation: doctor })).toMatchObject({
      body: fallback,
      rich: {
        provider: "lark",
        payload: {
          header: {
            title: { content: "OpenTag doctor (redacted)" }
          }
        }
      }
    });
  });

  it("renders source-thread status as rich Slack and Lark status cards with plain-text fallback", () => {
    const presentation = createDefaultProviderPresentation();
    const status = createSourceThreadStatusPresentation({
      sourceContainer: "slack:T123/C456",
      projectTarget: "github:acme/demo",
      bindingState: "bound",
      activeRun: {
        id: "run_active",
        status: "running",
        updatedAt: "2026-06-24T00:00:00.000Z"
      },
      queuedFollowUps: [
        {
          id: "follow_up_1",
          status: "queued",
          command: "label this bug"
        }
      ],
      queuedFollowUpsTotal: 1,
      currentCommand: "fix this flaky test",
      nextAction: "wait for the final reply, send a follow-up, or request cancellation with /stop.",
      stopHint: "cancellation is explicit and is not reported as successful completion.",
      detailHint: "use `opentag status --run run_active` locally for audit detail."
    });
    const fallback = [
      "OpenTag status",
      "Source container: slack:T123/C456",
      "Project Target: github:acme/demo",
      "Active run: run_active (running), updated 2026-06-24T00:00:00.000Z",
      "Command: fix this flaky test",
      "Queued follow-ups: 1 (follow_up_1 (queued): label this bug)",
      "Next action: wait for the final reply, send a follow-up, or request cancellation with /stop.",
      "Stop/timeout: cancellation is explicit and is not reported as successful completion.",
      "Details: use `opentag status --run run_active` locally for audit detail."
    ].join("\n");

    expect(presentation.render({ provider: "github", presentation: status })).toEqual({ body: fallback });
    expect(presentation.render({ provider: "custom", presentation: status })).toEqual({ body: fallback });
    const slackStatus = presentation.render({ provider: "slack", presentation: status });
    expect(slackStatus.body).toBe(fallback);
    expect(slackStatus.blocks?.[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*OpenTag status*"
      }
    });
    expect(JSON.stringify(slackStatus.blocks)).toContain("label this bug");
    expect(presentation.render({ provider: "lark", presentation: status })).toMatchObject({
      body: fallback,
      rich: {
        provider: "lark",
        payload: {
          header: {
            title: { content: "OpenTag status" }
          }
        }
      }
    });
    expect(JSON.stringify(presentation.render({ provider: "lark", presentation: status }).rich)).toContain("label this bug");
  });

  it("escapes Slack fallbacks for plain doctor and source-thread presentations", () => {
    const presentation = createDefaultProviderPresentation();
    const doctor = createDoctorSummaryPresentation({
      title: "OpenTag doctor <redacted> & ready",
      checks: [{ status: "ok", name: "dispatcher <local>", message: "reachable & healthy" }]
    });
    const status = createSourceThreadStatusPresentation({
      sourceContainer: "slack:T123/C456",
      projectTarget: "github:acme/demo",
      bindingState: "bound",
      queuedFollowUps: [],
      queuedFollowUpsTotal: 0,
      currentCommand: "fix <tag> & [docs](https://example.com)",
      nextAction: "wait & review <output>"
    });

    const slackDoctor = presentation.render({ provider: "slack", presentation: doctor });
    expect(slackDoctor.body).toContain("OpenTag doctor &lt;redacted&gt; &amp; ready");
    expect(slackDoctor.body).toContain("dispatcher &lt;local&gt;: reachable &amp; healthy");
    expect(slackDoctor.blocks).toBeDefined();

    const slackStatus = presentation.render({ provider: "slack", presentation: status });
    expect(slackStatus.body).toContain("Command: fix &lt;tag&gt; &amp; <https://example.com|docs>");
    expect(slackStatus.body).toContain("Next action: wait &amp; review &lt;output&gt;");
    expect(slackStatus.blocks).toBeDefined();

    expect(presentation.render({ provider: "github", presentation: doctor }).body).toContain("OpenTag doctor <redacted> & ready");
    expect(presentation.render({ provider: "custom", presentation: status }).body).toContain("Command: fix <tag> & [docs](https://example.com)");
  });

  it("renders standalone action receipts as Slack and Lark native UI with plain-text fallback", () => {
    const presentation = createDefaultProviderPresentation();
    const receipt = createActionReceiptPresentation({
      auditRunId: "run_action_receipt",
      result: {
        conclusion: "needs_human" as const,
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
          intent_label_1: { state: "ready_to_apply" as const }
        }
      }
    });
    if (!receipt) throw new Error("expected action receipt presentation");

    const fallback = [
      "Ready to apply",
      "1. Add the bug label.",
      "Target: GitHub labels",
      "Impact: Writes label metadata on the source work item.",
      "Capability/preflight: Adapter capability and preflight allow direct apply for this target.",
      "Approval: Review impact, then use `apply 1` to approve and apply, or `reject 1`.",
      "Safe next action: `apply 1` is the safe apply path after reviewing this receipt.",
      "Actions: apply 1, reject 1",
      "Audit: opentag status --run run_action_receipt"
    ].join("\n");

    expect(presentation.render({ provider: "github", presentation: receipt })).toEqual({ body: fallback });
    expect(presentation.render({ provider: "custom", presentation: receipt })).toEqual({ body: fallback });

    const slack = presentation.render({ provider: "slack", presentation: receipt });
    expect(slack.body).toContain("*Ready to apply*");
    expect(slack.body).toContain("Audit: `opentag status --run run_action_receipt`");
    expect(JSON.stringify(slack.blocks)).toContain("opentag:apply:1");
    expect(JSON.stringify(slack.blocks)).toContain("opentag:reject:1");

    const lark = presentation.render({ provider: "lark", presentation: receipt });
    expect(lark.body).toContain("Ready to apply");
    expect(lark.body).toContain("Audit: opentag status --run run_action_receipt");
    expect(lark.rich).toMatchObject({
      provider: "lark",
      payload: {
        header: {
          title: { content: "Ready to apply" }
        }
      }
    });
    expect(JSON.stringify(lark.rich)).toContain("Apply now: apply 1");
  });

  it("renders Telegram progress as concise conversational states", () => {
    const presentation = createDefaultProviderPresentation();

    expect(presentation.progress({ provider: "telegram", runId: "run_1", message: "Starting ACP agent claude-code in scratch workspace" })).toBe(
      ["<b>OpenTag is thinking</b>", "Run: <code>run_1</code>", "Status: <b>running</b>"].join("\n")
    );
    expect(
      presentation.progress({
        provider: "telegram",
        runId: "run_1",
        message: "Creating isolated branch opentag/run_1"
      })
    ).toBe(
      [
        "<b>OpenTag is working</b>",
        "Run: <code>run_1</code>",
        "Status: <b>running</b>",
        "",
        "Creating isolated branch opentag/run_1"
      ].join("\n")
    );
  });

  it("renders structured next actions by summary", () => {
    const presentation = createDefaultProviderPresentation();
    const result = {
      conclusion: "needs_human" as const,
      summary: "Prepared a suggested change snapshot.",
      nextAction: {
        summary: "Approve intent_label_1 to add the bug label.",
        hint: {
          kind: "apply_suggested_changes" as const,
          targetId: "proposal_1",
          selectedIntentIds: ["intent_label_1"]
        }
      }
    };

    expect(presentation.final({ provider: "github", result }).body).toContain("Next action: Approve intent_label_1");
    expect(presentation.final({ provider: "slack", result }).body).toContain("Next: Approve intent_label_1");
    expect(presentation.final({ provider: "slack", result }).blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Finished: needs_human.*\nPrepared a suggested change snapshot."
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Next: Approve intent_label_1 to add the bug label."
        }
      }
    ]);
    expect(presentation.final({ provider: "github", result }).body).not.toContain("[object Object]");
  });

  it("renders suggested changes as thread-native actions", () => {
    const presentation = createDefaultProviderPresentation();
    const result = {
      conclusion: "needs_human" as const,
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
          ],
          preconditions: ["The issue is still open."]
        }
      ]
    };
    const receiptContext = {
      capabilityByIntentId: {
        intent_label_1: { state: "ready_to_apply" as const }
      }
    };

    const github = presentation.final({ provider: "github", result, runId: "run_receipt_1", receiptContext }).body;
    expect(github).toContain("<summary>Ready to apply</summary>");
    expect(github).toContain("source-thread action receipt");
    expect(github).toContain("Audit: run `opentag status --run run_receipt_1` locally.");
    expect(github).toContain("#### 1. Add the bug label.");
    expect(github).toContain("| Target | GitHub labels |");
    expect(github).toContain("| Preconditions | The issue is still open. |");
    expect(github).toContain("| Apply now | `apply 1` |");
    expect(github).not.toContain("| Approve only | `approve 1` |");
    expect(github).not.toContain("| Continue | `continue 1` |");
    expect(github).not.toContain("Proposal: `proposal_1`");
    expect(github).not.toContain("Intent ID: `intent_label_1`");

    const slack = presentation.final({ provider: "slack", result, runId: "run_receipt_1", receiptContext });
    expect(slack.body).toContain("*Actions*");
    expect(slack.body).toContain("Ready to apply");
    expect(slack.body).toContain("Audit: `opentag status --run run_receipt_1`");
    expect(slack.body).toContain("1. *Add the bug label.*");
    expect(slack.body).toContain("Reply: `apply 1` / `reject 1`");
    expect(slack.body).not.toContain("Target: GitHub labels");
    expect(slack.body).not.toContain("Proposal:");
    expect(slack.body).not.toContain("Intent ID:");
    const slackActionBlock = slack.blocks?.find((block) => block.type === "actions" && block.block_id === "opentag_compact_actions_1");
    expect(slackActionBlock).toMatchObject({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Apply 1" }, action_id: "opentag:apply:1", style: "primary" },
        { type: "button", text: { type: "plain_text", text: "Reject 1" }, action_id: "opentag:reject:1", style: "danger" }
      ]
    });
    expect(slack.blocks?.at(-1)).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Audit: `opentag status --run run_receipt_1`" }]
    });

    const lark = presentation.final({ provider: "lark", result, runId: "run_receipt_1", receiptContext });
    expect(lark.body).toContain("Audit: opentag status --run run_receipt_1");
    expect(JSON.stringify(lark.rich)).toContain("Audit: opentag status --run run_receipt_1");

    const telegram = presentation.final({ provider: "telegram", result, runId: "run_receipt_1", receiptContext });
    expect(telegram.body).not.toContain("opentag status --run run_receipt_1");
    expect(JSON.stringify(telegram.rich)).toContain("Copy audit");
    expect(JSON.stringify(telegram.rich)).toContain("opentag status --run run_receipt_1");
    expect(JSON.stringify(telegram.rich)).toContain("Copy apply 1");
  });

  it("renders create PR suggested actions with PR-specific details", () => {
    const presentation = createDefaultProviderPresentation();
    const result = {
      conclusion: "needs_human" as const,
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
                title: "OpenTag run run_1",
                head: "opentag/run_1",
                base: "main",
                changedFiles: ["src/demo.ts"],
                risks: ["Review before merge."],
                verification: [{ command: "pnpm test", outcome: "passed" }]
              }
            }
          ]
        }
      ]
    };

    const github = presentation.final({ provider: "github", result }).body;
    expect(github).toContain("| Target | GitHub pull request |");
    expect(github).toContain("| Title | OpenTag run run_1 |");
    expect(github).toContain("| Branch | `opentag/run_1` -> `main` |");
    expect(github).toContain("| Changed files | `src/demo.ts` |");
    expect(github).toContain("| Verification | `pnpm test`: passed |");
    expect(github).toContain("| Risks | Review before merge. |");

    const slack = presentation.final({ provider: "slack", result });
    expect(slack.body).toContain("1. *Create a pull request*");
    expect(slack.body).toContain("Reply: `approve 1` / `reject 1`");
    expect(slack.body).not.toContain("Branch: `opentag/run_1` -> `main`");
    expect(slack.body).not.toContain("Changed files: `src/demo.ts`");
    expect(slack.body).not.toContain("Title: OpenTag run run_1");
    expect(slack.body).not.toContain("`pnpm test`: passed");
    expect(JSON.stringify(slack.blocks)).toContain("Create a pull request");
    expect(JSON.stringify(slack.blocks)).not.toContain("Branch: `opentag/run_1` -> `main`");
    expect(JSON.stringify(slack.blocks)).not.toContain("Title: OpenTag run run_1");

    const receiptContext = {
      capabilityByIntentId: {
        intent_create_pr: { state: "ready_to_apply" as const }
      }
    };
    const lark = presentation.final({ provider: "lark", result, receiptContext });
    expect(JSON.stringify(lark.rich)).toContain("Create PR");
    expect(JSON.stringify(lark.rich)).toContain("Reject");
    expect(JSON.stringify(lark.rich)).toContain("If buttons are unavailable");
    expect(JSON.stringify(lark.rich)).not.toContain("创建 PR");

    const feishu = presentation.final({ provider: "lark", result, receiptContext, larkRenderLocale: "zh-CN" });
    expect(JSON.stringify(feishu.rich)).toContain("创建 PR");
    expect(JSON.stringify(feishu.rich)).toContain("拒绝");
    expect(JSON.stringify(feishu.rich)).toContain("按钮不可用时");
    expect(JSON.stringify(feishu.rich)).toContain("完成：待确认");
    expect(JSON.stringify(feishu.rich)).not.toContain("Create PR");
  });
});
