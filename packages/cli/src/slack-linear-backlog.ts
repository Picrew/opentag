import { fetchLinearProjectBacklog, type LinearBacklogIssue, type LinearProjectBacklog } from "@opentag/linear";
import { escapeSlackText, type SlackEventProcessorInput } from "@opentag/slack";
import type { OpenTagCliConfig } from "./config.js";
import { resolveDefaultLinearBacklogToken, resolveLinearBacklogChannel } from "./linear-backlog-config.js";

export const SLACK_LINEAR_BACKLOG_LIMIT = 20;
export const SLACK_LINEAR_BACKLOG_TIMEOUT_MS = 10_000;

const NOT_CONFIGURED_TEXT =
  "Linear backlog is not configured for Slack. Add an entry to platforms.linear.channels and configure a Linear query credential.";
const UNAVAILABLE_TEXT = "Linear API is unavailable right now; try again later.";

const STATE_TYPE_EMOJI: Record<string, string> = {
  started: "🔵",
  unstarted: "⚪",
  backlog: "⚫",
  triage: "🟣"
};

function priorityMarker(priority: number): string {
  if (priority === 1) return " [urgent]";
  if (priority === 2) return " [high]";
  return "";
}

function safeSlackLinkUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // Slack uses `|` as the separator in <url|label>; URL leaves literal
    // pipes untouched, so encode them before embedding the href in mrkdwn.
    return url.href.replaceAll("|", "%7C");
  } catch {
    return null;
  }
}

function renderIssueLine(issue: LinearBacklogIssue): string {
  const marker = priorityMarker(issue.priority);
  const identifier = escapeSlackText(issue.identifier);
  const url = safeSlackLinkUrl(issue.url);
  const label = url ? `<${url}|${identifier}>` : identifier;
  return `• ${label}${marker} ${escapeSlackText(issue.title)}`;
}

type IssueGroup = { stateName: string; stateType: string; issues: LinearBacklogIssue[] };

function stateGroupKey(input: Pick<LinearBacklogIssue, "stateName" | "stateType">): string {
  return JSON.stringify([input.stateType, input.stateName]);
}

function groupShownIssues(shown: LinearBacklogIssue[]): IssueGroup[] {
  const groups: IssueGroup[] = [];
  const byState = new Map<string, IssueGroup>();
  for (const issue of shown) {
    const key = stateGroupKey(issue);
    let group = byState.get(key);
    if (!group) {
      group = { stateName: issue.stateName, stateType: issue.stateType, issues: [] };
      byState.set(key, group);
      groups.push(group);
    }
    group.issues.push(issue);
  }
  return groups;
}

export function renderSlackLinearBacklogReply(input: {
  backlog: LinearProjectBacklog;
  limit: number;
  queriedAt: string;
}): string {
  const { backlog, limit, queriedAt } = input;
  const shown = backlog.issues.slice(0, limit);
  const name = escapeSlackText(backlog.projectName ?? "Backlog");
  const truncated = backlog.fetched > limit || backlog.hasMore;
  const queriedHhMm = queriedAt.slice(11, 16);

  const lines: string[] = [];
  if (backlog.fetched === 0) {
    lines.push(`*${name} · 0 open* 🎉`);
    lines.push("No unfinished issues in this Linear project.");
  } else {
    const totalLabel = backlog.hasMore ? `${backlog.fetched}+` : String(backlog.fetched);
    const showingSuffix = truncated ? ` · showing ${shown.length}` : "";
    lines.push(`*${name} · ${totalLabel} open*${showingSuffix}`);

    const totalByState = new Map<string, number>();
    for (const issue of backlog.issues) {
      const key = stateGroupKey(issue);
      totalByState.set(key, (totalByState.get(key) ?? 0) + 1);
    }
    for (const group of groupShownIssues(shown)) {
      const totalInGroup = totalByState.get(stateGroupKey(group)) ?? 0;
      const shownInGroup = group.issues.length;
      const countLabel = shownInGroup < totalInGroup ? `${shownInGroup} of ${totalInGroup}` : String(totalInGroup);
      const emoji = STATE_TYPE_EMOJI[group.stateType] ?? "▫️";
      lines.push("");
      lines.push(`${emoji} *${escapeSlackText(group.stateName)} (${countLabel})*`);
      for (const issue of group.issues) lines.push(renderIssueLine(issue));
    }
  }

  lines.push("");
  if (truncated) {
    const hiddenCount = backlog.fetched - shown.length;
    const hiddenLabel = backlog.hasMore ? `${hiddenCount}+` : String(hiddenCount);
    lines.push(`_Linear · queried ${queriedHhMm} UTC · ${hiddenLabel} more not shown_`);
  } else {
    lines.push(`_Linear · queried ${queriedHhMm} UTC_`);
  }
  return lines.join("\n");
}

export function createSlackLinearBacklogHandler(input: {
  linear?: OpenTagCliConfig["platforms"]["linear"];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => string;
  logError?: (message: string) => void;
  getToken?: () => Promise<string | undefined> | string | undefined;
}): NonNullable<SlackEventProcessorInput["linear"]> {
  const env = input.env ?? process.env;
  const now = input.now ?? (() => new Date().toISOString());
  const logError = input.logError ?? ((message: string) => console.error(message));

  return async (context) => {
    const resolution = resolveLinearBacklogChannel({
      ...(input.linear ? { linear: input.linear } : {}),
      teamId: context.teamId,
      channelId: context.channelId,
      env
    });
    if (resolution.kind === "not-configured") return NOT_CONFIGURED_TEXT;
    if (resolution.kind === "unauthorized") {
      return `Linear backlog access is not authorized for Slack channel ${escapeSlackText(context.teamId)}/${escapeSlackText(context.channelId)}.`;
    }
    if (resolution.kind === "unsupported-connection") {
      return `Linear backlog is unavailable for this channel because connection ${escapeSlackText(resolution.connection)} is not supported.`;
    }

    try {
      const providedToken = input.getToken ? await input.getToken() : undefined;
      const token =
        providedToken?.trim() ||
        resolveDefaultLinearBacklogToken({ ...(input.linear ? { linear: input.linear } : {}), env });
      if (!token) return NOT_CONFIGURED_TEXT;

      const backlog = await fetchLinearProjectBacklog({
        token,
        projectId: resolution.projectId,
        ...(resolution.graphqlUrl ? { graphqlUrl: resolution.graphqlUrl } : {}),
        fetchImpl: input.fetchImpl ?? fetch,
        timeoutMs: SLACK_LINEAR_BACKLOG_TIMEOUT_MS
      });
      return {
        text: renderSlackLinearBacklogReply({ backlog, limit: SLACK_LINEAR_BACKLOG_LIMIT, queriedAt: now() }),
        textFormat: "mrkdwn" as const
      };
    } catch (error) {
      logError(`[slack] linear backlog query failed: ${error instanceof Error ? error.message : String(error)}`);
      return UNAVAILABLE_TEXT;
    }
  };
}
