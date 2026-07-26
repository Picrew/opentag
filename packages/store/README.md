# @opentag/store

SQLite and Drizzle persistence primitives for OpenTag.

Use this package when embedding the dispatcher, testing dispatcher behavior, or building a compatible control plane that wants OpenTag's default run storage and lease model.

## Install

```bash
pnpm add @opentag/store
```

## Exports

- `migrateSchema`: creates or updates the SQLite schema.
- `createOpenTagRepository`: repository API for runners, bindings, runs, leases, progress, completion, factory recipes/workstreams, replay-safe batch receipts, and audit events.
- Drizzle table definitions from `schema.ts`.
- Types such as `ClaimedOpenTagRun`, `OpenTagAuditEvent`, `RepoBinding`, `ChannelBinding`, and `SlackChannelBinding`.

## Example

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createOpenTagRepository, migrateSchema } from "@opentag/store";

const sqlite = new Database("opentag.db");
migrateSchema(sqlite);

const repo = createOpenTagRepository(drizzle(sqlite));

await repo.registerRunner({ runnerId: "runner_local", name: "Local Runner" });
await repo.createRepoBinding({
  provider: "github",
  owner: "acme",
  repo: "demo",
  runnerId: "runner_local"
});
```

## Stability

The repository methods are public API for embedded control planes. The raw Drizzle table definitions are lower-level and may evolve with migrations.
