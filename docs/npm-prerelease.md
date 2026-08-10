# npm Prerelease Candidate Procedure

This document defines the release contract for the coordinated
`0.10.0-next.0` package family. It prepares an operator-controlled candidate;
it does not authorize publication and it is not evidence that any npm or Git
operation has occurred.

The stable `0.9.0` procedure remains in [`npm-release.md`](npm-release.md).
Registry metadata is authoritative for public availability. Source manifests,
local tarballs, passing tests, and this guide cannot establish that a candidate
is published.

## Invariants

- Candidate version: exactly `0.10.0-next.0` for all 16 public packages.
- Channel: npm `next` only. This procedure must not create, move, or verify
  `latest` as pointing to the candidate.
- Immutability: never attempt to overwrite or rebuild an already published
  package version. npm package versions are immutable release artifacts.
- Coordination: treat the 16 packages as one publication set. A partial set is
  a failed candidate, not a successful release.
- Fail closed: an ambiguous registry response, authentication failure, timeout,
  package-set mismatch, dirty release input, or changed artifact digest stops
  the procedure.
- Stable isolation: record every package's existing `latest` value before any
  mutation and prove those values are unchanged afterward.
- Promotion separation: stable promotion requires a later, separately
  authorized procedure after registry-installed and provider-live evidence.

## Local preparation gate

Run these checks without npm credentials and without any registry mutation:

```bash
set -euo pipefail
candidate=0.10.0-next.0

corepack pnpm install --frozen-lockfile
corepack pnpm release:publication-set
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm smoke:governance -- --all --allow-missing
corepack pnpm release:check

test "$(find packages -mindepth 2 -maxdepth 2 -name package.json \
  -exec node -e \
  'const p=require(require("node:path").resolve(process.argv[1]));if(p.publishConfig?.access==="public")process.stdout.write(`${p.version}\n`)' \
  {} \; | sort -u)" = "$candidate"
```

`release:publication-set` is the authority for package discovery and dependency
order. Do not maintain a second hand-written publication list. Preserve the
packed tarballs and their digests from the exact verified commit; do not rebuild
between approval, publication, and registry verification.

Passing the local gate means only that the source candidate is ready for
release review. Stop here unless an authorized release operator explicitly
starts the credentialed publication procedure.

## Credentialed preflight contract

Before any mutation, the authorized operator must capture one reviewable
receipt containing:

1. the exact release commit and a clean worktree;
2. the automatically discovered 16-package topological order;
3. each package name, exact version, tarball filename, integrity, and digest;
4. each package's current `latest` and `next` dist-tag values; and
5. an authoritative registry result proving that every
   `<package>@0.10.0-next.0` is absent.

Absence must be a confirmed registry `404`. Do not treat DNS failures, TLS
failures, timeouts, authentication errors, rate limits, malformed JSON, or any
other non-success response as package absence. If even one package version
already exists, stop: compare the registry artifact with the preserved receipt
and never issue `npm publish` for that version again.

The operator must review the complete receipt before publication begins. A
preflight from a different commit or a rebuilt tarball is invalid.

## Authorized `next` publication contract

Publication, when separately authorized, must use the preserved tarballs in
the computed topological order and the exact command shape:

```text
npm publish <preserved-tarball> --access public --tag next --provenance
```

The literal `--tag next` is mandatory. Bare `npm publish`, `--tag latest`,
`npm dist-tag add ... latest`, and `npm dist-tag rm ... latest` are prohibited
in this candidate procedure.

After each accepted publish, verify from the public registry that:

- `<package>@0.10.0-next.0` resolves to the expected version;
- its registry integrity matches the preserved artifact receipt; and
- that package's `next` dist-tag resolves to `0.10.0-next.0`.

On any rejection or mismatch, stop immediately and preserve the partial-set
receipt. Do not republish accepted versions, do not continue to later packages,
and do not change `latest` to hide or compensate for a partial candidate.

## Candidate completion evidence

The candidate is registry-complete only after independent verification proves
all of the following:

- all 16 exact versions resolve from the public registry;
- all 16 `next` dist-tags resolve to `0.10.0-next.0`;
- all recorded pre-publication `latest` dist-tags are unchanged;
- a clean temporary project installs `@opentag/cli@0.10.0-next.0` explicitly;
- the installed CLI reports `0.10.0-next.0` and passes help, setup, doctor, and
  start checks; and
- required provider-live acceptance evidence is attached or explicitly marked
  unproven.

Until those checks exist, report the state as `prepared`, `publication_started`,
`partial`, or `outcome_unknown` as supported by evidence. Never report
`published` from local output alone. Never report the stable release as
`0.10.0-next.0`; stable promotion is outside this procedure.
