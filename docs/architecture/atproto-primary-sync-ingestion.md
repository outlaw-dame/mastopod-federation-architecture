# ATProto external ingestion: one source, one trust boundary

## Decision

Paper's preferred production external ATProto ingress is the **Sync v1.1**
`com.atproto.sync.subscribeRepos` firehose, using the existing
`AtExternalFirehoseBootstrap` / commit-signature, MST-inversion and DID
verification path. This is different from the **local** `AtFirehoseRuntime`,
which publishes Paper's own PDS changes; do not disable local publication.

`ENABLE_AT_EXTERNAL_FIREHOSE=true` selects the verified external consumer.
`ENABLE_AT_JETSTREAM=true` selects the alternative unsigned JSON subscriber.
Both enabled simultaneously is a startup error **in every environment**.
Both disabled remains valid for instances that do not ingest external AT data.
No silent fallback from a broken verified firehose to unsigned Jetstream.
Jetstream remains confined to `at.jetstream.unverified.v1` and is never
a substitute for verified commit processing.

An explicitly requested verified source must have at least one configured
endpoint, a commit verifier, and a successfully started runtime; otherwise
provider startup fails. Unverified Jetstream does **not** trigger canonical
event logging, notifications, or the trusted AT→AP protocol bridge.

This process-local guard does not by itself prevent a separately configured
second deployment from running another source. A production fleet must use
one deployment-level configuration source, restrict producer ACLs by mode,
and audit all replicas during rollout. Do not grant Jetstream staging
credentials permission to publish to `at.ingress.v1`.

## Sync v1.1 requirements

- Preserve signed v3 repository commit verification, MST inversion and per-DID
  commit ordering before canonical publication.
- Handle `#commit`, `#sync`, `#identity`, `#account`, and `#info` events
  according to the current Sync and Event Stream specifications.
- Treat `#sync` as a resynchronization boundary. A broken chain requires a
  verified authoritative `getRepo` rebuild; never silently accept an
  out-of-order or unverifiable commit.
- Persist source-scoped cursor checkpoints **after durable broker acceptance**,
  replay inclusively and deduplicate, and never reuse a relay cursor across
  different relay authorities. Do not silently begin live tail on lost cursor
  when lossless external ingestion is required.
- Apply WSS, no untrusted redirects, bounded CBOR frames, bounded in-flight
  publishes, heartbeat cleanup, capped reconnect with jitter, bounded DID
  resolution and DNS/SSRF protections.
- Measure actual sustained p95/p99 commit verification and delivery, heap/RSS
  retention, broker lag, replay amplification, retry rate, Redis cursor
  persistence and CPU/memory/network cost in a mixed workload.

## Remaining release boundaries

The external source policy is configuration correctness, **not** evidence that
the current firehose consumer passes these production capacity and recovery
checks. The external raw-consumer path requires separate reconciliation of
async WebSocket frame concurrency, shutdown/restart, cursor barriers and
broker backpressure before a production SLA can be claimed.

The ActivityPods managed repository and Solid-OIDC/SAI production gates remain
separate and must not be opened as a side effect of this source-selection change.

Primary specifications:
- https://atproto.com/specs/sync
- https://atproto.com/specs/event-stream
- https://atproto.com/blog/relay-updates-sync-v1-1
- https://atproto.com/blog/relay-rollout
- https://bsky.network/docs/jetstream/
