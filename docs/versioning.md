# Versioning and Publishing Policy

OpenTag packages are versioned and published as a coordinated package family.

## Package Family

Public packages, shown in one valid dependency order:

- `@opentag/core`
- `@opentag/governance`
- `@opentag/client`
- `@opentag/discord`
- `@opentag/github`
- `@opentag/gitlab`
- `@opentag/lark`
- `@opentag/linear`
- `@opentag/runner`
- `@opentag/slack`
- `@opentag/store`
- `@opentag/teams`
- `@opentag/telegram`
- `@opentag/dispatcher`
- `@opentag/local-runtime`
- `@opentag/cli`

Private runnable apps are not published:

- `@opentag/dispatcher-app`
- `@opentag/github-probot`
- `@opentag/slack-events`
- `@opentag/opentagd`

## Pre-1.0 Policy

The source package family is prepared as the `0.10.0-next.0` prerelease
candidate. Source manifests are preparation evidence only: npm dist-tags remain
authoritative for published channel versions, and `0.9.0` remains the
documented stable release until registry evidence says otherwise. The public
API is still settling, so all releases remain in the `0.x` line until the
package contracts are stable enough for `1.0.0`.

The first npm release was published as the coordinated `0.1.0` package family.
The `0.2.0` release added the published CLI, local runtime package, and Lark and Telegram packages.
The `0.3.0` release improved CLI setup flexibility, source-thread approval rendering, Slack interactivity, and executor result summaries.
The `0.3.4` release improves service startup reliability, Lark status updates, final-card readability, and read-only executor result summaries.
The `0.3.5` release adds Linux user-service support and keeps unsupported platforms on terminal startup by default.
The `0.4.0` release adds GitLab source-thread ingestion, note callbacks, and merge request action application.
The `0.5.0` release adds Discord, Linear, and Microsoft Teams adapters, ACP-first agent execution, durable Attempt leases and fencing, governed material-action receipts and reconciliation, and the corresponding Client/Runner migration.
The `0.6.0` release moves all built-in coding agents onto Generic ACP, adds Cursor, OpenCode, and OpenClaw executor profiles, requires Node.js 22 for the CLI/Local Runtime/Runner, and hardens ACP isolation, cancellation conformance, Slack summaries, and the coordinated release gate.
The `0.7.0` release completes the Phase 1 completion-governance vertical slice with durable work threads and contracts, deterministic evidence-backed assessments, GitHub PR/check/merge evidence ingestion, replay-safe reassessment, CLI explanations and bounded waivers, and a 16-package publication set that includes `@opentag/governance`.
The `0.8.0` release completes the first provider-live recipe-driven factory loop with access identity, bounded human escalation, explainable multi-runner routing, immutable recipes and WorkThread-only workstreams, restart-safe batch admission, authoritative accepted-outcome metrics, and a real GitHub issue-to-merge-to-receipt proof while keeping planning external.
The `0.9.0` release adds an authorized, read-only Slack-to-Linear project backlog query with bounded pagination, deterministic ordering, live OAuth token use, exact channel authorization, a query-only credential boundary, and an isolated best-effort Events API lane that does not change control or mutation delivery semantics.
The `0.10.0-next.0` source candidate adds canonical, evidence-backed completion
authority for governed runs. Its prerelease procedure is intentionally
`next`-only, fail-closed, and immutable; see
[`npm-prerelease.md`](npm-prerelease.md). Preparing this source candidate does
not assert that npm publication, provider-live validation, or stable promotion
has occurred.

For each npm release:

- Set every public package to the same version.
- Keep `private: true` only on runnable apps and the root workspace.
- Discover the public package family from `packages/*/package.json` entries with
  `publishConfig.access=public`; do not maintain separate package arrays in
  release scripts.
- Validate that every public package's `@opentag/*` runtime dependency is in
  the discovered publication set, reject dependency cycles, and build and
  publish packages in topological order.
- Verify `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Run the governance and privacy smoke suites.
- Pack every discovered public package, install the tarballs into a clean npm
  project, and run the installed CLI help and doctor checks.
- Publish the coordinated version to the npm `next` dist-tag first.
- Install the exact CLI version from the public registry and complete setup,
  doctor, start, and one credentialed real-platform smoke before promotion.
- Promote the same immutable package versions to `latest`; never rebuild or
  republish between canary and promotion.
- Create a matching annotated git tag and GitHub Release from the exact commit
  used for npm publication.

For `0.x` releases:

- Patch versions fix bugs without changing public TypeScript contracts or HTTP semantics.
- Minor versions may add optional fields, new functions, new adapters, or carefully documented breaking changes.
- Every breaking change must be called out in release notes because SemVer treats `0.x` as unstable but users still need migration guidance.

## 1.0 and Later

After `1.0.0`, follow SemVer:

- Patch: bug fixes and documentation updates that do not change public behavior.
- Minor: backward-compatible additions such as optional fields, new adapters, and new helper functions.
- Major: breaking changes to exported types, function signatures, endpoint semantics, storage requirements, or package layout.

## Compatibility Rules

- Prefer additive changes over modifying existing fields.
- Keep `@opentag/core` as the compatibility anchor for protocol objects.
- Avoid leaking app-only environment variable behavior into package APIs.
- Treat callback message shape, executor contracts, and dispatcher client method signatures as public API.
- If a storage change requires migration behavior, document it in release notes and keep `migrateSchema` idempotent.

## Release Checklist

1. Update package versions consistently across public packages.
2. Run `pnpm release:publication-set` and verify that automatic discovery
   returns all expected public packages, their versions match, and every
   internal runtime dependency belongs to the publication set.
3. Update changelog and migration notes with package-specific changes and every
   breaking public contract.
4. Run `pnpm install` to refresh `pnpm-lock.yaml`.
5. Run build, lint, typecheck, and tests sequentially.
6. Run governance and privacy smoke validation.
7. Run `release:check` to pack the complete publication set, install it in a
   clean npm project, and verify the installed CLI.
8. Publish all public packages to `next` in the computed topological order.
9. Confirm the exact version and `next` dist-tag for every package from the npm
   registry.
10. Install `@opentag/cli@<version>` from the registry in a clean directory.
11. Run CLI version/help, setup, doctor, and start from that registry
    installation, then repeat the GitHub factory acceptance loop through
    external source, batch admission, local execution, PR, required check,
    merge, completion, restart, source receipt, and workstream metrics.
12. Promote the same package versions to `latest` by changing dist-tags only.
13. Confirm `latest` and `next` for the complete package family.
14. Create and push the matching annotated `v<version>` git tag from the exact
    publication commit.
15. Create the matching GitHub Release with the changelog notes and verify its
    tag target.

If canary validation fails, leave `latest` unchanged and remove or move the
`next` tags after preserving diagnostics. If a promoted release must be rolled
back, move `latest` for every package back to the previous coordinated version;
do not unpublish or overwrite an immutable npm version.
