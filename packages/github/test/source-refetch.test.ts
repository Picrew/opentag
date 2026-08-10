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
  OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1,
  refetchGitHubIssueCommentForHostedAdmission,
  resolveGitHubSourceApiOrigin,
} from '../src/source-refetch.js';

const TOKEN = 'github_pat_secret-value';
const BODY = '@opentag fix this exact source';
const REPOSITORY_URL = 'https://api.github.com/repos/acme/demo';

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
  apiOrigin?: string;
  repository?: Record<string, unknown>;
  thread?: Record<string, unknown>;
  comment?: Record<string, unknown>;
  commentStatus?: number;
}) {
  const apiOrigin = overrides?.apiOrigin ?? 'https://api.github.com';
  const repositoryUrl = `${apiOrigin}/repos/acme/demo`;
  const issueUrl = `${repositoryUrl}/issues/7`;
  const commentUrl = `${repositoryUrl}/issues/comments/789`;
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
    repository_url: repositoryUrl,
    html_url: 'https://github.com/acme/demo/issues/7',
    comments_url: `${issueUrl}/comments`,
    ...overrides?.thread,
  };
  const comment = {
    id: 789,
    issue_url: issueUrl,
    body: BODY,
    html_url: 'https://github.com/acme/demo/issues/7#issuecomment-789',
    created_at: '2026-08-09T23:59:00.000Z',
    updated_at: '2026-08-09T23:59:00.000Z',
    user: { id: 1001, login: 'octocat' },
    author_association: 'MEMBER',
    ...overrides?.comment,
  };
  return vi.fn<typeof fetch>(async (url) => {
    if (url === repositoryUrl) return Response.json(repository);
    if (url === issueUrl) return Response.json(thread);
    if (url === commentUrl) {
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
  it('keeps the official GitHub API origin as the exact default', () => {
    expect(resolveGitHubSourceApiOrigin({ token: TOKEN })).toBe(
      'https://api.github.com',
    );
  });

  it('allows only the public E2E sentinel with an exact IPv4 loopback origin', async () => {
    const apiOrigin = 'http://127.0.0.1:43123';
    const fetchImpl = githubFetch({ apiOrigin });
    await expect(refetchGitHubIssueCommentForHostedAdmission({
      admission: await admission(),
      token: OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1,
      apiOrigin,
      fetchImpl,
    })).resolves.toMatchObject({ event: { source: 'github' } });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${apiOrigin}/repos/acme/demo`,
      `${apiOrigin}/repos/acme/demo/issues/7`,
      `${apiOrigin}/repos/acme/demo/issues/comments/789`,
    ]);
  });

  it.each([
    ['normal token', TOKEN, 'http://127.0.0.1:43123'],
    ['localhost', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'http://localhost:43123'],
    ['private IPv4', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'http://192.168.1.5:43123'],
    ['public host', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'http://example.com:43123'],
    ['evil suffix', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'http://127.0.0.1.evil.example:43123'],
    ['userinfo', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'http://user@127.0.0.1:43123'],
    ['path', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'http://127.0.0.1:43123/api'],
    ['query', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'http://127.0.0.1:43123?x=1'],
    ['fragment', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'http://127.0.0.1:43123#x'],
    ['missing port', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'http://127.0.0.1'],
    ['zero port', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'http://127.0.0.1:0'],
    ['leading-zero port', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'http://127.0.0.1:043123'],
    ['invalid port', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'http://127.0.0.1:65536'],
    ['trailing slash', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'http://127.0.0.1:43123/'],
    ['https loopback', OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1, 'https://127.0.0.1:43123'],
  ])('rejects %s before fetch without exposing input values', async (_label, token, apiOrigin) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const operation = refetchGitHubIssueCommentForHostedAdmission({
      admission: await admission(),
      token,
      apiOrigin,
      fetchImpl,
    });
    await expectCode(operation, 'github_source_api_origin_invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
    try {
      await operation;
    } catch (error) {
      const loggable = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(loggable).not.toContain(token);
      expect(loggable).not.toContain(apiOrigin);
    }
  });

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
        signal: expect.any(AbortSignal),
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

  it('bounds stalled provider requests and classifies them as refetch failures', async () => {
    const sourceAdmission = await admission();
    let requestSignal: AbortSignal | null | undefined;
    let resolveFetchCalled!: () => void;
    const fetchCalled = new Promise<void>((resolve) => {
      resolveFetchCalled = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      requestSignal = init?.signal;
      resolveFetchCalled();
      return new Promise<Response>(() => {});
    });
    vi.useFakeTimers();
    try {
      const assertion = expectCode(
        refetchGitHubIssueCommentForHostedAdmission({
          admission: sourceAdmission,
          token: TOKEN,
          fetchImpl,
        }),
        'github_source_refetch_failed',
      );
      await fetchCalled;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds stalled provider response bodies and preserves invalid-body classification', async () => {
    const sourceAdmission = await admission();
    let requestSignal: AbortSignal | null | undefined;
    let resolveFetchCalled!: () => void;
    const fetchCalled = new Promise<void>((resolve) => {
      resolveFetchCalled = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      requestSignal = init?.signal;
      resolveFetchCalled();
      return {
        ok: true,
        status: 200,
        json: () => new Promise<never>(() => {}),
      } as Response;
    });
    vi.useFakeTimers();
    try {
      const assertion = expectCode(
        refetchGitHubIssueCommentForHostedAdmission({
          admission: sourceAdmission,
          token: TOKEN,
          fetchImpl,
        }),
        'github_source_refetch_failed',
      );
      await fetchCalled;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    await expectCode(
      refetchGitHubIssueCommentForHostedAdmission({
        admission: sourceAdmission,
        token: TOKEN,
        fetchImpl: vi.fn<typeof fetch>(async () => new Response('{')),
      }),
      'github_source_invalid',
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
