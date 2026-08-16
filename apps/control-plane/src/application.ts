import {
  HostedClaimRequestV1Schema,
  HostedCancelRequestV1Schema,
  HostedCompleteRequestV1Schema,
  HostedHeartbeatRequestV1Schema,
  HostedProgressRequestV1Schema,
  HostedRejectStartRequestV1Schema,
  HostedRunningRequestV1Schema,
  HumanPermissionDecisionRequestV1Schema,
  MaterialActionReceiptEnvelopeV1Schema,
  RelayCapabilitiesResponseV1Schema,
  RunnerMaterialActionReconcileRequestV1Schema,
  RunnerPermissionCurrentQueryV1Schema,
  RunnerPermissionRequestV1Schema,
  RunnerReadinessReceiptEnvelopeV1Schema,
  RunnerCredentialReprovisionRequestV1Schema,
  RunnerRegistrationRequestV1Schema,
  type RelayCapability,
} from "@opentag/control-protocol";
import { randomUUID } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ZodError } from "zod";
import type { ConsoleReadModel } from "./modules/console-reads/index.js";
import type { HostedRunCoordinator } from "./modules/hosted-runs/index.js";
import type { PermissionCoordinator } from "./modules/hosted-runs/permissions.js";
import type { MaterialActionCoordinator } from "./modules/hosted-runs/material-actions.js";
import type { GithubIngress } from "./modules/github-ingress/index.js";
import type {
  ConsolePrincipal,
  IdentityModule,
} from "./modules/identity/index.js";
import type {
  RunnerDirectory,
  RuntimePrincipal,
} from "./modules/runners/index.js";

export type RelayCapabilitiesResponseV1 = ReturnType<
  typeof RelayCapabilitiesResponseV1Schema.parse
>;

export type ReadinessResult =
  | { ready: true }
  | {
      ready: false;
      reason:
        | "configuration_invalid"
        | "database_unavailable"
        | "migrations_pending"
        | "coordination_unavailable";
    };

export type ControlPlaneDependencies = {
  capabilities: RelayCapabilitiesResponseV1;
  readiness: {
    check(): Promise<ReadinessResult>;
  };
  control?: {
    bootstrap: {
      authenticate(token: string): {
        organizationId: string;
        organizationName: string;
      } | null;
    };
    recovery?: {
      authenticate(token: string): {
        organizationId: string;
      } | null;
    };
    runners: RunnerDirectory;
    hosted: HostedRunCoordinator;
    materials?: MaterialActionCoordinator;
    permissions?: PermissionCoordinator;
    approver?: {
      authenticate(token: string): Promise<
        | {
            kind: "authenticated";
            principal: { organizationId: string; actorId: string };
          }
        | { kind: "invalid_credential" }
        | { kind: "insufficient_scope" }
      >;
    };
  };
  console?: {
    identity: IdentityModule;
    reads: ConsoleReadModel;
    publicOrigin: string;
    loginNetworkMode?: "direct-peer" | "trusted-edge";
    targets?: Pick<RunnerDirectory, "declareProjectTarget">;
  };
  github?: Pick<GithubIngress, "receive"> & Partial<Pick<GithubIngress, "createBinding">>;
};

export type ControlPlaneApplication = {
  fetch(request: Request): Promise<Response>;
};

export function createControlPlaneApplication(
  dependencies: ControlPlaneDependencies,
): ControlPlaneApplication {
  const capabilities = RelayCapabilitiesResponseV1Schema.parse(dependencies.capabilities);
  const app = new Hono();

  app.onError((error, context) => {
    const requestId = randomUUID();
    console.error("control_plane_request_failed", {
      requestId,
      method: context.req.method,
      path: context.req.path,
      classification: error instanceof ZodError
        ? "validation_error"
        : "unexpected_error",
    });
    return context.json({ error: "internal_error", requestId }, 500);
  });

  app.use("*", async (context, next) => {
    await next();
    context.header("x-content-type-options", "nosniff");
    context.header("x-frame-options", "DENY");
    context.header("referrer-policy", "no-referrer");
    context.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (
      context.req.path.startsWith("/api/console/")
      || context.req.path.startsWith("/v1/")
    ) {
      context.header("cache-control", "no-store");
    }
  });

  const controlError = (
    error:
      | "invalid_credential"
      | "insufficient_scope"
      | "missing_or_concealed"
      | "invalid_request_body"
      | "idempotency_conflict"
      | "stale_attempt"
      | "invalid_state_transition",
    requestId = "request_unknown",
  ) => ({
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    error,
    message: error === "invalid_credential"
      ? "The supplied credential is not valid for this request."
      : error === "insufficient_scope"
        ? "The supplied credential lacks the required scope."
        : error === "missing_or_concealed"
          ? "The requested resource is unavailable."
      : "The Control V1 request could not be accepted.",
    requestId,
  });

  const bearerToken = (request: Request): string | null => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return null;
    const token = authorization.slice("Bearer ".length);
    return token && token === token.trim() ? token : null;
  };

  const runtimePrincipal = async (
    request: Request,
  ): Promise<RuntimePrincipal | null> => {
    const token = bearerToken(request);
    if (!token || !dependencies.control) return null;
    const outcome = await dependencies.control.runners.authenticate(token);
    return outcome.kind === "authenticated" ? outcome.principal : null;
  };

  const boundedBody = (maxSize: number) => bodyLimit({
    maxSize,
    onError: (context) => context.json({ error: "payload_too_large" }, 413),
  });
  app.use("/v1/*", async (context, next) => {
    const maxSize = context.req.path.startsWith(
      "/v1/providers/github/webhooks/",
    )
      ? 10 * 1024 * 1024
      : 256 * 1024;
    return boundedBody(maxSize)(context, next);
  });
  app.use("/api/console/*", boundedBody(64 * 1024));

  app.get("/healthz", (context) => context.json({ status: "ok" }));

  app.get("/readyz", async (context) => {
    const readiness = await dependencies.readiness.check();
    if (!readiness.ready) {
      return context.json(
        { status: "not_ready", reason: readiness.reason } as const,
        503,
      );
    }
    return context.json({ status: "ready" } as const);
  });

  app.get("/v1/relay/capabilities", (context) => context.json(capabilities));

  if (dependencies.github) {
    app.post("/v1/providers/github/webhooks/:bindingId", async (context) => {
      const deliveryId = context.req.header("x-github-delivery");
      const eventName = context.req.header("x-github-event");
      const signature = context.req.header("x-hub-signature-256");
      if (!deliveryId || !eventName || !signature) {
        return context.json({ error: "invalid_github_delivery" }, 400);
      }
      const outcome = await dependencies.github!.receive({
        bindingId: context.req.param("bindingId"),
        deliveryId,
        eventName,
        signature,
        body: new Uint8Array(await context.req.raw.arrayBuffer()),
      });
      if (outcome.kind === "invalid_binding_or_signature") {
        return context.json({ error: "not_found" }, 404);
      }
      if (outcome.kind === "invalid_payload") {
        return context.json({ error: "invalid_github_delivery" }, 400);
      }
      if (outcome.kind === "rejected_authority") {
        return context.json({ error: "forbidden_provider_principal" }, 403);
      }
      if (
        outcome.kind === "runner_not_ready"
        || outcome.kind === "admission_conflict"
        || outcome.kind === "delivery_conflict"
        || outcome.kind === "delivery_in_progress"
      ) {
        return context.json({ error: outcome.kind }, 409);
      }
      if (outcome.kind === "replayed" || outcome.kind === "evidence_replayed") {
        return context.json(outcome, 200);
      }
      return context.json(outcome, 202);
    });
  }

  if (dependencies.control) {
    const control = dependencies.control;

    app.post("/v1/runners", async (context) => {
      const token = bearerToken(context.req.raw);
      const bootstrap = token ? control.bootstrap.authenticate(token) : null;
      if (!bootstrap) {
        return context.json(controlError("invalid_credential"), 401);
      }
      let request: ReturnType<typeof RunnerRegistrationRequestV1Schema.parse>;
      try {
        request = RunnerRegistrationRequestV1Schema.parse(
          await context.req.json(),
        );
      } catch {
        return context.json(controlError("invalid_request_body"), 400);
      }
      const result = await control.runners.register({
        organizationId: bootstrap.organizationId,
        organizationName: bootstrap.organizationName,
        request,
      });
      if (result.kind === "created") return context.json(result.response, 201);
      if (result.kind === "replayed") return context.json(result.response, 200);
      return context.json(
        controlError("idempotency_conflict", request.requestId),
        409,
      );
    });

    app.post(
      "/v1/runners/:runnerId/credentials/reprovision",
      async (context) => {
        const token = bearerToken(context.req.raw);
        const recovery = token && control.recovery
          ? control.recovery.authenticate(token)
          : null;
        if (!recovery) {
          return context.json(controlError("invalid_credential"), 401);
        }
        let request: ReturnType<
          typeof RunnerCredentialReprovisionRequestV1Schema.parse
        >;
        try {
          request = RunnerCredentialReprovisionRequestV1Schema.parse(
            await context.req.json(),
          );
        } catch {
          return context.json(controlError("invalid_request_body"), 400);
        }
        if (request.runnerId !== context.req.param("runnerId")) {
          return context.json(
            controlError("stale_attempt", request.requestId),
            409,
          );
        }
        const outcome = await control.runners.reprovision({
          organizationId: recovery.organizationId,
          request,
        });
        if (outcome.kind === "created") {
          return context.json(outcome.response, 201);
        }
        if (outcome.kind === "replayed") {
          return context.json(outcome.response, 200);
        }
        return context.json(
          controlError(
            outcome.reason === "operation_mismatch"
              ? "idempotency_conflict"
              : "stale_attempt",
            request.requestId,
          ),
          409,
        );
      },
    );

    app.get("/v1/runners/:runnerId/control-context", async (context) => {
      const principal = await runtimePrincipal(context.req.raw);
      if (!principal) {
        return context.json(controlError("invalid_credential"), 401);
      }
      if (principal.runnerId !== context.req.param("runnerId")) {
        return context.json(
          {
            schemaVersion: 1 as const,
            protocolVersion: "1.0" as const,
            error: "missing_or_concealed" as const,
            message: "The requested runner is unavailable.",
            requestId: "request_unknown",
          },
          404,
        );
      }
      return context.json(await control.runners.getControlContext(principal));
    });

    app.post("/v1/runners/:runnerId/readiness", async (context) => {
      const principal = await runtimePrincipal(context.req.raw);
      if (!principal) {
        return context.json(controlError("invalid_credential"), 401);
      }
      let receipt: ReturnType<
        typeof RunnerReadinessReceiptEnvelopeV1Schema.parse
      >;
      try {
        receipt = RunnerReadinessReceiptEnvelopeV1Schema.parse(
          await context.req.json(),
        );
      } catch {
        return context.json(controlError("invalid_request_body"), 400);
      }
      if (principal.runnerId !== context.req.param("runnerId")) {
        return context.json(
          controlError("stale_attempt", receipt.operationId),
          409,
        );
      }
      const outcome = await control.runners.recordReadiness({
        principal,
        receipt,
      });
      if (outcome.kind === "recorded") return context.json(outcome.receipt, 201);
      if (outcome.kind === "replayed") return context.json(outcome.receipt, 200);
      return context.json(
        controlError("stale_attempt", receipt.operationId),
        409,
      );
    });

    app.post("/v1/runners/:runnerId/hosted-claims", async (context) => {
      const principal = await runtimePrincipal(context.req.raw);
      if (!principal) {
        return context.json(controlError("invalid_credential"), 401);
      }
      let request: ReturnType<typeof HostedClaimRequestV1Schema.parse>;
      try {
        request = HostedClaimRequestV1Schema.parse(await context.req.json());
      } catch {
        return context.json(controlError("invalid_request_body"), 400);
      }
      if (principal.runnerId !== context.req.param("runnerId")) {
        return context.json(
          controlError("stale_attempt", request.requestId),
          409,
        );
      }
      const outcome = await control.hosted.claim({ principal, request });
      if (outcome.kind === "claimed" || outcome.kind === "replayed") {
        return context.json(outcome.claim, 200);
      }
      if (outcome.kind === "empty") return context.body(null, 204);
      return context.json(
        controlError("idempotency_conflict", request.requestId),
        409,
      );
    });

    if (control.permissions) {
      const permissions = control.permissions;

      app.post(
        "/v1/runners/:runnerId/runs/:runId/action-permissions",
        async (context) => {
          const principal = await runtimePrincipal(context.req.raw);
          if (!principal) {
            return context.json(controlError("invalid_credential"), 401);
          }
          let request: ReturnType<typeof RunnerPermissionRequestV1Schema.parse>;
          try {
            request = RunnerPermissionRequestV1Schema.parse(
              await context.req.json(),
            );
          } catch {
            return context.json(controlError("invalid_request_body"), 400);
          }
          if (
            principal.runnerId !== context.req.param("runnerId")
            || request.runnerId !== context.req.param("runnerId")
            || request.runId !== context.req.param("runId")
          ) {
            return context.json(
              controlError("stale_attempt", request.requestId),
              409,
            );
          }
          const outcome = await permissions.request({ principal, request });
          if (outcome.kind === "waiting" || outcome.kind === "replayed") {
            return context.json(outcome.receipt, 202);
          }
          return context.json(
            controlError(
              outcome.kind === "stale_fence"
                ? "stale_attempt"
                : "idempotency_conflict",
              request.requestId,
            ),
            409,
          );
        },
      );

      app.post(
        "/v1/runners/:runnerId/runs/:runId/action-permissions/:actionId/resolve",
        async (context) => {
          let decision: ReturnType<
            typeof HumanPermissionDecisionRequestV1Schema.parse
          >;
          try {
            decision = HumanPermissionDecisionRequestV1Schema.parse(
              await context.req.json(),
            );
          } catch {
            return context.json(controlError("invalid_request_body"), 400);
          }
          const token = bearerToken(context.req.raw);
          const authentication = token && control.approver
            ? await control.approver.authenticate(token)
            : { kind: "invalid_credential" as const };
          if (authentication.kind === "invalid_credential") {
            return context.json(
              controlError("invalid_credential", decision.requestId),
              401,
            );
          }
          if (authentication.kind === "insufficient_scope") {
            return context.json(
              controlError("insufficient_scope", decision.requestId),
              403,
            );
          }
          if (
            decision.runId !== context.req.param("runId")
            || decision.actionId !== context.req.param("actionId")
          ) {
            return context.json(
              controlError("stale_attempt", decision.requestId),
              409,
            );
          }
          const outcome = await permissions.resolve({
            principal: authentication.principal,
            runnerId: context.req.param("runnerId"),
            decision,
          });
          if (outcome.kind === "resolved" || outcome.kind === "replayed") {
            return context.json(outcome.receipt, 200);
          }
          return context.json(
            controlError(
              outcome.kind === "stale_fence"
                ? "stale_attempt"
                : "idempotency_conflict",
              decision.requestId,
            ),
            409,
          );
        },
      );

      app.get(
        "/v1/runners/:runnerId/runs/:runId/action-permissions/:actionId/current",
        async (context) => {
          const principal = await runtimePrincipal(context.req.raw);
          if (!principal) {
            return context.json(controlError("invalid_credential"), 401);
          }
          let query: ReturnType<typeof RunnerPermissionCurrentQueryV1Schema.parse>;
          try {
            query = RunnerPermissionCurrentQueryV1Schema.parse({
              organizationId: context.req.query("organizationId"),
              runnerId: context.req.param("runnerId"),
              runId: context.req.param("runId"),
              attempt: {
                attemptId: context.req.query("attemptId"),
                attemptNumber: Number(context.req.query("attemptNumber")),
                epoch: Number(context.req.query("epoch")),
                fencingTokenDigest: context.req.query("fencingTokenDigest"),
              },
              actionId: context.req.param("actionId"),
              permissionRequestId: context.req.query("permissionRequestId"),
              permissionRequestDigest: context.req.query(
                "permissionRequestDigest",
              ),
            });
          } catch {
            return context.json(controlError("invalid_request_body"), 400);
          }
          const outcome = await permissions.current({ principal, query });
          if (outcome.kind === "waiting") {
            return context.json(outcome.receipt, 202);
          }
          if (outcome.kind === "resolved") {
            return context.json(outcome.receipt, 200);
          }
          if (outcome.kind === "missing") {
            return context.json(controlError("missing_or_concealed"), 404);
          }
          return context.json(controlError("stale_attempt"), 409);
        },
      );
    }

    if (control.materials) {
      const materials = control.materials;

      app.post(
        "/v1/runners/:runnerId/runs/:runId/material-actions/:actionId/receipt",
        async (context) => {
          const principal = await runtimePrincipal(context.req.raw);
          if (!principal) {
            return context.json(controlError("invalid_credential"), 401);
          }
          let body: {
            fencingToken: string;
            receipt: ReturnType<typeof MaterialActionReceiptEnvelopeV1Schema.parse>;
          };
          try {
            const raw = await context.req.json() as Record<string, unknown>;
            if (
              typeof raw !== "object"
              || raw === null
              || Object.keys(raw).some(
                (key) => key !== "fencingToken" && key !== "receipt",
              )
              || typeof raw.fencingToken !== "string"
            ) throw new Error("invalid body");
            body = {
              fencingToken: raw.fencingToken,
              receipt: MaterialActionReceiptEnvelopeV1Schema.parse(raw.receipt),
            };
          } catch {
            return context.json(controlError("invalid_request_body"), 400);
          }
          if (
            principal.runnerId !== context.req.param("runnerId")
            || body.receipt.runId !== context.req.param("runId")
            || body.receipt.payload.actionId !== context.req.param("actionId")
          ) {
            return context.json(
              controlError("stale_attempt", body.receipt.operationId),
              409,
            );
          }
          const outcome = await materials.record({
            principal,
            fencingToken: body.fencingToken,
            receipt: body.receipt,
          });
          if (outcome.kind === "recorded") {
            return context.json(outcome.receipt, 201);
          }
          if (outcome.kind === "replayed") {
            return context.json(outcome.receipt, 200);
          }
          return context.json(
            controlError(
              outcome.kind === "stale_fence"
                ? "stale_attempt"
                : "idempotency_conflict",
              body.receipt.operationId,
            ),
            409,
          );
        },
      );

      app.post("/v1/material-actions/:actionId/reconcile", async (context) => {
        const principal = await runtimePrincipal(context.req.raw);
        if (!principal) {
          return context.json(controlError("invalid_credential"), 401);
        }
        let request: ReturnType<
          typeof RunnerMaterialActionReconcileRequestV1Schema.parse
        >;
        try {
          request = RunnerMaterialActionReconcileRequestV1Schema.parse(
            await context.req.json(),
          );
        } catch {
          return context.json(controlError("invalid_request_body"), 400);
        }
        if (
          principal.runnerId !== request.runnerId
          || request.actionId !== context.req.param("actionId")
        ) {
          return context.json(
            controlError("stale_attempt", request.requestId),
            409,
          );
        }
        const outcome = await materials.reconcile({ principal, request });
        if (outcome.kind === "resolved") {
          return context.json(outcome.receipt, 200);
        }
        if (outcome.kind === "outcome_unknown") {
          return context.json(outcome.receipt, 202);
        }
        if (outcome.kind === "missing") {
          return context.json(
            controlError("missing_or_concealed", request.requestId),
            404,
          );
        }
        return context.json(
          controlError(
            outcome.kind === "stale_fence"
              ? "stale_attempt"
              : "idempotency_conflict",
            request.requestId,
          ),
          409,
        );
      });
    }

    const lifecycleSchemas = {
      heartbeat: HostedHeartbeatRequestV1Schema,
      running: HostedRunningRequestV1Schema,
      progress: HostedProgressRequestV1Schema,
      "reject-start": HostedRejectStartRequestV1Schema,
      cancel: HostedCancelRequestV1Schema,
      complete: HostedCompleteRequestV1Schema,
    } as const;
    for (const action of Object.keys(lifecycleSchemas) as Array<
      keyof typeof lifecycleSchemas
    >) {
      app.post(
        `/v1/runners/:runnerId/runs/:runId/${action}`,
        async (context) => {
          const principal = await runtimePrincipal(context.req.raw);
          if (!principal) {
            return context.json(controlError("invalid_credential"), 401);
          }
          let request;
          try {
            request = lifecycleSchemas[action].parse(await context.req.json());
          } catch {
            return context.json(controlError("invalid_request_body"), 400);
          }
          if (principal.runnerId !== context.req.param("runnerId")) {
            return context.json(
              controlError("stale_attempt", request.requestId),
              409,
            );
          }
          const outcome = await control.hosted.lifecycle({
            principal,
            runId: context.req.param("runId"),
            action,
            request,
          });
          if (outcome.kind === "accepted") {
            return context.json(outcome.receipt, 201);
          }
          if (outcome.kind === "replayed") {
            return context.json(outcome.receipt, 200);
          }
          return context.json(
            controlError(
              outcome.kind === "stale_fence"
                ? "stale_attempt"
                : "invalid_state_transition",
              request.requestId,
            ),
            409,
          );
        },
      );
    }
  }

  if (dependencies.console) {
    const consoleDependencies = dependencies.console;
    const trustedMutationOrigin = (request: Request) =>
      request.headers.get("origin") === consoleDependencies.publicOrigin;
    const consolePrincipal = async (
      token: string | undefined,
    ): Promise<ConsolePrincipal | null> => {
      if (!token) return null;
      const outcome = await consoleDependencies.identity.authenticateSession(
        token,
      );
      return outcome.kind === "authenticated" ? outcome.principal : null;
    };

    app.post("/api/console/session", async (context) => {
      if (!trustedMutationOrigin(context.req.raw)) {
        return context.json({ error: "forbidden_origin" }, 403);
      }
      let body: { email: string; password: string; organizationId?: string };
      try {
        const value = await context.req.json();
        if (
          typeof value !== "object"
          || value === null
          || typeof (value as { email?: unknown }).email !== "string"
          || typeof (value as { password?: unknown }).password !== "string"
          || (
            (value as { organizationId?: unknown }).organizationId !== undefined
            && typeof (value as { organizationId?: unknown }).organizationId
              !== "string"
          )
        ) {
          throw new Error("invalid body");
        }
        body = value as {
          email: string;
          password: string;
          organizationId?: string;
        };
      } catch {
        return context.json({ error: "invalid_request" }, 400);
      }
      let networkKey: string | undefined;
      if (consoleDependencies.loginNetworkMode !== "trusted-edge") {
        networkKey = "direct-fetch";
        try {
          networkKey = getConnInfo(context).remote.address ?? networkKey;
        } catch {
          // Direct Fetch API tests and non-Node adapters have no socket metadata.
        }
      }
      const outcome = await consoleDependencies.identity.login({
        ...body,
        ...(networkKey ? { networkKey } : {}),
      });
      if (outcome.kind === "organization_required") {
        return context.json({ error: "organization_required" }, 409);
      }
      if (outcome.kind === "rate_limited") {
        context.header(
          "retry-after",
          String(Math.ceil(outcome.retryAfterMs / 1_000)),
        );
        return context.json({ error: "rate_limited" }, 429);
      }
      if (outcome.kind !== "authenticated") {
        return context.json({ error: "invalid_credential" }, 401);
      }
      setCookie(context, "opentag_session", outcome.session.token, {
        expires: new Date(outcome.session.expiresAt),
        httpOnly: true,
        path: "/",
        sameSite: "Strict",
        secure: consoleDependencies.publicOrigin.startsWith("https://"),
      });
      return context.json({
        principal: outcome.session.principal,
        expiresAt: outcome.session.expiresAt,
      });
    });

    app.get("/api/console/session", async (context) => {
      const principal = await consolePrincipal(
        getCookie(context, "opentag_session"),
      );
      return principal
        ? context.json({ principal })
        : context.json({ error: "invalid_session" }, 401);
    });

    app.delete("/api/console/session", async (context) => {
      if (!trustedMutationOrigin(context.req.raw)) {
        return context.json({ error: "forbidden_origin" }, 403);
      }
      const token = getCookie(context, "opentag_session");
      if (token) await consoleDependencies.identity.logout(token);
      deleteCookie(context, "opentag_session", { path: "/" });
      return context.body(null, 204);
    });

    app.get("/api/console/overview", async (context) => {
      const principal = await consolePrincipal(
        getCookie(context, "opentag_session"),
      );
      if (!principal) return context.json({ error: "invalid_session" }, 401);
      return context.json({
        overview: await consoleDependencies.reads.overview(principal),
      });
    });

    app.get("/api/console/runners", async (context) => {
      const principal = await consolePrincipal(
        getCookie(context, "opentag_session"),
      );
      if (!principal) return context.json({ error: "invalid_session" }, 401);
      return context.json({
        runners: await consoleDependencies.reads.listRunners(principal),
      });
    });

    app.get("/api/console/runs", async (context) => {
      const principal = await consolePrincipal(
        getCookie(context, "opentag_session"),
      );
      if (!principal) return context.json({ error: "invalid_session" }, 401);
      return context.json({
        runs: await consoleDependencies.reads.listRuns(principal),
      });
    });

    app.get("/api/console/audit", async (context) => {
      const principal = await consolePrincipal(
        getCookie(context, "opentag_session"),
      );
      if (!principal) return context.json({ error: "invalid_session" }, 401);
      return context.json({
        events: await consoleDependencies.reads.listAudit(principal),
      });
    });

    app.get("/api/console/evidence", async (context) => {
      const principal = await consolePrincipal(
        getCookie(context, "opentag_session"),
      );
      if (!principal) return context.json({ error: "invalid_session" }, 401);
      const [materialActions, permissions] = await Promise.all([
        consoleDependencies.reads.listMaterialActions(principal),
        consoleDependencies.reads.listPermissions(principal),
      ]);
      return context.json({ materialActions, permissions });
    });

    app.get("/api/console/project-targets", async (context) => {
      const principal = await consolePrincipal(
        getCookie(context, "opentag_session"),
      );
      if (!principal) return context.json({ error: "invalid_session" }, 401);
      const [targets, bindings] = await Promise.all([
        consoleDependencies.reads.listProjectTargets(principal),
        consoleDependencies.reads.listGithubBindings(principal),
      ]);
      return context.json({ bindings, targets });
    });

    app.post("/api/console/project-targets", async (context) => {
      if (!consoleDependencies.targets) {
        return context.json({ error: "target_management_disabled" }, 404);
      }
      if (!trustedMutationOrigin(context.req.raw)) {
        return context.json({ error: "forbidden_origin" }, 403);
      }
      const principal = await consolePrincipal(
        getCookie(context, "opentag_session"),
      );
      if (!principal) return context.json({ error: "invalid_session" }, 401);
      if (principal.role !== "owner" && principal.role !== "admin") {
        return context.json({ error: "forbidden_action" }, 403);
      }
      let body: {
        projectTargetId: string;
        runnerId: string;
        bindingDigest: string;
        provider: string;
        owner: string;
        repo: string;
        defaultExecutor: string;
        defaultBranch: string | null;
        version: number;
      };
      try {
        const value = await context.req.json() as Record<string, unknown>;
        if (
          typeof value !== "object"
          || value === null
          || ![
            "projectTargetId",
            "runnerId",
            "bindingDigest",
            "provider",
            "owner",
            "repo",
            "defaultExecutor",
          ].every((key) => typeof value[key] === "string")
          || (value.defaultBranch !== null && typeof value.defaultBranch !== "string")
          || typeof value.version !== "number"
        ) {
          throw new Error("invalid body");
        }
        body = value as typeof body;
      } catch {
        return context.json({ error: "invalid_request" }, 400);
      }
      try {
        const { runnerId, ...target } = body;
        const outcome = await consoleDependencies.targets.declareProjectTarget({
          organizationId: principal.organizationId,
          runnerId,
          actor: { kind: "operator", id: principal.operatorId },
          target,
        });
        return context.json(
          { outcome: outcome.kind, projectTargetId: body.projectTargetId },
          outcome.kind === "created" ? 201 : 200,
        );
      } catch (error) {
        if (
          error instanceof ZodError
          || (error instanceof Error && error.message === "target_runner_not_found")
        ) {
          return context.json({ error: "invalid_request" }, 400);
        }
        throw error;
      }
    });

    app.get("/api/console/api-keys", async (context) => {
      const principal = await consolePrincipal(
        getCookie(context, "opentag_session"),
      );
      if (!principal) return context.json({ error: "invalid_session" }, 401);
      return context.json({ apiKeys: await consoleDependencies.identity.listApiKeys(principal) });
    });

    app.post("/api/console/api-keys", async (context) => {
      if (!trustedMutationOrigin(context.req.raw)) {
        return context.json({ error: "forbidden_origin" }, 403);
      }
      const principal = await consolePrincipal(
        getCookie(context, "opentag_session"),
      );
      if (!principal) return context.json({ error: "invalid_session" }, 401);
      let body: { label: string; scopes: string[] };
      try {
        const value = await context.req.json();
        if (
          typeof value !== "object"
          || value === null
          || typeof (value as { label?: unknown }).label !== "string"
          || !Array.isArray((value as { scopes?: unknown }).scopes)
          || !(value as { scopes: unknown[] }).scopes.every(
            (scope) => typeof scope === "string",
          )
        ) {
          throw new Error("invalid body");
        }
        body = value as { label: string; scopes: string[] };
      } catch {
        return context.json({ error: "invalid_request" }, 400);
      }
      try {
        return context.json(
          await consoleDependencies.identity.createApiKey(principal, body),
          201,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "forbidden_action") {
          return context.json({ error: "forbidden_action" }, 403);
        }
        if (error instanceof Error && error.message === "invalid_api_key_request") {
          return context.json({ error: "invalid_request" }, 400);
        }
        throw error;
      }
    });

    app.delete("/api/console/api-keys/:apiKeyId", async (context) => {
      if (!trustedMutationOrigin(context.req.raw)) {
        return context.json({ error: "forbidden_origin" }, 403);
      }
      const principal = await consolePrincipal(
        getCookie(context, "opentag_session"),
      );
      if (!principal) return context.json({ error: "invalid_session" }, 401);
      try {
        await consoleDependencies.identity.revokeApiKey(
          principal,
          context.req.param("apiKeyId"),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "forbidden_action") {
          return context.json({ error: "forbidden_action" }, 403);
        }
        throw error;
      }
      return context.body(null, 204);
    });

    app.post("/api/console/github-bindings", async (context) => {
      if (!dependencies.github?.createBinding) {
        return context.json({ error: "github_ingress_disabled" }, 404);
      }
      if (!trustedMutationOrigin(context.req.raw)) {
        return context.json({ error: "forbidden_origin" }, 403);
      }
      const principal = await consolePrincipal(
        getCookie(context, "opentag_session"),
      );
      if (!principal) return context.json({ error: "invalid_session" }, 401);
      let body: {
        bindingId: string;
        providerRepositoryId: string;
        owner: string;
        repo: string;
        runnerId: string;
        projectTargetId: string;
        allowedActorIds: string[];
        enabled: boolean;
      };
      try {
        const value = await context.req.json();
        const candidate = value as Record<string, unknown>;
        if (
          typeof value !== "object"
          || value === null
          || ![
            "bindingId",
            "providerRepositoryId",
            "owner",
            "repo",
            "runnerId",
            "projectTargetId",
          ].every((key) => typeof candidate[key] === "string")
          || !Array.isArray(candidate.allowedActorIds)
          || !candidate.allowedActorIds.every((actor) => typeof actor === "string")
          || typeof candidate.enabled !== "boolean"
        ) {
          throw new Error("invalid body");
        }
        body = candidate as typeof body;
      } catch {
        return context.json({ error: "invalid_request" }, 400);
      }
      try {
        const outcome = await dependencies.github.createBinding(principal, body);
        if (outcome.kind === "conflict") {
          return context.json({ error: "binding_conflict" }, 409);
        }
        return context.json(outcome, outcome.kind === "created" ? 201 : 200);
      } catch (error) {
        if (error instanceof Error && error.message === "forbidden_action") {
          return context.json({ error: "forbidden_action" }, 403);
        }
        if (error instanceof Error && error.message === "invalid_github_binding") {
          return context.json({ error: "invalid_request" }, 400);
        }
        throw error;
      }
    });
  }

  app.notFound((context) =>
    context.json(
      { error: { code: "not_found", message: "Route not found." } },
      404,
    ),
  );

  return {
    async fetch(request) {
      return app.fetch(request);
    },
  };
}

export type { RelayCapability };
