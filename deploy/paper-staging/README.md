# Paper unified-account staging review

**Release CLOSED. Review package, not production readiness.** This first deployment
phase exercises the merged canonical Entryway PostgreSQL implementation with real
TLS and a restricted login. It does not deploy a working provider/PDS signup flow.
Do not substitute fixture attestations to make the remaining phases pass.

## Prepare and inspect

Requirements: Python 3.9+, Git, OpenSSL, Docker Engine with Compose v2+, and enough
disk for a Node dependency image. Preparation itself needs no daemon or cloud
credentials. The pinned federation commit must exist in this checkout.

```sh
python3 deploy/paper-staging/prepare.py /absolute/new/private/paper-staging
docker compose -f /absolute/new/private/paper-staging/compose.json --profile acceptance config --quiet
```

The parent directory must exist; the destination must not. Preparation never
overwrites credentials or reuses a volume. Each bundle gets a unique Compose project.
`PREPARED` is written last; an incomplete directory must not be deployed. Do not
commit, upload, email, or publish the generated directory: it contains secrets.
The CA private key is outside every container mount. Certificates expire after
seven days. Prepare a fresh disposable bundle for a later rehearsal; do not
silently replace credentials under an existing database.

`lock.json` pins both approved repository baselines and multi-platform image
digests. Only federation code is built in this phase, using `npm ci` and the pinned
lockfile. Package lifecycle scripts are disabled. Updating pins is a reviewed
change followed by a new acceptance run. The current ActivityPods pin is **merged PR #267** at
`de9568fabcf5e53a7c7140fadbc9fdc9c519aa9c`, building on the
journal-bound owner-consent gate (#256) and independently attested native SAI
gate (#255). It additionally fences provider-issued OAuth access, one-use
authorization codes and refresh-token families by a fresh owner-approved
consent generation. It uses atomic Redis 8.2.11 code consumption and refresh
CAS; replay can revoke an entire token family. OAuth reapproval cannot revive
an earlier signed PDS access JWT or refresh token. The Redis grant key hashes
the exact owner/client tuple to prevent delimiter collisions. OAuth Redis
services refuse offline command queuing and automatic replay after
ambiguous write acknowledgments; production refresh encryption now requires
a private operator-controlled key.

ActivityPods PR #257 exact head
`6bb185ef5ebdb5b40ef3203bcedd6d679a6e1622` passed **7/7**
workflows, including actual Redis 8.2.11 two-worker refresh and signed
DPoP/PDS OAuth acceptance, PostgreSQL signed-repo/Jena isolation,
coordinator, PLC, backend and lint.

The provider source also includes a reviewed post-#257
startup correction in **PR #258**: the pure Redis Lua CAS policy was moved
from the recursive Moleculer OAuth service-loader glob to `backend/utils`.
PR #258 head `5f15d21b8e021fd3f9bc605dee3bfd5eeeef3921` passed all
three triggered workflows, including a loader-layout regression check.
This correction addresses the startup defect identified in staging run
44942966184. The corrected real production-mode provider passed **both**
negative-release staging jobs in federation run **44943917370** at merged
federation PR #184 exact head `fdb9d76afbecfc5d7746a72149d7dc9c9bc01a09`.
The run verified actual provider/frontend HTTPS startup, OIDC signing-key
continuity after provider/Redis/Fuseki restart, both explicit signup 503
denials, TLS PostgreSQL admission, independent protected Jena credentials,
13 hostile authorization checks and durable protected-RDF readback.

New ActivityPods **PR #259** adds atomic Redis 8.2 `GETDEL` consumption
for Pushed Authorization Requests (PAR) and browser owner-consent challenges.
It also configures their Redis clients and the DPoP nonce client to **disable
offline queuing and automatic resend** after unknown command acknowledgments,
requires connection readiness at provider startup, and checks successful
persist acknowledgments before returning new one-time records. Its real-Redis
two-worker regression forces `GET` + `DEL` implementations to fail
deterministically. PR #259 exact head
`ede212aaea59cac1e3d0edd727aa2c528867174e` passed all **3/3**
triggered workflows: Redis OAuth/DPoP acceptance **44945079574**, backend
**44945079643**, and dependency/lint **44945079510**. Its
production-mode **negative-release** provider acceptance then passed in
federation PR #185 exact-head staging run **44945508497**, with both
`tls-runtime` and `local-provider` jobs successful, verified OIDC
signing-key continuity after restart, independent Jena isolation,
13 hostile-access checks, and both signup 503 denials.

ActivityPods **PR #260** closes an additional real browser authentication
boundary: the OAuth session service previously permitted a fixed development
HMAC signing fallback even under `NODE_ENV=production` when no private
session secret was supplied, potentially allowing forged owner WebID cookies.
The provider now refuses production startup without a private signing secret
at least 32 UTF-8 bytes. It also validates exact two-segment session-cookie
MAC shape and size before `timingSafeEqual`, and safely ignores malformed
URI percent escapes and oversized cookies instead of turning attacker data
into HTTP 500 errors. A dedicated boundary proof tests real HMAC roundtrip,
wrong-length signatures, appended segments, malformed cookies, and startup
denials. PR #260 exact head
`0d249384f457f19dc372ead2c82733891336d565` passed **3/3**
triggered workflows: OAuth/Redis/DPoP acceptance **44945899874**,
backend **44945899861**, and lint/PLC/enrollment **44945899843**.
The prior #260 source passed fresh production-mode negative-release
staging in federation PR #187 exact-head run **44946214742**:
both `tls-runtime` and `local-provider` succeeded, including real
HTTPS startup, OIDC JWKS continuity across restarts, independent protected
Jena attestor credential isolation, 13 hostile-access checks and both
explicit signup 503 denials.

The newer ActivityPods **PR #261** is an intentionally **NONACTIVATED**
PostgreSQL 18 recovery-authority candidate. It adds a narrow
`paper_atproto_authority.oauth_generations` projection linked to
independently attested SAI consent, separate issuer/revoker/reader/signer
function-only NOLOGIN roles, and compare-and-swap issuance/revocation.
A PG transaction-held signer row lock serializes revocation against
signed-write authorization. Dependent OAuth rows cascade on native
SAI consent deletion. A real PG18 + Redis 8.2.11 test uses **binary
Redis DUMP/RESTORE** to confirm that an older active Redis snapshot
cannot override an intact PG revocation; it also tests competing
writers/revokers and least-privilege role denial.

PR #261 final head `f034c136b910fd3821cfeb0879d5df7f2141e881`
passed **3/3** independent workflows: PG18/Redis restore proof
**44948555620**, backend **44948555646**, and lint/regressions
**44948555594**. This new candidate is not connected to production
OAuth token issuance/introspection/refresh or a real signed-PDS commit.
No issuer/revoker is deployed. A **separate non-rewindable witness**
is still required to block PostgreSQL PITR/backup rollback; no
successful signed hosted PDS positive signup has been established.
See federation P0 issue #186.

These results do not replace the fresh real provider staging test at
the *current* ActivityPods source pin; they are separate fixture proofs.

The merged implementation remains **NONACTIVATED**. Existing unversioned
OAuth/PDS credentials require fresh owner approval. Redis backup/restore
epoch fencing, independent protected-SAI positive activation, and a genuinely
hosted signed PDS remain separate production acceptance requirements.

The newer merged ActivityPods **PR #262** adds a PostgreSQL 18
reader-only v5 revision function and a **NONACTIVATED** real OAuth handler
fence. Authorization codes carry the PG generation; signed JWT
introspection and encrypted refresh issue/rotation/readback consult
fresh restricted PG as well as Redis. Its disposable proof runs real
OAuth code, JWT and refresh handlers; a native Redis binary
DUMP/RESTORE cannot revive credentials after PG revocation, a
privilege-mismatched PG login is rejected, and a primary PG outage
fails closed. Exact ActivityPods PR-head `a49e249311abe3bd7baa834638203041c84bf236`
passed 4/4 workflows: PG18 + Redis8.2 restore proof **44953794032**,
existing OAuth/DPoP **44953793960**, backend **44953793927**, and
lint/regressions **44953794007**. Merge commit:
`0098cdf948734a94de7ef3a83053c1e1966f1251`.

No production owner-authenticated PG OAuth issuer or revoker is
deployed and the real signed PDS writer does NOT yet acquire the
new PG OAuth epoch lock inside the signed-commit transaction.
The independent anti-rollback witness across PG PITR and hosted
positive signup remain mandatory. Current P0 issue: #186.

The newer ActivityPods **PR #263** is an additional **NONACTIVATED**
PostgreSQL 18 signed-repository authorization gate: the restricted
reference-MST signed writer now locks both canonical SAI and OAuth
generation **in the same PG transaction** that commits signed head,
immutable blocks, native outbox and projection intent. PG v6 grants the
signed writer EXECUTE on an exact row-locking SECURITY DEFINER predicate;
no OAuth table read, reapproval, or revocation privilege is added.
The trusted provider OAuth bridge carries exact client/grant/scope/epoch
into its candidate signed writer factory, checked again after commit.

ActivityPods PR #263 exact head
`9da94b9ab34b61e7e39164eea8d664bccf15cd97` passed **7/7**
workflows: real PG18 signed reference-MST/OAuth-revoker contention
**44954374646**, protected Jena **44954374658**, PLC **44954374612**,
coordinator **44954374614**, real OAuth Redis **44954374616**,
backend **44954374631**, and lint/regressions **44954374619**.
The real PG proof reports an OAuth generation lock in the signed
commit, revoker serialization, denied post-revocation signed write,
unchanged signed head, and zero leaked idle transactions.

**Production still has no owner-authenticated PG OAuth issuer/revoker,
independent anti-PITR rollback witness, hosted PDS positive signup, or
fully released provider writer binding.** PR #263 only adds a
disposable/proof-only transaction boundary. The release remains CLOSED;
federation P0 issue #186 stays open. All image digests are unchanged.

### P0 development checkpoint through ActivityPods #267 (November 21, 2026)

**No production activation.** This source pin adds four more **NONACTIVATED**
security and integration candidates after the previously verified #263
signed-post transactional consent fence:

- Merged ActivityPods **#264** at `ab518498ce473995abb7418b83679b98a7604ede`:
  PostgreSQL v7 derives initial narrow ATProto OAuth issuer/revoker
  authority from the actual authenticated owner signup/SAI journal,
  instead of accepting an arbitrary owner WebID or client. Real PG18
  test denies forged/expired owner sessions, foreign clients, scope
  escalation and stale approvals. Direct signed-JWT issuance without
  its exact PG epoch is rejected. Eight exact-head checks passed,
  including signed-PG **44956877983**, PG OAuth **44956878015**,
  protected Jena **44956878024**, backend **44956877980** and
  lint **44956877978**.
- Merged ActivityPods **#265** at `04270e1c9f7d960f1f5e3204083ece624d6b6acf`:
  independently deployed PostgreSQL 18 witness schema with
  strictly separated issuer/revoker/reader/receipt-attestor roles,
  hash-chained revision CAS and fail-closed unsealed transitions.
  Disposable test on **two different PG18 clusters** plus real Redis
  binary DUMP/RESTORE passes, including simulated old primary-PG
  authorization rows; exact-head witness **44957663720**,
  PG restore **44957663724**, backend **44957663748**,
  lint **44957663765**.
- Merged ActivityPods **#266** at `e9ef05651eafbf19db243104858198f9faa666e5`:
  SAME journal-bound new account/SAI/OAuth fixture advances into
  a real secp256k1-signed ATProto genesis and `app.bsky.feed.post`
  with independently verified CAR/CIDs, durable outbox and denied
  cross-account/post-revocation writes. Six exact-head checks passed,
  including signed PG18 **44957919478** and protected Jena
  **44957919484**. It still seeds the signup account fixture
  directly and uses a synthetic PG-only projection ACK. It is NOT
  a real HTTPS-browser signup or hosted signed PDS test.
- Merged ActivityPods **#267** at `de9568fabcf5e53a7c7140fadbc9fdc9c519aa9c`:
  real signed access JWT issuance/introspection and the shared OAuth
  authorization/refresh candidate path now require the separate
  restricted, sealed high-water witness **and** canonical PG/Redis
  when test-only gates are explicitly enabled. Witness outage,
  unsealed new grant and pre-revocation PG+Redis restore deny.
  All four exact-head workflows passed: witness **44958499314**,
  combined PG **44958499230**, backend **44958499223**,
  lint **44958499215**. GitHub Codex's review could not run
  because review credits were exhausted; it did not supply
  independent code-review approval.

These are security-gated disposable candidate paths: production
OAuth/owner-browser, actual PDS signer and positive signup have NOT
been activated or released. No independent immutable WORM receipt
store has been provisioned; the test used an explicitly fake
in-memory write-once receipt. It simulated primary PG rollback,
not a physical WAL PITR/restore with independent WORM catch-up.
A true witness must survive even its own restore and hold
authorization through the signed-PDS commit/externally acknowledged
revocation boundary. Long-lived post-enrollment owner-consent
management, real protected Jena signed record readback, DID/PLC
remote signing/rotation, real HTTPS PDS XRPC and remote ActivityPub
peer acceptance remain P0 blockers.

See ActivityPods docs:
`docs/paper-oauth-external-pitr-witness.md` and
`docs/paper-unified-positive-acceptance.md`. The production
release remains **CLOSED**; issue #186 remains OPEN.
Every image digest/federation source pin remains unchanged.

This production-mode Paper staging profile does NOT enable the disposable
issuer, protected-SAI attestor or positive PDS account flow. It still uses
`NODE_ENV=production`, and **both** unified and native account-creation
entrypoints must return their existing explicit `503` release-gate denials
before and after restart. CI fetches the ActivityPods source only from
`lock.json`; all image digests and the federation source remain frozen.
Successful HTTPS/OIDC signing-key continuity, PG TLS and protected Jena
isolation are a **negative-release smoke test**, not positive owner signup
or hosted-PDS readiness. `release=CLOSED` must not change.

## Execute only after reviewing the bundle

```sh
docker compose -f /absolute/new/private/paper-staging/compose.json --profile acceptance build acceptance
docker compose -f /absolute/new/private/paper-staging/compose.json up -d --wait --wait-timeout 120 postgres
docker compose -f /absolute/new/private/paper-staging/compose.json --profile acceptance run --rm acceptance
docker compose -f /absolute/new/private/paper-staging/compose.json restart postgres
docker compose -f /absolute/new/private/paper-staging/compose.json up -d --wait --wait-timeout 120 postgres
docker compose -f /absolute/new/private/paper-staging/compose.json --profile acceptance run --rm acceptance
```

The database has no published ports and only an isolated internal network. The
administrator is socket-only inside the container; runtime TCP access requires
TLS and SCRAM. Initial schema migration runs once on a new volume. The application
login inherits only `paper_entryway_runtime`. No restore fence is reset, no existing
Redis data is imported, and no unknown mutation outcome is retried. Startup and
queries have bounded waits. Container restarts are operator controlled.

The runner checks production connection options, verified TLS, runtime-role
readiness, denied direct reads, denied owner escalation, and rejected plaintext.
The existing `Entryway PostgreSQL authority` workflow separately covers concurrent
reservations, CAS, restart evidence and logical-restore quarantine. A TLS smoke
pass does not replace that evidence or prove deployed multiworker recovery.

Stop without deleting data using `docker compose -f .../compose.json down`.
Only for this disposable rehearsal, `down --volumes` removes its database. Never
point this package at production data or copy production secrets into it.

## Provider/PDS deployment specification for the next phase

### Local provider browser profile

The optional `provider` profile builds the actual pinned ActivityPods backend and
frontend. It adds Redis, Fuseki and explicit HTTPS ingress on **127.0.0.1:8443**.
It tests actual provider configuration/UI delivery and the **closed** unified-signup
response, not successful new-account creation. PR #252's positive browser/consent,
PostgreSQL activation and signed provider genesis proofs ran only in its separately
gated disposable environment, **not in this deployment-equivalent profile**. The
staging PostgreSQL foundation and provider account-completion services remain
unconnected; no disposable identity bypass is enabled here.

```sh
python3 deploy/paper-staging/prepare.py /absolute/new/private/paper-provider \
  --activitypods-checkout /absolute/activity-pods-checkout
docker compose -f /absolute/new/private/paper-provider/compose.json --profile provider config --quiet
docker compose -f /absolute/new/private/paper-provider/compose.json --profile provider build provider frontend
docker compose -f /absolute/new/private/paper-provider/compose.json --profile provider up -d postgres ingress
docker compose -f /absolute/new/private/paper-provider/compose.json exec -T provider node /staging/provider-probe.mjs
```

Resolve `provider.paper.example.org` and `login.paper.example.org` to `127.0.0.1` on the local
browser host. Trust this bundle's `certificates/ca.crt` only in a disposable browser
profile; do not disable certificate validation globally or install the private CA
key. Then visit `https://login.paper.example.org:8443/login`. Generated secrets are read
at startup; they are not baked into images or expanded into Compose configuration.
The backend reads its private secret file before dropping to UID/GID 1000.
The staging generator now creates a **unique 32-byte OAuth refresh-token
AES-GCM key** under `secrets/provider.json` (0600), injects it only at
provider startup, and rejects a missing/extra/malformed secret. This meets
the pinned provider's fail-closed production encryption-key requirement
without exposing it in Compose, Docker image layers or logs. Never rotate
the key under a still-live Redis refresh-token namespace: the corresponding
family must be revoked or re-authorized first.
JWT keys, provider state, uploads, Redis and Fuseki have dedicated volumes.
The `local-provider` CI job also restarts the Redis, Fuseki and provider
containers without replacing their volumes or credentials. It repeats
CA-verified discovery, JWKS, UI and signup-denial probes after restart and
compares a canonical SHA-256 fingerprint of the **public** OIDC signing keys.
Key continuity alone is not evidence of signing-key custody under an
independent production HSM or of completed account/ATProto recovery.
A separate optional `storage-proof` profile now creates a physically independent
protected Jena/Fuseki TDB2 service with an owner-private Shiro policy and volume.
The ordinary provider receives **none** of its provisioner, projector or attestor
credentials and is absent from the separate internal `protected-authority`
network. The disposable proof container, separately mounted with those
credentials, creates one protected dataset and verifies that ordinary provider
credentials cannot read, update or administrate it; the independent reader can
query and not mutate, and only the projector can write. The proof is repeated
after protected-Fuseki restart to establish durable isolation. The disposable
proof runner runs as the **host secret-file owner's UID/GID**, without Linux
capabilities, with a read-only filesystem, no Docker socket, no host ports
and a bounded lifespan. The generated test credentials remain owner-private
(0600), so neither broad file permissions nor DAC-override privileges are needed. The normal
provider never receives those mounts. The proof service is a restricted
**rehearsal**, not the production canonical consent/identity store:
no signup or SAI projection has been connected to it, and protected-storage
release gates remain disabled.

These names are under the reserved documentation domain `example.org`; this is
local-only naming, not evidence of public domain ownership or resolvable ATProto
handles. Production URL syntax checks and all signup release fuses remain intact.

The profile does not provide email delivery, app-server transaction binding or
a hosted PDS. Its negative signup check must remain a separate result from future
positive signup acceptance. Keep enough local disk space for Node build layers and
data; do not prune unrelated Docker resources to make room. Bounded diagnostics:

```sh
python3 deploy/paper-staging/diagnose.py /absolute/new/private/paper-provider
```

Use a dedicated disposable host/project and HTTPS names for provider API, provider
frontend, PDS, and an ActivityPods app. Paper/Memory remain apps: the provider owns
identity creation, signing and consent. Frontend-to-provider login/consent must use
real Solid-OIDC/DPoP sessions and server-bound signup transactions. Entryway's bearer
token and provisioning requests remain backend-only, never browser credentials.

Only the HTTPS ingress may publish a port. Route app/provider/PDS hosts explicitly;
do not publish PostgreSQL, Redis, Fuseki, admin endpoints or Docker's socket. Use
separate named volumes, per-service secrets and immutable built images. Keep the
Entryway runtime role separate from the migration role. The provider owns its
existing Redis/Fuseki storage; PostgreSQL alone owns Entryway routes. This package
does not change that boundary. Media/search workers are outside this signup gate.

The following are required before enabling successful provider/PDS signup:

| Gate | Required evidence | Current status |
| --- | --- | --- |
| Provider completion | Genuine signed PDS, Solid and current SAI evidence committed to the same canonical operation; uncertain creates reconcile without replay | Disposable local PR #252 proof passed; production pathway still blocked by `ACCOUNT_COMPLETION_ATTESTATION_PENDING` |
| Signed hosted PDS | Actual HTTPS DID/handle/key/repository checks, native writes, key persistence and restart | Disposable signed genesis/readback passed; hosted production PDS, native writes, restart and release gate still unverified |
| App transaction | Authenticated app-server session, expiry, single-use state, exact callback and owner binding; concurrent tab and replay tests | Local Chromium callback/PKCE proved in PR #252; staged independent app-server transaction and concurrent tab/replay acceptance still pending |
| Consent/revocation | Real browser owner consent; required/optional grants; operation-time denial after revocation | Local real-Jena / OIDC session admission regression checks passed; staging browser and refresh-token lifecycle proof still pending |
| Multiworker failure | Two deployed workers; kill before/after provider create, lost acknowledgement, restart and replay; exactly one identity/route | Local PostgreSQL/two-worker consent races passed; deployed kill/recovery/restore and exactly-one-identity acceptance still pending |
| Cutover and restore | Frozen Redis reconciliation, database ownership inspection, TLS, backup/restore, external physical/PITR write epoch fence | Logical restore CI exists; external restore fence remains open |

Do not add fake successful health endpoints for these gates or remove release
constants. Record repository SHA, built image digest, environment identifier,
scenario, timestamp and sanitized result for each run. Keep raw tokens, passwords,
proofs, browser storage and signing keys out of logs/artifacts. Any failed or absent
scenario keeps release CLOSED. No provider/PDS deployment is authorized by the
database smoke passing alone.
