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
change followed by a new acceptance run. The authoritative current pin is
always the `activitypods` SHA in `lock.json`; historical milestone paragraphs
below document earlier revisions and are superseded by the latest dated
checkpoint. An earlier ActivityPods pin was **merged PR #288** at
`6a7893f7f867bc04293afa3451e5741e5e732ecb`, building on the
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

## Independent external AWS custody and two-PG18 physical PITR gate — November 22, 2026

Staging source is pinned to **merged ActivityPods
[PR #288](https://github.com/outlaw-dame/activity-pods/pull/288)**
at `6a7893f7f867bc04293afa3451e5741e5e732ecb`. Its exact
PR head `4b5d6c0e4660922eaf897c666e6566ef35c24b1d`
passed **six out of six** workflows:

- S3 COMPLIANCE/STS official AWS SDK contract `45067953225`
- Primary PostgreSQL18 + Redis8.2 restore fence `45067953175`
- Independent PostgreSQL18 witness and signed repository test `45067953150`
- **Real two-cluster PostgreSQL18 physical base backup and archived WAL/PITR**
  named-before/after-revocation `45067953212`
- Backend suite `45067953238`
- Dependency, lint and auth regression `45067953147`

No external AWS resource, receipt, account or key was created.
Every S3 receipt transport command now requires a validated
`ExpectedBucketOwner` AWS account ID. The separate read-only
operator probe checks real AWS STS role ownership in **different**
provider and archive accounts, COMPLIANCE default retention,
versioning, bucket public access blocks and (when independently
supplied) a pre-existing exact immutable receipt version and hash.
It forces official regional AWS TLS endpoints, refuses custom
endpoints/CA substitutions, uses privately installed exact-pinned
SDKs and cannot issue S3 writes or change policy. Its result
always includes `releaseAccepted:false`. Operator runbook:
`pod-provider/backend/docs` is **not** the document location;
see `docs/paper-independent-worm-custody-acceptance.md` in the
pinned ActivityPods source.

The physical PITR test now waits for actual final PostgreSQL
TCP readiness and successful SQL against the intended database;
a previous `pg_isready` test raced the official image's temporary
initializer before the named database existed. Both real cluster
backups, WAL and named restores passed after the fix.

**Boundary:** These are disposable operator-readiness and recovery
rehearsals, not a deployed independently administered WORM service,
nor proof that a restored PG/Redis/Jena/PDS cannot roll back an
actual live owner grant. P0 still requires a separately operated
S3 Object Lock COMPLIANCE archive with independent reader/writer
IAM roles and latest high-water witness receipt; live PG18 WAL/PITR,
Redis/Jena, signer/PDS failover against those receipts; complete
canonical owner credentials/SAI/Solid grant and signed-PDS
transaction integration; positive hosted new-account
Solid/ActivityPub/ATProto/XRPC acceptance and external peer
readback; and independent human integrated security review.

This staging PR advances **only** the ActivityPods source pin and
this checkpoint. All images and other source hashes remain locked,
both signup paths continue returning 503, and the release remains
`CLOSED`.

## Provider-neutral R2 disposable witness transport gate — November 22, 2026

Staging pins merged ActivityPods
[PR #289](https://github.com/outlaw-dame/activity-pods/pull/289)
at `72d131dca15efa33a73c55acac1287b61b82942d`.
Its exact PR head `bc7e997f2b8072ecf3563736f139b2a03db3020d`
passed all five GitHub Actions workflows:

- R2/S3 canonical receipts, lock-policy and rollback-denial contract
  `45083753865`
- Two-cluster PG18 physical WAL/PITR `45083753802`
- Independent PG18 witness restore `45083753999`
- Backend suite `45083753847`
- Dependency, lint and authorization regressions `45083753857`

**Storage interface correction:** The architecture requires independently
trusted latest authorization high-water, **not AWS ownership or AWS
storage as such**. Cloudflare R2 is an S3-compatible transport option,
but its account-controlled bucket-lock rules are not S3 Object Lock
COMPLIANCE and can be removed by a privileged Cloudflare operator.
The existing AWS-only verifier retains its strict bucket-owner,
versioning and Object Lock checks. New nonactivated R2 receipt transport
shares canonical receipt validation; create-only PUT, independent
readback, lock checks and separately supplied latest checkpoint protect
against ordinary conflict and missing epochs in disposable tests.
The checkpoint itself must still be independently authenticated and
durable in a separate failure/privilege domain.

**Verified live account-scoped R2 smoke test:** isolated bucket
`paper-witness-disposable-tests` (not Atlas backups), Standard class,
enabled 30-day lock scoped to `paper/oauth-witness/`. A 51-byte
disposable fixture was PUT and GET with exact bytes; attempted
overwrite returned HTTP 409; reread stayed intact. This used the
Cloudflare management API, **not S3 HMAC conditional PUT**. No
production receipt, S3 access credentials or cross-store live
revocation recovery was established. Operator details:
`docs/paper-r2-disposable-witness-contract.md` in the ActivityPods
source.

No producer, owner grant, SAI or signed PDS paths use this candidate.
All image digests and the federation source hash remain unchanged,
staging signup remains 503, and `release=CLOSED`.

## Signed external R2 latest-head fast path — November 22, 2026

Merged ActivityPods
[PR #290](https://github.com/outlaw-dame/activity-pods/pull/290)
at `28ab8c6807deb0b5136f9128f90195d0e7da5241`. Exact tested head
`2b28d3cbac6578343221f23548bda8a20b574082` passed all five:

- R2 signed Ed25519 and S3 receipt contract `45086641408`
- Dual real PG18 physical WAL/PITR `45086641520`
- Independent PG18 witness `45086641407`
- Backend checks `45086641441`
- Dependency/lint/auth regression `45086641457`

The new NONACTIVATED, pinned-public-key verifier authenticates
canonical domain-separated signed `paper.witness.latest-checkpoint.v1`
heads fetched from an independently configured checkpoint authority.
The R2 exact-key fast path requires a branded verified authority,
verifies SHA-256 receipt readback, checks R2 policy on both sides,
then re-reads the signed checkpoint to detect concurrently advanced
revocations. The O(history) fixture scan is not used in this path.
Tests cover stale DB/R2 snapshots, missing/forged/rotated signer,
cross-owner reuse, caller-supplied fake authority and concurrent change.

**Not completed:** independently deployed nonrewindable latest-head
authority and external key custody, live signed R2 S3 client readback,
production cross-store recovery, SemApps bearer/SAI/PDS revocation,
hosted positive full signup and independent security acceptance.
A valid signature can still be replayed by a dishonest or restored
head authority: operator-independent high-water freshness is required.
This PR updates *only* the source pin and checkpoint text. Staging
release and all other digests remain `CLOSED`/unchanged respectively.

## Canonical SemApps credential revocation candidate — November 22, 2026

Staging pins merged ActivityPods
[PR #291](https://github.com/outlaw-dame/activity-pods/pull/291)
at `3c5c623ad940c8af10f5fcba1b432235a1aa2e63`.
Its exact tested PR head `7385e631dee0c525b9169b55c06482d1f38447e9`
passed **Backend checks** `45089191987` and **Dependency and lint
consistency** `45089191980`, including the new standalone RS256
credential epoch proof.

Security audit: upstream SemApps `auth.jwt` signs and verifies RS256
JWTs without a mandatory expiry or canonical password-change epoch.
Paper's existing enrollment middleware validates a matching account
but does not invalidate old signed tokens after password rotation.
The merged NONACTIVATED `middlewares/credential-epoch.js` verifies
independent owner classification before enforcing 15-minute JWT
expirations and per-owner epoch on new unified accounts. The
test-only mutation proof requires `pending` authorization state
before downstream password writes, rejects old tokens while the
credential mutation remains uncertain, and never retries after an
ambiguous credential write. Two authority reads around issuance
detect concurrent rotation. Restoration-induced owner/legacy
classification downgrade is denied rather than silently bypassed.
Older pre-unification accounts are not implicitly migrated.

**Not production accepted:** No canonical independent credential
authority or password-reset/administrative mutation service has
been deployed; no real end-to-end SemApps JWT, Solid/SAI, signed PDS
and cross-replica revocation acceptance has been performed.
The file is fixture-only and NOT imported by production middleware
configuration. Detailed handoff:
`docs/paper-canonical-credential-revocation-gate.md` in ActivityPods.

This PR advances only the exact merged ActivityPods pin and this
checkpoint. Other image/source digests remain locked, and
`release=CLOSED` remains mandatory.

## Restricted PostgreSQL credential authority checkpoint — November 22, 2026

Advance the frozen ActivityPods source to merged
[PR #293](https://github.com/outlaw-dame/activity-pods/pull/293),
commit `ae7ad7383abeb45ec4f54db311758a95d4373058`, including
the acknowledged-mutation denial merged in [#292](https://github.com/outlaw-dame/activity-pods/pull/292).

PR #293 exact head `91f5218bebbc773ad5aac8f65cd012545066671b`
passed **three** workflows: real PostgreSQL18 restricted-credential
authority `45090947470` (reader/enroller/coordinator functions,
pending fences, epoch CAS and terminal disable), backend
`45090947410`, and dependency/lint `45090947848`.
PR #292 passed exact-head backend `45089773853` and lint
`45089773840`.

The restricted SQL credential authority is **NONACTIVATED**. No
production password-change path, SemApps JWT/SAI/PDS token check,
independent nonrewindable high-water, hosted positive signup or physical
cross-store restore has been certified. It must not be auto-migrated,
treated as a signoff, or enabled by removing a fixture guard.

This PR changes only the ActivityPods source commit and this textual
checkpoint. Every frozen OCI image digest, federation source SHA and
`release=CLOSED` remain unchanged. Exact-head staging `tls-runtime`
and `local-provider` jobs remain mandatory before this pin merges.

## Fresh independent credential-head candidate — November 22, 2026

Frozen ActivityPods source updated to merged
[PR #294](https://github.com/outlaw-dame/activity-pods/pull/294),
SHA `39ba2f32d73c980cbedf473e4ee0bc6fe33cbaad`.
The exact tested head `a6900f1d47ec1c4a1eb5924ab035bfdb809d176f`
passed **four** workflows: real restricted PostgreSQL18 signed
challenge head `45094391647`, PG18 authority `45094391639`,
backend `45094391594` and dependency/lint `45094391560`.

The nonactivated candidate verifies independently challenged Ed25519
latest-head signatures against a restricted PostgreSQL18 LOGIN and
the existing RS256 new-unified-account guard. It denies historical
response replay, concurrent advancement, lost head, altered signer,
wrong owner, stale SQL state and restored previous credential epoch.
The real PG test also verifies old bearer denial after password epoch
advance, database row rewind and owner disable. It **does not prove**
the independent latest signer's own state is nonrewindable.

An external human-operated signer and immutable audit trail, actual
production credential mutation/SAI/PDS integration, physical PG/Jena/
Redis/PDS restore, positive hosted complete signup and independent
human security review are still open production P0s. Neither the
restricted reader nor the signer is activated in production. No
OCI image digest or federation source SHA changes. `release=CLOSED`.

## Final candidate hardening — November 22, 2026

Frozen source now includes two subsequent merged ActivityPods gates:
- [#295](https://github.com/outlaw-dame/activity-pods/pull/295),
  merge `19c04cd77de6082d228f7877c3f550814e8b3dcf`:
  public-only Ed25519 SPKI/key-object admission, explicit denial if a
  private PEM is accidentally supplied to the verifier. Exact-head
  signed-head/PG18 `45094805596`, backend `45094805593`, lint
  `45094805575` all passed.
- [#296](https://github.com/outlaw-dame/activity-pods/pull/296),
  merge `6dd0795f63ab05d14f5aabbf5f3404acd31383d2`:
  both independently backed-up PostgreSQL18 clusters now physically
  restore the **actual** credential epoch v1/v2 tables from named WAL
  points before and after a terminal disable. The older snapshot is
  active epoch 1; the later is disabled epoch 2. Five exact-head jobs
  passed: real physical PITR `45094981291`, PG18 authority
  `45094981426`, signed-head regression `45094981293`, backend
  `45094981308`, and lint `45094981278`.

These are **NONACTIVATED** security/proof implementations. There is no
new independent human-operated latest-head signer, no live external
WORM authority, no production SemApps/SAI/PDS password/consent
mutation integration, no Jena/Redis/PDS full physical recovery, no
hosted positive new-account signup, and no independent human approval.
Staging MUST prove exact final source on both HTTPS jobs. All pinned
OCI/federation digests remain unchanged, and `release=CLOSED`.

## Restricted native SemApps bcrypt-write boundary — November 22, 2026

ActivityPods [PR #297](https://github.com/outlaw-dame/activity-pods/pull/297)
merged at `d6b651ff0fd87348347c665ca6bf8f171a9dbac7`
from exact-tested head `edb8b4951dd4d641248123552ada413e501ac600`.
All five GitHub workflows completed successfully: native PG18
`45097341677`, signed head `45097341661`, PG18 epoch
`45097341575`, backend `45097341616`, and dependency/lint
`45097341603`.

The restricted nonactivated v3 SQL closes generic native-account
`UPDATE(data)` and `DELETE` credential bypasses through a protected
PostgreSQL18 trigger. A separate operation-bound bcrypt writer,
read-only native receipt attestor and restricted sealer require an
exact pending UUID/epoch; the old digest-only generic coordinator
seal is no longer executable by its role. The proof tests real
distinct SQL LOGINs, rollback, unexpected ACK, wrong account/operation,
replay, and terminal disabled owner. Bcrypt work factor is bounded
to 10–14, matching pinned SemApps hash cost 10.

**This remains NONACTIVATED**. Existing SemApps password-reset/change
routes are not yet owner-authenticated and wired into the new PG role
protocol. No live independent nonrewindable signer or WORM custodian
is available, so the protocol must not be activated by an env flag
or production migration. Full PG/Redis/Jena/PDS hosted recovery,
positive owner signup, and independent human security acceptance
are outstanding. This PR changes only the ActivityPods source SHA
and checkpoint prose: pinned images/federation digests and
`release=CLOSED` are unchanged.

## Independent head transport + actual credential restore source — November 23, 2026

The frozen source now includes two recently verified ActivityPods merges:

- [#298](https://github.com/outlaw-dame/activity-pods/pull/298), merge
  `ac17dd1e1c9ac4364bec212687b3ac1b1e00ee86`: exact-head
  `3221ee133bed4fe439994a33324397ccea4ba419`, **six passing CI
  workflows**, including real two-cluster PG18 `pg_basebackup`,
  archived-WAL named-point recovery of the actual SemApps native account
  password, append-only operation receipts, and protected credential
  epochs on either side of disablement.
- [#299](https://github.com/outlaw-dame/activity-pods/pull/299), merge
  `a8ff987f585fd797e773296e39946abcb0a86594`: exact-head
  `f64af7eb81922ec94b91bb87db7cbaac206ebb39`,
  **three passing workflows**: real HTTPS/TLS nonce-challenged
  Ed25519 independent-head transport `45098789762`, backend
  `45098789833`, lint `45098789873`. HTTPS transport has strict
  TLS, absolute deadline and refused redirects, responses, stale signed
  nonce replays and globally disabled verification. No production
  verifier service is wired to it.

No upstream federation source or pinned image changed. This staging pin
must pass the exact tested TLS/runtime and actual local provider jobs.
This work is **NONACTIVATED**. The independently administered signer
with genuinely nonrewindable head, owner-authenticated native password
change/reset, Solid/SAI/OAuth/PDS integrated state, full
Redis/Jena/PDS restore, positive hosted signup, and independent
security review remain outstanding. `release=CLOSED`.

## Enrolled-account upstream credential-mutation holding fence — November 23, 2026

Frozen source includes merged ActivityPods
[#300](https://github.com/outlaw-dame/activity-pods/pull/300),
`a93bbf9f01f3330a4b2650e0df470b3c9bf1d447`.
Exact tested head `b62b1989834cb7bade1ed10c4a1767ea15af5b33`
passed backend `45180282508` and dependency/lint `45180282510`.

On every broker that hosts SemApps authentication, the always-registered
`AccountEnrollmentMiddleware` now stops six upstream credential
mutation actions for incompletely enrolled accounts *before* any
password/hash/reset/delete/tombstone side effect. These actions use a
fresh isolated `findByWebId` lookup with a 3-second deadline and zero
retries; missing, forged or malformed enrollment markers fail closed.
A real Moleculer test covers all six actions and unchanged unmarked
legacy behavior.

This is a **holding denial**. The old SemApps password-reset/change
actions are not replaced with an authenticated PostgreSQL operation
coordinator yet; the native v3 SQL and independently challenged head
remain nonactivated. Positive hosted signup, separately operated
nonrewindable checkpoint/immutable custody, full cross-store
PDS/Jena/Redis disaster recovery, and independent human review are
still required. No image or federation digest changes. `release=CLOSED`.

## Real SemApps mutation integration and recovery-token hardening — November 23, 2026

ActivityPods source now pins merged
[#301](https://github.com/outlaw-dame/activity-pods/pull/301)
(`b995f07359cf51dc41ba4d9cca680f9ec67194e1`,
exact tested head `4ea4d1a354938ff5d8e85f264e3986a25f379d95`):
real pinned `@semapps/auth` 1.1.4 service, restricted PostgreSQL18
account adapter, canonical credential v1/v2/v3 schemas, and disposable
protected-Fuseki workflow. All three exact-head workflows passed:
real SemApps/Fuseki `45181622231`, backend `45181622038`,
dependency/lint `45181622270`. The test attempts six actual
upstream password/reset/settings/delete/tombstone actions and
direct native adapter bcrypt mutation/deletion, verifies no native
write receipt, and checks account persistence.

ActivityPods [#302](https://github.com/outlaw-dame/activity-pods/pull/302)
merged `fd864a25e2491280ca51d914cb980fdf876c99e2`
(exact head `a720019881823d0eb3b1cbd21aab538cea9ccaec`).
Six workflows passed: real native PG18 `45182491606`, physical
dual-cluster PG18 archived-WAL PITR `45182491502`, canonical
credential `45182491660`, challenged signer `45182491703`,
backend `45182491589`, dependency/lint `45182491677`.

This hardening scopes credential/recovery/tombstone SQL trigger
restrictions to unified accounts determined by either immutable
enrollment marker or canonical PostgreSQL owner, retaining legacy
SemApps account password/update behavior. A verified native bcrypt
write now also removes previous reset-token material in the same
operation-bound transaction; receipt attestation requires token
absence. Real two-cluster physical backup/restore proves the old
reset capability present before a rotation, but absent in the
later restored sealed/disabled generation.

The external Ed25519 signer/witness remains a NONACTIVATED
disposable candidate. A separately operated nonrewindable latest
checkpoint and immutable object retention, actual owner-approved
positive SemApps password change/SAI/OAuth/PDS integration,
hosted complete signup, Redis/Jena/PDS cross-store disaster
recovery and independent security acceptance remain P0.

Only ActivityPods source SHA and README change; all federation,
OCI image and service configurations unchanged.
`release=CLOSED`, signup CLOSED.

## Production unscoped identity-write closure — November 23, 2026

Merged ActivityPods [#303](https://github.com/outlaw-dame/activity-pods/pull/303)
`134be7a998d6fc3336b4164e940bc76b0e2cf6bb` fixes five
unscoped database and identity entrypoints: inherited Moleculer
`auth.account.insert/update/remove` and direct
`auth.account.create/attachWebId`, which otherwise bypass the
closed production signup or owner-approved credential coordinator.
The always-registered middleware refuses these before the service
handler. Its production-mode real Moleculer test covers spoofed
privileged metadata, runtime environment tampering, and legacy
approved account action compatibility. Exact-head source
`533eeb2a942afe4f9d4419287c71ff66a894cd03`
passed all three workflows: ATProto protected Fuseki `45184125566`,
dependency/lint `45184125693`, and backend `45184125721`.

This pin changes only the ActivityPods source SHA and checkpoint
documentation; pinned federation, PostgreSQL, Redis, Fuseki and
ingress image digests stay unchanged. `release=CLOSED`.

The independently operated monotonic signer, separately-administered
COMPLIANCE WORM retention, authenticated SemApps/SAI/OAuth/PDS
credential flows, full hosted multi-store recovery and positive
unified signup remain unproved release dependencies.

## Portable immutable S3 archive qualification — November 23, 2026

Merged ActivityPods [#304](https://github.com/outlaw-dame/activity-pods/pull/304),
`3b0e8350b99b74ea0914321f39ced610e1f24f35`,
exact tested head `26440e9979d466a5b4ba6693fedfba6db4021084`.

All four exact-head workflows passed: immutable S3 compliance contract
`45194952371`, independent PG18 restore witness `45194952231`,
backend `45194952348`, dependency/lint `45194952705`.

Adds an operator-only READ-ONLY B2/Storj S3 compatibility qualifier with
strict official HTTPS endpoint allowlist, positive COMPLIANCE lock and
versioning checks, exact retained receipt/version/digest audit,
nonretryable S3 failures and denial of unsafe/raced histories. It
explicitly refuses Filebase as an immutable witness: Filebase does
not expose the required Object Lock/versions APIs. The tool never
outputs production grant and is not registered in any running auth
service. It also documents Backblaze's 2026 Enterprise-only
IAM/STS/GetCallerIdentity and OIDC support separately from normal
B2 application keys, and Storj's access-grant model. B2/Storj
conditional create-only race behavior, independent operators and
nonrewindable live latest signer are still UNVERIFIED.

This staging change ONLY pins ActivityPods source and updates
the README; federation source and OCI digests unchanged,
`release=CLOSED` and signup CLOSED. Neither a B2 nor Storj
account has been connected to production. Multi-store recovery
and positive hosted account signup remain P0.

## Unified-owner restore fence and provider-neutral S3 qualification — November 23, 2026

Frozen ActivityPods source advances to
`fc58582b9ebce2031467ea3dc06b91a51102e76e`
(two completed merges; **no release activation**):

- [ActivityPods #305](https://github.com/outlaw-dame/activity-pods/pull/305)
  merge `b7b9a025f4ee5e3a9150903fda8e253447448688`,
  exact tested head `a758cf642876368e944b47f7b99c1c313b6f4c9b`,
  all SEVEN workflows successful:
  native restricted PG18 `45203091910`,
  real SemApps/ATProto protected Fuseki `45203092082`,
  canonical PG18 epoch `45203092158`,
  signed independent-head/PG18 `45203092555`,
  dual-cluster physical WAL recovery `45203093046`,
  backend `45203091973`, dependency/lint `45203092019`.
  The NONACTIVATED PG18 native credential guard now prevents account
  WebID/username/UUID rebind and any update when the canonical owner
  survives but the SemApps enrollment marker was rewound/lost.
  First reserved WebID attachment before canonical enrollment continues
  to succeed, as proven by the real SemApps integration.

- [ActivityPods #306](https://github.com/outlaw-dame/activity-pods/pull/306)
  merge `fc58582b9ebce2031467ea3dc06b91a51102e76e`,
  exact tested head `a950cc177ad033a0c00b5a51150bbe1ada6d99cd`,
  all FOUR workflows successful:
  provider-neutral S3 compliance contract `45204750905`,
  independent PostgreSQL witness PITR `45204750985`,
  backend `45204750887`,
  dependency/lint `45204750864`.
  Any independently operator-pinned public HTTPS S3-compatible origin
  can now be checked READ-ONLY for retention, versioning and exact
  receipt data. AWS numeric account IDs/STS are not a generic
  requirement; provider-specific identity/custody audit is separate.
  Default result remains `releaseAccepted:false`. It does not
  establish a live writer, independent signer, conditional-PUT safety
  or complete recovery. Paper and Memory are candidate application
  names, not separate identity controllers.

This staging PR changes **only** ActivityPods source pin and operator
README. Federation source, OCI image digests and
`release=CLOSED` remain unchanged. No hosted positive signup,
owner-approved credential change, independent nonrewindable witness
or full Redis/Jena/PDS physical restore has been certified.

## Provider-neutral conditional S3 writes and adversarial retention test — November 23, 2026

The unified ActivityPods account authority and federation sidecar remain
separate from product-brand naming (Paper/Memory). Frozen source now
pins ActivityPods `fa6916e3416d731163ebfea2deee6eb31d60c787`,
including **two nonactivated, provider-neutral S3 custody gates**:

- [ActivityPods #307](https://github.com/outlaw-dame/activity-pods/pull/307),
  merged `1bffe66e7801596216be91c6e8842cdbb270e5ac`,
  exact tested head `b3fad0280ad28e4647cfa54b18cf24db20239bff`;
  FOUR exact-head workflows succeeded: S3 contract `45207548198`,
  independent two-PG18 witness recovery `45207548180`,
  backend `45207548040` and dependency/lint `45207548055`.
  Adds a provider-neutral S3 receipt writer which respects
  `IfNoneMatch: '*'`, reconciles lost ACK without retry, verifies
  exact immutable version/readback and fails closed on missing Object
  Lock COMPLIANCE or versioning. AWS IAM/STS remains only an optional
  *provider-specific* custody audit.

- [ActivityPods #309](https://github.com/outlaw-dame/activity-pods/pull/309),
  merged `fa6916e3416d731163ebfea2deee6eb31d60c787`,
  exact tested head `89f4f3e8bc0f11b7f2a4463e933b82a1b3e25028`;
  FOUR exact-head workflows succeeded: S3 contract `45209169706`,
  independent two-PG18 witness recovery `45209169709`,
  backend `45209169902`, dependency/lint `45209169915`.
  Adds operator-only two-attempt conditional PUT race validation
  with explicit approval for one irreversible test object in
  `paper-worm-disposable-*`, using separate read/write credentials
  and a random synthetic receipt. One ACK + one HTTP 412/409 conflict,
  exact version/bytes, COMPLIANCE retention and absence of delete
  markers are required. Ambiguous ACK never triggers a retry.
  Superseded conflicting [#308](https://github.com/outlaw-dame/activity-pods/pull/308)
  was closed; the portable writer code and coverage were preserved.

This source pin changes only `deploy/paper-staging/lock.json` and this
handoff note. **All federation, PG18, Redis, Jena and OCI digests
remain unchanged; `release=CLOSED`; signup CLOSED.** These are
DISPOSABLE/NONACTIVATED proofs. No live B2/Storj/custom-S3 write
acceptance, separate operator/key control, immutable COMPLIANCE
historical delete/refusal, nonrewindable external signer, full
PG18/Redis/Jena/PDS multi-store recovery, owner-authenticated
credential change or positive hosted unified signup has been
certified by this staging promotion.

## Closed PDS OAuth and runtime-secret clean-up — November 25, 2026

This **source-only**, deliberately CLOSED staging checkpoint pins ActivityPods
merged [#311](https://github.com/outlaw-dame/activity-pods/pull/311)
`919f6f61b96a2a23db87a9481c2e22029eedeff3`, built on merged
[#310](https://github.com/outlaw-dame/activity-pods/pull/310)
`dc955028601e7619559a45b6d286c298a89059c2`.

- #310 removed the formerly tracked backend `.env` and binary Redis `dump.rdb`
  from the **current tree**, added Git/Docker exclusions and an exact-index CI
  guard, supplied a secret-free `.env.example` and documented secret rotation.
  This **does not** purge Git history, revoke deployed sessions, rotate
  historically exposed tokens, or establish whether any credential was active.
  Operator rotation, image audit and restore checks remain mandatory.
  Exact-head backend run `45554096435` and dependency/lint run
  `45554096440` both **passed**.
- #311 closes the previously permissive Redis-only PDS OAuth issuer for every
  **non-test** runtime at source level, regardless of disposable env flags.
  Direct grant approval, consent upsert, token exchange and access-token
  issuance fail before side effects. Existing JWTs plus a restored Redis grant,
  and restored encrypted refresh families, cannot regain PDS authorization
  through the reviewed issuer. Revocation remains possible.
  The exact-head ActivityPods PG18/Redis OAuth recovery, independent two-PG18
  witness, Redis refresh/replay, backend, and dependency/lint workflows
  **passed** before the merge. This does NOT activate the test-only
  PostgreSQL/WORM authority or positive PDS authorization.

This staging PR must run **both** `tls-runtime` and `local-provider` on the
**combined pin**. The provider profile must no longer rely on a committed
runtime `.env`: nonsecret test configuration comes from controlled staging
settings and secrets are generated into private mounts. The HTTPS/OIDC keys
must survive restart and both native signup and PDS OAuth authorization must
remain CLOSED. A 503 refusal is a negative-release test, **not** a positive
owner/SAI/PDS signup proof.

The federation source SHA, image digests and `release=CLOSED` are unchanged.
No independent live COMPLIANCE S3 archive, separately administered signer,
human-approved complete SemApps/SAI/PDS mutation, multi-store
PostgreSQL/Redis/Jena/PDS restore, or hosted positive signup is claimed.
Promoting the protected issuer or changing `release` is forbidden on this PR.

## Final combined credential/OAuth source pin and staging startup regression — November 25, 2026

ActivityPods frozen source now pins merged [#312](https://github.com/outlaw-dame/activity-pods/pull/312)
`fcf034a97bbd1a70aae8cc7c25ac18e115492282`, containing already-merged
security [#310](https://github.com/outlaw-dame/activity-pods/pull/310) and
[#311](https://github.com/outlaw-dame/activity-pods/pull/311).
ActivityPods #312 restored the **nonsecret local example** settings lost
during source-secret cleanup, with distinct local Redis DBs and loopback
configuration regression. Its exact-head backend run `45554761704` and
dependency/lint run `45554761637` passed.

The initial federation staging candidate pinned #311 and its TLS/runtime
job passed, but its `local-provider` job failed during startup
([run 45554942604](https://github.com/outlaw-dame/mastopod-federation-architecture/actions/runs/45554942604)).
The backend log identified a **missing `SEMAPPS_SHAPE_REPOSITORY_URL`** in
`services/files.js`: that service constructs a shape-tree URL at import,
and previously inherited the setting from the tracked backend `.env`.
Removing the tracked file exposed this implicit dependency. This is a real
integration failure and must not be recorded as passing HTTPS/fuse checks.

Staging now explicitly supplies the public shape-repository URL in its
generated provider Compose environment and checks that value plus
`NODE_ENV=production` **before** any expensive image build. No historical
credential or implicit local `.env` is restored. A fresh final-head
`tls-runtime` **and** `local-provider` run must pass with actual HTTPS
negative PDS authorization-code/refresh exchange denials, protected Jena
role isolation, stable JWKS through restart and both signup 503 denials.

This staged source-only update preserves the existing federation SHA,
all OCI image digests and `release=CLOSED`. **It does not assert**
independent WORM provider credentials/COMPLIANCE retention or hostile
overwrite/delete refusal, nonrewindable independently signed latest
head, credential rotation, native owner-authorized SAI/PDS lifecycle,
full PostgreSQL/Redis/Jena/PDS rollback recovery or a successful hosted
unified-account signup. Independent human release signoff is still required.

## Initial owner-enrollment OAuth coordinator — CLOSED staging source pin, November 25, 2026

This stage advances **only** the reviewed ActivityPods Git source SHA to
`327ddf9819c14e04e9606eb7e2d6a33143df886f`, merged
[ActivityPods PR #313](https://github.com/outlaw-dame/activity-pods/pull/313).
Federation source SHA, all OCI digests and `release=CLOSED` remain unchanged.

The new upstream ActivityPods candidate is intentionally **NONACTIVATED**.
It proves that the *first* enrollment-bound OAuth consent cannot become
an active Redis grant before the canonical PostgreSQL epoch is committed
under a restricted PG18 issuer and an independent immutable-witness
high-water has been freshly attested and read back. It uses the same
browser-session Lua CAS as existing session approval and refuses timeout,
logout, credential rotation, concurrent first approval and lost PG/Redis/
COMMIT acknowledgements. The issuer's role admission and irreversible SQL
write execute inside one PG transaction, including under a transaction pooler.
Tests require `NODE_ENV=test` and multiple explicit disposable gates.

Exact upstream PR-head workflows succeeded: PG18 + Redis 8.2 recovery
`45558103024` (**15 new tests passing**), backend `45558103064`
and dependency/lint `45558103008`. The real Redis 8.2 DUMP/RESTORE
exercise includes signed ES256 token introspection. Other existing
two-PG18 independent witness recovery proofs also passed. The new v7
initial issuer's PG role and owner verifier are **simulated contracts**;
the live post-enrollment browser/SAI authorization path is not wired
to that candidate.

Staging promotion must pass both exact-head `tls-runtime` and
`local-provider`, including HTTPS signup refusal and PDS OAuth refusal,
protected Fuseki isolation and OIDC JWKS continuity through restart.
This is a **negative-release** integration, not hosted positive signup.
An independently administered, irreversible high-water head and actual
S3-compatible COMPLIANCE WORM retention/hostile operation evidence are
still missing. General owner grant/change/revoke/uninstall **cannot**
use the short-lived signup enrollment token; new independently archived
pre-transition denial intent and canonical post-enrollment owner-session
binding must be implemented before production activation. Historical
credential rotation, physical multi-store recovery and independent
release signoff remain P0. **Do not open the signup or PDS OAuth fuse.**

## Post-enrollment owner/credential/SAI reader — CLOSED source pin, November 25, 2026

This stage advances **only** the ActivityPods source pin to merged
`40668f44a0db021591837dbd41c14cc1883264d7`
([ActivityPods #314](https://github.com/outlaw-dame/activity-pods/pull/314)).
Federation source commit and five OCI digests are unchanged; `release=CLOSED`.

The newly merged ActivityPods PostgreSQL 18 v8 SQL is a **NONACTIVATED,
read-only** joined view of the existing managed WebID/DID, active credential
epoch, native-attested SAI and current OAuth generation. It provisions
a dedicated function-only NOLOGIN role and grants no direct credential/SAI/
OAuth table privileges or mutating functions. The accompanying test-only
owner verifier compares an authenticated browser-session issuance epoch
to an independently challenge-signed latest credential head plus fresh
primary PG, SAI and immutable witness checks, repeated across the
network read window. It returns **pre-denial planning evidence only**,
not permission to approve, revoke, replace, uninstall or sign PDS writes.

Exact-head upstream security CI passed: real PG18 and Ed25519 signer test
`45600562738`, backend `45600562912`, lint/regressions `45600562760`.
The integrated fixture uses a real PG18 schema and restricted SQL logins;
its native Jena/Redis browser and independently immutable OAuth witness
callbacks are **simulations**, not deployed cross-service wiring.
Current production OAuth cookies do not include the independent credential
epoch, so do not wire this candidate into running services.

The crucial remaining P0 is independently retained **pre-transition
denial before every revoke/replace/uninstall mutation**, with an
independently administered immutable high-water signer visible to all
token, DPoP, PDS and browser authorization paths. Existing signed-write
pending intents must be durably reconciled before revocation ACK.
Operator-proven S3-compatible COMPLIANCE custody, real positive owner
grant lifecycle, PG/Redis/Jena/PDS coordinated physical PITR, historical
credential rotation and security/performance signoff remain incomplete.
No production signup or OAuth issuer release is authorized.

## Immutable pre-denial S3 receipt and signed latest-head contract — CLOSED pin, November 25, 2026

This source-only stage pins merged ActivityPods
`124543d1ef115cc4e884a77935f6a56a691b8db1`
([PR #315](https://github.com/outlaw-dame/activity-pods/pull/315)).
Federation source and all five OCI image digests are unchanged, and
`release=CLOSED` remains source-controlled.

Upstream ActivityPods now has **NONACTIVATED** strict versioned OAuth
pre-denial receipt bytes under a separate `pre-deny/v1` prefix.
The owner/client/grant/revision/credential/SAI fields derive from its
post-enrollment signed owner/canonical credential/SAI reader, not from
untrusted request-selected identifiers. The existing vendor-neutral
S3 COMPLIANCE receipt transport verifies conditional create-only PUT
request shape, complete version history, exact payload digest, versioned
retention and independent object readback. A new isolated Ed25519
public-key-only latest-head verifier checks nonce, signature, subject,
grant, revision, exact retained receipt digest and timestamp, including
after owner-session and credential rechecks following WORM archive.

**Exact ActivityPods tested head** passed:
S3 contract `45602870960`, independent PostgreSQL witness
`45602871028`, two independent PostgreSQL 18 physical WAL/PITR
`45602871058`, backend `45602871121`, dependency/lint
`45602870968`. The S3 endpoint and signer used by the new proof are
**disposable simulations**, not evidence of a qualified live storage
provider or independently administered nonrewindable signer.
The new coordinator cannot call any runtime revoker or PDS writer,
returns `releaseAccepted:false`, and is not imported by running services.

Independent **live** signer custody, provider-qualified COMPLIANCE retention,
hostile overwrite/delete tests, complete pre-denial consultation by
OAuth code/access/refresh/DPoP, browser and PDS signed-write paths,
signed-write pending intent drain/commit reconciliation, signed current
owner session-credential epochs, actual native Jena/SAI owner mutation,
physical PG/Redis/Jena/PDS recovery, rotated historic credentials and
hosted positive signup still block production. Nothing authorizes opening
the signup or PDS OAuth release fuse.

## Independent PG18/pre-deny subject agreement — CLOSED pin, November 25, 2026

Frozen staging advances ONLY ActivityPods Git SHA to merged
`06ab9a5ed8deaae652555e22f355ed33b1186f9d`
([ActivityPods #316](https://github.com/outlaw-dame/activity-pods/pull/316)).
The federation source, all five OCI image digests and
`release=CLOSED` remain unchanged.

A critical integration mismatch was found in previous nonactivated
ActivityPods #315: the pre-denial subject used NUL delimiters while the
independent PostgreSQL 18 witness v5 signed-write receipt uses an
ASCII/UTF-8 **owner-length-framed** subject hash. The corrected
pre-denial candidate now uses the exact independent witness v5 algorithm.
Its strengthened hosted regression compares the actual SQL-produced
signed-intent receipt bytes with the JavaScript pre-deny subject and
rejects the legacy NUL-delimited mismatch, as well as owner/client drift.
All source remains NONACTIVATED: no production OAuth/PDS issuer, revoke,
replace, Jena permission or independent signer was enabled.

Exact ActivityPods #316 head
`1c2dc502eeda525f1fa342f39a9e72eebe8f0a81` passed all
five required CI workflows: independent two-PostgreSQL witness
`45604722390`, PostgreSQL/Redis recovery `45604722601`, S3 COMPLIANCE
contract `45604722533`, backend `45604722581` and dependency/lint
`45604722519`. This is a *disposable real PG18 cross-language proof*,
not deployed independently administered signer or live S3 provider
COMPLIANCE-custody certification.

Subsequent source promotion requires both exact-head staging TLS/runtime
and local-provider jobs, including HTTPS negative signup/PDS OAuth, Jena
protected permissions, RDF durability and OIDC JWKS restart continuity.
Production release remains blocked until real immutable latest head and
PRE-DENY enforcement on every OAuth/PDS writer admission, signed-write
intent drain/recovery, real owner consent/revoke lifecycle, multi-store
physical restore and operator credential rotation are demonstrated.

## Independent current denial + prepared signed-PDS write fence — CLOSED source pin, November 25, 2026

Frozen source pin advances ONLY ActivityPods to merged
`4469172d59171fd7a967caeb2df09512ecfda0ab`
([ActivityPods #318](https://github.com/outlaw-dame/activity-pods/pull/318)),
which includes earlier merged
[ActivityPods #317](https://github.com/outlaw-dame/activity-pods/pull/317)
at `617f0937fd58b5ef998e7f9a22c6b74fd684e4a5`.
The federation code pin, all five OCI image digests and
`release=CLOSED` are unchanged.

#317 adds a NONACTIVATED, public-Ed25519-key-only read admission contract
for 15 identified OAuth, DPoP, owner-consent and signed-PDS entry points.
It requires canonical PG, independent witness PG18, separate immutable
archive exact latest readback, nonce-signed current signer head and a
second cross-check of authenticated owner, grant and credential epoch.
Its return is `releaseAccepted:false` and no production service imports
it. Upstream exact-head S3, independent witness, backend and lint passed:
`45607560525`, `45607560400`, `45607560476`, `45607560397`.

#318 adds an **independent PostgreSQL 18 v7 prepared PRE-DENY
writer fence** (also NONACTIVATED): one-way exact owner/grant/credential/
SAI/scope/operation CAS; writer reservations serialize with PREPARE using
a row lock; new signed-write intents and active witness queries reject
a prepared denial. Existing PENDING signed-write intents **remain unresolved**
until their independently retained PENDING/COMMITTED receipts are settled;
a revocation cannot acknowledge before exact PRE-DENY receipt archival and
SQL sealing. The two physically distinct PG18 fixture and strict
SQL-versus-S3 JSON test passed. Coordinator preserves
**PG PREPARE -> archive WORM -> independently seal -> signed-head publish**
and refuses unknown acknowledgments without retry or timeout abort.
Upstream exact-head checks ALL passed: S3 `45608959866`, independent
two-PG18 witness `45608960002`, backend `45608959891`, and lint
`45608960160`.

**Important security limits:** The real PG18 SQL/locking proof uses
disposable, simulated S3 storage and signer; it is not a deployed
independently controlled COMPLIANCE Object Lock store or a nonrewindable
latest-head authority. The v7 migration explicitly **refuses any historical
signed-write intent**; no live migration, signer, revoker or PDS OAuth
endpoint activation has been performed. Real current browser credential
epoch + native SAI and grant lifecycle, endpoint-wide independent denial,
witness/PDS pending commit reconciliation, real physical
PG/Redis/Jena/PDS recovery and historically exposed credential rotation
remain release blockers. The production signup and PDS OAuth fuse MUST
remain CLOSED, regardless of successful frozen staging.

## Same-session pre-denial owner proof — CLOSED source pin, November 25, 2026

This frozen staging pin advances ONLY ActivityPods from
`4469172d59171fd7a967caeb2df09512ecfda0ab` to the merged
`544316e19d4d816654c48106b453343b9a733ab3`
([ActivityPods #319](https://github.com/outlaw-dame/activity-pods/pull/319)).
The pinned federation source, all five OCI image digests, the native
PG/Jena/Redis/PDS runtime and `release=CLOSED` are unchanged.

The NONACTIVATED pre-denial coordinator previously rechecked owner WebID,
client/grant, OAuth, SAI and credential revisions after immutable archival
but did not compare the authenticated session proof itself. It now
requires a provider-derived SHA256 authentication-proof identifier and
compares that exact digest before independent witness SEAL and
latest-head publication. A same-owner logout/relogin with unchanged
credential epoch cannot silently replace the original owner ceremony.
Invalid or absent proof stops before WORM PUT. A proof change after
the PG18 PREPARE and archive leaves the independent denial prepared
and refuses sealing/publication; no speculative rollback, expiry or
repeat write is attempted. The proof digest never enters the retained
receipt.

ActivityPods #319 exact tested head
`3e7e76b21cca409af215b1a14a5d488a1869cd28` passed all
four required CI jobs: independent two-PG18 witness
`45652487167`, S3 COMPLIANCE archive `45652487262`,
backend `45652487190`, and dependency/lint
`45652487138`. Its merge used an exact-head SHA lease and had no
unresolved review threads.

These are disposable candidate regressions, **not** a production
authenticated SemApps/Solid-OIDC SAI integration or independent
nonrewindable WORM signer. Physical multi-store restore, real
independent custody/monotonic signer, complete owner grant/revoke/
uninstall and signing-key rotation, every live OAuth/PDS denial
admission, pending PDS COMMIT drain, hosted positive signup and
operator/security signoff remain P0. Production signup and PDS OAuth
issuance MUST remain CLOSED.

## Portable independent PRE-DENY S3 inventory — CLOSED source pin, November 25, 2026

Frozen source pin advances **only** ActivityPods from the preceding
`544316e19d4d816654c48106b453343b9a733ab3` to merged
`2a6a0c595c5eae77eed6c2e460a513b398453be1`
([ActivityPods #320](https://github.com/outlaw-dame/activity-pods/pull/320)).
The federation source SHA, all five image digests and
`release=CLOSED` remain exactly unchanged.

The NONACTIVATED candidate adds an actual S3-compatible **read-only**
pre-denial object-version inventory for the independent witness-v5
length-framed owner/client subject. It reuses the restricted portable
bucket/retention/version-content verifier; rejects forks, delete
markers, malformed receipts, incomplete histories and observed
mid-read drift; and reports retained PRE-DENY as **denial-only
evidence**. An empty archive inventory explicitly does **not**
authorize a code, JWT, DPoP proof, refreshed token or signed PDS
commit. Its isolated OAuth/PDS admission candidate checks the
archive inventory twice around current-head and canonical/witness
reads. It passes the archive reader only the pseudonymous subject
digest and cancellation signal, not user WebIDs, grant or session
credentials. No production endpoint imports the code.

**Exact ActivityPods tested head**
`fe75b7a1525a398f17a05b6f2bc528c2970fd684` passed all
four required jobs: independent PG18 witness `45664062336`,
S3 COMPLIANCE/official SDK `45664062416`, backend
`45664062455`, dependency/lint `45664062609`.
Source was merged by expected-head SHA lease with clean reviews.

**Still P0:** this does NOT provision independently administered
COMPLIANCE S3 custody or an outside nonrewindable monotonic signer;
synthetic listings can be stale and two observations do not
serialize with a concurrent PREPARE/PUT. Native Solid-OIDC/SAI
owner lifecycle, real OAuth/PDS admission, pending signed repo
commit recovery, encrypted physical cross-store PITR,
credential rotation, hosted positive signup, scale and independent
operator/security acceptance remain blocked. Keep production
signup and PDS OAuth issuance `CLOSED`.

## Independent WORM-backed denial signer — CLOSED staging pin (November 25, 2026)

This staging source-only PR advances **only** ActivityPods from
`2a6a0c595c5eae77eed6c2e460a513b398453be1` to merged
`f7762a51275edfadf6fa316a85eba05587253a47`
([ActivityPods PR #321](https://github.com/outlaw-dame/activity-pods/pull/321)).
The federation SHA, all five pinned container images and
`release=CLOSED` are unchanged.

The independently located, **NONACTIVATED** denial signer source
`pod-provider/independent-authority/immutable-denial-head-signer.mjs`
reconstructs a retained pre-denial for every fresh nonce from
S3-compatible Object Lock COMPLIANCE read-only evidence, rather
than trusting restored provider, PG, Redis or signer-local state.
It obtains an Ed25519 signature through a **separate, injected
signing callback**, independently verifies that signature against
a public-only pinned key and **revalidates S3 versions, hash, object
retention and history after signing**. Missing, forked, corrupted,
deleted or expired WORM evidence never produces ACTIVE or a positive
authorization. It is a deny-only statement; no production provider
service uses the code, no signing key is stored in the repository,
and no live B2, Storj or alternate S3 custody has been provisioned.

The existing consumer independently verifies the signed nonce,
subject, grant digest, operation, receipt digest and time.
Adversarial tests cover stale signer caches after restored
PostgreSQL, missing or corrupted WORM receipts, different
versions or delete markers inserted during KMS signing, forged
signer, stale nonce, unsafe challenge coercion, incomplete S3
history and canceled requests.

ActivityPods exact-head `f5bdce26fcb2541dd0743b771acbbdd0883729c1`
passed the full four required CI workflows:
S3 COMPLIANCE and official SDK `45667844744`,
independent PG18 witness `45667844647`,
backend `45667844702`, lint/regressions `45667844785`.
The first ESLint issue for standalone Node globals was corrected
using narrow imports, then **all** exact-head CI was rerun.
Merge leased to that passing SHA and its clean review.

**Still OPEN P0:** independently administered real COMPLIANCE
storage and KMS custody, full positive+negative monotonic
high-water protocol, durable generation renewal before 400-day
expiration, live native OAuth/Solid-OIDC/SAI/PDS authorization and
signed-write fence, actual cloud operator hostility tests,
physical multi-store PITR, and positive hosted signup. Storj
documentation warns that object listings are not always sorted;
never infer complete ordered high-water from its S3 LIST without
provider-specific certification. No simulated denial signing
can activate `release=OPEN`.

## Independent dual-status generation WORM chain — CLOSED source pin (November 25, 2026)

Source pin advances **only** ActivityPods from
`f7762a51275edfadf6fa316a85eba05587253a47` to merged
`5df648afed802397dac8249b4f68cfd9bed62de6`
([ActivityPods PR #322](https://github.com/outlaw-dame/activity-pods/pull/322)).
The federation source SHA, all five immutable image digests and
`release=CLOSED` remain unchanged.

The **NONACTIVATED** independent custody-side generation journal
`pod-provider/independent-authority/oauth-generation-worm-journal.mjs`
provides a strict S3-compatible Object Lock COMPLIANCE receipt chain:
an initial ACTIVE genesis and one terminal BLOCKED transition,
bound by SHA256, revision, stable grant and owner-proof metadata,
the legacy epoch-v1 and witness-v5 subject hashes, and the
independently retained PRE-DENY v7 receipt. It confirms per-object
COMPLIANCE/version/retention, refuses incomplete version histories,
forks, delete markers, repeated generations, unsupported third
transitions and conflicting concurrent S3 writes. A conditional PUT
receives **one** attempt; lost ACK is reconciled with exact WORM
versions and hash, never retried blindly.

For every observed ACTIVE or BLOCKED journal,
`activeAuthorizes:false`, `completeExternallyVerified:false`
and `releaseAccepted:false`. The two opaque subject hashes are
**not** cryptographically proven to be derived from the same
authenticated WebID/client; the live native Solid-OIDC/SAI owner
bridge must provide that proof. S3 can return a coherent stale
listing, so positive authorization requires a separate signer
with nonrewindable monotonic high-water — not this fixture.

Upstream exact-head `7cf9f3c2c1dd0f2c5a21dc45ca238b1d65c08c22`
passed **all five CI gates** before merge: S3 COMPLIANCE/official
SDK `45671479779`, independent PG18 witness `45671479766`,
two-cluster physical PITR `45671479843`, full backend
`45671479902` and lint `45671479774`. All 4 Codex
review threads were resolved; code was merged by expected-head
SHA lease after a reviewed seven-file source diff. The backend
workflow now also explicitly watches
`pod-provider/independent-authority/**`.

**Still P0 / release CLOSED:** separately administered real
Backblaze B2 / Storj / qualified S3 COMPLIANCE account, proven
hostile conditional-PUT/delete-marker/retention behavior,
independent externally held signing/KMS key and signed
nonrewindable positive + negative high-water, proper renewal
before 400-day expiry, actual authenticated owner/SAI/Solid-OIDC
ceremony and all OAuth/PDS/DPoP/JWT/signed-write fences, independent
physical signer/PG/Redis/Jena/PDS disaster restore, hosted positive
signup and operator/security acceptance. Cloudflare R2's
reversible bucket locks do not meet COMPLIANCE custody.

## Signed generation high-water and all-surface admission — CLOSED (November 25, 2026)

ActivityPods source pin: merged
[`#323`](https://github.com/outlaw-dame/activity-pods/pull/323) at
`bd38eded14e17515c9c604a2cb8eafd08ac33699`
(exact green reviewed source `a4e6aa21ba3a17c51de06cbe84bd260116dc3297`).
Only the ActivityPods source pin advanced from
`5df648afed802397dac8249b4f68cfd9bed62de6`.
The federation source pin, all five immutable OCI image digests,
and `release=CLOSED` must remain byte-for-byte unchanged.

The **NONACTIVATED** independent generation high-water candidate
`pod-provider/independent-authority/signed-generation-high-water.mjs`
reconciles full immutable S3 COMPLIANCE journal observations with a
separately persisted compare-and-set checkpoint. It rejects a coherently
hidden or rewound ACTIVE journal prefix after the checkpoint has
advanced, never blindly retries ambiguous CAS, and binds a fresh
nonce, numeric generation, journal hash and S3 version, key epoch,
subject and owner/grant/scope/OAuth/credential/SAI revision evidence
in a canonical Ed25519 signed response. Signing is injected, and
the journal and checkpoint are rechecked after signature creation.
The shared receipt-version bound is **512 UTF-8 bytes**, including
multibyte values.

The test-only `oauth-independent-pre-deny-admission.mjs` verifier
checks the new signed generation evidence at all **15** OAuth/PDS
admission surfaces, including current owner-proof matching, and
fails closed on incorrect signature, key epoch, checkpoint,
evidence scope, rollback and concurrent state changes. This is a
rejection protocol and does **not** grant production access.

Upstream exact-head CI on source `a4e6aa21ba3a17c51de06cbe84bd260116dc3297`:
S3 COMPLIANCE/high-water contract `45712187336`;
independent PostgreSQL witness `45712187656`;
backend `45712187462`;
lint/regressions `45712187644` — all successful. The
multibyte-version boundary review defect was corrected and retested
before merge; the follow-up code review reported no major issues.
An independent security-review automation did not return a result
and is not being represented as complete.

**Critical release P0 remains:** This test-only injected CAS is not
evidence that the **actual deployed sequencer** is independently
operated, has irreversible monotonic behavior or survives a hostile
signer rollback; no real independent S3 COMPLIANCE account or protected
signing key has been certified. The subject pair and owner-proof
metadata still need a live, authenticated WebID/client binding.
Live Solid-OIDC/SAI, OAuth code/access/refresh, DPoP and signed-PDS
mutation paths need fenced authority integration, independently
verified cloud contention/deletion/retention tests and real
multi-store physical recovery. No feature flag permits release to
open until those tests, operator custody and security review pass.

## Independent live S3 COMPLIANCE hostile-version certification — CLOSED (November 25, 2026)

ActivityPods source advances **only** from
`bd38eded14e17515c9c604a2cb8eafd08ac33699`
to merged [PR #324](https://github.com/outlaw-dame/activity-pods/pull/324)
`a4f55d26e9422ca75ca9b74d89d36509eee6a9f6`,
exact CI-tested head `43149914ccdf3f186bc11e6acce674e2ca0d4638`.
The federation source, **all five** pinned OCI image digests, and
`release=CLOSED` remain unchanged.

**NONACTIVATED operator-only security harness:**
`pod-provider/backend/scripts/probe-oauth-portable-s3-hostile-lock.mjs`
and `candidates/oauth-portable-s3-hostile-lock-probe.mjs`.
The operator performs **read-only preflight** of a disposable S3
COMPLIANCE sample created by the preexisting competing-writers
`probe-oauth-portable-s3-writeonce.mjs` probe. It validates bucket
versioning, exact historical version and SHA-256, unaltered canonical
receipt bytes, no delete markers and retention, then derives a SHA-256
approval challenge binding provider origin, bucket, key, version,
digest, retention expiration and planned adversarial credential
profile. The separately approved **hostile phase** requests exact
VersionId deletion and one-day retention shortening, each **once**,
re-reading the entire version, retention and digest evidence after
each denied request. It never performs unversioned deletion or an
overwrite. Only idempotent `GetObjectRetention` may retry, using a
bounded exponential backoff with jitter for 429/503/504.

The tool returns `releaseAccepted:false`,
`iamEnforcementProven:false`,
`independentAdministrationVerified:false` and
`monotonicLatestHeadVerified:false`. In particular, a 400/403 may
come from insufficient IAM privilege or an invalid S3 method rather
than Object Lock COMPLIANCE. The **external custodian must prove**
the adversary was otherwise authorized to attempt version deletion
and retention change, provide out-of-band signed certificate and
native-API checks, and demonstrate independently governed root,
billing, retention, permissions, KMS/signing and recovery. Real
retention-shortening/deletion requests can permanently alter the
sacrificial sample if a provider is faulty: explicit, informed
operator approval is mandatory before running them.

Upstream exact-head CI passed all four required jobs:
S3 COMPLIANCE + official pinned SDK `45729885551`,
two-PG18 independent witness `45729885654`,
backend `45729885536`, lint/regressions `45729885515`.
The reviewed upstream diff was five files; no production service
imports, no private keys, secrets or endpoint activation. A separate
Codex review request did not return completed security signoff.

**Next P0** is to execute the already implemented operator probes
under an **actually independent** qualified Backblaze B2, Storj or
other S3-compatible COMPLIANCE account, preserve auditor evidence
and attest independent KMS and signed nonrewindable high-water;
only then integrate native owner/SAI OAuth/PDS fences and execute
multi-store physical PITR. Cloudflare R2 reversible bucket rules
are not a substitute for separately administered COMPLIANCE
version custody. The signup/release fuse remains **CLOSED**.
