# Key Corrections from Feedback Document

## Critical Architecture Changes Required

### 1. Queue Architecture Split
- **Redis** = Fedify's message queue (inbound/outbound work queues)
- **RedPanda** = Streaming backbone for public activities (logs, not work queues)
- **DO NOT** use RedPanda as Fedify's MessageQueue - use Redis Streams instead

### 2. Signing API Contract (Formal)
- **Batch signing endpoint**: `signing.signHttpRequestsBatch`
- **Profiles**: `ap_get_v1`, `ap_post_v1`, `ap_post_v1_ct`
- **keyId**: MUST be signer-controlled (never hardcoded by sidecar)
- **Digest modes**: `server_compute` (preferred) vs `caller_provided_strict`
- **Immutability**: Body bytes used for signing MUST be identical to bytes sent

### 3. Redis Streams Design
Streams:
- `fedify:inbound` - Raw inbound envelopes
- `fedify:inbound:dlq` - Inbound permanent failures
- `fedify:outbound` - Delivery jobs (fanned-out by domain)
- `fedify:outbound:dlq` - Delivery jobs exhausted retries

Consumer groups:
- `inbound-workers` on `fedify:inbound`
- `outbound-workers` on `fedify:outbound`

Worker algorithm:
1. XAUTOCLAIM stuck messages (recovery)
2. XREADGROUP new messages
3. Process, then XACK (even on failure to avoid poison pills)
4. On failure: increment attempt, compute backoff, XADD new job, XACK original

### 4. RedPanda Topics (Pure Logs)
Topics:
- `apub.public.local.v1` - 12 partitions (local public activities)
- `apub.public.remote.v1` - 12 partitions (remote public activities)
- `apub.public.firehose.v1` - 24 partitions (combined for indexing)
- `apub.tombstone.v1` - 12 partitions (deletes, use compaction)
- `apub.delivery.dlq.v1` - 12 partitions (delivery failures for audit)

Partition keys:
- Delivery: `recipientDomain`
- Local public: `actorUri` or `podDataset`
- Remote public: `originDomain`
- Tombstone: `objectId`

### 5. Delivery Job Schema
```json
{
  "schema": "ap.delivery.job.v1",
  "jobId": "ULID",
  "actor": { "actorUri": "...", "keyHint": { "profile": "ap_post_v1" } },
  "recipient": { "host": "...", "inboxUrl": "...", "sharedInboxUrl": "..." },
  "activity": { "activityId": "...", "objectId": "...", "type": "...", "payload": {...} },
  "delivery": { "httpMethod": "POST", "headersProfile": "ap_post_v1" },
  "attempt": { "count": 0, "max": 8 },
  "idempotency": { "key": "sha256(activityId|recipientInboxUrl)" }
}
```

### 6. Retry Tiers
| Attempt | Delay |
|---------|-------|
| 1 | 1 minute |
| 2 | 5 minutes |
| 3 | 30 minutes |
| 4 | 2 hours |
| 5 | 12 hours |
| 6-8 | 48 hours then DLQ |

### 7. Idempotency
- Key: `sha256(actorUri | inboxUrl | activityId)`
- Store in Redis with TTL (7 days)
- `SET key value NX EX ttlSeconds` before sending
- Skip if exists, XACK the job

### 8. Per-Domain Throttling
- Token bucket: `rate:domain:<domain>:tokens`
- Inflight counter: `inflight:domain:<domain>`
- Prevents one bad domain from starving others

### 9. Stream1 Emit Contract (ActivityPods)
```json
{
  "schema": "ap.outbox.committed.v1",
  "eventId": "ULID",
  "actorUri": "...",
  "activity": { "ActivityStreams JSON" },
  "deliveryTargets": [
    { "recipientHost": "...", "inboxUrl": "...", "sharedInboxUrl": "..." }
  ],
  "meta": { "isPublicIndexable": true, "isDeleteOrTombstone": false }
}
```

### 10. What to Remove/Change
- Remove "RedPandaMessageQueue implements Fedify MessageQueue"
- Remove "signature caching" - replace with:
  - Batch signing via ActivityPods Signing API
  - Cache actor docs / sharedInbox discovery
  - Cache public keyId mapping
- Remove "Aggregator watches outboxes via Solid Notifications" - replace with:
  - Primary: ActivityPods emits `activitypub.outbox.committed` events
  - Optional: watcher-based reconciliation (safety net)
