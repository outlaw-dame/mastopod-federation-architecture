# ATProto Authority Convergence

**Status:** Architecture convergence target; current sidecar implementation remains transitional until the corresponding ActivityPods/SemApps ATProto middleware is integrated.

## Purpose

This document separates two concepts that older V6/V6.5 implementation work sometimes conflates:

1. **ATProto network/runtime surfaces** — XRPC HTTP, OAuth/session edge behavior, public repo sync endpoints, subscribeRepos/firehose delivery, external PDS interoperability, ingress verification, protocol bridging.
2. **Authoritative managed ATProto repository state** — DID/account binding, repository records, MST/commit state, record CIDs, repository revision/head, durable CAR blocks, and signing-key authority.

The long-term architecture keeps the first category at the protocol/network edge where appropriate, but places the second category with ActivityPods/SemApps in Tier 1, parallel to ActivityPub middleware and the user's Pod authority.

This is an authority-boundary clarification, not a claim that the unpublished/unmerged SemApps ATProto middleware is already present on `master`.

## Current `master` implementation

Today the sidecar still constructs a local managed-AT repository stack when XRPC is enabled:

- `RedisIdentityBindingRepository`
- `RedisAtAliasStore`
- `RedisAtprotoRepoRegistry`
- `DefaultAtRecordReader`
- `DefaultAtCarExporter`
- `DefaultAtCommitBuilder`
- `DefaultAtCommitPersistenceService`
- `DefaultAtProjectionWorker`
- `DefaultCanonicalClientWriteService`
- `DefaultAtWriteGateway`
- `RedisAtWriteResultStore`

The XRPC write path is currently:

```text
XRPC create/put/deleteRecord
        |
        v
DefaultAtWriteGateway
        |
        v
CanonicalMutationEnvelope
        |
        v
DefaultCanonicalClientWriteService
        |
        v
DefaultAtProjectionWorker
        |
        +--> commit builder/signing request
        |
        +--> sidecar persistence/alias/repo state
        |
        +--> at.commit.v1 / at.egress.v1
```

This is useful transitional runtime work, but it is not the desired final authority boundary.

Several current implementations explicitly demonstrate that this layer is transitional rather than a production repository authority:

- `DefaultAtCommitPersistenceService` says its durable repo store is "mocked for now", writes repo head/revision to Redis, and synthesizes mock record CIDs.
- `DefaultAtCarExporter` emits a CAR header/root but does not yet write the commit, MST nodes, or record blocks.
- `DefaultAtRecordReader` reconstructs records from alias metadata and returns placeholder record values rather than authoritative stored records.
- `RedisAtprotoRepoRegistry` gives repository registry entries a 30-day TTL, which is appropriate for reconstructable runtime/cache state but not as the sole authority for a managed PDS repository.

These are migration signals. They should not be completed into a second independent authoritative repository if Tier 1 already owns or is gaining that responsibility.

## Target authority model

The intended model is:

```text
                         TIER 1 — AUTHORITY
                    ActivityPods / SemApps / Pod

              Canonical account / WebID / identity binding
                              |
              +---------------+----------------+
              |                                |
              v                                v
      ActivityPub middleware             ATProto middleware
      actor/inbox/outbox/etc.             DID/repo/records
              |                           MST/commit state
              |                                |
              +---------------+----------------+
                              |
                    authoritative Pod state
                              |
                AP key / AT commit key /
                    AT rotation key custody

                              |
                    trusted internal contracts
                              v

                    TIER 2 — PROTOCOL EDGE
                    Fedify / sidecar runtime

              +---------------+----------------+
              |                                |
              v                                v
       remote AP federation             AT network surfaces
       HTTP/signature edge              XRPC transport/OAuth
                                        sync/firehose edge
              |                                |
              +---------------+----------------+
                              |
                              v
                         Redis work state
                     Redpanda durable events
```

### Tier 1 owns

For a locally managed AT identity, ActivityPods/SemApps should be authoritative for:

- canonical account ↔ WebID ↔ ActivityPub actor ↔ AT DID binding;
- managed-vs-external PDS ownership state;
- AT repository lifecycle;
- repository records and their real CIDs;
- MST/tree state;
- commit object, revision, previous commit and repository head;
- durable repository blocks/CAR reconstruction inputs;
- commit and rotation private keys;
- authorization/policy-bearing mutations that decide whether a local account may write.

### Tier 2 owns

The sidecar remains appropriate for:

- Internet-facing XRPC transport where deployment chooses to expose it there;
- AT OAuth protocol-edge behavior and external-client interoperability;
- `subscribeRepos`/firehose serving;
- external PDS routing and proxying for externally managed identities;
- external AT firehose/Jetstream intake and verification;
- protocol translation/canonical projection orchestration;
- Redpanda publication/consumption at the network/event edge;
- low-latency reconstructable caches and correlation state in Redis;
- network rate limiting, retries, circuit breaking and other operational coordination.

The sidecar may cache a projection of Tier-1 repo/identity state, but cache loss must not destroy the user's repository.

## Redis and Redpanda under the target model

This convergence does not change the infrastructure split.

### Redis

Redis remains operational state, not repository authority:

- work queues;
- retry/backoff state;
- request/result correlation;
- worker leases and distributed locks;
- rate limits;
- idempotency markers;
- session/runtime state where explicitly designed;
- identity/repository caches that can be reconstructed from Tier 1;
- firehose cursors/buffers where loss/rebuild semantics are defined.

A Redis key such as a repo-head cache may remain useful after convergence, but Tier 1 must be able to repopulate it.

### Redpanda

Redpanda remains the durable replayable event plane:

- `at.commit.v1` — a real committed repository fact emitted after Tier-1 persistence succeeds;
- `at.identity.v1`;
- `at.account.v1`;
- external verified AT ingress events;
- ActivityPub Stream 1 / Stream 2 / merged firehose;
- `canonical.v1` semantic convergence;
- audit/lifecycle/domain events.

Redpanda is not the AT repository itself. A replayable `at.commit.v1` event does not substitute for the authoritative MST, commit block and record blocks required to serve a managed repository correctly.

## Desired managed AT write flow

The converged local write path should become conceptually:

```text
AT client
   |
   v
XRPC network surface
   |
   v
trusted Tier-1 AT write contract
   |
   v
ActivityPods/SemApps ATProto middleware
   |
   +--> authorize against canonical local account
   +--> mutate authoritative repo records/MST
   +--> build real commit/rev/CIDs
   +--> sign with Tier-1 key custody
   +--> persist atomically/recoverably inside Pod authority
   |
   v
committed result
   |
   +--> XRPC response
   |
   +--> at.commit.v1 / at.identity.v1 / at.account.v1 as applicable
             |
             v
          Redpanda
             |
      +------+------+----------------+
      |             |                |
      v             v                v
  firehose      canonical         search/etc.
```

The event is emitted because the repository commit happened. The event must not be the only place the repository exists.

## Protocol bridge implications

The canonical layer remains valuable after authority convergence.

It should not become a substitute repository or make one protocol authoritative over the other.

```text
ActivityPub native event ----+
                             |
                             v
                      canonical intent
                             ^
                             |
ATProto native event --------+
```

For AP → AT projection, the projector should eventually invoke the same Tier-1 managed AT write primitive used by native XRPC clients rather than maintaining a second sidecar-only repository path.

For AT → AP projection, the projector should invoke the authoritative ActivityPods/SemApps AP ingress/write primitive and then use APDM/Fedify only for remote network execution.

This provides one native authority path per protocol and keeps canonical translation as semantic parity infrastructure.

## Native AT streams remain first-class

`canonical.v1` does not replace native AT events.

The desired event topology keeps both:

```text
native AT repository state
        |
        +--> at.commit.v1
        +--> at.identity.v1
        +--> at.account.v1
        |
        +--> canonical translation when semantically applicable
                    |
                    v
               canonical.v1
```

Consumers that need exact AT semantics should consume native AT topics. Consumers that need protocol-neutral social semantics should consume `canonical.v1`.

The same principle applies to ActivityPub Stream 1, Stream 2 and the merged AP firehose.

## Component disposition guide

When the SemApps ATProto middleware is available for integration, current sidecar components should be reviewed using this classification rather than deleted wholesale.

| Current sidecar component | Target disposition |
| --- | --- |
| XRPC HTTP/Fastify bridge | **Keep/adapt** as protocol edge if deployment retains sidecar XRPC |
| OAuth/client interoperability | **Keep** at network/runtime edge where appropriate |
| external-PDS read/write gateway | **Keep** for externally managed identities |
| external firehose/Jetstream intake | **Keep** |
| `AtFirehoseRuntime` | **Keep/adapt** to consume real Tier-1-produced native events |
| Redpanda AT publishers/consumers | **Keep** |
| canonical translators/projectors | **Keep/adapt** to call authoritative native write contracts |
| Redis identity binding repository | **Downgrade to cache/projection** of Tier-1 identity authority |
| Redis repo registry | **Downgrade to reconstructable cache or remove** |
| Redis alias store | **Review**; keep only derived cross-protocol alias/projection metadata, not repository authority |
| sidecar commit builder | **Replace for local managed repos** with Tier-1 repo commit primitive; may remain in isolated fixtures/tests |
| `DefaultAtCommitPersistenceService` | **Replace/remove for local managed repos** |
| `DefaultAtRecordReader` | **Replace/adapt** to Tier-1 authoritative record-read contract |
| `DefaultAtCarExporter` | **Replace/adapt** to Tier-1 authoritative CAR/repo export contract |
| sidecar projection worker | **Split responsibilities**: semantic serialization/projection may remain, authoritative repo mutation moves Tier 1 |
| Redis write-result store | **Keep if needed** as operational correlation when writes cross process boundaries |

## Migration requirements

Do not remove the current sidecar managed-repo implementation until all of the following are true:

1. The SemApps ATProto middleware source is available on a reviewable branch.
2. Identity/repository ownership contracts are versioned and tested across both repos.
3. Native `createRecord`, `putRecord` and `deleteRecord` use the Tier-1 write primitive.
4. AP → AT projection uses that same write primitive.
5. `getRecord`, `listRecords`, `describeRepo`, `getLatestCommit` and `getRepo` read authoritative Tier-1 repository state.
6. Real record CIDs, commit CIDs, MST state and CAR blocks survive restart and cache loss.
7. `at.commit.v1` is emitted only after authoritative persistence succeeds and is replay-safe downstream.
8. `subscribeRepos` serves events derived from those real committed events.
9. Redis loss does not destroy a managed repository or identity binding.
10. External-PDS mode remains correctly separated and fail-closed from local-managed write paths.
11. Cross-protocol loop prevention and canonical provenance remain intact.
12. Interop tests are run against an official/compatible AT relay/client implementation before the transitional authority is retired.

## What not to do during cleanup

- Do not "finish" the mock sidecar repo persistence into a second authority before comparing it with the SemApps middleware.
- Do not move AT private keys into the sidecar.
- Do not use Redpanda as the repository datastore.
- Do not make Redis the only durable source for managed repository state.
- Do not route native local writes through the canonical event log merely to force symmetry with ActivityPub.
- Do not delete native AT topics in favor of `canonical.v1`.
- Do not merge stale AT branches wholesale over the current APDM/canonical architecture.

## Relationship to current baseline

`ARCHITECTURE-BASELINE.md` describes the runtime that exists on current `master`. This document describes the authority convergence target that should guide integration of the unmerged ActivityPods/SemApps ATProto middleware.

Until that integration lands, code review must distinguish **current runtime truth** from **target authority ownership**. The target is not permission to claim that current `master` already has a Pod-authoritative AT repository.