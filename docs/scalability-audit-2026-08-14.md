# Scalability audit — 2026-08-14

This audit was performed while APDM Phase 8 real local-delivery measurements were running. Findings are deliberately separated from the APDM local fan-out optimization sequence so measurement-sensitive work is not changed prematurely.

## Safe independent finding: Fedify Redis KV list N+1 reads

`fedify-sidecar/src/federation/FedifyKvAdapter.ts` keeps key enumeration bounded with Redis `SCAN`, but the previous implementation followed every returned key with an individually awaited `GET`. For `K` keys, enumeration therefore required approximately `ceil(K / SCAN_COUNT)` `SCAN` commands plus up to `K` sequential value-read round trips.

The fix in this branch retains the same `SCAN` page size, namespace/prefix behavior, key decoding, JSON parsing, expiry race handling, and async-iterator semantics, but retrieves each scan page with one `MGET`. Command count becomes approximately `2 * ceil(K / SCAN_COUNT)` rather than `K + ceil(K / SCAN_COUNT)`.

This is independent of ActivityPods local-delivery concurrency, metadata batching, persistence batching, canonical bridge convergence, and shared-inbox work, so it does not pre-empt APDM Phases 9–14.

## Confirmed finding intentionally not changed in this branch: ActivityPods identity binding scans

Current ActivityPods `identitybindings.getByDid`, `getByHandle`, and incremental `list` first materialize all `AtprotoIdentityBindingIndex` rows from Fuseki and then select/filter/sort in JavaScript. Exact identity lookups and every identity-warmup poll therefore scale with total provider account count rather than the requested result size.

This should be fixed in ActivityPods on a separate branch by pushing exact predicates and cursor/order/limit constraints into SPARQL while preserving the current LDP fallback and cursor semantics. It is independent of the Phase 8 local-delivery measurement path.

## Confirmed finding to phase deliberately: domain-filtered follower synchronization

The ActivityPods internal follower-sync endpoint has an efficient cursor-based SPARQL path for normal paging. Its domain-filtered path, however, materializes the full followers collection through `activitypub.collection.getPartialCollection` and filters by host in JavaScript. That is O(total followers) for a domain-specific synchronization request on a high-follower actor.

Because this behavior interacts directly with collection-synchronization/shared-inbox semantics, it should be addressed alongside the appropriate APDM follower/shared-inbox work rather than opportunistically changing it while Phase 8 is in flight.

## Audited paths with no immediate unbounded issue found

- Federation outbound delivery already has explicit global and per-domain concurrency controls, queue-residence bounds, retry/DLQ handling, and bounded not-before behavior.
- Feed hydration uses `p-limit`, and hydration requests are schema-capped at 100 items.
- Identity warmup HTTP fetches are bounded to 500 items per poll and use bounded retry/backoff; its backend query shape, rather than the sidecar fetch bound, is the dominant scale defect found in that path.
