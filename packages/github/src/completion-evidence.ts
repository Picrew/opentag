import { createHash } from "node:crypto";

export type GitHubCheckState = "passed" | "failed" | "pending";

export type GitHubVerifiedPullRequestSnapshot = {
  provider: "github";
  deliveryId: string;
  eventName: "pull_request" | "check_run" | "check_suite" | "status";
  repository: { owner: string; repo: string };
  pullRequest: {
    number: number;
    resourceRef: string;
    headSha: string;
    baseSha: string;
    baseBranch: string;
    state: "open" | "closed" | "merged";
  };
  checks: Record<string, GitHubCheckState>;
  checksComplete: boolean;
  observedAt: string;
  payloadDigest: string;
};

export type GitHubCompletionApi = {
  getPullRequest(input: { owner: string; repo: string; pullRequestNumber: number }): Promise<{
    number: number;
    state: string;
    merged: boolean;
    head: { sha: string };
    base: { ref: string; sha: string; repo?: { full_name?: string } | null };
  }>;
  listCheckRunsForRef(input: { owner: string; repo: string; ref: string }): Promise<{
    totalCount: number;
    checkRuns: Array<{
      name: string;
      status: string;
      conclusion: string | null;
      head_sha: string;
    }>;
  }>;
  getCombinedStatusForRef(input: { owner: string; repo: string; ref: string }): Promise<{
    totalCount: number;
    statuses: Array<{
      context: string;
      state: string;
      sha: string;
    }>;
  }>;
  listPullRequestsForCommit(input: { owner: string; repo: string; ref: string }): Promise<Array<{ number: number }>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function repositoryFromPayload(payload: unknown): { owner: string; repo: string } | null {
  if (!isRecord(payload) || !isRecord(payload["repository"])) return null;
  const repository = payload["repository"];
  const repo = nonEmptyString(repository["name"]);
  const owner = isRecord(repository["owner"]) ? nonEmptyString(repository["owner"]["login"]) : null;
  return owner && repo ? { owner, repo } : null;
}

function pullRequestNumbersFromEmbedded(value: unknown): number[] {
  if (!isRecord(value) || !Array.isArray(value["pull_requests"])) return [];
  return value["pull_requests"].flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const number = positiveInteger(candidate["number"]);
    return number ? [number] : [];
  });
}

export type GitHubCompletionEventCorrelation = {
  repository: { owner: string; repo: string };
  pullRequestNumbers: number[];
  headSha?: string;
};

export function githubCompletionEventCorrelation(input: {
  eventName: string;
  payload: unknown;
}): GitHubCompletionEventCorrelation | null {
  if (!["pull_request", "check_run", "check_suite", "status"].includes(input.eventName)) return null;
  const repository = repositoryFromPayload(input.payload);
  if (!repository || !isRecord(input.payload)) return null;
  if (input.eventName === "pull_request") {
    const number = positiveInteger(input.payload["number"])
      ?? (isRecord(input.payload["pull_request"]) ? positiveInteger(input.payload["pull_request"]["number"]) : null);
    return number ? { repository, pullRequestNumbers: [number] } : null;
  }
  if (input.eventName === "check_run" && isRecord(input.payload["check_run"])) {
    const checkRun = input.payload["check_run"];
    const headSha = nonEmptyString(checkRun["head_sha"]);
    return headSha ? { repository, pullRequestNumbers: pullRequestNumbersFromEmbedded(checkRun), headSha } : null;
  }
  if (input.eventName === "check_suite" && isRecord(input.payload["check_suite"])) {
    const checkSuite = input.payload["check_suite"];
    const headSha = nonEmptyString(checkSuite["head_sha"]);
    return headSha ? { repository, pullRequestNumbers: pullRequestNumbersFromEmbedded(checkSuite), headSha } : null;
  }
  const headSha = nonEmptyString(input.payload["sha"]);
  return headSha ? { repository, pullRequestNumbers: [], headSha } : null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function mergeCheckState(left: GitHubCheckState | undefined, right: GitHubCheckState): GitHubCheckState {
  if (!left) return right;
  if (left === "failed" || right === "failed") return "failed";
  if (left === "pending" || right === "pending") return "pending";
  return "passed";
}

function checkRunState(run: { status: string; conclusion: string | null }): GitHubCheckState {
  if (run.status !== "completed" || run.conclusion === null) return "pending";
  return run.conclusion === "success" ? "passed" : "failed";
}

function commitStatusState(state: string): GitHubCheckState {
  if (state === "success") return "passed";
  if (state === "pending") return "pending";
  return "failed";
}

function normalizedChecks(input: {
  headSha: string;
  checkRuns: Awaited<ReturnType<GitHubCompletionApi["listCheckRunsForRef"]>>["checkRuns"];
  statuses: Awaited<ReturnType<GitHubCompletionApi["getCombinedStatusForRef"]>>["statuses"];
}): Record<string, GitHubCheckState> {
  const checks = new Map<string, GitHubCheckState>();
  for (const run of input.checkRuns) {
    if (run.head_sha !== input.headSha || !run.name.trim()) continue;
    checks.set(run.name, mergeCheckState(checks.get(run.name), checkRunState(run)));
  }
  for (const status of input.statuses) {
    if (status.sha !== input.headSha || !status.context.trim()) continue;
    checks.set(status.context, mergeCheckState(checks.get(status.context), commitStatusState(status.state)));
  }
  return Object.fromEntries([...checks.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function isGitHubCompletionEventName(
  eventName: string | undefined
): eventName is GitHubVerifiedPullRequestSnapshot["eventName"] {
  return eventName === "pull_request" || eventName === "check_run" || eventName === "check_suite" || eventName === "status";
}

export async function reconcileGitHubCompletionEvidence(input: {
  eventName: GitHubVerifiedPullRequestSnapshot["eventName"];
  deliveryId: string;
  payload: unknown;
  api: GitHubCompletionApi;
  now: () => string;
}): Promise<GitHubVerifiedPullRequestSnapshot[]> {
  const correlation = githubCompletionEventCorrelation({ eventName: input.eventName, payload: input.payload });
  if (!correlation) throw new Error("GitHub completion event payload is missing a stable repository, pull request, or head identity.");
  const pullRequestNumbers = correlation.pullRequestNumbers.length > 0
    ? correlation.pullRequestNumbers
    : (await input.api.listPullRequestsForCommit({
        ...correlation.repository,
        ref: correlation.headSha!
      })).map((pullRequest) => pullRequest.number);
  const snapshots: GitHubVerifiedPullRequestSnapshot[] = [];
  for (const pullRequestNumber of [...new Set(pullRequestNumbers)].sort((left, right) => left - right)) {
    const pullRequest = await input.api.getPullRequest({ ...correlation.repository, pullRequestNumber });
    const expectedRepository = `${correlation.repository.owner}/${correlation.repository.repo}`.toLowerCase();
    if (pullRequest.number !== pullRequestNumber) throw new Error("GitHub pull request reconciliation returned a mismatched pull request number.");
    if (pullRequest.base.repo?.full_name && pullRequest.base.repo.full_name.toLowerCase() !== expectedRepository) {
      throw new Error("GitHub pull request reconciliation returned a mismatched target repository.");
    }
    const [checkRunPage, statusPage] = await Promise.all([
      input.api.listCheckRunsForRef({ ...correlation.repository, ref: pullRequest.head.sha }),
      input.api.getCombinedStatusForRef({ ...correlation.repository, ref: pullRequest.head.sha })
    ]);
    const checks = normalizedChecks({
      headSha: pullRequest.head.sha,
      checkRuns: checkRunPage.checkRuns,
      statuses: statusPage.statuses
    });
    const checksComplete =
      checkRunPage.checkRuns.length === checkRunPage.totalCount
      && statusPage.statuses.length === statusPage.totalCount
      && checkRunPage.checkRuns.every((run) => run.head_sha === pullRequest.head.sha)
      && statusPage.statuses.every((status) => status.sha === pullRequest.head.sha);
    const state: GitHubVerifiedPullRequestSnapshot["pullRequest"]["state"] = pullRequest.merged
      ? "merged"
      : pullRequest.state === "closed"
        ? "closed"
        : "open";
    const snapshotWithoutDigest = {
      provider: "github" as const,
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      repository: correlation.repository,
      pullRequest: {
        number: pullRequest.number,
        resourceRef: `github:${correlation.repository.owner}/${correlation.repository.repo}:pull_request:${pullRequest.number}`,
        headSha: pullRequest.head.sha,
        baseSha: pullRequest.base.sha,
        baseBranch: pullRequest.base.ref,
        state
      },
      checks,
      checksComplete,
      observedAt: input.now()
    };
    const semanticSnapshot = {
      provider: snapshotWithoutDigest.provider,
      repository: snapshotWithoutDigest.repository,
      pullRequest: snapshotWithoutDigest.pullRequest,
      checks: snapshotWithoutDigest.checks,
      checksComplete: snapshotWithoutDigest.checksComplete
    };
    snapshots.push({ ...snapshotWithoutDigest, payloadDigest: digest(semanticSnapshot) });
  }
  return snapshots;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28"
  };
}

export function createGitHubCompletionApi(input: {
  token: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}): GitHubCompletionApi {
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiBaseUrl = (input.apiBaseUrl ?? "https://api.github.com").replace(/\/$/u, "");
  const segment = (value: string | number) => encodeURIComponent(String(value));
  async function request(path: string): Promise<unknown> {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, { headers: githubHeaders(input.token) });
    if (!response.ok) throw new Error(`GitHub completion reconciliation failed: ${response.status} ${path}`);
    return response.json();
  }
  return {
    async getPullRequest({ owner, repo, pullRequestNumber }) {
      const value = await request(`/repos/${segment(owner)}/${segment(repo)}/pulls/${segment(pullRequestNumber)}`);
      if (!isRecord(value) || !positiveInteger(value["number"]) || !isRecord(value["head"]) || !nonEmptyString(value["head"]["sha"])
        || !isRecord(value["base"]) || !nonEmptyString(value["base"]["ref"]) || !nonEmptyString(value["base"]["sha"])
        || typeof value["merged"] !== "boolean" || typeof value["state"] !== "string") {
        throw new Error("GitHub pull request reconciliation returned an invalid response.");
      }
      const baseRepo = isRecord(value["base"]["repo"]) ? nonEmptyString(value["base"]["repo"]["full_name"]) : null;
      return {
        number: value["number"] as number,
        state: value["state"],
        merged: value["merged"],
        head: { sha: value["head"]["sha"] as string },
        base: {
          ref: value["base"]["ref"] as string,
          sha: value["base"]["sha"] as string,
          ...(baseRepo ? { repo: { full_name: baseRepo } } : {})
        }
      };
    },
    async listCheckRunsForRef({ owner, repo, ref }) {
      const value = await request(`/repos/${segment(owner)}/${segment(repo)}/commits/${segment(ref)}/check-runs?filter=latest&per_page=100`);
      if (!isRecord(value)) throw new Error("GitHub check-run reconciliation returned an invalid response.");
      const totalCount = nonNegativeInteger(value["total_count"]);
      if (totalCount === null || !Array.isArray(value["check_runs"])) throw new Error("GitHub check-run reconciliation returned an invalid response.");
      const checkRuns = value["check_runs"].map((candidate) => {
        if (!isRecord(candidate) || !nonEmptyString(candidate["name"]) || !nonEmptyString(candidate["status"])
          || !nonEmptyString(candidate["head_sha"])
          || (candidate["conclusion"] !== null && typeof candidate["conclusion"] !== "string")) {
          throw new Error("GitHub check-run reconciliation returned an invalid response.");
        }
        return {
          name: candidate["name"] as string,
          status: candidate["status"] as string,
          conclusion: candidate["conclusion"] as string | null,
          head_sha: candidate["head_sha"] as string
        };
      });
      return { totalCount, checkRuns };
    },
    async getCombinedStatusForRef({ owner, repo, ref }) {
      const value = await request(`/repos/${segment(owner)}/${segment(repo)}/commits/${segment(ref)}/status?per_page=100`);
      if (!isRecord(value)) throw new Error("GitHub commit-status reconciliation returned an invalid response.");
      const sha = nonEmptyString(value["sha"]);
      const totalCount = nonNegativeInteger(value["total_count"]);
      const statuses = value["statuses"];
      if (!sha || totalCount === null || !Array.isArray(statuses)) throw new Error("GitHub commit-status reconciliation returned an invalid response.");
      const normalizedStatuses = statuses.map((candidate) => {
        if (!isRecord(candidate) || !nonEmptyString(candidate["context"])
          || !nonEmptyString(candidate["state"])) {
          throw new Error("GitHub commit-status reconciliation returned an invalid response.");
        }
        return {
          context: candidate["context"] as string,
          state: candidate["state"] as string,
          sha
        };
      });
      return { totalCount, statuses: normalizedStatuses };
    },
    async listPullRequestsForCommit({ owner, repo, ref }) {
      const value = await request(`/repos/${segment(owner)}/${segment(repo)}/commits/${segment(ref)}/pulls?per_page=100`);
      if (!Array.isArray(value)) throw new Error("GitHub commit pull-request correlation returned an invalid response.");
      return value.flatMap((candidate) => {
        const number = isRecord(candidate) ? positiveInteger(candidate["number"]) : null;
        return number ? [{ number }] : [];
      });
    }
  };
}
