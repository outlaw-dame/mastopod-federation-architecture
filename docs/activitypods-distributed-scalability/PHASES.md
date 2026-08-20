# ADSP Phases

This is the ordered cross-repository ActivityPods Distributed Scalability Program roadmap. `STATUS.md` carries the live evidence ledger, `P0-SOURCE-BASELINE.md` freezes source-level baseline facts, `BENCHMARK-CONTRACT.md` defines comparison rules, and `P2-CLOSEOUT-2026-08-20.md` records the final Phase-2 decision.

## Completion rule

A checked phase means its evidence question and exit decision are closed. A completed phase may legitimately end in **non-promotion** when the frozen contract is not met. Preparatory code, a successful unit test, a running distributed topology, or a faster isolated benchmark does not by itself complete or promote a phase.

Later phases may not be promoted by assumption. NATS Core remains an unselected transporter candidate, additional Redis Streams use remains workload-specific, and JetStream remains gated behind reproduced limitations in the incumbent Redis durability model.

## Program checklist

- [x] Phase 0 — Freeze topology baseline, authority and benchmark contract — **COMPLETE**
- [x] Phase 1 — Safe distributable Moleculer fabric — **COMPLETE**
- [x] Phase 2 — Horizontal ActivityPods with Redis transporter — **COMPLETE / NON-PROMOTABLE**
- [ ] Phase 3 — NATS Core transporter comparison — **ENTRY GATE CLOSED; NOT AUTHORIZED**
- [ ] Phase 4 — Extend/reuse Redis Streams for qualified additional workloads — **CONDITIONAL; no new workload authorized by Phase 2**
- [ ] Phase 5 — Conditional JetStream evaluation — **ENTRY GATE CLOSED**
- [ ] Phase 6 — Deployment profiles, stabilization and closeout — **BLOCKED pending an evidence-backed selected horizontal architecture**

The separate `ActivityPub Interoperability Hardening` phase is a bounded product/protocol-hardening workstream, not an ADSP transporter promotion. It may proceed after Phase-2 reconciliation without opening Phase 3.

## Phase 0 — Freeze topology baseline, authority and benchmark contract

**Status:** COMPLETE  
**Slices:** `ADSP-P0-A`, `ADSP-P0-F`

Goals:
- verify current ActivityPods Moleculer node ID, namespace, transporter and serializer behavior from source;
- inventory which services are loaded into the default backend process and which calls are local today;
- freeze the existing Redis responsibilities on both sides of the architecture;
- freeze Fedify-sidecar durable queue/handoff behavior so transporter work cannot silently replace it;
- define representative workloads, measurement points, failure scenarios and promotion criteria before candidate testing;
- record exact repository heads used for the baseline.

Exit gate: closed. The numerical contract is frozen in `P0-PROMOTION-THRESHOLDS.md` and `BENCHMARK-CONTRACT.md`. No NATS-Core benchmark result was used to select those values.

## Phase 1 — Safe distributable Moleculer fabric

**Status:** COMPLETE  
**Primary:** `ADSP-P1-A`; federation slice only where integration/observability is needed.

Phase 1 established safe distribution without changing the selected transporter:
- unique node IDs and explicit namespaces;
- transport-independent `RdfJSONSerializer`;
- selective service loading and explicit locality groups;
- local-first Pod/SemApps cells;
- local-versus-remote telemetry;
- genuine remote RDF/JSON-LD calls and errors;
- node join/leave/rejoin and stale-registry behavior;
- fail-closed distributed configuration;
- native single-process deployment retained as a supported low-resource profile.

The Phase-1 node-loss proof established that the Moleculer fabric does not silently replay an already-committed mutation after its serving node is killed before response. Phase 2 subsequently closed the stronger whole-system real-ActivityPub node-loss requirement.

## Phase 2 — Horizontal ActivityPods with Redis transporter

**Status:** COMPLETE / NON-PROMOTABLE  
**Primary:** `ADSP-P2-A`; `ADSP-P2-F` for whole-stack measurement.

Phase 2 established and measured the first real horizontal ActivityPods baseline using infrastructure already present in ActivityPods:
- multiple ActivityPods backend replicas;
- Redis Moleculer transporter;
- existing Redis state/cache/queue responsibilities preserved;
- Fedify sidecar incumbent Redis Streams durability unchanged;
- tightly coupled Tier-1 work colocated under the Phase-1 locality contract.

### Closed evidence

Canonical W1 run `32256193005` remains the frozen scale/resource decision evidence:
- N=10 scales strongly;
- N=100 fails the 1→2 promotion gate;
- N=100 fails the 2→4 promotion gate, with 2→4 essentially flat.

W3 mixed-federation correctness is closed by federation PR #93 and the corrected ActivityPods W3 broker from PR #97 (`d0b2fce2cfcfd5d319d708005dd960790a08f894`).

The remaining node-loss gate closed in ActivityPods PR #106, merged as `0ae54f0a898df3fb4e6516504c4e649669834d69`. Final exact candidate head `0fc73267c359630c6ccd769bdf71ee745eaa849f` passed exact-head run `32366561510`.

Key final node-loss evidence:
- deterministic real `activitypub.outbox.post` ambiguous-commit SIGKILL boundary;
- selected caller-rejected mutation persisted exactly once;
- every caller-accepted mutation persisted exactly once;
- zero duplicate authoritative mutations;
- authoritative 4→3 convergence measured from a pre-SIGKILL epoch: 16,225 ms;
- 3→4 endpoint convergence: 5,721 ms;
- restarted-r4 full semantic readiness: 5,769 ms;
- survivor work covers r1/r2/r3 and post-rejoin work covers all four replicas;
- Redis measured interval: 38,640 calls, zero failed and zero rejected;
- all four cells end with 21 ontologies and correct expansion of all 58 required ActivityStreams classes, including Note and Article;
- no second federation authority path is introduced.

Full closeout provenance and artifact digest are in `P2-CLOSEOUT-2026-08-20.md`.

### Phase-2 decision

Phase 2 is complete because its evidence question is closed. It is **not promotable** because the frozen N=100 scale gates failed. The later correctness/recovery success does not overwrite or weaken the scale result.

Therefore the Redis horizontal topology is an evidence-backed correct baseline but does **not** become an authorized Phase-3 promotion comparator under the frozen contract.

## Phase 3 — NATS Core transporter comparison

**Status:** ENTRY GATE CLOSED / NOT AUTHORIZED  
**Primary if ever opened:** `ADSP-P3-A`; `ADSP-P3-F` for whole-stack evidence.

NATS Core was defined as a candidate replacement **only for the distributed Moleculer transporter**. Redis would remain for state/cache/existing queues and the Fedify sidecar would keep its incumbent Redis Streams durable path.

The frozen program rule requires the Phase-2 Redis baseline to be promotable before spending another phase comparing NATS against it. Phase 2 failed that scale gate. Therefore Phase 3 does not start.

Do not run NATS benchmarks merely because NATS is technically available. Reopening this gate requires an explicit roadmap/contract decision made prospectively; prior failed evidence may not be reinterpreted post hoc.

## Phase 4 — Extend/reuse Redis Streams for qualified additional workloads

**Status:** CONDITIONAL / NOT OPENED BY PHASE 2  
**Slices:** assigned per workload; may be ActivityPods, federation, or both.

Redis Streams are already incumbent federation infrastructure. This phase does not introduce Redis Streams to the architecture and does not rewrite existing sidecar queues simply to satisfy the roadmap.

Evaluate reuse or extension only for an additional workload that genuinely requires ordered durable events, replay, consumer groups, acknowledgements or horizontally distributed workers.

For any candidate workload, require before promotion:
- queue/stream semantics classified before implementation;
- incumbent mechanism shown insufficient or Streams shown materially simpler/better with evidence;
- reuse of existing abstractions preferred over duplicate queue infrastructure;
- explicit idempotency, retry, poison/DLQ, retention and replay bounds;
- Redis failover/data-loss semantics tested against the workload durability requirement;
- consumer-group recovery and pending-entry handling proven where applicable;
- memory growth and trimming bounded;
- workload-specific promotion or rejection decision recorded.

If no workload qualifies, Phase 4 closes as **NOT REQUIRED FOR ADDITIONAL WORKLOADS**; incumbent federation Redis Streams remain part of the architecture regardless.

## Phase 5 — Conditional JetStream evaluation

**Status:** ENTRY GATE CLOSED

JetStream is not part of the default plan. It may be evaluated only when a documented limitation in the incumbent Redis Streams/queue topology materially affects HA, partitioning, flow control, recovery, throughput or operational safety for a required production workload.

Entry gate requires:
- a concrete Redis limitation reproduced and quantified;
- material impact on a required production workload;
- Redis-native topology/partitioning and simpler options considered;
- expected benefit large enough to justify a second durable subsystem.

No such qualifying limitation was established by Phase 2. JetStream therefore remains unauthorized.

## Phase 6 — Deployment profiles, stabilization and closeout

**Status:** BLOCKED pending an evidence-backed selected horizontal architecture

The program should eventually expose explicit deployment choices rather than one mandatory heavyweight stack:
- low-resource/single-node ActivityPods profile;
- horizontal profile only when supported by the frozen evidence contract;
- incumbent federation Redis Streams preserved;
- additional Redis Streams only for qualified workloads;
- JetStream only for a workload/profile that independently earns it.

Exit work includes deployment/configuration docs, rollback, capacity guidance, observability/failure runbooks, and removal of experimental mandatory dependencies.

Phase 2's non-promotion decision means Phase 6 cannot simply bless the current Redis horizontal profile as the selected scalable architecture.

## Current authorized follow-on

The ADSP transporter ladder is intentionally paused at the Phase-2 decision boundary. The next active implementation phase is the separate `docs/phases/ACTIVITYPUB-INTEROPERABILITY-HARDENING.md` workstream.

That phase must:
- remain subordinate to ActivityPods/SemApps authority and privacy rules;
- avoid creating a second federation path;
- build hermetic real-world implementation-dialect fixtures and a stable normalized app-facing compatibility contract;
- distinguish parser tolerance from trust/authority tolerance;
- keep live third-party services out of ordinary PR merge gates.
