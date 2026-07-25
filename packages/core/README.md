# @opentag/core

Core protocol types and validation for OpenTag.

Use this package when you need to create, validate, parse, or document OpenTag protocol objects without depending on any provider SDK or runtime service.

## Install

```bash
pnpm add @opentag/core
```

## Exports

- `OpenTagEventSchema`, `OpenTagRunSchema`, `OpenTagRunResultSchema`: Zod schemas for protocol objects.
- `OpenTagEvent`, `OpenTagRun`, `OpenTagRunResult`: TypeScript types inferred from the schemas.
- `CompletionContract`, `CompletionAssessment`, `HumanEscalation`: additive completion-governance protocol objects that keep executor outcome separate from accepted work completion.
- `RunnerDirectoryEntry`, `RoutingDecision`, `AcceptedCompletionMetrics`: additive schemas for current runner readiness, explainable placement, and accepted outcomes by runner or executor.
- `parseOpenTagMention`: extracts an `@opentag` command from workspace text.
- `commandFromRawText`: maps raw command text to a normalized intent.
- `OpenTagJsonSchemas`: JSON Schema definitions for systems that do not use TypeScript or Zod.

## Example

```ts
import { OpenTagEventSchema, parseOpenTagMention } from "@opentag/core";

const command = parseOpenTagMention("@opentag fix this flaky test");
if (!command.matched) {
  throw new Error("No OpenTag command found");
}

const event = OpenTagEventSchema.parse({
  id: "evt_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: new Date().toISOString(),
  actor: { provider: "github", providerUserId: "42", handle: "octocat" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: command.rawText, intent: command.intent, args: command.args },
  context: [],
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
});
```

## Stability

This package is the most stable OpenTag surface. Protocol changes should be additive whenever possible and follow the repository versioning policy.
