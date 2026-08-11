# Delivery Plan Contract

## Ownership boundary

ActivityPods is authoritative for data and semantics that require local knowledge of WebIDs, Pods, datasets, LDP/WebACL state, and SemApps recipient expansion. The federation sidecar is authoritative for remote execution semantics after durable handoff.

### ActivityPods produces

- persisted Activity identifier and immutable Activity payload;
- authoritative actor URI;
- recipient expansion result;
- local/remote recipient classification;
- local dataset and inbox metadata;
- remote actor URI and known inbox/shared-inbox metadata;
- visibility and policy metadata required by downstream federation;
- a stable delivery intent identifier/idempotency basis.

### Federation sidecar consumes and owns

- validation/normalization of remote targets;
- sharedInbox enrichment when the producer did not supply one;
- deduplication by actual delivery URL;
- durable outbound-job creation;
- per-domain rate limiting and concurrency;
- HTTP signing orchestration using ActivityPods-held keys/signing APIs;
- external HTTP delivery;
- retry/backoff, idempotency, DLQ and delivery telemetry.

## v1 shape

```ts
export interface ActivityPubDeliveryPlanV1 {
  schema: 'ap.delivery-plan.v1';
  intentId: string;
  activityId: string;
  actorUri: string;
  activity: Record<string, unknown>;
  localRecipients: LocalDeliveryTargetV1[];
  remoteRecipients: RemoteDeliveryTargetV1[];
  meta: {
    visibility: 'public' | 'unlisted' | 'followers' | 'direct';
    isPublicActivity: boolean;
    isPublicIndexable?: boolean;
    searchConsent?: Record<string, unknown> | null;
  };
}

export interface LocalDeliveryTargetV1 {
  actorUri: string;
  dataset: string;
  inboxUri: string;
}

export interface RemoteDeliveryTargetV1 {
  actorUri: string;
  inboxUrl: string;
  sharedInboxUrl?: string;
  targetDomain: string;
}
```

The exact serialized schema is pinned in both repositories and is guarded by cross-repo fixture/schema fingerprints.

## Contract rules

1. Recipient expansion MUST happen once at the ActivityPods authority boundary for an ActivityPods-originated Activity.
2. The sender's own unresolved followers collection MUST NOT be treated as a concrete actor delivery target. An unrelated legitimate actor URI merely ending in `/followers` is not a followers collection by name alone.
3. Every concrete actor explicitly addressed in `to`, `bto`, `cc`, or `bcc` MUST be present in the Delivery Plan recipient set. Public aliases and the sender's own followers collection are excluded from this subset check because Public is not an actor target and follower members are expanded by ActivityPods.
4. The sidecar MAY enrich a remote target with `sharedInboxUrl`, but MUST NOT change the logical recipient set.
5. Local recipients MUST NOT be routed through the internet-facing Fedify path.
6. Execution endpoints (`inboxUri`, `inboxUrl`, `sharedInboxUrl`) MUST be fragment-free HTTP(S) URLs without embedded credentials, whitespace, or ASCII control characters.
7. `targetDomain` MUST be the canonical lowercase hostname of the effective delivery URL (shared inbox when present, otherwise inbox), with DNS trailing-dot aliases removed. Domain-keyed blocking, rate limiting, concurrency and telemetry MUST use this canonical value.
8. Local dataset identifiers and domain authority tokens MUST be non-empty and free of whitespace/control-character ambiguity.
9. The serialized contract is JSON. Contract fingerprinting MUST fail closed on unsupported non-JSON values rather than mapping different runtime values to an ambiguous canonical representation.
10. The sidecar MUST deduplicate execution by final delivery URL after sharedInbox enrichment.
11. Activity payload bytes used for signing/delivery MUST be immutable once an outbound job is created.
12. Duplicate delivery-plan handoff MUST be safe and idempotent.
13. External mode MUST prevent SemApps native `remotePost` jobs from being created; cancellation-after-enqueue is not an accepted suppression design.
14. Native mode MUST remain available as a tested rollback path until the cleanup phase.
15. Contract-version incompatibility MUST fail closed rather than silently falling back to raw recipient inference.

## Network-security boundary

Delivery Plan validation is a semantic/wire-contract boundary, not a complete SSRF defense. Accepting a syntactically safe HTTP(S) hostname does not authorize its resolved IP address. DNS resolution, private/link-local/loopback address policy, redirect policy and DNS-rebinding protection remain execution-layer responsibilities and must be enforced by the sidecar before Phase 5 makes it authoritative for external HTTP.
