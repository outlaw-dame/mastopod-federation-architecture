# Developer ATProto Branch: Exact Provider Source Audit and 57-Path Integration Inventory

**Date:** 2026-11-11. **State:** source location recovered; static review and full path inventory verified. **Runtime conformance, CI, semantics of all 57 files: NOT VERIFIED.**

Parent tracker: [#125](https://github.com/outlaw-dame/mastopod-federation-architecture/issues/125). G0–G6 acceptance plan: [external-atproto-recovery-integration-gates.md](./external-atproto-recovery-integration-gates.md).

## Immutable source provenance

| Item | Verified value |
| --- | --- |
| External sidecar | [`Lawhacknifemi/mastopod-federation-architecture`, `sh-mvp`](https://github.com/Lawhacknifemi/mastopod-federation-architecture/tree/e4d0bb74142afbaf4573d2f93e28028479d6b52d), `e4d0bb74142afbaf4573d2f93e28028479d6b52d` |
| **Recovered provider repository** | [`Lawhacknifemi/activitypods-demo-bridge`](https://github.com/Lawhacknifemi/activitypods-demo-bridge/tree/9f1c7fc3511487150ce458f025e9dc4477133221), `9f1c7fc3511487150ce458f025e9dc4477133221` |
| Verified parent provider gitlink | `11108f070c7e29a4a86cff84d4f671a40bffcb46` also exists in this exact provider repository |
| Provider tree | `activitypods/pod-provider/backend/`, `semapps/src/middleware/packages/atproto/`, `demo-pds-js/`, tests/scripts |
| Parent sidecar submodule metadata | `activitpod-aptoroto` gitlink exists, but missing associated `.gitmodules` URL. Manual source identified; clean recursive clone not automatically reproducible |
| Cross-fork comparison | our federation `master` vs `Lawhacknifemi:sh-mvp`: **30 ahead, 282 behind, 57 changed paths (25 added / 32 modified; no removed)**; **+10,829 / -101** |
| Validation | Authenticated hash lookups, static inspection and **[G0 Actions #43056813618](https://github.com/outlaw-dame/mastopod-federation-architecture/actions/runs/43056813618) successful** at workflow head `fdf5e415e53b6ba5b948d7e8fb8a157def33d385`: immutable sidecar/provider checkout, gitlink verification, 9 provider + 8 sidecar JavaScript syntax checks. **No dependency install, provider suite, live PLC/relay or signed CAR verification yet** |

**Important correction from initial source review:** The external **sidecar's** `activitypods-integration/backend/services/atproto/identity.service.js` constructs fake, hex-hash-derived `did:plc` identifiers. The **recovered provider's active helper** is *different*: `activitypods/pod-provider/backend/helpers/atproto/identity.service.js` assembles and signs a PLC genesis operation and POSTs it to `plc.directory`. Do **not** conclude the developer's entire ATProto implementation uses fake PLC DIDs on the basis of the sidecar file; and do **not** conclude real network compatibility without executing independent verifiers.

## Provider code findings and what they mean for implementation

| Evidence (all under recovered provider SHA above) | Verified static observation | Gate/required remedy |
| --- | --- | --- |
| `activitypods/pod-provider/backend/services/identity.js` and `helpers/atproto/identity.service.js` | Active wrapper uses helper with signed genesis operation and directory POST; `semapps/.../services/identity.js` is an older separate implementation. | **G1:** retain exactly one canonical identity/provisioning implementation; independently verify DID method conformance, resolved DID document, operation signature, PDS endpoint, key rotation. No blind copy of duplicates. |
| `activitypods/pod-provider/backend/services/core/auth.js` | Generates AT commit/rotation keys and persists partial identity binding before PLC genesis, but catches provisioning errors and still returns successful signup. | **G1 BLOCKER:** unified-account creation must not report ready without verifiable `did:plc` and initialized repo; durable staged recovery and exactly-once signup. PR #134/#138 must be reconciled. |
| `activitypods/pod-provider/backend/services/core/keys.js`; `services/signing.service.js` | Implements secp256k1 key operations and signed PLC/commit endpoints; our ActivityPods `master` **already has** `generateSecp256k1Key`, `getAtprotoKeyPair`, `signAtprotoCommit` and `signAtprotoPlcOp` APIs. | **G1 ALREADY PARTIALLY PRESENT:** compare behavior and secure custody rather than duplicating services or allowing multiple writers; confirm key ownership and scoped authentication. |
| `activitypods/pod-provider/backend/helpers/atproto/repo.js` | `_finalizeCommit` signs when a callback and account exist, but logs and permits **unsigned commits** otherwise; initial empty-tree commit sets `data: null`. | **G2 BLOCKER:** managed mode must fail closed without signing keys; external repository spec requires non-null CID-link `data`; validate exact CBOR signature/commit/MST against independent tooling. |
| `activitypods/pod-provider/backend/helpers/atproto/atproto.service.js` | Keeps repo cache `new Map()`; stores MST and commit blocks in Fuseki; performs separate writes for record, tree, commit and RDF metadata. | **G2:** single-writer/revision fences across replicas, transactional or compensatable state changes, crash/restart correctness, replay under concurrent writers. No claim that process cache is authoritative. |
| Same `atproto.service.js` | Logs `ctx.params` and `ctx.meta` wholesale in create/update paths; an ad-hoc firehose frame uses `rev: commitCid` rather than commit TID, with empty `blocks`. | **G3 / G5:** redact sensitive metadata, remove ad-hoc nonconformant wire path, test native revision and full CAR in actual sidecar route. |
| `activitypods/pod-provider/backend/services/atproto/redpanda-commit-publisher.service.js` and write path | Publishes `at.commit.v1` after persistence; failure is caught and only warned, and write can return success. | **G2 BLOCKER:** durable native-event outbox/reconciliation required, otherwise crash/broker outage can strand valid commits. |
| `helpers/atproto/repo.js#getCheckout` | Queries **all** stored block entries from Fuseki to construct full CAR; in-memory materialization of all blocks. | **G2 / G5:** bounded streaming or paginated block iteration, cache/retention design, load test at large record counts; ensure CAR root includes signed commit, all reachable MST and record blocks. |
| `activitypods/pod-provider/backend/services/api.js` | Adds `/identity`, `/atproto`, `/bridge`, and `/xrpc` aliases, including mutation routes, with no demonstrated per-alias authorization in the excerpt. | **G5 BLOCKER until proven:** enforce routes' authentication *and* caller/actor authorization; keep private internal contracts behind a separate trusted boundary. |
| External sidecar `internal-social-api.service.js` | Supports master-token route capable of mutating arbitrary requested actor and substitutes an actor URI into Moleculer metadata. | **G5:** do not port as user delegation; require caller-scoped grants, deny-first revocation, and authenticated actor ownership. |
| External sidecar `AtFirehoseEventEncoder.ts`, `AtRecordReader.ts`, `AtCarExporter.ts` | Candidate fixes for CID-link CBOR encoding, real provider-backed record values and non-empty CAR; our `master` retains earlier versions of these files. | **G3:** selective tests/ports only after G0; no whole-branch merge. |

### Additional integration regressions confirmed against our current master

These differences emerged from side-by-side source inspection, rather than relying on the external branch's original commit messages:

- **APDM authorization regression:** external `fedify-sidecar/src/delivery/outbound-webhook.ts` (6,192 bytes) lacks the more recent explicit APDM `delivery_plan` / `interop_legacy` authority/provenance checks in our `master` (13,895 bytes). **Do not take the external implementation.**
- **Durable retry regression:** external `src/delivery/outbox-intent-worker.ts` uses an ACK-then-reenqueue approach for some deferred work. Our `master` uses a persisted delayed replacement and requires a durable delay scheduler before consuming. **Do not reintroduce the older queue semantics.**
- **Localhost boundary widening:** external `src/utils/internalAuthority.ts` includes `host.docker.internal` in loopback hostnames where our `master` does not. This may change internal API trust decisions; reject unless individually justified and tested.
- **Development DB credentials:** external `src/config/v6-config.ts` supplies a plaintext PostgreSQL connection-string fallback containing `sidecar_user:sidecar_password`. Our `master` does not load that database. Do not carry test defaults into deployed environments.
- **Non-AT adjacent changes:** `DirectMessageTranslator.ts`, Redpanda topic governance, OpenSearch feed/search mappings and Docker/Compose wiring are **not automatically needed** for ATProto recovery. Treat as separate change domains with dedicated acceptance.

### Priority test matrix

1. **G1 identity:** same username/email simultaneous registration; synthetic PLC outage; successful genesis + crash before local binding; missing/forged rotation key; tampered PLC response; retry with same idempotency key; prove no phantom successful unified account.
2. **G2 repository:** write from two replicas at same rev; power-loss after commit persisted but before `at.commit.v1`; collision on record key; crash after MST storage but before commit; bad signature; no signer configured; signed commit's DID/key agrees with registered PLC document; full CAR import independently verifies all blocks/CIDs.
3. **G3 edge:** independent CBOR decoder and relay verify `commit`, `ops[].cid`, `prevData` CID links; `rev` matches commit TID; CAR includes all reachable blocks; cursor/out-of-order/gap repair; enforce bounded export and authentication.
4. **G4 projection:** AP only / AT only / dual with replayed, duplicated and reordered native events, no unauthorized publication and no self-reinforcing loops.
5. **G5 security:** malformed actor URI, remote/private SSRF, JSON-LD/SPARQL/N-Triples injection, cross-tenant IDOR, private inbox access, revoked consent, untrusted metadata, logs redaction and unbounded buffer control.
6. **G6 CI/production:** independent signed PLC resolution, exact-head backend and sidecar suites, real relay/AppView acceptance, four-replica recovery, performance/cost and rollback evidence.

## Complete source-delta path inventory (57 files)

This table is **complete at the path level**, based on cross-fork `compare_commits` against our current federation `master`. Each disposition is a **triage category**, **not** proof of semantic review, safe migration, test pass, or deployment.

| File | Change | Triage / integration ownership |
| --- | --- | --- |
| `LOCAL-DEVELOPMENT.md` | added | Wiring/build/config; do not merge wholesale |
| `activitpod-aptoroto` | added | Provider gitlink (now located) |
| `fedify-sidecar/Dockerfile` | modified | Wiring/build/config; do not merge wholesale |
| `fedify-sidecar/activitypods-integration/backend/services/INTERNAL-SOCIAL-API.md` | added | Investigate behavior before disposition |
| `fedify-sidecar/activitypods-integration/backend/services/api.js` | added | Auth boundary and API surface; security review, no direct copy |
| `fedify-sidecar/activitypods-integration/backend/services/atproto/atproto.service.js` | added | Legacy duplicate provider/bridge implementation; do not import |
| `fedify-sidecar/activitypods-integration/backend/services/atproto/bridge.service.js` | added | Legacy duplicate provider/bridge implementation; do not import |
| `fedify-sidecar/activitypods-integration/backend/services/atproto/federation.service.js` | added | Legacy duplicate provider/bridge implementation; do not import |
| `fedify-sidecar/activitypods-integration/backend/services/atproto/identity.service.js` | added | Legacy duplicate provider/bridge implementation; do not import |
| `fedify-sidecar/activitypods-integration/backend/services/atproto/utils/atproto-utils.js` | added | Legacy duplicate provider/bridge implementation; do not import |
| `fedify-sidecar/activitypods-integration/backend/services/atproto/utils/carfile.js` | added | Legacy duplicate provider/bridge implementation; do not import |
| `fedify-sidecar/activitypods-integration/backend/services/atproto/utils/mst.js` | added | Legacy duplicate provider/bridge implementation; do not import |
| `fedify-sidecar/activitypods-integration/backend/services/atproto/utils/repo.js` | added | Legacy duplicate provider/bridge implementation; do not import |
| `fedify-sidecar/activitypods-integration/backend/services/core/auth.js` | added | Legacy duplicate provider/bridge implementation; do not import |
| `fedify-sidecar/activitypods-integration/backend/services/internal-social-api.service.js` | added | Auth boundary and API surface; security review, no direct copy |
| `fedify-sidecar/activitypods-integration/outbox-emitter.service.js` | modified | AP delivery and bridge integration; must not regress APDM |
| `fedify-sidecar/activitypods-integration/scripts/bootstrap-local-dev.sh` | modified | Wiring/build/config; do not merge wholesale |
| `fedify-sidecar/activitypods-integration/scripts/shutdown-local-dev.sh` | modified | Wiring/build/config; do not merge wholesale |
| `fedify-sidecar/activitypods-integration/scripts/status-local-dev.sh` | modified | Wiring/build/config; do not merge wholesale |
| `fedify-sidecar/docker-compose.yml` | modified | Wiring/build/config; do not merge wholesale |
| `fedify-sidecar/package-lock.json` | modified | Wiring/build/config; do not merge wholesale |
| `fedify-sidecar/package.json` | modified | Wiring/build/config; do not merge wholesale |
| `fedify-sidecar/scripts/listen-local-firehose.js` | added | Wiring/build/config; do not merge wholesale |
| `fedify-sidecar/scripts/start-local-minimal.sh` | added | Wiring/build/config; do not merge wholesale |
| `fedify-sidecar/scripts/test_db_sync_temp.js` | added | Debug or ad-hoc fixture; exclude |
| `fedify-sidecar/scripts/test_single_sync.js` | added | Debug or ad-hoc fixture; exclude |
| `fedify-sidecar/sidecar_logs.txt` | added | Debug or ad-hoc fixture; exclude |
| `fedify-sidecar/src/at-adapter/events/AtRepoEvents.ts` | modified | Protocol read/CAR/wire contract candidate; manual diff and conformance |
| `fedify-sidecar/src/at-adapter/firehose/AtFirehoseEventEncoder.ts` | modified | Protocol read/CAR/wire contract candidate; manual diff and conformance |
| `fedify-sidecar/src/at-adapter/repo/AtCarExporter.ts` | modified | Protocol read/CAR/wire contract candidate; manual diff and conformance |
| `fedify-sidecar/src/at-adapter/repo/AtRecordReader.ts` | modified | Protocol read/CAR/wire contract candidate; manual diff and conformance |
| `fedify-sidecar/src/at-adapter/repo/AtRepoDiffBuilder.ts` | modified | Protocol read/CAR/wire contract candidate; manual diff and conformance |
| `fedify-sidecar/src/at-adapter/xrpc/AtXrpcServer.ts` | modified | Protocol read/CAR/wire contract candidate; manual diff and conformance |
| `fedify-sidecar/src/at-adapter/xrpc/routes/RepoDescribeRepoRoute.ts` | modified | Protocol read/CAR/wire contract candidate; manual diff and conformance |
| `fedify-sidecar/src/at-adapter/xrpc/routes/SyncGetRepoRoute.ts` | modified | Protocol read/CAR/wire contract candidate; manual diff and conformance |
| `fedify-sidecar/src/config/v6-config.ts` | modified | Wiring/build/config; do not merge wholesale |
| `fedify-sidecar/src/db/postgres.ts` | added | Separate feed/PostgreSQL feature; defer from AT integration |
| `fedify-sidecar/src/delivery/outbound-webhook.ts` | modified | AP delivery and bridge integration; must not regress APDM |
| `fedify-sidecar/src/delivery/outbox-intent-worker.ts` | modified | AP delivery and bridge integration; must not regress APDM |
| `fedify-sidecar/src/delivery/tests/OutboundWebhook.test.ts` | modified | AP delivery and bridge integration; must not regress APDM |
| `fedify-sidecar/src/delivery/tests/OutboxIntentWorker.test.ts` | modified | AP delivery and bridge integration; must not regress APDM |
| `fedify-sidecar/src/feed/OpenSearchHydrator.ts` | modified | Separate feed/PostgreSQL feature; defer from AT integration |
| `fedify-sidecar/src/feed/SearchFeedProvider.ts` | modified | Separate feed/PostgreSQL feature; defer from AT integration |
| `fedify-sidecar/src/feed/SearchHydrator.ts` | modified | Separate feed/PostgreSQL feature; defer from AT integration |
| `fedify-sidecar/src/feed/contracts.ts` | modified | Separate feed/PostgreSQL feature; defer from AT integration |
| `fedify-sidecar/src/feed/public-routes.ts` | added | Separate feed/PostgreSQL feature; defer from AT integration |
| `fedify-sidecar/src/index.ts` | modified | Wiring/build/config; do not merge wholesale |
| `fedify-sidecar/src/protocol-bridge/activitypub/translators/DirectMessageTranslator.ts` | modified | AP delivery and bridge integration; must not regress APDM |
| `fedify-sidecar/src/search/mappings/PublicContentMapping.ts` | modified | Separate feed/PostgreSQL feature; defer from AT integration |
| `fedify-sidecar/src/services/PostSyncWorker.test.ts` | added | Separate feed/PostgreSQL feature; defer from AT integration |
| `fedify-sidecar/src/services/PostSyncWorker.ts` | added | Separate feed/PostgreSQL feature; defer from AT integration |
| `fedify-sidecar/src/streams/redpanda-topic-governance.ts` | modified | Wiring/build/config; do not merge wholesale |
| `fedify-sidecar/src/utils/internalAuthority.ts` | modified | Wiring/build/config; do not merge wholesale |
| `fedify-sidecar/tsconfig.json` | modified | Wiring/build/config; do not merge wholesale |
| `input.json` | added | Debug or ad-hoc fixture; exclude |
| `ldp_create_debug.txt` | added | Debug or ad-hoc fixture; exclude |
| `memory` | modified | Existing unrelated submodule pointer — do not copy |

## Remaining G0 work

- [x] Recover immutable provider repository/source SHA from the otherwise broken parent Git-subproject pointer.
- [x] Run repeatable, isolated GitHub Actions source probe on both pinned commits without untrusted script execution; **17 JavaScript files passed `node --check`**. Read-only fetch bypasses unconfigured gitlink and leaves parent source unchanged.
- [x] Cross-compare full external branch with our actual federation `master`; enumerate and categorize all 57 changed paths.
- [x] Verify recovered provider uses a different, signed PLC genesis implementation from the external sidecar's legacy hash-based identity file.
- [x] Identify key existing overlaps in our ActivityPods `master` (keypair and signing APIs; protected identitybindings) to avoid redundant code.
- [ ] Run recovered provider exact-SHA **real tests**, confirm dependency trees/lockfiles, assess its embedded SemApps package vs active wrappers, and verify no sensitive checked-in fixture/debug material.
- [ ] Review all 57 changed paths for *semantic* collisions with recent master and open branches (path inventory alone is insufficient), record per-file SHA and candidate differences.
- [ ] Verify PLC genesis and key signatures independently against current specifications and a controllable test directory, plus real repository CAR/relay tests.
- [ ] Prove multi-replica state, signer/permission fencing and event-outbox failure recovery before any copy or activation.

**Decision: G0 is IN PROGRESS. Source-provenance blocker resolved; reproducibility and integration/acceptance blocker remains.**
