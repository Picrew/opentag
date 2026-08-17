import { createServer, type Server } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { computeGitHubSignature, createGitHubWebhookApp, startGitHubIngress } from "../src/ingress.js";
import type { GitHubCompletionApi } from "../src/completion-evidence.js";

const COMPLETION_HEAD = "b".repeat(40);
const COMPLETION_BASE = "c".repeat(40);

function completionApi(): GitHubCompletionApi {
  return {
    async getPullRequest({ pullRequestNumber }) {
      return {
        number: pullRequestNumber,
        state: "closed",
        merged: true,
        head: { sha: COMPLETION_HEAD },
        base: { ref: "main", sha: COMPLETION_BASE, repo: { full_name: "acme/demo" } }
      };
    },
    async listCheckRunsForRef() {
      return {
        totalCount: 1,
        checkRuns: [{ name: "build", status: "completed", conclusion: "success", head_sha: COMPLETION_HEAD }]
      };
    },
    async getCombinedStatusForRef() {
      return {
        totalCount: 1,
        statuses: [{ context: "test", state: "success", sha: COMPLETION_HEAD }]
      };
    },
    async listPullRequestsForCommit() {
      return [{ number: 7 }];
    }
  };
}

async function listenOnRandomPort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate a test port.");
  }
  return { server, port: address.port };
}

async function waitUntilListening(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });
}

function signedRequest(input: { body: string; secret: string; event: string; deliveryId?: string }): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": input.event,
      "x-hub-signature-256": computeGitHubSignature({ webhookSecret: input.secret, rawBody: input.body }),
      ...(input.deliveryId ? { "x-github-delivery": input.deliveryId } : {})
    },
    body: input.body
  };
}

describe("GitHub webhook ingress", () => {
  it("submits a multi-PR completion delivery as one snapshot-set ingestion", async () => {
    const api = completionApi();
    api.listPullRequestsForCommit = async () => [{ number: 8 }, { number: 7 }];
    const ingestCompletionEvidenceBatch = vi.fn(async () => ({ outcome: "recorded" }));
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun: vi.fn(async () => ({})),
      completionApi: api,
      ingestCompletionEvidenceBatch,
      requestCompletionReconciliationEscalation: vi.fn(async () => undefined),
      now: () => "2026-07-21T10:00:00.000Z"
    });
    const body = JSON.stringify({
      sha: COMPLETION_HEAD,
      repository: { name: "demo", owner: { login: "acme" } }
    });

    const response = await app.request(
      "/github/webhooks",
      signedRequest({ body, secret: "secret", event: "status", deliveryId: "delivery-multi-pr" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, evidenceSnapshots: 2 });
    expect(ingestCompletionEvidenceBatch).toHaveBeenCalledTimes(1);
    expect(ingestCompletionEvidenceBatch).toHaveBeenCalledWith([
      expect.objectContaining({ deliveryId: "delivery-multi-pr", pullRequest: expect.objectContaining({ number: 7 }) }),
      expect.objectContaining({ deliveryId: "delivery-multi-pr", pullRequest: expect.objectContaining({ number: 8 }) })
    ]);
  });

  it("ignores a status delivery that has no correlated pull request", async () => {
    const api = completionApi();
    api.listPullRequestsForCommit = async () => [];
    const ingestCompletionEvidenceBatch = vi.fn(async () => ({ outcome: "recorded" }));
    const requestCompletionReconciliationEscalation = vi.fn(async () => undefined);
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun: vi.fn(async () => ({})),
      completionApi: api,
      ingestCompletionEvidenceBatch,
      requestCompletionReconciliationEscalation,
      now: () => "2026-07-21T10:00:00.000Z"
    });
    const body = JSON.stringify({
      sha: COMPLETION_HEAD,
      repository: { name: "demo", owner: { login: "acme" } }
    });

    const response = await app.request(
      "/github/webhooks",
      signedRequest({ body, secret: "secret", event: "status", deliveryId: "delivery-no-pull-request" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      evidenceSnapshots: 0,
      ignored: "no_correlated_pull_requests"
    });
    expect(ingestCompletionEvidenceBatch).not.toHaveBeenCalled();
    expect(requestCompletionReconciliationEscalation).not.toHaveBeenCalled();
  });

  it("fails a multi-PR delivery before any single-snapshot fallback write when batch ingestion is unavailable", async () => {
    const api = completionApi();
    api.listPullRequestsForCommit = async () => [{ number: 7 }, { number: 8 }];
    const ingestCompletionEvidence = vi.fn(async () => ({ outcome: "recorded" }));
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun: vi.fn(async () => ({})),
      completionApi: api,
      ingestCompletionEvidence,
      now: () => "2026-07-21T10:00:00.000Z"
    });
    const body = JSON.stringify({
      sha: COMPLETION_HEAD,
      repository: { name: "demo", owner: { login: "acme" } }
    });

    const response = await app.request(
      "/github/webhooks",
      signedRequest({ body, secret: "secret", event: "status", deliveryId: "delivery-no-batch" })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "completion_snapshot_batch_ingestion_required",
      retryable: true
    });
    expect(ingestCompletionEvidence).not.toHaveBeenCalled();
  });

  it("durably ingests reconciled completion evidence without creating a run", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_should_not_exist" }));
    const ingestCompletionEvidence = vi.fn(async () => ({ outcome: "recorded" }));
    const requestCompletionReconciliationEscalation = vi.fn(async () => undefined);
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun,
      completionApi: completionApi(),
      ingestCompletionEvidence,
      requestCompletionReconciliationEscalation,
      now: () => "2026-07-21T10:00:00.000Z"
    });
    const body = JSON.stringify({
      action: "closed",
      number: 7,
      pull_request: { number: 7 },
      repository: { name: "demo", owner: { login: "acme" } }
    });

    const response = await app.request(
      "/github/webhooks",
      signedRequest({ body, secret: "secret", event: "pull_request", deliveryId: "delivery-completion-1" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, evidenceSnapshots: 1 });
    expect(createRun).not.toHaveBeenCalled();
    expect(ingestCompletionEvidence).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "delivery-completion-1",
      pullRequest: { headSha: COMPLETION_HEAD, state: "merged", number: 7, resourceRef: "github:acme/demo:pull_request:7", baseSha: COMPLETION_BASE, baseBranch: "main" }
    }));
    expect(requestCompletionReconciliationEscalation).toHaveBeenCalledWith({
      operation: "resolve",
      escalation: {
        class: "reconciliation",
        audience: "repo_owner",
        subjectRef: "github:acme/demo:pull_request:7",
        state: "resolved",
        blocking: true,
        summary: "GitHub completion evidence reconciliation recovered.",
        reason: "Authoritative GitHub completion evidence was reconciled and ingested successfully.",
        dedupeKey: "github:completion-reconciliation:github:acme/demo:pull_request:7"
      },
      correlation: {
        provider: "github",
        deliveryId: "delivery-completion-1",
        eventName: "pull_request",
        repository: { owner: "acme", repo: "demo" },
        pullRequestNumbers: [7]
      }
    });
  });

  it("requests one typed idempotent reconciliation escalation when GitHub reconciliation fails", async () => {
    const requestCompletionReconciliationEscalation = vi.fn(async () => undefined);
    const failingApi = completionApi();
    failingApi.getPullRequest = vi.fn(async () => {
      throw new Error("GitHub API unavailable");
    });
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun: vi.fn(async () => ({})),
      completionApi: failingApi,
      ingestCompletionEvidence: vi.fn(async () => ({ outcome: "recorded" })),
      requestCompletionReconciliationEscalation,
      now: () => "2026-07-21T10:00:00.000Z"
    });
    const body = JSON.stringify({
      action: "synchronize",
      number: 7,
      repository: { name: "demo", owner: { login: "acme" } }
    });

    for (const deliveryId of ["delivery-failure-1", "delivery-failure-retry"]) {
      const response = await app.request(
        "/github/webhooks",
        signedRequest({ body, secret: "secret", event: "pull_request", deliveryId })
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "completion_reconciliation_failed" });
    }

    expect(requestCompletionReconciliationEscalation).toHaveBeenCalledTimes(2);
    expect(requestCompletionReconciliationEscalation.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        operation: "open",
        escalation: expect.objectContaining({
          class: "reconciliation",
          state: "open",
          subjectRef: "github:acme/demo:pull_request:7",
          dedupeKey: "github:completion-reconciliation:github:acme/demo:pull_request:7"
        }),
        correlation: expect.objectContaining({ deliveryId: "delivery-failure-1" })
      }),
      expect.objectContaining({
        operation: "open",
        escalation: expect.objectContaining({
          dedupeKey: "github:completion-reconciliation:github:acme/demo:pull_request:7"
        }),
        correlation: expect.objectContaining({ deliveryId: "delivery-failure-retry" })
      })
    ]);
  });

  it("resolves a head-correlated status escalation using pull requests returned by GitHub", async () => {
    const requestCompletionReconciliationEscalation = vi.fn(async () => undefined);
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun: vi.fn(async () => ({})),
      completionApi: completionApi(),
      ingestCompletionEvidence: vi.fn(async () => ({ outcome: "recorded" })),
      requestCompletionReconciliationEscalation,
      now: () => "2026-07-21T10:00:00.000Z"
    });
    const body = JSON.stringify({
      sha: COMPLETION_HEAD,
      repository: { name: "demo", owner: { login: "acme" } }
    });

    const response = await app.request(
      "/github/webhooks",
      signedRequest({ body, secret: "secret", event: "status", deliveryId: "delivery-head-success" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, evidenceSnapshots: 1 });
    expect(requestCompletionReconciliationEscalation).toHaveBeenCalledWith(expect.objectContaining({
      operation: "resolve",
      escalation: expect.objectContaining({
        subjectRef: `github:acme/demo:commit:${COMPLETION_HEAD}`,
        dedupeKey: `github:completion-reconciliation:github:acme/demo:commit:${COMPLETION_HEAD}`
      }),
      correlation: {
        provider: "github",
        deliveryId: "delivery-head-success",
        eventName: "status",
        repository: { owner: "acme", repo: "demo" },
        pullRequestNumbers: [7],
        headSha: COMPLETION_HEAD
      }
    }));
  });

  it("opens a stable head-correlated escalation when commit-to-PR reconciliation fails", async () => {
    const requestCompletionReconciliationEscalation = vi.fn(async () => undefined);
    const api = completionApi();
    api.listPullRequestsForCommit = vi.fn(async () => {
      throw new Error("GitHub commit correlation unavailable");
    });
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun: vi.fn(async () => ({})),
      completionApi: api,
      ingestCompletionEvidence: vi.fn(async () => ({ outcome: "recorded" })),
      requestCompletionReconciliationEscalation,
      now: () => "2026-07-21T10:00:00.000Z"
    });
    const body = JSON.stringify({
      sha: COMPLETION_HEAD,
      repository: { name: "demo", owner: { login: "acme" } }
    });

    for (const deliveryId of ["delivery-head-failure", "delivery-head-failure-retry"]) {
      const response = await app.request(
        "/github/webhooks",
        signedRequest({ body, secret: "secret", event: "status", deliveryId })
      );
      expect(response.status).toBe(503);
    }

    expect(requestCompletionReconciliationEscalation).toHaveBeenCalledTimes(2);
    const requests = requestCompletionReconciliationEscalation.mock.calls.map(([request]) => request);
    expect(requests.map((request) => request.escalation.dedupeKey)).toEqual([
      `github:completion-reconciliation:github:acme/demo:commit:${COMPLETION_HEAD}`,
      `github:completion-reconciliation:github:acme/demo:commit:${COMPLETION_HEAD}`
    ]);
    expect(requests[0]?.correlation).toMatchObject({
      pullRequestNumbers: [],
      headSha: COMPLETION_HEAD
    });
  });

  it("preserves compatibility by ignoring completion events when reconciliation is unconfigured", async () => {
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun: vi.fn(async () => ({})),
      now: () => "2026-07-21T10:00:00.000Z"
    });
    const body = JSON.stringify({
      action: "synchronize",
      number: 7,
      repository: { name: "demo", owner: { login: "acme" } }
    });
    const response = await app.request(
      "/github/webhooks",
      signedRequest({ body, secret: "secret", event: "pull_request", deliveryId: "delivery-no-api" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, ignored: "completion_reconciliation_unconfigured" });
  });

  it("returns a retryable failure for an incomplete completion ingestion configuration", async () => {
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun: vi.fn(async () => ({})),
      completionApi: completionApi(),
      now: () => "2026-07-21T10:00:00.000Z"
    });
    const body = JSON.stringify({
      action: "synchronize",
      number: 7,
      repository: { name: "demo", owner: { login: "acme" } }
    });
    const response = await app.request(
      "/github/webhooks",
      signedRequest({ body, secret: "secret", event: "pull_request", deliveryId: "delivery-incomplete" })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "completion_reconciliation_unavailable" });
  });

  it("binds the local server to loopback by default", async () => {
    const { server, port } = await listenOnRandomPort();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    const handle = startGitHubIngress({
      webhookSecret: "secret",
      dispatcherUrl: "http://localhost:3030",
      port
    });
    try {
      await waitUntilListening(handle.server);
      expect(handle.url).toBe(`http://127.0.0.1:${port}`);
    } finally {
      await handle.close();
    }
  });

  it("creates a run for a signed issue comment mention", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun,
      now: () => "2026-06-27T00:00:00.000Z"
    });
    const body = JSON.stringify({
      action: "created",
      comment: {
        id: 123,
        body: "@opentag investigate this",
        html_url: "https://github.com/acme/demo/issues/1#issuecomment-123"
      },
      issue: {
        html_url: "https://github.com/acme/demo/issues/1",
        comments_url: "https://api.github.com/repos/acme/demo/issues/1/comments",
        number: 1
      },
      repository: { name: "demo", private: false, owner: { login: "acme" } },
      sender: { id: 42, login: "octocat" }
    });

    const response = await app.request(
      "/github/webhooks",
      signedRequest({ body, secret: "secret", event: "issue_comment", deliveryId: "delivery_123" })
    );

    expect(response.status).toBe(200);
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(createRun.mock.calls[0]![0]).toMatchObject({
      source: "github",
      metadata: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        issueNumber: 1,
        sourceDeliveryId: "delivery_123",
        webhookDeliveryId: "delivery_123",
        webhookSignatureVerified: true,
        signatureState: "verified"
      },
      callback: { provider: "github" }
    });
  });

  it("keeps author_association metadata without inferring actor write access", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_assoc" }));
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun,
      now: () => "2026-06-27T00:00:00.000Z"
    });
    const body = JSON.stringify({
      action: "created",
      comment: {
        id: 125,
        body: "@opentag investigate this",
        html_url: "https://github.com/acme/demo/issues/1#issuecomment-125",
        author_association: "COLLABORATOR"
      },
      issue: {
        html_url: "https://github.com/acme/demo/issues/1",
        comments_url: "https://api.github.com/repos/acme/demo/issues/1/comments",
        number: 1
      },
      repository: { name: "demo", private: false, owner: { login: "acme" } },
      sender: { id: 42, login: "octocat" }
    });

    const response = await app.request(
      "/github/webhooks",
      signedRequest({ body, secret: "secret", event: "issue_comment", deliveryId: "delivery_125" })
    );

    expect(response.status).toBe(200);
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(createRun.mock.calls[0]![0]).toMatchObject({
      actor: { provider: "github", handle: "octocat" },
      metadata: { authorAssociation: "COLLABORATOR" }
    });
    expect(createRun.mock.calls[0]![0].actor.writeAccess).toBeUndefined();
  });

  it("uses resolved repository permission as actor write access when provided", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_permission" }));
    const resolveActorWriteAccess = vi.fn(async () => true);
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun,
      resolveActorWriteAccess,
      now: () => "2026-06-27T00:00:00.000Z"
    });
    const body = JSON.stringify({
      action: "created",
      comment: {
        id: 126,
        body: "@opentag investigate this",
        html_url: "https://github.com/acme/demo/issues/1#issuecomment-126",
        author_association: "COLLABORATOR"
      },
      issue: {
        html_url: "https://github.com/acme/demo/issues/1",
        comments_url: "https://api.github.com/repos/acme/demo/issues/1/comments",
        number: 1
      },
      repository: { name: "demo", private: false, owner: { login: "acme" } },
      sender: { id: 42, login: "octocat" }
    });

    const response = await app.request(
      "/github/webhooks",
      signedRequest({ body, secret: "secret", event: "issue_comment", deliveryId: "delivery_126" })
    );

    expect(response.status).toBe(200);
    expect(resolveActorWriteAccess).toHaveBeenCalledWith({ owner: "acme", repo: "demo", username: "octocat" });
    expect(createRun.mock.calls[0]![0]).toMatchObject({
      actor: { provider: "github", handle: "octocat", writeAccess: true },
      metadata: { authorAssociation: "COLLABORATOR" }
    });
  });

  it("routes mentioned source-thread control commands without creating a run", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({ outcome: "status" }));
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun,
      submitThreadAction,
      now: () => "2026-06-27T00:00:00.000Z"
    });
    const body = JSON.stringify({
      action: "created",
      comment: {
        id: 124,
        body: "@opentag /status",
        html_url: "https://github.com/acme/demo/issues/1#issuecomment-124"
      },
      issue: {
        html_url: "https://github.com/acme/demo/issues/1",
        comments_url: "https://api.github.com/repos/acme/demo/issues/1/comments",
        number: 1
      },
      repository: { name: "demo", private: false, owner: { login: "acme" } },
      sender: { id: 42, login: "octocat" }
    });

    const response = await app.request(
      "/github/webhooks",
      signedRequest({ body, secret: "secret", event: "issue_comment", deliveryId: "delivery_124" })
    );

    expect(response.status).toBe(200);
    expect(createRun).not.toHaveBeenCalled();
    expect(submitThreadAction).toHaveBeenCalledOnce();
    expect(submitThreadAction.mock.calls[0]![0]).toMatchObject({
      id: "control_github_comment_124",
      rawText: "@opentag /status",
      callback: {
        provider: "github",
        threadKey: "acme/demo#1"
      },
      metadata: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        issueNumber: 1
      }
    });
  });

  it("rejects invalid signatures", async () => {
    const recordControlPlaneEvent = vi.fn(async () => {});
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun: vi.fn(async () => ({ runId: "run_1" })),
      recordControlPlaneEvent,
      now: () => "2026-06-27T00:00:00.000Z"
    });

    const response = await app.request("/github/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=bad",
        "x-github-delivery": "delivery_bad"
      },
      body: "{}"
    });

    expect(response.status).toBe(401);
    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      type: "security.signature_failed",
      severity: "warn",
      subject: "github:POST /github/webhooks",
      payload: {
        provider: "github",
        endpoint: "POST /github/webhooks",
        reason: "invalid_signature",
        deliveryId: "delivery_bad",
        hasSignature: true
      }
    });
    expect(JSON.stringify(recordControlPlaneEvent.mock.calls)).not.toContain("sha256=bad");
  });

  it("rejects oversized webhook bodies before parsing or creating runs", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const recordControlPlaneEvent = vi.fn(async () => {});
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun,
      recordControlPlaneEvent,
      maxRequestBodyBytes: 8,
      now: () => "2026-06-27T00:00:00.000Z"
    });
    const body = JSON.stringify({ ping: true });
    const request = signedRequest({ body, secret: "secret", event: "ping", deliveryId: "delivery_large" });
    const headers = request.headers as Record<string, string>;

    const response = await app.request("/github/webhooks", {
      ...request,
      headers: {
        ...headers,
        "content-length": String(Buffer.byteLength(body))
      }
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "request_body_too_large", maxBytes: 8 });
    expect(createRun).not.toHaveBeenCalled();
    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      type: "security.request_body_rejected",
      severity: "warn",
      subject: "github:POST /github/webhooks",
      payload: {
        provider: "github",
        endpoint: "POST /github/webhooks",
        reason: "request_body_too_large",
        deliveryId: "delivery_large",
        githubEvent: "ping",
        maxBytes: 8,
        contentLength: String(Buffer.byteLength(body))
      }
    });
  });

  it("rejects signed issue_comment payloads that do not match the consumed schema", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const recordControlPlaneEvent = vi.fn(async () => {});
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun,
      recordControlPlaneEvent,
      now: () => "2026-06-27T00:00:00.000Z"
    });
    const body = JSON.stringify({ action: "created", comment: { body: "@opentag fix this" } });

    const response = await app.request(
      "/github/webhooks",
      signedRequest({ body, secret: "secret", event: "issue_comment" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request_body" });
    expect(createRun).not.toHaveBeenCalled();
    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      type: "security.request_body_rejected",
      severity: "warn",
      subject: "github:POST /github/webhooks",
      payload: {
        provider: "github",
        endpoint: "POST /github/webhooks",
        reason: "invalid_request_body",
        contentLength: null,
        githubEvent: "issue_comment"
      }
    });
  });

  it("records missing GitHub signature headers before rejecting webhook delivery", async () => {
    const recordControlPlaneEvent = vi.fn(async () => {});
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun: vi.fn(async () => ({ runId: "run_1" })),
      recordControlPlaneEvent,
      now: () => "2026-06-27T00:00:00.000Z"
    });

    const response = await app.request("/github/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping"
      },
      body: "{}"
    });

    expect(response.status).toBe(401);
    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      type: "security.signature_failed",
      severity: "warn",
      subject: "github:POST /github/webhooks",
      payload: {
        provider: "github",
        endpoint: "POST /github/webhooks",
        reason: "missing_signature_header",
        hasSignature: false
      }
    });
  });
});
