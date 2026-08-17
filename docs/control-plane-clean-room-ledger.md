# Control Plane clean-room ledger

This ledger records the provenance boundary for the Node/PostgreSQL Control
Plane rebuilt on branch `codex/control-plane-clean-rebuild` from public OpenTag
revision `39f851920aae6e22e21e095173f54408097dff8c` (`origin/main` at the start of
the rebuild).

## Allowed inputs

- Public OpenTag source and public Control V1 tests at the base revision.
- The independently authored architecture and ADR documents migrated into this
  worktree as requirements.
- Official package documentation and normal generated package metadata.
- Black-box observations of a private reference implementation only when used
  to describe OpenTag-specific behavior; its source, assets, layouts, copy,
  and history are excluded.

## Authorship classification

| Path | Classification | Notes |
| --- | --- | --- |
| `apps/control-plane/src/**` | Newly authored | Node/Hono application, domain modules, PostgreSQL state, jobs, identity, and static-console serving |
| `apps/control-plane/web/**` | Newly authored | Minimal OpenTag operator console; no imported template components or assets |
| `apps/control-plane/test/**` | Newly authored | Unit and real-PostgreSQL behavior corpus |
| `apps/control-plane/migrations/**` | Newly authored, reviewed SQL | Append-only PostgreSQL migration corpus |
| `apps/control-plane/Dockerfile` | Newly authored | One non-root Node OCI image for every process role |
| `deploy/compose/**` | Newly authored | PostgreSQL-only self-hosting profile and configuration example |
| `packages/control-protocol/**` | Extracted from public OpenTag source | Focused public package; Core remains an identity-equal compatibility re-export |
| `packages/client/**` and CLI changes | Modified public OpenTag source | Existing consumers wired to the canonical protocol and Control Plane |
| `docs/adr/0003-*`, `docs/control-plane-*` | Independently authored design and operations documentation | No prior application implementation is included |
| `pnpm-lock.yaml` | Generated | pnpm resolution output for reviewed manifests |
| `apps/control-plane/dist/**` | Generated, ignored | tsup/Vite build output; must be reproducible from source |

Third-party packages remain governed by their own licenses and are installed
from the package registry through the checked lockfile. They are not vendored
as application source.

## Excluded material

The clean branch must not contain or make reachable through its own history:

- the former private Control Plane application source or Git history;
- template pages, components, content, branding, screenshots, assets, schema,
  configuration, routes, or product copy;
- Worker/D1/KV/R2 runtime scaffolding retained only because it existed before;
- dormant billing, newsletter, notification, blog, pricing, storage, or SaaS
  starter dependencies;
- secrets, local `.env` files, database dumps, cookies, or pairing/runtime/API
  key material.

## Review gates

Before the branch is committed or made public:

1. Verify its merge base and reachable history start from the recorded public
   revision, not a private implementation branch.
2. Inspect every new application source path and dependency.
3. Search the tracked tree and packed OCI context for excluded product surfaces,
   template markers, private filenames, and secrets.
4. Build and inspect the production image; confirm it runs as the non-root
   `opentag` user and contains no SQLite or Cloudflare runtime dependency.
5. Run the canonical protocol, Client, real-PostgreSQL, Compose, backup/restore,
   and local-independence tests.
6. Record managed deployment, provider mutation, publication, and production
   activation as unknown until separately proven. Local success is not that
   evidence.

This ledger establishes source provenance and review expectations. It is not a
license opinion or a claim that an unperformed deployment exists.
