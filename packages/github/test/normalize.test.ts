import { describe, expect, it } from "vitest";
import { githubPermissionHasWriteAccess, normalizeGitHubIssueComment, normalizeGitHubPullRequestReviewComment } from "../src/normalize.js";

describe("githubPermissionHasWriteAccess", () => {
  it("maps actual GitHub repository permissions to write access", () => {
    expect(githubPermissionHasWriteAccess("admin")).toBe(true);
    expect(githubPermissionHasWriteAccess("maintain")).toBe(true);
    expect(githubPermissionHasWriteAccess("write")).toBe(true);
    expect(githubPermissionHasWriteAccess("read")).toBe(false);
    expect(githubPermissionHasWriteAccess("triage")).toBe(false);
    expect(githubPermissionHasWriteAccess("none")).toBe(false);
    expect(githubPermissionHasWriteAccess("WRITE")).toBe(true);
  });

  it("returns undefined when the platform did not report a permission", () => {
    expect(githubPermissionHasWriteAccess(undefined)).toBeUndefined();
  });
});

describe("normalizeGitHubIssueComment", () => {
  it("carries explicit actor write access and author_association metadata", () => {
    const event = normalizeGitHubIssueComment({
      id: "321",
      commentBody: "@opentag fix this",
      commentUrl: "https://github.com/acme/demo/issues/1#issuecomment-321",
      apiCommentsUrl: "https://api.github.com/repos/acme/demo/issues/1/comments",
      issueUrl: "https://github.com/acme/demo/issues/1",
      issueNumber: 1,
      owner: "acme",
      repo: "demo",
      actorId: 42,
      actorLogin: "octocat",
      authorAssociation: "OWNER",
      actorWriteAccess: true,
      private: false,
      receivedAt: "2026-06-24T00:00:00.000Z"
    });

    expect(event?.actor).toMatchObject({ handle: "octocat", writeAccess: true });
    expect(event?.metadata).toMatchObject({ authorAssociation: "OWNER" });
  });

  it("does not derive write access from author_association alone", () => {
    const event = normalizeGitHubIssueComment({
      id: "324",
      commentBody: "@opentag fix this",
      commentUrl: "https://github.com/acme/demo/issues/1#issuecomment-324",
      apiCommentsUrl: "https://api.github.com/repos/acme/demo/issues/1/comments",
      issueUrl: "https://github.com/acme/demo/issues/1",
      issueNumber: 1,
      owner: "acme",
      repo: "demo",
      actorId: 42,
      actorLogin: "octocat",
      authorAssociation: "OWNER",
      private: false,
      receivedAt: "2026-06-24T00:00:00.000Z"
    });

    expect(event?.actor.writeAccess).toBeUndefined();
    expect(event?.metadata).toMatchObject({ authorAssociation: "OWNER" });
  });

  it("marks explicit non-write permission as writeAccess false and leaves it unset when absent", () => {
    const strangerEvent = normalizeGitHubIssueComment({
      id: "322",
      commentBody: "@opentag fix this",
      commentUrl: "https://github.com/acme/demo/issues/1#issuecomment-322",
      apiCommentsUrl: "https://api.github.com/repos/acme/demo/issues/1/comments",
      issueUrl: "https://github.com/acme/demo/issues/1",
      issueNumber: 1,
      owner: "acme",
      repo: "demo",
      actorId: 99,
      actorLogin: "mallory",
      authorAssociation: "NONE",
      actorWriteAccess: false,
      private: false,
      receivedAt: "2026-06-24T00:00:00.000Z"
    });
    expect(strangerEvent?.actor.writeAccess).toBe(false);

    const unreportedEvent = normalizeGitHubIssueComment({
      id: "323",
      commentBody: "@opentag fix this",
      commentUrl: "https://github.com/acme/demo/issues/1#issuecomment-323",
      apiCommentsUrl: "https://api.github.com/repos/acme/demo/issues/1/comments",
      issueUrl: "https://github.com/acme/demo/issues/1",
      issueNumber: 1,
      owner: "acme",
      repo: "demo",
      actorId: 42,
      actorLogin: "octocat",
      private: false,
      receivedAt: "2026-06-24T00:00:00.000Z"
    });
    expect(unreportedEvent?.actor.writeAccess).toBeUndefined();
  });

  it("normalizes an @opentag GitHub issue comment", () => {
    const event = normalizeGitHubIssueComment({
      id: "123",
      commentBody: "@opentag fix this",
      commentUrl: "https://github.com/acme/demo/issues/1#issuecomment-123",
      apiCommentsUrl: "https://api.github.com/repos/acme/demo/issues/1/comments",
      issueUrl: "https://github.com/acme/demo/issues/1",
      issueNumber: 1,
      owner: "acme",
      repo: "demo",
      actorId: 42,
      actorLogin: "octocat",
      private: false,
      receivedAt: "2026-06-24T00:00:00.000Z",
      installationId: 99
    });

    expect(event?.source).toBe("github");
    expect(event?.command.intent).toBe("fix");
    expect(event?.context[0]).toMatchObject({ provider: "github", kind: "issue" });
    expect(event?.workItem).toMatchObject({ provider: "github", kind: "issue", externalId: "acme/demo#1" });
    expect(event?.callback.threadKey).toBe("acme/demo#1");
    expect(event?.permissions.map((permission) => permission.scope)).toContain("pr:create");
    expect(event?.metadata).toMatchObject({ owner: "acme", repo: "demo", issueNumber: 1, installationId: 99 });
  });

  it("normalizes an issue comment on a pull request as a pull request work item", () => {
    const event = normalizeGitHubIssueComment({
      id: "124",
      commentBody: "@opentag fix this PR",
      commentUrl: "https://github.com/acme/demo/pull/7#issuecomment-124",
      apiCommentsUrl: "https://api.github.com/repos/acme/demo/issues/7/comments",
      issueUrl: "https://github.com/acme/demo/pull/7",
      issueNumber: 7,
      threadKind: "pull_request",
      owner: "acme",
      repo: "demo",
      actorId: 42,
      actorLogin: "octocat",
      private: true,
      receivedAt: "2026-08-08T00:00:00.000Z",
    });

    expect(event?.context[0]).toMatchObject({
      provider: "github",
      kind: "pull_request",
    });
    expect(event?.workItem).toMatchObject({
      provider: "github",
      kind: "pull_request",
      externalId: "acme/demo#7",
    });
    expect(event?.metadata).toMatchObject({
      owner: "acme",
      repo: "demo",
      pullRequestNumber: 7,
    });
    expect(event?.metadata).not.toHaveProperty("issueNumber");
  });

  it("normalizes an @opentag pull request review comment", () => {
    const event = normalizeGitHubPullRequestReviewComment({
      id: "456",
      commentBody: "@opentag review this change",
      commentUrl: "https://github.com/acme/demo/pull/2#discussion_r456",
      pullRequestUrl: "https://github.com/acme/demo/pull/2",
      apiCommentsUrl: "https://api.github.com/repos/acme/demo/issues/2/comments",
      owner: "acme",
      repo: "demo",
      pullRequestNumber: 2,
      actorId: 42,
      actorLogin: "octocat",
      private: false,
      receivedAt: "2026-06-24T00:00:00.000Z",
      installationId: 77
    });

    expect(event?.id).toBe("evt_github_pr_review_comment_456");
    expect(event?.context[0]).toMatchObject({ provider: "github", kind: "pull_request" });
    expect(event?.workItem).toMatchObject({ provider: "github", kind: "pull_request", externalId: "acme/demo#2" });
    expect(event?.callback.threadKey).toBe("acme/demo#2");
    expect(event?.permissions.map((permission) => permission.scope)).toContain("pr:update");
    expect(event?.metadata).toMatchObject({ repoProvider: "github", pullRequestNumber: 2, installationId: 77 });
  });

  it("does not grant pull request update permission for read-only review-comment intents", () => {
    const event = normalizeGitHubPullRequestReviewComment({
      id: "457",
      commentBody: "@opentag explain this change",
      commentUrl: "https://github.com/acme/demo/pull/2#discussion_r457",
      pullRequestUrl: "https://github.com/acme/demo/pull/2",
      apiCommentsUrl: "https://api.github.com/repos/acme/demo/issues/2/comments",
      owner: "acme",
      repo: "demo",
      pullRequestNumber: 2,
      actorId: 42,
      actorLogin: "octocat",
      private: false,
      receivedAt: "2026-06-24T00:00:00.000Z"
    });

    expect(event?.command.intent).toBe("explain");
    expect(event?.permissions.map((permission) => permission.scope)).not.toContain("pr:update");
  });

  it("keeps requested scopes in parsed command metadata instead of elevating them into granted permissions", () => {
    const event = normalizeGitHubIssueComment({
      id: "789",
      commentBody: "@opentag fix auth --scope repo:write --executor codex --file src/auth.ts --line 12",
      commentUrl: "https://github.com/acme/demo/issues/1#issuecomment-789",
      apiCommentsUrl: "https://api.github.com/repos/acme/demo/issues/1/comments",
      issueUrl: "https://github.com/acme/demo/issues/1",
      issueNumber: 1,
      owner: "acme",
      repo: "demo",
      actorId: 42,
      actorLogin: "octocat",
      private: false,
      receivedAt: "2026-06-24T00:00:00.000Z"
    });

    expect(event?.target.executorHint).toBe("codex");
    expect(event?.command.parsed?.requestedScopes).toEqual(["repo:write"]);
    expect(event?.permissions.filter((permission) => permission.scope === "repo:write")).toHaveLength(1);
    expect(event?.context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", uri: "src/auth.ts", line: 12 })
      ])
    );
  });
});
