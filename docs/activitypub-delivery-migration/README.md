# ActivityPub Delivery Migration Program

This directory is the authoritative cross-repository roadmap for moving external ActivityPub HTTP execution from SemApps native remote delivery to the Fedify sidecar while separately optimizing local ActivityPods Pod fan-out.

## Repositories and authority

- `outlaw-dame/activity-pods` — Tier 1 authority: Activity persistence, recipient expansion, local/remote classification, local Pod delivery, dataset/WebACL/LDP semantics, signing/key custody, and production of the authoritative Delivery Plan.
- `outlaw-dame/mastopod-federation-architecture` — Tier 2 authority: durable accepted outbound intents, shared-inbox optimization, remote queues, retry/rate/domain controls, DLQ, Fedify HTTP execution and AP interoperability.

Local Pod delivery remains ActivityPods/SemApps-owned; it is not routed through the Fedify sidecar.

## Program rule

One program phase may contain one or more repository slices. Repositories do not maintain independent phase numbering. Cross-repo phases use `APDM-P<n>`; repository slices use `-A` for ActivityPods and `-F` for federation architecture.

A phase is checked complete only after its **exit gate** closes. A preparatory implementation, benchmark harness, or supporting scalability/security PR does not by itself advance the phase.

## Current program state

- Phases **0–9 are PASS**.
- Phase **10 is IN PROGRESS** on the measured c4 local-delivery baseline.
- Phases **11–16 remain blocked/not started** behind preceding gates.
- ActivityPods PR #67 contains the current Phase 10 fail-closed dataset-existence reuse slice and measurement harness.
- Real Phase 10 OFF/ON run `31965449687` was launched from frozen ActivityPods head `1f512cfb192ab469b9684cb17a7e3af2756a3cdb`; its result must be recorded in `STATUS.md` before Phase 10 can be marked PASS.

See `PHASES.md` for the checkbox roadmap and `STATUS.md` for evidence/PR tracking.

## Current proven architecture after Phase 9

In production `external` mode:

1. ActivityPods/SemApps persists/processes the Activity and performs local Pod delivery.
2. ActivityPods owns recipient expansion and authoritative local/remote planning.
3. native SemApps `remotePost` jobs are suppressed before creation for the external-authority request.
4. ActivityPods produces one `ap.delivery-plan.v1` intent and hands it durably to the sidecar.
5. Fedify/sidecar is the sole external ActivityPub HTTP executor.
6. ActivityPods retains user signing/key custody authority.
7. native mode remains the rollback executor.

For local fan-out, Phase 7 removed the duplicate account lookup, Phase 8 measured the real nested Tier 1 work, and Phase 9 promoted empirically selected bounded concurrency `4` while preserving explicit serial rollback with `APDM_LOCAL_DELIVERY_CONCURRENCY=1`.

The remaining local problem is not remote federation. It is the measured per-recipient LDP/WebACL/Fuseki amplification inside the ActivityPods/SemApps Pod-delivery path.

## Historical Phase 0 baseline

The migration began from SemApps 1.1.4 behavior in which:

1. `activitypub.activity.getRecipients` expanded a local actor's followers collection;
2. the outbox partitioned expanded recipients into local and remote sets;
3. local recipients incurred duplicate account lookup plus sequential inbox/LDP/activity work;
4. SemApps created one native Bull `remotePost` job per remote recipient before `activitypub.outbox.posted`;
5. the custom downstream `outbox-emitter` separately inferred some remote targets for the sidecar.

That historical state explained the original duplicate-routing and followers-expansion hazards. It is **not** the current external-mode authority model after Phases 5–6.

## Supporting work versus APDM phase work

This repository also contains substantial FEP, ATProto, identity, Redis, queue, media, moderation and security scalability hardening. Such work may protect APDM invariants or reduce resource use, but it is tracked as **supporting/adjacent work** unless a phase exit gate explicitly depends on it. This prevents unrelated merged performance PRs from being mistaken for completed APDM phases.

## Authoritative documents

- `PHASES.md` — ordered roadmap, checkbox completion state and exit gates.
- `STATUS.md` — live cross-repo evidence ledger and paired PR tracking.
- `CONTRACT.md` — Delivery Plan contract and authority boundary.
- `INVARIANTS.md` — correctness, security, durability and rollback requirements.
- phase-specific hardening/cutover documents — implementation details for the relevant closed phases.
