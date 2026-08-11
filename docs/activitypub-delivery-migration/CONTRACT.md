# Delivery Plan Contract

## Ownership boundary

ActivityPods is authoritative for data and semantics that require local knowledge of WebIDs, Pods, datasets, LDP/WebACL state, and SemApps recipient expansion. The federation sidecar is authoritative for remote execution semantics after durable handoff.

### ActivityPods produces

- persisted Activity identifier and outbound Activity payload;
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
3. Every concrete actor explicitly addressed in `to`, `bto`, `cc`, `bcc`, or `audience` MUST be represented by the authoritative recipient plan, except Public aliases and the sender's own followers collection. Sender-followers expressed through `audience` MUST fail closed until authoritative audience expansion exists.
4. `bto` and `bcc` are routing-only inputs. They MUST be stripped from the outbound Activity before it enters the Delivery Plan, including nested object values, and a consumer MUST reject any Delivery Plan whose outbound `activity` still contains `bto` or `bcc`.
5. The sidecar MAY enrich a remote target with `sharedInboxUrl`, but MUST NOT change the logical recipient set.
6. Local recipients MUST NOT be routed through the internet-facing Fedify path.
7. Execution endpoints (`inboxUri`, `inboxUrl`, `sharedInboxUrl`) MUST be fragment-free HTTP(S) URLs without embedded credentials, whitespace, or ASCII control characters.
8. `targetDomain` MUST be the canonical lowercase hostname of the effective delivery URL (shared inbox when present, otherwise inbox), with DNS trailing-dot aliases removed. Domain-keyed blocking, rate limiting, concurrency and telemetry MUST use this canonical value.
9. Local dataset identifiers and domain authority tokens MUST be non-empty and free of whitespace/control-character ambiguity.
10. The serialized contract is JSON. Contract fingerprinting MUST fail closed on unsupported non-JSON values rather than mapping different runtime values to an ambiguous canonical representation.
11. The sidecar MUST deduplicate execution by final delivery URL after sharedInbox enrichment.
12. Activity payload bytes used for signing/delivery MUST be immutable once an outbound job is created.
13. Duplicate delivery-plan handoff MUST be safe and idempotent.
14. External mode MUST prevent SemApps native `remotePost` jobs from being created; cancellation-after-enqueue is not an accepted suppression design.
15. Native mode MUST remain available as a tested rollback path until the cleanup phase.
16. Contract-version incompatibility MUST fail closed rather than silently falling back to raw recipient inference.

## Blind-address privacy boundary

Exact SemApps 1.1.4 recipient discovery scans `to`, `bto`, `cc`, and `bcc`, but the native outbox path then carries the same Activity onward. APDM therefore cannot treat the persisted/native Activity bytes as automatically safe outbound bytes when blind addressing is present.

For APDM external delivery, ActivityPods must use the unsanitized source Activity only for authoritative recipient planning, then construct the Delivery Plan with a sanitized outbound Activity in which `bto` and `bcc` are absent recursively. The sidecar independently rejects leaked blind-address fields as defense in depth.

This Delivery Plan rule fixes the future external/Fedify boundary. It does **not** by itself repair SemApps native/local persistence and delivery behavior. That remaining ActivityPods/SemApps blind-address exposure is a pre-Phase-5 privacy blocker and must be addressed or proven unreachable before production cutover.

## Audience compatibility boundary

ActivityPub delivery semantics include `audience`, while exact SemApps 1.1.4 `activitypub.activity.getRecipients` scans only `to`, `bto`, `cc`, and `bcc`. APDM therefore fails closed rather than silently dropping concrete `audience` recipients. In particular, a sender-followers collection expressed through `audience` is rejected until an authoritative expansion path exists.

## Network-security boundary

Delivery Plan validation is a semantic/wire-contract boundary, not a complete SSRF defense. Accepting a syntactically safe HTTP(S) hostname does not authorize its resolved IP address. DNS resolution, private/link-local/loopback address policy, redirect policy and DNS-rebinding protection remain execution-layer responsibilities and must be enforced by the sidecar before Phase 5 makes it authoritative for external HTTP.
