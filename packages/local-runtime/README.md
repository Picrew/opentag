# @opentag/local-runtime

Local OpenTag runtime helpers used by `@opentag/cli`.

Use this package when embedding the same local dispatcher, daemon, diagnostics, and GitHub PR helpers that the CLI uses.

## Install

```bash
pnpm add @opentag/local-runtime
```

## Exports

- `startDispatcher`: starts the local dispatcher with the unified delivery
  producer and provider registry.
- `serveDaemon`: starts the local daemon loop.
- `createDaemonRuntimeInput`: derives daemon runtime input from config.
- `runDoctor`: checks dispatcher, bindings, checkouts, and executors.
- `parseDaemonConfig`: parses daemon config with compatibility aliases.
- `maybeCreatePullRequest`: creates GitHub pull requests from prepared run branches.

Subpath exports are also available:

```ts
import { startDispatcher } from "@opentag/local-runtime/dispatcher";
import { serveDaemon } from "@opentag/local-runtime/daemon";
import { runDoctor } from "@opentag/local-runtime/doctor";
```

## Requirements

- Node.js 22.14 or newer.
- A writable SQLite database path for the dispatcher.
- A local checkout for any Project Target you bind.

## Stability

This package is the local runtime boundary for the CLI. Keep app wrappers thin and put reusable local runtime behavior here.
