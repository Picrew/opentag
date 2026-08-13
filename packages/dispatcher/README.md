# @opentag/dispatcher

Embeddable dispatcher service for OpenTag.

Use this package when you want to host the OpenTag dispatcher inside another Node or Hono-compatible service instead of running `@opentag/dispatcher-app`.

## Install

```bash
pnpm add @opentag/dispatcher
```

## Exports

- `createDispatcherApp`: creates the Hono app that exposes the OpenTag dispatcher API.
- `UnifiedDeliveryProducer`: validates and enqueues configured delivery intents.
- `DispatcherDeliveryPresentation`: provider-neutral rendering input for the
  configured delivery-intent resolver.

## Example

```ts
import { createDispatcherApp } from "@opentag/dispatcher";

export const dispatcher = createDispatcherApp({
  databasePath: "opentag.db",
  pairingToken: process.env.OPENTAG_PAIRING_TOKEN
});
```

## API Shape

The app exposes `/healthz` and `/v1/*` dispatcher endpoints for runners, Project Target bindings, generic channel bindings, Slack compatibility bindings, runs, progress, heartbeats, completion, and audit event lookup.

Factory-mode callers can additionally create immutable recipe snapshots and
WorkThread-only workstreams, submit replay-safe workstream batches, inspect a
durable batch receipt, and read workstream metrics/evaluation. Every batch item
uses the same managed-channel ownership and Run admission path as `/v1/runs`;
routine per-item source-thread acknowledgements are suppressed in favor of one
bounded exception summary.

## Governed WorkLoop continuation

An immutable factory recipe may opt into `continuation.mode: evidence_driven`
for selected `completion_evidence_changed`, `human_escalation_resolved`, or
`retryable_run_failure` triggers. The dispatcher re-evaluates the canonical
WorkLoop and Workstream budgets at the trigger boundary; it never treats a
timer, a runner result, or an `attention_required` metric by itself as authority
to continue.

One eligible Workstream creates a normal child Run with
`triggeredByAction.kind: resume_work_thread`, durable parent/trigger/digest
metadata, and the same admission, access-profile, routing, and managed-channel
checks as any other Run. Managed Slack/Lark admission stores a non-secret
application/bot ownership attestation on the parent event; continuation must
match that attestation to the current binding, and a request-bound human
resolution must also present the current owning adapter principal. Admission-
time Slack/Lark escalations persist the server-verified provider, conversation
scope, non-secret ownership, and binding digest so acknowledgement and
resolution remain fail-closed even though no Run exists yet. Human
resolution continuations carry a credential-sanitized immutable decision
snapshot in the child context and bind its digest into continuation metadata.
Multiple eligible Workstreams, missing recipe
authority, a blocked Workstream, a human/reconciliation action, or a concurrent
Run all fail closed. The admission check does not queue an implicit follow-up,
and Run persistence repeats the active-conversation check inside its transaction
to close the admission/write race; direct child Run writers also reject an
already-committed automatic continuation, and queued follow-up promotion uses
the same transactional fence. Created continuations do not emit a
second source acknowledgement; their lineage and control-plane event are the
receipt. Deferred, ambiguous, rejected, and failed continuation outcomes remain
distinct in direct and source-thread responses so a new task is recommended
only for manual-policy outcomes.

When `pairingToken` is set, every `/v1/*` endpoint requires:

```text
Authorization: Bearer <pairingToken>
```

## Stability

The Hono app factory and delivery-intent boundary are public API. Delivery is
activation-blocked until a resolver and durable submitter are configured.
