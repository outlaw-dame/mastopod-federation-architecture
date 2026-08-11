# Mastopod Federation Architecture Baseline

This document is the single authoritative architecture baseline for this repository as of April 4, 2026.

If another document disagrees with this one, treat this document as current and treat the older document as historical context unless it is brought back into sync.

## Scope

This repo is the federation and dual-protocol runtime around ActivityPods. It owns:

- the Fedify-based ActivityPub sidecar
- the ATProto XRPC/PDS runtime
- the canonical protocol projection layer used for AP/AT parity
- Redis/RedPanda/OpenSearch integration
- ActivityPods integration contracts and companion glue

This repo does not replace ActivityPods core. ActivityPods remains the authority for pod data, canonical account identity, permission enforcement, and signing-key custody.

> **ATProto authority convergence:** current `master` still contains a sidecar-local managed
> repository implementation, but that is a transitional runtime boundary rather than the
> desired long-term repository authority. The target architecture places authoritative
> managed ATProto identity/repository state in ActivityPods/SemApps Tier 1, parallel to
> ActivityPub middleware, while retaining appropriate XRPC/network/firehose behavior at
> the protocol edge. See `docs/atproto-authority-convergence.md`. This target does not
> imply that the unmerged SemApps ATProto middleware is already present on `master`.

## Baseline

The architecture is a three-tier model.

1. Tier 1: ActivityPods Core
- ActivityPods is authoritative for local account state, pod data, WebID, inbox acceptance, and policy-bearing mutations.
- Private signing keys never leave ActivityPods.
- IdentityBinding is the canonical identity model conceptually owned by Tier 1, even when the sidecar keeps synchronized runtime copies for low-latency reads.
- Target convergence also places authoritative managed ATProto repository state in Tier 1; the current sidecar-local managed repository stack remains transitional until that integration is complete.

2. Tier 2: Federation And Protocol Runtime
- The `fedify-sidecar` is the standalone non-Moleculer protocol runtime.
- Redis Streams are used for transient work queues only.
- RedPanda is used for append-only event logs only.
- MRF runs in Tier 2 before accepted remote public content enters downstream public streams.
- The ATProto network/runtime surface is also Tier 2. Current `master` additionally contains transitional managed-repository implementation code here; target ownership is defined in `docs/atproto-authority-convergence.md`.

3. Tier 3: Query And Application Services
- OpenSearch, feed/query services, hydration, durable public streams, and media/query consumers are downstream consumers.
- Tier 3 is never the source of truth for federation, signing, or canonical identity.

## Current Runtime Shape

The current repo should be understood this way:

- ActivityPub remote HTTP federation is handled by the sidecar.
- Fedify is the ActivityPub server framework for AP-facing HTTP surfaces such as actor documents, WebFinger, NodeInfo, and future inbox delegation.
- The sidecar workers still own outbound delivery, inbound HTTP-signature verification, queue handling, and RedPanda publication until Fedify runtime delegation is fully cut over.
- ATProto support is native in this repo. The sidecar exposes `createSession`, `refreshSession`, `createRecord`, `putRecord`, `deleteRecord`, `getRepo`, `getRecord`, `listRecords`, `describeRepo`, `resolveHandle`, and `subscribeRepos`.
- On current `master`, managed AT writes still pass through sidecar-local repository/projection components. Treat that as current runtime truth, not as the final authority boundary.
- The protocol bridge is an internal canonical projection layer, not a user-facing third-party bridge product. Its role is parity, projection, and loop-safe synchronization between co-equal native AP and AT surfaces.

## Canonical Responsibilities

### ActivityPods

- Owns signing authority for ActivityPub and managed ATProto identities.
- Owns canonical account lifecycle and authoritative local inbox handling.
- Owns the trust boundary for internal write surfaces.
- Emits or serves the identity projections that the sidecar syncs for runtime use.
- Owns app-mediated account provisioning decisions. Approved apps may initiate
  signup, but ActivityPods remains the issuer of accounts, Pods, WebIDs, actors,
  grants, and managed protocol keys.
- Target convergence extends Tier-1 authority to managed ATProto repository records, MST/commit state, repository heads/revisions, and durable repo export inputs.

### Fedify Sidecar

- Handles remote ActivityPub HTTP entry and exit paths.
- Enforces queueing, retry, rate limiting, idempotency, and shared-inbox optimization.
- Publishes public events to RedPanda and supplies downstream public-stream consumers.
- Serves ATProto XRPC and firehose functionality for managed identities.
- Applies MRF before public remote content is admitted to downstream streams.
- May maintain reconstructable identity/repository caches and operational correlation state, but target convergence does not make those caches the durable managed-repository authority.

### Protocol Bridge

- Converts protocol-specific inputs into canonical intents.
- Applies projection policy and provenance rules.
- Routes projected results into native ActivityPub or native ATProto write paths.
- Prevents projection loops with explicit ledgering and provenance markers.
- After AT authority convergence, AP→AT projection should use the same Tier-1 native AT write primitive as locally managed XRPC writes rather than a second sidecar-only repository path.

## Canonical Data And Control Planes

### Redis Streams

Use Redis Streams only for transient work that is claimed, retried, ACKed, and retired.

Examples:

- outbound AP delivery jobs
- inbound AP processing envelopes
- pending retry state and delivery scheduling

Redis may also hold reconstructable runtime caches, locks, idempotency markers,
correlation results, cursors, rate-limit state, and session/runtime state where
explicitly designed. Redis loss must not destroy authoritative Pod or managed
AT repository data.

### RedPanda

Use RedPanda only for durable event logs that support replay and multiple independent consumers.

Examples:

- local public ActivityPub stream
- remote public ActivityPub stream
- merged firehose
- AT commit log and AT identity/account topics
- canonical semantic events
- tombstones and audit events

Native AP/AT event logs and `canonical.v1` are complementary. `canonical.v1`
does not replace protocol-native streams, and RedPanda does not replace the
underlying authoritative AP/AT data stores.

### OpenSearch

OpenSearch is a public-query projection. It is never an authority for identity, inbox state, repository state, or protocol correctness.

## Identity Baseline

- `IdentityBinding` is the canonical dual-protocol model.
- `canonicalAccountId` is the stable internal account subject. Current WebID,
  ActivityPub actor URI, ATProto DID, and ATProto handle are identity surfaces
  bound to that subject, not substitutes for it.
- `did:plc` is the primary managed ATProto identity method.
- `did:web` is supported where operationally appropriate.
- Managed ATProto identities use three separate key slots:
  - ActivityPub signing key
  - ATProto commit-signing key
  - ATProto rotation key
- External PDS mode is supported, but it must fail closed in managed-only code paths.

## Invariants

- ActivityPods remains the signing authority. Keys never leave it.
- Redis Streams are work queues. RedPanda is the event log.
- Redis-only state must be disposable/reconstructable unless explicitly designated durable operational state; it must not become the sole authority for a managed user repository.
- MRF runs before accepted remote public content enters public downstream streams.
- Public firehose/search consumers only consume content that has already crossed the Tier 2 trust boundary.
- The sidecar is pluggable at the ActivityPods core layer, not tied to any one app.
- The protocol bridge is internal parity infrastructure, not permission authority.
- Account links and `alsoKnownAs` values are discovery and verification inputs only, never authorization primitives.
- App-mediated signup must be capability-gated through
  `provider.account.provisioning`; apps never call internal provisioning or
  signing routes directly.
- ATProto support is native even when AP/AT parity uses canonical projection internally.
- Native AT topics remain first-class protocol event streams; they are not replaced by `canonical.v1`.
- Same-provider authoritative flows should stay on trusted internal routes whenever possible; public HTTP surfaces exist for federation, not for replacing internal authority.

## What “Built On Fedify” Means Here

In this repo, “built on Fedify” means:

- Fedify is the framework for the ActivityPub server surface.
- Fedify does not take over key custody.
- Fedify does not change the Redis-vs-RedPanda split.
- Fedify does not make ActivityPods non-authoritative.
- Fedify complements the sidecar workers and current migration seams; it does not justify reintroducing local-signing caches, RedPanda work queues, or public-route shortcuts into authoritative flows.

## Near-Term Convergence Targets

The current architecture still has migration seams that should be closed over time:

- finish Fedify runtime delegation for AP paths that are still owned by bespoke workers
- integrate/reconcile the unmerged ActivityPods/SemApps ATProto middleware against `docs/atproto-authority-convergence.md` before investing further in sidecar-local managed-repository authority
- keep identity-verification state machines aligned with the canonical `IdentityBinding` model
- make Redis repo/identity state reconstructable from Tier-1 authority after AT convergence
- preserve native `at.commit.v1`, `at.identity.v1`, `at.account.v1` and AP public streams alongside `canonical.v1`
- remove stale bridge-era assumptions where native AP or native AT write paths already exist
- keep historical design docs clearly subordinate to this baseline unless refreshed