export class ConsoleApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "ConsoleApiError";
  }
}

export type ConsolePrincipal = {
  operatorId: string;
  organizationId: string;
  email: string;
  displayName: string;
  role: "owner" | "admin" | "operator" | "viewer";
};

export type ConsoleOverview = {
  runnerCount: number;
  readyRunnerCount: number;
  activeRunCount: number;
  terminalRunCount: number;
  pendingJobCount: number;
};

export type ConsoleRunner = {
  runnerId: string;
  displayName: string | null;
  registrationGeneration: number;
  credentialGeneration: number;
  capabilities: string[];
  readiness: unknown | null;
  updatedAt: string;
};

export type ConsoleRun = {
  runId: string;
  runnerId: string;
  executorId: string;
  state: string;
  currentAttemptNumber: number;
  terminalKind: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConsoleAuditEvent = {
  sequenceId: string;
  runId: string | null;
  eventKind: string;
  event: unknown;
  createdAt: string;
};

export type ConsolePermission = {
  permissionRequestId: string;
  runId: string;
  runnerId: string;
  attemptId: string;
  actionId: string;
  state: string;
  request: unknown;
  currentReceipt: unknown;
  updatedAt: string;
};

export type ConsoleMaterialAction = {
  runId: string;
  attemptId: string;
  actionId: string;
  receiptId: string;
  receiptDigest: string;
  outcome: string;
  receipt: unknown;
  updatedAt: string;
};

export type ConsoleProjectTarget = {
  projectTargetId: string;
  runnerId: string;
  provider: string;
  owner: string;
  repo: string;
  defaultExecutor: string;
  defaultBranch: string | null;
  version: number;
  updatedAt: string;
};

export type ConsoleGithubBinding = {
  bindingId: string;
  providerRepositoryId: string;
  owner: string;
  repo: string;
  runnerId: string;
  projectTargetId: string;
  secretVersion: string;
  allowedActorIds: string[];
  enabled: boolean;
  updatedAt: string;
};

export type ConsoleApiKey = {
  apiKeyId: string;
  label: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
};

type FetchImplementation = typeof fetch;

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  let code = "request_failed";
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") code = body.error;
  } catch {
    // The public error remains closed when an intermediary returns non-JSON.
  }
  throw new ConsoleApiError(code, response.status);
}

export function createConsoleApi(fetchImplementation: FetchImplementation = fetch) {
  const request = async <T>(path: string, init: RequestInit = {}) =>
    parseResponse<T>(
      await fetchImplementation(path, {
        ...init,
        credentials: "same-origin",
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      }),
    );

  return {
    session: () => request<{ principal: ConsolePrincipal }>("/api/console/session"),
    login: (input: {
      email: string;
      password: string;
      organizationId?: string;
    }) =>
      request<{ principal: ConsolePrincipal; expiresAt: string }>(
        "/api/console/session",
        { method: "POST", body: JSON.stringify(input) },
      ),
    logout: () => request<void>("/api/console/session", { method: "DELETE" }),
    overview: async () =>
      (await request<{ overview: ConsoleOverview }>("/api/console/overview"))
        .overview,
    runners: async () =>
      (await request<{ runners: ConsoleRunner[] }>("/api/console/runners"))
        .runners,
    runs: async () =>
      (await request<{ runs: ConsoleRun[] }>("/api/console/runs")).runs,
    audit: async () =>
      (await request<{ events: ConsoleAuditEvent[] }>("/api/console/audit"))
        .events,
    evidence: () => request<{
      materialActions: ConsoleMaterialAction[];
      permissions: ConsolePermission[];
    }>("/api/console/evidence"),
    projectTargets: () =>
      request<{
        bindings: ConsoleGithubBinding[];
        targets: ConsoleProjectTarget[];
      }>("/api/console/project-targets"),
    createProjectTarget: (input: {
      projectTargetId: string;
      runnerId: string;
      bindingDigest: string;
      provider: string;
      owner: string;
      repo: string;
      defaultExecutor: string;
      defaultBranch: string | null;
      version: number;
    }) => request<{
      outcome: "created" | "updated";
      projectTargetId: string;
    }>("/api/console/project-targets", {
      method: "POST",
      body: JSON.stringify(input),
    }),
    createGithubBinding: (input: {
      bindingId: string;
      providerRepositoryId: string;
      owner: string;
      repo: string;
      runnerId: string;
      projectTargetId: string;
      allowedActorIds: string[];
      enabled: boolean;
    }) => request<{
      kind: "created" | "replayed";
      bindingId: string;
      secret?: string;
    }>("/api/console/github-bindings", {
      method: "POST",
      body: JSON.stringify(input),
    }),
    apiKeys: async () =>
      (await request<{ apiKeys: ConsoleApiKey[] }>("/api/console/api-keys"))
        .apiKeys,
    createApiKey: (input: { label: string; scopes: string[] }) =>
      request<{ apiKey: ConsoleApiKey; token: string }>(
        "/api/console/api-keys",
        { method: "POST", body: JSON.stringify(input) },
      ),
    revokeApiKey: (apiKeyId: string) =>
      request<void>(`/api/console/api-keys/${encodeURIComponent(apiKeyId)}`, {
        method: "DELETE",
      }),
  };
}

export type ConsoleApi = ReturnType<typeof createConsoleApi>;
