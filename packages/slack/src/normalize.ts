import {
  commandFromRawText,
  isRepositoryFreePermissionScope,
  OpenTagChannelInboundMessageSchema,
  type ContextPointer,
  type OpenTagChannelInboundMessage,
  type OpenTagCommand,
  type OpenTagEvent,
  type PermissionGrant
} from "@opentag/core";

export type SlackChannelBinding = {
  teamId: string;
  channelId: string;
} & ({ repoProvider?: string; owner: string; repo: string } | { repoProvider?: never; owner?: never; repo?: never });

export type SlackAppMentionInput = {
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs?: string;
  eventId: string;
  eventTime: number;
  appId?: string;
  agentId?: string;
  botUserId?: string;
  callbackUri?: string;
  signatureVerified?: boolean;
  binding: SlackChannelBinding;
};

// Matches a run of one or more leading user mentions (e.g. a teammate mention
// placed before the bot mention) along with the whitespace separating them.
const LEADING_MENTION_RUN = /^(?:<@[^>]+>\s*)+/;
// Matches a single mention token, used to confirm the bot itself appears in the
// leading run so we only treat the message as an at-mention of the bot.
const MENTION_TOKEN = /<@([^>]+)>/g;

export function stripSlackAppMention(text: string, botUserId?: string): string | null {
  const run = text.match(LEADING_MENTION_RUN);
  if (!run) return null;

  // Only strip the *leading* run of mentions; mentions later in the message
  // (e.g. "<@bot> ping <@teammate> now") must be preserved as command text.
  const leadingRun = run[0];

  if (botUserId) {
    // Require that the bot is mentioned somewhere in the leading run before we
    // accept this as a command directed at the bot. This lets a teammate
    // mention precede the bot mention without breaking routing.
    const mentionedIds = leadingRun.match(MENTION_TOKEN) ?? [];
    const botIsMentioned = mentionedIds.some((token) => {
      // Slack mentions may carry a display-name/label suffix, e.g.
      // "<@U12345|alice>". Strip the label so we compare against the bare
      // user ID rather than "U12345|alice".
      const id = token.slice(2, -1).split("|")[0] ?? "";
      return id.toLowerCase() === botUserId.toLowerCase();
    });
    if (!botIsMentioned) return null;
  }

  const stripped = text.slice(leadingRun.length).trim();
  return stripped.length > 0 ? stripped : null;
}

export function encodeSlackThreadKey(input: { teamId: string; channelId: string; threadTs: string }): string {
  return `${input.teamId}|${input.channelId}|${input.threadTs}`;
}

export function parseSlackThreadKey(threadKey: string): { teamId: string; channelId: string; threadTs: string } {
  const segments = threadKey.split("|");
  const [teamId, channelId, threadTs] = segments;
  if (segments.length !== 3 || !teamId || !channelId || !threadTs) {
    throw new Error(`Invalid Slack thread key: ${threadKey}`);
  }
  return { teamId, channelId, threadTs };
}

export function normalizeSlackChannelMessage(input: SlackAppMentionInput): OpenTagChannelInboundMessage | null {
  const text = stripSlackAppMention(input.text, input.botUserId);
  if (!text) return null;
  const threadTs = input.threadTs ?? input.ts;
  const channel = { provider: "slack", workspace: input.teamId, id: input.channelId };
  const thread = { provider: "slack", id: threadTs, parentMessageId: threadTs };
  return OpenTagChannelInboundMessageSchema.parse({
    protocol: "opentag.channel.v1",
    eventId: input.eventId,
    occurredAt: new Date(input.eventTime * 1000).toISOString(),
    trigger: "mention",
    source: {
      kind: "channel_message",
      channel,
      thread,
      actor: { provider: "slack", id: input.userId }
    },
    text,
    attachments: [],
    replyTarget: { channel, thread, purpose: "all" }
  });
}

const UNKNOWN_WRITE_VERB_PATTERN = /\b(add|append|apply|change|commit|create|delete|edit|fix|modify|open\s+a?\s*pr|pull\s+request|remove|update|write)\b/i;
const REPO_WRITE_TARGET_PATTERN =
  /\b(repo|repository|code|file|files|branch|commit|diff|patch|readme|pr|pull\s+request|package\.json|pnpm|npm|test|build)\b|(?:^|\s)[./\w-]+\.(?:cjs|css|gitignore|go|html|js|json|jsx|lock|md|mjs|py|rb|rs|sh|toml|ts|tsx|txt|yaml|yml)\b|(?:^|[\s`'"(])(?:[./\w-]+\/)?(?:Dockerfile|Makefile|Procfile|Rakefile|Gemfile|Brewfile|Justfile|Taskfile|\.dockerignore|\.env(?:\.[\w-]+)?|\.gitignore|\.npmrc)(?=$|[\s`'",.):])/i;
const LINEAR_ISSUE_CREATE_PATTERN = /(?=.*\blinear\b)(?=.*\b(?:issue|task|ticket)\b)(?=.*\b(?:add|create|file|open)\b)/i;
function repositoryMetadataFromBinding(
  binding: SlackChannelBinding
): { repoProvider: string; owner: string; repo: string } | undefined {
  if (!binding.owner?.trim() || !binding.repo?.trim()) return undefined;
  return {
    repoProvider: binding.repoProvider?.trim() || "github",
    owner: binding.owner,
    repo: binding.repo
  };
}

function ownerContainerUri(repository: { repoProvider: string; owner: string; repo: string }): string | undefined {
  const id = `${repository.owner}/${repository.repo}`;
  if (repository.repoProvider === "github") return `https://github.com/${id}`;
  if (repository.repoProvider === "gitlab") return `https://gitlab.com/${id}`;
  return undefined;
}

function workItemFromBoundSlackThread(input: {
  teamId: string;
  channelId: string;
  threadTs: string;
  threadKey: string;
  repository: { repoProvider: string; owner: string; repo: string };
}): NonNullable<OpenTagEvent["workItem"]> {
  const ownerContainerId = `${input.repository.owner}/${input.repository.repo}`;
  const ownerContainerUriValue = ownerContainerUri(input.repository);
  return {
    provider: "slack",
    kind: "thread",
    externalId: input.threadKey,
    uri: `slack://team/${input.teamId}/channel/${input.channelId}/thread/${input.threadTs}`,
    ownerContainer: {
      provider: input.repository.repoProvider,
      id: ownerContainerId,
      ...(ownerContainerUriValue ? { uri: ownerContainerUriValue } : {})
    }
  };
}

function commandLooksRepoWriteCapable(command: OpenTagCommand): boolean {
  return UNKNOWN_WRITE_VERB_PATTERN.test(command.rawText) && REPO_WRITE_TARGET_PATTERN.test(command.rawText);
}

function commandLooksLinearIssueCreateCapable(command: OpenTagCommand): boolean {
  return LINEAR_ISSUE_CREATE_PATTERN.test(command.rawText);
}

function addPermissionGrant(permissions: PermissionGrant[], grant: PermissionGrant): void {
  if (!permissions.some((permission) => permission.scope === grant.scope)) permissions.push(grant);
}

function permissionsForCommand(command: OpenTagCommand, hasRepositoryTarget: boolean): PermissionGrant[] {
  const permissions: PermissionGrant[] = [
    {
      scope: "chat:postMessage",
      reason: "reply in the originating Slack thread"
    },
    {
      scope: "reactions:write",
      reason: "mark the originating Slack message as received without posting a thread reply"
    },
    {
      scope: "runner:local",
      reason: "execute the run on a paired local daemon"
    }
  ];

  if (
    hasRepositoryTarget &&
    (command.intent === "fix" || command.intent === "run" || (command.intent === "unknown" && commandLooksRepoWriteCapable(command)))
  ) {
    addPermissionGrant(permissions, {
      scope: "repo:read",
      reason: "inspect the repository in the paired local checkout"
    });
    addPermissionGrant(permissions, {
      scope: "repo:write",
      reason: "commit code changes on an isolated run branch"
    });
    addPermissionGrant(permissions, {
      scope: "pr:create",
      reason: "open a pull request for completed code changes"
    });
  }

  if (commandLooksLinearIssueCreateCapable(command)) {
    addPermissionGrant(permissions, {
      scope: "issue:create",
      reason: "create a Linear issue after explicit source-thread approval"
    });
  }

  for (const scope of command.parsed?.requestedScopes ?? []) {
    if (!hasRepositoryTarget && !isRepositoryFreePermissionScope(scope)) continue;
    addPermissionGrant(permissions, {
      scope,
      reason: "requested explicitly in the source-thread command"
    });
  }

  return permissions;
}

function contextPointersForCommand(command: OpenTagCommand): ContextPointer[] {
  const context: ContextPointer[] = [];

  for (const reference of command.parsed?.references ?? []) {
    if (reference.kind === "url") {
      context.push({
        kind: "url",
        uri: reference.uri,
        visibility: "organization",
        title: reference.title ?? "Command URL reference"
      });
      continue;
    }

    if (reference.kind === "file" || reference.kind === "path") {
      context.push({
        kind: "file",
        uri: reference.uri,
        ...(reference.line ? { line: reference.line } : {}),
        ...(reference.startLine ? { startLine: reference.startLine } : {}),
        ...(reference.endLine ? { endLine: reference.endLine } : {}),
        visibility: "organization",
        title: referenceTitle(reference)
      });
    }
  }

  return context;
}

function referenceTitle(reference: NonNullable<OpenTagCommand["parsed"]>["references"][number]): string {
  return reference.title ?? "Command file reference";
}

function commandMetadata(command: OpenTagCommand): Record<string, unknown> {
  if (!command.parsed) return {};
  return {
    commandParser: command.parsed.version,
    commandDiagnostics: command.parsed.diagnostics,
    ...(command.parsed.approval ? { approval: command.parsed.approval } : {}),
    ...(command.parsed.network ? { network: command.parsed.network } : {})
  };
}

export function normalizeSlackAppMention(input: SlackAppMentionInput): OpenTagEvent | null {
  const channelMessage = normalizeSlackChannelMessage(input);
  if (!channelMessage?.text) return null;
  const rawText = channelMessage.text;

  const command = commandFromRawText(rawText);
  const replyThreadTs = input.threadTs ?? input.ts;
  const agentId = input.agentId ?? "opentag";
  const repositoryMetadata = repositoryMetadataFromBinding(input.binding);
  const threadKey = encodeSlackThreadKey({
    teamId: input.teamId,
    channelId: input.channelId,
    threadTs: replyThreadTs
  });

  return {
    id: `evt_slack_app_mention_${input.eventId}`,
    source: "slack",
    sourceEventId: input.eventId,
    receivedAt: new Date(input.eventTime * 1000).toISOString(),
    actor: {
      provider: "slack",
      providerUserId: input.userId,
      handle: input.userId,
      organizationId: input.teamId
    },
    target: {
      mention: input.botUserId ? `<@${input.botUserId}>` : "<@app>",
      agentId,
      ...(command.parsed?.executorHint ? { executorHint: command.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        provider: "slack",
        kind: "message",
        uri: `slack://team/${input.teamId}/channel/${input.channelId}/message/${input.ts}`,
        visibility: "organization",
        title: "Slack message"
      },
      {
        kind: "text",
        uri: input.text,
        visibility: "organization",
        title: "Slack message text"
      },
      ...contextPointersForCommand(command)
    ],
    ...(repositoryMetadata
      ? {
          workItem: workItemFromBoundSlackThread({
            teamId: input.teamId,
            channelId: input.channelId,
            threadTs: replyThreadTs,
            threadKey,
            repository: repositoryMetadata
          })
        }
      : {}),
    permissions: permissionsForCommand(command, repositoryMetadata !== undefined),
    callback: {
      provider: "slack",
      uri: input.callbackUri ?? "https://slack.com/api/chat.postMessage",
      threadKey
    },
    metadata: {
      teamId: input.teamId,
      channelId: input.channelId,
      messageTs: input.ts,
      sourceDeliveryId: input.eventId,
      slackEventId: input.eventId,
      ...(input.appId ? { slackAppId: input.appId } : {}),
      ...(input.botUserId ? { slackBotUserId: input.botUserId } : {}),
      ...(input.appId ? { channelApplicationId: input.appId } : {}),
      ...(input.botUserId ? { channelBotId: input.botUserId } : {}),
      ...(typeof input.signatureVerified === "boolean"
        ? { webhookSignatureVerified: input.signatureVerified, signatureState: input.signatureVerified ? "verified" : "unverified" }
        : {}),
      ...commandMetadata(command),
      ...repositoryMetadata
    }
  };
}
