import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryIntentV2Schema } from "@opentag/delivery-contract";
import { describe, expect, it } from "vitest";
import {
  createEncryptedFileDeliveryPayloadCustody,
  deliveryJournalIntentDigest,
} from "../src/index.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const stable = digest("stable");
const intent = DeliveryIntentV2Schema.parse({
  contractVersion: 2,
  sideEffectIntentId: "intent_1",
  causalId: "cause_1",
  intentKind: "delivery",
  operation: "create",
  deliveryKind: "message",
  presentationDigest: stable,
  provenance: {
    kind: "business",
    repositoryIdentityDigest: stable,
    runId: "run_1",
    authorityLineageDigest: stable,
  },
  providerBinding: {
    bindingKind: "established",
    providerId: "slack",
    providerInstanceId: "instance_1",
    providerPrincipalDigest: stable,
    principalAssurance: "configured_declared",
    bindingDigest: stable,
    providerConfigGeneration: 7,
    providerConfigGenerationDigest: stable,
    lifecycle: "active",
  },
  targetDigest: stable,
  authorityKind: "run_authority",
  authoritySnapshotDigest: stable,
  evidencePolicy: "local_audit",
  idempotencyKey: "delivery_1",
  scope: { kind: "local_repository", id: "repo_1" },
  createdAt: "2026-08-13T00:00:00.000Z",
  initialAttemptSequence: 1,
});
const payload = {
  operation: { kind: "create_message", channelId: "C1", threadTs: "170.001" },
  presentation: {
    kind: "message",
    text: "customer-visible UNKNOWN_SECRET_SENTINEL_85c7",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "private block sentinel" } }],
  },
};
const descriptor = {
  intentId: intent.sideEffectIntentId,
  journalIntentDigest: deliveryJournalIntentDigest(intent),
  providerId: intent.providerBinding.providerId,
  providerInstanceId: intent.providerBinding.providerInstanceId,
  providerBindingDigest: intent.providerBinding.bindingDigest,
  providerConfigGeneration: intent.providerBinding.providerConfigGeneration,
  providerConfigGenerationDigest:
    intent.providerBinding.providerConfigGenerationDigest,
  runtimeOwnerId: "installation_1",
  runtimeGeneration: 3,
  schemaGeneration: 1,
};
const stored = { intent, persistedPayload: payload };

describe("encrypted delivery payload custody", () => {
  it("rehydrates exact payload after restart without writing plaintext to custody files", () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-payload-custody-"));
    try {
      const key = Buffer.alloc(32, 7);
      const first = createEncryptedFileDeliveryPayloadCustody({ directory, trustedBoundary: tmpdir(), key });
      const staged = first.stage({ ...descriptor, envelope: stored });
      staged.commit();
      expect(first.read(descriptor)).toEqual(stored);

      const bytes = Buffer.concat(readdirSync(directory).map((name) => readFileSync(join(directory, name))));
      expect(bytes.includes(Buffer.from("UNKNOWN_SECRET_SENTINEL_85c7"))).toBe(false);
      expect(bytes.includes(Buffer.from("private block sentinel"))).toBe(false);
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const object = readFileSync(path);
        expect(statSync(path).mode & 0o077).toBe(0);
        expect(Object.keys(JSON.parse(object.toString("utf8"))).sort()).toEqual([
          "data", "iv", "tag",
        ]);
        expect(object.includes(Buffer.from(descriptor.journalIntentDigest))).toBe(false);
        expect(object.includes(Buffer.from("payloadDigest"))).toBe(false);
        expect(object.includes(Buffer.from("locator"))).toBe(false);
      }

      const restarted = createEncryptedFileDeliveryPayloadCustody({ directory, trustedBoundary: tmpdir(), key });
      expect(restarted.read(descriptor)).toEqual(stored);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when committed ciphertext is tampered", () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-payload-custody-tamper-"));
    try {
      const custody = createEncryptedFileDeliveryPayloadCustody({ directory, trustedBoundary: tmpdir(), key: Buffer.alloc(32, 8) });
      custody.stage({ ...descriptor, envelope: stored }).commit();
      const payloadFile = readdirSync(directory).find((name) => name.endsWith(".payload"));
      if (!payloadFile) throw new Error("missing payload file");
      const path = join(directory, payloadFile);
      const envelope = readFileSync(path);
      envelope[envelope.length - 1]! ^= 1;
      writeFileSync(path, envelope, { mode: 0o600 });
      expect(() => custody.read(descriptor)).toThrow(/delivery_payload_custody_mismatch/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("finalizes an authenticated stage after restart only when its exact journal row is proven", () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-payload-reconcile-"));
    try {
      const key = Buffer.alloc(32, 9);
      const crashed = createEncryptedFileDeliveryPayloadCustody({
        directory,
        trustedBoundary: tmpdir(),
        key,
        fault(point) {
          if (point === "after_stage_publish") throw new Error("simulated crash");
        },
      });
      expect(() => crashed.stage({ ...descriptor, envelope: stored })).toThrow("simulated crash");

      const restarted = createEncryptedFileDeliveryPayloadCustody({ directory, trustedBoundary: tmpdir(), key });
      expect(restarted.reconcile({ journaled: [descriptor], orphanGraceMs: 0 })).toEqual({
        finalized: 1,
        removed: 0,
      });
      expect(restarted.read(descriptor)).toEqual(stored);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers a commit-boundary crash without a second publish or provider action", () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-payload-commit-crash-"));
    try {
      const key = Buffer.alloc(32, 10);
      let injected = false;
      const crashed = createEncryptedFileDeliveryPayloadCustody({
        directory,
        trustedBoundary: tmpdir(),
        key,
        fault(point) {
          if (!injected && point === "before_finalize") {
            injected = true;
            throw new Error("journal committed, custody finalize interrupted");
          }
        },
      });
      const stage = crashed.stage({ ...descriptor, envelope: stored });
      expect(() => stage.commit()).toThrow("journal committed, custody finalize interrupted");

      const restarted = createEncryptedFileDeliveryPayloadCustody({ directory, trustedBoundary: tmpdir(), key });
      expect(restarted.reconcile({ journaled: [descriptor], orphanGraceMs: 0 }).finalized).toBe(1);
      expect(restarted.read(descriptor)).toEqual(stored);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes an authenticated duplicate stage left after finalize on restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-payload-finalize-crash-"));
    try {
      const key = Buffer.alloc(32, 11);
      const crashed = createEncryptedFileDeliveryPayloadCustody({ directory, trustedBoundary: tmpdir(), key,
        fault(point) { if (point === "after_finalize") throw new Error("finalize interrupted"); } });
      const stage = crashed.stage({ ...descriptor, envelope: stored });
      expect(() => stage.commit()).toThrow("finalize interrupted");
      expect(readdirSync(directory).sort()).toEqual([
        expect.stringMatching(/\.payload$/u), expect.stringMatching(/\.staged$/u),
      ]);
      const restarted = createEncryptedFileDeliveryPayloadCustody({ directory, trustedBoundary: tmpdir(), key });
      expect(restarted.recoverJournaled([descriptor])).toBe(0);
      expect(restarted.read(descriptor)).toEqual(stored);
      expect(readdirSync(directory)).toEqual([expect.stringMatching(/\.payload$/u)]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects ancestor symlinks and never exposes their path", () => {
    const boundary = mkdtempSync(join(tmpdir(), "opentag-payload-root-"));
    try {
      const real = join(boundary, "real");
      const alias = join(boundary, "unknown-secret-path");
      mkdirSync(real, { mode: 0o700 });
      symlinkSync(real, alias, "dir");
      expect(() => createEncryptedFileDeliveryPayloadCustody({
        directory: join(alias, "custody"),
        trustedBoundary: boundary,
        key: Buffer.alloc(32, 11),
      })).toThrow("delivery_payload_custody_configuration");
      try {
        createEncryptedFileDeliveryPayloadCustody({
          directory: join(alias, "custody"),
          trustedBoundary: boundary,
          key: Buffer.alloc(32, 11),
        });
      } catch (error) {
        expect(String(error)).not.toContain("unknown-secret-path");
      }
    } finally {
      rmSync(boundary, { recursive: true, force: true });
    }
  });

  it("bounds payload and member reads and rejects no-follow swaps", () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-payload-bounds-"));
    try {
      const custody = createEncryptedFileDeliveryPayloadCustody({
        directory,
        trustedBoundary: tmpdir(),
        key: Buffer.alloc(32, 12),
      });
      expect(() => custody.stage({ ...descriptor, envelope: {
        intent,
        persistedPayload: { text: "x".repeat(513 * 1024) },
      } }))
        .toThrow("delivery_payload_custody_mismatch");
      custody.stage({ ...descriptor, envelope: stored }).commit();
      const payloadFile = readdirSync(directory).find((name) => name.endsWith(".payload"));
      if (!payloadFile) throw new Error("missing payload file");
      const file = join(directory, payloadFile);
      writeFileSync(file, "x".repeat(520 * 1024), { mode: 0o600 });
      expect(() => custody.read(descriptor)).toThrow("delivery_payload_custody_mismatch");
      rmSync(file);
      symlinkSync("/dev/zero", file);
      expect(() => custody.read(descriptor)).toThrow("delivery_payload_custody_mismatch");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects path-shaped and credential-shaped runtime owner identifiers", () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-payload-owner-"));
    try {
      const custody = createEncryptedFileDeliveryPayloadCustody({
        directory,
        trustedBoundary: tmpdir(),
        key: Buffer.alloc(32, 14),
      });
      for (const runtimeOwnerId of ["../runner", "https://runner", "Bearer token.value", "xoxb-secret", "ghp_secret", "github_pat_secret", "sk-secret", "x".repeat(65)]) {
        expect(() => custody.stage({ ...descriptor, runtimeOwnerId, envelope: stored }))
          .toThrow("delivery_payload_custody_mismatch");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports cleanup failure with a stable path-free code", () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-payload-cleanup-secret-"));
    try {
      const custody = createEncryptedFileDeliveryPayloadCustody({ directory, trustedBoundary: tmpdir(), key: Buffer.alloc(32, 13) });
      custody.stage({ ...descriptor, envelope: stored });
      chmodSync(directory, 0o500);
      expect(() => custody.reconcile({ journaled: [], orphanGraceMs: 0, nowMs: Date.now() + 1_000 }))
        .toThrow("delivery_payload_custody_cleanup");
    } finally {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
