import { describe, expect, it } from "vitest";
import { EXECUTOR_REPORT_END, EXECUTOR_REPORT_START } from "../src/executor-report.js";
import { createExecutorRunResult } from "../src/result.js";

describe("createExecutorRunResult", () => {
  it("renders user-visible summaries from the structured executor report when present", () => {
    const result = createExecutorRunResult({
      executorName: "Claude Code",
      runId: "run_1",
      branchName: "opentag/run_1",
      output: [
        "Raw executor note: please approve `git commit` and `gh pr create` to finish.",
        EXECUTOR_REPORT_START,
        JSON.stringify({
          changes: [{ file: "README.md", summary: "Added one sentence about clean Slack approval summaries." }],
          verification: [{ outcome: "passed", summary: "The edit applied cleanly." }],
          artifacts: [{ kind: "screenshot", title: "UI screenshot", uri: "artifacts/run_1.png" }],
          risks: ["No known risks beyond reviewing the generated diff."]
        }),
        EXECUTOR_REPORT_END
      ].join("\n"),
      changedFiles: ["README.md"]
    });

    expect(result.summary).toBe(
      [
        "What changed:",
        "- `README.md`: Added one sentence about clean Slack approval summaries.",
        "",
        "Verified:",
        "- passed - The edit applied cleanly.",
        "",
        "Risks:",
        "- No known risks beyond reviewing the generated diff."
      ].join("\n")
    );
    expect(result.summary).not.toMatch(/git\s+commit/i);
    expect(result.summary).not.toMatch(/gh\s+pr\s+create/i);
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        kind: "patch",
        title: "Generated patch",
        uri: "opentag/run_1",
        metadata: expect.objectContaining({
          runId: "run_1",
          branchName: "opentag/run_1",
          changedFiles: ["README.md"]
        })
      }),
      expect.objectContaining({
        kind: "report",
        title: "Run report",
        uri: "opentag://run/run_1/report",
        metadata: expect.objectContaining({
          executor: "Claude Code",
          changedFiles: ["README.md"],
          report: expect.objectContaining({
            changes: [{ file: "README.md", summary: "Added one sentence about clean Slack approval summaries." }],
            artifacts: [{ kind: "screenshot", title: "UI screenshot", uri: "artifacts/run_1.png" }]
          })
        })
      }),
      expect.objectContaining({
        kind: "log_summary",
        title: "Log summary",
        uri: "opentag://run/run_1/log-summary",
        metadata: expect.objectContaining({
          executor: "Claude Code"
        })
      }),
      { kind: "screenshot", title: "UI screenshot", uri: "artifacts/run_1.png" }
    ]);

    const pullRequestBody = result.suggestedChanges?.[0]?.intents[0]?.params?.["body"];
    expect(pullRequestBody).toContain("- `README.md`: Added one sentence about clean Slack approval summaries.");
    expect(pullRequestBody).not.toMatch(/git\s+commit/i);
    expect(pullRequestBody).not.toMatch(/gh\s+pr\s+create/i);
  });

  it("preserves no-change answer text before a structured executor report", () => {
    const result = createExecutorRunResult({
      executorName: "Codex",
      runId: "run_1",
      branchName: "opentag/run_1",
      output: [
        "OpenTag is a local-first source-thread callback system. It connects chat or issue events to a local coding agent, runs work in an isolated checkout, and posts concise results back to the originating thread.",
        "",
        EXECUTOR_REPORT_START,
        JSON.stringify({
          changes: [],
          verification: [
            {
              command: "git status --short --branch",
              outcome: "passed",
              summary: "Confirmed the checkout remained clean after read-only inspection."
            }
          ],
          risks: []
        }),
        EXECUTOR_REPORT_END
      ].join("\n"),
      changedFiles: []
    });

    expect(result.summary).toContain("OpenTag is a local-first source-thread callback system.");
    expect(result.summary).toContain("Verified:");
    expect(result.summary).toContain("git status --short --branch");
    expect(result.summary).not.toContain(EXECUTOR_REPORT_START);
    expect(result.summary).not.toContain(EXECUTOR_REPORT_END);
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        id: "run_1:diagnosis-report",
        type: "diagnosis_report",
        kind: "report",
        title: "Run report",
        uri: "opentag://run/run_1/report",
        sourceRunId: "run_1",
        metadata: expect.objectContaining({
          executor: "Codex",
          changedFiles: []
        })
      }),
      expect.objectContaining({
        id: "run_1:log-summary",
        type: "log_summary",
        kind: "log_summary",
        title: "Log summary",
        uri: "opentag://run/run_1/log-summary",
        sourceRunId: "run_1",
        metadata: expect.objectContaining({
          executor: "Codex"
        })
      })
    ]);
  });

  it("carries explicit executor artifacts even when no files changed", () => {
    const result = createExecutorRunResult({
      executorName: "Codex",
      runId: "run_visual",
      branchName: "opentag/run_visual",
      output: [
        "Captured the requested screenshot without editing files.",
        "",
        EXECUTOR_REPORT_START,
        JSON.stringify({
          changes: [],
          verification: [{ command: "playwright screenshot", outcome: "passed", summary: "Screenshot captured." }],
          artifacts: [{ kind: "screenshot", title: "Checkout screenshot", uri: "artifacts/checkout.png" }],
          risks: []
        }),
        EXECUTOR_REPORT_END
      ].join("\n"),
      changedFiles: []
    });

    expect(result.changedFiles).toEqual([]);
    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "diagnosis_report",
          kind: "report",
          sourceRunId: "run_visual"
        }),
        expect.objectContaining({
          type: "log_summary",
          kind: "log_summary",
          sourceRunId: "run_visual"
        }),
        { kind: "screenshot", title: "Checkout screenshot", uri: "artifacts/checkout.png" }
      ])
    );
    expect(result.summary).toContain("Captured the requested screenshot");
    expect(result.summary).toContain("Verified:");
  });

  it("only accepts safe screenshot artifacts from executor reports", () => {
    const result = createExecutorRunResult({
      executorName: "Codex",
      runId: "run_visual_safety",
      branchName: "opentag/run_visual_safety",
      output: [
        "Captured one screenshot and ignored unsafe artifact claims.",
        "",
        EXECUTOR_REPORT_START,
        JSON.stringify({
          changes: [],
          artifacts: [
            { kind: "patch", title: "Fake patch", uri: "artifacts/fake.patch" },
            { kind: "screenshot", title: "Unsafe screenshot", uri: "javascript:alert(1)" },
            { kind: "screenshot", title: "Safe screenshot", uri: "artifacts/safe.png" }
          ],
          risks: []
        }),
        EXECUTOR_REPORT_END
      ].join("\n"),
      changedFiles: []
    });

    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "diagnosis_report",
          kind: "report",
          sourceRunId: "run_visual_safety"
        }),
        expect.objectContaining({
          type: "log_summary",
          kind: "log_summary",
          sourceRunId: "run_visual_safety"
        }),
        { kind: "screenshot", title: "Safe screenshot", uri: "artifacts/safe.png" }
      ])
    );
    expect(result.artifacts).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Fake patch" })]));
    expect(result.artifacts).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Unsafe screenshot" })]));
    expect(result.summary).toContain("Captured one screenshot");
  });

  it("preserves assistant answers beyond the former 4,000-character limit", () => {
    const output = `Long answer: ${"x".repeat(20_000)}`;
    const result = createExecutorRunResult({
      executorName: "Claude Code",
      runId: "run_long_answer",
      branchName: "opentag/run_long_answer",
      output,
      changedFiles: []
    });

    expect(result.summary).toBe(output);
    expect(result.summary.length).toBeGreaterThan(4_000);
  });

  it("drops a leading partial line when an answer exceeds the expanded summary limit", () => {
    const result = createExecutorRunResult({
      executorName: "Codex",
      runId: "run_1",
      branchName: "opentag/run_1",
      output: [
        `${"OpenTag policy handoff ".repeat(2_600)}source-thread decisions apply/reject/continue.`,
        "",
        "**Repository Shape**",
        "This is a PNPM workspace with packages, apps, docs, and examples.",
        "",
        EXECUTOR_REPORT_START,
        JSON.stringify({
          changes: [],
          verification: [{ command: "git status --short", outcome: "passed", summary: "No file changes." }],
          risks: []
        }),
        EXECUTOR_REPORT_END
      ].join("\n"),
      changedFiles: []
    });

    expect(result.summary).toContain("**Repository Shape**");
    expect(result.summary).toContain("This is a PNPM workspace");
    expect(result.summary).not.toContain("apply/reject/continue");
    expect(result.summary.trimStart().startsWith("**Repository Shape**")).toBe(true);
  });

  it("removes executor source-control handoff instructions from user-visible summaries", () => {
    const result = createExecutorRunResult({
      executorName: "Claude Code",
      runId: "run_1",
      branchName: "opentag/run_1",
      output: [
        "What changed: Added the requested README sentence.",
        "",
        "Verified: The edit applied cleanly.",
        "",
        "Recommended next action: Commit the change and push to the branch.",
        "",
        "Blocker: I cannot run `git add README.md` or `git commit` because those commands require interactive user approval.",
        "",
        "To finish:",
        "```bash",
        "git add README.md && git commit -m \"Update README\" && gh pr create",
        "```"
      ].join("\n"),
      changedFiles: ["README.md"]
    });

    expect(result.summary).toContain("What changed: Added the requested README sentence.");
    expect(result.summary).toContain("Verified: The edit applied cleanly.");
    expect(result.summary).not.toMatch(/git\s+add/i);
    expect(result.summary).not.toMatch(/git\s+commit/i);
    expect(result.summary).not.toMatch(/git\s+push/i);
    expect(result.summary).not.toMatch(/gh\s+pr\s+create/i);
    expect(result.summary).not.toMatch(/interactive user approval/i);
    expect(result.summary).not.toContain("```");

    const pullRequestBody = result.suggestedChanges?.[0]?.intents[0]?.params?.["body"];
    expect(pullRequestBody).toContain("What changed: Added the requested README sentence.");
    expect(pullRequestBody).toContain("Verified: The edit applied cleanly.");
    expect(pullRequestBody).not.toMatch(/git\s+add/i);
    expect(pullRequestBody).not.toMatch(/git\s+commit/i);
    expect(pullRequestBody).not.toMatch(/gh\s+pr\s+create/i);
    expect(result.nextAction).toMatchObject({
      summary: "Review the proposed pull request action and reply `apply 1` if the branch should become a PR."
    });
  });

  it("falls back to an OpenTag-owned summary when the executor output is only handoff noise", () => {
    const result = createExecutorRunResult({
      executorName: "Claude Code",
      runId: "run_1",
      branchName: "opentag/run_1",
      output: "Please approve `git add README.md && git commit && gh pr create` to finish.",
      changedFiles: ["README.md", "docs/setup.md"]
    });

    expect(result.summary).toBe("Claude Code changed 2 file(s). Changed files: README.md, docs/setup.md.");
    expect(result.summary).not.toMatch(/git\s+add/i);
    expect(result.suggestedChanges?.[0]?.intents[0]?.params?.["body"]).not.toMatch(/git\s+add/i);
  });

  it("preserves generic blocker and permission-system status lines in fallback summaries", () => {
    const result = createExecutorRunResult({
      executorName: "Claude Code",
      runId: "run_1",
      branchName: "opentag/run_1",
      output: [
        "What changed:",
        "- Updated permission-system documentation.",
        "",
        "Blocker: External API credentials are missing.",
        "",
        "Verified: Not run because credentials are missing."
      ].join("\n"),
      changedFiles: ["docs/security.md"]
    });

    expect(result.summary).toContain("What changed:");
    expect(result.summary).toContain("Updated permission-system documentation.");
    expect(result.summary).toContain("Blocker: External API credentials are missing.");
    expect(result.summary).toContain("Verified: Not run because credentials are missing.");
  });
});
