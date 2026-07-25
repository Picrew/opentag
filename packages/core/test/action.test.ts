import { describe, expect, it } from "vitest";
import {
  actionReceiptHeading,
  buildActionReceipt,
  evaluateActionPermission,
  grantMatchesAction,
  normalizeMaterialActionRequest,
  parseThreadActionCommand,
  parseThreadControlCommand,
  parseWorkContextMutationCommand,
  suggestedActionCandidatesFromResult
} from "../src/action.js";

describe("governed material actions", () => {
  const request = normalizeMaterialActionRequest({
    title: "Publish package",
    kind: "publish",
    permissionScopes: ["npm:publish", "package:write"]
  });

  it("keeps ask, auto, and autonomous modes distinct", () => {
    expect(evaluateActionPermission({ mode: "ask", action: request }).outcome).toBe("needs_approval");
    expect(evaluateActionPermission({ mode: "auto", action: request }).outcome).toBe("needs_approval");
    expect(evaluateActionPermission({ mode: "autonomous", action: request }).outcome).toBe("authorized");

    const read = normalizeMaterialActionRequest({ title: "Read package metadata", kind: "read", permissionScopes: [] });
    expect(evaluateActionPermission({ mode: "auto", action: read }).outcome).toBe("authorized");
  });

  it("treats opaque ACP operations as material and separates exact identity from bounded run scope", () => {
    for (const kind of ["execute", "tool", "fetch", "edit", "delete", "move", "other"]) {
      const opaque = normalizeMaterialActionRequest({
        title: "Do work",
        kind,
        provider: "acp",
        connectionId: "acp:agent-managed",
        operation: kind,
        resource: "workspace:report",
        targetFingerprint: `sha256:${kind.padEnd(64, "0").slice(0, 64)}`
      });
      expect(evaluateActionPermission({ mode: "auto", action: opaque }).outcome).toBe("needs_approval");
    }

    const first = normalizeMaterialActionRequest({
      title: "Publish package",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "@acme/report",
      resourceVersion: "next",
      targetFingerprint: `sha256:${"a".repeat(64)}`
    });
    const second = normalizeMaterialActionRequest({
      title: "Publish package",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "@acme/report",
      resourceVersion: "stable",
      targetFingerprint: `sha256:${"b".repeat(64)}`
    });
    const outside = normalizeMaterialActionRequest({
      title: "Publish package",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "@acme/other",
      resourceVersion: "stable",
      targetFingerprint: `sha256:${"c".repeat(64)}`
    });
    expect(first.scope).not.toEqual(second.scope);
    expect(first.target).not.toEqual(second.target);
    expect(first.scope).not.toEqual(outside.scope);
    expect(first.target).toMatchObject({
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "@acme/report",
      resourceVersion: "next"
    });
    const genericRunGrant = {
      runId: "run_1",
      capability: first.actionFamily,
      resourceScope: first.scope,
      constraints: { permissionDecision: "allow_run" }
    };
    expect(grantMatchesAction(genericRunGrant, { runId: "run_1", attemptId: "attempt_1", action: first })).toBe(true);
    expect(grantMatchesAction(genericRunGrant, { runId: "run_1", attemptId: "attempt_1", action: second })).toBe(false);
    const trustedFirst = normalizeMaterialActionRequest({
      title: "Publish package",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "@acme/report",
      resourceVersion: "next",
      targetFingerprint: `sha256:${"a".repeat(64)}`,
      grantScope: { package: "@acme/report", versions: "*" }
    });
    const trustedSecond = normalizeMaterialActionRequest({
      title: "Publish package",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "@acme/report",
      resourceVersion: "stable",
      targetFingerprint: `sha256:${"b".repeat(64)}`,
      grantScope: { package: "@acme/report", versions: "*" }
    });
    expect(trustedFirst.scope).toEqual(trustedSecond.scope);
    expect(JSON.stringify(first)).not.toContain("secret-value");
  });

  it("keeps normalized target identity canonical when extensions reuse reserved fields", () => {
    const normalized = normalizeMaterialActionRequest({
      title: "Publish report",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "@acme/report",
      resourceVersion: "next",
      targetFingerprint: `sha256:${"a".repeat(64)}`,
      targetConstraints: { queryMode: "canonical", reuse: "exact" },
      grantScope: { package: "@acme/report", versions: "*" },
      target: {
        title: "Delete production",
        kind: "delete",
        provider: "forged",
        connectionId: "forged:admin",
        operation: "delete",
        resource: "production",
        resourceVersion: "latest",
        targetFingerprint: `sha256:${"b".repeat(64)}`,
        targetConstraints: { reuse: "deny" },
        grantScope: { package: "*", versions: "*" },
        displayLabel: "Release report"
      }
    });

    expect(normalized.target).toMatchObject({
      title: "Publish report",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "@acme/report",
      resourceVersion: "next",
      targetFingerprint: `sha256:${"a".repeat(64)}`,
      targetConstraints: { queryMode: "canonical", reuse: "exact" },
      grantScope: { package: "@acme/report", versions: "*" },
      displayLabel: "Release report"
    });

    const withoutOptionalIdentity = normalizeMaterialActionRequest({
      title: "Publish report",
      target: {
        kind: "delete",
        resourceVersion: "latest",
        targetFingerprint: `sha256:${"b".repeat(64)}`,
        targetConstraints: { reuse: "deny" },
        grantScope: { package: "*", versions: "*" },
        displayLabel: "Release report"
      }
    });
    expect(withoutOptionalIdentity.target).toMatchObject({ displayLabel: "Release report" });
    for (const reserved of ["kind", "resourceVersion", "targetFingerprint", "targetConstraints", "grantScope"]) {
      expect(withoutOptionalIdentity.target).not.toHaveProperty(reserved);
    }
  });

  it("matches allow_once only to an attempt and allow_run only to the exact normalized family and scope", () => {
    const once = {
      id: "grant_once",
      connectionId: "acp",
      capability: request.actionFamily,
      resourceScope: request.scope,
      runId: "run_1",
      attemptId: "attempt_1",
      constraints: {
        permissionDecision: "allow_once",
        actionId: "action_1",
        proposalHash: "proposal_hash_1"
      }
    };
    expect(grantMatchesAction(once, { runId: "run_1", attemptId: "attempt_1", actionId: "action_1", proposalHash: "proposal_hash_1", action: request })).toBe(true);
    expect(grantMatchesAction(once, { runId: "run_1", attemptId: "attempt_1", actionId: "action_2", proposalHash: "proposal_hash_1", action: request })).toBe(false);
    expect(grantMatchesAction(once, { runId: "run_1", attemptId: "attempt_2", actionId: "action_1", proposalHash: "proposal_hash_1", action: request })).toBe(false);

    const runGrant = { ...once, id: "grant_run", attemptId: undefined, constraints: { permissionDecision: "allow_run" } };
    expect(grantMatchesAction(runGrant, { runId: "run_1", attemptId: "attempt_2", action: request })).toBe(true);
    expect(
      grantMatchesAction(runGrant, {
        runId: "run_1",
        attemptId: "attempt_2",
        action: normalizeMaterialActionRequest({ title: "Deploy app", kind: "deploy", permissionScopes: ["deploy:write"] })
      })
    ).toBe(false);

    const scoped = normalizeMaterialActionRequest({
      title: "Publish report next",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "@acme/report",
      resourceVersion: "next",
      targetFingerprint: `sha256:${"a".repeat(64)}`,
      grantScope: { package: "@acme/report", versions: "*" }
    });
    const boundedRunGrant = { ...runGrant, capability: scoped.actionFamily, resourceScope: scoped.scope };
    const distinctInsideScope = normalizeMaterialActionRequest({
      title: "Publish report stable",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "@acme/report",
      resourceVersion: "stable",
      targetFingerprint: `sha256:${"b".repeat(64)}`,
      grantScope: { package: "@acme/report", versions: "*" }
    });
    const outsideScope = normalizeMaterialActionRequest({
      title: "Publish other stable",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "@acme/other",
      resourceVersion: "stable",
      targetFingerprint: `sha256:${"c".repeat(64)}`,
      grantScope: { package: "@acme/other", versions: "*" }
    });
    expect(grantMatchesAction(boundedRunGrant, { runId: "run_1", attemptId: "attempt_2", action: distinctInsideScope })).toBe(true);
    expect(grantMatchesAction(boundedRunGrant, { runId: "run_1", attemptId: "attempt_2", action: outsideScope })).toBe(false);

    const nonReusable = normalizeMaterialActionRequest({
      title: "Publish signed target",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "https://example.test/report",
      targetFingerprint: `sha256:${"d".repeat(64)}`,
      targetConstraints: { queryMode: "credential_stripped", reuse: "deny" },
      grantScope: { package: "@acme/report", versions: "*" }
    });
    const deniedReuseGrant = { ...runGrant, capability: nonReusable.actionFamily, resourceScope: nonReusable.scope };
    expect(grantMatchesAction(deniedReuseGrant, { runId: "run_1", attemptId: "attempt_2", action: nonReusable })).toBe(false);
  });

  it("preserves an exact allow_once grant when the target denies run reuse", () => {
    const nonReusable = normalizeMaterialActionRequest({
      title: "Publish signed target",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "https://example.test/report",
      targetConstraints: { queryMode: "credential_stripped", reuse: "deny" }
    });
    const exactGrant = {
      runId: "run_1",
      attemptId: "attempt_1",
      capability: nonReusable.actionFamily,
      resourceScope: nonReusable.scope,
      constraints: {
        permissionDecision: "allow_once",
        actionId: "action_1",
        proposalHash: "proposal_hash_1"
      }
    };
    const exactInput = {
      runId: "run_1",
      attemptId: "attempt_1",
      actionId: "action_1",
      proposalHash: "proposal_hash_1",
      action: nonReusable
    };

    expect(grantMatchesAction(exactGrant, exactInput)).toBe(true);
    const inexactCases = [
      { label: "missing grant attempt", grant: { ...exactGrant, attemptId: undefined }, input: exactInput },
      { label: "mismatched attempt", grant: exactGrant, input: { ...exactInput, attemptId: "attempt_2" } },
      {
        label: "missing grant action",
        grant: { ...exactGrant, constraints: { permissionDecision: "allow_once", proposalHash: "proposal_hash_1" } },
        input: exactInput
      },
      { label: "missing input action", grant: exactGrant, input: { ...exactInput, actionId: undefined } },
      { label: "mismatched action", grant: exactGrant, input: { ...exactInput, actionId: "action_2" } },
      {
        label: "missing grant proposal",
        grant: { ...exactGrant, constraints: { permissionDecision: "allow_once", actionId: "action_1" } },
        input: exactInput
      },
      { label: "missing input proposal", grant: exactGrant, input: { ...exactInput, proposalHash: undefined } },
      { label: "mismatched proposal", grant: exactGrant, input: { ...exactInput, proposalHash: "proposal_hash_2" } }
    ];
    for (const { label, grant, input } of inexactCases) {
      expect({ label, matches: grantMatchesAction(grant, input) }).toEqual({ label, matches: false });
    }
    expect(grantMatchesAction({
      ...exactGrant,
      attemptId: undefined,
      constraints: { permissionDecision: "allow_run" }
    }, {
      runId: "run_1",
      attemptId: "attempt_1",
      action: nonReusable
    })).toBe(false);
  });

  it("keeps internal guardrails active in autonomous mode", () => {
    const guarded = normalizeMaterialActionRequest({
      title: "Export access token",
      kind: "credential_export",
      permissionScopes: ["secrets:read"]
    });
    expect(evaluateActionPermission({ mode: "autonomous", action: guarded })).toMatchObject({ outcome: "blocked" });
  });
});

describe("thread action commands", () => {
  it("parses explicit English action replies", () => {
    expect(parseThreadActionCommand("approve 1")).toEqual({
      verb: "approve",
      selection: { kind: "index", index: 1 },
      rawText: "approve 1"
    });
    expect(parseThreadActionCommand("apply all")).toEqual({
      verb: "apply",
      selection: { kind: "all" },
      rawText: "apply all"
    });
    expect(parseThreadActionCommand("continue proposal_run_1 because tests passed")).toEqual({
      verb: "continue",
      selection: { kind: "proposal", proposalId: "proposal_run_1" },
      rawText: "continue proposal_run_1 because tests passed",
      reason: "because tests passed"
    });
    expect(parseThreadActionCommand("reject intent_label_1")).toEqual({
      verb: "reject",
      selection: { kind: "intent", intentId: "intent_label_1" },
      rawText: "reject intent_label_1"
    });
    expect(parseThreadActionCommand("apply pr")).toEqual({
      verb: "apply",
      selection: { kind: "domain", domain: "pull_request" },
      rawText: "apply pr"
    });
  });

  it("does not treat regex-special selection tokens as parser syntax", () => {
    expect(parseThreadActionCommand("continue proposal_[x because tests passed")).toEqual({
      verb: "continue",
      selection: { kind: "proposal", proposalId: "proposal_[x" },
      rawText: "continue proposal_[x because tests passed",
      reason: "because tests passed"
    });
  });

  it("parses concise Chinese action replies", () => {
    expect(parseThreadActionCommand("批准 1")).toEqual({
      verb: "approve",
      selection: { kind: "index", index: 1 },
      rawText: "批准 1"
    });
    expect(parseThreadActionCommand("应用 全部")).toEqual({
      verb: "apply",
      selection: { kind: "all" },
      rawText: "应用 全部"
    });
    expect(parseThreadActionCommand("继续执行")).toEqual({
      verb: "continue",
      selection: { kind: "latest" },
      rawText: "继续执行"
    });
    expect(parseThreadActionCommand("拒绝 2")).toEqual({
      verb: "reject",
      selection: { kind: "index", index: 2 },
      rawText: "拒绝 2"
    });
  });

  it("ignores ambiguous conversational text", () => {
    expect(parseThreadActionCommand("looks good to me")).toBeNull();
    expect(parseThreadActionCommand("maybe apply this later")).toBeNull();
  });

  it("parses mentioned source-thread control commands", () => {
    expect(parseThreadControlCommand("@opentag /status")).toEqual({
      verb: "status",
      rawText: "/status"
    });
    expect(parseThreadControlCommand("@opentag /doctor")).toEqual({
      verb: "doctor",
      rawText: "/doctor"
    });
    expect(parseThreadControlCommand("@opentag /stop run_1")).toEqual({
      verb: "stop",
      rawText: "/stop run_1",
      runId: "run_1"
    });
    expect(parseThreadControlCommand("@opentag /ack escalation_1")).toEqual({
      verb: "acknowledge",
      rawText: "/ack escalation_1",
      escalationId: "escalation_1"
    });
    expect(parseThreadControlCommand("@opentag /resolve escalation_1 --option staging --reason Use the safe target")).toEqual({
      verb: "resolve",
      rawText: "/resolve escalation_1 --option staging --reason Use the safe target",
      escalationId: "escalation_1",
      optionId: "staging",
      reason: "Use the safe target"
    });
    expect(parseThreadControlCommand("@opentag /resolve custom-human-gate --reason Use the safe target --option staging")).toEqual({
      verb: "resolve",
      rawText: "/resolve custom-human-gate --reason Use the safe target --option staging",
      escalationId: "custom-human-gate",
      optionId: "staging",
      reason: "Use the safe target"
    });
  });

  it("does not parse non-slash status words as control commands", () => {
    expect(parseThreadControlCommand("status looks okay")).toBeNull();
    expect(parseThreadControlCommand("@opentag status")).toBeNull();
  });
});

describe("action receipts", () => {
  const candidate = {
    index: 1,
    proposalId: "proposal_1",
    proposalSummary: "Move issue forward.",
    intent: {
      intentId: "intent_label",
      domain: "labels",
      action: "add_label",
      summary: "Add bug label."
    }
  };

  it("defaults to approval-only when direct apply capability is not proven", () => {
    const receipt = buildActionReceipt(candidate);

    expect(receipt).toMatchObject({
      state: "needs_approval",
      targetLabel: "GitHub labels",
      primaryDecision: "none",
      visibleDecisions: ["approve", "reject"]
    });
    expect(actionReceiptHeading([receipt])).toBe("Needs approval");
  });

  it("uses capability context to expose ready-to-apply decisions", () => {
    const receipt = buildActionReceipt(candidate, {
      capabilityByIntentId: {
        intent_label: { state: "ready_to_apply" }
      }
    });

    expect(receipt).toMatchObject({
      state: "ready_to_apply",
      primaryDecision: "apply",
      visibleDecisions: ["apply", "reject"]
    });
    expect(actionReceiptHeading([receipt])).toBe("Ready to apply");
  });

  it("uses setup context to hide apply and guide follow-up", () => {
    const receipt = buildActionReceipt(candidate, {
      capabilityByIntentId: {
        intent_label: {
          state: "needs_setup",
          setupReason: "GitHub apply is not configured on this dispatcher."
        }
      }
    });

    expect(receipt).toMatchObject({
      state: "needs_setup",
      primaryDecision: "continue",
      setupReason: "GitHub apply is not configured on this dispatcher.",
      visibleDecisions: ["continue", "reject"]
    });
    expect(actionReceiptHeading([receipt])).toBe("Needs setup");
  });

  it("does not overstate readiness when receipt states are mixed", () => {
    const ready = buildActionReceipt(candidate, {
      capabilityByIntentId: {
        intent_label: { state: "ready_to_apply" }
      }
    });
    const setup = buildActionReceipt({
      ...candidate,
      index: 2,
      intent: { ...candidate.intent, intentId: "intent_setup", summary: "Create a pull request." }
    }, {
      capabilityByIntentId: {
        intent_setup: { state: "needs_setup", setupReason: "GitHub apply is not configured on this dispatcher." }
      }
    });
    const approval = buildActionReceipt({
      ...candidate,
      index: 3,
      intent: { ...candidate.intent, intentId: "intent_approval", summary: "Request human review." }
    });
    const unsupported = buildActionReceipt({
      ...candidate,
      index: 4,
      intent: { ...candidate.intent, intentId: "intent_unsupported", summary: "Needs manual intervention." }
    }, {
      capabilityByIntentId: {
        intent_unsupported: { state: "unsupported", setupReason: "This action is audit-only for now." }
      }
    });

    expect(actionReceiptHeading([ready, setup])).toBe("1 action ready to apply, 1 action needs setup");
    expect(actionReceiptHeading([unsupported])).toBe("Needs attention");
    expect(actionReceiptHeading([ready, unsupported])).toBe("1 action ready to apply, 1 action needs attention");
    expect(actionReceiptHeading([ready, approval])).toBe("1 action ready to apply, 1 action needs approval");
    expect(actionReceiptHeading([ready, setup, unsupported])).toBe(
      "1 action ready to apply, 1 action needs setup, 1 action needs attention"
    );
  });
});

describe("suggested action candidates", () => {
  it("flattens result suggested changes into stable action numbers", () => {
    expect(
      suggestedActionCandidatesFromResult({
        conclusion: "needs_human",
        summary: "Prepared actions.",
        suggestedChanges: [
          {
            proposalId: "proposal_1",
            createdAt: "2026-06-24T00:00:00.000Z",
            summary: "Move issue forward.",
            intents: [
              { intentId: "intent_label", domain: "labels", action: "add_label", summary: "Add bug label." },
              { intentId: "intent_review", domain: "review", action: "request_review", summary: "Ask for review." }
            ]
          }
        ]
      }).map((candidate) => ({
        index: candidate.index,
        proposalId: candidate.proposalId,
        intentId: candidate.intent.intentId
      }))
    ).toEqual([
      { index: 1, proposalId: "proposal_1", intentId: "intent_label" },
      { index: 2, proposalId: "proposal_1", intentId: "intent_review" }
    ]);
  });
});

describe("parseWorkContextMutationCommand", () => {
  it("parses a single priority mutation with mention prefix", () => {
    expect(parseWorkContextMutationCommand("@opentag set this issue's priority to High")).toEqual([
      { domain: "priority", value: "High" }
    ]);
  });

  it("parses status, assignee, and label clauses joined with and", () => {
    expect(parseWorkContextMutationCommand("set status to In Progress and assign to alice and add label bug")).toEqual([
      { domain: "status", value: "In Progress" },
      { domain: "assignee", value: "alice" },
      { domain: "label", value: "bug" }
    ]);
  });

  it("parses move-to as a status mutation and strips quotes", () => {
    expect(parseWorkContextMutationCommand('move this issue to "In Review"')).toEqual([
      { domain: "status", value: "In Review" }
    ]);
  });

  it("returns null for mixed requests that include non-mutation work", () => {
    expect(parseWorkContextMutationCommand("fix the flaky test and set priority to High")).toBeNull();
    expect(parseWorkContextMutationCommand("summarize this issue")).toBeNull();
    expect(parseWorkContextMutationCommand("")).toBeNull();
  });

  it("returns null for multi-line requests", () => {
    expect(parseWorkContextMutationCommand("set priority to High\nthen do something else")).toBeNull();
  });
});
