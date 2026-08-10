import { parseOpenTagMention, type OpenTagEvent } from "@opentag/core";
import type { ContextPointer, OpenTagCommand, PermissionGrant, WorkItemReference } from "@opentag/core";

export type GitHubIssueCommentInput = {
  id: string;
  commentBody: string;
  commentUrl: string;
  apiCommentsUrl: string;
  issueUrl: string;
  issueNumber: number;
  threadKind?: "issue" | "pull_request";
  owner: string;
  repo: string;
  actorId: number;
  actorLogin: string;
  authorAssociation?: string;
  actorWriteAccess?: boolean;
  private: boolean;
  receivedAt: string;
  installationId?: number;
  deliveryId?: string;
  signatureVerified?: boolean;
};

export type GitHubPullRequestReviewCommentInput = {
  id: string;
  commentBody: string;
  commentUrl: string;
  pullRequestUrl: string;
  apiCommentsUrl: string;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  actorId: number;
  actorLogin: string;
  authorAssociation?: string;
  actorWriteAccess?: boolean;
  private: boolean;
  receivedAt: string;
  installationId?: number;
  deliveryId?: string;
  signatureVerified?: boolean;
};

const GITHUB_WRITE_PERMISSION_LEVELS = new Set(["admin", "maintain", "write"]);

export function githubPermissionHasWriteAccess(permission: string | undefined): boolean | undefined {
  if (!permission) return undefined;
  return GITHUB_WRITE_PERMISSION_LEVELS.has(permission.toLowerCase());
}

function permissionsForIntent(intent: OpenTagCommand["intent"]): PermissionGrant[] {
  const permissions: PermissionGrant[] = [
    {
      scope: "issue:comment",
      reason: "reply to the source GitHub thread"
    },
    {
      scope: "runner:local",
      reason: "execute the run on a paired local daemon"
    }
  ];
  if (intent === "fix" || intent === "run") {
    permissions.push(
      {
        scope: "repo:read",
        reason: "inspect the repository in the paired local checkout"
      },
      {
        scope: "repo:write",
        reason: "commit code changes on an isolated run branch"
      },
      {
        scope: "pr:create",
        reason: "open a pull request for completed code changes"
      }
    );
  }
  return permissions;
}

function permissionsForPullRequestIntent(intent: OpenTagCommand["intent"]): PermissionGrant[] {
  const permissions = permissionsForIntent(intent).filter((permission) => permission.scope !== "pr:create");
  if (intent === "review") {
    permissions.push({
      scope: "pr:update",
      reason: "request reviewers on the source pull request after explicit approval"
    });
  }
  return permissions;
}

function contextPointersForCommand(command: OpenTagCommand, privateRepo: boolean): ContextPointer[] {
  const visibility = privateRepo ? "private" : "public";
  const context: ContextPointer[] = [];

  for (const reference of command.parsed?.references ?? []) {
    if (reference.kind === "url") {
      context.push({
        kind: "url",
        uri: reference.uri,
        visibility,
        title: reference.title ?? "Command URL reference"
      });
      continue;
    }

    if (reference.kind === "file" || reference.kind === "path" || reference.kind === "line" || reference.kind === "range") {
      context.push({
        kind: "file",
        uri: reference.uri,
        ...(reference.line ? { line: reference.line } : {}),
        ...(reference.startLine ? { startLine: reference.startLine } : {}),
        ...(reference.endLine ? { endLine: reference.endLine } : {}),
        visibility,
        title: referenceTitle(reference)
      });
    }
  }

  return context;
}

function referenceTitle(reference: NonNullable<OpenTagCommand["parsed"]>["references"][number]): string {
  return reference.title ?? "Command file reference";
}

function githubWorkItem(input: {
  owner: string;
  repo: string;
  kind: "issue" | "pull_request";
  number: number;
  uri: string;
}): WorkItemReference {
  return {
    provider: "github",
    kind: input.kind,
    externalId: `${input.owner}/${input.repo}#${input.number}`,
    uri: input.uri,
    ownerContainer: {
      provider: "github",
      id: `${input.owner}/${input.repo}`,
      uri: `https://github.com/${input.owner}/${input.repo}`
    }
  };
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

export function normalizeGitHubIssueComment(input: GitHubIssueCommentInput): OpenTagEvent | null {
  const mention = parseOpenTagMention(input.commentBody);
  if (!mention.matched) return null;
  const threadKind = input.threadKind ?? "issue";

  const command = {
    rawText: mention.rawText,
    intent: mention.intent,
    args: mention.args,
    ...(mention.parsed ? { parsed: mention.parsed } : {})
  };

  return {
    id: `evt_github_comment_${input.id}`,
    source: "github",
    sourceEventId: input.id,
    receivedAt: input.receivedAt,
    actor: {
      provider: "github",
      providerUserId: String(input.actorId),
      handle: input.actorLogin,
      ...(input.actorWriteAccess !== undefined ? { writeAccess: input.actorWriteAccess } : {})
    },
    target: {
      mention: "@opentag",
      agentId: "opentag",
      ...(mention.parsed?.executorHint ? { executorHint: mention.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        provider: "github",
        kind: threadKind,
        uri: input.issueUrl,
        visibility: input.private ? "private" : "public"
      },
      {
        provider: "github",
        kind: "comment",
        uri: input.commentUrl,
        visibility: input.private ? "private" : "public"
      },
      ...contextPointersForCommand(command, input.private)
    ],
    workItem: githubWorkItem({
      owner: input.owner,
      repo: input.repo,
      kind: threadKind,
      number: input.issueNumber,
      uri: input.issueUrl
    }),
    permissions: threadKind === "issue"
      ? permissionsForIntent(mention.intent)
      : permissionsForPullRequestIntent(mention.intent),
    callback: {
      provider: "github",
      uri: input.apiCommentsUrl,
      threadKey: `${input.owner}/${input.repo}#${input.issueNumber}`
    },
    metadata: {
      repoProvider: "github",
      owner: input.owner,
      repo: input.repo,
      ...(threadKind === "pull_request"
        ? { pullRequestNumber: input.issueNumber }
        : { issueNumber: input.issueNumber }),
      ...(input.authorAssociation ? { authorAssociation: input.authorAssociation } : {}),
      ...commandMetadata(command),
      ...(input.deliveryId ? { sourceDeliveryId: input.deliveryId, webhookDeliveryId: input.deliveryId } : {}),
      ...(typeof input.signatureVerified === "boolean"
        ? { webhookSignatureVerified: input.signatureVerified, signatureState: input.signatureVerified ? "verified" : "unverified" }
        : {}),
      ...(typeof input.installationId === "number" ? { installationId: input.installationId } : {})
    }
  };
}

export function normalizeGitHubPullRequestReviewComment(input: GitHubPullRequestReviewCommentInput): OpenTagEvent | null {
  const mention = parseOpenTagMention(input.commentBody);
  if (!mention.matched) return null;

  const command = {
    rawText: mention.rawText,
    intent: mention.intent,
    args: mention.args,
    ...(mention.parsed ? { parsed: mention.parsed } : {})
  };

  return {
    id: `evt_github_pr_review_comment_${input.id}`,
    source: "github",
    sourceEventId: input.id,
    receivedAt: input.receivedAt,
    actor: {
      provider: "github",
      providerUserId: String(input.actorId),
      handle: input.actorLogin,
      ...(input.actorWriteAccess !== undefined ? { writeAccess: input.actorWriteAccess } : {})
    },
    target: {
      mention: "@opentag",
      agentId: "opentag",
      ...(mention.parsed?.executorHint ? { executorHint: mention.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        provider: "github",
        kind: "pull_request",
        uri: input.pullRequestUrl,
        visibility: input.private ? "private" : "public"
      },
      {
        provider: "github",
        kind: "comment",
        uri: input.commentUrl,
        visibility: input.private ? "private" : "public"
      },
      ...contextPointersForCommand(command, input.private)
    ],
    workItem: githubWorkItem({
      owner: input.owner,
      repo: input.repo,
      kind: "pull_request",
      number: input.pullRequestNumber,
      uri: input.pullRequestUrl
    }),
    permissions: permissionsForPullRequestIntent(mention.intent),
    callback: {
      provider: "github",
      uri: input.apiCommentsUrl,
      threadKey: `${input.owner}/${input.repo}#${input.pullRequestNumber}`
    },
    metadata: {
      repoProvider: "github",
      owner: input.owner,
      repo: input.repo,
      pullRequestNumber: input.pullRequestNumber,
      ...(input.authorAssociation ? { authorAssociation: input.authorAssociation } : {}),
      ...commandMetadata(command),
      ...(input.deliveryId ? { sourceDeliveryId: input.deliveryId, webhookDeliveryId: input.deliveryId } : {}),
      ...(typeof input.signatureVerified === "boolean"
        ? { webhookSignatureVerified: input.signatureVerified, signatureState: input.signatureVerified ? "verified" : "unverified" }
        : {}),
      ...(typeof input.installationId === "number" ? { installationId: input.installationId } : {})
    }
  };
}
