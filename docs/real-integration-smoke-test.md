# Delivery Integration Verification

OpenTag has one outbound-delivery path: a dispatcher presentation is resolved
to a canonical delivery intent, durably queued, claimed by the side-effect
kernel, and settled from the provider adapter result. The old callback sinks
and callback-delivery table are not part of this path.

Keep the evidence levels separate:

| Evidence | What it proves | What it does not prove |
| --- | --- | --- |
| `delivery.intent.queued` run event | The dispatcher handed a presentation to the unified producer and the intent was durably accepted | Provider I/O began or a user saw a message |
| `delivery.activation_blocked` run event | Delivery was unavailable and no provider I/O was attempted | A retry or fallback occurred |
| Delivery journal `pending` / `leased` | A local intent exists or is being claimed | Provider I/O began |
| Delivery journal `provider_io_begun` | The fenced provider operation began | Its outcome is known |
| Terminal attempt `accepted`, `rejected`, `outcome_unknown`, or `attention` | The durable provider outcome recorded by the kernel | More than the named outcome |
| Signed hosted delivery observation | The hosted post-outcome fact passed integrity and policy verification | Local run completion by itself |

Never derive provider success from a run status, an enqueue event, an executor
result, or the existence of an external-looking URI. If terminal journal or
verified observation evidence is unavailable, report the provider outcome as
unavailable.

## Credential-free contract smokes

Run these from the repository root:

```bash
corepack pnpm smoke:protocol
corepack pnpm smoke:slack-protocol
corepack pnpm smoke:factory-conformance
corepack pnpm verify:delivery-fixtures
```

The protocol smokes inject a test `deliveryProducer`, capture the resulting
presentations, and require truthful `delivery.intent.queued` audit events. They
also assert that the run-event read model never invents a delivered outcome.
The factory conformance case adds restart-safe run, recipe, workstream, and
batch behavior without provider credentials. The fixture verifier checks the
canonical hosted delivery-observation corpus without network or provider I/O.

These checks are implementation evidence. They are not live-provider proof.

## Activation state

The unified delivery vertical is intentionally fail-closed while its provider
root set, cloud consumer cutover, production inventory, migration, and
operations work are incomplete. With no active producer/adapter composition,
the dispatcher records `delivery.activation_blocked`; it does not call an old
sink or silently fall back to a legacy transport.

Use:

```bash
opentag status --run <run_id>
```

The status output reports queued intents and activation blocks from run events.
It explicitly says that provider outcomes are unavailable in that read model.
Inspect the delivery journal or a verified hosted observation for outcome
truth.

## Current provider-live acceptance

The retained live harness case is the registry-installed Slack `/linear`
acceptance:

```bash
corepack pnpm smoke:live -- --case slack-linear-registry-live --dry-run
```

It verifies one real Slack command, read-only Linear GraphQL access, and a
provider-visible Slack reply using the exact installed release. This is a
separate application-level provider acceptance. Do not use it as evidence that
the partially activated unified delivery kernel is production-ready.

Before claiming a new unified-delivery provider is live, add an acceptance that
retains all of the following, with secrets and raw private message content
redacted:

1. exact release and provider-adapter artifact identity;
2. the canonical delivery intent and immutable provider binding generation;
3. local begin markers and lease-fence lineage;
4. the terminal delivery-attempt state and evidence digest;
5. provider-visible evidence or a signed hosted observation;
6. restart behavior that cannot resend after an ambiguous begun operation.

Until that proof exists, the correct release state is non-releasable for the
unified delivery vertical.
