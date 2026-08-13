import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DeliveryIntentV2Schema, domainSeparatedCanonicalBytes, type DeliveryIntentV2 } from "@opentag/delivery-contract";
import { and, asc, eq, isNotNull, isNull, lt, or, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { DELIVERY_ERROR_CODES, deliveryAttempts, type DeliveryErrorCode } from "./delivery-schema.js";
import type { DeliveryPayloadCustody, DeliveryPayloadCustodyDescriptor } from "./delivery-payload-custody.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ERROR_CODES = new Set<string>(DELIVERY_ERROR_CODES);
const DELIVERY_JOURNAL_INTENT_DOMAIN = "opentag.delivery.journal-intent.v1";
export const DELIVERY_SETTLEMENT_STALE_EVIDENCE_DIGEST = "sha256:8a5ce723353265fc801c674d1cd94727259c2d95d9759ca7044d8c34e617e29c";
export type DeliveryOutcome = "accepted" | "rejected" | "outcome_unknown" | "attention";
type DeliveryAttemptRecord = typeof deliveryAttempts.$inferSelect;
type ImmutableAttempt = Omit<typeof deliveryAttempts.$inferInsert, "id" | "state" | "revision" | "leaseOwner" | "leaseExpiresAt" | "leaseFenceDigest" | "installationBeginMarkerId" | "installationBeginMarkerDigest" | "scopeBeginMarkerId" | "scopeBeginMarkerDigest" | "begunAt" | "evidenceDigest" | "errorCode" | "externalResourceDigest" | "externalResourceId" | "outcomeRecordedAt" | "updatedAt">;
export type ExpectedDeliveryOwner = Pick<ImmutableAttempt, "providerId" | "providerInstanceId" | "providerBindingDigest" | "providerConfigGeneration" | "providerConfigGenerationDigest" | "runtimeOwnerId" | "runtimeGeneration" | "schemaGeneration">;
export type DeliveryClaim = ExpectedDeliveryOwner & { attemptId: string; intentId: string; sequence: number; leaseFence: string; revision: number; authoritySnapshotDigest: string; journalIntentDigest: string };
export type DeliveryBegin = DeliveryClaim & { installationBeginMarkerId: string; installationBeginMarkerDigest: string; scopeBeginMarkerId: string; scopeBeginMarkerDigest: string };
export type DeliverySettlement = DeliveryBegin & { outcome: DeliveryOutcome; evidenceDigest: string; errorCode?: DeliveryErrorCode; externalResourceDigest?: string; externalResourceId?: string };
type DeliveryKernelRepositoryOptions = { database: BetterSQLite3Database; payloadCustody: DeliveryPayloadCustody; owner: ExpectedDeliveryOwner; leaseOwner: string; leaseSeconds: number; now?: () => Date };
export type DeliveryKernelRepository = ReturnType<typeof createDeliveryKernelRepository>;

const sha256 = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const deliveryJournalIntentDigest = (intent: DeliveryIntentV2) => sha256(domainSeparatedCanonicalBytes(DELIVERY_JOURNAL_INTENT_DOMAIN, intent));
function validDigest(value: string, label: string): void { if (!SHA256.test(value)) throw new Error(`${label} must be a sha256 digest`); }
function validOwner(value: string, label: "runtimeOwnerId" | "leaseOwner"): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value) || /^(?:xox[baprs]-|gh[pousr]_|sk-)/iu.test(value)) throw new Error(`${label} must be a bounded credential-safe identifier`);
}
function validLease(value: number): void { if (!Number.isSafeInteger(value) || value <= 0 || value > 86_400) throw new Error("leaseSeconds must be an integer from 1 to 86400"); }
const terminal = (state: string): state is DeliveryOutcome => ["accepted", "rejected", "outcome_unknown", "attention"].includes(state);
const sameOwner = (row: ExpectedDeliveryOwner, owner: ExpectedDeliveryOwner) =>
  Object.keys(OWNER_COLUMNS).every((key) =>
    row[key as keyof ExpectedDeliveryOwner] === owner[key as keyof ExpectedDeliveryOwner]);
const descriptor = (row: ImmutableAttempt | DeliveryAttemptRecord): DeliveryPayloadCustodyDescriptor => ({ intentId: row.intentId, journalIntentDigest: row.journalIntentDigest,
  providerId: row.providerId, providerInstanceId: row.providerInstanceId, providerBindingDigest: row.providerBindingDigest,
  providerConfigGeneration: row.providerConfigGeneration, providerConfigGenerationDigest: row.providerConfigGenerationDigest,
  runtimeOwnerId: row.runtimeOwnerId, runtimeGeneration: row.runtimeGeneration, schemaGeneration: row.schemaGeneration });
const claim = (row: DeliveryAttemptRecord, leaseFence: string): DeliveryClaim => ({ ...descriptor(row), attemptId: row.id, sequence: row.sequence,
  leaseFence, revision: row.revision, authoritySnapshotDigest: row.authoritySnapshotDigest });
const begun = (row: DeliveryAttemptRecord, leaseFence: string): DeliveryBegin => ({ ...claim(row, leaseFence), installationBeginMarkerId: row.installationBeginMarkerId!,
  installationBeginMarkerDigest: row.installationBeginMarkerDigest!, scopeBeginMarkerId: row.scopeBeginMarkerId!, scopeBeginMarkerDigest: row.scopeBeginMarkerDigest! });
function claimTuple(input: DeliveryClaim, fence = sha256(input.leaseFence)): SQL[] { return [eq(deliveryAttempts.id, input.attemptId), eq(deliveryAttempts.intentId, input.intentId),
  eq(deliveryAttempts.sequence, input.sequence), eq(deliveryAttempts.revision, input.revision), eq(deliveryAttempts.leaseFenceDigest, fence),
  ...Object.entries(input).flatMap(([key, value]) => key in OWNER_COLUMNS ? [eq(OWNER_COLUMNS[key as keyof ExpectedDeliveryOwner], value)] : []),
  eq(deliveryAttempts.authoritySnapshotDigest, input.authoritySnapshotDigest), eq(deliveryAttempts.journalIntentDigest, input.journalIntentDigest)]; }
const OWNER_COLUMNS = { providerId: deliveryAttempts.providerId, providerInstanceId: deliveryAttempts.providerInstanceId,
  providerBindingDigest: deliveryAttempts.providerBindingDigest, providerConfigGeneration: deliveryAttempts.providerConfigGeneration,
  providerConfigGenerationDigest: deliveryAttempts.providerConfigGenerationDigest, runtimeOwnerId: deliveryAttempts.runtimeOwnerId,
  runtimeGeneration: deliveryAttempts.runtimeGeneration, schemaGeneration: deliveryAttempts.schemaGeneration } as const;
const beginTuple = (input: DeliveryBegin) => [eq(deliveryAttempts.installationBeginMarkerId, input.installationBeginMarkerId), eq(deliveryAttempts.installationBeginMarkerDigest, input.installationBeginMarkerDigest),
  eq(deliveryAttempts.scopeBeginMarkerId, input.scopeBeginMarkerId), eq(deliveryAttempts.scopeBeginMarkerDigest, input.scopeBeginMarkerDigest)];

function intentRow(intentInput: DeliveryIntentV2, owner: ExpectedDeliveryOwner): ImmutableAttempt {
  const intent = DeliveryIntentV2Schema.parse(intentInput); const provenance = intent.provenance; const binding = intent.providerBinding;
  return { intentId: intent.sideEffectIntentId, sequence: intent.initialAttemptSequence, causalId: intent.causalId, operation: intent.operation, deliveryKind: intent.deliveryKind,
    presentationDigest: intent.presentationDigest, targetDigest: intent.targetDigest, authorityKind: intent.authorityKind, evidencePolicy: intent.evidencePolicy,
    provenanceKind: provenance.kind, repositoryIdentityDigest: provenance.kind === "business" ? provenance.repositoryIdentityDigest : null, runId: provenance.kind === "business" ? provenance.runId : null,
    authorityLineageDigest: provenance.kind === "business" ? provenance.authorityLineageDigest : null, inboundEventDigest: provenance.kind === "source_thread_control" ? provenance.inboundEventDigest : null,
    sourceThreadDigest: provenance.kind === "source_thread_control" ? provenance.sourceThreadDigest : null, provenanceInstallationId: provenance.kind === "source_thread_control" ? provenance.installationId : null,
    provenanceRuntimeGeneration: provenance.kind === "source_thread_control" ? provenance.runtimeGeneration : null, provenanceScopeId: provenance.kind === "source_thread_control" ? provenance.scopeId : null,
    providerPrincipalDigest: binding.providerPrincipalDigest, principalAssurance: binding.principalAssurance, connectionId: binding.connectionId ?? null, connectionIdDigest: binding.connectionIdDigest ?? null,
    statusMessageId: "statusMessageId" in intent ? intent.statusMessageId ?? null : null, installationId: "installationId" in intent ? intent.installationId : null,
    intentRuntimeGeneration: "runtimeGeneration" in intent ? intent.runtimeGeneration : null, journalIntentDigest: deliveryJournalIntentDigest(intent), authoritySnapshotDigest: intent.authoritySnapshotDigest,
    scopeKind: intent.scope.kind, scopeId: intent.scope.id, idempotencyKey: intent.idempotencyKey,
    providerId: binding.providerId, providerInstanceId: binding.providerInstanceId,
    providerBindingDigest: binding.bindingDigest,
    providerConfigGeneration: binding.providerConfigGeneration,
    providerConfigGenerationDigest: binding.providerConfigGenerationDigest,
    runtimeOwnerId: owner.runtimeOwnerId, runtimeGeneration: owner.runtimeGeneration,
    schemaGeneration: owner.schemaGeneration, createdAt: intent.createdAt };
}

export function createDeliveryKernelRepository(options: DeliveryKernelRepositoryOptions) {
  const { database: db, owner, payloadCustody } = options; validOwner(owner.runtimeOwnerId, "runtimeOwnerId"); validOwner(options.leaseOwner, "leaseOwner"); validLease(options.leaseSeconds);
  payloadCustody.recoverJournaled(db.select().from(deliveryAttempts).all().map(descriptor));
  return {
    recordIntent(intent: DeliveryIntentV2, persistedPayload: unknown): void {
      const row = intentRow(intent, owner); const stage = payloadCustody.stage({ ...descriptor(row), envelope: { intent, persistedPayload } });
      try { db.transaction((tx) => { const existing = tx.select().from(deliveryAttempts).where(eq(deliveryAttempts.intentId, row.intentId)).get();
        if (existing) { if (existing.journalIntentDigest !== row.journalIntentDigest || !sameOwner(existing, row)) throw new Error(`delivery intent ${row.intentId} conflict`); return; }
        const replay = tx.select().from(deliveryAttempts).where(and(eq(deliveryAttempts.scopeKind, row.scopeKind), eq(deliveryAttempts.scopeId, row.scopeId), eq(deliveryAttempts.providerId, row.providerId), eq(deliveryAttempts.providerInstanceId, row.providerInstanceId), eq(deliveryAttempts.idempotencyKey, row.idempotencyKey))).get();
        if (replay) throw new Error(`delivery idempotency conflict with ${replay.intentId}`);
        const digestOwner = tx.select().from(deliveryAttempts).where(eq(deliveryAttempts.journalIntentDigest, row.journalIntentDigest)).get();
        if (digestOwner) throw new Error(`delivery intent digest conflict with ${digestOwner.intentId}`);
        tx.insert(deliveryAttempts).values({ ...row, id: randomUUID(), state: "pending", revision: 1, updatedAt: row.createdAt }).run(); });
      } catch (error) { stage.rollback(); throw error; }
      stage.commit();
    },
    getIntent(input: DeliveryClaim) {
      const row = db.select().from(deliveryAttempts).where(eq(deliveryAttempts.intentId, input.intentId)).get(); if (!row) return null;
      try { const envelope = payloadCustody.read(descriptor(row)); const intent = DeliveryIntentV2Schema.parse(envelope.intent);
        if (deliveryJournalIntentDigest(intent) !== row.journalIntentDigest) throw new Error("custody intent mismatch");
        return { outcome: "hydrated" as const, intent, journalIntentDigest: row.journalIntentDigest, persistedPayload: envelope.persistedPayload };
      } catch { return { outcome: "custody_unavailable" as const, journalIntentDigest: row.journalIntentDigest }; }
    },
    claimNext(input: { leaseOwner?: string; leaseSeconds?: number; now?: Date } = {}): DeliveryClaim | null {
      const leaseOwner = input.leaseOwner ?? options.leaseOwner; const leaseSeconds = input.leaseSeconds ?? options.leaseSeconds;
      validOwner(leaseOwner, "leaseOwner"); validLease(leaseSeconds);
      const now = input.now ?? options.now?.() ?? new Date(); const nowIso = now.toISOString(); const expires = new Date(now.getTime() + leaseSeconds * 1_000).toISOString();
      return db.transaction((tx) => { const candidates = tx.select().from(deliveryAttempts).where(or(eq(deliveryAttempts.state, "pending"), and(eq(deliveryAttempts.state, "leased"), lt(deliveryAttempts.leaseExpiresAt, nowIso)))).orderBy(asc(deliveryAttempts.createdAt), asc(deliveryAttempts.id)).all();
        for (const row of candidates) { const leaseFence = randomBytes(32).toString("base64url"); const updated = tx.update(deliveryAttempts).set({ state: "leased", revision: row.revision + 1, leaseOwner,
          leaseExpiresAt: expires, leaseFenceDigest: sha256(leaseFence), updatedAt: nowIso }).where(and(eq(deliveryAttempts.id, row.id), eq(deliveryAttempts.revision, row.revision), eq(deliveryAttempts.state, row.state), isNull(deliveryAttempts.begunAt), row.state === "leased" ? lt(deliveryAttempts.leaseExpiresAt, nowIso) : undefined)).returning().get();
          if (updated) return claim(updated, leaseFence); }
        return null; });
    },
    renewLease(input: DeliveryClaim & { leaseOwner?: string; leaseSeconds?: number; now?: Date }): DeliveryClaim | null {
      const leaseOwner = input.leaseOwner ?? options.leaseOwner; const leaseSeconds = input.leaseSeconds ?? options.leaseSeconds;
      validOwner(leaseOwner, "leaseOwner"); validLease(leaseSeconds);
      const now = input.now ?? options.now?.() ?? new Date(); const updated = db.update(deliveryAttempts).set({ revision: input.revision + 1,
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1_000).toISOString(), updatedAt: now.toISOString() }).where(and(eq(deliveryAttempts.state, "leased"),
        eq(deliveryAttempts.leaseOwner, leaseOwner), ...claimTuple(input), isNull(deliveryAttempts.begunAt))).returning().get();
      return updated ? claim(updated, input.leaseFence) : null;
    },
    releaseUnusedClaim(input: DeliveryClaim): boolean { return db.update(deliveryAttempts).set({ state: "pending", revision: input.revision + 1, leaseOwner: null,
      leaseExpiresAt: null, leaseFenceDigest: null, updatedAt: new Date().toISOString() }).where(and(eq(deliveryAttempts.state, "leased"), ...claimTuple(input), isNull(deliveryAttempts.begunAt))).run().changes === 1; },
    markBegin(input: DeliveryBegin & { begunAt?: string }): DeliveryBegin | null {
      for (const [label, value] of [["authoritySnapshotDigest", input.authoritySnapshotDigest], ["journalIntentDigest", input.journalIntentDigest], ["installationBeginMarkerDigest", input.installationBeginMarkerDigest], ["scopeBeginMarkerDigest", input.scopeBeginMarkerDigest]] as const) validDigest(value, label);
      const now = input.begunAt ?? options.now?.().toISOString() ?? new Date().toISOString(); const updated = db.update(deliveryAttempts).set({ state: "provider_io_begun", revision: input.revision + 1,
        installationBeginMarkerId: input.installationBeginMarkerId, installationBeginMarkerDigest: input.installationBeginMarkerDigest, scopeBeginMarkerId: input.scopeBeginMarkerId,
        scopeBeginMarkerDigest: input.scopeBeginMarkerDigest, begunAt: now, updatedAt: now }).where(and(eq(deliveryAttempts.state, "leased"), ...claimTuple(input), isNull(deliveryAttempts.begunAt))).returning().get();
      return updated ? begun(updated, input.leaseFence) : null;
    },
    settleOrReadTerminal(input: DeliverySettlement & { outcomeRecordedAt?: string }): DeliverySettlement {
      validDigest(input.evidenceDigest, "evidenceDigest"); if (input.errorCode && !ERROR_CODES.has(input.errorCode)) throw new Error(`unsupported delivery error code: ${input.errorCode}`);
      if (input.outcome === "accepted" ? input.errorCode : !input.errorCode) throw new Error(input.outcome === "accepted" ? "accepted delivery cannot persist an error code" : "non-accepted terminal delivery requires an error code");
      if (input.externalResourceDigest !== undefined || input.externalResourceId !== undefined) { if (!input.externalResourceDigest || !input.externalResourceId || input.outcome !== "accepted") throw new Error("external resource identity requires accepted outcome and digest pair"); validDigest(input.externalResourceDigest, "externalResourceDigest"); if (input.providerId !== "slack" || !/^\d{1,20}\.\d{1,20}$/u.test(input.externalResourceId)) throw new Error("externalResourceId must be a bounded Slack timestamp"); }
      const recordedAt = input.outcomeRecordedAt ?? new Date().toISOString(); return db.transaction((tx) => { const exact = (revision: number) => and(eq(deliveryAttempts.state, "provider_io_begun"), ...claimTuple({ ...input, revision }), ...beginTuple(input));
        const write = (revision: number, state: DeliveryOutcome, evidenceDigest: string, errorCode?: string) => tx.update(deliveryAttempts).set({ state, revision: revision + 1, evidenceDigest, errorCode: errorCode ?? null,
          externalResourceDigest: input.externalResourceDigest ?? null, externalResourceId: input.externalResourceId ?? null, outcomeRecordedAt: recordedAt, updatedAt: recordedAt }).where(exact(revision)).returning().get();
        let row = write(input.revision, input.outcome, input.evidenceDigest, input.errorCode); if (!row) { const current = tx.select().from(deliveryAttempts).where(eq(deliveryAttempts.id, input.attemptId)).get();
          if (!current || current.leaseFenceDigest !== sha256(input.leaseFence) || !sameOwner(current, input) || current.authoritySnapshotDigest !== input.authoritySnapshotDigest || current.journalIntentDigest !== input.journalIntentDigest ||
            current.installationBeginMarkerId !== input.installationBeginMarkerId || current.installationBeginMarkerDigest !== input.installationBeginMarkerDigest || current.scopeBeginMarkerId !== input.scopeBeginMarkerId || current.scopeBeginMarkerDigest !== input.scopeBeginMarkerDigest) throw new Error(`delivery settlement tuple conflict for attempt ${input.attemptId}`);
          if (terminal(current.state)) row = current; else if (current.state === "provider_io_begun") row = write(current.revision, "outcome_unknown", DELIVERY_SETTLEMENT_STALE_EVIDENCE_DIGEST, "delivery_settlement_stale");
          if (!row) throw new Error(`delivery settlement durable truth unavailable for attempt ${input.attemptId}`); }
        return { ...begun(row, input.leaseFence), outcome: row.state as DeliveryOutcome, evidenceDigest: row.evidenceDigest!, ...(row.errorCode ? { errorCode: row.errorCode as DeliveryErrorCode } : {}),
          ...(row.externalResourceDigest ? { externalResourceDigest: row.externalResourceDigest } : {}), ...(row.externalResourceId ? { externalResourceId: row.externalResourceId } : {}) }; });
    },
    finalizeStrandedBegun(input: { before: string; evidenceDigest: string; outcomeRecordedAt?: string }): number {
      validDigest(input.evidenceDigest, "evidenceDigest"); const at = input.outcomeRecordedAt ?? new Date().toISOString(); const rows = db.select().from(deliveryAttempts).where(and(eq(deliveryAttempts.state, "provider_io_begun"), lt(deliveryAttempts.begunAt, input.before))).orderBy(asc(deliveryAttempts.begunAt), asc(deliveryAttempts.id)).all();
      return rows.reduce((count, row) => count + db.update(deliveryAttempts).set({ state: "outcome_unknown", evidenceDigest: input.evidenceDigest, errorCode: "delivery_restart_after_begin", externalResourceDigest: null, externalResourceId: null,
        outcomeRecordedAt: at, updatedAt: at, revision: row.revision + 1 }).where(and(eq(deliveryAttempts.state, "provider_io_begun"), ...claimTuple({ ...claim(row, "unused"), leaseFence: "unused" }, row.leaseFenceDigest!), ...beginTuple(begun(row, "unused")), eq(deliveryAttempts.begunAt, row.begunAt!))).run().changes, 0);
    },
    findAcceptedExternalResource(input: { intent: DeliveryIntentV2; statusMessageId: string }): { outcome: "none" | "ambiguous" } | { outcome: "exact"; externalResourceId: string; externalResourceDigest: string } {
      const rows = db.selectDistinct({ externalResourceId: deliveryAttempts.externalResourceId, externalResourceDigest: deliveryAttempts.externalResourceDigest }).from(deliveryAttempts).where(and(eq(deliveryAttempts.state, "accepted"),
        eq(deliveryAttempts.provenanceKind, "business"), eq(deliveryAttempts.operation, "create"), eq(deliveryAttempts.scopeKind, input.intent.scope.kind), eq(deliveryAttempts.scopeId, input.intent.scope.id),
        eq(deliveryAttempts.statusMessageId, input.statusMessageId), eq(deliveryAttempts.targetDigest, input.intent.targetDigest), ...Object.entries(owner).map(([key, value]) => eq(OWNER_COLUMNS[key as keyof ExpectedDeliveryOwner], value)),
        isNotNull(deliveryAttempts.externalResourceId), isNotNull(deliveryAttempts.externalResourceDigest))).limit(2).all();
      return rows.length === 0 ? { outcome: "none" } : rows.length > 1 ? { outcome: "ambiguous" } : { outcome: "exact", externalResourceId: rows[0]!.externalResourceId!, externalResourceDigest: rows[0]!.externalResourceDigest! };
    },
  };
}
