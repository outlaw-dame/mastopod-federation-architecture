# ADSP Status

Last updated: 2026-08-20

This is the live cross-repository evidence ledger for the ActivityPods Distributed Scalability Program. `PHASES.md` defines phase ownership and exit decisions, `BENCHMARK-CONTRACT.md` defines evidence validity and promotion rules, and `P2-CLOSEOUT-2026-08-20.md` records the final Phase-2 evidence and non-promotion decision.

## Program checklist

- [x] ADSP-P0 — baseline, authority and benchmark contract — **COMPLETE**
- [x] ADSP-P1 — safe distributable Moleculer fabric — **COMPLETE**
- [x] ADSP-P2 — horizontal ActivityPods / Redis transporter — **COMPLETE / NON-PROMOTABLE**
- [ ] ADSP-P3 — NATS Core transporter comparison — **ENTRY GATE CLOSED / NOT AUTHORIZED**
- [ ] ADSP-P4 — qualified extension/reuse of Redis Streams — **CONDITIONAL; no additional workload opened by P2**
- [ ] ADSP-P5 — JetStream evaluation — **ENTRY GATE CLOSED**
- [ ] ADSP-P6 — deployment profiles and stabilization — **BLOCKED pending an evidence-backed selected horizontal architecture**

Separate authorized follow-on: **ActivityPub Interoperability Hardening — ACTIVE after P2 reconciliation**. This does not alter the ADSP transporter decision.

## Frozen source baseline

Historical setup heads remain:

- ActivityPods: `3fad15838ec098d8d32c0f36cd8c75cbb66a46a8`
- federation architecture: `e20c32fc5d4c9b9157de3063345e050ea3ec5007`

Confirmed baseline constraints remain unchanged:

- ActivityPods/SemApps owns authoritative local application state and local ActivityPub planning/semantics.
- Fedify sidecar owns the external federation execution path when that authority mode is selected.
- Redis cache, transporter, queue and OIDC-state responsibilities are distinct.
- the sidecar already uses Redis Streams for durable federation workloads.
- RedPanda is not a Moleculer transporter replacement and does not create a second federation authority.
- native single-process ActivityPods remains a supported low-resource profile.

The frozen P0 source heads are historical provenance. Later hardening does not rewrite that baseline.

## Phase 0 — COMPLETE

Phase 0 froze the topology, authority model, benchmark fixtures and numerical promotion contract before any NATS comparison.

Key locked gates include:

- correctness: zero unexplained lost/duplicate authoritative outcomes or semantic/privacy drift;
- horizontal scale: both 1→2 and 2→4 require at least 1.50x successful throughput or at least 20% p95 latency reduction when the smaller topology is demonstrably saturated;
- dependency/registry recovery: at most 30 seconds after the dependency becomes reachable;
- p95 latency regression ceiling: +10%;
- p99/tail regression ceiling: +15%;
- whole-system CPU regression ceiling: +15%;
- whole-system and ActivityPods median RSS regression ceiling: +20%;
- added-runtime candidates require stronger materiality and operational-cost justification.

Detailed derivation remains in `P0-PROMOTION-THRESHOLDS.md` and `BENCHMARK-CONTRACT.md`.

### P0 runtime provenance retained

Tier-1 local fanout run `32070748744` produced 25/25 successful measured samples across N=1,10,100,200,1000. Stable N=10–1000 points supplied the variance evidence used to lock the promotion thresholds.

Mixed/remote federation run `32086514942` proved the intended authority chain through ActivityPods delivery planning, durable handoff, sidecar Redis Streams, RedPanda event log, outbound execution, ActivityPods signing and controlled remote HTTP, including success, bounded transient retry and permanent-failure DLQ scenarios.

RedPanda stream-semantics run `32086514958` independently proved:

- `ap.stream1.local-public.v1` = local public ActivityPub aggregate for the Pod provider;
- `ap.stream2.remote-public.v1` = remote public ActivityPub aggregate from accepted remote sources;
- `ap.firehose.v1` = Stream1 + Stream2;
- `ap.tombstones.v1` remains separate;
- `canonical.v1` remains a separate protocol-neutral intent log.

## Phase 1 — COMPLETE

Phase 1 established the safe distributable Moleculer fabric without selecting a new transporter.

Closed evidence includes:

- unique distributed node IDs and explicit namespace isolation;
- transport-independent `RdfJSONSerializer`;
- genuine Redis-transported RDF/JSON-LD remote-call/error parity;
- independently startable service groups;
- production Pod/SemApps local-first routing under `registry.preferLocal`;
- local/remote execution telemetry;
- clean node join/leave/rejoin behavior;
- fail-closed distributed configuration;
- ambiguous-commit fabric proof showing an already-committed authoritative mutation is not silently replayed after node loss;
- native single-process deployment preserved.

Historical merged PRs include ActivityPods #87, #88, #89 and #90; their detailed exact-head runs remain in repository history and prior revisions of this ledger.

## Phase 2 — COMPLETE / NON-PROMOTABLE

Phase 2 has complete evidence for the incumbent Redis Moleculer transporter across correctness, scale/resource behavior, mixed-federation correctness and real ActivityPub node loss under load.

### W1 — frozen scale/resource decision

Canonical W1 replacement run: `32256193005`

Exact merged federation head: `54ca8024d3c6f374988cca5b32eb6281f57c1aa2`

Frozen result:

- N=10 passes the horizontal scaling gates strongly;
- N=100 fails the 1→2 gate;
- N=100 fails the 2→4 gate and is essentially flat at 2→4.

This mixed result is immutable under the frozen benchmark contract. Later correctness or failure-recovery success cannot be used to relax or reinterpret it.

### W3 — mixed federation correctness closed

W3 remains closed.

- ActivityPods PR #97 merged as `d0b2fce2cfcfd5d319d708005dd960790a08f894`, adding the missing P1/P2-standard `RdfJSONSerializer` and `registry.preferLocal` to the W3 broker.
- Federation PR #93 is merged.
- executions against the older pre-#97 ActivityPods pin remain invalidated.

### Node-loss correctness/recovery — closed

ActivityPods PR #106 merged as:

`0ae54f0a898df3fb4e6516504c4e649669834d69`

Final exact candidate head:

`0fc73267c359630c6ccd769bdf71ee745eaa849f`

Exact-head node-loss run:

`32366561510`

Artifact:

- `adsp-p2-node-loss-32366561510-1`
- artifact id `9405622286`
- digest `sha256:0fb2c90c6d3fb82d52dd2ef3d86f45cad9ae5c9495a48b7fa49322fe2ea507b9`

The artifact was independently inspected.

#### Deterministic ambiguous commit

The selected r4 request completed the real `activitypub.outbox.post` root, recorded `root-action-complete-response-held`, then had its response withheld before SIGKILL.

Final result:

- selected root entry exactly once on r4;
- held boundary before the pre-SIGKILL fault epoch and kill completion marker;
- fault burst 7 accepted / 1 selected rejected;
- selected request rejected to caller exactly once and never retried by the harness;
- survivor accepted work covers r1/r2/r3;
- post-rejoin work covers r1/r2/r3/r4;
- 23 accepted request IDs unique;
- 23 accepted Activity IDs unique;
- no duplicate measured completed traces.

#### Conservative recovery timing

A late Codex review correctly identified that the earlier removal stopwatch began after `docker compose kill` returned. The final evidence adds an independent recovery-clock broker and writes the authoritative fault epoch immediately **before** SIGKILL.

Final measured recovery:

- pre-SIGKILL fault epoch → 4→3 endpoint convergence: **16,225 ms**;
- 3→4 endpoint convergence after restart: **5,721 ms**;
- restarted-r4 full semantic readiness: **5,769 ms**;
- frozen bound: **30,000 ms**.

All pass.

#### Authoritative persistence

The final authenticated Fuseki audit counts only distinct IRI resources typed `as:Note` with the exact request marker.

- all 23 caller-accepted requests: exactly one authoritative Note IRI each;
- selected caller-rejected ambiguous commit: exactly one authoritative Note IRI;
- duplicate authoritative mutation count: `0`.

#### Redis command health

Bull 3.29.3 lazy Lua loading had produced `EVALSHA`/`NOSCRIPT` misses in earlier measured intervals. The frozen zero-failure gate was not weakened.

The P2 Pod-cell now preloads installed Bull Lua scripts with `SCRIPT LOAD` during a P2-only service startup lifecycle before service advertisement; restarted r4 repeats that preload before rejoining.

Final measured interval after `CONFIG RESETSTAT`:

- calls: **38,640**;
- failed calls: **0**;
- rejected calls: **0**;
- `EVALSHA`: **1,823 calls, 0 failures**;
- final `NOSCRIPT` errorstats: none.

#### Semantic restart parity

All four cells ended with:

- 21 local ontologies;
- ActivityStreams (`as`) present;
- coherent local/current ActivityStreams context;
- complete required ActivityStreams cache;
- all 58 required ActivityStreams classes expanded correctly;
- explicit `Note` and `Article` expansion passing.

#### Authority result

The lane retained SemApps native remote-delivery authority for its profile and did not introduce a second federation execution authority. No privacy/addressing drift was observed.

### Phase-2 decision

The evidence phase is closed, but **Redis P2 is non-promotable** because canonical N=100 failed both horizontal scale transitions.

This is a negative promotion decision, not an unfinished correctness phase.

## Phase 3 — ENTRY GATE CLOSED

NATS Core comparison was authorized only if the Redis Phase-2 comparator was promotable under the frozen contract. It is not.

Therefore:

- do not begin NATS Core benchmarking;
- do not reinterpret W1 after seeing the node-loss result;
- do not retain NATS merely because it can technically function;
- reopening Phase 3 would require an explicit prospective roadmap/contract change, not a post-hoc gate relaxation.

## Phase 4 / Phase 5

Additional Redis Streams workloads remain workload-specific and conditional. Phase 2 did not itself qualify a new workload for migration.

JetStream remains unauthorized. Its entry gate still requires a concrete, quantified Redis durability/HA/flow-control limitation that materially affects a required production workload after simpler Redis-native options are considered.

## Current decision ledger

| Decision | State | Reason |
|---|---|---|
| Native single-process ActivityPods | supported low-resource profile | Phase 1 preserved it and Phase 2 did not invalidate it |
| Redis transporter for horizontal ActivityPods | evidence complete / **not promoted** | correctness/recovery passes, canonical N=100 scale gates fail |
| NATS Core | **not authorized** | Phase-3 entry gate closed by non-promotable P2 |
| Existing sidecar Redis Streams | incumbent / preserved | already supplies durable federation work queues |
| RedPanda AP public streams | incumbent / verified | Stream1 local + Stream2 remote; AP firehose is their union |
| Redis Stream Brotli compression | merged capability, writer off by default | separate queue optimization; does not change P2 transporter decision |
| Additional Redis Streams workloads | conditional | require workload-specific evidence |
| JetStream | **not authorized** | reproduced material Redis-limitation entry gate is not open |

## Current authorized work

With PR #106 merged and Phase 2 reconciled, the next active implementation work is the bounded **ActivityPub Interoperability Hardening** phase in `docs/phases/ACTIVITYPUB-INTEROPERABILITY-HARDENING.md`.

It is deliberately separate from the transporter ladder. It must preserve:

- ActivityPods/SemApps authority and privacy boundaries;
- no second federation route;
- fail-closed signature/authorization/ACL/visibility/SSRF behavior;
- hermetic executable fixtures as merge evidence;
- live third-party inspection only as a debugging/discovery aid, never the sole CI gate.

Initial work begins with an inventory of existing ActivityPods/SemApps ActivityPub parsing, semantic normalization, authority and app-facing test layers before adding new fixture infrastructure.
