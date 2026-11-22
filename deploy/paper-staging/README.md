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
change followed by a new acceptance run. The current ActivityPods pin is **merged PR #287** at
`3c3bf8c0ed17521dcbb055150790c5fadeca0bc8`, building on the
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

### Independently retained version-history high-water and composed PG18 proof (#280/#281)

ActivityPods **#280** merged
`7fc35b2e1f8b5c1fd25809fd499e4d87e46f4328`. AWS S3 Object
Lock COMPLIANCE retains protected **versions** but does not prevent
normal DELETE inserting a *delete marker*. A current-object listing
can therefore hide an immutable revocation. The **NONACTIVATED**
`ListObjectVersions` reader enumerates historical revisions and
delete markers, rejects any masked/duplicate version, noncontiguous
epoch revision, malformed pagination, too many receipts, invalid
retention or changed latest `VersionId`, and returns independently
readback canonical epoch bytes for the PG18 witness v6
`active_checkpoint` before/after comparison. It bounds listing to
4096 receipts/eight pages with no positive-cache fallback.
Four exact-head CI workflows passed: S3 SDK **44979090389**,
independent witness **44979090347**, backend **44979090363** and
lint **44979090333**.

ActivityPods **#281** merged
`1fa9d0d887d4b5dd85809a56f06989a1e71257c6`. Its dedicated
two-physical-PG18 + Redis8.2 witness test now invokes the
**actual S3 version-history verification code** against a
**disposable in-memory S3 API transport**, rather than an ad hoc
Map sort, and feeds the verified bytes to the restricted PostgreSQL
high-water reader during actual signed JWT admission. It proves
revoked JWT denial after dual PG/Redis **logical** rollback when
newer immutable receipts survive, plus immediate denial of an S3
delete marker. All **4/4** exact-head workflows passed: PG restore
**44979450419**, independent witness **44979450499**, backend
**44979450485**, lint **44979450418**.

**This does NOT establish a real immutable archive.** No
independently controlled S3 COMPLIANCE bucket/account, separate
audited IAM credentials, live version enumeration/readback or
production WORM/witness service has been deployed; positive signup
remains prohibited. The O(n) high-water listing, completeness
under a misconfigured storage intermediary, independent
anti-rollback/incarnation anchor, signed-intent chain catch-up,
physical both-primary-and-witness PG PITR/WAL, owner post-enrollment
OAuth and hosted cross-protocol acceptance remain P0 blockers.
No image digest or federation source change; `release=CLOSED`.

### Verified owner bearer / S3 COMPLIANCE transport security checkpoint (#278/#279)

**P0 security remediation in actual OAuth authorization path.** ActivityPods
**#279** merged at `8e13c8404b3a1af1e1d1edf531ce302f6af8ca71`.
The previous provider OAuth API used SemApps
`auth.jwt.decodeToken` to select an owner WebID from HTTP
`Authorization: Bearer ...`, despite upstream SemApps explicitly marking
that action **UNVERIFIED**. The actual endpoint now calls
`auth.jwt.verifyServerSignedToken`, rejects forged/unsigned/expired or
unknown signing keys, enforces canonical HTTPS WebID claims, and refuses
invalid bearer fallback to a browser cookie. Because upstream SemApps
JWT issuance lacks `exp` by default, an owner's verified bearer must
also have a fresh, valid `iat` within **one hour** for this OAuth
approval. Existing unrelated SemApps authentication remains untouched.

Exact-head #279 workflows **44978765556** (real Redis8.2 OAuth
consent/replay/DPoP and signed RSA negative proof), **44978765481**
(backend) and **44978765482** (lint) all passed. This is a real
authorization bypass repair, distinct from test-only release candidates.
It is not sufficient proof of revoked/disabled owner session admission
or production owner post-enrollment consent.

Merged ActivityPods **#278**, `17da942cd219ace2f8045f048195516df16e497d`,
adds a **NONACTIVATED**, private, exact-version AWS S3 API COMPLIANCE
archive transport for owner epoch and signed-write intent receipts.
It enforces bucket versioning/lock default, conditional
`If-None-Match: *` PUT, exact `VersionId`, COMPLIANCE
`GetObjectRetention`, bounded independent byte readback and version
stability. Four exact-head #278 workflows passed: actual pinned upstream
SDK contract **44978422733**, two PG18 witness **44978422718**,
backend **44978422742**, lint **44978422760**.

**Still NOT production-ready:** no independently controlled deployed
S3 Object Lock account/bucket, no verified cross-object WORM high-water
against delete-marker history/physical dual PG WAL restore, no
post-enrollment owner grant/revoke authority or positive hosted
WebID/Solid/SAI + ActivityPub + signed PDS acceptance.
No provider production WORM adapter was activated, and frozen
federation source/OCI images plus `release=CLOSED` remain unchanged.
See P0 issue #186. Staging MUST still prove both signup entrypoints
remain 503 and JWKS credentials survive service restarts.

### Physical PostgreSQL PITR and immutable epoch high-water (#275/#276)

ActivityPods **#275** merged as
`4f934fc87621255436c9c5d5323d0acb20cb08fc` after
**4/4** exact-head checks passed (two physical PG18 witness/Redis
signed-JWT rollback proof **44976466239**, recovery **44976466267**,
backend **44976466229**, dependency/lint **44976466275**).
The **NONACTIVATED** v6 independent witness `active_checkpoint`
function exposes an exact sealed epoch hash/revision/operation only
to the restricted reader. A separate test-gated immutable high-water
callback reads the independently retained latest epoch receipt,
checks strict canonical bytes and owner/client scope, and compares
the PostgreSQL witness checkpoint **before and after** the external
readback. A signed JWT is rejected when BOTH primary and witness PG
and Redis are *logically rewound* to an old, revoked grant.
Missing/foreign/uncanonical archive objects, stale epoch and
concurrent revocation deny; no positive caching or runtime activation.

ActivityPods **#276** merged as
`ed424a874cd0bb39b88e98a61546936046e1dee8`
after exact-head merge-reconciled physical PostgreSQL PITR
`466afe5a3f99e4128172708aca7386598372422d`
passed **3/3** workflows: real physical PG18/WAL test
**44976808546**, backend **44976808515**, dependency/lint
**44976808522**. Two independently initialized PG18 systems
create data-checksummed streamed `pg_basebackup`, verify manifest
with `pg_verifybackup`, archive actual WAL and restore fresh
clusters to named **before and after revocation** points with
`recovery.signal`/`restore_command`, verifying expected epochs,
system identifiers and promotion.

These two proofs are deliberately **separate**: the high-water JWT
test exercises true Account/OAuth/Witness SQL with **logical** row
rewinds and an in-memory archive Map; the physical PITR test
exercises true WAL recovery using **synthetic** authorization
records and locally archived ordinary files. **Neither is a
production-integrated physical restore of real Paper identities,
nor proof that the WORM archive cannot rewind or omit a later
receipt.** Both remain NONACTIVATED; no hosted production runtime,
external storage permissions or signup switch changed.

**Still blocking production release:** a separately administered
version-retained immutable Object Lock store and independently
verifiable complete high-water enumeration for epoch plus pending/
resolved signed-write intent chains; hosted real primary+witness
PITR and WAL transaction abort barrier; authenticated long-lived
post-enrollment owner OAuth approval/revocation; genuine hosted
WebID/Solid/SAI, ATProto XRPC signed PDS and ActivityPub remote
positive account acceptance; independent security review. Keep
all OCI digests/frozen federation source unchanged,
`release=CLOSED`, and P0 issue #186 OPEN.

### P0 WORM intent settlement barrier (#274, witness v5)

ActivityPods **#274** merged at
`5f13bd6072b1a4847e0534d34d41e880ca34f462` after exact
head `aec7fb3ad774335f1e1a3f607bad521bd4dfddd9` passed
**8/8** workflows: two physical PG18 witness/Redis signed-MST proof,
PG/Redis recovery, native signed ATProto repository, protected Jena,
canonical coordinator, PLC, backend and lint. This candidate adds
NONACTIVATED v5 witness SQL that rejects unsafe historical-intent
migrations and binds pending/resolved receipts to the sealed OAuth
epoch event, operation UUID and both signed commit CIDs.

A signed reference-MST writer must independently verify the exact
**pending** archive receipt before its primary signed PostgreSQL
transaction. A verified positive commit now remains **ineligible
for a successful revocation ACK** until an independently retained
and sealed **resolved** receipt exists. The runtime reconciler
retains v4 commit-only authority; no runtime abort is available.
An indexed eight-intent cap covers all unarchived operations,
including `committed` outcomes that have not been sealed. The
disposable test validates this capacity and recovery ordering
through real PG18 independent roles and the signed repository writer.

**No change in production readiness:** the storage/archive receipt
and retention check remain in-memory test substitutes, NOT a live
independently controlled R2/S3 WORM service. Primary+witness
physical PostgreSQL PITR/WAL barriers, archive high-water rollback
detection, owner-authenticated post-enrollment OAuth grant/revoke,
and real hosted WebID/Solid SAI, signed ATProto/PDS and remote
ActivityPub positive acceptance remain P0. No new cloud credentials,
privileged runtime role or production signer were activated.
Federation source SHA, all image digests and `release=CLOSED` remain
unchanged. Federation issue #186 must remain OPEN.

### Independent WORM epoch-receipt readback proof (#273)

ActivityPods **#273**, merged as
`0ca8dad559a3e3ad9cc4269e2cff57522ae79647`, includes
the existing **NONACTIVATED** witness v4 commit-only authorization
boundary from #272 and adds an explicitly disposable WORM epoch
receipt **attestor protocol**. The isolated attestor reads an exact
unsealed witness digest, uses deterministic privacy-pseudonymous
bounded receipt bytes, checks independent storage retention, makes
a create-only conditional write (`If-None-Match: *`), independently
reads back and verifies exact bytes, rechecks retention and only then
calls the restricted witness `seal` function. Lost write
acknowledgment, corrupted readback, lock-policy removal and
unavailable storage cannot optimistically seal authority.

The test uses an **in-memory storage/lock-policy substitute**, not
a live Cloudflare R2 or S3 Object Lock archive. Both physical
PostgreSQL18 witness clusters and Redis 8.2 remain disposable;
all new code is test-gated and no provider production runtime
or privileged cloud credential was activated. After reconciling the
concurrently merged #272 changes, exact PR #273 head
`3c88d78486c28c925bd9743a30b8d21fcc1326fc`
passed **all 4/4 relevant workflows**: independent witness
**44973545069**, PG18/Redis restore **44973545059**, backend
**44973545063**, dependency/lint **44973545079**.

**Still P0 before release:** independently administered, actual
immutable receipt storage with enforceable retained lock and
restricted credentials; signed-write pending/resolved intent
receipts and cross-object high-water chain replay; *physical*
primary and witness PostgreSQL PITR/WAL recovery barrier;
genuine post-enrollment owner OAuth grant/revoke; hosted real
WebID/Solid SAI, signed PDS/XRPC and remote ActivityPub
positive acceptance; independent human security review.
Automated Codex review was unavailable due to exhausted credits.
No change to locked federation source, OCI images, or
`release=CLOSED`. Issue #186 remains OPEN.

### P0 runtime abort-authority separation (#272)

ActivityPods **#272** merged at
`46aa7f7ca5e8db49d8e830caefec879f8699934b`, adding a
**NONACTIVATED witness PG18 v4** security migration. It **revokes**
the runtime positive-commit reconciler role's EXECUTE permission
on the generic `resolve_signed_write` function, which could falsely
mark an unresolved signed PDS transaction `aborted` and permit a
witness revocation ACK before that transaction commits. The runtime
reconciler now receives only narrow `settle_verified_committed`
permission, with v3's immutable operation UUID and exact proposed-CID
checks. The privileged generic abort path is **not** exposed to
ordinary provider, JWT issuer, writer, revoker or positive-commit
reconciler; it is exercised only by a supervised disposable
migration-owner recovery fixture after a simulated proven rollback.

Four exact-head #272 workflows passed: two independent PG18 witness
clusters+Redis8.2 **44973043218**, PG/Redis restore **44973043251**,
backend **44973043192**, dependency/lint **44973043263**.
No automatic abort is possible until an independent physical
PostgreSQL WAL/PITR recovery barrier, historically verified signature
and WORM witness intent receipts are deployed and independently
audited. No runtime SQL migrations/LOGIN roles were activated.
This source-only staging pin keeps the federation baseline and all
Docker image digests unchanged and **`release=CLOSED`**. The
genuine post-enrollment browser owner OAuth approval/revocation and
hosted real Solid, ATProto PDS and ActivityPub acceptance remain P0.

### Independently witnessed historical signed commit recovery (#270/#271)

**No activation, no production signer and no positive signup.** The
immutable ActivityPods pin now includes two further merged **NONACTIVATED**
security candidates:

- **#270** (ActivityPods merge
  `c03bf50e65812be4949d97538cc22f943138e7d8`): independent
  witness v3 seals the exact **previous** and **proposed**
  CIDv1 DAG-CBOR signed repository heads into every new operation.
  The old six-argument unbound reservation API was removed.
  Commit settlement rejects a different CID, even if it looks valid;
  an unresolved old-intent migration fails closed instead of guessing.
  Exact-head 4/4 workflows passed: witness **44971196172**,
  PG18/Redis restore **44971196187**, backend **44971196282**,
  lint **44971196167**.
- **#271** (ActivityPods merge
  `8bf51871fb10bc01de690b22ebb85431308195e5`): a
  separately credentialed **read-only primary PostgreSQL 18**
  positive-commit reconciler verifies witness UUID, WebID,
  expected/proposed signed commit CIDs, historical before-and-after
  reference MST records, authentic **both** parent and proposed
  secp256k1 signatures with independently resolved historical
  DID signing keys, and durable native event outbox, before a
  distinct independent-witness role can mark the commit `committed`.
  Rejects wrong signing key, superuser primary reader, missing
  rolled-back evidence, no-op update, replay and foreign signed CID.
  A missing row is **never** proof that a commit was `aborted`.
  All **8/8** exact-head workflows passed: recovery **44972090541**,
  coordinator **44972090693**, PLC **44972090561**, witness
  **44972090609**, signed repository **44972090576**, backend
  **44972090598**, protected Jena **44972090587**, and dependency/lint
  **44972090600**. Auto-review approval is unavailable because
  Codex review credits were exhausted; human production security
  review is still mandatory.

**P0 still blocks `release=OPEN`:** a genuinely independently
administered immutable WORM/Object Lock receipt and readback attestor
for every witness transition and pending/settled writer intent;
physical primary **and witness** PG PITR with non-rewindable restore
and verified WAL abort barrier; an actual restricted owner-authenticated
long-lived post-enrollment OAuth approval/revocation; authenticated
historical DID PLC key custody/resolution and hosted real browser,
Solid/SAI, PDS XRPC, ActivityPub remote-post acceptance. All changes
here are source-pin and README only; every image digest, federation
source SHA and `release=CLOSED` remain unchanged.

### Incremental P0 external witness/signed-PDS commit ordering (#268/#269)

**Production signup still CLOSED. No credentials or migrations for this
candidate are activated in the staging provider.**

- ActivityPods **#268**, merged at
  `e037f040a31d764d01c007d47301c87f12827bf4`, added independently
  credentialed PostgreSQL18 witness writer/reconciler roles and permanent,
  operation-UUID keyed pending signed-write intents. The witness revoker
  cannot acknowledge an OAuth epoch transition while any signed write
  has an unresolved COMMIT outcome. Separate role and PG18/Redis8.2
  proof, plus existing PG/Redis, backend, lint checks, all green:
  witness **44964981989**, recovery **44964981805**, backend
  **44964981782**, lint **44964981991**.
- ActivityPods **#269**, merged at
  `7af36f912452dfd106b98f09a436f8b408f9f425`, connected the
  witnessed operation to the actual upstream Bluesky
  `@atproto/repo@0.11.0` signed reference-MST transaction. A random
  intent UUID is reserved in the independent PG18 witness before the
  canonical signed commit transaction; the signed mutation audit records
  the same immutable UUID atomically with the signed head, native
  event outbox and projection intent. Canonical PG native SAI and
  OAuth generation share-lock the actual signed-head transaction.
  A forced rollback after staging signed blocks leaves no primary PG
  commit but leaves the witness pending until a separately reconciled
  abort. An actually committed signed post prevents witness
  revocation ACK until verified signed-head settlement. All **8/8**
  exact-head workflows passed: witness **44965733638**, PG rollback
  **44965733667**, signed repository **44965733855**, protected Jena
  **44965733737**, PLC **44965733647**, coordinator **44965734054**,
  backend **44965733621**, lint **44965733756**.

These integration paths are **test-only NONACTIVATED candidates**, not a
runtime PDS or a production distributed transaction. The independent
reconciler is not deployed, its abort/commit evidence is not yet backed
by a physical PITR/WAL recovery barrier, and no independently immutable
WORM Object Lock receipts protect the witness high-water or pending
write intents. General owner-authenticated post-enrollment OAuth
approval/revoke and actual positive HTTPS/browser Solid/SAI/PDS/remote
ActivityPub acceptance still remain required; Codex independent review
is unavailable because credits were exhausted. Do not enable unified
signup, deploy a signer, change `release=CLOSED`, or close
federation issue #186 based on these fixture proofs.

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


## Primary-only independent OAuth witness — exact source pin, NONACTIVATED

The staging lock now pins merged ActivityPods [#277](https://github.com/outlaw-dame/activity-pods/pull/277)
at `7823b9f2e29ceacc45764771aba904ddac6be585`, following merged
[#281](https://github.com/outlaw-dame/activity-pods/pull/281). Four
ActivityPods #277 exact-head workflows passed, including separate PG18
witness and Redis8.2 recovery simulations, backend checks and lint.
The restricted witness reader refuses `pg_is_in_recovery()` standby
connections on every admission check; a coherent but lagging witness replica
cannot admit an old grant. The latest archive verifier also composes
S3 ListObjectVersions and immutable receipt checks into real PostgreSQL
witness code-path tests, using a **test-only fake S3 transport**.

**Release remains CLOSED.** No production locked S3 archive, independent
custody, externally trusted complete high-water, WAL-based failover barrier,
post-enrollment owner-consent flow, or positive multi-protocol signup is
certified by these checks. Keep all image digests and federation source pins
unchanged. Negative-release staging must continue denying both signup paths.

## OAuth owner tombstone admission pin — November 22, 2026

The verified merged ActivityPods [PR #282](https://github.com/outlaw-dame/activity-pods/pull/282)
at `449c003d48c3a6097eed8e8c898c768087e83df1` closes an
OAuth owner *liveness* gap in the real provider endpoints. A valid
HMAC browser cookie or provider-verified RS256 bearer no longer proves a
deleted account may approve fresh authorization. Both routes call the
account authority on each approval and fail closed for deleted, absent,
mismatched, malformed or unavailable owner records. Login consumes
the verified record directly, including valid email aliases; it does
not perform a second unscoped username lookup.

The exact PR head `dc38c956b1851f93fa9c40060fc15284e7c814f0`
passed all three workflows: Redis8.2 OAuth consent / owner-signature
regressions **45052820852**, backend **45052820843**, and dependency/lint
**45052820842**. The initial test harness improperly called
`schema.actions.loginSession.handler` for an actual Moleculer function
and failed; the committed correction calls
`schema.actions.loginSession` directly. Do not confuse that test
harness fix with a weakened production authorization check.

This was **negative-release** evidence at the PR #282 baseline. At that
point logout cleared only the browser cookie and did not invalidate
copied signed browser sessions server-side; password-reset session invalidation and
durable owner disabled/consent race fencing remain unproven.
The independent witness/S3 receipt path is still a *nonactivated test
candidate* without independently administered immutable storage,
complete retention/WAL failover proof, hosted post-enrollment OAuth,
or full positive signed PDS, Solid/SAI and ActivityPub signup.
Independent human security review also remains outstanding.
`release=CLOSED` is mandatory. Both native and unified signup must
continue to return 503 until all production release criteria are met.

## Cross-replica OAuth browser-session revocation pin — November 22, 2026

The staging lock now pins merged ActivityPods [PR #283](https://github.com/outlaw-dame/activity-pods/pull/283)
at `d28a30bb8baa6ace0859bf06076678ecbc26245b`.
That merge introduces the actual provider's live Redis-backed
owner-bound browser sessions. An HMAC cookie alone no longer authorizes
OAuth consent. Login registers a random session id before issuing a
cookie, a copy of the cookie is denied after cross-replica logout, and
missing Redis admission refuses authorization. Invalid legacy stateless
cookies are rejected by design. The browser consent-upsert Lua policy
atomically checks the matching active session key in the SAME Redis
operation that writes the new grant, preventing consent creation after
a competing logout has won.

The exact ActivityPods #283 PR head
`3d3f830c008f8183b1878a4ed40496f5b0a084d3` passed
Redis8.2 real two-replica OAuth proofs **45058653871**, backend
**45058654374**, and dependency/lint **45058653920**. Each was
`success` before the squash merge. The prior lint failure consisted
of two empty catch blocks in disposable test cleanup, fixed and
verified at the final exact head.

**This is not a production restore/release approval.** A Redis
backup restore can resurrect an older browser-session id, grant, or
token family until every admission is bound to independently attested
non-rewindable generation state. Password changes still lack full
owner-wide session revocation. Owner deletion/disable and Jena/PG
consent do not share an atomic authority transaction with the Redis
browser grant. Independent immutable WORM/WAL recovery, hosted
post-enrollment consent and signed Solid/SAI/PDS/ActivityPub positive
signup, and independent integrated security review remain P0.
Staging must verify *negative* real-provider signup again and keep
`release=CLOSED`.

## Password-credential browser session admission pin — November 22, 2026

Pinned merged ActivityPods [PR #284](https://github.com/outlaw-dame/activity-pods/pull/284)
at `9d9257fb79fc21200dc9937eb0599f1600d6e2d6`, following
merged #283. The provider's browser login HMAC-binds its session
cookie to a domain-separated digest of the exact authenticated WebID
and stored password verifier. Browser OAuth POST approval checks a
fresh authoritative account record and constant-time matches that
digest before allowing the live Redis session to approve a grant.
GET authorize no longer displays a stale changed-password cookie as
active. All old cookies lacking this proof fail closed; raw password
verifiers are never copied into cookies.

Upstream SemApps exposes `setPassword`, `setNewPassword`, and
`updateAccountSettings` mutation routes; each changes the password
verifier. This check denies cookies issued before any of those
mutations without relying on a callback from one endpoint.
Exact ActivityPods PR-head `9b238d7a38a67816c75f2d54ac24206e23b0da02`
passed Redis8.2 real-session/consent proofs **45059177547**, backend
**45059177454**, and dependency/lint **45059177538**.

**Security and release boundaries:** this check fences browser
session admission while the account source remains current. Earlier
SemApps provider-signed RS256 bearer credentials are not
password-verifier-bound and still honor their separate maximum
one-hour issue-age window. Redis+account/PG/Jena restore can revive
older state absent independently immutable WORM high-water; owner
post-enrollment consent and account/SAI revocation lack a single
cross-store transaction, as does the signed PDS witness. Hosted
positive browser/Solid/SAI/PDS/ActivityPub signup, external DID
verification, and independent integrated security review remain P0.
All other image/source digests are unchanged, and `release=CLOSED`
is required; this staging gate is negative-release only.

## Owner post-enrollment OAuth grant revoke — November 22, 2026

ActivityPods merged [PR #285](https://github.com/outlaw-dame/activity-pods/pull/285)
at `c2f33d30492606346f17d9ddb30bad14d40349fc`.
Real Redis 8.2 two-provider OAuth tests **45062027655**, backend
**45062027585**, and dependency/lint **45062027652** passed at exact
PR head `ac5fbc7b4d6a1aee5d1e564a2860e20d59be390e`.

The provider now offers a **browser-owner-only** per-client consent
read/revoke API under `/oauth/owner/grant`. The owner session must be
Redis-live, HMAC-signed, bound to the current password verifier, and
verified against a live non-tombstoned account. POST revocation requires
same-origin HTTPS JSON, a Redis one-use challenge, CSRF/fingerprint,
and an exact consent generation; a stale challenge cannot revoke a
later reapproval because one Redis Lua CAS binds owner, active session,
and grantId at the same linearization point.

This staging version also checks **real HTTPS negative admission** for
the new GET/POST routes without an authenticated session and with a
malicious Origin, in addition to pre-existing blocked signup, protected
Jena storage, JWKS restart and PostgreSQL TLS tests. It cannot test
the positive owner route without a real preregistered owner account;
the separate Redis proof covers that behavior with actual Redis and
two provider contexts, not a hosted user.

**Remaining P0 before release:** Redis-only owner revoke is not a
durable cross-database PG/Jena/SAI/PDS revocation. An older restored
Redis and Jena state can revive grants/password verifiers absent an
independently administered Object Lock COMPLIANCE high-water.
The connected Cloudflare account currently does not furnish a
separate admin-controlled WORM failure domain, and R2 bucket locks
can be removed by their controller; no production receipt/retention
certificate exists. The signed PDS primary+witness transaction,
physical PITR recovery, RS256 owner bearer credential epochs,
positive hosted new-account browser/Solid/ActivityPub/ATProto/PDS/XRPC
acceptance, and independent human security review are still missing.
Keep all other image/source pins unchanged and `release=CLOSED`.

## Browser-only public OAuth consent gate — November 22, 2026

Pinned merged ActivityPods [PR #286](https://github.com/outlaw-dame/activity-pods/pull/286)
at `89cab0f0f00022ad863058a23ec07f6539e186ca`, following
#285 owner post-enrollment revocation. Exact PR source
`a7e3874c38cd9f9e02e60bfee875e8d2530a0aa2`
passed Redis8.2 OAuth **45063555387**, backend **45063555410**,
and repository lint **45063555407**, all three successful.

The public Authorization Interface's POST approval now requires the
current password-verifier-bound **browser owner session** and refuses
every `Authorization` header even when an older signed SemApps
RS256 bearer token and a valid browser cookie are both supplied.
Previously, signed tokens from upstream SemApps have an `iat` but
lack a canonical account/password credential epoch and could
authorize new owner consent within their one-hour age window after
a password change. The browser session (HMAC + Redis + live
account/password verifier) and atomic same-Redis consent CAS remain
required. The user-facing authorization interface is consistent
with https://atproto.com/specs/oauth . The internal authorization
fallback stays production-disabled.

**Exact scope:** The test suite proves negative valid-RS256 bearer
consent and positive live browser approval under the real Redis
OAuth workflow. Staging still tests the actual HTTPS provider,
closed signup and post-enrollment owner endpoint denial, protected
Jena data and OIDC key restart, and PG18 TLS; these are negative
release tests and do not establish hosted positive signup.
Other SemApps bearer endpoints still lack a durable credential
revocation epoch. The real independent S3 Object Lock COMPLIANCE
witness, WAL/PITR restore, signed PDS/SAI cross-store authority,
positive hosted new-account approval and independent human security
review remain P0. Keep all other source/image digests and
`release=CLOSED`.

## Browser login and consent same-origin CSRF gate — November 22, 2026

Staging source now pins merged ActivityPods
[PR #287](https://github.com/outlaw-dame/activity-pods/pull/287)
at `3c3bf8c0ed17521dcbb055150790c5fadeca0bc8`, following
#286 browser-only consent. Exact PR head
`d933bfe0d3662565a0cddc6d33b12d243b557c6e`
passed Redis8.2 real browser OAuth **45064274228**, backend
**45064274263**, and dependency/lint **45064274269**.

All browser-sensitive provider OAuth POST routes now require the
exact issuer HTTPS `Origin`: `/oauth/session/login`,
`/oauth/session/logout`, `/oauth/authorize`, and
`/oauth/owner/grant/revoke`. Missing, mismatched, conflicting
and cross-site Fetch Metadata are denied **before passwords or
Redis session/grant mutations**. Provider-hosted HTML forms remain
urlencoded compatible, JSON API owner calls remain supported,
owner grant revocation stays JSON-only, and bodyless same-origin
logout does not require a Content-Type. The normal React
frontend `/auth/login` flow and token/PAR protocol endpoints are
not changed. The issuer must remain HTTPS.

This staging gate extends real production-mode HTTPS checks beyond
the two signup fuses and existing owner grant paths. It now checks
cross-origin/missing-Origin/form-content login denial without
any signed session cookie, successful passage of a *valid same-origin
form with intentionally invalid credentials* to its 401 account
check, malicious Origin/logout denial, empty-body same-origin
logout 200 with cookie clearing, and cross-origin OAuth consent 403
without PAR/access mutation. All requests are disposable and use
synthetic nonexistent usernames. No account is provisioned.

**This remains a negative-release security test**, not acceptance
for real post-enrollment Solid/SAI, signed PDS, or ActivityPub
enrollment. Separate immutable admin-controlled Object Lock
COMPLIANCE receipt storage, physical recovery across trusted
failure domains, canonical signed JWT/owner epoch and WORM/PDS
commit barrier, hosted positive cross-protocol signup, and
independent integrated human security review remain P0. The
staging lock must preserve `release=CLOSED` and all other
pinned digest/source values.
