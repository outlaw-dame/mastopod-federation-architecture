# Paper Groups — Cross-Instance Federation Coverage and Compression

**Scope:** ActivityPods and the existing Fedify sidecar are separate runtime
authorities. This document is an evidence ledger, not a claim of production
Group interoperability or a proposal for an additional Group federation
service.

## Ownership and cost boundary

| Concern | Authoritative runtime | Status |
|---|---|---|
| Group identity, owner, invited/accepted/active/banned member state, SAI consent and visibility | ActivityPods provider remains the authority; existing protected Jena/Solid paths are not yet cut over to the planned canonical PostgreSQL Group control plane | PostgreSQL Group candidate and consent proofs are non-activated; live migration, distributed revocation and invitation acceptance remain blocked |
| Local Pod inbox/LDP/WebACL persistence | ActivityPods/SemApps (APDM Tier 1) | Existing path; APDM Phase 11 performance remediation still open |
| Concrete local versus remote actor membership snapshot and `ap.delivery-plan.v1` production | ActivityPods | Existing APDM architecture; no live Group producer yet |
| Remote inbox/sharedInbox delivery URL, queue, retry, domain limits, HTTP signing request and dedup | Fedify Tier 2 | Existing general ActivityPub executor; synthetic Group boundary coverage added |
| Remote instance's membership moderation, Group semantics and inbox processing | Actual remote server | **Not validated** by the new synthetic tests |
| ATProto identity/protocol routing | Its separate verified authority | Not implied by Group ActivityPub delivery |


The approved [ActivityPods PostgreSQL architecture decision](https://github.com/outlaw-dame/activity-pods/blob/master/docs/activitypods-postgres-account-and-groups-decision.md) calls for a **single canonical PostgreSQL Group control plane** after a consent-first, revocation-fenced cutover. Do not confuse that planned authority with today's active protected Jena/Solid records: component SQL proofs are not an activated group migration. Account UUID/WebID/did:plc provisioning is a separate phased migration; it cannot be inferred from a passing federation transport fixture. Neither PostgreSQL nor Redis may authorize a cached recipient list after consent revocation.

The existing Redis Streams work in [#147](https://github.com/outlaw-dame/mastopod-federation-architecture/pull/147) (paged XAUTOCLAIM) and [#150](https://github.com/outlaw-dame/mastopod-federation-architecture/pull/150) (opt-in Redis 8.2 ACKED admission) is **not duplicated or activated here**. The sidecar must continue acknowledging jobs only after durable replacement/settlement; capacity rejection keeps prior work pending. [#154](https://github.com/outlaw-dame/mastopod-federation-architecture/pull/154) independently pins broker versions and requires its own upgrade acceptance. Group delivery must inherit the single existing queue and enforce bounded backpressure, without second per-member job queues or silent 5,001st-target truncation.

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

## Compatibility: a Group actor is not a complete Group protocol

The official [Lemmy federation documentation](https://join-lemmy.org/docs/contributors/05-federation.html)
specifies a Community as an ActivityPub `Group` actor that forwards
community posts and related activities as `Announce`. Interop therefore
needs actual Follow/Accept, Group inbox and Announce/Object tests, not just
generic Person-to-Person Create/Note delivery.

Fedify supports a `Group` actor dispatcher, but ownership, membership,
moderation, delivery authorization and ActivityPub collections must be
implemented by ActivityPods with actual signing and remote proof.

Bonfire's [August 2026 launch announcement](https://bonfirenetworks.org/posts/bonfire-for-communities/)
described native Groups as local-only **at that time**. The newer
[Bonfire v1.1 Community RC Groups guide](https://docs.bonfirenetworks.org/groups.html)
now documents public **Open network** and **Announcement channel**
federation via FEP-1b12, plus Lemmy community participation. By contrast,
**Local community** and **Private club** presets do not federate;
private cross-server Group federation is explicitly unsupported. The
[upstream changelog](https://bonfirenetworks.org/docs/changelog/)
identifies this as Bonfire 1.1 *unreleased* functionality, so a hosted
Bonfire installation must be tested against its actual pinned flavour and
build rather than assuming every 1.0/1.1 server supports it.
Our interoperability target is the newer **Bonfire Group experience and
boundaries model**, with exact FEP-1b12 wire compatibility tested separately.

**Inbound Group semantic gap:** the current generic
`src/protocol-bridge/activitypub/translators/social.ts`
`translateAnnounceActivity` projects an ordinary `Announce` to the
canonical `ShareAdd` operation (or a quote-post when it has content).
That is suitable for many boosts, but Lemmy's community `Announce`
wrapping `Create/Page` is **also a community distribution and provenance
event**. Paper must not claim it is an implemented remote Group post or
flatten away its verified Group identity, nested author/object identity,
moderation context and membership distinctions. Introduce a distinct,
authenticated Group-Announce handling rule once the provider Group model
is integrated, using the same existing ingress queue and key/signature
authority. Do not add a parallel inbound queue.

The canonical ActivityPub spec requires inbox duplicate filtering by
Activity `id`; our sidecar still needs its own durable transport-level
destination/intent dedup to minimize waste rather than relying solely on
remote receivers to absorb duplicate POSTs.

## Paper Group interoperability profile — authoritative protocol mapping

The ActivityPods provider owns the independent `Group` actor's member
rights, privacy boundaries, role grants and ID. It is **app-neutral**:
Paper is a client, and Fedify is the remote transport and protocol adapter.
The user experience follows Bonfire's explicit
**who can discover / join / read / contribute / moderate / federate**
boundary separation, topics within Groups, and revocable moderator roles.
Remote Group following/subscription is not the same as social membership.

| Protocol | Paper behavior | Priority and verified partner evidence |
| --- | --- | --- |
| **ActivityPub + FEP-1b12** | Group actor, remote Follow/Accept/Undo, contributor Create/Note or Create/Page addressed to Group, Group-signed Announce of accepted activity, canonical membership/follower separation, moderation authority | **Core**, Lemmy, Mbin, PieFed, Bonfire v1.1 federating presets, NodeBB federated categories |
| **FEP-7888** | Preserve resolvable conversation `context` for threads; do not rewrite a topic into an unrelated group context | High, NodeBB implements for its topics |
| **FEP-7458** | Support replies collection and pagination without unbounded recursive retrieval | High, NodeBB partial |
| **FEP-11dd** | Preserve parent/inherited conversation context when interoperating with NodeBB | Compatibility, NodeBB implemented |
| **FEP-f228** | Authenticated bounded thread backfill, no federation-initiated amplification | Compatibility, NodeBB implemented; optional where offered |
| **FEP-d36d** | Only negotiate cross-forum content sharing if both endpoints advertise/support it; prevent duplicate threads and loops | Optional; NodeBB defers; not a prerequisite |
| **FEP-1a11 / FEP-400e** | No implicit multi-Announce or publicly appendable collection assumptions | Optional/not baseline; no compatibility regression |
| **SWICG Groups draft (2026-10-20)** | Treat member, follower and subscriber as distinct; invitation consent and restrictions remain provider-governed | Design input, **not a W3C Standard** |

**Platform target details**

- **Bonfire Community (v1.1 RC):** Use its public/open and announcement
  federation as a primary reference, but never publish private clubs through
  public AP/AT feed or assume a local-only flavour federates.
- **Lemmy, PieFed, Mbin:** Community or magazine maps to `Group`;
  accept/forward Group `Announce` wrapping original author
  `Create/Page` or `Create/Note`, maintain author and moderation provenance.
  Remote Follow/Accept is subscription, not automatic Paper private membership.
- **NodeBB:** Its federated **category** is the `Group`; a topic is the
  resolvable `context`; `audience` can be the category; categories can
  follow categories. Never flatten category/topic into a generic repost.
- **WAFRN:** Its current public docs confirm generic Fediverse and ATProto
  connectivity but do **not** establish FEP-1b12 Group actor behavior.
  Add WAFRN as a **capability-discovery and live fixture target**; allow
  generic Note/Announce interoperability when supported, but do not claim
  its Groups actor/membership conformance without pinned-source/live proof.
- **Friendica:** Its pinned 2026.08-rc `FEDERATION.md` explicitly lists
  **FEP-1b12 partial support**: following remote Groups, `audience`, and
  processing activities announced by Groups (including Lemmy/kbin), but
  **not Group moderation activities**. Friendica also supports delegated
  forum/group accounts; their legacy forum behaviors are **not** assumed
  wire-identical to every FEP-1b12 Group implementation. Test both
  Friendica-following-Paper-Group and Paper-following-Friendica-forum
  directions, preserve Group actor and nested original-author provenance,
  and label unsupported moderation explicitly rather than claiming it.
  Primary evidence: [Friendica 2026.08-rc federation support](
  https://github.com/friendica/friendica/blob/2026.08-rc/FEDERATION.md)
  and [Friendica forum documentation](https://wiki.friendi.ca/docs/forums).
  The existing real Friendica interop CI failed to persist even an ordinary
  Follow despite HTTP 202; remote database acceptance, actor dereferencing
  and worker processing must be corrected, not suppressed.
- **Mastodon/GoToSocial:** Prefer standard public Group follow/distribution
  compatibility where supported; do not misrepresent those servers as
  providing full native structured Group moderation.

**Critical Group federation truth condition:** HTTP 202 or generic Announce
translation cannot alone pass a Group semantic test. Record actor
Follow/Accept, accepted contribution -> Group Announce, nested original
author/object integrity, FEP-7888 context, reply threading, moderator
authority, recipient/delivery permission, idempotent propagation and remote
persistence. Always pin the remote implementation and capability version.

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

## Intelligent caching: bounded, authority-preserving opportunities

Caching **is** useful, but only behind an explicit provenance/revision rule:

| Candidate | Decision | Cache invalidation and privacy |
| --- | --- | --- |
| Provider membership authorization, SAI grants, suspension/bans, membership epochs | **Do not cache for authorize/commit/delivery decisions.** | Current TDB2 state must be checked; TTL-only authorization is unsafe after a revoke |
| Immutable sealed public Group metadata, unchanged JSON object and fixed-revision index page bytes | Eligible for bounded cache **after** a live current-epoch/SAI/visibility check | Key by provider, Group, exact revision and content digest; bounded bytes+entries; deny on absent/mismatched authority; measure whether caching beats the existing ~9ms TDB2 direct-page lookup |
| Within one authenticated sealed Group delivery plan | Deduplicate normalized destination strings, inboxes and immutable activity-body encoding **only within that plan** | Rebuild when policy/epoch/recipient snapshot changes; never infer membership from domain |
| Remote actor profiles / keys and canonical inbox descriptors | Reuse the existing verified Fedify transport discovery/caching facilities only under actor-ID, signature and TTL/ETag rules | Explicit invalidation for 404/410, key rotation, redirects, fetch error; do not dereference 100k actors for each post |
| Failed network responses, disabled/revoked users, remote permission denials | Avoid broad negative/authorization caching | Must not turn transient errors or revocations into long-lived incorrect state |
| Redis delivery stream payload | Keep existing versioned, gated Brotli-0 compression, bounded decode+digest and exact-payload memo only when measured | This is storage/CPU efficiency, **not** a second member/endpoint authority |

**Retired sidecar cache is intentional.**
`fedify-sidecar/src/delivery/RemoteSharedInboxCache.ts` is a
no-I/O compatibility shim: domain-based inference can choose a remote
endpoint that was never authorized by ActivityPods. Do not revive it.
Only collapse explicitly supplied sharedInbox URLs for eligible public
Group posts; members-only posts use authorized personal inboxes unless
strict private shared-inbox semantics are independently demonstrated.

**Benchmark before creating a new cache.** The real 100k-member isolated
indexed TDB2 read measured ~9ms median; a separate distributed-cache
request plus mandatory live SAI/current-revision query might be **slower**
and more expensive. Prefer bounded per-operation memoization and
transport reuse where hit rate/CPU/IO metrics justify it. Measure hit
rate, stale denial attempts, invalidation age, Redis memory, network
bytes, p95/p99 latency, out-of-order membership CAS and restart recovery.
A cache miss must never trigger unbounded remote actor discovery or a
provider-wide Fuseki membership scan.

## Merge/activation gates

This test-only sidecar PR cannot activate Group delivery. The Group
provider-owned actor, accepted membership snapshot, durable index delta and
Federation Delivery Plan handoff must exist and be interoperably proven
before any remote Group delivery flag is released. Do **not** add a second
Fedify queue, signer, delivery scheduler, actor rediscovery service or
unbounded per-member remote HTTP loop to satisfy the feature.
