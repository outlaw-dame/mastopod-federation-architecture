# ActivityPub Delivery Migration Program

This directory is the authoritative cross-repository roadmap for replacing SemApps native remote ActivityPub delivery with the Fedify sidecar while separately optimizing local ActivityPods fan-out.

## Repositories

- `outlaw-dame/activity-pods` — Tier 1 authority: Activity persistence, recipient expansion, local/remote classification, local Pod delivery, dataset/WebACL/LDP semantics, signing authority.
- `outlaw-dame/mastopod-federation-architecture` — Tier 2 authority: durable outbound intents, shared-inbox optimization, remote delivery queues, retries, domain controls, DLQ, Fedify runtime and AP interoperability.

## Program rule

One program phase may contain one or more repository slices. Repositories do not maintain independent phase numbering. Cross-repo phases use the identifier `APDM-P<n>` and repository slices use `-A` for ActivityPods and `-F` for federation architecture.

Examples:

- `APDM-P2-A` — ActivityPods slice of Phase 2.
- `APDM-P2-F` — federation-architecture slice of Phase 2.

## Current proven baseline

The exact SemApps middleware 1.1.4 code used by ActivityPods:

1. expands a local actor's followers collection in `activitypub.activity.getRecipients`;
2. partitions resolved recipients into local and remote recipients;
3. performs a per-local-recipient `auth.account.findByWebId` during partitioning;
4. performs a second `auth.account.findByWebId` inside `localPost`, followed sequentially by `activitypub.actor.getCollectionUri`, `activitypub.collection.add`, `ldp.remote.store`, and `activitypub.activity.attach` in pod-provider mode;
5. creates a native Bull `remotePost` job for every remote recipient;
6. only after those jobs are created emits `activitypub.outbox.posted` with `{ activity }` and no expanded recipient list;
7. processes `remotePost` by resolving the inbox, signing the request, and performing an HTTP POST.

The ActivityPods fork mixes `ActivityPubService` with `podProvider: true` and does not currently replace this outbox implementation.

The current custom `outbox-emitter` consumes `activitypub.outbox.posted`, filters local actors, resolves literal remote actors, and forwards targets to the sidecar. It does not expand ordinary followers collections itself.

The sidecar already supports target normalization, shared-inbox enrichment, delivery-URL deduplication, bounded worker concurrency, per-domain controls, retries, idempotency and DLQ handling.

## Immediate architectural consequences

- An `outbox.posted` listener is too late to suppress SemApps native remote jobs because those jobs have already been created.
- Directly addressed remote actors can be routed by both SemApps native delivery and the sidecar path.
- Ordinary follower-addressed posts currently depend on SemApps' recipient expansion because the custom emitter does not expand `/followers` itself.
- Local delivery is a separate Tier 1 performance problem and must not be routed through the Fedify sidecar.

## Authoritative documents

- `PHASES.md` — ordered implementation roadmap and exit gates.
- `CONTRACT.md` — cross-repo delivery-plan contract and ownership boundary.
- `INVARIANTS.md` — correctness, security, durability and rollback requirements.
- `STATUS.md` — live phase/slice status and paired PR tracking.
