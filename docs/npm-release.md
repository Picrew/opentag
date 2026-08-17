# Publishing OpenTag to npm

OpenTag npm packages are published manually from a clean local checkout until
a trusted release pipeline exists. All public packages ship as one coordinated
version.

## Target release

```text
0.11.0
```

The release is first published on the npm `next` dist-tag, tested from the
registry, then promoted to `latest`. The exact commit that produced the npm
artifacts must also receive the matching `v0.11.0` git tag and GitHub Release.

The public release set contains 18 packages. Every package has a coordinated
`0.10.0` stable baseline. Publishing `0.11.0` with `--tag next` must leave each
package's `latest` pointer at `0.10.0` until the complete registry, ACP,
governance, factory, and live-platform gate passes.

## Public package discovery and order

The release helpers discover packages from `packages/*/package.json`. A package
is in the publication set only when its manifest contains:

```json
{
  "publishConfig": {
    "access": "public"
  }
}
```

The helpers validate that every `@opentag/*` runtime dependency of a public
package is also in that set, build the internal dependency graph, and publish
it in topological order. Do not add a second hand-maintained package list to a
release script or this guide.

Run `corepack pnpm release:publication-set` whenever the exact set or order is
needed. Its live, dependency-first output is the authoritative publication
plan.

## Release gate

Start from the intended release commit with a clean working tree. Confirm that
all 18 public manifests use `0.11.0` and that the frozen lockfile is current,
then run the verification ladder in this order:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm release:publication-set
corepack pnpm build
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm smoke:governance -- --all --report .omx/governance-matrix/all.json
corepack pnpm smoke:privacy -- --allow-missing --report .omx/governance-matrix/privacy.json
corepack pnpm smoke:factory-conformance
OPENTAG_BUILTIN_ACP_AGENTS=hermes OPENTAG_HERMES_PROFILE=<profile> corepack pnpm smoke:acp-conformance
OPENTAG_BUILTIN_ACP_AGENTS=openclaw OPENTAG_OPENCLAW_PROFILE=opentag-conformance corepack pnpm smoke:acp-conformance
corepack pnpm release:check
```

`release:check` repeats the build as a packaging precondition, packs every
automatically discovered public package, installs all tarballs into a clean npm
project, audits the installed production dependency tree at `high` severity,
and runs the installed CLI's help and doctor checks. It fails before publish
when the public-package set is inconsistent, the dependency graph is cyclic, a
tarball is missing, the clean install cannot resolve the complete package
family, the audit finds a high/critical vulnerability, or the installed CLI
checks fail. If the npm audit service is temporarily unavailable, retain the
error as release evidence and retry the gate; do not treat an unavailable audit
as a clean result.

The packed-install gate also imports `@opentag/governance`, evaluates a minimal
completion contract, and checks the installed CLI's bounded completion-waiver
help. This proves the new public package and CLI surface resolve from tarballs,
not from workspace aliases. It also scans installed public-package `.json`,
`.md`, `.txt`, and `.log` artifacts for token-like values, private keys, raw
secret fields, full Lark message IDs, and developer-local absolute paths.

The OpenClaw gate expects a running Gateway and the named profile. Override
`OPENTAG_OPENCLAW_COMMAND`, `OPENTAG_OPENCLAW_GATEWAY_URL`, or
`OPENTAG_OPENCLAW_EXPECTED_VERSION` when the conformance environment differs.
The capability-aware gate must pass its readiness, scratch, and worktree cases;
it records cancellation as skipped while the definition declares
`supportsCancel: false`.

Also run the strict capability audit and keep its output with the release
record:

```bash
OPENTAG_OPENCLAW_PROFILE=opentag-conformance corepack pnpm smoke:openclaw-acp-conformance
```

The strict audit is fail-closed. On stock OpenClaw 2026.7.1, the cwd/session
cases must pass but process-tree cancellation is expected to fail because a
cancelled tool may continue through its completion marker. Do not promote that
known non-zero result into release failure while `supportsCancel: false` is
truthful, and do not change the capability to `true` until the same strict
audit passes on the exact supported OpenClaw release.

Do not use `--skip-check` for a release. Keep the release-gate outputs with the
release record, but do not commit reports that contain local paths or live
provider identifiers.

## Publish the `next` canary

Capture the exact clean commit before any npm side effect, persist it as release
authority, then confirm npm access and publish from that same commit:

```bash
(
  set -euo pipefail

  test -z "$(git status --porcelain)"
  release_state_dir=".omx/releases/0.11.0"
  release_commit_file="$release_state_dir/release-commit-sha"
  current_release_commit="$(git rev-parse HEAD)"
  mkdir -p "$release_state_dir"
  chmod 700 "$release_state_dir"
  if [ -e "$release_commit_file" ]; then
    test "$(<"$release_commit_file")" = "$current_release_commit"
  else
    release_commit_tmp="$(mktemp "$release_state_dir/release-commit-sha.XXXXXX")"
    trap 'rm -f -- "$release_commit_tmp"' EXIT
    chmod 600 "$release_commit_tmp"
    printf '%s\n' "$current_release_commit" >"$release_commit_tmp"
    mv -n "$release_commit_tmp" "$release_commit_file"
    test ! -e "$release_commit_tmp"
  fi
  release_commit="$(<"$release_commit_file")"
  test "$(git rev-parse HEAD)" = "$release_commit"

  npm whoami
  npm org ls opentag
  corepack pnpm release:publish -- --tag next
)
```

The publish command uses the same automatic publication set and topological
order as `release:check`. A coordinated release is incomplete until all 18
packages exist at `0.11.0`; do not promote a partial package family. Preserve
the exact `release-commit-sha` file with the release record. Every later lock,
tag, rollback, and release check reads that authority instead of recapturing
the current `HEAD`.

If npm asks for a two-factor one-time password, do not pass `--otp` by default
for OpenTag releases. Refresh the local npm browser login, then rerun the normal
publish command:

```bash
npm login --auth-type=web
```

Then rerun the complete fail-fast publish block above. It refuses to publish if
the clean checkout no longer matches the persisted release commit.

If npm still requires a per-publish code after a fresh browser login, stop and
continue from a trusted interactive terminal or adjust the npm account/session
policy. Never paste a one-time password into shared logs or automation.

## Verify from the npm registry

Do not smoke-test the workspace build for this gate. Install the exact canary
version into a new directory so npm must resolve every dependency from the
registry:

```bash
smoke_root="$(mktemp -d)"
(
  set -euo pipefail

  cd "$smoke_root"
  npm init --yes >/dev/null
  npm install --no-audit --no-fund @opentag/cli@0.11.0
  test "$("$smoke_root/node_modules/.bin/opentag" --version)" = "0.11.0"
  "$smoke_root/node_modules/.bin/opentag" --help
  npm audit --prefix "$smoke_root" --omit=dev --audit-level=high
)
```

The version must be `0.11.0`. With isolated config and state directories, run
the setup, doctor, and foreground-start path for one platform that has real
test credentials:

```bash
export OPENTAG_CONFIG_HOME="$smoke_root/config"
export OPENTAG_STATE_DIR="$smoke_root/state"
export PATH="$smoke_root/node_modules/.bin:$PATH"

opentag setup
opentag doctor
opentag start
```

Use the relevant platform setup guide for the credentialed `opentag setup`
answers. While `opentag start` is running, send one real provider event and
verify the complete loop: provider ingest, Run creation, local execution,
source-thread reply, and the expected audit/action receipt. Stop the foreground
process after the receipt is visible. Record which platform was tested and the
redacted evidence in the release notes; never record provider tokens, fencing
tokens, raw ACP frames, or full private message IDs.

The old GitHub factory live case depended on the removed provider-specific
callback stack and is no longer a release gate. Do not replace it with a queued
run event: `delivery.intent.queued` proves durable enqueue, not provider
acceptance. Until a registry-installed provider adapter is active and its live
acceptance retains delivery-journal begin and terminal outcome evidence, the
unified delivery vertical remains non-releasable. Run the credential-free
protocol, factory, and fixture checks documented in
[Delivery Integration Verification](./real-integration-smoke-test.md), and
record this activation limitation in the release notes.

Also verify every package and its canary tag before promotion:

```bash
(
  set -euo pipefail

  test "$("$smoke_root/node_modules/.bin/opentag" --version)" = "0.11.0"
  for manifest in packages/*/package.json; do
    [ "$(jq -r '.publishConfig.access // ""' "$manifest")" = "public" ] || continue
    package="$(jq -r '.name' "$manifest")"
    test "$(npm view "$package@0.11.0" version)" = "0.11.0"
    test "$(npm view "$package" dist-tags.next)" = "0.11.0"
    npm view "$package" dist-tags --json
  done
)
```

## Promote the same artifacts to `latest`

Promotion changes dist-tags only; it must not rebuild or republish. Before
capturing rollback authority, acquire the repository-wide npm dist-tag lock.
GitHub ref creation is atomic, so two release operators cannot both acquire the
window:

```bash
(
  set -euo pipefail

  release_state_dir=".omx/releases/0.11.0"
  release_commit_file="$release_state_dir/release-commit-sha"
  lock_owner_file="$release_state_dir/npm-dist-tags.lock-sha"
  test -f "$release_commit_file"
  release_commit="$(<"$release_commit_file")"
  test "$(git rev-parse HEAD)" = "$release_commit"
  test -z "$(git status --porcelain)"
  test ! -e "$lock_owner_file"
  lock_nonce="$(openssl rand -hex 16)"
  lock_owner="$(gh api user --jq '.login')"
  release_tree="$(gh api "repos/amplifthq/opentag/git/commits/$release_commit" --jq '.tree.sha')"
  lock_commit="$(gh api --method POST repos/amplifthq/opentag/git/commits \
    -f message="OpenTag npm dist-tag lock release=$release_commit owner=$lock_owner nonce=$lock_nonce" \
    -f tree="$release_tree" \
    -f "parents[]=$release_commit" \
    --jq '.sha')"
  test "$(gh api "repos/amplifthq/opentag/git/commits/$lock_commit" --jq '.parents[0].sha')" = "$release_commit"
  lock_owner_tmp="$(mktemp "$release_state_dir/npm-dist-tags.lock-sha.XXXXXX")"
  trap 'rm -f -- "$lock_owner_tmp"' EXIT
  chmod 600 "$lock_owner_tmp"
  printf '%s\n' "$lock_commit" >"$lock_owner_tmp"
  mv -n "$lock_owner_tmp" "$lock_owner_file"
  test ! -e "$lock_owner_tmp"
  if ! gh api --method POST repos/amplifthq/opentag/git/refs \
    -f ref=refs/heads/release-lock/npm-dist-tags \
    -f sha="$lock_commit"; then
    rm -f -- "$lock_owner_file"
    exit 1
  fi
  test "$(gh api repos/amplifthq/opentag/git/ref/heads/release-lock/npm-dist-tags --jq '.object.sha')" = "$(<"$lock_owner_file")"
)
```

A failed ref creation means another promotion or rollback owns the window, or a
previous operator left a stale lock. Stop. Inspect the referenced commit and
coordinate with that operator before deciding whether the lock is stale; never
delete it merely to make this command pass. The unique lock commit has the
release commit as its parent and records an acquisition nonce and operator; its
SHA is persisted in the protected release-state directory. A different
operator on the same release commit therefore cannot accidentally pass the
ownership checks. Keep the lock until the matching GitHub Release succeeds or
rollback is fully verified.

While holding that lock, create exactly one durable pre-promotion snapshot. The
snapshot command refuses to overwrite an existing file so a partial-promotion
retry cannot replace the original rollback authority:

```bash
(
  set -euo pipefail

  release_state_dir=".omx/releases/0.11.0"
  release_commit_file="$release_state_dir/release-commit-sha"
  lock_owner_file="$release_state_dir/npm-dist-tags.lock-sha"
  test -f "$release_commit_file"
  release_commit="$(<"$release_commit_file")"
  test "$(git rev-parse HEAD)" = "$release_commit"
  test -f "$lock_owner_file"
  lock_commit="$(<"$lock_owner_file")"
  test "$(gh api repos/amplifthq/opentag/git/ref/heads/release-lock/npm-dist-tags --jq '.object.sha')" = "$lock_commit"
  test "$(gh api "repos/amplifthq/opentag/git/commits/$lock_commit" --jq '.parents[0].sha')" = "$release_commit"
  rollback_file="$release_state_dir/pre-promotion-latest.tsv"
  mkdir -p "$release_state_dir"
  chmod 700 "$release_state_dir"
  test ! -e "$rollback_file"
  snapshot_tmp="$(mktemp "$release_state_dir/pre-promotion-latest.XXXXXX")"
  trap 'rm -f -- "$snapshot_tmp"' EXIT
  chmod 600 "$snapshot_tmp"
  for manifest in packages/*/package.json; do
    [ "$(jq -r '.publishConfig.access // ""' "$manifest")" = "public" ] || continue
    package="$(jq -r '.name' "$manifest")"
    dist_tags_json="$(npm view "$package" dist-tags --json)"
    previous_latest="$(jq -er '.latest | select(type == "string" and length > 0)' <<<"$dist_tags_json")"
    test "$previous_latest" = "0.10.0"
    printf '%s\t%s\n' "$package" "$previous_latest" >>"$snapshot_tmp"
  done
  test "$(wc -l <"$snapshot_tmp" | tr -d ' ')" = "18"
  test "$(cut -f1 "$snapshot_tmp" | sort -u | wc -l | tr -d ' ')" = "18"
  test "$(cut -f2 "$snapshot_tmp" | sort -u)" = "0.10.0"
  mv -n "$snapshot_tmp" "$rollback_file"
  test ! -e "$snapshot_tmp"
)
```

Keep that exact file until the release is complete. It records the actual
pre-promotion `latest` target for every package and fails unless all 18 packages
are still on the known `0.10.0` baseline. A registry lookup failure or a
missing/unexpected tag stops the release; it is never interpreted as rollback
authority. Back the snapshot up outside the ephemeral shell session before
changing any dist-tag.

The following promotion loop is retryable. Every first attempt and retry must
reuse the original `rollback_file`; never rerun the snapshot block after any
package has been promoted:

```bash
(
  set -euo pipefail

  release_state_dir=".omx/releases/0.11.0"
  release_commit_file="$release_state_dir/release-commit-sha"
  lock_owner_file="$release_state_dir/npm-dist-tags.lock-sha"
  test -f "$release_commit_file"
  release_commit="$(<"$release_commit_file")"
  test "$(git rev-parse HEAD)" = "$release_commit"
  test -f "$lock_owner_file"
  lock_commit="$(<"$lock_owner_file")"
  test "$(gh api repos/amplifthq/opentag/git/ref/heads/release-lock/npm-dist-tags --jq '.object.sha')" = "$lock_commit"
  test "$(gh api "repos/amplifthq/opentag/git/commits/$lock_commit" --jq '.parents[0].sha')" = "$release_commit"
  rollback_file=".omx/releases/0.11.0/pre-promotion-latest.tsv"
  test -f "$rollback_file"
  test "$(wc -l <"$rollback_file" | tr -d ' ')" = "18"
  test "$(cut -f1 "$rollback_file" | sort -u | wc -l | tr -d ' ')" = "18"
  test "$(cut -f2 "$rollback_file" | sort -u)" = "0.10.0"

  for manifest in packages/*/package.json; do
    [ "$(jq -r '.publishConfig.access // ""' "$manifest")" = "public" ] || continue
    package="$(jq -r '.name' "$manifest")"
    previous_latest="$(awk -F '\t' -v package="$package" '$1 == package { print $2 }' "$rollback_file")"
    test "$previous_latest" = "0.10.0"
    current_tags_json="$(npm view "$package" dist-tags --json)"
    current_next="$(jq -er '.next | select(type == "string" and length > 0)' <<<"$current_tags_json")"
    test "$current_next" = "0.11.0"
    current_latest="$(jq -er '.latest | select(type == "string" and length > 0)' <<<"$current_tags_json")"
    case "$current_latest" in
      "$previous_latest") npm dist-tag add "$package@0.11.0" latest ;;
      "0.11.0") ;;
      *) echo "Refusing to replace drifted $package latest=$current_latest" >&2; exit 1 ;;
    esac
    test "$(npm view "$package" dist-tags.latest)" = "0.11.0"
    test "$(npm view "$package" dist-tags.next)" = "0.11.0"
  done
)
```

Rerun the package loop from the registry-verification section and confirm both
`next` and `latest` point at `0.11.0` for all 18 packages.

## Create the matching source release

Create the source tag from the exact clean commit used for `release:publish`.
Copy the `v0.11.0` section of `CHANGELOG.md` into a temporary release-notes file,
then run:

```bash
(
  set -euo pipefail

  release_commit_file=".omx/releases/0.11.0/release-commit-sha"
  test -f "$release_commit_file"
  release_commit="$(<"$release_commit_file")"
  test "$(git rev-parse HEAD)" = "$release_commit"
  test -z "$(git status --porcelain)"

  release_tag_probe="$(mktemp)"
  if ! gh api --include --silent repos/amplifthq/opentag/git/ref/tags/v0.11.0 >"$release_tag_probe"; then
    : # Inspect the HTTP status below; only a confirmed 404 permits tag creation.
  fi
  release_tag_status="$(awk 'toupper($1) ~ /^HTTP\// {status=$2} END {print status}' "$release_tag_probe")"
  rm -f "$release_tag_probe"
  case "$release_tag_status" in
    200)
      release_tag_ref="$(gh api repos/amplifthq/opentag/git/ref/tags/v0.11.0)"
      ;;
    404)
      if git show-ref --verify --quiet refs/tags/v0.11.0; then
        test "$(git cat-file -t refs/tags/v0.11.0)" = "tag"
        test "$(git rev-parse 'v0.11.0^{}')" = "$release_commit"
      else
        git tag -a v0.11.0 "$release_commit" -m "OpenTag v0.11.0"
      fi
      git push origin refs/tags/v0.11.0
      release_tag_ref="$(gh api repos/amplifthq/opentag/git/ref/tags/v0.11.0)"
      ;;
    *)
      echo "Refusing tag creation after upstream lookup returned HTTP ${release_tag_status:-unavailable}" >&2
      exit 1
      ;;
  esac
  test "$(jq -r '.object.type' <<<"$release_tag_ref")" = "tag"
  release_tag_object="$(jq -r '.object.sha' <<<"$release_tag_ref")"
  test "$(gh api "repos/amplifthq/opentag/git/tags/$release_tag_object" --jq '.object.sha')" = "$release_commit"
  existing_release_state="$(gh api --paginate 'repos/amplifthq/opentag/releases?per_page=100' \
    --jq '.[] | select(.tag_name == "v0.11.0") | [.tag_name, .draft, .prerelease, (.published_at != null)] | @tsv')"
  case "$existing_release_state" in
    "")
      gh release create v0.11.0 \
        --verify-tag \
        --title "OpenTag v0.11.0" \
        --notes-file /tmp/opentag-v0.11.0-release-notes.md
      ;;
    $'v0.11.0\tfalse\tfalse\ttrue') ;;
    *) echo "Refusing conflicting draft, prerelease, unpublished, or duplicate v0.11.0 GitHub Release state" >&2; exit 1 ;;
  esac
  release_state="$(gh api repos/amplifthq/opentag/releases/tags/v0.11.0)"
  test "$(jq -r '.tag_name' <<<"$release_state")" = "v0.11.0"
  test "$(jq -r '.draft' <<<"$release_state")" = "false"
  test "$(jq -r '.prerelease' <<<"$release_state")" = "false"
  jq -er '.published_at | select(type == "string" and length > 0)' <<<"$release_state" >/dev/null
)
```

The tag/release block is retryable after partial success. It reuses an existing
local tag only when it is annotated and peels to the persisted release commit;
the pushed remote tag must also be annotated and target that commit. The
paginated release lookup must succeed before an absent release is created, so a
network or API failure is never misread as authoritative absence. An existing
draft, prerelease, unpublished object, or duplicate match is conflicting state:
stop and inspect it rather than treating it as the completed `v0.11.0` release.

Verify that the GitHub Release tag resolves to the same commit that produced
the npm tarballs. The release is not complete until npm, git, and GitHub all
identify version `0.11.0`. After that verification—or after a completed and
verified rollback—release the exclusive window only when it still points at
your release commit:

```bash
(
  set -euo pipefail

  release_state_dir=".omx/releases/0.11.0"
  release_commit_file="$release_state_dir/release-commit-sha"
  lock_owner_file="$release_state_dir/npm-dist-tags.lock-sha"
  test -f "$release_commit_file"
  release_commit="$(<"$release_commit_file")"
  test "$(git rev-parse HEAD)" = "$release_commit"
  test -f "$lock_owner_file"
  lock_commit="$(<"$lock_owner_file")"
  test "$(gh api repos/amplifthq/opentag/git/ref/heads/release-lock/npm-dist-tags --jq '.object.sha')" = "$lock_commit"
  test "$(gh api "repos/amplifthq/opentag/git/commits/$lock_commit" --jq '.parents[0].sha')" = "$release_commit"
  gh api --method DELETE repos/amplifthq/opentag/git/refs/heads/release-lock/npm-dist-tags
  rm -f -- "$lock_owner_file"
)
```

## Dist-tag rollback

Do not unpublish immutable package versions during rollback.

- If canary validation fails before promotion, leave every package's previous
  `latest` tag unchanged and stop the rollout. Preserve `next` for diagnosis or
  move it to the corrected version.
- If `latest` promotion fails partway, first finish or retry only the idempotent
  promotion loop with the original snapshot. If 0.11.0 itself must be withdrawn,
  restore each package's recorded pre-promotion target and leave 0.11.0 on `next`
  for diagnosis:

```bash
(
  set -euo pipefail

  release_state_dir=".omx/releases/0.11.0"
  release_commit_file="$release_state_dir/release-commit-sha"
  lock_owner_file="$release_state_dir/npm-dist-tags.lock-sha"
  test -f "$release_commit_file"
  release_commit="$(<"$release_commit_file")"
  test "$(git rev-parse HEAD)" = "$release_commit"
  test -f "$lock_owner_file"
  lock_commit="$(<"$lock_owner_file")"
  test "$(gh api repos/amplifthq/opentag/git/ref/heads/release-lock/npm-dist-tags --jq '.object.sha')" = "$lock_commit"
  test "$(gh api "repos/amplifthq/opentag/git/commits/$lock_commit" --jq '.parents[0].sha')" = "$release_commit"
  rollback_file=".omx/releases/0.11.0/pre-promotion-latest.tsv"
  test -f "$rollback_file"
  test "$(wc -l <"$rollback_file" | tr -d ' ')" = "18"
  test "$(cut -f1 "$rollback_file" | sort -u | wc -l | tr -d ' ')" = "18"
  test "$(cut -f2 "$rollback_file" | sort -u)" = "0.10.0"
  for manifest in packages/*/package.json; do
    [ "$(jq -r '.publishConfig.access // ""' "$manifest")" = "public" ] || continue
    package="$(jq -r '.name' "$manifest")"
    previous_latest="$(awk -F '\t' -v package="$package" '$1 == package { print $2 }' "$rollback_file")"
    test "$previous_latest" = "0.10.0"
    test "$(npm view "$package@$previous_latest" version)" = "$previous_latest"
    current_tags_json="$(npm view "$package" dist-tags --json)"
    current_latest="$(jq -er '.latest | select(type == "string" and length > 0)' <<<"$current_tags_json")"
    current_next="$(jq -er '.next | select(type == "string" and length > 0)' <<<"$current_tags_json")"
    test "$current_next" = "0.11.0"
    case "$current_latest" in
      "$previous_latest") ;;
      "0.11.0") npm dist-tag add "$package@$previous_latest" latest ;;
      *) echo "Refusing to replace drifted $package latest=$current_latest" >&2; exit 1 ;;
    esac
    test "$(npm view "$package" dist-tags.latest)" = "$previous_latest"
    test "$(npm view "$package" dist-tags.next)" = "0.11.0"
  done
)
```

Verify all dist-tags after rollback, publish a clear incident note, then release
the exclusive window with the guarded command above. A later fix must use a new
version; never overwrite `0.11.0`.
