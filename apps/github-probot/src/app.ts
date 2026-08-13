import { randomUUID } from "node:crypto";
import { createOpenTagClient, type ThreadActionInput } from "@opentag/client";
import { parseThreadActionCommand, type OpenTagEvent } from "@opentag/core";
import {
  githubPermissionHasWriteAccess,
  normalizeGitHubIssueComment,
  normalizeGitHubPullRequestReviewComment,
  type GitHubActorWriteAccessResolver
} from "@opentag/github";
import type { Probot } from "probot";

type IssueCommentPayload = {
  comment: { id: number; body: string; html_url: string; author_association?: string };
  issue: { html_url: string; comments_url: string; number: number };
  repository: { name: string; private: boolean; owner: { login: string } };
  sender: { id: number; login: string };
  installation?: { id: number };
};

type PullRequestReviewCommentPayload = {
  comment: { id: number; body: string; html_url: string; author_association?: string };
  pull_request: { html_url: string; number: number };
  repository: { name: string; private: boolean; owner: { login: string } };
  sender: { id: number; login: string };
  installation?: { id: number };
};

async function resolvePayloadActorWriteAccess(input: {
  payload: { repository: { name: string; owner: { login: string } }; sender: { login: string } };
  resolveActorWriteAccess?: GitHubActorWriteAccessResolver;
}): Promise<boolean | undefined> {
  if (!input.resolveActorWriteAccess) return undefined;
  try {
    return await input.resolveActorWriteAccess({
      owner: input.payload.repository.owner.login,
      repo: input.payload.repository.name,
      username: input.payload.sender.login
    });
  } catch {
    return undefined;
  }
}

export async function handleIssueCommentCreated(input: {
  payload: IssueCommentPayload;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: ThreadActionInput): Promise<unknown>;
  resolveActorWriteAccess?: GitHubActorWriteAccessResolver;
  now(): string;
}): Promise<void> {
  const owner = input.payload.repository.owner.login;
  const repo = input.payload.repository.name;
  if (parseThreadActionCommand(input.payload.comment.body) && input.submitThreadAction) {
    const actorWriteAccess = await resolvePayloadActorWriteAccess(input);
    await input.submitThreadAction({
      id: `approval_github_comment_${input.payload.comment.id}`,
      rawText: input.payload.comment.body,
      actor: {
        provider: "github",
        providerUserId: String(input.payload.sender.id),
        handle: input.payload.sender.login,
        ...(actorWriteAccess !== undefined ? { writeAccess: actorWriteAccess } : {})
      },
      callback: {
        provider: "github",
        uri: input.payload.issue.comments_url,
        threadKey: `${owner}/${repo}#${input.payload.issue.number}`
      },
      metadata: {
        repoProvider: "github",
        owner,
        repo,
        issueNumber: input.payload.issue.number,
        commentUrl: input.payload.comment.html_url
      }
    });
    return;
  }

  const event = normalizeGitHubIssueComment({
    id: String(input.payload.comment.id),
    commentBody: input.payload.comment.body,
    commentUrl: input.payload.comment.html_url,
    apiCommentsUrl: input.payload.issue.comments_url,
    issueUrl: input.payload.issue.html_url,
    issueNumber: input.payload.issue.number,
    owner,
    repo,
    actorId: input.payload.sender.id,
    actorLogin: input.payload.sender.login,
    ...(input.payload.comment.author_association ? { authorAssociation: input.payload.comment.author_association } : {}),
    private: input.payload.repository.private,
    receivedAt: input.now(),
    ...(input.payload.installation ? { installationId: input.payload.installation.id } : {})
  });

  if (!event) return;
  const actorWriteAccess = await resolvePayloadActorWriteAccess(input);
  if (actorWriteAccess !== undefined) {
    event.actor.writeAccess = actorWriteAccess;
  }

  await input.createRun(event);
}

export async function handlePullRequestReviewCommentCreated(input: {
  payload: PullRequestReviewCommentPayload;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: ThreadActionInput): Promise<unknown>;
  resolveActorWriteAccess?: GitHubActorWriteAccessResolver;
  now(): string;
}): Promise<void> {
  const owner = input.payload.repository.owner.login;
  const repo = input.payload.repository.name;
  if (parseThreadActionCommand(input.payload.comment.body) && input.submitThreadAction) {
    const actorWriteAccess = await resolvePayloadActorWriteAccess(input);
    await input.submitThreadAction({
      id: `approval_github_pr_review_comment_${input.payload.comment.id}`,
      rawText: input.payload.comment.body,
      actor: {
        provider: "github",
        providerUserId: String(input.payload.sender.id),
        handle: input.payload.sender.login,
        ...(actorWriteAccess !== undefined ? { writeAccess: actorWriteAccess } : {})
      },
      callback: {
        provider: "github",
        uri: `https://api.github.com/repos/${owner}/${repo}/issues/${input.payload.pull_request.number}/comments`,
        threadKey: `${owner}/${repo}#${input.payload.pull_request.number}`
      },
      metadata: {
        repoProvider: "github",
        owner,
        repo,
        pullRequestNumber: input.payload.pull_request.number,
        commentUrl: input.payload.comment.html_url
      }
    });
    return;
  }

  const event = normalizeGitHubPullRequestReviewComment({
    id: String(input.payload.comment.id),
    commentBody: input.payload.comment.body,
    commentUrl: input.payload.comment.html_url,
    pullRequestUrl: input.payload.pull_request.html_url,
    apiCommentsUrl: `https://api.github.com/repos/${owner}/${repo}/issues/${input.payload.pull_request.number}/comments`,
    owner,
    repo,
    pullRequestNumber: input.payload.pull_request.number,
    actorId: input.payload.sender.id,
    actorLogin: input.payload.sender.login,
    ...(input.payload.comment.author_association ? { authorAssociation: input.payload.comment.author_association } : {}),
    private: input.payload.repository.private,
    receivedAt: input.now(),
    ...(input.payload.installation ? { installationId: input.payload.installation.id } : {})
  });

  if (!event) return;
  const actorWriteAccess = await resolvePayloadActorWriteAccess(input);
  if (actorWriteAccess !== undefined) {
    event.actor.writeAccess = actorWriteAccess;
  }

  await input.createRun(event);
}

export function newRunId(): string {
  // Use a unique id like every other ingress (slack/lark/github) already does.
  // createRun only guards on eventId, not on the run's primary key, so a
  // Date.now()-based id would collide for two distinct same-millisecond events
  // and surface as a SQLITE_CONSTRAINT error (500 + dropped event).
  return `run_${randomUUID()}`;
}

async function createDispatcherRun(input: { event: OpenTagEvent; log: { warn(data: unknown, message: string): void } }): Promise<{ runId?: string }> {
  const dispatcherUrl = process.env.OPENTAG_DISPATCHER_URL;
  const runId = newRunId();
  if (!dispatcherUrl) {
    input.log.warn({ runId, event: input.event }, "OPENTAG_DISPATCHER_URL is not set; run was not dispatched");
    return {};
  }

  const client = createOpenTagClient({
    dispatcherUrl,
    ...(process.env.OPENTAG_DISPATCHER_TOKEN ? { pairingToken: process.env.OPENTAG_DISPATCHER_TOKEN } : {})
  });
  const created = await client.createRun({
    runId,
    event: input.event
  });
  return created.outcome === "run_created" ? { runId: created.run.id } : {};
}

async function submitDispatcherThreadAction(input: { action: ThreadActionInput; log: { warn(data: unknown, message: string): void } }): Promise<void> {
  const dispatcherUrl = process.env.OPENTAG_DISPATCHER_URL;
  if (!dispatcherUrl) {
    input.log.warn({ action: input.action }, "OPENTAG_DISPATCHER_URL is not set; thread action was not dispatched");
    return;
  }

  const client = createOpenTagClient({
    dispatcherUrl,
    ...(process.env.OPENTAG_DISPATCHER_TOKEN ? { pairingToken: process.env.OPENTAG_DISPATCHER_TOKEN } : {})
  });
  await client.submitThreadAction(input.action);
}

export function createOpenTagProbotApp(app: Probot): void {
  app.on("issue_comment.created", async (context) => {
    await handleIssueCommentCreated({
      payload: context.payload as IssueCommentPayload,
      createRun: async (event) => createDispatcherRun({ event, log: context.log }),
      submitThreadAction: async (action) => submitDispatcherThreadAction({ action, log: context.log }),
      resolveActorWriteAccess: async ({ owner, repo, username }) => {
        try {
          const response = await context.octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
          return githubPermissionHasWriteAccess(response.data.permission);
        } catch (error) {
          context.log.warn({ error, owner, repo, username }, "Could not resolve GitHub actor repository permission; failing closed for write access");
          return undefined;
        }
      },
      now: () => new Date().toISOString()
    });
  });

  app.on("pull_request_review_comment.created", async (context) => {
    const payload = context.payload as PullRequestReviewCommentPayload;
    await handlePullRequestReviewCommentCreated({
      payload,
      createRun: async (event) => createDispatcherRun({ event, log: context.log }),
      submitThreadAction: async (action) => submitDispatcherThreadAction({ action, log: context.log }),
      resolveActorWriteAccess: async ({ owner, repo, username }) => {
        try {
          const response = await context.octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
          return githubPermissionHasWriteAccess(response.data.permission);
        } catch (error) {
          context.log.warn({ error, owner, repo, username }, "Could not resolve GitHub actor repository permission; failing closed for write access");
          return undefined;
        }
      },
      now: () => new Date().toISOString()
    });
  });
}
