import { describe, expect, it, vi } from "vitest";
import {
  createGitHubCompletionApi,
  reconcileGitHubCompletionEvidence,
  type GitHubCheckState,
  type GitHubCompletionApi
} from "../src/completion-evidence.js";

const HEAD_OLD = "a".repeat(40);
const HEAD_CURRENT = "b".repeat(40);
const BASE_SHA = "c".repeat(40);

function completionApi(overrides: Partial<GitHubCompletionApi> = {}): GitHubCompletionApi {
  return {
    async getPullRequest({ pullRequestNumber }) {
      return {
        number: pullRequestNumber,
        state: "open",
        merged: false,
        head: { sha: HEAD_CURRENT },
        base: { ref: "main", sha: BASE_SHA, repo: { full_name: "acme/demo" } }
      };
    },
    async listCheckRunsForRef() {
      return {
        totalCount: 2,
        checkRuns: [
          { name: "build", status: "completed", conclusion: "success", head_sha: HEAD_CURRENT },
          { name: "test", status: "completed", conclusion: "failure", head_sha: HEAD_OLD }
        ]
      };
    },
    async getCombinedStatusForRef() {
      return {
        totalCount: 1,
        statuses: [{ context: "test", state: "success", sha: HEAD_CURRENT }]
      };
    },
    async listPullRequestsForCommit() {
      return [{ number: 7 }];
    },
    ...overrides
  };
}

describe("GitHub completion evidence", () => {
  it("reconciles a PR event against the authoritative current head", async () => {
    const api = completionApi();
    const snapshot = await reconcileGitHubCompletionEvidence({
      eventName: "pull_request",
      deliveryId: "delivery-pr-1",
      payload: {
        number: 7,
        pull_request: { number: 7, head: { sha: HEAD_OLD }, merged: true },
        repository: { name: "demo", owner: { login: "acme" } }
      },
      api,
      now: () => "2026-07-21T10:00:00.000Z"
    });

    expect(snapshot).toEqual([expect.objectContaining({
      provider: "github",
      deliveryId: "delivery-pr-1",
      repository: { owner: "acme", repo: "demo" },
      pullRequest: {
        number: 7,
        resourceRef: "github:acme/demo:pull_request:7",
        headSha: HEAD_CURRENT,
        baseSha: BASE_SHA,
        baseBranch: "main",
        state: "open"
      },
      checks: { build: "passed", test: "passed" },
      payloadDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    })]);
  });

  it("correlates status events through the commit-to-pull-request API", async () => {
    const listPullRequestsForCommit = vi.fn(async () => [{ number: 7 }]);
    await reconcileGitHubCompletionEvidence({
      eventName: "status",
      deliveryId: "delivery-status-1",
      payload: {
        sha: HEAD_CURRENT,
        repository: { name: "demo", owner: { login: "acme" } }
      },
      api: completionApi({ listPullRequestsForCommit }),
      now: () => "2026-07-21T10:00:00.000Z"
    });

    expect(listPullRequestsForCommit).toHaveBeenCalledWith({ owner: "acme", repo: "demo", ref: HEAD_CURRENT });
  });

  it("fails closed when GitHub returns a pull request for another base repository", async () => {
    await expect(reconcileGitHubCompletionEvidence({
      eventName: "check_run",
      deliveryId: "delivery-check-1",
      payload: {
        check_run: { head_sha: HEAD_CURRENT, pull_requests: [{ number: 7 }] },
        repository: { name: "demo", owner: { login: "acme" } }
      },
      api: completionApi({
        async getPullRequest({ pullRequestNumber }) {
          return {
            number: pullRequestNumber,
            state: "open",
            merged: false,
            head: { sha: HEAD_CURRENT },
            base: { ref: "main", sha: BASE_SHA, repo: { full_name: "other/demo" } }
          };
        }
      }),
      now: () => "2026-07-21T10:00:00.000Z"
    })).rejects.toThrow("mismatched target repository");
  });

  it("excludes observation time from the semantic payload digest", async () => {
    const input = {
      eventName: "pull_request" as const,
      deliveryId: "delivery-semantic-replay",
      payload: {
        number: 7,
        repository: { name: "demo", owner: { login: "acme" } }
      },
      api: completionApi()
    };
    const [earlier] = await reconcileGitHubCompletionEvidence({
      ...input,
      now: () => "2026-07-21T10:00:00.000Z"
    });
    const [later] = await reconcileGitHubCompletionEvidence({
      ...input,
      now: () => "2026-07-21T10:05:00.000Z"
    });

    expect(earlier?.observedAt).not.toBe(later?.observedAt);
    expect(earlier?.payloadDigest).toBe(later?.payloadDigest);
  });

  it("stamps observations only after authoritative API reads complete", async () => {
    let releaseEarlier!: () => void;
    let releaseLater!: () => void;
    const earlierRead = new Promise<void>((resolve) => { releaseEarlier = resolve; });
    const laterRead = new Promise<void>((resolve) => { releaseLater = resolve; });
    const clockValues = ["2026-07-21T10:00:00.000Z", "2026-07-21T10:01:00.000Z"];
    const now = vi.fn(() => clockValues.shift()!);
    const reconcile = (deliveryId: string, barrier: Promise<void>, checks: GitHubCheckState) =>
      reconcileGitHubCompletionEvidence({
        eventName: "pull_request",
        deliveryId,
        payload: {
          number: 7,
          repository: { name: "demo", owner: { login: "acme" } }
        },
        api: completionApi({
          async listCheckRunsForRef() {
            await barrier;
            return {
              totalCount: 1,
              checkRuns: [{
                name: "build",
                status: "completed",
                conclusion: checks === "passed" ? "success" : "failure",
                head_sha: HEAD_CURRENT
              }]
            };
          }
        }),
        now
      });

    const earlierStarted = reconcile("delivery-started-earlier", earlierRead, "failed");
    const laterStarted = reconcile("delivery-started-later", laterRead, "passed");
    expect(now).not.toHaveBeenCalled();
    releaseLater();
    const [laterFinished] = await laterStarted;
    releaseEarlier();
    const [earlierFinished] = await earlierStarted;

    expect(laterFinished?.observedAt).toBe("2026-07-21T10:00:00.000Z");
    expect(earlierFinished?.observedAt).toBe("2026-07-21T10:01:00.000Z");
    expect(laterFinished?.checks.build).toBe("passed");
    expect(earlierFinished?.checks.build).toBe("failed");
  });

  it("never includes the API token in reconciliation failures", async () => {
    const api = createGitHubCompletionApi({
      token: "github_secret_token",
      fetchImpl: vi.fn(async () => new Response("nope", { status: 500 }))
    });
    await expect(api.getPullRequest({ owner: "acme", repo: "demo", pullRequestNumber: 7 }))
      .rejects.not.toThrow("github_secret_token");
  });

  it("uses the combined-status response SHA for status entries", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      sha: HEAD_CURRENT,
      total_count: 2,
      statuses: [
        { context: "build", state: "success" },
        { context: "test", state: "pending" }
      ]
    }));
    const api = createGitHubCompletionApi({ token: "github_token", fetchImpl });

    await expect(api.getCombinedStatusForRef({ owner: "acme", repo: "demo", ref: HEAD_CURRENT })).resolves.toEqual({
      totalCount: 2,
      statuses: [
        { context: "build", state: "success", sha: HEAD_CURRENT },
        { context: "test", state: "pending", sha: HEAD_CURRENT }
      ]
    });
  });

  it("marks the check rollup incomplete when a GitHub result page is truncated", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes("/pulls/7")) {
        return Response.json({
          number: 7,
          state: "open",
          merged: false,
          head: { sha: HEAD_CURRENT },
          base: { ref: "main", sha: BASE_SHA, repo: { full_name: "acme/demo" } }
        });
      }
      if (path.includes("/check-runs")) {
        return Response.json({
          total_count: 2,
          check_runs: [
            { name: "build", status: "completed", conclusion: "success", head_sha: HEAD_CURRENT }
          ]
        });
      }
      if (path.includes("/status?")) {
        return Response.json({ sha: HEAD_CURRENT, total_count: 0, statuses: [] });
      }
      throw new Error(`Unexpected GitHub API request: ${path}`);
    });
    const api = createGitHubCompletionApi({ token: "github_token", fetchImpl });

    const [snapshot] = await reconcileGitHubCompletionEvidence({
      eventName: "pull_request",
      deliveryId: "delivery-truncated-checks",
      payload: {
        number: 7,
        repository: { name: "demo", owner: { login: "acme" } }
      },
      api,
      now: () => "2026-07-21T10:00:00.000Z"
    });

    expect(snapshot).toHaveProperty("checksComplete", false);
    expect(snapshot?.checks).toEqual({ build: "passed" });
  });
});
