# ADSP-P0 mixed/remote runtime evidence

Date: 2026-08-18

This document records the completed ADSP Phase 0 Fixture B evidence and the independent real-RedPanda stream-semantics proof. It complements `P0-TIER1-RUNTIME-EVIDENCE.md`; neither fixture substitutes for the other.

## Result

**Fixture B: COMPLETE for its frozen mixed/remote correctness scope.**

The successful whole-system run originated from the real ActivityPods ActivityPub authority and completed the production external-delivery path through ActivityPods signing, incumbent Redis Streams durability, RedPanda public event logging and controlled remote HTTP execution.

No benchmark code constructed a second Delivery Plan or submitted a second sidecar handoff.

## Exact provenance

Whole-system Fixture B:

- GitHub Actions run: `32086514942`
- federation candidate head: `337e62999ef6fa4e14e126987dec5be67c8e49c6`
- federation PR merge commit after validation: `2cd1c097456756c8c28d349dfc800d36cfd6fce6`
- ActivityPods tested head: `2d18680ce399682ac4e85a2bd777aaf8f631b81a`
- ActivityPods PR merge commit after validation: `7a727f52ba783added771f87693afbcb4fd8c536`
- evidence artifact: `adsp-p0-activitypods-remote-32086514942-1`
- artifact ID: `9306973300`
- artifact digest: `sha256:58f2bc88cd726493243d068f6717849ced190797c360f00c1cf04ff4b1b1847b`

Independent real-RedPanda AP stream proof:

- GitHub Actions run: `32086514958`
- federation candidate head: `337e62999ef6fa4e14e126987dec5be67c8e49c6`
- evidence artifact: `redpanda-ap-stream-semantics-32086514958-1`
- artifact ID: `9306891269`
- artifact digest: `sha256:8efd08789762e9fc0b76df2938dcc9c86631e1c0b4f9aaac0459b50de589b691`

Exact-head validation on the federation candidate also passed:

- Fedify Sidecar Fast Checks: run `32086514949`
- AP Interop Smoke: run `32086514939`
- RedPanda AP stream semantics: run `32086514958`
- ADSP P0 ActivityPods-origin remote fixture: run `32086514942`

The ActivityPods signing/authority candidate passed Backend Checks in run `32086078437` before it was pinned into Fixture B.

## Proven authority path

The successful fixture exercised:

```text
ActivityPods activitypub.outbox.post
  ↓
authoritative ap.delivery-plan.v1
  ↓
exactly one suppressed native remotePost job
  ↓
ActivityPods durable Bull handoff
  ↓
sidecar durable 202 acceptance
  ↓
Redis Streams outbox-intent
  ↓
RedPanda Stream1 + AP firehose publication
  ↓
Redis Streams outbound job
  ↓
ActivityPods internal signing API
  ↓
controlled remote ActivityPub inbox
  ↓
completion / retry / DLQ reconciliation
```

The ActivityPods signing boundary was repaired before this proof so it now verifies a real local `auth.account` and exact ActivityPub actor, resolves the actor-controlled RSA key through SemApps with the account dataset context, and derives the key ID from signer-controlled attached key material. Remote, same-host-but-nonexistent, mismatched and ambiguous actors/keys fail closed.

## Scenario evidence

### Success

- Activity ID: `http://localhost:3000/p8ms9755433835954458/data/149cdb1a-18e9-4bbc-9797-70dae0e71f3f`
- Delivery Plan intent ID: `apdm-v1-2d074a1f5b84e63bbc52b32bb778c8c41638a359eec31c8a06a6b737f2f7d5bb`
- RedPanda publication marker present: `eventLogPublishedAt=1787014836586`
- controlled HTTP requests: `1`
- body SHA-256: `29aa7a70175c4dd099238832145b83abaa26902f1a5f21d386612c4bebd50ab9`
- final delivery: HTTP `202`
- reconciliation errors: `0`

### Transient failure then success

- Activity ID: `http://localhost:3000/p8ms6290744922913786/data/76ba25a5-c45b-47be-8db9-ebc51eeb695d`
- Delivery Plan intent ID: `apdm-v1-4eaa10c616f5711d19424842e3defca80ac0a0205f67608b76783e1675932d34`
- RedPanda publication marker present: `eventLogPublishedAt=1787014850561`
- controlled HTTP requests: `3`
- body SHA-256 remained the reconciled body: `f4be52f9d9679f9f35314ff6d867effc9ccf39aaa166f59842e1fdaf22461d88`
- attempt 1: HTTP `503`, retry scheduled approximately 60 seconds later
- attempt 2: HTTP `503`, retry scheduled approximately 60 seconds later
- attempt 3: HTTP `202`
- reconciliation errors: `0`

This proves retry execution without a second federation authority path.

### Permanent failure

- Activity ID: `http://localhost:3000/p8ms2941932992729857/data/628a0c0d-02c0-4f49-a89c-00e025eafce9`
- Delivery Plan intent ID: `apdm-v1-334c7e13d46708cdd806b6e92b021a3ce7275768ee3223cd0a521f6f300fca15`
- RedPanda publication marker present: `eventLogPublishedAt=1787014983527`
- controlled HTTP requests: `1`
- body SHA-256: `4b9be991c7e8af66accbf3621805a3c879ad16ebdfa1e138a8af9e3195b991be`
- remote response: HTTP `410`
- worker result: permanent failure moved to outbound DLQ
- reconciliation errors: `0`

## HTTP signing proof

The controlled-target observation for the final permanent scenario recorded:

- `Date` present;
- `Digest` present;
- digest valid for the transmitted body;
- `Signature` present;
- content type `application/activity+json`.

The success and transient cases passed the same strict controlled-target/reconciliation contract before the target was reset for the next scenario.

## RedPanda semantics — authoritative contract

The ActivityPub public stream model is:

- `ap.stream1.local-public.v1` — aggregate of **local public ActivityPub activities** originating on this Pod provider;
- `ap.stream2.remote-public.v1` — aggregate of **remote public ActivityPub activities** accepted from verified remote federation sources, including relay/service-actor ingress where applicable;
- `ap.firehose.v1` — consumable combined public ActivityPub stream containing **Stream1 + Stream2**;
- `ap.tombstones.v1` — delete/tombstone events, deliberately separate from the public AP firehose;
- `canonical.v1` — protocol-neutral canonical intent log, deliberately separate from the ActivityPub firehose.

The production `RedPandaProducer` writes a local public event atomically to Stream1 and the firehose, and a remote public event atomically to Stream2 and the firehose. Tombstones use only the dedicated tombstone topic.

## Real-broker semantic proof

Run `32086514958` started an isolated real RedPanda broker and used the production producer to publish one unique local event, one unique remote event and one tombstone. A Kafka consumer then read all four relevant topics from the broker.

Observed membership exactly matched the contract:

| Topic | Observed proof records |
|---|---|
| Stream1 | local event only |
| Stream2 | remote event only |
| AP firehose | local event exactly once + remote event exactly once |
| Tombstones | tombstone only |

All assertions passed:

- Stream1 contained only the local proof event;
- Stream2 contained only the remote proof event;
- the firehose contained the local event exactly once;
- the firehose contained the remote event exactly once;
- the firehose excluded the tombstone;
- Stream1 excluded the remote event;
- Stream2 excluded the local event;
- the tombstone topic contained only the tombstone proof record.

This is broker-level evidence, not a mocked producer-only result.

## Resource evidence boundary

The Fixture B artifact retains:

- ActivityPods process snapshots before/after;
- sidecar process snapshots before/after;
- Docker stats snapshots;
- Redis commandstats and memory snapshots;
- RedPanda topic descriptions before/after;
- controlled-target observations;
- service logs;
- per-scenario origin/prepared/settlement evidence.

Fixture B currently has one deterministic correctness run per scenario. It is therefore valid correctness/failure-path evidence but is **not** used to claim a stable p50/p95/p99 remote-delivery performance distribution.

## P0 consequence

Fixture A and Fixture B are now both complete for their frozen P0 scopes. They establish reproducible local and mixed/remote workloads, exact authority boundaries and real incumbent Redis/RedPanda federation behavior.

ADSP-P0 is **not automatically closed by these two successful fixtures**. The remaining Phase-0 gate is to freeze the numerical Phase-2/Phase-3 promotion thresholds from the measured baseline variance before any candidate NATS results are observed. Multi-node namespace, serializer/RDF remote parity, service locality and join/leave/rejoin correctness remain Phase-1 work as defined in `PHASES.md`; they must not be mislabeled as unfinished P0 evidence.
