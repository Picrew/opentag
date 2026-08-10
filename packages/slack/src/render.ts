import {
  type ActionReceiptContext,
  type ActionReceiptDecision,
  type OpenTagApprovalPromptPresentation,
  renderApprovalRunScope,
  type OpenTagActionReceiptPresentation,
  type OpenTagDoctorSummaryPresentation,
  type OpenTagFinalSummaryPresentation,
  type OpenTagPresentationAction,
  type OpenTagRunStatusPresentation,
  type OpenTagSourceThreadStatusPresentation,
  createFinalSummaryPresentation,
  type OpenTagRunResult
} from "@opentag/core";

export type SlackTextBlock = {
  type: "section";
  text: {
    type: "mrkdwn";
    text: string;
  };
};

export type SlackDividerBlock = {
  type: "divider";
};

export type SlackContextBlock = {
  type: "context";
  elements: Array<{
    type: "mrkdwn";
    text: string;
  }>;
};

export type SlackButtonElement = {
  type: "button";
  text: {
    type: "plain_text";
    text: string;
    emoji?: boolean;
  };
  action_id: string;
  value: string;
  style?: "primary" | "danger";
};

export type SlackActionsBlock = {
  type: "actions";
  block_id?: string;
  elements: SlackButtonElement[];
};

export type SlackBlock = SlackTextBlock | SlackDividerBlock | SlackContextBlock | SlackActionsBlock;

export type SlackSuggestedActionButtonValue = {
  version: 1;
  command: string;
  proposalId: string;
  intentId: string;
  permissionDecision?: "allow_once" | "allow_run" | "deny";
  proposalHash?: string;
  approvalEpoch?: string;
  actionId?: string;
};

export type SlackMessagePayload = {
  channel: string;
  text: string;
  thread_ts?: string;
  ts?: string;
  blocks?: SlackBlock[];
};

export type SlackReactionPayload = {
  channel: string;
  timestamp: string;
  name: string;
};

export type SlackSourceReceiptState = "received" | "running";

const MAX_SLACK_SUGGESTED_ACTION_CANDIDATES = 20;
const MAX_SLACK_COMPACT_FINAL_ACTIONS = 3;
// Slack section text is capped at 3000 characters; reserve space for the final-summary prefix.
const MAX_SLACK_FINAL_SUMMARY_LENGTH = 2500;

export type SlackRenderOptions = {
  receiptContext?: ActionReceiptContext;
  auditRunId?: string;
};

export function buildSlackSuggestedActionButtonValue(input: SlackSuggestedActionButtonValue): string {
  return JSON.stringify(input);
}

export function parseSlackSuggestedActionButtonValue(value: string): SlackSuggestedActionButtonValue | null {
  try {
    const parsed = JSON.parse(value) as Partial<SlackSuggestedActionButtonValue>;
    if (
      parsed.version !== 1 ||
      typeof parsed.command !== "string" ||
      parsed.command.trim().length === 0 ||
      typeof parsed.proposalId !== "string" ||
      parsed.proposalId.length === 0 ||
      typeof parsed.intentId !== "string" ||
      parsed.intentId.length === 0
    ) {
      return null;
    }
    return {
      version: 1,
      command: parsed.command.trim(),
      proposalId: parsed.proposalId,
      intentId: parsed.intentId,
      ...(parsed.permissionDecision === "allow_once" || parsed.permissionDecision === "allow_run" || parsed.permissionDecision === "deny"
        ? { permissionDecision: parsed.permissionDecision }
        : {}),
      ...(typeof parsed.proposalHash === "string" && parsed.proposalHash.length > 0 ? { proposalHash: parsed.proposalHash } : {}),
      ...(typeof parsed.approvalEpoch === "string" && parsed.approvalEpoch.length > 0 ? { approvalEpoch: parsed.approvalEpoch } : {}),
      ...(typeof parsed.actionId === "string" && parsed.actionId.length > 0 ? { actionId: parsed.actionId } : {})
    };
  } catch {
    return null;
  }
}

export function renderSlackApprovalPrompt(presentation: OpenTagApprovalPromptPresentation): string {
  const target = [presentation.target.provider, presentation.target.connectionId, presentation.target.operation, presentation.target.resource, presentation.target.resourceVersion]
    .filter((value) => value !== undefined)
    .join(" / ");
  const runScope = renderApprovalRunScope(presentation.runScope);
  return `*${markdownToSlackMrkdwn(presentation.title)}*\n${markdownToSlackMrkdwn(presentation.summary)}\nTarget: ${markdownToSlackMrkdwn(target)}\nRun scope: ${markdownToSlackMrkdwn(runScope)}\nAllow for run applies only to the Run scope shown above. Choose Allow once, Allow for run, or Deny.`;
}

export function createSlackApprovalPromptBlocks(presentation: OpenTagApprovalPromptPresentation): SlackBlock[] {
  const labels = { allow_once: "Allow once", allow_run: "Allow for run", deny: "Deny" } as const;
  return [
    slackSection(renderSlackApprovalPrompt(presentation).split(" Choose Allow once")[0]!),
    {
      type: "actions",
      block_id: `opentag_permission_${presentation.actionId}`,
      elements: presentation.decisions.map((permissionDecision) => ({
        type: "button",
        text: { type: "plain_text", text: labels[permissionDecision], emoji: true },
        action_id: `opentag:permission:${permissionDecision}`,
        value: buildSlackSuggestedActionButtonValue({
          version: 1,
          command: permissionDecision === "deny" ? "reject 1" : "approve 1",
          proposalId: presentation.proposalId,
          intentId: presentation.intentId,
          permissionDecision,
          proposalHash: presentation.proposalHash,
          approvalEpoch: presentation.approvalEpoch,
          actionId: presentation.actionId
        }),
        ...(permissionDecision === "allow_once" ? { style: "primary" as const } : {}),
        ...(permissionDecision === "deny" ? { style: "danger" as const } : {})
      }))
    }
  ];
}

export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function replaceMarkdownLinks(
  text: string,
  replacement: (label: string, url: string) => string
): string {
  let output = "";
  let cursor = 0;
  while (cursor < text.length) {
    const labelStart = text.indexOf("[", cursor);
    if (labelStart === -1) return output + text.slice(cursor);
    const labelEnd = text.indexOf("]", labelStart + 1);
    if (labelEnd === -1) return output + text.slice(cursor);
    if (labelEnd === labelStart + 1 || text[labelEnd + 1] !== "(") {
      output += text.slice(cursor, labelEnd + 1);
      cursor = labelEnd + 1;
      continue;
    }
    const urlStart = labelEnd + 2;
    const urlEnd = text.indexOf(")", urlStart);
    if (urlEnd === -1) return output + text.slice(cursor);
    if (urlEnd === urlStart) {
      output += text.slice(cursor, urlEnd + 1);
      cursor = urlEnd + 1;
      continue;
    }
    output += text.slice(cursor, labelStart);
    output += replacement(
      text.slice(labelStart + 1, labelEnd),
      text.slice(urlStart, urlEnd)
    );
    cursor = urlEnd + 1;
  }
  return output;
}

export function markdownToSlackMrkdwn(text: string): string {
  const links: string[] = [];
  const withoutLinks = replaceMarkdownLinks(text, (label, url) => {
    const token = `\u0000SLACK_LINK_${links.length}\u0000`;
    links.push(`<${url}|${escapeSlackText(label)}>`);
    return token;
  });
  const converted = escapeSlackText(withoutLinks)
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*");
  return links.reduce((output, link, index) => output.replace(`\u0000SLACK_LINK_${index}\u0000`, link), converted);
}

function markdownToSlackActionDetail(text: string): string {
  return markdownToSlackMrkdwn(text).replace(/-&gt;/g, "->");
}

export function renderSlackAcknowledgement(runId: string): string {
  void runId;
  return "Working on it.";
}

function slackRunStatusTitle(state: OpenTagRunStatusPresentation["state"]): string {
  if (state === "received") return "Received";
  if (state === "queued") return "Queued";
  if (state === "running") return "Running";
  if (state === "waiting_for_approval") return "Waiting for approval";
  if (state === "waiting_for_human") return "Waiting for human input";
  if (state === "completed") return "Completed";
  if (state === "failed") return "Failed";
  if (state === "cancelled") return "Cancelled";
  if (state === "interrupted") return "Interrupted";
  return "Timed out";
}

export function renderSlackRunStatusPresentation(presentation: OpenTagRunStatusPresentation): string {
  const title = slackRunStatusTitle(presentation.state);
  return [
    `*OpenTag: ${title}*`,
    ...(presentation.message ? [markdownToSlackMrkdwn(presentation.message)] : []),
    `Run: \`${presentation.runId}\``,
    ...(presentation.nextAction ? [markdownToSlackMrkdwn(presentation.nextAction)] : [])
  ].join("\n");
}

export function createSlackRunStatusBlocks(presentation: OpenTagRunStatusPresentation): SlackBlock[] {
  return [slackSection(renderSlackRunStatusPresentation(presentation))];
}

export function slackSourceReceiptReactionName(state: SlackSourceReceiptState): string {
  if (state === "received") return "eyes";
  if (state === "running") return "hourglass_flowing_sand";
  return "eyes";
}

export function createSlackReactionPayload(input: { channelId: string; messageTs: string; name: string }): SlackReactionPayload {
  return {
    channel: input.channelId,
    timestamp: input.messageTs,
    name: input.name
  };
}

function truncateSlackText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeSlackMultilineText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function firstMarkdownSection(text: string, heading: string): string | undefined {
  const pattern = new RegExp(`\\*\\*${heading}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\s*\\n\\*\\*[^*]+:\\*\\*|\\n\\s*\\n[A-Z][^\\n]{0,60}:|$)`, "i");
  const match = text.match(pattern);
  return match?.[1]?.trim();
}

// Apply the limit after mrkdwn conversion because Slack escaping can expand the source text.
function truncateSlackMrkdwn(text: string, maxLength: number): string {
  const normalized = normalizeSlackMultilineText(text);
  const rendered = markdownToSlackMrkdwn(normalized);
  if (rendered.length <= maxLength) return rendered;

  const characters = Array.from(normalized);
  let low = 0;
  let high = Math.min(characters.length, Math.max(0, maxLength - 1));
  let best = "…";

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = markdownToSlackMrkdwn(`${characters.slice(0, midpoint).join("").trimEnd()}…`);
    if (candidate.length <= maxLength) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function compactSlackSummary(summary: string): string {
  const whatChanged = firstMarkdownSection(summary, "What changed");
  const selected = whatChanged ?? summary;
  return normalizeSlackMultilineText(selected.replace(/^\*\*[^*]+:\*\*\s*/i, ""));
}

function renderCompactSlackSummary(summary: string): string {
  return truncateSlackMrkdwn(compactSlackSummary(summary), MAX_SLACK_FINAL_SUMMARY_LENGTH);
}

function compactNextAction(nextAction: string): string {
  return truncateSlackText(nextAction, 180);
}

function slackArtifactKindLabel(kind: string | undefined): string {
  if (kind === "patch") return "Patch";
  if (kind === "report") return "Report";
  if (kind === "screenshot") return "Screenshot";
  if (kind === "log_summary") return "Logs";
  if (kind === "pull_request") return "Pull request";
  return kind ? kind.replace(/_/g, " ") : "Artifact";
}

function compactArtifactLine(artifact: NonNullable<OpenTagFinalSummaryPresentation["artifacts"]>[number]): string {
  const label = slackArtifactKindLabel(artifact.kind);
  const title = artifact.title;
  const summary = title.toLowerCase() === label.toLowerCase() ? label : `${label}: ${title}`;
  if (/^https?:\/\//i.test(artifact.uri)) {
    return `[${summary}](${artifact.uri})`;
  }
  return summary;
}

function resultForFinalSummaryPresentation(result: OpenTagRunResult): OpenTagRunResult {
  if (!result.suggestedChanges) return result;
  const visibleSuggestedChanges = result.suggestedChanges.filter((snapshot) => snapshot.intents.length > 0);
  if (visibleSuggestedChanges.length === result.suggestedChanges.length) return result;
  const { suggestedChanges: _suggestedChanges, ...withoutSuggestedChanges } = result;
  return visibleSuggestedChanges.length > 0 ? { ...withoutSuggestedChanges, suggestedChanges: visibleSuggestedChanges } : withoutSuggestedChanges;
}

function slackSection(text: string): SlackTextBlock {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text
    }
  };
}

function slackContext(text: string): SlackContextBlock {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text }]
  };
}

function slackCheckStatusLabel(status: OpenTagDoctorSummaryPresentation["checks"][number]["status"]): string {
  if (status === "ok") return "OK";
  if (status === "warn") return "WARN";
  if (status === "fail") return "FAIL";
  return "UNKNOWN";
}

function slackStatusActiveRun(presentation: OpenTagSourceThreadStatusPresentation): string {
  if (!presentation.activeRun) return "none";
  return `${presentation.activeRun.id} (${presentation.activeRun.status})${presentation.activeRun.updatedAt ? `, updated ${presentation.activeRun.updatedAt}` : ""}`;
}

function slackStatusQueuedFollowUps(presentation: OpenTagSourceThreadStatusPresentation): string {
  const total = presentation.queuedFollowUpsTotal ?? presentation.queuedFollowUps.length;
  if (total === 0) return "none";
  const visible = presentation.queuedFollowUps.map((followUp) => {
    const status = followUp.status ? ` (${followUp.status})` : "";
    const command = followUp.command ? `: ${markdownToSlackMrkdwn(truncateSlackText(followUp.command, 120))}` : "";
    return `${followUp.id}${status}${command}`;
  });
  const remaining = Math.max(total - visible.length, 0);
  return `${total}${visible.length ? ` (${visible.join(", ")}${remaining > 0 ? `, +${remaining} more` : ""})` : ""}`;
}

function renderPresentationActionLines(action: OpenTagPresentationAction): string[] {
  const lines = [`${action.index}. *${markdownToSlackMrkdwn(action.title)}*`];
  lines.push(`Target: ${markdownToSlackMrkdwn(action.targetLabel)}`);
  if (action.setupReason) {
    lines.push(`Status: ${markdownToSlackMrkdwn(action.setupReason)}`);
  }
  if (action.details?.length) {
    lines.push(...action.details.map(markdownToSlackActionDetail));
  }
  return lines;
}

type SlackActionReceiptGroup = {
  state: OpenTagPresentationAction["state"];
  title: string;
  actions: OpenTagPresentationAction[];
};

const ACTION_RECEIPT_GROUP_ORDER: Array<OpenTagPresentationAction["state"]> = [
  "ready_to_apply",
  "needs_setup",
  "needs_approval",
  "unsupported"
];

function actionReceiptGroupTitle(state: OpenTagPresentationAction["state"]): string {
  if (state === "ready_to_apply") return "Ready to apply";
  if (state === "needs_setup") return "Needs setup";
  if (state === "unsupported") return "Needs attention";
  return "Needs approval";
}

function actionReceiptGroups(actions: OpenTagPresentationAction[]): SlackActionReceiptGroup[] {
  return ACTION_RECEIPT_GROUP_ORDER.flatMap((state) => {
    const groupedActions = actions.filter((action) => action.state === state);
    return groupedActions.length > 0
      ? [
          {
            state,
            title: actionReceiptGroupTitle(state),
            actions: groupedActions
          }
        ]
      : [];
  });
}

function renderActionReceiptMarkdownLines(input: { title: string; actions: OpenTagPresentationAction[] }): string[] {
  if (input.actions.length === 0) return [];

  const visibleActions = input.actions.slice(0, MAX_SLACK_SUGGESTED_ACTION_CANDIDATES);
  const groups = actionReceiptGroups(visibleActions);
  const showGroupHeadings = groups.length > 1;
  const lines = [`*${input.title}*`, "", "Choose an action in this thread. Details stay in the OpenTag audit log."];
  for (const group of groups) {
    if (showGroupHeadings) {
      lines.push("", `*${group.title}*`);
    }
    for (const action of group.actions) {
      lines.push("", ...renderPresentationActionLines(action));
    }
  }

  const remainingCount = input.actions.length - visibleActions.length;
  if (remainingCount > 0) {
    lines.push("", `Showing first ${visibleActions.length} of ${input.actions.length} actions. Reply with an action number for the rest.`);
  }
  lines.push("", "Use the buttons below, or reply with the matching command.");
  return lines;
}

function slackActionCommand(decision: OpenTagPresentationAction["visibleDecisions"][number], index: number): string {
  return `${decision} ${index}`;
}

function slackPrimaryActionCommand(action: OpenTagPresentationAction): string | undefined {
  const decision =
    action.primaryDecision !== "none"
      ? action.primaryDecision
      : action.visibleDecisions.find((candidate) => candidate !== "reject") ?? action.visibleDecisions[0];
  return decision ? slackActionCommand(decision, action.index) : undefined;
}

function compactSlackActionTitle(title: string): string {
  const plain = title.replace(/`/g, "");
  if (/^Create a pull request for branch\b/i.test(plain)) return "Create a pull request";
  if (/^Link the run branch\b/i.test(plain)) return "Link the run branch";
  return truncateSlackText(plain, 120);
}

function compactSlackActionHeading(action: OpenTagPresentationAction): string {
  return `${action.index}. *${markdownToSlackMrkdwn(compactSlackActionTitle(action.title))}*`;
}

function compactSlackActionReplyLine(action: OpenTagPresentationAction): string | undefined {
  const primaryCommand = slackPrimaryActionCommand(action);
  const rejectCommand = action.visibleDecisions.includes("reject") ? slackActionCommand("reject", action.index) : undefined;
  const commands = Array.from(new Set([primaryCommand, rejectCommand].filter((command): command is string => Boolean(command))));
  if (commands.length === 0) return undefined;
  return `Reply: ${commands.map((command) => `\`${command}\``).join(" / ")}`;
}

function compactSlackSetupReason(action: OpenTagPresentationAction): string {
  const reason = action.setupReason?.replace(/\s+/g, " ").trim();
  if (!reason) return action.state === "unsupported" ? "No direct source-thread handler is available." : "Setup is required before this action can run.";
  if (/audit-only for now/i.test(reason)) return "Audit-only for now; use audit/status for details.";
  if (/No source-thread apply capability is registered/i.test(reason)) return "No direct source-thread handler is registered.";
  return truncateSlackText(reason, 140);
}

function compactSlackActionStatusLine(action: OpenTagPresentationAction): string | undefined {
  if (action.state === "unsupported") return `Needs attention: ${compactSlackSetupReason(action)}`;
  if (action.state === "needs_setup") return `Needs setup: ${compactSlackSetupReason(action)}`;
  if (action.state === "needs_approval") return "Needs approval before apply.";
  return undefined;
}

function compactSlackActionLines(action: OpenTagPresentationAction): string[] {
  const statusLine = compactSlackActionStatusLine(action);
  const replyLine = compactSlackActionReplyLine(action);
  return [compactSlackActionHeading(action), ...(statusLine ? [statusLine] : []), ...(replyLine ? [replyLine] : [])];
}

function renderCompactActionReceiptMarkdownLines(input: { title: string; actions: OpenTagPresentationAction[]; auditRunId?: string }): string[] {
  const visibleActions = input.actions.slice(0, MAX_SLACK_COMPACT_FINAL_ACTIONS);
  if (visibleActions.length === 0) return [];
  const lines = [
    "*Actions*",
    markdownToSlackMrkdwn(truncateSlackText(input.title, 140)),
  ];

  for (const action of visibleActions) {
    lines.push("", ...compactSlackActionLines(action));
  }

  const remaining = input.actions.length - visibleActions.length;
  lines.push(
    ...(remaining > 0 ? ["", `+${remaining} more action(s) in audit/status.`] : []),
    ...(!input.auditRunId ? ["Full action details stay in OpenTag audit/status."] : [])
  );
  return lines;
}

function renderSuggestedActionsMarkdown(presentation: OpenTagFinalSummaryPresentation): string[] {
  const actions = presentation.actions ?? [];
  if (actions.length === 0 || !presentation.actionReceiptTitle) return [];
  return renderCompactActionReceiptMarkdownLines({ title: presentation.actionReceiptTitle, actions, ...(presentation.auditRunId ? { auditRunId: presentation.auditRunId } : {}) });
}

function createSuggestedActionButton(action: OpenTagPresentationAction & { proposalId: string; intentId: string }, decision: ActionReceiptDecision): SlackButtonElement {
  const index = action.index;
  const labels: Record<ActionReceiptDecision, string> = {
    apply: `Apply ${index}`,
    approve: "Approve only",
    continue: "Continue",
    reject: "Reject"
  };
  return {
    type: "button",
    text: { type: "plain_text", text: labels[decision], emoji: true },
    action_id: `opentag:${decision}:${index}`,
    value: buildSlackSuggestedActionButtonValue({
      version: 1,
      command: `${decision} ${index}`,
      proposalId: action.proposalId,
      intentId: action.intentId
    }),
    ...(decision === "apply" ? { style: "primary" as const } : {}),
    ...(decision === "reject" ? { style: "danger" as const } : {})
  };
}

function actionHasInteractiveIdentity(action: OpenTagPresentationAction): action is OpenTagPresentationAction & { proposalId: string; intentId: string } {
  return Boolean(action.proposalId && action.intentId);
}

function createSuggestedActionButtons(action: OpenTagPresentationAction): SlackButtonElement[] {
  if (!actionHasInteractiveIdentity(action)) return [];
  return action.visibleDecisions.map((decision) => createSuggestedActionButton(action, decision));
}

function createCompactSuggestedActionButtons(action: OpenTagPresentationAction): SlackButtonElement[] {
  return createSuggestedActionButtons(action).map((button) => ({
    ...button,
    text: {
      ...button.text,
      text:
        parseSlackSuggestedActionButtonValue(button.value)
          ?.command.replace(/^apply\b/, "Apply")
          .replace(/^approve\b/, "Approve")
          .replace(/^continue\b/, "Continue")
          .replace(/^reject\b/, "Reject") ?? button.text.text
    }
  }));
}

function createSlackActionReceiptBlockSet(input: {
  title: string;
  actions: OpenTagPresentationAction[];
  auditRunId?: string;
  includeDivider?: boolean;
}): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  if (input.includeDivider) blocks.push({ type: "divider" });
  blocks.push(
    slackSection(`*${markdownToSlackMrkdwn(input.title)}*\n\nChoose an action in this thread. Details stay in the OpenTag audit log.`)
  );

  const visibleActions = input.actions.slice(0, MAX_SLACK_SUGGESTED_ACTION_CANDIDATES);
  const groups = actionReceiptGroups(visibleActions);
  const showGroupHeadings = groups.length > 1;
  for (const group of groups) {
    if (showGroupHeadings) {
      blocks.push(slackSection(`*${markdownToSlackMrkdwn(group.title)}*`));
    }
    for (const action of group.actions) {
      blocks.push(slackSection(renderPresentationActionLines(action).join("\n")));
      const buttons = createSuggestedActionButtons(action);
      if (buttons.length === 0) continue;
      blocks.push({
        type: "actions",
        block_id: `opentag_actions_${action.index}`,
        elements: buttons
      });
    }
  }

  const remainingCount = input.actions.length - visibleActions.length;
  if (remainingCount > 0) {
    blocks.push(slackSection(`Showing first ${visibleActions.length} of ${input.actions.length} actions. Reply with an action number for the rest.`));
  }

  if (input.auditRunId) {
    blocks.push(slackContext(markdownToSlackMrkdwn(`Audit: \`opentag status --run ${input.auditRunId}\``)));
  }

  return blocks;
}

function createSlackCompactActionReceiptBlockSet(input: {
  title: string;
  actions: OpenTagPresentationAction[];
  auditRunId?: string;
  includeDivider?: boolean;
}): SlackBlock[] {
  const visibleActions = input.actions.slice(0, MAX_SLACK_COMPACT_FINAL_ACTIONS);
  if (visibleActions.length === 0) return [];
  const blocks: SlackBlock[] = [];
  if (input.includeDivider) blocks.push({ type: "divider" });
  blocks.push(slackSection(`*Actions*\n${markdownToSlackMrkdwn(truncateSlackText(input.title, 140))}`));
  for (const action of visibleActions) {
    blocks.push(slackSection(compactSlackActionLines(action).join("\n")));
    const buttons = createCompactSuggestedActionButtons(action);
    if (buttons.length > 0) {
      blocks.push({
        type: "actions",
        block_id: `opentag_compact_actions_${action.index}`,
        elements: buttons
      });
    }
  }
  const remaining = input.actions.length - visibleActions.length;
  const detailHint = [
    remaining > 0 ? `+${remaining} more action(s) in audit/status.` : undefined,
    input.auditRunId ? undefined : "Full action details stay in OpenTag audit/status."
  ].filter((line): line is string => Boolean(line));
  if (detailHint.length > 0) {
    blocks.push(slackContext(markdownToSlackMrkdwn(detailHint.join(" "))));
  }
  return blocks;
}

export function renderSlackActionReceiptPresentation(presentation: OpenTagActionReceiptPresentation): string {
  const lines = renderActionReceiptMarkdownLines({ title: presentation.title, actions: presentation.actions });
  if (presentation.auditRunId) {
    lines.push("", markdownToSlackMrkdwn(`Audit: \`opentag status --run ${presentation.auditRunId}\``));
  }
  return lines.join("\n");
}

export function createSlackActionReceiptBlocks(presentation: OpenTagActionReceiptPresentation): SlackBlock[] {
  return createSlackActionReceiptBlockSet({
    title: presentation.title,
    actions: presentation.actions,
    ...(presentation.auditRunId ? { auditRunId: presentation.auditRunId } : {})
  });
}

export function renderSlackFinalResult(result: OpenTagRunResult, options: SlackRenderOptions = {}): string {
  return renderSlackFinalSummaryPresentation(
    createFinalSummaryPresentation({
      result: resultForFinalSummaryPresentation(result),
      ...(options.receiptContext ? { receiptContext: options.receiptContext } : {}),
      ...(options.auditRunId ? { auditRunId: options.auditRunId } : {})
    })
  );
}

export function renderSlackFinalSummaryPresentation(presentation: OpenTagFinalSummaryPresentation): string {
  const lines = [`*Finished: ${presentation.outcome}.*`, renderCompactSlackSummary(presentation.summary)];

  if (presentation.verification?.length) {
    lines.push(
      `Verified: ${presentation.verification
        .slice(0, 3)
        .map((check) => `\`${markdownToSlackMrkdwn(check.command)}\` ${markdownToSlackMrkdwn(check.outcome)}`)
        .join(", ")}`
    );
  }

  if (presentation.artifacts?.length) {
    lines.push(
      `Artifacts: ${presentation.artifacts
        .slice(0, 4)
        .map((artifact) => markdownToSlackMrkdwn(compactArtifactLine(artifact)))
        .join(", ")}. Details in audit/status.`
    );
  }

  const suggestedActions = renderSuggestedActionsMarkdown(presentation);
  if (presentation.nextActions?.length && suggestedActions.length === 0) {
    lines.push(`Next: ${markdownToSlackMrkdwn(compactNextAction(presentation.nextActions[0] ?? ""))}`);
  }
  if (suggestedActions.length > 0) {
    lines.push("", ...suggestedActions);
  }
  if (presentation.auditRunId) {
    lines.push("", markdownToSlackMrkdwn(`Audit: \`opentag status --run ${presentation.auditRunId}\``));
  }

  return lines.join("\n");
}

export function createSlackFinalResultBlocks(result: OpenTagRunResult, options: SlackRenderOptions = {}): SlackBlock[] {
  return createSlackFinalSummaryBlocks(
    createFinalSummaryPresentation({
      result: resultForFinalSummaryPresentation(result),
      ...(options.receiptContext ? { receiptContext: options.receiptContext } : {}),
      ...(options.auditRunId ? { auditRunId: options.auditRunId } : {})
    })
  );
}

export function createSlackFinalSummaryBlocks(presentation: OpenTagFinalSummaryPresentation): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Finished: ${presentation.outcome}.*\n${renderCompactSlackSummary(presentation.summary)}`
      }
    }
  ];

  if (presentation.verification?.length) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Verified: ${markdownToSlackMrkdwn(
          presentation.verification
            .slice(0, 3)
            .map((check) => `\`${check.command}\` ${check.outcome}`)
            .join(", ")
        )}`
      }
    });
  }

  if (presentation.artifacts?.length) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Artifacts: ${markdownToSlackMrkdwn(presentation.artifacts.slice(0, 4).map(compactArtifactLine).join(", "))}. Details in audit/status.`
      }
    });
  }

  const actions = presentation.actions ?? [];
  if (presentation.nextActions?.length && actions.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Next: ${markdownToSlackMrkdwn(compactNextAction(presentation.nextActions[0] ?? ""))}`
      }
    });
  }

  if (actions.length > 0 && presentation.actionReceiptTitle) {
    blocks.push(
      ...createSlackCompactActionReceiptBlockSet({
        title: presentation.actionReceiptTitle,
        actions,
        ...(presentation.auditRunId ? { auditRunId: presentation.auditRunId } : {}),
        includeDivider: true
      })
    );
  }

  if (presentation.auditRunId) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: markdownToSlackMrkdwn(`Audit: \`opentag status --run ${presentation.auditRunId}\``)
        }
      ]
    });
  }

  return blocks;
}

export function createSlackDoctorSummaryBlocks(presentation: OpenTagDoctorSummaryPresentation): SlackBlock[] {
  const blocks: SlackBlock[] = [slackSection(`*${markdownToSlackMrkdwn(presentation.title)}*`)];
  if (presentation.checks.length === 0) {
    blocks.push(slackContext("No readiness checks were reported."));
    return blocks;
  }

  for (const check of presentation.checks.slice(0, 10)) {
    blocks.push(
      slackSection(
        `*${slackCheckStatusLabel(check.status)} ${markdownToSlackMrkdwn(check.name)}*${check.message ? `\n${markdownToSlackMrkdwn(check.message)}` : ""}`
      )
    );
  }
  if (presentation.checks.length > 10) {
    blocks.push(slackContext(`Showing first 10 of ${presentation.checks.length} readiness checks. Use \`opentag doctor\` locally for full detail.`));
  }
  return blocks;
}

export function createSlackSourceThreadStatusBlocks(presentation: OpenTagSourceThreadStatusPresentation): SlackBlock[] {
  const blocks: SlackBlock[] = [
    slackSection(`*${markdownToSlackMrkdwn(presentation.title)}*`),
    slackContext(
      [
        presentation.sourceContainer ? `Source: \`${presentation.sourceContainer}\`` : undefined,
        `Project Target: \`${presentation.projectTarget ?? "not bound"}\``
      ]
        .filter((line): line is string => Boolean(line))
        .join(" | ")
    ),
    slackSection(
      [
        `*Active run:* ${markdownToSlackMrkdwn(slackStatusActiveRun(presentation))}`,
        presentation.currentCommand ? `*Command:* ${markdownToSlackMrkdwn(presentation.currentCommand)}` : undefined,
        `*Queued follow-ups:* ${markdownToSlackMrkdwn(slackStatusQueuedFollowUps(presentation))}`,
        `*Next action:* ${markdownToSlackMrkdwn(presentation.nextAction)}`
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    )
  ];

  if (presentation.stopHint || presentation.detailHint) {
    blocks.push(
      slackContext(
        [
          presentation.stopHint ? `Stop/timeout: ${presentation.stopHint}` : undefined,
          presentation.detailHint ? `Details: ${presentation.detailHint}` : undefined
        ]
          .filter((line): line is string => Boolean(line))
          .map(markdownToSlackMrkdwn)
          .join(" | ")
      )
    );
  }
  return blocks;
}

export function createSlackPostMessagePayload(input: {
  channelId: string;
  text: string;
  textFormat?: "markdown" | "mrkdwn";
  threadTs: string;
  blocks?: SlackBlock[];
}): SlackMessagePayload {
  return {
    channel: input.channelId,
    text: input.textFormat === "mrkdwn" ? input.text : markdownToSlackMrkdwn(input.text),
    thread_ts: input.threadTs,
    ...(input.blocks?.length ? { blocks: input.blocks } : {})
  };
}

export function createSlackUpdateMessagePayload(input: {
  channelId: string;
  text: string;
  textFormat?: "markdown" | "mrkdwn";
  messageTs: string;
  blocks?: SlackBlock[];
}): SlackMessagePayload {
  return {
    channel: input.channelId,
    text: input.textFormat === "mrkdwn" ? input.text : markdownToSlackMrkdwn(input.text),
    ts: input.messageTs,
    ...(input.blocks?.length ? { blocks: input.blocks } : {})
  };
}
