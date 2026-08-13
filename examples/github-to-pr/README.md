# GitHub to Pull Request

The current safe example is split into two independently verifiable paths:

1. run and governance behavior, including local execution and pull-request
   completion evidence;
2. outbound delivery through the unified delivery producer and side-effect
   kernel.

The old CLI-assisted scripts that posted run comments through provider-specific
callback sinks were removed. There is no compatibility fallback. Until a
GitHub provider adapter is registered and the unified delivery activation gate
is open, GitHub presentations record `delivery.activation_blocked` and perform
no provider I/O.

## Local protocol proof

From the repository root:

```bash
corepack pnpm smoke:protocol
corepack pnpm smoke:factory-conformance
```

These checks prove run lifecycle, governance, workstream behavior, presentation
generation, and durable handoff to a test unified producer. A
`delivery.intent.queued` run event proves enqueue only; it is not a GitHub
comment receipt.

## Live GitHub acceptance requirement

Before restoring a live GitHub-to-PR demo, the acceptance must use the
production provider registry and retain:

- exact release and GitHub adapter identity;
- the immutable provider binding generation;
- delivery journal begin and terminal outcome evidence;
- current-head check and pull-request facts from GitHub;
- restart behavior that does not resend an ambiguous begun operation;
- a provider-visible comment or verified hosted observation.

Do not claim the demo is live from executor success, a queued intent, or a pull
request URI alone. See [Delivery Integration Verification](../../docs/real-integration-smoke-test.md)
for the evidence contract.
