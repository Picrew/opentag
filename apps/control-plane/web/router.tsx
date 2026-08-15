import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  ConsoleApiError,
  type ConsoleApi,
  type ConsoleApiKey,
  type ConsoleAuditEvent,
  type ConsoleGithubBinding,
  type ConsoleMaterialAction,
  type ConsoleOverview,
  type ConsolePermission,
  type ConsoleProjectTarget,
  type ConsoleRun,
  type ConsoleRunner,
} from "./api.js";

type RouterContext = {
  api: ConsoleApi;
  queryClient: QueryClient;
};

const sessionQuery = (api: ConsoleApi) => ({
  queryKey: ["console-session"] as const,
  queryFn: api.session,
  staleTime: 10_000,
});

const tenantQueryKey = (organizationId: string, resource: string) =>
  ["tenant", organizationId, resource] as const;

function Root() {
  return <Outlet />;
}

function ErrorState({ error }: { error: unknown }) {
  const message = error instanceof ConsoleApiError
    ? `Request failed: ${error.code}`
    : "The Control Plane could not load this view.";
  return <div className="notice notice-error">{message}</div>;
}

function LoadingState() {
  return <div className="notice">Loading control-plane state…</div>;
}

const navigation = [
  ["/", "Overview"],
  ["/runners", "Runners"],
  ["/targets", "Targets"],
  ["/runs", "Runs"],
  ["/evidence", "Evidence"],
  ["/audit", "Audit"],
  ["/api-keys", "API keys"],
  ["/profile", "Profile"],
  ["/security", "Security"],
] as const;

function ConsoleShell() {
  const { api, queryClient } = authenticatedRoute.useRouteContext();
  const { principal } = authenticatedRoute.useRouteContext();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  return (
    <div className="console-shell">
      <aside className="sidebar">
        <Link to="/" className="brand" aria-label="OpenTag Control Plane home">
          <span className="brand-mark">OT</span>
          <span><strong>OpenTag</strong><small>Control Plane</small></span>
        </Link>
        <nav aria-label="Control Plane">
          {navigation.map(([to, label]) => (
            <Link key={to} to={to} activeProps={{ className: "active" }}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="operator-card">
          <strong>{principal.displayName}</strong>
          <span>{principal.email}</span>
          <span>{principal.role} · {principal.organizationId}</span>
          <button
            className="button button-secondary"
            disabled={loggingOut}
            type="button"
            onClick={async () => {
              setLoggingOut(true);
              try {
                await api.logout();
                queryClient.removeQueries();
                await navigate({ to: "/login" });
              } finally {
                setLoggingOut(false);
              }
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="workspace"><Outlet /></main>
    </div>
  );
}

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(12).max(1024),
  organizationId: z.string().trim().max(255).optional(),
});
type LoginValues = z.input<typeof loginSchema>;

function LoginPage() {
  const { api, queryClient } = loginRoute.useRouteContext();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<LoginValues>({
    defaultValues: { email: "", password: "", organizationId: "" },
  });
  return (
    <main className="auth-layout">
      <section className="auth-card">
        <div className="brand auth-brand">
          <span className="brand-mark">OT</span>
          <span><strong>OpenTag</strong><small>Control Plane</small></span>
        </div>
        <p className="eyebrow">Local-first coordination</p>
        <h1>Operate your runners without moving their workspaces to the cloud.</h1>
        <p className="muted">
          Sign in to inspect readiness, governed runs, and audit evidence for
          this installation.
        </p>
        <form
          onSubmit={handleSubmit(async (values) => {
            setServerError(null);
            const parsed = loginSchema.safeParse(values);
            if (!parsed.success) {
              setServerError("Enter a valid email and a password of at least 12 characters.");
              return;
            }
            try {
              const session = await api.login(parsed.data.organizationId
                ? {
                    email: parsed.data.email,
                    password: parsed.data.password,
                    organizationId: parsed.data.organizationId,
                  }
                : {
                    email: parsed.data.email,
                    password: parsed.data.password,
                  });
              queryClient.clear();
              queryClient.setQueryData(["console-session"], session);
              await navigate({ to: "/" });
            } catch (error) {
              setServerError(
                error instanceof ConsoleApiError
                  && error.code === "organization_required"
                  ? "This account belongs to multiple organizations. Enter the organization ID."
                  : error instanceof ConsoleApiError
                    ? "The email, password, or organization was not accepted."
                    : "The Control Plane is unavailable.",
              );
            }
          })}
        >
          <label>Email<input autoComplete="email" type="email" {...register("email")} /></label>
          <label>Password<input autoComplete="current-password" type="password" {...register("password")} /></label>
          <label>Organization ID (required for multi-organization accounts)<input autoComplete="organization" type="text" {...register("organizationId")} /></label>
          {serverError ? <div className="notice notice-error">{serverError}</div> : null}
          <button className="button" disabled={formState.isSubmitting} type="submit">
            {formState.isSubmitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <Link to="/recovery" className="text-link">Account recovery</Link>
      </section>
    </main>
  );
}

function RecoveryPage() {
  return (
    <main className="auth-layout">
      <section className="auth-card">
        <p className="eyebrow">Fail-closed recovery</p>
        <h1>Recovery is installation-managed.</h1>
        <p className="muted">
          Contact an installation owner to reset access. This build does not
          send recovery mail until a mail adapter and public origin are configured.
        </p>
        <Link to="/login" className="button button-secondary">Back to sign in</Link>
      </section>
    </main>
  );
}

function Page({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <section className="page">
      <header className="page-header"><p className="eyebrow">Control Plane</p><h1>{title}</h1><p>{intro}</p></header>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <article className="metric"><span>{label}</span><strong>{value}</strong></article>;
}

function OverviewPage() {
  const { api, principal } = overviewRoute.useRouteContext();
  const query = useQuery({
    queryKey: tenantQueryKey(principal.organizationId, "overview"),
    queryFn: api.overview,
  });
  return <Page title="System overview" intro="Live, tenant-scoped operational state from PostgreSQL.">
    {query.isPending ? <LoadingState /> : query.error ? <ErrorState error={query.error} /> : (
      <div className="metrics">
        <Metric label="Runners" value={(query.data as ConsoleOverview).runnerCount} />
        <Metric label="Ready" value={query.data.readyRunnerCount} />
        <Metric label="Active runs" value={query.data.activeRunCount} />
        <Metric label="Terminal runs" value={query.data.terminalRunCount} />
        <Metric label="Pending jobs" value={query.data.pendingJobCount} />
      </div>
    )}
  </Page>;
}

function DataTable({ headings, rows }: { headings: string[]; rows: ReactNode[][] }) {
  return <div className="table-wrap"><table><thead><tr>{headings.map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
}

function RunnersPage() {
  const { api, principal } = runnersRoute.useRouteContext();
  const query = useQuery({
    queryKey: tenantQueryKey(principal.organizationId, "runners"),
    queryFn: api.runners,
  });
  return <Page title="Runners" intro="Paired local runtimes and their latest readiness evidence.">
    {query.isPending ? <LoadingState /> : query.error ? <ErrorState error={query.error} /> : (
      <DataTable headings={["Runner", "Generation", "Capabilities", "Readiness", "Updated"]} rows={query.data.map((runner: ConsoleRunner) => [
        <strong>{runner.displayName ?? runner.runnerId}</strong>,
        `${runner.registrationGeneration} / credential ${runner.credentialGeneration}`,
        runner.capabilities.join(", "),
        runner.readiness ? "reported" : "not reported",
        new Date(runner.updatedAt).toLocaleString(),
      ])} />
    )}
  </Page>;
}

function TargetsPage() {
  const { api, principal, queryClient } = targetsRoute.useRouteContext();
  const query = useQuery({
    queryKey: tenantQueryKey(principal.organizationId, "project-targets"),
    queryFn: api.projectTargets,
  });
  if (query.isPending) return <Page title="Targets & ingress" intro="Project Targets bind a provider repository to one approved local runner."><LoadingState /></Page>;
  if (query.error) return <Page title="Targets & ingress" intro="Project Targets bind a provider repository to one approved local runner."><ErrorState error={query.error} /></Page>;
  const canAdminister = principal.role === "owner" || principal.role === "admin";
  return <Page title="Targets & ingress" intro="Project Targets bind a provider repository to one approved local runner.">
    <h2>Project Targets</h2>
    {canAdminister ? <ProjectTargetForm onCreate={async (command) => {
      await api.createProjectTarget(command);
      await queryClient.invalidateQueries({
        queryKey: tenantQueryKey(principal.organizationId, "project-targets"),
      });
    }} /> : null}
    {query.data.targets.length === 0 ? <div className="notice">No Project Targets. Pair a runner, then declare its repository binding here.</div> : (
      <DataTable headings={["Target", "Repository", "Runner", "Executor", "Version"]} rows={query.data.targets.map((target: ConsoleProjectTarget) => [
        target.projectTargetId,
        `${target.provider}:${target.owner}/${target.repo}`,
        target.runnerId,
        target.defaultExecutor,
        target.version,
      ])} />
    )}
    <h2>GitHub ingress bindings</h2>
    {canAdminister && query.data.targets.length > 0 ? <GithubBindingForm
      targets={query.data.targets}
      onCreate={async (command) => {
        const outcome = await api.createGithubBinding(command);
        await queryClient.invalidateQueries({
          queryKey: tenantQueryKey(principal.organizationId, "project-targets"),
        });
        return outcome;
      }}
    /> : null}
    {query.data.bindings.length === 0 ? <div className="notice">No GitHub ingress bindings. Ingress remains fail-closed.</div> : (
      <DataTable headings={["Binding", "Repository", "Runner", "Actors", "State"]} rows={query.data.bindings.map((binding: ConsoleGithubBinding) => [
        binding.bindingId,
        `${binding.owner}/${binding.repo}`,
        binding.runnerId,
        binding.allowedActorIds.join(", "),
        binding.enabled ? "enabled" : "disabled",
      ])} />
    )}
  </Page>;
}

function ProjectTargetForm({
  onCreate,
}: {
  onCreate(command: {
    projectTargetId: string;
    runnerId: string;
    bindingDigest: string;
    provider: string;
    owner: string;
    repo: string;
    defaultExecutor: string;
    defaultBranch: string | null;
    version: number;
  }): Promise<void>;
}) {
  const [projectTargetId, setProjectTargetId] = useState("");
  const [runnerId, setRunnerId] = useState("");
  const [bindingDigest, setBindingDigest] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [defaultExecutor, setDefaultExecutor] = useState("codex");
  const [defaultBranch, setDefaultBranch] = useState("main");
  return <form className="binding-form" onSubmit={async (event) => {
    event.preventDefault();
    await onCreate({
      projectTargetId,
      runnerId,
      bindingDigest,
      provider: "github",
      owner,
      repo,
      defaultExecutor,
      defaultBranch: defaultBranch || null,
      version: 1,
    });
    setProjectTargetId("");
    setBindingDigest("");
  }}>
    <label>Target ID<input required value={projectTargetId} onChange={(event) => setProjectTargetId(event.target.value)} /></label>
    <label>Runner ID<input required value={runnerId} onChange={(event) => setRunnerId(event.target.value)} /></label>
    <label>Repository owner<input required value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
    <label>Repository name<input required value={repo} onChange={(event) => setRepo(event.target.value)} /></label>
    <label>Binding digest<input required pattern="sha256:[a-f0-9]{64}" placeholder="sha256:…" value={bindingDigest} onChange={(event) => setBindingDigest(event.target.value)} /></label>
    <label>Default executor<input required value={defaultExecutor} onChange={(event) => setDefaultExecutor(event.target.value)} /></label>
    <label>Default branch<input value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} /></label>
    <button className="button" type="submit">Declare Project Target</button>
  </form>;
}

function GithubBindingForm({
  targets,
  onCreate,
}: {
  targets: ConsoleProjectTarget[];
  onCreate(command: {
    bindingId: string;
    providerRepositoryId: string;
    owner: string;
    repo: string;
    runnerId: string;
    projectTargetId: string;
    allowedActorIds: string[];
    enabled: boolean;
  }): Promise<{ kind: "created" | "replayed"; bindingId: string; secret?: string }>;
}) {
  const [targetId, setTargetId] = useState(targets[0]?.projectTargetId ?? "");
  const [bindingId, setBindingId] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [actorIds, setActorIds] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const target = targets.find((candidate) => candidate.projectTargetId === targetId);
  return <form className="binding-form" onSubmit={async (event) => {
    event.preventDefault();
    if (!target) return;
    const outcome = await onCreate({
      bindingId,
      providerRepositoryId: repositoryId,
      owner: target.owner,
      repo: target.repo,
      runnerId: target.runnerId,
      projectTargetId: target.projectTargetId,
      allowedActorIds: actorIds.split(",").map((value) => value.trim()).filter(Boolean),
      enabled: true,
    });
    setSecret(outcome.secret ?? null);
  }}>
    <label>Project Target<select value={targetId} onChange={(event) => setTargetId(event.target.value)}>{targets.map((item) => <option key={item.projectTargetId} value={item.projectTargetId}>{item.owner}/{item.repo} · {item.runnerId}</option>)}</select></label>
    <label>Binding ID<input required value={bindingId} onChange={(event) => setBindingId(event.target.value)} /></label>
    <label>GitHub repository ID<input required inputMode="numeric" value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)} /></label>
    <label>Allowed actor IDs<input required placeholder="1001, 1002" value={actorIds} onChange={(event) => setActorIds(event.target.value)} /></label>
    <button className="button" type="submit">Create enabled binding</button>
    {secret ? <div className="notice form-span"><strong>Copy the webhook secret now.</strong><br /><code>{secret}</code></div> : null}
  </form>;
}

function RunsPage() {
  const { api, principal } = runsRoute.useRouteContext();
  const query = useQuery({
    queryKey: tenantQueryKey(principal.organizationId, "runs"),
    queryFn: api.runs,
  });
  return <Page title="Governed runs" intro="Admission, claim, attempt, and terminal state owned by the hosted coordinator.">
    {query.isPending ? <LoadingState /> : query.error ? <ErrorState error={query.error} /> : (
      <DataTable headings={["Run", "Runner", "Executor", "State", "Attempt", "Updated"]} rows={query.data.map((run: ConsoleRun) => [
        <code>{run.runId}</code>, run.runnerId, run.executorId,
        run.terminalKind ?? run.state, run.currentAttemptNumber,
        new Date(run.updatedAt).toLocaleString(),
      ])} />
    )}
  </Page>;
}

function AuditPage() {
  const { api, principal } = auditRoute.useRouteContext();
  const query = useQuery({
    queryKey: tenantQueryKey(principal.organizationId, "audit"),
    queryFn: api.audit,
  });
  return <Page title="Audit evidence" intro="Append-only coordination evidence, newest first.">
    {query.isPending ? <LoadingState /> : query.error ? <ErrorState error={query.error} /> : (
      <DataTable headings={["Sequence", "Run", "Event", "Observed"]} rows={query.data.map((event: ConsoleAuditEvent) => [
        event.sequenceId, event.runId ? <code>{event.runId}</code> : "management", event.eventKind,
        new Date(event.createdAt).toLocaleString(),
      ])} />
    )}
  </Page>;
}

function EvidencePage() {
  const { api, principal } = evidenceRoute.useRouteContext();
  const query = useQuery({
    queryKey: tenantQueryKey(principal.organizationId, "evidence"),
    queryFn: api.evidence,
  });
  return <Page title="Governed evidence" intro="Attempt-scoped permissions and append-only provider action receipts.">
    {query.isPending ? <LoadingState /> : query.error ? <ErrorState error={query.error} /> : <>
      <h2>Permissions</h2>
      {query.data.permissions.length === 0 ? <div className="notice">No governed permission requests.</div> : (
        <DataTable headings={["Request", "Run", "Action", "State", "Updated"]} rows={query.data.permissions.map((permission: ConsolePermission) => [
          <code>{permission.permissionRequestId}</code>,
          <code>{permission.runId}</code>,
          permission.actionId,
          permission.state,
          new Date(permission.updatedAt).toLocaleString(),
        ])} />
      )}
      <h2>Material actions</h2>
      {query.data.materialActions.length === 0 ? <div className="notice">No provider action receipts.</div> : (
        <DataTable headings={["Receipt", "Run", "Action", "Outcome", "Updated"]} rows={query.data.materialActions.map((action: ConsoleMaterialAction) => [
          <code>{action.receiptId}</code>,
          <code>{action.runId}</code>,
          action.actionId,
          action.outcome,
          new Date(action.updatedAt).toLocaleString(),
        ])} />
      )}
    </>}
  </Page>;
}

function ApiKeysPage() {
  const { api, queryClient, principal } = apiKeysRoute.useRouteContext();
  const apiKeysQueryKey = tenantQueryKey(principal.organizationId, "api-keys");
  const query = useQuery({ queryKey: apiKeysQueryKey, queryFn: api.apiKeys });
  const [label, setLabel] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [canResolvePermissions, setCanResolvePermissions] = useState(false);
  const canAdminister = principal.role === "owner" || principal.role === "admin";
  return <Page title="API keys" intro="Machine credentials are tenant-scoped and separate from runner and browser sessions.">
    {createdToken ? <div className="notice"><strong>Copy this token now.</strong><br /><code>{createdToken}</code><br />It will not be shown again.</div> : null}
    {canAdminister ? <form className="inline-form" onSubmit={async (event) => {
      event.preventDefault();
      const created = await api.createApiKey({
        label,
        scopes: [
          "audit:read",
          ...(canResolvePermissions ? ["permission:resolve"] : []),
          "run:read",
          "runner:read",
          "target:read",
        ],
      });
      setCreatedToken(created.token);
      setLabel("");
      setCanResolvePermissions(false);
      await queryClient.invalidateQueries({ queryKey: apiKeysQueryKey });
    }}>
      <label>Key label<input required maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <label><input checked={canResolvePermissions} type="checkbox" onChange={(event) => setCanResolvePermissions(event.target.checked)} /> Allow governed permission decisions</label>
      <button className="button" type="submit">Create API key</button>
    </form> : <div className="notice">Only an owner or administrator can issue API keys.</div>}
    {query.isPending ? <LoadingState /> : query.error ? <ErrorState error={query.error} /> : query.data.length === 0 ? <div className="notice">No API keys have been issued.</div> : (
      <DataTable headings={["Label", "Scopes", "Created", "State", "Action"]} rows={query.data.map((apiKey: ConsoleApiKey) => [
        apiKey.label,
        apiKey.scopes.join(", "),
        new Date(apiKey.createdAt).toLocaleString(),
        apiKey.revokedAt ? "revoked" : "active",
        canAdminister && !apiKey.revokedAt ? <button className="text-button" type="button" onClick={async () => {
          await api.revokeApiKey(apiKey.apiKeyId);
          await queryClient.invalidateQueries({ queryKey: apiKeysQueryKey });
        }}>Revoke</button> : "—",
      ])} />
    )}
  </Page>;
}

function ProfilePage() {
  const { principal } = profileRoute.useRouteContext();
  return <Page title="Profile" intro="Authenticated identity for this installation.">
    <dl className="details"><div><dt>Name</dt><dd>{principal.displayName}</dd></div><div><dt>Email</dt><dd>{principal.email}</dd></div><div><dt>Role</dt><dd>{principal.role}</dd></div><div><dt>Organization</dt><dd>{principal.organizationId}</dd></div></dl>
  </Page>;
}

function SecurityPage() {
  return <Page title="Security" intro="Authority boundaries enforced by this installation.">
    <ul className="security-list"><li>Browser mutations require the configured same origin.</li><li>Runner credentials are hashed and isolated from browser sessions.</li><li>Repository and coding-agent credentials remain on paired local runners.</li><li>Terminal run settlement is fenced and written by one coordinator.</li></ul>
  </Page>;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Root });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage });
const recoveryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/recovery", component: RecoveryPage });
const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_authenticated",
  beforeLoad: async ({ context }) => {
    try {
      return {
        principal: (await context.queryClient.ensureQueryData(
          sessionQuery(context.api),
        )).principal,
      };
    } catch {
      throw redirect({ to: "/login" });
    }
  },
  component: ConsoleShell,
});
const protectedContext = () => authenticatedRoute;
const overviewRoute = createRoute({ getParentRoute: protectedContext, path: "/", component: OverviewPage });
const runnersRoute = createRoute({ getParentRoute: protectedContext, path: "/runners", component: RunnersPage });
const targetsRoute = createRoute({ getParentRoute: protectedContext, path: "/targets", component: TargetsPage });
const runsRoute = createRoute({ getParentRoute: protectedContext, path: "/runs", component: RunsPage });
const evidenceRoute = createRoute({ getParentRoute: protectedContext, path: "/evidence", component: EvidencePage });
const auditRoute = createRoute({ getParentRoute: protectedContext, path: "/audit", component: AuditPage });
const apiKeysRoute = createRoute({ getParentRoute: protectedContext, path: "/api-keys", component: ApiKeysPage });
const profileRoute = createRoute({ getParentRoute: protectedContext, path: "/profile", component: ProfilePage });
const securityRoute = createRoute({ getParentRoute: protectedContext, path: "/security", component: SecurityPage });
const routeTree = rootRoute.addChildren([
  loginRoute,
  recoveryRoute,
  authenticatedRoute.addChildren([
    overviewRoute, runnersRoute, targetsRoute, runsRoute, evidenceRoute, auditRoute,
    apiKeysRoute, profileRoute, securityRoute,
  ]),
]);

export function createConsoleRouter(context: RouterContext) {
  return createRouter({ context, routeTree, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createConsoleRouter>;
  }
}
