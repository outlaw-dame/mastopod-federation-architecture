# External ATProto recovery: investigation, disposition, and acceptance gates

**State:** INVESTIGATION BLOCKED — source inventory substantially complete, provider-side review incomplete. **Created:** 2026-11-11.  
**Scope:** `Lawhacknifemi/mastopod-federation-architecture` branch `sh-mvp` vs our federation `master`, the ActivityPods `master`, and active identity/account PRs.  
**Purpose:** prevent a branch-wide merge, duplicate implementation, authority drift, security regressions, and unverifiable "completed" checkmarks.

> **Do not implement, cherry-pick, activate, or merge the external branch from this document alone.** The source-recovery gate (G0) is blocking. The checkboxes below are an evidence-driven integration backlog, *not* assertions that these features have been delivered.

## Source provenance and verified observations

- External repository: https://github.com/Lawhacknifemi/mastopod-federation-architecture/tree/sh-mvp  
  Head inspected: `e4d0bb74142afbaf4573d2f93e28028479d6b52d` (2026-10-28); 30 commits ahead of that repo's `master`; 57 changed paths, approximately +10,829/-101 lines from the GitHub compare API.
- External Git link `activitpod-aptoroto` at head points to commit `9f1c7fc3511487150ce458f025e9dc4477133221`; prior link `11108f070c7e29a4a86cff84d4f671a40bffcb46`. The accessible `.gitmodules` defines only `memory`, not `activitpod-aptoroto`. The external `Lawhacknifemi/activitypods` repository did **not** resolve either commit at review time. **Provider implementation, source repository URL, build and test coverage remain unverified**.
- For several common files, external `master` and our federation `master` have **identical blob SHAs**; `sh-mvp` changes those files. Confirmed paths: `AtRecordReader.ts`, `AtCarExporter.ts`, `AtFirehoseEventEncoder.ts`, `AtXrpcServer.ts`, `RepoDescribeRepoRoute.ts`, `SyncGetRepoRoute.ts`.
- No relevant GitHub Actions PR-triggered runs or commit status checks were available for the external head in the connector. **Not equivalent to a verified passing build**.
- Current architectural direction already exists in `ARCHITECTURE-BASELINE.md` and `docs/atproto-authority-convergence.md` (branch `docs/atproto-authority-convergence` at review time). This recovery work must *converge with* those decisions, not supersede them.
- ActivityPods `identitybindings.service.js` already models account/WebID/AP actor/DID/handle/PDS/key references. Active draft PR **#134** enforces new-account mandatory WebID=AP actor plus `did:plc` and initialized repo; draft **#138** aligns the nonactivated PostgreSQL account candidate. Neither is assumed merged or deployed.
- This is a **static source review**. No build, live PLC creation, signed-CAR verification, distributed workload, or external relay ingestion was executed in this investigation.

## Disposition matrix (preliminary until G0)

| External path/component | Observed difference / risk | Disposition | Acceptance evidence |
| --- | --- | --- | --- |
| `activitypods-integration/backend/services/atproto/identity.service.js` | Constructs `did:plc:` by truncated SHA-256 hex; no PLC genesis/operation publication | **REJECT implementation** | Real signed PLC genesis, resolution, rotation custody and idempotent compensation in Tier 1 |
| `activitypods-integration/backend/services/core/auth.js` | Signup catches DID provisioning error and returns signup success | **REJECT behavior** | Mandatory unified-account failure semantics, exactly-once reservation/recovery |
| `activitypods-integration/backend/services/atproto/bridge.service.js` | Process-local AP actor↔DID `Map`; independent bidirectional bridge | **REJECT authority/duplicate bridge** | Use protected identitybinding and one proven canonical projection pipeline with provenance |
| `activitypods-integration/backend/services/atproto/atproto.service.js` | Process-local repo map, Fuseki triples, sidecar/provider repo ambiguity | **REVIEW ONLY** | Provider-side source, ownership map, durable repo/MST/record recovery |
| `activitypods-integration/backend/services/atproto/utils/repo.js` | Unsigned commits (explicit TODOs); incomplete firehose CAR block payload | **REJECT as production PDS** | Signed verifiable commit chain and replayable complete CAR/MST |
| `activitypods-integration/backend/services/atproto/federation.service.js` | Additional WebSocket/firehose implementation, JWT fallback secret, local server did:web | **DO NOT MERGE** | Single controlled XRPC/firehose edge, no default secrets, correct service DID config |
| `activitypods-integration/backend/services/api.js` | Adds parallel public `/identity`, `/atproto`, `/bridge`, `/xrpc` entry points | **REJECT wholesale** | Route ownership and auth matrix; no direct public identity mutation |
| `activitypods-integration/backend/services/internal-social-api.service.js` | Master-token actor impersonation; explicitly disables OIDC route auth; actor-scoped token alternative | **SECURITY BLOCKER** | Verified capability/grant per actor/action, service authentication separately, deny-first revocation |
| `src/at-adapter/firehose/AtFirehoseEventEncoder.ts` | Converts commit/operation/prevData CID strings to actual IPLD CID links | **CANDIDATE: selective port** | CBOR golden vectors decoded by independent AT tooling; exact commit event acceptance |
| `src/at-adapter/repo/AtRecordReader.ts` | Adds `ActivityPodsAtRecordReader` fetching real values rather than placeholder records; swallows some failed reads as empty | **CANDIDATE: adapt** | Authenticated internal read API, typed errors, pagination, revision-consistent CID pinning, negative tests |
| `src/at-adapter/repo/AtCarExporter.ts` | Fetches full CAR bytes from `/atproto/checkout/:did` rather than empty mock CAR | **CANDIDATE: adapt** | Real signed CAR completeness, content hash integrity, streaming/bounded memory, fail closed for `since` |
| `src/at-adapter/repo/AtRepoDiffBuilder.ts` | Consumes real `carSliceBase64`, sets `prevData` | **CANDIDATE: adapt** | Multi-commit relay replay, previous revision, MST root and block correctness |
| `src/at-adapter/xrpc/routes/RepoDescribeRepoRoute.ts`, `SyncGetRepoRoute.ts` | Delegation toward provider's actual collections and CAR content | **CANDIDATE: adapt** | Standard XRPC semantics, handle↔DID proof, status/auth semantics |
| `src/db/postgres.ts`, `src/services/PostSyncWorker.ts` | New posting cache/engagement tables, polling worker; only process-local single-flight, no DB-level claims | **SEPARATE, DEFER** | Clarify authority, multi-replica `SKIP LOCKED`/lease + idempotency or existing queue, crash and retry tests |
| `src/feed/public-routes.ts` | ~1,789-line new feed API surface; overlaps query/search/product concerns | **SEPARATE FEATURE REVIEW** | Access/privacy, bounded query costs, cursor/index and load-test evidence |
| `src/index.ts`, Docker/Compose, scripts/config changes | Wires multiple new paths, PostgreSQL and local fixtures | **NO WHOLE-FILE REPLACEMENTS** | Precise wiring diff after component review, no competing bootstraps or leaked fixture flags |
| Debug/log/fixture additions (`ldp_create_debug.txt`, `sidecar_logs.txt`, `input.json`) | Not production components; debug output could expose sensitive data | **DO NOT IMPORT** | Inspect for secrets before any archival/copy |

**Did method clarification:** our *new locally managed unified users* require `did:plc` per PR #134. Existing external identities or **PDS service identifiers** may have different legitimate DID methods; do not conflate those with the managed user contract.

## Checkable investigation and integration gates

### G0 — source recovery and evidence baseline (**BLOCKS ALL PORTS**)
- [x] Identify the external `sh-mvp` head, compare against the external base, record file inventory.
- [x] Compare representative common-file blob SHAs with our federation `master` and identify changed vs unchanged code.
- [x] Inspect source for DID generation, signup, signing, CAR, bridging, API authorization, PostgreSQL sync and feed paths.
- [ ] Retrieve exact `activitpod-aptoroto` gitlink target `9f1c7fc3511487150ce458f025e9dc4477133221` **from an authenticated, verifiable repository/archive**, plus corresponding tests and parent history. Record repository URL, immutable commit and integrity evidence. If genuinely unavailable, record that and independently classify all claimed provider-side behavior **UNVERIFIED**, without inventing code.
- [ ] Confirm complete build graph and exact lockfiles/submodule mappings; inspect any private key, credential or user-data material accidentally present in debug artifacts *without copying secrets into the report*.
- [ ] Audit all **57 changed paths** against current `master`, open AT-related branches/PRs and ActivityPods active identity/provisioning PRs. Produce a complete SHA/file/feature collision map, not just the representative entries above.
- [ ] Capture exact-head isolated build/test results for source that can be built, with explicit environment and test logs.
- [ ] Record go/no-go outcome and freeze source refs for integration; G0 closes only if provider-side provenance is resolved or a formally accepted missing-source disposition is documented.

### G1 — authority boundaries, identity and durable lifecycle
- [ ] Verify one local account owns its HTTPS WebID (= AP actor), managed `did:plc`, handle, initialized PDS repo and three key roles (AP signing, AT commit, PLC rotation).
- [ ] Ensure signed PLC operation creation and verification against the PLC directory (not shape-only DID generation). Test replays, collision, key rotation and domain/handle changes.
- [ ] Align with ActivityPods PR #134 and #138 **by exact head and latest review**, not by stale assumptions; preserve protected RDF identitybindings and nonactivated PostgreSQL candidate until explicit migration.
- [ ] Implement/prove durable signup state machine: crash before/after PLC submission and PDS init, concurrent same-handle signups, immutable identity reconciliation, account disable/delete/export, no orphan DID/key.
- [ ] Verify multi-replica Solid bootstrap and actual OIDC/SAI readiness independently from AT account success.

### G2 — provider-owned ATProto repository
- [ ] Determine whether recovered provider source contains correct production record/MST/commit/CAR/PLC logic; disposition each component.
- [ ] Establish one authoritative Tier-1 repository writer; sidecar Redis must be reconstructable cache, never sole repo state.
- [ ] Test CID-addressed DAG-CBOR blocks, MST mutations, signed commits, real CAR full and incremental semantics, repository enumeration/status/describe, blob storage.
- [ ] Prevent repo-state/event split via transactional outbox or durable commit-history reconciliation; prove restart/outage replay and no lost events.

### G3 — XRPC, OAuth and edge interoperability
- [ ] For each changed XRPC route/reader/exporter, diff against our current implementation and select one authority path; no parallel servers.
- [ ] Golden-vector/interoperability tests for CBOR CID links, CAR, subscribeRepos cursor/sequence, relay backfill, handle-to-DID resolution and negative replies.
- [ ] Confirm OAuth/session/DPoP/grant model and service key custody; no master-token substitute for user grants.
- [ ] Stress bounded pagination/export/backpressure and remove fixture defaults from release configuration.

### G4 — AP↔AT canonical projection
- [ ] Identify only one native AP and one native AT write path; canonical translation must not create additional protocol authorities.
- [ ] Test AP-only, AT-only, dual, edits, deletes, likes, reposts, replies, private posts, blocks, provenance and opt-in policy with no double-publication or infinite reflection.
- [ ] Verify durable idempotency across replay, multi-replica concurrency, out-of-order events and restarts.

### G5 — security, scaling and cost
- [ ] Remove/deny shared master-token arbitrary-actor mutation path; demonstrate valid scoped grants and immediate SAI/consent revocation.
- [ ] Test SSRF, SPARQL/JSON-LD injection, PDS/DID resolution, private media and cross-user/tenant IDOR.
- [ ] Review legacy plaintext/debug logging and exposure of secrets or sensitive Pod content.
- [ ] Multi-replica pressure tests on Jena/Fuseki and PostgreSQL: bounded reads/writes, DB row claims, lock contention, queue amplification, cache misses, retries/backoff/jitter, rate limits, recovery, low-cost indexes/pooling.

### G6 — final exact-head release acceptance
- [ ] Component tests and negative tests passing at each PR's exact head; full integration and distributed failure-injection tests passing.
- [ ] External standards/relay/AppView conformance evidence with signed real managed DID and repo (not local fixture).
- [ ] Protected production workflows green, review threads resolved, docs updated and no unrelated feature drift.
- [ ] Separate human-reviewed activation/migration/rollback plan; release gates explicitly approve a single canonical writer.
- [ ] **Only then** mark integration complete; no checkbox is satisfied merely because a PR was opened or merged.

## Integration protocol for every candidate

1. Open a narrowly scoped PR targeting our repository's current base, referencing this document and source blob SHA.
2. Record **why** it is missing and how it differs from existing source. If equivalent, label **ALREADY IMPLEMENTED** with tests and **do not copy**.
3. State authority owner, failure/recovery behavior, latency/scale budget and privacy/consent impact.
4. Add executable positive, negative, concurrent and recovery tests proportional to the risk. Validate wire output independently for protocol changes.
5. Link exact-head green CI runs, source files, reviewer resolution and acceptance artifacts before moving a gate checkbox.
6. Do not merge stacked PRs or activate runtime paths with incomplete prerequisites. Rollback is explicit; no duplicate worker/writer.

## Status bookkeeping

| Stage | Status | Evidence |
| --- | --- | --- |
| Initial external-sidecar survey | **Partial review complete** | External compare 30 commits/57 files and cited paths above |
| Exact provider subproject recovery | **BLOCKED / source missing** | Inconsistent `.gitmodules`; `9f1c7fc…` not resolved in accessible developer ActivityPods repo |
| Current-code overlap map | **Partial** | Representative blob SHA comparisons; full 57-path map pending |
| Production DID/PLC signing verification | **NOT TESTED** | External hash-based DID implementation invalid; provider source unavailable |
| Integration coding | **NOT STARTED** | No external code copied |
| Production activation | **NOT AUTHORIZED** | No migration or runtime cutover |

## Source links

- External branch: https://github.com/Lawhacknifemi/mastopod-federation-architecture/tree/sh-mvp
- External head: https://github.com/Lawhacknifemi/mastopod-federation-architecture/commit/e4d0bb74142afbaf4573d2f93e28028479d6b52d
- Current federation repo: https://github.com/outlaw-dame/mastopod-federation-architecture
- ActivityPods identity implementation: https://github.com/outlaw-dame/activity-pods/blob/master/pod-provider/backend/services/identitybindings.service.js
- Mandatory unified identity PR: https://github.com/outlaw-dame/activity-pods/pull/134
- PostgreSQL unified identity candidate PR: https://github.com/outlaw-dame/activity-pods/pull/138
- Existing authority convergence: https://github.com/outlaw-dame/mastopod-federation-architecture/tree/docs/atproto-authority-convergence
- Specifications: https://atproto.com/specs/did-plc ; https://atproto.com/specs/repository ; https://atproto.com/specs/xrpc ; https://solid.github.io/solid-oidc/

**Maintenance rule:** change gate status only with verifiable link(s) and tested immutable SHA. If evidence is missing, use BLOCKED/NOT TESTED; do not imply completion.
