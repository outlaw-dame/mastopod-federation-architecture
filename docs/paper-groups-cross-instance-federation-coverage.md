# Paper Groups — Cross-Instance Federation Coverage and Compression

**Scope:** ActivityPods and the existing Fedify sidecar are separate runtime
authorities. This document is an evidence ledger, not a claim of production
Group interoperability or a proposal for an additional Group federation
service.

## Ownership and cost boundary

| Concern | Authoritative runtime | Status |
|---|---|---|
| Group identity, owner, invited/accepted/active/banned member state, SAI consent and visibility | ActivityPods settings TDB2 and provider | Group-specific live persistence/invitation acceptance incomplete |
| Local Pod inbox/LDP/WebACL persistence | ActivityPods/SemApps (APDM Tier 1) | Existing path; APDM Phase 11 performance remediation still open |
| Concrete local versus remote actor membership snapshot and `ap.delivery-plan.v1` production | ActivityPods | Existing APDM architecture; no live Group producer yet |
| Remote inbox/sharedInbox delivery URL, queue, retry, domain limits, HTTP signing request and dedup | Fedify Tier 2 | Existing general ActivityPub executor; synthetic Group boundary coverage added |
| Remote instance's membership moderation, Group semantics and inbox processing | Actual remote server | **Not validated** by the new synthetic tests |
| ATProto identity/protocol routing | Its separate verified authority | Not implied by Group ActivityPub delivery |

A sharedInbox does **not** mean all accounts on a domain consent to Group
membership. Only a remote endpoint independently known and authorized by
ActivityPods may be used. A shared inbox for a restricted/hidden Group may
not know how to route an activity addressed solely to a Group followers
collection. Before promotion, verify recipients are explicitly addressable
where required by each server; otherwise use the verified personal inbox.
Do not infer all members from a remote server's hostname, account follow,
or a Group's actor URI.

## Test evidence distinctions

The `PaperGroupsCrossInstanceBoundary.test.ts` checks the real APDM v1
parser and sidecar target normalization with synthetic local/remote actor
URIs, multiple distinct server domains, mixed personal/sharedInbox targets,
1,000 remote actors spread across 10 servers, 1,000 personal inboxes on
one server, an explicit 5,000-target raw webhook limit (5,001 rejects without truncation), malicious/forged authority, blind-address leakage and overlap
between local and remote recipients. Its results count **target endpoints**,
not successful remote HTTP deliveries.

Pre-existing Fedify interop campaigns exercise general ActivityPub
transport with Mastodon, GoToSocial, Akkoma and controlled test targets;
their PASS is not proof of Lemmy/PieFed/Mbin/Bonfire **Group semantics**.

Before marking Group production ready, run real provisioned local Group
actors and consenting members against remote **Lemmy, PieFed, Mbin,
Bonfire, Mastodon and GoToSocial** endpoints to the extent each supports
the relevant Group exchange, and record unsupported protocol features
explicitly. Required cases: public/restricted/private visibility, local
and remote joins/acceptance, remote moderation, edits/deletes, authorization
retraction, 1/10/100/1000 mixed member fan-out, same-domain sharedInbox
and per-user fallback, invalid signatures/SSRF, retries and 429/5xx,
time-out and SIGKILL replay, duplicate POST prevention, per-domain fairness,
ingress backpressure, signed bytes integrity and complete observability.

Measure Node CPU/RSS and GC, ActivityPods Moleculer actions, Fuseki HTTP
read/write requests, Redis Stream memory/decode CPU and job counts, actual
remote HTTP requests, bytes sent and request latency by destination domain.
No synthetic workload may be reported as externally delivered membership.

## Large Group transport blocker: bounded cross-page handoff

The existing raw outbound webhook defaults to
`OUTBOUND_WEBHOOK_MAX_TARGETS=5000`; the G2 provider planning kernel uses
at most 1,000 recipients **per page**. Neither constraint is a maximum
Group size, and simply raising either limit to 100,000 would create a
large in-memory envelope and excessive JSON hashing/queue overhead.

For a Group with 100,000 remotely hosted members, the provider must durably
stream verified membership pages and aggregate actual delivery destinations,
using the exact actor set, visibility and membership epoch. No group post may
execute until the complete snapshot has been sealed. Once sealed, each
activity+Group actor+destination must have a single stable durable delivery
identity, across pages and restarts; updates/retries must never replay the
same shared inbox once per page. A sealed multi-chunk handoff requires an
explicit mutually versioned producer/consumer protocol and ACK/replay
protection, **not** a fabricated `ap.delivery-plan.v1` input with omitted
actors or a sidecar-specific second queue.

Until this contract and mixed local/remote fault/load proof are complete,
the new 1k/5k synthetic tests are **not** evidence that a 100k-member Group
can be federated successfully.

## Compression / compatibility

Use the already evidenced codec per transport rather than a single
universal choice:

- **Redpanda event log:** native Zstandard level 1 on supported Node
  runtimes. The sidecar's codec registration preserves decoding of retained
  Zstd batches after producer rollback. When workers are mixed-version,
  the compatible fallback is GZIP; do not silently enable Zstd writes
  before all consumers can decode it.
- **Redis Stream ready payloads:** existing Brotli quality 0 versioned
  envelope with digest, bounded input/output and exact-envelope LRU cache.
  The writer flag remains **off by default** and must be rolled out after
  decoder support is available everywhere. The codec runs only when
  beneficial above the configured size threshold; no extra codec added.
- **HTTP ActivityPub:** preserve the exact immutable bytes that the signing
  authority signs. Wire-level transport compression requires its own
  interoperability and signature-coverage proof; do not precompress an
  Activity JSON body and expect remote implementations to understand it.
- **Provider TDB2 Group member index:** bounded, uncompressed, integrity-
  checked private JSON pages (max 32 KiB), with variable page packing for
  long actor URIs. Codec migration must be versioned and measured against
  actual actor URI entropy, index build/repair overhead and p95 latency.

## Merge/activation gates

This test-only sidecar PR cannot activate Group delivery. The Group
provider-owned actor, accepted membership snapshot, durable index delta and
Federation Delivery Plan handoff must exist and be interoperably proven
before any remote Group delivery flag is released. Do **not** add a second
Fedify queue, signer, delivery scheduler, actor rediscovery service or
unbounded per-member remote HTTP loop to satisfy the feature.
