import {
  computeControlPayloadDigestV1,
  computeGitHubIssueCommentSourceIdentityDigestV1,
  computeHostedAdmissionEnvelopeDigestV1,
  HostedAdmissionEnvelopeV1Schema,
  type HostedAdmissionEnvelopeV1,
} from '@opentag/core';
import { describe, expect, it, vi } from 'vitest';
import {
  GitHubSourceRefetchError,
  refetchGitHubIssueCommentForHostedAdmission,
} from '../src/source-refetch.js';

const TOKEN = 'github_pat_secret-value';
const BODY = '@opentag fix this exact source';
const REPOSITORY_URL = 'https://api.github.com/repos/acme/demo';
const ISSUE_URL = `${REPOSITORY_URL}/issues/7`;
const COMMENT_URL = `${REPOSITORY_URL}/issues/comments/789`;

type ThreadKind = HostedAdmissionEnvelopeV1['sourceThread']['kind'];

async function admission(
  threadKind: ThreadKind = 'issue',
): Promise<HostedAdmissionEnvelopeV1> {
  const sourceIdentityDigest =
    await computeGitHubIssueCommentSourceIdentityDigestV1({
      provider: 'github',
      repository: {
        providerRepositoryId: '123',
        owner: 'acme',
        repo: 'demo',
      },
      sourceThread: {
        kind: threadKind,
        providerThreadId: '456',
        number: 7,
      },
      sourceEvent: {
        providerEventId: '789',
        kind: 'issue_comment',
      },
      actor: {
        providerUserId: '1001',
        login: 'octocat',
      },
      executionBearingCommentBody: BODY,
    });
  const unsigned = {
    kind: 'hosted_admission' as const,
    schemaVersion: 1 as const,
    protocolVersion: '1.0' as const,
    requiredCapabilities: ['relay.hosted-admission.v1'] as const,
    admissionId: 'hadm_01J00000000000000000000000',
    operationId: 'op_01J000000000000000000000000',
    organizationId: 'org_01J00000000000000000000000',
    bindingId: 'bnd_01J00000000000000000000000',
    bindingSecretVersion: 'secret-v1',
    provider: 'github' as const,
    deliveryId: 'delivery-1',
    deliveryPayloadDigest: `sha256:${'1'.repeat(64)}`,
    sourceIdentityDigest,
    eventName: 'issue_comment' as const,
    action: 'created',
    repository: {
      providerRepositoryId: '123',
      owner: 'acme',
      repo: 'demo',
    },
    sourceThread: {
      kind: threadKind,
      providerThreadId: '456',
      number: 7,
    },
    sourceEvent: {
      providerEventId: '789',
      kind: 'issue_comment' as const,
    },
    verifiedActor: {
      providerUserId: '1001',
      login: 'octocat',
      authorization: {
        decision: 'allowed' as const,
        grantRef: 'grant:github:acme/demo:octocat',
        grantVersion: 1,
        grantDigest: `sha256:${'2'.repeat(64)}`,
      },
    },
    projectTarget: {
      projectTargetId: 'pt_01J00000000000000000000000',
      version: 1,
      digest: `sha256:${'3'.repeat(64)}`,
    },
    runnerId: 'runner_01J0000000000000000000000',
    admissionPolicySnapshot: {
      snapshotId: 'aps_01J00000000000000000000000',
      digest: `sha256:${'4'.repeat(64)}`,
    },
    receivedAt: '2026-08-10T00:00:00.000Z',
    envelopeDigest: `sha256:${'0'.repeat(64)}`,
  };
  return HostedAdmissionEnvelopeV1Schema.parse({
    ...unsigned,
    envelopeDigest: await computeHostedAdmissionEnvelopeDigestV1(unsigned),
  });
}

function githubFetch(overrides?: {
  repository?: Record<string, unknown>;
  thread?: Record<string, unknown>;
  comment?: Record<string, unknown>;
  commentStatus?: number;
}) {
  const repository = {
    id: 123,
    name: 'demo',
    full_name: 'acme/demo',
    private: true,
    owner: { login: 'acme' },
    ...overrides?.repository,
  };
  const thread = {
    id: 456,
    number: 7,
    repository_url: REPOSITORY_URL,
    html_url: 'https://github.com/acme/demo/issues/7',
    comments_url: `${ISSUE_URL}/comments`,
    ...overrides?.thread,
  };
  const comment = {
    id: 789,
    issue_url: ISSUE_URL,
    body: BODY,
    html_url: 'https://github.com/acme/demo/issues/7#issuecomment-789',
    created_at: '2026-08-09T23:59:00.000Z',
    updated_at: '2026-08-09T23:59:00.000Z',
    user: { id: 1001, login: 'octocat' },
    author_association: 'MEMBER',
    ...overrides?.comment,
  };
  return vi.fn<typeof fetch>(async (url) => {
    if (url === REPOSITORY_URL) return Response.json(repository);
    if (url === ISSUE_URL) return Response.json(thread);
    if (url === COMMENT_URL) {
      return Response.json(comment, { status: overrides?.commentStatus ?? 200 });
    }
    return new Response(null, { status: 404 });
  });
}

async function expectCode(
  promise: Promise<unknown>,
  code: GitHubSourceRefetchError['code'],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'GitHubSourceRefetchError',
    code,
    message: code,
  });
}

describe('refetchGitHubIssueCommentForHostedAdmission', () => {
  it('refetches an exact issue comment with caller credentials and a redacted receipt', async () => {
    const fetchImpl = githubFetch();
    const result = await refetchGitHubIssueCommentForHostedAdmission({
      admission: await admission(),
      token: TOKEN,
      fetchImpl,
      now: () => new Date('2026-08-10T00:01:00.000Z'),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]).toMatchObject({
        method: 'GET',
        redirect: 'manual',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
    }
    expect(result.event).toMatchObject({
      source: 'github',
      sourceEventId: '789',
      command: { intent: 'fix' },
      workItem: { kind: 'issue', externalId: 'acme/demo#7' },
    });
    expect(result.receipt).toMatchObject({
      providerRepositoryId: '123',
      sourceThread: { kind: 'issue', providerThreadId: '456', number: 7 },
      sourceEvent: { kind: 'issue_comment', providerEventId: '789' },
      actor: { providerUserId: '1001', login: 'octocat' },
      refetchedAt: '2026-08-10T00:01:00.000Z',
    });
    expect(result.receipt.eventDigest).toBe(
      await computeControlPayloadDigestV1(result.event),
    );
    expect(result.receipt.eventDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(result.receipt)).not.toContain(TOKEN);
    expect(JSON.stringify(result.receipt)).not.toContain(BODY);
  });

  it('cryptographically binds the receipt to the final normalized event', async () => {
    const result = await refetchGitHubIssueCommentForHostedAdmission({
      admission: await admission(),
      token: TOKEN,
      fetchImpl: githubFetch(),
    });
    const tamperedEvent = {
      ...result.event,
      command: {
        ...result.event.command,
        intent: 'explain' as const,
      },
    };

    expect(await computeControlPayloadDigestV1(tamperedEvent)).not.toBe(
      result.receipt.eventDigest,
    );
    expect(JSON.stringify(result.receipt)).not.toContain(TOKEN);
    expect(JSON.stringify(result.receipt)).not.toContain(BODY);
  });

  it('supports issue comments on pull requests after exact kind refetch', async () => {
    const fetchImpl = githubFetch({
      thread: {
        pull_request: { url: `${REPOSITORY_URL}/pulls/7` },
        html_url: 'https://github.com/acme/demo/pull/7',
      },
      comment: {
        html_url: 'https://github.com/acme/demo/pull/7#issuecomment-789',
      },
    });
    const result = await refetchGitHubIssueCommentForHostedAdmission({
      admission: await admission('pull_request'),
      token: TOKEN,
      fetchImpl,
    });

    expect(result.event.workItem).toMatchObject({
      kind: 'pull_request',
      externalId: 'acme/demo#7',
    });
    expect(result.event.metadata).toMatchObject({ pullRequestNumber: 7 });
    expect(result.event.metadata).not.toHaveProperty('issueNumber');
  });

  it('fails closed when the execution-bearing comment body was edited', async () => {
    await expectCode(
      refetchGitHubIssueCommentForHostedAdmission({
        admission: await admission(),
        token: TOKEN,
        fetchImpl: githubFetch({ comment: { body: '@opentag explain instead' } }),
      }),
      'github_source_semantic_mismatch',
    );
  });

  it('fails closed when the exact comment was deleted', async () => {
    await expectCode(
      refetchGitHubIssueCommentForHostedAdmission({
        admission: await admission(),
        token: TOKEN,
        fetchImpl: githubFetch({ commentStatus: 404 }),
      }),
      'github_source_missing',
    );
  });

  it('fails closed on repository transfer or rename', async () => {
    await expectCode(
      refetchGitHubIssueCommentForHostedAdmission({
        admission: await admission(),
        token: TOKEN,
        fetchImpl: githubFetch({
          repository: { full_name: 'other/demo', owner: { login: 'other' } },
        }),
      }),
      'github_source_identity_mismatch',
    );
  });

  it('fails closed on thread kind and actor identity mismatches', async () => {
    await expectCode(
      refetchGitHubIssueCommentForHostedAdmission({
        admission: await admission('pull_request'),
        token: TOKEN,
        fetchImpl: githubFetch(),
      }),
      'github_source_identity_mismatch',
    );
    await expectCode(
      refetchGitHubIssueCommentForHostedAdmission({
        admission: await admission(),
        token: TOKEN,
        fetchImpl: githubFetch({
          comment: { user: { id: 1002, login: 'mallory' } },
        }),
      }),
      'github_source_identity_mismatch',
    );
  });

  it('redacts caller tokens and provider bodies from failures', async () => {
    const secretBody = `provider diagnostic ${BODY}`;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error(`${TOKEN} ${secretBody}`);
    });
    let thrown: unknown;
    try {
      await refetchGitHubIssueCommentForHostedAdmission({
        admission: await admission(),
        token: TOKEN,
        fetchImpl,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GitHubSourceRefetchError);
    expect(JSON.stringify(thrown)).not.toContain(TOKEN);
    expect(String(thrown)).not.toContain(secretBody);
  });
});
