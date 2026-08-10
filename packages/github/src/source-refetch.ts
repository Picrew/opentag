import {
  computeControlPayloadDigestV1,
  computeGitHubIssueCommentSourceIdentityDigestV1,
  HostedAdmissionEnvelopeV1Schema,
  verifyHostedAdmissionEnvelopeDigestV1,
  type HostedAdmissionEnvelopeV1,
  type OpenTagEvent,
} from "@opentag/core";
import { normalizeGitHubIssueComment } from "./normalize.js";

const GITHUB_API_ORIGIN = "https://api.github.com";
export const OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1 =
  "opentag_e2e_no_provider_credential_v1";

export type GitHubIssueCommentRefetchReceipt = {
  provider: "github";
  providerRepositoryId: string;
  owner: string;
  repo: string;
  sourceThread: HostedAdmissionEnvelopeV1["sourceThread"];
  sourceEvent: HostedAdmissionEnvelopeV1["sourceEvent"];
  actor: {
    providerUserId: string;
    login: string;
  };
  sourceIdentityDigest: string;
  eventDigest: string;
  refetchedAt: string;
};

export type RefetchedGitHubIssueComment = {
  event: OpenTagEvent;
  receipt: GitHubIssueCommentRefetchReceipt;
};

export class GitHubSourceRefetchError extends Error {
  override readonly name = "GitHubSourceRefetchError";

  constructor(readonly code:
    | "github_source_missing"
    | "github_source_refetch_failed"
    | "github_source_api_origin_invalid"
    | "github_source_invalid"
    | "github_source_identity_mismatch"
    | "github_source_semantic_mismatch"
  ) {
    super(code);
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function exactInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function validGitHubTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? value : undefined;
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

function requestHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
}

export function resolveGitHubSourceApiOrigin(input: {
  token: string;
  apiOrigin?: string;
}): string {
  if (input.apiOrigin === undefined) return GITHUB_API_ORIGIN;
  if (input.token !== OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1) {
    throw new GitHubSourceRefetchError("github_source_api_origin_invalid");
  }
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(
    input.apiOrigin,
  );
  const port = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new GitHubSourceRefetchError("github_source_api_origin_invalid");
  }
  return input.apiOrigin;
}

async function fetchGitHubJson(input: {
  fetchImpl: typeof fetch;
  url: string;
  token: string;
}): Promise<JsonRecord> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "GET",
      headers: requestHeaders(input.token),
      redirect: "manual",
    });
  } catch {
    throw new GitHubSourceRefetchError("github_source_refetch_failed");
  }
  if (response.status === 404 || response.status === 410) {
    throw new GitHubSourceRefetchError("github_source_missing");
  }
  if (!response.ok || (response.status >= 300 && response.status < 400)) {
    throw new GitHubSourceRefetchError("github_source_refetch_failed");
  }
  try {
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      throw new GitHubSourceRefetchError("github_source_invalid");
    }
    return body;
  } catch (error) {
    if (error instanceof GitHubSourceRefetchError) throw error;
    throw new GitHubSourceRefetchError("github_source_invalid");
  }
}

function assertIdentity(condition: boolean): void {
  if (!condition) {
    throw new GitHubSourceRefetchError("github_source_identity_mismatch");
  }
}

export async function refetchGitHubIssueCommentForHostedAdmission(input: {
  admission: HostedAdmissionEnvelopeV1;
  token: string;
  apiOrigin?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<RefetchedGitHubIssueComment> {
  const parsedAdmission = HostedAdmissionEnvelopeV1Schema.safeParse(
    input.admission,
  );
  if (
    !parsedAdmission.success
    || !(await verifyHostedAdmissionEnvelopeDigestV1(parsedAdmission.data))
  ) {
    throw new GitHubSourceRefetchError("github_source_invalid");
  }
  const admission = parsedAdmission.data;
  if (admission.provider !== "github" || admission.eventName !== "issue_comment") {
    throw new GitHubSourceRefetchError("github_source_invalid");
  }
  if (typeof input.token !== "string" || input.token.trim().length === 0) {
    throw new GitHubSourceRefetchError("github_source_refetch_failed");
  }

  const apiOrigin = resolveGitHubSourceApiOrigin({
    token: input.token,
    ...(input.apiOrigin !== undefined ? { apiOrigin: input.apiOrigin } : {}),
  });
  const fetchImpl = input.fetchImpl ?? fetch;
  const owner = admission.repository.owner;
  const repo = admission.repository.repo;
  const repositoryUrl = `${apiOrigin}/repos/${encodePath(owner)}/${encodePath(repo)}`;
  const issueUrl = `${repositoryUrl}/issues/${admission.sourceThread.number}`;
  const commentUrl = `${repositoryUrl}/issues/comments/${encodePath(admission.sourceEvent.providerEventId)}`;

  const repository = await fetchGitHubJson({
    fetchImpl,
    url: repositoryUrl,
    token: input.token,
  });
  const repositoryOwner = isRecord(repository.owner)
    ? exactString(repository.owner.login)
    : undefined;
  assertIdentity(
    String(repository.id) === admission.repository.providerRepositoryId
      && exactString(repository.name) === repo
      && repositoryOwner === owner
      && exactString(repository.full_name) === `${owner}/${repo}`,
  );
  if (typeof repository.private !== "boolean") {
    throw new GitHubSourceRefetchError("github_source_invalid");
  }

  const thread = await fetchGitHubJson({
    fetchImpl,
    url: issueUrl,
    token: input.token,
  });
  const fetchedThreadKind = isRecord(thread.pull_request)
    ? "pull_request"
    : "issue";
  assertIdentity(
    String(thread.id) === admission.sourceThread.providerThreadId
      && exactInteger(thread.number) === admission.sourceThread.number
      && fetchedThreadKind === admission.sourceThread.kind
      && exactString(thread.repository_url) === repositoryUrl
      && exactString(thread.comments_url) === `${issueUrl}/comments`,
  );
  const threadHtmlUrl = exactString(thread.html_url);
  const commentsUrl = exactString(thread.comments_url);
  if (!threadHtmlUrl || !commentsUrl) {
    throw new GitHubSourceRefetchError("github_source_invalid");
  }

  const comment = await fetchGitHubJson({
    fetchImpl,
    url: commentUrl,
    token: input.token,
  });
  const actor = isRecord(comment.user) ? comment.user : undefined;
  const actorId = actor ? exactInteger(actor.id) : undefined;
  const actorLogin = actor ? exactString(actor.login) : undefined;
  assertIdentity(
    String(comment.id) === admission.sourceEvent.providerEventId
      && exactString(comment.issue_url) === issueUrl
      && String(actorId) === admission.verifiedActor.providerUserId
      && actorLogin === admission.verifiedActor.login,
  );
  const commentBody = typeof comment.body === "string" ? comment.body : undefined;
  const commentHtmlUrl = exactString(comment.html_url);
  const createdAt = validGitHubTimestamp(comment.created_at);
  const updatedAt = validGitHubTimestamp(comment.updated_at);
  if (!commentBody || !commentHtmlUrl || !createdAt || !updatedAt) {
    throw new GitHubSourceRefetchError("github_source_invalid");
  }

  const sourceIdentityDigest = await computeGitHubIssueCommentSourceIdentityDigestV1({
    provider: "github",
    repository: admission.repository,
    sourceThread: admission.sourceThread,
    sourceEvent: admission.sourceEvent,
    actor: {
      providerUserId: admission.verifiedActor.providerUserId,
      login: admission.verifiedActor.login,
    },
    executionBearingCommentBody: commentBody,
  });
  if (sourceIdentityDigest !== admission.sourceIdentityDigest) {
    throw new GitHubSourceRefetchError("github_source_semantic_mismatch");
  }

  const event = normalizeGitHubIssueComment({
    id: admission.sourceEvent.providerEventId,
    commentBody,
    commentUrl: commentHtmlUrl,
    apiCommentsUrl: commentsUrl,
    issueUrl: threadHtmlUrl,
    issueNumber: admission.sourceThread.number,
    threadKind: admission.sourceThread.kind,
    owner,
    repo,
    actorId: actorId!,
    actorLogin: actorLogin!,
    ...(typeof comment.author_association === "string"
      ? { authorAssociation: comment.author_association }
      : {}),
    private: repository.private,
    receivedAt: admission.receivedAt,
    deliveryId: admission.deliveryId,
  });
  if (!event) {
    throw new GitHubSourceRefetchError("github_source_semantic_mismatch");
  }
  const eventDigest = await computeControlPayloadDigestV1(event);

  return {
    event,
    receipt: {
      provider: "github",
      providerRepositoryId: admission.repository.providerRepositoryId,
      owner,
      repo,
      sourceThread: admission.sourceThread,
      sourceEvent: admission.sourceEvent,
      actor: {
        providerUserId: admission.verifiedActor.providerUserId,
        login: admission.verifiedActor.login,
      },
      sourceIdentityDigest,
      eventDigest,
      refetchedAt: (input.now?.() ?? new Date()).toISOString(),
    },
  };
}
