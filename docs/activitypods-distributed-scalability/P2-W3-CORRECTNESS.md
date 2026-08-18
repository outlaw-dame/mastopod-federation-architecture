# ADSP Phase 2 W3 mixed ActivityPods + federation correctness foundation

This slice is the correctness/topology prerequisite for the W3 mixed whole-stack benchmark. It is **not** promotion evidence and does not close ADSP Phase 2.

## Reused authority chain

The fixture deliberately reuses the already-proven P0 ActivityPods-origin remote path instead of introducing a second federation executor:

`activitypub.outbox.post → authoritative Delivery Plan → suppressed native remotePost → durable ActivityPods handoff → sidecar 202 → Redis Streams outbox-intent → RedPanda publication → outbound worker → ActivityPods signing → controlled remote HTTP → completion/retry/DLQ reconciliation`

The sidecar `prepare`/`settle` CLI and its strict ActivityPods-origin parser remain unchanged. W3-only topology/request correlation is carried in a separate ActivityPods companion artifact rather than weakening the P0 evidence schema.

## Horizontal source topology

The ActivityPods companion uses the merged P2 Redis-transporter pod-cell topology. The W3 origin runner is an independent Moleculer broker in the same explicit namespace and refuses to create the Activity unless the registry contains exactly the requested number of `activitypub.outbox.post` endpoints: 1, 2, or 4.

The W3 external-delivery compose overlay is separate from the W1/native overlay. W1 remains native and unchanged.

## Loopback authority without SSRF-policy drift

P0 uses literal loopback (`127.0.0.1`) for the controlled ActivityPub actor/inbox because the sidecar's test egress exception is intentionally limited to literal loopback.

Horizontal ActivityPods cells run inside containers, where their own loopback cannot reach the host target. Each W3 cell therefore runs a benchmark-only loopback bridge bound only to `127.0.0.1:18080`. It forwards actor-discovery requests to the host gateway while preserving the incoming `Host` authority. The controlled target and sidecar bind `0.0.0.0` only inside the isolated CI runner so the containers can reach them through the host gateway.

The authoritative Delivery Plan still contains a literal loopback destination and the sidecar still delivers to literal loopback. No production/private-network egress policy is broadened. An accidental native ActivityPods POST would traverse the same bridge to the single controlled target and therefore contaminate the reconciliation evidence rather than being hidden.

## Root executor evidence

APDM Phase-8 instrumentation observes SemApps `localPost()` and is therefore not the correct executor authority for a remote-only Activity with zero local recipients.

W3 instead reuses the P1/P2 `AdspActionLocalityMiddleware`, which observes Moleculer local/remote action routing without changing endpoint selection or action results. The W3 overlay enables a separate locality file per pod-cell. After a graceful cell stop, the fixture requires exactly one aggregate `activitypub.outbox.post` local execution for each single-root success topology case.

This proves which cell executed the root for that case. It does **not** claim that every configured cell carried work. All-replica measured participation belongs to the later long-lived W3 performance runner.

## Correctness cases

The foundation runs:

- success under exactly 1 ActivityPods cell;
- success under exactly 2 cells;
- success under exactly 4 cells;
- transient remote failure/retry under 4 cells;
- permanent remote failure/DLQ under 4 cells.

Every case must retain the P0 invariants:

- Delivery Plan schema `ap.delivery-plan.v1`;
- durable ActivityPods handoff queued;
- exactly one suppressed native remote executor;
- public Activity eligibility for the event-log path;
- sidecar settlement with no reconciliation errors;
- intent identity preserved end to end;
- Redis → RedPanda publication marker present.

The ActivityPods W3 correlation artifact must independently bind the case to the same Activity ID, explicit Moleculer namespace, and expected replica count.

## What this does not prove

This fixture does not provide the locked W3 performance evidence. It intentionally does not infer scaling from one request per topology and does not require all replicas to execute work.

The subsequent W3 comparator must use a long-lived independent Moleculer broker across each measured window and the same matched-state discipline as W1. Promotion evidence still requires at least five valid samples after warmup, whole-system CPU/RSS accounting including ActivityPods + Fuseki + Redis + sidecar + RedPanda, zero authority/correctness drift, and the frozen horizontal scale/resource thresholds.

The separate W1 five-sample `workflow_dispatch` evidence also remains outstanding. NATS Core remains blocked until all Redis Phase-2 gates close.
