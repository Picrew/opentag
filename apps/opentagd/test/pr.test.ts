import type { OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import { describe, expect, it } from "vitest";
import { maybeCreatePullRequest } from "../src/pr.js";

const run: OpenTagRun = {
  id: "run_1",
  eventId: "evt_1",
  status: "running",
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z"
};

const event: OpenTagEvent = {
  id: "evt_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix", args: {} },
  context: [],
  permissions: [
    { scope: "issue:comment", reason: "reply to source thread" },
    { scope: "pr:create", reason: "open a pull request for code changes" }
  ],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

const result: OpenTagRunResult = {
  conclusion: "success",
  summary: "Implemented the fix.",
  changedFiles: ["src/demo.ts"]
};

const slackEvent: OpenTagEvent = {
  ...event,
  id: "evt_slack_1",
  source: "slack",
  sourceEventId: "Ev123",
  actor: { provider: "slack", providerUserId: "U456", organizationId: "T123" },
  target: { mention: "<@U_APP>", agentId: "opentag" },
  permissions: [
    { scope: "chat:postMessage", reason: "reply in the originating Slack thread" },
    { scope: "runner:local", reason: "execute the run on a paired local daemon" },
    { scope: "repo:read", reason: "inspect the repository in the paired local checkout" },
    { scope: "repo:write", reason: "commit code changes on an isolated run branch" },
    { scope: "pr:create", reason: "open a pull request for completed code changes" }
  ],
  callback: {
    provider: "slack",
    uri: "https://slack.com/api/chat.postMessage",
    threadKey: "T123|C123|1710000000.000100"
  },
  metadata: {
    teamId: "T123",
    channelId: "C123",
    messageTs: "1710000000.000100",
    repoProvider: "github",
    owner: "acme",
    repo: "demo"
  }
};

describe("maybeCreatePullRequest", () => {
  it("pushes the run branch and creates a GitHub pull request when allowed", async () => {
    const commands: string[] = [];
    const requests: string[] = [];
    const updated = await maybeCreatePullRequest({
      run,
      executorCapability: { sourceControl: "daemon_managed" },
      event,
      binding: {
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        baseBranch: "main",
        pushRemote: "origin"
      },
      result,
      options: {
        githubToken: "ghs_test",
        allowAutoCreatePullRequest: true,
        commandRunner: {
          async run(command, args) {
            commands.push(`${command} ${args.join(" ")}`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        },
        fetchImpl: (async (url) => {
          requests.push(String(url));
          return Response.json({ html_url: "https://github.com/acme/demo/pull/1" });
        }) as typeof fetch
      }
    });

    expect(commands).toEqual(["git add -- src/demo.ts", "git commit -m OpenTag run run_1", "git push -u origin opentag/run_1"]);
    expect(requests).toEqual(["https://api.github.com/repos/acme/demo/pulls"]);
    expect(updated.createdPullRequestUrl).toBe("https://github.com/acme/demo/pull/1");
    expect(updated.artifacts?.at(-1)).toMatchObject({ kind: "pull_request", uri: "https://github.com/acme/demo/pull/1" });
    expect(updated.nextAction).toMatchObject({
      summary: "Review pull request: https://github.com/acme/demo/pull/1",
      hint: {
        kind: "request_review",
        metadata: { pullRequestUrl: "https://github.com/acme/demo/pull/1" }
      }
    });
  });

  it("rechecks execution authority before each pull-request materialization step", async () => {
    const commands: string[] = [];
    const requests: string[] = [];
    const authorityChecks = [true, true, false];

    await expect(maybeCreatePullRequest({
      run,
      executorCapability: { sourceControl: "daemon_managed" },
      event,
      binding: {
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        baseBranch: "main",
        pushRemote: "origin"
      },
      result,
      assertExecutionCurrent: async () => authorityChecks.shift() ?? false,
      options: {
        githubToken: "ghs_test",
        allowAutoCreatePullRequest: true,
        commandRunner: {
          async run(command, args) {
            commands.push(`${command} ${args.join(" ")}`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        },
        fetchImpl: (async (url) => {
          requests.push(String(url));
          return Response.json({ html_url: "https://github.com/acme/demo/pull/1" });
        }) as typeof fetch
      }
    })).rejects.toThrow("execution_authority_expired");

    expect(authorityChecks).toEqual([]);
    expect(commands).toEqual([
      "git add -- src/demo.ts",
      "git commit -m OpenTag run run_1",
      "git push -u origin opentag/run_1"
    ]);
    expect(requests).toEqual([]);
  });

  it("leaves the result unchanged without a GitHub token", async () => {
    await expect(
      maybeCreatePullRequest({
        run,
        executorCapability: { sourceControl: "daemon_managed" },
        event,
        binding: { provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" },
        result,
        options: {}
      })
    ).resolves.toBe(result);
  });

  it("leaves the result unchanged unless auto PR creation is explicitly enabled", async () => {
    const commands: string[] = [];
    await expect(
      maybeCreatePullRequest({
        run,
        executorCapability: { sourceControl: "daemon_managed" },
        event,
        binding: { provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" },
        result,
        options: {
          githubToken: "ghs_test",
          commandRunner: {
            async run(command, args) {
              commands.push(`${command} ${args.join(" ")}`);
              return { exitCode: 0, stdout: "", stderr: "" };
            }
          }
        }
      })
    ).resolves.toBe(result);
    expect(commands).toEqual([]);
  });

  it("can prepare a remote PR branch without creating the pull request", async () => {
    const commands: string[] = [];
    const requests: string[] = [];
    const updated = await maybeCreatePullRequest({
      run,
      executorCapability: { sourceControl: "daemon_managed" },
      event,
      binding: {
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        baseBranch: "main",
        pushRemote: "origin"
      },
      result,
      options: {
        githubToken: "ghs_test",
        preparePullRequestBranch: true,
        commandRunner: {
          async run(command, args) {
            commands.push(`${command} ${args.join(" ")}`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        },
        fetchImpl: (async (url) => {
          requests.push(String(url));
          return Response.json({ html_url: "https://github.com/acme/demo/pull/1" });
        }) as typeof fetch
      }
    });

    expect(updated).toBe(result);
    expect(commands).toEqual(["git add -- src/demo.ts", "git commit -m OpenTag run run_1", "git push -u origin opentag/run_1"]);
    expect(requests).toEqual([]);
  });

  it("can prepare a remote PR branch without a GitHub API token", async () => {
    const commands: string[] = [];
    const updated = await maybeCreatePullRequest({
      run,
      executorCapability: { sourceControl: "daemon_managed" },
      event,
      binding: {
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        baseBranch: "main",
        pushRemote: "origin"
      },
      result,
      options: {
        preparePullRequestBranch: true,
        commandRunner: {
          async run(command, args) {
            commands.push(`${command} ${args.join(" ")}`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      }
    });

    expect(updated).toBe(result);
    expect(commands).toEqual(["git add -- src/demo.ts", "git commit -m OpenTag run run_1", "git push -u origin opentag/run_1"]);
  });

  it("creates a GitHub pull request for Slack runs mapped to a GitHub repository", async () => {
    const commands: string[] = [];
    const requests: string[] = [];
    const updated = await maybeCreatePullRequest({
      run,
      executorCapability: { sourceControl: "daemon_managed" },
      event: slackEvent,
      binding: {
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        baseBranch: "main",
        pushRemote: "origin"
      },
      result,
      options: {
        githubToken: "ghs_test",
        allowAutoCreatePullRequest: true,
        commandRunner: {
          async run(command, args) {
            commands.push(`${command} ${args.join(" ")}`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        },
        fetchImpl: (async (url) => {
          requests.push(String(url));
          return Response.json({ html_url: "https://github.com/acme/demo/pull/2" });
        }) as typeof fetch
      }
    });

    expect(commands).toEqual(["git add -- src/demo.ts", "git commit -m OpenTag run run_1", "git push -u origin opentag/run_1"]);
    expect(requests).toEqual(["https://api.github.com/repos/acme/demo/pulls"]);
    expect(updated.createdPullRequestUrl).toBe("https://github.com/acme/demo/pull/2");
    expect(updated.artifacts?.at(-1)).toMatchObject({ kind: "pull_request", uri: "https://github.com/acme/demo/pull/2" });
  });

  it("does not recommit files for Codex-generated branches before opening the pull request", async () => {
    const commands: string[] = [];
    await maybeCreatePullRequest({
      run,
      executorCapability: { sourceControl: "self_committing" },
      event,
      binding: {
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        baseBranch: "main",
        pushRemote: "origin"
      },
      result,
      options: {
        githubToken: "ghs_test",
        allowAutoCreatePullRequest: true,
        commandRunner: {
          async run(command, args) {
            commands.push(`${command} ${args.join(" ")}`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        },
        fetchImpl: (async () => Response.json({ html_url: "https://github.com/acme/demo/pull/3" })) as typeof fetch
      }
    });

    expect(commands).toEqual(["git push -u origin opentag/run_1"]);
  });

  it("pushes the canonical attempt branch for a self-committing ACP result without touching the base checkout", async () => {
    const commands: string[] = [];
    const attemptBranch = "opentag/run_1-attempt_01J_TEST";
    const acpResult: OpenTagRunResult = {
      ...result,
      suggestedChanges: [
        {
          proposalId: "proposal_run_1",
          createdAt: "2026-07-12T00:00:00.000Z",
          sourceRunId: "run_1",
          summary: "ACP prepared a repository change.",
          intents: [
            {
              intentId: "proposal_run_1_create_pr",
              domain: "pull_request",
              action: "create_pull_request",
              summary: `Create a pull request for branch ${attemptBranch}.`,
              params: { head: attemptBranch, base: "main", changedFiles: ["src/demo.ts"] }
            }
          ]
        }
      ]
    };

    await maybeCreatePullRequest({
      run,
      executorCapability: { sourceControl: "self_committing" },
      event,
      binding: {
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        baseBranch: "main",
        pushRemote: "origin"
      },
      result: acpResult,
      options: {
        preparePullRequestBranch: true,
        commandRunner: {
          async run(command, args) {
            commands.push(`${command} ${args.join(" ")}`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      }
    });

    expect(commands).toEqual([`git push -u origin ${attemptBranch}`]);
  });

  it("skips push and PR creation when event metadata owner/repo does not match binding", async () => {
    const commands: string[] = [];
    const mismatchEvent: OpenTagEvent = {
      ...event,
      metadata: { owner: "other-org", repo: "other-repo" }
    };
    const updated = await maybeCreatePullRequest({
      run,
      executorCapability: { sourceControl: "daemon_managed" },
      event: mismatchEvent,
      binding: {
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        baseBranch: "main",
        pushRemote: "origin"
      },
      result,
      options: {
        githubToken: "ghs_test",
        allowAutoCreatePullRequest: true,
        commandRunner: {
          async run(command, args) {
            commands.push(`${command} ${args.join(" ")}`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        },
        fetchImpl: (async () => Response.json({})) as typeof fetch
      }
    });

    expect(commands).toEqual([]);
    expect(updated.createdPullRequestUrl).toBeUndefined();
  });
});
