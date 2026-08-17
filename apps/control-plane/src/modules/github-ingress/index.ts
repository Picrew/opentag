import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeGitHubIssueCommentSourceIdentityDigestV1,
  computeHostedAdmissionEnvelopeDigestV1,
  HostedAdmissionEnvelopeV1Schema,
  RunnerReadinessReceiptEnvelopeV1Schema,
} from "@opentag/control-protocol";
import type { Pool } from "pg";
import { z } from "zod";
import { withPostgresTransaction } from "../../database/postgres.js";
import { recordManagementAudit } from "../audit/index.js";
import type { ConsolePrincipal } from "../identity/index.js";
import type { HostedRunCoordinator } from "../hosted-runs/index.js";

const HOSTED_CAPABILITIES = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.readiness.v1",
] as const;
const DELIVERY_PROCESSING_LEASE_MS = 60_000;

const GithubIdSchema = z.union([
  z.number().int().positive().safe(),
  z.string().regex(/^[1-9][0-9]{0,30}$/u),
]).transform(String);

const RepositorySchema = z.object({
  id: GithubIdSchema,
  name: z.string().min(1).max(255),
  owner: z.object({ login: z.string().min(1).max(255) }).passthrough(),
}).passthrough();
const SenderSchema = z.object({
  id: GithubIdSchema,
  login: z.string().min(1).max(255),
}).passthrough();

const IssueCommentSchema = z.object({
  action: z.literal("created"),
  repository: RepositorySchema,
  sender: SenderSchema,
  issue: z.object({
    id: GithubIdSchema,
    number: z.number().int().positive(),
    pull_request: z.unknown().optional(),
  }).passthrough(),
  comment: z.object({
    id: GithubIdSchema,
    body: z.string().min(1).max(64 * 1024),
  }).passthrough(),
}).passthrough();

const PullRequestSchema = z.object({
  action: z.enum(["opened", "closed"]),
  repository: RepositorySchema,
  sender: SenderSchema,
  pull_request: z.object({
    id: GithubIdSchema,
    number: z.number().int().positive(),
    html_url: z.string().url(),
    merged: z.boolean().optional(),
  }).passthrough(),
}).passthrough();

type BindingRow = {
  organization_id: string;
  binding_id: string;
  provider_repository_id: string;
  owner: string;
  repo: string;
  runner_id: string;
  project_target_id: string;
  secret_hash: string;
  secret_version: string;
  allowed_actor_ids: string[];
  enabled: boolean;
  binding_digest: string;
  default_executor: string;
  default_branch: string | null;
  target_version: number;
  runner_capabilities: string[];
};

export type GithubIngressOutcome =
  | { kind: "accepted" | "replayed"; runId: string }
  | {
      kind:
        | "admission_conflict"
        | "delivery_conflict"
        | "delivery_in_progress"
        | "evidence_recorded"
        | "evidence_replayed"
        | "invalid_binding_or_signature"
        | "invalid_payload"
        | "rejected_authority"
        | "runner_not_ready"
        | "unsupported_event";
    };

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function secretHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function requireAdmin(principal: ConsolePrincipal): void {
  if (principal.role !== "owner" && principal.role !== "admin") {
    throw new Error("forbidden_action");
  }
}

function validSignature(signature: string, secret: string, body: Uint8Array): boolean {
  if (!/^sha256=[a-f0-9]{64}$/u.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(signature.slice("sha256=".length), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validRepositoryAndActor(
  binding: BindingRow,
  value: { repository: z.output<typeof RepositorySchema>; sender: z.output<typeof SenderSchema> },
): boolean {
  return value.repository.id === binding.provider_repository_id
    && value.repository.owner.login.toLowerCase() === binding.owner
    && value.repository.name.toLowerCase() === binding.repo
    && binding.allowed_actor_ids.includes(value.sender.id);
}

function replayOutcome(outcome: unknown): GithubIngressOutcome {
  if (
    typeof outcome === "object"
    && outcome !== null
    && "kind" in outcome
    && (outcome as { kind: unknown }).kind === "accepted"
    && "runId" in outcome
    && typeof (outcome as { runId: unknown }).runId === "string"
  ) {
    return { kind: "replayed", runId: (outcome as { runId: string }).runId } as const;
  }
  if (
    typeof outcome === "object"
    && outcome !== null
    && "kind" in outcome
    && (outcome as { kind: unknown }).kind === "evidence_recorded"
  ) {
    return { kind: "evidence_replayed" } as const;
  }
  const kind = typeof outcome === "object"
    && outcome !== null
    && "kind" in outcome
    ? (outcome as { kind: unknown }).kind
    : null;
  if (kind === "processing") return { kind: "delivery_in_progress" };
  if (
    kind === "admission_conflict"
    || kind === "invalid_payload"
    || kind === "rejected_authority"
    || kind === "runner_not_ready"
    || kind === "unsupported_event"
  ) {
    return { kind };
  }
  return { kind: "delivery_conflict" };
}

export function createGithubIngress(input: {
  pool: Pool;
  hosted: HostedRunCoordinator;
  clock: { now(): Date };
  masterSecret: string;
}) {
  if (Buffer.byteLength(input.masterSecret, "utf8") < 32) {
    throw new Error("invalid_github_ingress_master_secret");
  }

  const deriveBindingSecret = (
    organizationId: string,
    bindingId: string,
    version: string,
  ) => createHmac("sha256", input.masterSecret)
    .update(JSON.stringify([organizationId, bindingId, version]))
    .digest("base64url");

  const loadBinding = async (bindingId: string) => {
    const result = await input.pool.query<BindingRow>(
      `SELECT binding.*, target.binding_digest, target.default_executor,
              target.default_branch, target.version AS target_version,
              runner.capabilities AS runner_capabilities
       FROM cp_github_binding binding
       JOIN cp_project_target target
         ON target.organization_id = binding.organization_id
        AND target.project_target_id = binding.project_target_id
        AND target.runner_id = binding.runner_id
       JOIN cp_runner runner
         ON runner.organization_id = binding.organization_id
        AND runner.runner_id = binding.runner_id
       WHERE binding.binding_id = $1`,
      [bindingId],
    );
    return result.rows[0] ?? null;
  };

  const reserveDelivery = async (
    binding: BindingRow,
    deliveryId: string,
    payloadDigest: string,
    eventName: string,
  ): Promise<
    | { owner: true; processingToken: string }
    | { owner: false; outcome: GithubIngressOutcome }
  > => {
    const processingToken = randomBytes(24).toString("base64url");
    const now = input.clock.now();
    const processingExpiresAt = new Date(
      now.getTime() + DELIVERY_PROCESSING_LEASE_MS,
    );
    return withPostgresTransaction(input.pool, async (client) => {
      const inserted = await client.query<{ delivery_id: string }>(
        `INSERT INTO cp_github_delivery(
           organization_id, binding_id, delivery_id, payload_digest,
           event_name, normalized_outcome, processing_token,
           processing_expires_at, received_at
         ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING
         RETURNING delivery_id`,
        [
          binding.organization_id,
          binding.binding_id,
          deliveryId,
          payloadDigest,
          eventName,
          { kind: "processing" },
          processingToken,
          processingExpiresAt,
          now,
        ],
      );
      if (inserted.rows[0]) return { owner: true, processingToken };
      const replay = await client.query<{
        payload_digest: string;
        event_name: string;
        normalized_outcome: unknown;
        processing_expires_at: Date | null;
      }>(
        `SELECT payload_digest, event_name, normalized_outcome,
                processing_expires_at
         FROM cp_github_delivery
         WHERE organization_id = $1 AND binding_id = $2 AND delivery_id = $3
         FOR UPDATE`,
        [binding.organization_id, binding.binding_id, deliveryId],
      );
      const row = replay.rows[0];
      if (
        !row
        || row.payload_digest !== payloadDigest
        || row.event_name !== eventName
      ) {
        return { owner: false, outcome: { kind: "delivery_conflict" } };
      }
      if (
        replayOutcome(row.normalized_outcome).kind === "delivery_in_progress"
        && row.processing_expires_at
        && row.processing_expires_at.getTime() <= now.getTime()
      ) {
        await client.query(
          `UPDATE cp_github_delivery
           SET processing_token = $4, processing_expires_at = $5
           WHERE organization_id = $1 AND binding_id = $2 AND delivery_id = $3`,
          [
            binding.organization_id,
            binding.binding_id,
            deliveryId,
            processingToken,
            processingExpiresAt,
          ],
        );
        return { owner: true, processingToken };
      }
      return { owner: false, outcome: replayOutcome(row.normalized_outcome) };
    });
  };

  const completeDelivery = async <T extends GithubIngressOutcome>(
    binding: BindingRow,
    deliveryId: string,
    payloadDigest: string,
    eventName: string,
    processingToken: string,
    outcome: T,
  ): Promise<T> => {
    const completed = await input.pool.query(
      `UPDATE cp_github_delivery
       SET normalized_outcome = $7,
           processing_token = NULL,
           processing_expires_at = NULL
       WHERE organization_id = $1 AND binding_id = $2 AND delivery_id = $3
         AND payload_digest = $4 AND event_name = $5
         AND processing_token = $6
         AND normalized_outcome = '{"kind":"processing"}'::jsonb`,
      [
        binding.organization_id,
        binding.binding_id,
        deliveryId,
        payloadDigest,
        eventName,
        processingToken,
        outcome,
      ],
    );
    if (completed.rowCount !== 1) {
      throw new Error("github_delivery_reservation_lost");
    }
    return outcome;
  };

  return {
    deriveBindingSecret,

    async createBinding(
      principal: ConsolePrincipal,
      command: {
        bindingId: string;
        providerRepositoryId: string;
        owner: string;
        repo: string;
        runnerId: string;
        projectTargetId: string;
        allowedActorIds: string[];
        enabled: boolean;
      },
    ) {
      requireAdmin(principal);
      const owner = command.owner.toLowerCase();
      const repo = command.repo.toLowerCase();
      const actorIds = [...new Set(command.allowedActorIds)].sort();
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(command.bindingId)
        || !/^[1-9][0-9]{0,30}$/u.test(command.providerRepositoryId)
        || !owner
        || !repo
        || actorIds.length < 1
        || actorIds.some((actorId) => !/^[1-9][0-9]{0,30}$/u.test(actorId))
      ) {
        throw new Error("invalid_github_binding");
      }
      const secretVersion = "v1";
      const secret = deriveBindingSecret(
        principal.organizationId,
        command.bindingId,
        secretVersion,
      );
      return withPostgresTransaction(input.pool, async (client) => {
        const target = await client.query(
          `SELECT 1 FROM cp_project_target
           WHERE organization_id = $1 AND project_target_id = $2
             AND runner_id = $3 AND provider = 'github'
             AND lower(owner) = $4 AND lower(repo) = $5
           FOR UPDATE`,
          [
            principal.organizationId,
            command.projectTargetId,
            command.runnerId,
            owner,
            repo,
          ],
        ) as { rows: unknown[] };
        if (target.rows.length !== 1) throw new Error("invalid_github_binding");
        const inserted = await client.query(
          `INSERT INTO cp_github_binding(
             organization_id, binding_id, provider_repository_id, owner, repo,
             runner_id, project_target_id, secret_hash, secret_version,
             allowed_actor_ids, enabled, created_at, updated_at
           ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
           ON CONFLICT DO NOTHING
           RETURNING binding_id`,
          [
            principal.organizationId,
            command.bindingId,
            command.providerRepositoryId,
            owner,
            repo,
            command.runnerId,
            command.projectTargetId,
            secretHash(secret),
            secretVersion,
            actorIds,
            command.enabled,
            input.clock.now(),
          ],
        ) as { rows: Array<{ binding_id: string }> };
        if (inserted.rows[0]) {
          await recordManagementAudit(client, {
            organizationId: principal.organizationId,
            actor: { kind: "operator", id: principal.operatorId },
            operationKind: "github_binding.create",
            resource: { kind: "github_binding", id: command.bindingId },
            outcome: command.enabled ? "created_enabled" : "created_disabled",
            event: {
              projectTargetId: command.projectTargetId,
              providerRepositoryId: command.providerRepositoryId,
              runnerId: command.runnerId,
              secretVersion,
            },
            createdAt: input.clock.now(),
          });
          return { kind: "created", bindingId: command.bindingId, secret } as const;
        }
        const existing = await client.query(
          `SELECT * FROM cp_github_binding
           WHERE organization_id = $1 AND binding_id = $2 FOR UPDATE`,
          [principal.organizationId, command.bindingId],
        ) as { rows: BindingRow[] };
        const row = existing.rows[0];
        return row
          && row.provider_repository_id === command.providerRepositoryId
          && row.owner === owner
          && row.repo === repo
          && row.runner_id === command.runnerId
          && row.project_target_id === command.projectTargetId
          && row.secret_hash === secretHash(secret)
          && row.secret_version === secretVersion
          && row.enabled === command.enabled
          && JSON.stringify(row.allowed_actor_ids) === JSON.stringify(actorIds)
          ? { kind: "replayed", bindingId: command.bindingId } as const
          : { kind: "conflict" } as const;
      });
    },

    async receive(command: {
      bindingId: string;
      deliveryId: string;
      eventName: string;
      signature: string;
      body: Uint8Array;
    }): Promise<GithubIngressOutcome> {
      const binding = await loadBinding(command.bindingId);
      if (!binding || !binding.enabled) {
        return { kind: "invalid_binding_or_signature" } as const;
      }
      const secret = deriveBindingSecret(
        binding.organization_id,
        binding.binding_id,
        binding.secret_version,
      );
      if (
        secretHash(secret) !== binding.secret_hash
        || !validSignature(command.signature, secret, command.body)
      ) {
        return { kind: "invalid_binding_or_signature" } as const;
      }
      const payloadDigest = digestBytes(command.body);
      const reservation = await reserveDelivery(
        binding,
        command.deliveryId,
        payloadDigest,
        command.eventName,
      );
      if (!reservation.owner) return reservation.outcome;
      const finish = <T extends GithubIngressOutcome>(outcome: T) =>
        completeDelivery(
          binding,
          command.deliveryId,
          payloadDigest,
          command.eventName,
          reservation.processingToken,
          outcome,
        );
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(command.body));
      } catch {
        return finish({ kind: "invalid_payload" } as const);
      }

      if (command.eventName === "pull_request") {
        const parsed = PullRequestSchema.safeParse(raw);
        if (!parsed.success) return finish({ kind: "invalid_payload" } as const);
        if (!validRepositoryAndActor(binding, parsed.data)) {
          return finish({ kind: "rejected_authority" });
        }
        const evidenceKind = parsed.data.action === "opened"
          ? "pull_request_opened"
          : parsed.data.pull_request.merged
            ? "pull_request_merged"
            : "pull_request_closed";
        const providerIdentity = [
          "github",
          parsed.data.repository.id,
          "pull_request",
          parsed.data.pull_request.id,
          evidenceKind,
        ].join(":");
        const evidenceId = `evidence_${createHash("sha256").update(providerIdentity).digest("hex").slice(0, 32)}`;
        await input.pool.query(
          `INSERT INTO cp_provider_evidence(
             evidence_id, organization_id, provider, evidence_kind,
             provider_identity, payload_digest, evidence, observed_at
           ) VALUES($1, $2, 'github', $3, $4, $5, $6, $7)
           ON CONFLICT (organization_id, provider, evidence_kind, provider_identity)
           DO NOTHING`,
          [
            evidenceId,
            binding.organization_id,
            evidenceKind,
            providerIdentity,
            payloadDigest,
            {
              number: parsed.data.pull_request.number,
              url: parsed.data.pull_request.html_url,
              actorId: parsed.data.sender.id,
            },
            input.clock.now(),
          ],
        );
        return finish({ kind: "evidence_recorded" } as const);
      }

      if (command.eventName !== "issue_comment") {
        return finish({ kind: "unsupported_event" } as const);
      }
      const parsed = IssueCommentSchema.safeParse(raw);
      if (!parsed.success) return finish({ kind: "invalid_payload" } as const);
      if (
        !validRepositoryAndActor(binding, parsed.data)
        || !/^@opentag(?:\s+|$)/iu.test(parsed.data.comment.body.trim())
      ) {
        return finish({ kind: "rejected_authority" });
      }
      if (!HOSTED_CAPABILITIES.every((capability) =>
        binding.runner_capabilities.includes(capability))) {
        return finish({ kind: "runner_not_ready" } as const);
      }
      const readinessResult = await input.pool.query<{
        receipt: unknown;
        receipt_digest: string;
      }>(
        `SELECT receipt, receipt_digest FROM cp_runner_readiness
         WHERE organization_id = $1 AND runner_id = $2
           AND expires_at > $3
         ORDER BY observed_at DESC LIMIT 1`,
        [binding.organization_id, binding.runner_id, input.clock.now()],
      );
      const readinessRow = readinessResult.rows[0];
      if (!readinessRow) return finish({ kind: "runner_not_ready" } as const);
      let readiness;
      try {
        readiness = RunnerReadinessReceiptEnvelopeV1Schema.parse(readinessRow.receipt);
      } catch {
        return finish({ kind: "runner_not_ready" } as const);
      }
      const executor = readiness.payload.executors.find(
        (candidate) => candidate.executorId === binding.default_executor
          && candidate.state === "ready",
      );
      const target = readiness.payload.targets.find(
        (candidate) => candidate.projectTargetId === binding.project_target_id
          && candidate.state === "ready"
          && candidate.bindingDigest === binding.binding_digest,
      );
      if (!executor || !target || readiness.receiptDigest !== readinessRow.receipt_digest) {
        return finish({ kind: "runner_not_ready" } as const);
      }

      const receivedAt = input.clock.now().toISOString();
      const sourceIdentityDigest = await computeGitHubIssueCommentSourceIdentityDigestV1({
        provider: "github",
        repository: {
          providerRepositoryId: parsed.data.repository.id,
          owner: binding.owner,
          repo: binding.repo,
        },
        sourceThread: {
          kind: parsed.data.issue.pull_request ? "pull_request" : "issue",
          providerThreadId: parsed.data.issue.id,
          number: parsed.data.issue.number,
        },
        sourceEvent: {
          providerEventId: parsed.data.comment.id,
          kind: "issue_comment",
        },
        actor: {
          providerUserId: parsed.data.sender.id,
          login: parsed.data.sender.login,
        },
        executionBearingCommentBody: parsed.data.comment.body.trim(),
      });
      const identitySuffix = sourceIdentityDigest.slice("sha256:".length, 38);
      const runId = `run_${identitySuffix}`;
      const operationId = `operation_admit_${identitySuffix}`;
      const snapshotId = `policy_${identitySuffix}`;
      const authorizationRef = `github_${binding.binding_id}_${parsed.data.sender.id}`;
      const policyPayload = {
        snapshotId,
        capturedAt: receivedAt,
        tenant: { organizationId: binding.organization_id },
        actor: {
          provider: "github",
          providerUserId: parsed.data.sender.id,
          login: parsed.data.sender.login,
          authorizationRef,
        },
        target: {
          projectTargetId: binding.project_target_id,
          bindingId: binding.binding_id,
          providerRepositoryId: binding.provider_repository_id,
          defaultBranch: binding.default_branch ?? "main",
        },
        runner: {
          runnerId: binding.runner_id,
          readinessReceiptDigest: readiness.receiptDigest,
        },
        executor: {
          executorId: executor.executorId,
          capabilityDigest: executor.capabilityDigest,
        },
        requiredRelayCapabilities: HOSTED_CAPABILITIES,
        admissionRules: {
          profile: "github-issue-comment/v1",
          requiredCheckNames: [] as string[],
          mergeRequired: false,
          humanApprovalRequiredFor: [] as string[],
        },
      };
      const policySeed = {
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        receiptId: `policy_receipt_${identitySuffix}`,
        organizationId: binding.organization_id,
        operationId,
        requiredCapabilities: HOSTED_CAPABILITIES,
        producer: { kind: "cloud" as const, id: "control_plane" },
        identity: {
          namespace: "opentag.control.receipt/admission-policy-snapshot/v1" as const,
          parts: [binding.organization_id, runId, snapshotId],
        },
        observedAt: receivedAt,
        payloadDigest: await computeControlPayloadDigestV1(policyPayload),
        receiptDigest: `sha256:${"0".repeat(64)}`,
        receiptKind: "admission_policy_snapshot" as const,
        runId,
        payload: policyPayload,
      };
      const { receiptDigest: _ignored, ...policyDigestInput } = policySeed;
      const policy = AdmissionPolicySnapshotReceiptEnvelopeV1Schema.parse({
        ...policySeed,
        receiptDigest: await computeControlReceiptDigestV1(policyDigestInput),
      });
      const grantDigest = await computeControlPayloadDigestV1({
        authorizationRef,
        actorId: parsed.data.sender.id,
        bindingId: binding.binding_id,
      });
      const admissionSeed = {
        kind: "hosted_admission" as const,
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        requiredCapabilities: [
          "relay.hosted-admission.v1",
        ] as ["relay.hosted-admission.v1"],
        admissionId: `admission_${identitySuffix}`,
        operationId,
        organizationId: binding.organization_id,
        bindingId: binding.binding_id,
        bindingSecretVersion: binding.secret_version,
        provider: "github" as const,
        deliveryId: command.deliveryId,
        deliveryPayloadDigest: payloadDigest,
        sourceIdentityDigest,
        eventName: "issue_comment" as const,
        action: "created" as const,
        repository: {
          providerRepositoryId: binding.provider_repository_id,
          owner: binding.owner,
          repo: binding.repo,
        },
        sourceThread: {
          kind: parsed.data.issue.pull_request ? "pull_request" as const : "issue" as const,
          providerThreadId: parsed.data.issue.id,
          number: parsed.data.issue.number,
        },
        sourceEvent: {
          providerEventId: parsed.data.comment.id,
          kind: "issue_comment" as const,
        },
        verifiedActor: {
          providerUserId: parsed.data.sender.id,
          login: parsed.data.sender.login,
          authorization: {
            decision: "allowed" as const,
            grantRef: authorizationRef,
            grantVersion: 1,
            grantDigest,
          },
        },
        projectTarget: {
          projectTargetId: binding.project_target_id,
          version: binding.target_version,
          digest: binding.binding_digest,
        },
        runnerId: binding.runner_id,
        admissionPolicySnapshot: {
          snapshotId,
          digest: policy.receiptDigest,
        },
        receivedAt,
        envelopeDigest: `sha256:${"0".repeat(64)}`,
      };
      const admission = HostedAdmissionEnvelopeV1Schema.parse({
        ...admissionSeed,
        envelopeDigest: await computeHostedAdmissionEnvelopeDigestV1(admissionSeed),
      });
      const admitted = await input.hosted.admit({ runId, admission, policy });
      if (admitted.kind === "conflict") {
        return finish({ kind: "admission_conflict" } as const);
      }
      const outcome = { kind: "accepted" as const, runId };
      return finish(outcome);
    },
  };
}

export type GithubIngress = ReturnType<typeof createGithubIngress>;
