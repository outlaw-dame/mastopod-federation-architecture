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

## Proposed v1 shape

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
    searchConsent?: unknown;
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

The exact serialized schema is finalized in APDM-P1; this document defines ownership and required semantics, not the final wire format.

## Contract rules

1. Recipient expansion MUST happen once at the ActivityPods authority boundary for an ActivityPods-originated Activity.
2. A `/followers` collection URI MUST NOT be treated as an actor delivery target by the sidecar.
3. The sidecar MAY enrich a remote target with `sharedInboxUrl`, but MUST NOT change the logical recipient set.
4. Local recipients MUST NOT be routed through the internet-facing Fedify path.
5. The sidecar MUST deduplicate execution by final delivery URL after sharedInbox enrichment.
6. Activity payload bytes used for signing/delivery MUST be immutable once an outbound job is created.
7. Duplicate delivery-plan handoff MUST be safe and idempotent.
8. External mode MUST prevent SemApps native `remotePost` jobs from being created; cancellation-after-enqueue is not an accepted suppression design.
9. Native mode MUST remain available as a tested rollback path until the cleanup phase.
10. Contract-version incompatibility MUST fail closed rather than silently falling back to raw recipient inference.
