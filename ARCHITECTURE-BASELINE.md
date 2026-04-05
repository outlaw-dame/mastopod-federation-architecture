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

## Baseline

The architecture is a three-tier model.

1. Tier 1: ActivityPods Core
- ActivityPods is authoritative for local account state, pod data, WebID, inbox acceptance, and policy-bearing mutations.
- Private signing keys never leave ActivityPods.
- IdentityBinding is the canonical identity model conceptually owned by Tier 1, even when the sidecar keeps synchronized runtime copies for low-latency reads.

2. Tier 2: Federation And Protocol Runtime
- The `fedify-sidecar` is the standalone non-Moleculer protocol runtime.
- Redis Streams are used for transient work queues only.
- RedPanda is used for append-only event logs only.
- MRF runs in Tier 2 before accepted remote public content enters downstream public streams.
- The ATProto runtime is also Tier 2. It exposes XRPC routes, firehose surfaces, repo export, and native write paths for managed AT identities.

3. Tier 3: Query And Application Services
- OpenSearch, feed/query services, hydration, durable public streams, and media/query consumers are downstream consumers.
- Tier 3 is never the source of truth for federation, signing, or canonical identity.

## Current Runtime Shape

The current repo should be understood this way:

- ActivityPub remote HTTP federation is handled by the sidecar.
- Fedify is the ActivityPub server framework for AP-facing HTTP surfaces such as actor documents, WebFinger, NodeInfo, and future inbox delegation.
- The sidecar workers still own outbound delivery, inbound HTTP-signature verification, queue handling, and RedPanda publication until Fedify runtime delegation is fully cut over.
- ATProto support is native in this repo. The sidecar exposes `createSession`, `refreshSession`, `createRecord`, `putRecord`, `deleteRecord`, `getRepo`, `getRecord`, `listRecords`, `describeRepo`, `resolveHandle`, and `subscribeRepos`.
- The protocol bridge is an internal canonical projection layer, not a user-facing third-party bridge product. Its role is parity, projection, and loop-safe synchronization between co-equal native AP and AT surfaces.

## Canonical Responsibilities

### ActivityPods

- Owns signing authority for ActivityPub and managed ATProto identities.
- Owns canonical account lifecycle and authoritative local inbox handling.
- Owns the trust boundary for internal write surfaces.
- Emits or serves the identity projections that the sidecar syncs for runtime use.

### Fedify Sidecar

- Handles remote ActivityPub HTTP entry and exit paths.
- Enforces queueing, retry, rate limiting, idempotency, and shared-inbox optimization.
- Publishes public events to RedPanda and supplies downstream public-stream consumers.
- Serves ATProto XRPC and firehose functionality for managed identities.
- Applies MRF before public remote content is admitted to downstream streams.

### Protocol Bridge

- Converts protocol-specific inputs into canonical intents.
- Applies projection policy and provenance rules.
- Routes projected results into native ActivityPub or native ATProto write paths.
- Prevents projection loops with explicit ledgering and provenance markers.

## Canonical Data And Control Planes

### Redis Streams

Use Redis Streams only for transient work that is claimed, retried, ACKed, and retired.

Examples:

- outbound AP delivery jobs
- inbound AP processing envelopes
- pending retry state and delivery scheduling

### RedPanda

Use RedPanda only for durable event logs that support replay and multiple independent consumers.

Examples:

- local public ActivityPub stream
- remote public ActivityPub stream
- merged firehose
- AT commit log and AT identity/account topics
- tombstones and audit events

### OpenSearch

OpenSearch is a public-query projection. It is never an authority for identity, inbox state, or protocol correctness.

## Identity Baseline

- `IdentityBinding` is the canonical dual-protocol model.
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
- MRF runs before accepted remote public content enters public downstream streams.
- Public firehose/search consumers only consume content that has already crossed the Tier 2 trust boundary.
- The sidecar is pluggable at the ActivityPods core layer, not tied to any one app.
- The protocol bridge is internal parity infrastructure, not permission authority.
- Account links and `alsoKnownAs` values are discovery and verification inputs only, never authorization primitives.
- ATProto support is native in the runtime even when AP/AT parity uses canonical projection internally.
- Same-provider authoritative flows should stay on trusted internal routes whenever possible; public HTTP surfaces exist for federation, not for replacing internal authority.

## What “Built On Fedify” Means Here

In this repo, “built on Fedify” means:

- Fedify is the framework for the ActivityPub server surface.
- Fedify does not take over key custody.
- Fedify does not change the Redis-vs-RedPanda split.
- Fedify does not make ActivityPods non-authoritative.
- Fedify complements the sidecar workers and current migration seams; it does not justify reintroducing local-signing caches, RedPanda work queues, or public-route shortcuts into authoritative flows.

## Near-Term Convergence Targets

The current architecture still has a few migration seams that should be closed over time:

- finish Fedify runtime delegation for AP paths that are still owned by bespoke workers
- keep identity-verification state machines aligned with the canonical `IdentityBinding` model
- remove stale bridge-era assumptions where native AP or native AT write paths already exist
- keep historical design docs clearly subordinate to this baseline unless refreshed
