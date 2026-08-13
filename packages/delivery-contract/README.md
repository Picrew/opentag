# @opentag/delivery-contract

Canonical OpenTag V2 side-effect intent and sanitized delivery-observation
contracts.

The default export is platform-neutral. It contains strict Zod schemas,
canonical JSON serialization, domain-separated byte framing, and explicit
digest-verification functions. It does not import Node runtime modules.

Node callers can use the separate `@opentag/delivery-contract/node` subpath for
the built-in SHA-256 provider:

```ts
import {
  verifyHostedObservationIntegrity,
  verifyHostedObservationPolicy,
} from '@opentag/delivery-contract';
import {
  nodeSha256DigestProvider,
} from '@opentag/delivery-contract/node';

const observation = await verifyHostedObservationIntegrity(
  nodeSha256DigestProvider,
  signatureVerifier,
  input,
);
verifyHostedObservationPolicy(observation, expectedPolicy);
```

Cloud and browser runtimes should supply their own `DigestProvider`, typically
backed by Web Crypto, plus an async `SignatureVerifier` for Ed25519. The
authored schemas and canonical bytes stay identical;
only hashing is runtime-specific.
Every `DigestProvider` result must be exactly `sha256:` followed by 64 lowercase
hexadecimal characters.

`verifyHostedObservationIntegrity` proves strict shape, canonical semantic
digests, the Ed25519 signature, and that local Provider I/O began inside the
signed authorization window. It does not decide tenant trust. Call
`verifyHostedObservationPolicy` with explicit expected issuer, audience,
public-key-set digest, deployment/capability versions, and
`historical_append` mode. Historical append intentionally does not reject an
authorization merely because it is expired at ingestion time.

Before any local Provider I/O, call
`verifyHostedAuthorizationForLocalBegin` on the authorization alone with the
complete expected current identity/configuration tuple and current time/skew.
This pre-I/O API does not require or accept a post-outcome receipt.
The permitted clock skew is an explicit `maxClockSkewMs` protected claim,
bounded to an integer from 0 through 30,000. Local begin must expect that exact
signed value, and both begin-time and receipt lineage checks apply the same
signed window; no verifier adds an implicit wider allowance.

## Fixture corpus

`fixtures/relay.delivery-observation.v2` is the only authored V2 corpus. Its
manifest binds the exact sorted file set, raw bytes, stable IDs/kinds, and a
corpus digest. Corpus framing is:

```text
u32be(path byte length) || UTF-8 path ||
u64be(content byte length) || raw content bytes
```

Each semantic digest uses:

```text
UTF-8 domain || NUL || canonical JSON bytes
```

`sideEffectIntentId` identifies the immutable local intent. `deliveryId`
identifies the Hosted delivery aggregate, so the two are deliberately distinct.
`operationDigest` and `presentationDigest` bind provider-operation and rendered
presentation identity without sending either raw value to Cloud. Every Cloud
intent, attempt, and provider observation is a Hosted post-outcome record and
therefore carries the same signed authorization plus immutable local
begin/outcome receipt. Local/offline audit records are intentionally not part of
the Cloud wire schema.

Run the repository verifier with:

```bash
pnpm verify:delivery-fixtures
```

The verifier resolves the declared `tsx` dependency from the dispatcher
workspace; no package-manager-global executable is assumed.

The verifier performs no network or Provider I/O.
