import {
  createActionReceiptPresentation,
  createDoctorSummaryPresentation,
  createFinalSummaryPresentation,
  createSourceThreadStatusPresentation,
  OpenTagApprovalPromptPresentationSchema,
  type OpenTagRunResult
} from "@opentag/core";
import { describe, expect, it } from "vitest";
import {
  createLarkActionReceiptCard,
  createLarkApprovalPromptCard,
  createLarkDoctorSummaryCard,
  createLarkFinalSummaryCard,
  createLarkInteractiveMessageContent,
  createLarkRunStatusCard,
  createLarkSourceThreadStatusCard,
  createLarkTextMessageContent,
  parseLarkThreadActionButtonValue,
  renderLarkActionReceiptPresentation,
  renderLarkAcknowledgement,
  renderLarkFinalSummaryPresentation,
  renderLarkFinalResult
} from "../src/index.js";

describe("renderLarkAcknowledgement", () => {
  it("renders immutable governed permission choices as native buttons", () => {
    const card = createLarkApprovalPromptCard(OpenTagApprovalPromptPresentationSchema.parse({
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
    }));
    expect(JSON.stringify(card)).toContain("npm / npm:team / publish / @acme/report / next");
    expect(JSON.stringify(card)).toContain('grantScope={\\"package\\":\\"@acme/report\\",\\"versions\\":\\"*\\"}');
    expect(JSON.stringify(card)).toContain("Allow for run applies only to the Run scope shown above");
    expect(JSON.stringify(card)).toContain('\\"urlQuery\\":{\\"environment\\":\\"staging\\",\\"force\\":\\"false\\"}');
    const action = card.elements.find((element) => element.tag === "action");
    expect(action).toMatchObject({ tag: "action", actions: [{ text: { content: "Allow once" } }, { text: { content: "Allow for run" } }, { text: { content: "Deny" } }] });
    if (!action || action.tag !== "action") throw new Error("expected action");
    expect(action.actions.map((button) => parseLarkThreadActionButtonValue(button.value))).toEqual([
      expect.objectContaining({ command: "approve 1", permissionDecision: "allow_once", proposalHash: "hash_1", actionId: "action_1" }),
      expect.objectContaining({ command: "approve 1", permissionDecision: "allow_run", proposalHash: "hash_1", actionId: "action_1" }),
      expect.objectContaining({ command: "reject 1", permissionDecision: "deny", proposalHash: "hash_1", actionId: "action_1" })
    ]);
  });
  it("renders a quiet received acknowledgement with audit guidance", () => {
    expect(renderLarkAcknowledgement("run_1")).toBe(
      ["Received. OpenTag is working.", "Run: run_1", "Use /status here for queue state; audit locally with opentag status --run run_1."].join("\n")
    );
  });
  it("uses a colleague-style Feishu task acknowledgement", () => {
    expect(renderLarkAcknowledgement("run_1", { locale: "zh-CN" })).toBe(
      ["我接了，跑完回这个话题。", "任务：run_1", "想看进度就在这里发 /status。"].join("\n")
    );
    expect(createLarkRunStatusCard({
      kind: "run_status",
      runId: "run_1",
      state: "running",
      detailVisibility: "source_thread"
    }, { locale: "zh-CN" }).header.title.content).toBe("在处理了");
  });
});

describe("renderLarkFinalResult", () => {
  it("renders conclusion, summary, verification and next action", () => {
    const result: OpenTagRunResult = {
      conclusion: "success",
      summary: "Did the thing.",
      verification: [{ command: "pnpm test", outcome: "passed" }],
      nextAction: "Review the PR."
    };
    const text = renderLarkFinalResult(result, { auditRunId: "run_1" });
    expect(text).toContain("success");
    expect(text).toContain("Did the thing.");
    expect(text).toContain("pnpm test");
    expect(text).toContain("passed");
    expect(text).toContain("Review the PR.");
    expect(text).toContain("Audit: opentag status --run run_1");
  });

  it("handles a structured nextAction", () => {
    const result: OpenTagRunResult = {
      conclusion: "needs_human",
      summary: "Need a decision.",
      nextAction: { summary: "Pick an option", hint: { kind: "request_human_decision" } }
    };
    expect(renderLarkFinalResult(result)).toContain("Pick an option");
  });

  it("renders final fallback text from semantic final summary presentation", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_semantic_lark",
      result: {
        conclusion: "success",
        summary: "Did the semantic thing.",
        verification: [{ command: "pnpm test", outcome: "passed" }],
        nextAction: "Review the source thread."
      }
    });

    const text = renderLarkFinalSummaryPresentation(presentation);

    expect(text).toBe(
      [
        "Finished with success.",
        "",
        "Did the semantic thing.",
        "",
        "Verification",
        "- pnpm test: passed",
        "",
        "Next action: Review the source thread.",
        "",
        "Audit: opentag status --run run_semantic_lark"
      ].join("\n")
    );
  });

  it("renders artifacts in final fallback text", () => {
    const presentation = createFinalSummaryPresentation({
      result: {
        conclusion: "success",
        summary: "Produced artifacts.",
        artifacts: [
          { kind: "patch", title: "Generated patch", uri: "opentag/run_1.patch" },
          { kind: "report", title: "Run report", uri: "opentag/run_1-report.md" },
          { kind: "screenshot", title: "UI screenshot", uri: "opentag/run_1.png" },
          { kind: "log_summary", title: "Log summary", uri: "opentag/run_1-log.md" },
          { kind: "pull_request", title: "Pull request", uri: "https://github.com/acme/demo/pull/1" },
          { title: "Raw bundle", uri: "opentag/run_1.zip" }
        ]
      }
    });

    const text = renderLarkFinalSummaryPresentation(presentation);
    expect(text).toContain("Artifacts");
    expect(text).toContain("- Patch: Generated patch");
    expect(text).toContain("- Report: Run report");
    expect(text).toContain("- Screenshot: UI screenshot");
    expect(text).toContain("- Logs: Log summary");
    expect(text).toContain("- [Pull request](https://github.com/acme/demo/pull/1)");
    expect(text).toContain("- Artifact: Raw bundle");
    expect(text).toContain("Links/details are in audit/status.");
    expect(text).not.toContain("opentag/run_1-report.md");

    const zhText = renderLarkFinalSummaryPresentation(presentation, { locale: "zh-CN" });
    expect(zhText).toContain("已完成：成功。");
    expect(zhText).toContain("产物");
    expect(zhText).toContain("- 补丁: Generated patch");
    expect(zhText).toContain("- 报告: Run report");
    expect(zhText).toContain("- 截图: UI screenshot");
    expect(zhText).toContain("- 日志: Log summary");
    expect(zhText).toContain("- [PR: Pull request](https://github.com/acme/demo/pull/1)");
    expect(zhText).toContain("- 产物: Raw bundle");
    expect(zhText).toContain("链接和详情在 audit/status 中。");
    expect(zhText).not.toContain("Artifacts");
  });
});

describe("createLarkActionReceiptCard", () => {
  it("renders a standalone source-thread action receipt card", () => {
    const presentation = createActionReceiptPresentation({
      auditRunId: "run_lark_receipt_standalone",
      result: {
        conclusion: "needs_human",
        summary: "Prepared a pull request action.",
        suggestedChanges: [
          {
            proposalId: "proposal_pr",
            createdAt: "2026-06-29T00:00:00.000Z",
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
                  changedFiles: ["README.md"]
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
    if (!presentation) throw new Error("expected action receipt presentation");

    const text = renderLarkActionReceiptPresentation(presentation);
    const card = createLarkActionReceiptCard(presentation);
    const rendered = JSON.stringify(card);

    expect(text).toContain("Ready to apply");
    expect(text).toContain("Apply now: apply 1");
    expect(card.header).toEqual({
      template: "blue",
      title: { tag: "plain_text", content: "Ready to apply" }
    });
    expect(rendered).toContain("Create a pull request for branch opentag/run_1.");
    expect(rendered).toContain("Branch: opentag/run_1 -> main");
    expect(rendered).toContain("Apply now: apply 1");
    expect(rendered).toContain("Reject: reject 1");
    expect(rendered).toContain("Audit: opentag status --run run_lark_receipt_standalone");
    expect(rendered).not.toContain("proposal_pr");
    expect(rendered).not.toContain("intent_create_pr");
    expect(JSON.parse(createLarkInteractiveMessageContent(card))).toEqual(card);
  });
});

describe("createLarkSourceThreadStatusCard", () => {
  it("renders active run and queue status from semantic status presentation", () => {
    const presentation = createSourceThreadStatusPresentation({
      title: "OpenTag status:",
      sourceContainer: "lark:tenant_1/oc_chat",
      projectTarget: "github:acme/demo",
      bindingState: "bound",
      activeRun: { id: "run_active", status: "running", updatedAt: "2026-06-24T00:01:00.000Z" },
      queuedFollowUps: [{ id: "follow_up_1", status: "queued", command: "update the docs" }],
      queuedFollowUpsTotal: 2,
      currentCommand: "fix this",
      nextAction: "wait for the final reply or use /stop.",
      stopHint: "cancellation is explicit.",
      detailHint: "use `opentag status --run run_active` locally."
    });

    const card = createLarkSourceThreadStatusCard(presentation);

    expect(card.header).toEqual({
      template: "blue",
      title: { tag: "plain_text", content: "OpenTag status" }
    });
    expect(JSON.stringify(card)).toContain("github:acme/demo");
    expect(JSON.stringify(card)).toContain("run_active (running)");
    expect(JSON.stringify(card)).toContain("fix this");
    expect(JSON.stringify(card)).toContain("2 (follow_up_1 (queued): update the docs, +1 more)");
    expect(JSON.stringify(card)).toContain("Stop/timeout: cancellation is explicit.");
  });
});

describe("createLarkDoctorSummaryCard", () => {
  it("uses warning styling when any readiness check warns", () => {
    const presentation = createDoctorSummaryPresentation({
      title: "OpenTag doctor (redacted):",
      checks: [
        { status: "ok", name: "Dispatcher", message: "reachable" },
        { status: "warn", name: "Runtime readiness", message: "heartbeat stale" }
      ]
    });

    const card = createLarkDoctorSummaryCard(presentation);

    expect(card.header).toEqual({
      template: "yellow",
      title: { tag: "plain_text", content: "OpenTag doctor (redacted)" }
    });
    expect(JSON.stringify(card)).toContain("OK Dispatcher");
    expect(JSON.stringify(card)).toContain("WARN Runtime readiness");
    expect(JSON.stringify(card)).toContain("heartbeat stale");
  });
});

describe("createLarkFinalSummaryCard", () => {
  it("renders a Lark-native card from semantic final summary presentation", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_1",
      result: {
        conclusion: "success",
        summary: "Did the thing.",
        changedFiles: ["packages/lark/src/render.ts"],
        artifacts: [
          { kind: "patch", title: "Generated patch", uri: "opentag/run_1.patch" },
          { kind: "report", title: "Run report", uri: "opentag/run_1-report.md" }
        ],
        verification: [{ command: "pnpm test", outcome: "passed" }],
        nextAction: "Review the PR."
      }
    });

    const card = createLarkFinalSummaryCard(presentation);

    expect(card).toMatchObject({
      config: { wide_screen_mode: true },
      header: {
        template: "green",
        title: { tag: "plain_text", content: "Finished: success" }
      }
    });
    expect(JSON.stringify(card)).toContain("Did the thing.");
    expect(JSON.stringify(card)).toContain("pnpm test: passed");
    expect(JSON.stringify(card)).toContain("packages/lark/src/render.ts");
    expect(JSON.stringify(card)).toContain("Generated patch");
    expect(JSON.stringify(card)).toContain("Run report");
    expect(JSON.stringify(card)).toContain("Links/details are in audit/status.");
    expect(JSON.stringify(card)).not.toContain("opentag/run_1.patch");
    expect(JSON.stringify(card)).not.toContain("opentag/run_1-report.md");
    expect(JSON.stringify(card)).toContain("Review the PR.");
    expect(JSON.stringify(card)).toContain("Audit: opentag status --run run_1");
    expect(JSON.stringify(card)).not.toContain("blocks");
    expect(JSON.parse(createLarkInteractiveMessageContent(card))).toEqual(card);

    const feishuCard = createLarkFinalSummaryCard(presentation, { locale: "zh-CN" });
    const feishuRendered = JSON.stringify(feishuCard);
    expect(feishuCard.header.title.content).toBe("完成：成功");
    expect(feishuRendered).toContain("**验证**");
    expect(feishuRendered).toContain("**变更文件**");
    expect(feishuRendered).toContain("**产物**");
    expect(feishuRendered).toContain("补丁: Generated patch");
    expect(feishuRendered).toContain("报告: Run report");
    expect(feishuRendered).toContain("详情在 audit/status 中。");
    expect(feishuRendered).toContain("**下一步**");
    expect(feishuRendered).not.toContain("**Artifacts**");
    expect(feishuRendered).not.toContain("Links/details are in audit/status.");
  });

  it("renders source-thread action receipts in the Lark-native final card", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_lark_receipt",
      result: {
        conclusion: "needs_human",
        summary: "Prepared a pull request action.",
        nextAction: "Review the proposed pull request action.",
        suggestedChanges: [
          {
            proposalId: "proposal_pr",
            createdAt: "2026-06-29T00:00:00.000Z",
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
                  changedFiles: ["README.md"]
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

    const card = createLarkFinalSummaryCard(presentation, { locale: "zh-CN" });
    const rendered = JSON.stringify(card);
    const fallbackText = renderLarkFinalSummaryPresentation(presentation, { locale: "zh-CN" });

    expect(card.header.title.content).toBe("完成：待确认");
    expect(rendered).toContain("需要确认");
    expect(rendered).toContain("需要你确认");
    expect(rendered).toContain("1. 创建 PR");
    expect(rendered).not.toContain("Create a pull request for branch opentag/run_1.");
    expect(rendered).toContain("可直接执行。");
    expect(rendered).toContain("按钮不可用时");
    expect(rendered).toContain("执行 1");
    expect(rendered).toContain("apply 1");
    expect(rendered).toContain("完整动作详情保留在 OpenTag audit/status。");
    expect(rendered).not.toContain("Target: GitHub pull request");
    expect(rendered).not.toContain("Branch: opentag/run_1 -> main");
    expect(rendered).not.toContain("Changed files: README.md");
    expect(rendered).not.toContain("Apply now: apply 1");
    expect(rendered).toContain("创建 PR");
    expect(rendered).toContain("拒绝");
    expect(rendered).toContain("Audit: opentag status --run run_lark_receipt");
    expect(fallbackText).toContain("下一步：Review the proposed pull request action.");
    expect(fallbackText).toContain("**需要确认**");
    expect(fallbackText).toContain("按钮不可用时");
    expect(fallbackText).toContain("执行 1");
    expect(fallbackText).toContain("apply 1");
    expect(fallbackText).toContain("拒绝 1");
    expect(fallbackText).toContain("reject 1");
    expect(fallbackText).toContain("完整动作详情保留在 OpenTag audit/status。");

    const actionBlock = card.elements.find((element) => element.tag === "action");
    if (!actionBlock || actionBlock.tag !== "action") throw new Error("expected Lark action block");
    expect(actionBlock).toMatchObject({
      tag: "action",
      layout: "bisected",
      actions: [
        { tag: "button", text: { tag: "plain_text", content: "创建 PR" }, type: "primary" },
        { tag: "button", text: { tag: "plain_text", content: "拒绝" }, type: "danger" }
      ]
    });
    expect(actionBlock.actions.map((action) => parseLarkThreadActionButtonValue(action.value))).toEqual([
      {
        opentag: "thread_action",
        version: 1,
        command: "apply 1",
        decision: "apply",
        index: 1,
        proposalId: "proposal_pr",
        intentId: "intent_create_pr"
      },
      {
        opentag: "thread_action",
        version: 1,
        command: "reject 1",
        decision: "reject",
        index: 1,
        proposalId: "proposal_pr",
        intentId: "intent_create_pr"
      }
    ]);
    expect(
      parseLarkThreadActionButtonValue({
        opentag: "thread_action",
        version: 1,
        command: "reject 1",
        decision: "apply",
        index: 1,
        proposalId: "proposal_pr",
        intentId: "intent_create_pr"
      })
    ).toBeNull();
    expect(
      parseLarkThreadActionButtonValue({
        opentag: "thread_action",
        version: 1,
        command: "apply 2",
        decision: "apply",
        index: 1,
        proposalId: "proposal_pr",
        intentId: "intent_create_pr"
      })
    ).toBeNull();
  });

  it("renders Lark-domain final actions in English by default", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_lark_en_receipt",
      result: {
        conclusion: "needs_human",
        summary: "Prepared a pull request action.",
        suggestedChanges: [
          {
            proposalId: "proposal_pr",
            createdAt: "2026-06-29T00:00:00.000Z",
            summary: "Create a pull request.",
            intents: [
              {
                intentId: "intent_create_pr",
                domain: "pull_request",
                action: "create_pull_request",
                summary: "Create a pull request for branch opentag/run_1.",
                params: {
                  head: "opentag/run_1",
                  base: "main"
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

    const card = createLarkFinalSummaryCard(presentation);
    const rendered = JSON.stringify(card);

    expect(rendered).toContain("Actions");
    expect(rendered).toContain("1. Create PR");
    expect(rendered).toContain("Ready to apply.");
    expect(rendered).toContain("If buttons are unavailable, reply");
    expect(rendered).toContain("apply 1");
    expect(rendered).not.toContain("创建 PR");
    expect(rendered).not.toContain("按钮不可用时");

    const actionBlock = card.elements.find((element) => element.tag === "action");
    if (!actionBlock || actionBlock.tag !== "action") throw new Error("expected Lark action block");
    expect(actionBlock.actions).toMatchObject([
      { tag: "button", text: { tag: "plain_text", content: "Create PR" }, type: "primary" },
      { tag: "button", text: { tag: "plain_text", content: "Reject" }, type: "danger" }
    ]);
  });

  it("does not duplicate fallback commands when only reject is available", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_lark_reject_only",
      result: {
        conclusion: "needs_human",
        summary: "Prepared a reject-only action.",
        suggestedChanges: [
          {
            proposalId: "proposal_reject_only",
            createdAt: "2026-06-29T00:00:00.000Z",
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

    const card = createLarkFinalSummaryCard(presentation, { locale: "zh-CN" });
    const rendered = JSON.stringify(card);

    expect(rendered).toContain("按钮不可用时：回复 `拒绝 1`（也支持 `reject 1`）。");
    expect(rendered).not.toContain("`拒绝 1` / `拒绝 1`");
    expect(rendered).not.toContain("`reject 1` / `reject 1`");

    const actionBlock = card.elements.find((element) => element.tag === "action");
    if (!actionBlock || actionBlock.tag !== "action") throw new Error("expected Lark action block");
    expect(actionBlock.actions).toHaveLength(1);
    expect(actionBlock.actions).toMatchObject([{ tag: "button", text: { tag: "plain_text", content: "拒绝" }, type: "danger" }]);
  });

  it("keeps long Markdown summaries readable instead of flattening them into one Lark paragraph", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_summary",
      result: {
        conclusion: "success",
        summary: [
          "Preserved marker: `summary E2E 20260701T101750Z`",
          "",
          "**High-Level Summary**",
          "OpenTag is a local-first, source-thread-native agent invocation system.",
          "",
          "**Repo Map**",
          "- The repo is a `pnpm` TypeScript monorepo with packages under `packages/*`.",
          "- `@opentag/core` defines protocol types and validation."
        ].join("\n"),
        nextAction: "No file changes were detected."
      }
    });

    const card = createLarkFinalSummaryCard(presentation);
    const summaryElements = card.elements.filter((element) => element.tag === "div");
    const rendered = JSON.stringify(summaryElements);

    expect(rendered).toContain("High-Level Summary");
    expect(rendered).toContain("Repo Map");
    expect(rendered).toContain("packages/*");
    expect(rendered).not.toContain("Preserved marker: summary E2E 20260701T101750Z High-Level Summary");
    expect(summaryElements.some((element) => element.tag === "div" && element.text.tag === "plain_text" && element.text.content.includes("packages/*"))).toBe(true);
  });
});

describe("createLarkTextMessageContent", () => {
  it("produces JSON-encoded text content", () => {
    expect(createLarkTextMessageContent("hi")).toBe('{"text":"hi"}');
  });
});
