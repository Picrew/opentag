import { describe, expect, it, vi } from "vitest";
import type { OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import { maybeCreatePullRequest } from "../src/pr.js";

describe("local-runtime pull request target identity", () => {
  it("matches mixed-case GitHub event metadata to the canonical binding", async () => {
    const commandRunner = {
      run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };
    const event: OpenTagEvent = {
      id: "event_1",
      source: "github",
      sourceEventId: "delivery_1",
      receivedAt: "2026-08-10T00:00:00.000Z",
      actor: {
        provider: "github",
        providerUserId: "user_1",
        handle: "octocat",
      },
      target: { mention: "@opentag", agentId: "opentag" },
      command: { rawText: "fix it", intent: "fix", args: {} },
      context: [],
      permissions: [{ scope: "pr:create", reason: "requested by maintainer" }],
      callback: { provider: "github", uri: "https://example.test/callback" },
      metadata: {
        repoProvider: "GitHub",
        owner: "AcMe",
        repo: "WiDgEt",
      },
    };
    const run: OpenTagRun = {
      id: "run_1",
      eventId: event.id,
      status: "running",
      createdAt: event.receivedAt,
      updatedAt: event.receivedAt,
    };
    const result: OpenTagRunResult = {
      conclusion: "success",
      summary: "updated",
      changedFiles: ["README.md"],
    };

    await expect(maybeCreatePullRequest({
      run,
      event,
      binding: {
        provider: "github",
        owner: "acme",
        repo: "widget",
        checkoutPath: "/tmp/widget",
        defaultExecutor: "codex",
        baseBranch: "main",
        pushRemote: "origin",
        keepWorktree: "on_failure",
      },
      executorCapability: { sourceControl: "self_committing" },
      result,
      options: {
        preparePullRequestBranch: true,
        commandRunner,
      },
    })).resolves.toBe(result);
    expect(commandRunner.run).toHaveBeenCalledWith(
      "git",
      ["push", "-u", "origin", "opentag/run_1"],
      { cwd: "/tmp/widget" },
    );
  });
});
