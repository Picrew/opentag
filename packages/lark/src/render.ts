import {
  createFinalSummaryPresentation,
  type OpenTagApprovalPromptPresentation,
  renderApprovalRunScope,
  type OpenTagActionReceiptPresentation,
  type OpenTagDoctorCheckPresentation,
  type OpenTagDoctorSummaryPresentation,
  type OpenTagFinalSummaryPresentation,
  type OpenTagPresentationAction,
  type OpenTagRunStatusPresentation,
  type OpenTagRunResult,
  type OpenTagSourceThreadStatusPresentation
} from "@opentag/core";

export type LarkCardText = {
  tag: "plain_text" | "lark_md";
  content: string;
};

export type LarkCardButton = {
  tag: "button";
  text: LarkCardText;
  type?: "default" | "primary" | "danger";
  value?: Record<string, unknown>;
};

export type LarkCardElement =
  | {
      tag: "div";
      text: LarkCardText;
    }
  | {
      tag: "hr";
    }
  | {
      tag: "note";
      elements: LarkCardText[];
    }
  | {
      tag: "action";
      actions: LarkCardButton[];
      layout?: "bisected" | "trisection" | "flow";
    };

export type LarkCard = {
  config: {
    wide_screen_mode: boolean;
    update_multi?: boolean;
  };
  header: {
    template: "green" | "red" | "yellow" | "blue" | "grey";
    title: {
      tag: "plain_text";
      content: string;
    };
  };
  elements: LarkCardElement[];
};

export type LarkRenderOptions = {
  auditRunId?: string;
  locale?: LarkRenderLocale;
};

export type LarkRenderLocale = "en-US" | "zh-CN";

const MAX_LARK_COMPACT_FINAL_ACTIONS = 3;

export function larkRenderLocaleFromDomain(domain: "lark" | "feishu" | string | undefined): LarkRenderLocale {
  return domain === "feishu" ? "zh-CN" : "en-US";
}

function larkRenderLocale(options: { locale?: LarkRenderLocale } = {}): LarkRenderLocale {
  return options.locale ?? "en-US";
}

export type LarkThreadActionButtonValue = {
  opentag: "thread_action";
  version: 1;
  command: string;
  decision: OpenTagPresentationAction["visibleDecisions"][number];
  index: number;
  proposalId?: string;
  intentId?: string;
  permissionDecision?: "allow_once" | "allow_run" | "deny";
  proposalHash?: string;
  approvalEpoch?: string;
  actionId?: string;
};

export function parseLarkThreadActionButtonValue(value: unknown): LarkThreadActionButtonValue | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as Record<string, unknown>;
  const decision = record["decision"];
  const index = record["index"];
  const command = record["command"];
  const normalizedCommand = typeof command === "string" ? command.trim() : "";
  if (
    record["opentag"] !== "thread_action" ||
    record["version"] !== 1 ||
    typeof command !== "string" ||
    normalizedCommand.length === 0 ||
    (decision !== "apply" && decision !== "approve" && decision !== "continue" && decision !== "reject") ||
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index <= 0
  ) {
    return null;
  }
  if (normalizedCommand !== larkActionCommand(decision, index)) return null;
  return {
    opentag: "thread_action",
    version: 1,
    command: normalizedCommand,
    decision,
    index,
    ...(typeof record["proposalId"] === "string" && record["proposalId"].length > 0 ? { proposalId: record["proposalId"] } : {}),
    ...(typeof record["intentId"] === "string" && record["intentId"].length > 0 ? { intentId: record["intentId"] } : {}),
    ...(record["permissionDecision"] === "allow_once" || record["permissionDecision"] === "allow_run" || record["permissionDecision"] === "deny"
      ? { permissionDecision: record["permissionDecision"] }
      : {}),
    ...(typeof record["proposalHash"] === "string" && record["proposalHash"].length > 0 ? { proposalHash: record["proposalHash"] } : {}),
    ...(typeof record["approvalEpoch"] === "string" && record["approvalEpoch"].length > 0 ? { approvalEpoch: record["approvalEpoch"] } : {}),
    ...(typeof record["actionId"] === "string" && record["actionId"].length > 0 ? { actionId: record["actionId"] } : {})
  };
}

export function renderLarkApprovalPrompt(presentation: OpenTagApprovalPromptPresentation): string {
  const target = [presentation.target.provider, presentation.target.connectionId, presentation.target.operation, presentation.target.resource, presentation.target.resourceVersion]
    .filter((value) => value !== undefined)
    .join(" / ");
  return [
    presentation.title,
    presentation.summary,
    `Target: ${target}`,
    `Run scope: ${renderApprovalRunScope(presentation.runScope)}`,
    "Allow for run applies only to the Run scope shown above. Choose Allow once, Allow for run, or Deny."
  ].join("\n");
}

export function createLarkApprovalPromptCard(presentation: OpenTagApprovalPromptPresentation): LarkCard {
  const labels = { allow_once: "Allow once", allow_run: "Allow for run", deny: "Deny" } as const;
  return {
    config: { wide_screen_mode: true },
    header: { template: "yellow", title: { tag: "plain_text", content: presentation.title } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: renderLarkApprovalPrompt(presentation).split(" Choose Allow once")[0]! } },
      {
        tag: "action",
        layout: "trisection",
        actions: presentation.decisions.map((permissionDecision) => ({
          tag: "button",
          text: { tag: "plain_text", content: labels[permissionDecision] },
          type: permissionDecision === "allow_once" ? "primary" : permissionDecision === "deny" ? "danger" : "default",
          value: {
            opentag: "thread_action",
            version: 1,
            command: permissionDecision === "deny" ? "reject 1" : "approve 1",
            decision: permissionDecision === "deny" ? "reject" : "approve",
            index: 1,
            proposalId: presentation.proposalId,
            intentId: presentation.intentId,
            permissionDecision,
            proposalHash: presentation.proposalHash,
            approvalEpoch: presentation.approvalEpoch,
            actionId: presentation.actionId
          }
        }))
      }
    ]
  };
}

function larkPlain(value: string): string {
  return value.replace(/`/g, "");
}

function auditCommand(runId: string): string {
  return `opentag status --run ${runId}`;
}

export function renderLarkAcknowledgement(runId: string, options: { locale?: LarkRenderLocale } = {}): string {
  if (larkRenderLocale(options) === "zh-CN") {
    return ["我接了，跑完回这个话题。", `任务：${runId}`, "想看进度就在这里发 /status。"].join("\n");
  }
  return ["Received. OpenTag is working.", `Run: ${runId}`, `Use /status here for queue state; audit locally with ${auditCommand(runId)}.`].join("\n");
}

export function renderLarkRunStatusPresentation(presentation: OpenTagRunStatusPresentation, options: { locale?: LarkRenderLocale } = {}): string {
  const locale = larkRenderLocale(options);
  if (presentation.state === "received") {
    return renderLarkAcknowledgement(presentation.runId, options);
  }
  if (locale === "zh-CN") {
    if (presentation.state === "queued") {
      return ["前面还有个任务，我排在后面了。", `任务：${presentation.runId}`, "想看队列就在这里发 /status。"].join("\n");
    }
    if (presentation.state === "waiting_for_approval") {
      return ["这一步得你确认一下。", presentation.message, presentation.nextAction]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    }
    if (presentation.state === "waiting_for_human") {
      return [presentation.message ?? "这里缺个决定，得你补一下。", presentation.nextAction]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    }
    if (presentation.state === "running") {
      return ["我在处理，跑完回这里。", "想看细节就在这里发 /status。"].join("\n");
    }
    if (presentation.state === "completed") return "弄好了，结果在下面。";
    if (presentation.state === "cancelled") return "这个任务停掉了。";
    if (presentation.state === "timed_out") return "这次跑超时了，细节在 /status。";
    if (presentation.state === "failed" || presentation.state === "interrupted") {
      return ["这次没跑成。", presentation.nextAction].filter((line): line is string => Boolean(line)).join("\n");
    }
  }
  if (presentation.state === "queued") {
    return ["Queued behind an active run.", `Run: ${presentation.runId}`, "Use /status here for queue details."].join("\n");
  }
  if (presentation.state === "waiting_for_approval") {
    return ["Waiting for your review.", `Run: ${presentation.runId}`, "Review the action receipt in this thread, or use /status here for details."].join("\n");
  }
  if (presentation.state === "waiting_for_human") {
    return [
      presentation.message ?? "Waiting for human input.",
      `Run: ${presentation.runId}`,
      presentation.nextAction ?? "Use /status here for details."
    ].join("\n");
  }
  if (presentation.state === "running") {
    return [presentation.message ?? "OpenTag is working.", `Run: ${presentation.runId}`, "Use /status here for details."].join("\n");
  }
  return [
    `OpenTag run ${presentation.state}.`,
    `Run: ${presentation.runId}`,
    ...(presentation.nextAction ? [presentation.nextAction] : [`Audit locally with ${auditCommand(presentation.runId)}.`])
  ].join("\n");
}

function larkRunStatusHeaderTemplate(state: OpenTagRunStatusPresentation["state"]): LarkCard["header"]["template"] {
  if (state === "received" || state === "queued" || state === "running") return "blue";
  if (state === "waiting_for_approval" || state === "waiting_for_human") return "yellow";
  if (state === "completed") return "green";
  if (state === "failed" || state === "timed_out") return "red";
  if (state === "cancelled" || state === "interrupted") return "grey";
  return "blue";
}

function larkRunStatusTitle(state: OpenTagRunStatusPresentation["state"], locale: LarkRenderLocale): string {
  if (locale === "zh-CN") {
    if (state === "received") return "我接了";
    if (state === "queued") return "排队中";
    if (state === "running") return "在处理了";
    if (state === "waiting_for_approval") return "等你确认";
    if (state === "waiting_for_human") return "需要你补一下";
    if (state === "completed") return "弄好了";
    if (state === "cancelled") return "已经停了";
    if (state === "timed_out") return "跑超时了";
    return "这次没跑成";
  }
  if (state === "received") return "OpenTag received this";
  if (state === "queued") return "OpenTag queued this";
  if (state === "running") return "OpenTag is working";
  if (state === "waiting_for_approval") return "OpenTag is waiting for review";
  if (state === "waiting_for_human") return "OpenTag needs human input";
  return `OpenTag ${state}`;
}

export function createLarkRunStatusCard(presentation: OpenTagRunStatusPresentation, options: { locale?: LarkRenderLocale } = {}): LarkCard {
  const locale = larkRenderLocale(options);
  const statusText = renderLarkRunStatusPresentation(presentation, options);
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template: larkRunStatusHeaderTemplate(presentation.state),
      title: {
        tag: "plain_text",
        content: larkRunStatusTitle(presentation.state, locale)
      }
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: statusText
        }
      }
    ]
  };
}

export function renderLarkFinalResult(result: OpenTagRunResult, options: LarkRenderOptions = {}): string {
  return renderLarkFinalSummaryPresentation(
    createFinalSummaryPresentation({
      result,
      ...(options.auditRunId ? { auditRunId: options.auditRunId } : {})
    }),
    options
  );
}

export function renderLarkFinalSummaryPresentation(presentation: OpenTagFinalSummaryPresentation, options: { locale?: LarkRenderLocale } = {}): string {
  const locale = larkRenderLocale(options);
  const lines = [
    locale === "zh-CN" ? `已完成：${larkOutcomeLabel(presentation.outcome, locale)}。` : `Finished with ${presentation.outcome}.`,
    "",
    presentation.summary
  ];

  if (presentation.verification?.length) {
    lines.push("", locale === "zh-CN" ? "验证" : "Verification");
    for (const check of presentation.verification) {
      lines.push(`- ${check.command}: ${check.outcome}`);
    }
  }

  if (presentation.artifacts?.length) {
    lines.push("", locale === "zh-CN" ? "产物" : "Artifacts");
    for (const artifact of presentation.artifacts) {
      lines.push(`- ${larkArtifactSummary(artifact, { locale })}`);
    }
    lines.push(locale === "zh-CN" ? "链接和详情在 audit/status 中。" : "Links/details are in audit/status.");
  }

  if (presentation.nextActions?.length) {
    lines.push("", locale === "zh-CN" ? `下一步：${presentation.nextActions[0]}` : `Next action: ${presentation.nextActions[0]}`);
  }
  const actionReceipt = larkFinalSummaryActionReceiptMarkdown(presentation, { locale });
  if (actionReceipt) {
    lines.push("", actionReceipt);
  }
  if (presentation.auditRunId) {
    lines.push("", `Audit: opentag status --run ${presentation.auditRunId}`);
  }

  return lines.join("\n");
}

function larkHeaderTemplate(outcome: string): LarkCard["header"]["template"] {
  if (outcome === "success") return "green";
  if (outcome === "failure") return "red";
  if (outcome === "cancelled") return "grey";
  if (outcome === "needs_human") return "blue";
  return "yellow";
}

function larkOutcomeLabel(outcome: string, locale: LarkRenderLocale): string {
  if (locale === "en-US") return outcome;
  if (outcome === "success") return "成功";
  if (outcome === "failure") return "失败";
  if (outcome === "cancelled") return "已取消";
  if (outcome === "needs_human") return "待确认";
  return outcome;
}

function larkFinalHeaderTitle(outcome: string, locale: LarkRenderLocale): string {
  return locale === "zh-CN" ? `完成：${larkOutcomeLabel(outcome, locale)}` : `Finished: ${outcome}`;
}

function compactCardText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function compactMultilineText(text: string, maxLength: number): string {
  const compact = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function larkMarkdownList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function larkArtifactKindLabel(kind: string | undefined, locale: LarkRenderLocale): string {
  if (locale === "zh-CN") {
    if (kind === "patch") return "补丁";
    if (kind === "report") return "报告";
    if (kind === "screenshot") return "截图";
    if (kind === "log_summary") return "日志";
    if (kind === "pull_request") return "PR";
    return kind ? kind.replace(/_/g, " ") : "产物";
  }
  if (kind === "patch") return "Patch";
  if (kind === "report") return "Report";
  if (kind === "screenshot") return "Screenshot";
  if (kind === "log_summary") return "Logs";
  if (kind === "pull_request") return "Pull request";
  return kind ? kind.replace(/_/g, " ") : "Artifact";
}

function larkArtifactSummary(input: { kind?: string | undefined; title: string; uri: string }, options: { locale?: LarkRenderLocale } = {}): string {
  const locale = larkRenderLocale(options);
  const label = larkArtifactKindLabel(input.kind, locale);
  const title = larkPlain(input.title);
  const summary = title.toLowerCase() === label.toLowerCase() ? label : `${label}: ${title}`;
  if (/^https?:\/\//i.test(input.uri)) {
    return `[${summary}](${input.uri})`;
  }
  return summary;
}

function larkSummaryHeading(line: string): string | undefined {
  const trimmed = line.trim();
  const markdownHeading = trimmed.match(/^#{1,6}\s+(.+)$/);
  if (markdownHeading?.[1]) return larkPlain(markdownHeading[1]).trim();
  const boldHeading = trimmed.match(/^\*\*(.+?)\*\*$/);
  if (boldHeading?.[1]) return larkPlain(boldHeading[1]).trim();
  return undefined;
}

function larkPlainSummaryLine(line: string): string {
  return larkPlain(line)
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .trimEnd();
}

function larkSummarySections(summary: string): Array<{ title?: string; content: string }> {
  const sections: Array<{ title?: string; lines: string[] }> = [];
  let current: { title?: string; lines: string[] } = { lines: [] };

  function flush(): void {
    while (current.lines.at(-1) === "") current.lines.pop();
    const content = current.lines.join("\n").trim();
    if (current.title || content) {
      sections.push({ ...(current.title ? { title: current.title } : {}), lines: content ? content.split("\n") : [] });
    }
  }

  for (const rawLine of summary.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) continue;

    const heading = larkSummaryHeading(trimmed);
    if (heading) {
      flush();
      current = { title: heading, lines: [] };
      continue;
    }

    if (trimmed.length === 0) {
      if (current.lines.length > 0 && current.lines.at(-1) !== "") current.lines.push("");
      continue;
    }

    current.lines.push(larkPlainSummaryLine(rawLine).trim());
  }
  flush();

  return sections.map((section) => ({
    ...(section.title ? { title: section.title } : {}),
    content: compactMultilineText(section.lines.join("\n"), 600)
  }));
}

function larkFinalSummaryElements(summary: string): LarkCardElement[] {
  const sections = larkSummarySections(summary);
  const visibleSections = sections.slice(0, 3);
  const elements: LarkCardElement[] = [];

  for (const section of visibleSections) {
    if (section.title) {
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**${section.title}**`
        }
      });
    }
    if (section.content) {
      elements.push({
        tag: "div",
        text: {
          tag: "plain_text",
          content: section.content
        }
      });
    }
  }

  if (sections.length > visibleSections.length) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: "Summary preview truncated. Full detail is available in the audit/status output."
        }
      ]
    });
  }

  return elements.length > 0
    ? elements
    : [
        {
          tag: "div",
          text: {
            tag: "plain_text",
            content: compactMultilineText(larkPlain(summary), 900)
          }
        }
      ];
}

function larkActionDecisionLabel(decision: OpenTagPresentationAction["visibleDecisions"][number], index: number): string {
  if (decision === "apply") return `Apply now: apply ${index}`;
  if (decision === "approve") return `Approve only: approve ${index}`;
  if (decision === "continue") return `Continue: continue ${index}`;
  return `Reject: reject ${index}`;
}

function larkActionDetails(action: OpenTagPresentationAction): string[] {
  const rowDetails = action.detailRows?.map((row) => `${row.label}: ${larkPlain(row.value)}`) ?? [];
  if (rowDetails.length > 0) return rowDetails.map((detail) => compactCardText(detail, 180));

  const details = [`Target: ${action.targetLabel}`];
  if (action.setupReason) details.push(`Status: ${action.setupReason}`);
  if (action.details?.length) details.push(...action.details.slice(0, 3));
  return details.map((detail) => compactCardText(larkPlain(detail), 180));
}

function larkActionReceiptMarkdown(input: { title: string; actions: OpenTagPresentationAction[] }, options: { includeTitle?: boolean } = {}): string | undefined {
  if (input.actions.length === 0) return undefined;
  const visibleActions = input.actions.slice(0, 5);
  const lines = [
    ...(options.includeTitle === false ? [] : [`**${input.title}**`]),
    "Choose a command in this source thread. Details stay in OpenTag audit/status."
  ];
  for (const action of visibleActions) {
    lines.push("", `**${action.index}. ${compactCardText(action.title, 180)}**`);
    lines.push(...larkMarkdownList(larkActionDetails(action)).split("\n"));
    lines.push(...larkMarkdownList(action.visibleDecisions.map((decision) => larkActionDecisionLabel(decision, action.index))).split("\n"));
  }
  const remaining = input.actions.length - visibleActions.length;
  if (remaining > 0) {
    lines.push("", `Showing first ${visibleActions.length} of ${input.actions.length} actions. Use opentag status locally for full detail.`);
  }
  return lines.join("\n");
}

function larkActionCommand(decision: OpenTagPresentationAction["visibleDecisions"][number], index: number): string {
  return `${decision} ${index}`;
}

function larkLocalizedActionCommand(decision: OpenTagPresentationAction["visibleDecisions"][number], index: number, locale: LarkRenderLocale): string {
  if (locale === "en-US") return larkActionCommand(decision, index);
  if (decision === "apply") return `执行 ${index}`;
  if (decision === "approve") return `确认 ${index}`;
  if (decision === "continue") return `继续 ${index}`;
  return `拒绝 ${index}`;
}

function larkPrimaryActionCommand(action: OpenTagPresentationAction): string | undefined {
  const decision =
    action.primaryDecision !== "none"
      ? action.primaryDecision
      : action.visibleDecisions.find((candidate) => candidate !== "reject") ?? action.visibleDecisions[0];
  return decision ? larkActionCommand(decision, action.index) : undefined;
}

function larkFinalActionTitle(title: string, locale: LarkRenderLocale): string {
  const plain = larkPlain(title);
  if (/^Create a pull request for branch\b/i.test(plain)) return locale === "zh-CN" ? "创建 PR" : "Create PR";
  if (/^Link the run branch\b/i.test(plain)) return locale === "zh-CN" ? "关联运行分支" : "Link run branch";
  if (/^Request human review\b/i.test(plain)) return locale === "zh-CN" ? "请求人工 Review" : "Request human review";
  return compactCardText(plain, 120);
}

function larkActionReceiptTitle(title: string, locale: LarkRenderLocale): string {
  if (/ready to apply|needs setup|needs attention|needs approval/i.test(title)) return locale === "zh-CN" ? "需要你确认" : compactCardText(larkPlain(title), 140);
  return compactCardText(larkPlain(title), 140);
}

function larkActionStatusLine(action: OpenTagPresentationAction, locale: LarkRenderLocale): string | undefined {
  if (locale === "en-US") {
    if (action.state === "ready_to_apply") return "Ready to apply.";
    if (action.state === "needs_approval") return "Needs approval.";
    if (action.state === "needs_setup") return "Needs setup; details are in audit/status.";
    if (action.state === "unsupported") return "Not available here; details are in audit/status.";
    return undefined;
  }
  if (action.state === "ready_to_apply") return "可直接执行。";
  if (action.state === "needs_approval") return "需要先确认。";
  if (action.state === "needs_setup") return "需要先完成配置，详情见 audit/status。";
  if (action.state === "unsupported") return "暂不能直接执行，详情见 audit/status。";
  return undefined;
}

function larkPrimaryDecision(action: OpenTagPresentationAction): OpenTagPresentationAction["visibleDecisions"][number] | undefined {
  return action.primaryDecision !== "none"
    ? action.primaryDecision
    : action.visibleDecisions.find((candidate) => candidate !== "reject") ?? action.visibleDecisions[0];
}

function larkFallbackCommandHint(action: OpenTagPresentationAction, locale: LarkRenderLocale): string | undefined {
  const primaryDecision = larkPrimaryDecision(action);
  const rejectDecision = action.visibleDecisions.includes("reject") ? "reject" : undefined;
  const decisions = Array.from(
    new Set([primaryDecision, rejectDecision].filter((decision): decision is OpenTagPresentationAction["visibleDecisions"][number] => Boolean(decision)))
  );
  if (decisions.length === 0) return undefined;
  const localized = decisions.map((decision) => `\`${larkLocalizedActionCommand(decision, action.index, locale)}\``).join(" / ");
  const crossPlatform = decisions.map((decision) => `\`${larkActionCommand(decision, action.index)}\``).join(" / ");
  if (locale === "en-US") return `If buttons are unavailable, reply ${crossPlatform}.`;
  return `按钮不可用时：回复 ${localized}（也支持 ${crossPlatform}）。`;
}

function larkDecisionButtonLabel(action: OpenTagPresentationAction, decision: OpenTagPresentationAction["visibleDecisions"][number], locale: LarkRenderLocale): string {
  if (locale === "en-US") {
    if (decision === "reject") return "Reject";
    if (decision === "continue") return "Continue";
    if (decision === "approve") return "Approve";
    if (/^Create a pull request for branch\b/i.test(larkPlain(action.title))) return "Create PR";
    return "Apply";
  }
  if (decision === "reject") return "拒绝";
  if (decision === "continue") return "继续";
  if (decision === "approve") return "确认";
  if (/^Create a pull request for branch\b/i.test(larkPlain(action.title))) return "创建 PR";
  return "执行";
}

function larkButtonType(decision: OpenTagPresentationAction["visibleDecisions"][number]): NonNullable<LarkCardButton["type"]> {
  if (decision === "reject") return "danger";
  if (decision === "apply" || decision === "approve") return "primary";
  return "default";
}

function larkActionButton(action: OpenTagPresentationAction, decision: OpenTagPresentationAction["visibleDecisions"][number], locale: LarkRenderLocale): LarkCardButton {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: larkDecisionButtonLabel(action, decision, locale)
    },
    type: larkButtonType(decision),
    value: {
      opentag: "thread_action",
      version: 1,
      command: larkActionCommand(decision, action.index),
      decision,
      index: action.index,
      ...(action.proposalId ? { proposalId: action.proposalId } : {}),
      ...(action.intentId ? { intentId: action.intentId } : {})
    }
  };
}

function larkActionButtons(action: OpenTagPresentationAction, locale: LarkRenderLocale): LarkCardButton[] {
  return action.visibleDecisions.map((decision) => larkActionButton(action, decision, locale));
}

function larkFinalSummaryActionReceiptMarkdown(presentation: OpenTagFinalSummaryPresentation, options: { locale?: LarkRenderLocale } = {}): string | undefined {
  const locale = larkRenderLocale(options);
  const actions = presentation.actions ?? [];
  if (!presentation.actionReceiptTitle || actions.length === 0) return undefined;
  const visibleActions = actions.slice(0, MAX_LARK_COMPACT_FINAL_ACTIONS);
  const lines = [
    locale === "zh-CN" ? "**需要确认**" : "**Actions**",
    larkActionReceiptTitle(presentation.actionReceiptTitle, locale),
  ];

  for (const action of visibleActions) {
    const primaryCommand = larkPrimaryActionCommand(action);
    const rejectCommand = action.visibleDecisions.includes("reject") ? larkActionCommand("reject", action.index) : undefined;
    const commandHint = [primaryCommand, rejectCommand].filter((command): command is string => Boolean(command)).join(" / ");
    lines.push("", `${action.index}. ${larkFinalActionTitle(action.title, locale)}`);
    const statusLine = larkActionStatusLine(action, locale);
    if (statusLine) {
      lines.push(statusLine);
    }
    if (commandHint) {
      const fallbackHint = larkFallbackCommandHint(action, locale);
      lines.push(fallbackHint ?? (locale === "zh-CN" ? `按钮不可用时：回复 ${commandHint}` : `If buttons are unavailable, reply ${commandHint}.`));
    }
  }

  const remaining = actions.length - visibleActions.length;
  lines.push(
    ...(remaining > 0 ? ["", locale === "zh-CN" ? `还有 ${remaining} 个动作在 audit/status 中。` : `+${remaining} more action(s) in audit/status.`] : []),
    locale === "zh-CN" ? "完整动作详情保留在 OpenTag audit/status。" : "Full action details stay in OpenTag audit/status."
  );
  return lines.join("\n");
}

function larkFinalSummaryActionReceiptElements(presentation: OpenTagFinalSummaryPresentation, options: { locale?: LarkRenderLocale } = {}): LarkCardElement[] {
  const locale = larkRenderLocale(options);
  const actions = presentation.actions ?? [];
  if (!presentation.actionReceiptTitle || actions.length === 0) return [];
  const visibleActions = actions.slice(0, MAX_LARK_COMPACT_FINAL_ACTIONS);
  const elements: LarkCardElement[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: [locale === "zh-CN" ? "**需要确认**" : "**Actions**", larkActionReceiptTitle(presentation.actionReceiptTitle, locale)].join("\n")
      }
    }
  ];

  for (const action of visibleActions) {
    const statusLine = larkActionStatusLine(action, locale);
    const fallbackHint = larkFallbackCommandHint(action, locale);
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          `**${action.index}. ${larkFinalActionTitle(action.title, locale)}**`,
          ...(statusLine ? [statusLine] : []),
          ...(fallbackHint ? [fallbackHint] : [])
        ].join("\n")
      }
    });
    const buttons = larkActionButtons(action, locale);
    if (buttons.length > 0) {
      elements.push({
        tag: "action",
        layout: buttons.length >= 3 ? "trisection" : "bisected",
        actions: buttons
      });
    }
  }

  const remaining = actions.length - visibleActions.length;
  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: [
          remaining > 0 ? (locale === "zh-CN" ? `还有 ${remaining} 个动作在 audit/status 中。` : `${remaining} more action(s) in audit/status.`) : undefined,
          locale === "zh-CN" ? "完整动作详情保留在 OpenTag audit/status。" : "Full action details stay in OpenTag audit/status."
        ].filter((line): line is string => Boolean(line)).join(" ")
      }
    ]
  });
  return elements;
}

function larkActionReceiptHeaderTemplate(actions: OpenTagPresentationAction[]): LarkCard["header"]["template"] {
  if (actions.some((action) => action.state === "needs_setup" || action.state === "unsupported")) return "yellow";
  if (actions.some((action) => action.state === "ready_to_apply" || action.state === "needs_approval")) return "blue";
  return "grey";
}

export function createLarkFinalSummaryCard(presentation: OpenTagFinalSummaryPresentation, options: { locale?: LarkRenderLocale } = {}): LarkCard {
  const locale = larkRenderLocale(options);
  const elements: LarkCardElement[] = larkFinalSummaryElements(presentation.summary);

  if (presentation.verification?.length) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          locale === "zh-CN" ? "**验证**" : "**Verification**",
          larkMarkdownList(presentation.verification.slice(0, 5).map((check) => `${larkPlain(check.command)}: ${check.outcome}`))
        ].join("\n")
      }
    });
  }

  if (presentation.changedFiles?.length) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          locale === "zh-CN" ? "**变更文件**" : "**Changed files**",
          larkMarkdownList(presentation.changedFiles.slice(0, 8).map(larkPlain))
        ].join("\n")
      }
    });
  }

  if (presentation.artifacts?.length) {
    const visibleArtifacts = presentation.artifacts.slice(0, 6);
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          locale === "zh-CN" ? "**产物**" : "**Artifacts**",
          larkMarkdownList(visibleArtifacts.map((artifact) => larkArtifactSummary(artifact, { locale }))),
          ...(presentation.artifacts.length > visibleArtifacts.length
            ? [
                locale === "zh-CN"
                  ? `还有 ${presentation.artifacts.length - visibleArtifacts.length} 个产物。`
                  : `+${presentation.artifacts.length - visibleArtifacts.length} more artifact(s).`
              ]
            : []),
          locale === "zh-CN" ? "详情在 audit/status 中。" : "Links/details are in audit/status."
        ].join("\n")
      }
    });
  }

  const hasActionReceipt = Boolean(presentation.actionReceiptTitle && presentation.actions?.length);
  if (presentation.nextActions?.length && !hasActionReceipt) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          locale === "zh-CN" ? "**下一步**" : "**Next action**",
          larkMarkdownList(presentation.nextActions.map((action) => compactCardText(action, 240)))
        ].join("\n")
      }
    });
  }

  const actionReceiptElements = larkFinalSummaryActionReceiptElements(presentation, { locale });
  if (actionReceiptElements.length > 0) {
    elements.push({ tag: "hr" });
    elements.push(...actionReceiptElements);
  }

  if (presentation.auditRunId) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: `Audit: opentag status --run ${presentation.auditRunId}`
        }
      ]
    });
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template: larkHeaderTemplate(presentation.outcome),
      title: {
        tag: "plain_text",
        content: larkFinalHeaderTitle(presentation.outcome, locale)
      }
    },
    elements
  };
}

export function renderLarkActionReceiptPresentation(presentation: OpenTagActionReceiptPresentation): string {
  return [
    presentation.title,
    "",
    larkActionReceiptMarkdown({ title: presentation.title, actions: presentation.actions }, { includeTitle: false }) ?? "No source-thread actions.",
    ...(presentation.auditRunId ? ["", `Audit: opentag status --run ${presentation.auditRunId}`] : [])
  ].join("\n");
}

export function createLarkActionReceiptCard(presentation: OpenTagActionReceiptPresentation): LarkCard {
  const elements: LarkCardElement[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: larkActionReceiptMarkdown({ title: presentation.title, actions: presentation.actions }, { includeTitle: false }) ?? "No source-thread actions."
      }
    }
  ];

  if (presentation.auditRunId) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: `Audit: opentag status --run ${presentation.auditRunId}`
        }
      ]
    });
  }

  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: larkActionReceiptHeaderTemplate(presentation.actions),
      title: {
        tag: "plain_text",
        content: presentation.title.replace(/:$/, "")
      }
    },
    elements
  };
}

function larkDoctorHeaderTemplate(checks: OpenTagDoctorCheckPresentation[]): LarkCard["header"]["template"] {
  if (checks.some((check) => check.status === "fail")) return "red";
  if (checks.some((check) => check.status === "warn" || check.status === "unknown")) return "yellow";
  return "green";
}

function larkStatusHeaderTemplate(presentation: OpenTagSourceThreadStatusPresentation): LarkCard["header"]["template"] {
  if (presentation.bindingState === "unbound") return "yellow";
  if (presentation.activeRun) return "blue";
  return "green";
}

function checkStatusLabel(status: OpenTagDoctorCheckPresentation["status"]): string {
  return status.toUpperCase();
}

export function createLarkDoctorSummaryCard(presentation: OpenTagDoctorSummaryPresentation): LarkCard {
  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: larkDoctorHeaderTemplate(presentation.checks),
      title: {
        tag: "plain_text",
        content: presentation.title.replace(/:$/, "")
      }
    },
    elements: presentation.checks.map((check) => ({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**${checkStatusLabel(check.status)} ${check.name}**${check.message ? `\n${compactCardText(check.message, 500)}` : ""}`
      }
    }))
  };
}

export function createLarkSourceThreadStatusCard(presentation: OpenTagSourceThreadStatusPresentation): LarkCard {
  const elements: LarkCardElement[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          presentation.sourceContainer ? `**Source container**\n${presentation.sourceContainer}` : undefined,
          `**Project Target**\n${presentation.projectTarget ?? "not bound"}`,
          `**Active run**\n${
            presentation.activeRun
              ? `${presentation.activeRun.id} (${presentation.activeRun.status})${
                  presentation.activeRun.updatedAt ? `, updated ${presentation.activeRun.updatedAt}` : ""
                }`
              : "none"
          }`,
          presentation.currentCommand ? `**Command**\n${compactCardText(presentation.currentCommand, 240)}` : undefined
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n\n")
      }
    }
  ];

  const queuedTotal = presentation.queuedFollowUpsTotal ?? presentation.queuedFollowUps.length;
  const queuedIds = presentation.queuedFollowUps.map((followUp) => {
    const status = followUp.status ? ` (${followUp.status})` : "";
    const command = followUp.command ? `: ${compactCardText(followUp.command, 120)}` : "";
    return `${followUp.id}${status}${command}`;
  });
  const queuedOverflow = Math.max(queuedTotal - queuedIds.length, 0);
  const queuedSummary =
    queuedTotal === 0
      ? "none"
      : `${queuedTotal}${queuedIds.length ? ` (${queuedIds.join(", ")}${queuedOverflow > 0 ? `, +${queuedOverflow} more` : ""})` : ""}`;

  elements.push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: ["**Queued follow-ups**", queuedSummary, "", "**Next action**", compactCardText(presentation.nextAction, 360)].join("\n")
    }
  });

  if (presentation.stopHint || presentation.detailHint) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: [presentation.stopHint ? `Stop/timeout: ${presentation.stopHint}` : undefined, presentation.detailHint ? `Details: ${presentation.detailHint}` : undefined]
            .filter((line): line is string => Boolean(line))
            .join(" ")
        }
      ]
    });
  }

  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: larkStatusHeaderTemplate(presentation),
      title: {
        tag: "plain_text",
        content: presentation.title.replace(/:$/, "")
      }
    },
    elements
  };
}

// Lark text message content is a JSON-encoded `{ "text": "..." }` string.
export function createLarkTextMessageContent(text: string): string {
  return JSON.stringify({ text });
}

// Lark interactive message content is a JSON-encoded card object.
export function createLarkInteractiveMessageContent(card: LarkCard): string {
  return JSON.stringify(card);
}
