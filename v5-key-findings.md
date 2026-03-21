# V5 Key Findings from Specification Documents

## Core Architecture Decision: Redis for Work Queues, RedPanda for Event Logs

### Why Redis Streams for Fedify's Internal Queue

| Characteristic | Work Queue (Redis) | Event Log (RedPanda) |
|----------------|-------------------|----------------------|
| Mental model | "Do this task" | "This happened" |
| Message lifecycle | Removed on success | Retained until expiry |
| Acknowledgment | Per-message ACK | Offset commit |
| Failure handling | Return to queue, retry | Consumer must handle |
| Multiple consumers | Competing (one wins) | Independent (all see everything) |
| Replay | Not the point | Core feature |

### Redis Streams Primitives

- **XADD**: Add message to stream
- **XREADGROUP**: Read messages as consumer in group
- **XACK**: Acknowledge message (remove from PEL)
- **XAUTOCLAIM**: Reclaim stuck messages from dead workers
- **PEL (Pending Entries List)**: Tracks in-flight messages

### Redis Keyspace Layout

```
REGULAR KEYS (Control Plane):
  idem:out:<hash>           → SET NX EX 7d (idempotency)
  dom:inflight:<domain>     → INCR/DECR (concurrency slots)
  dom:rate:<domain>:<min>   → fixed-window counter
  dom:sharedInbox:<domain>  → cached URL, TTL 24h
  actorDoc:<uri>            → cached actor document
  blocklist:<domain>        → policy cache

STREAMS (Work Queues):
  fedify:outbound           → delivery jobs
    └─ group: outbound-workers
  fedify:inbound            → incoming activity processing
    └─ group: inbound-workers
  fedify:outbound:dlq       → exhausted/permanent failures
  fedify:inbound:dlq        → invalid/poison inbound
```

## Signing API Contract (Updated)

### Request Schema

```json
{
  "requests": [
    {
      "requestId": "01HZY...ULID-or-UUID",
      "actorUri": "https://pods.example/users/alice",
      "method": "POST",
      "targetUrl": "https://remote.example/users/bob/inbox",
      "headers": {
        "content-type": "application/activity+json",
        "accept": "application/activity+json"
      },
      "body": "{\"@context\":\"https://www.w3.org/ns/activitystreams\", ... }",
      "options": {
        "requireDigest": true,
        "signatureHeaders": ["(request-target)", "host", "date", "digest"]
      }
    }
  ]
}
```

### Response Schema

```json
{
  "results": [
    {
      "requestId": "01HZY...same",
      "ok": true,
      "signedHeaders": {
        "date": "Sat, 03 Jan 2026 18:22:10 GMT",
        "digest": "SHA-256=....",
        "signature": "keyId=\"...\",algorithm=\"rsa-sha256\",headers=\"(request-target) host date digest\",signature=\"...\""
      }
    }
  ]
}
```

### Error Codes (Stable Contract)

- `ACTOR_NOT_LOCAL` - Wrong sidecar, shouldn't happen
- `ACTOR_NOT_FOUND` - Actor deleted, stop trying
- `KEY_NOT_FOUND` - No key material, can't sign
- `AUTH_FAILED` - Sidecar not authorized
- `INVALID_REQUEST` - Bug in job construction
- `BODY_TOO_LARGE` - Activity too big
- `RATE_LIMITED` - ActivityPods protecting itself (retryable)
- `INTERNAL_ERROR` - Transient (retryable)

### Limits (MUST enforce)

- maxBatchSize: 200-1000
- maxBodyBytes: 512KB

## Backoff Function (Mastodon-Compatible)

```javascript
function backoffMs(attempt) {
  const base =
    attempt === 1 ? 60_000 :           // 1 min
    attempt === 2 ? 5 * 60_000 :       // 5 min
    attempt === 3 ? 30 * 60_000 :      // 30 min
    attempt === 4 ? 2 * 60 * 60_000 :  // 2 hours
    attempt === 5 ? 12 * 60 * 60_000 : // 12 hours
    48 * 60 * 60_000;                  // 48 hours (cap)

  // Jitter: [0.5x, 1.0x] prevents thundering herd
  const jitter = 0.5 + Math.random() * 0.5;
  return Math.floor(base * jitter);
}
```

## RedPanda Topics

| Topic | Partitions | Key | Purpose |
|-------|------------|-----|---------|
| `apub.public.local.v1` | 12 | podDataset or actorUri | Local public activities |
| `apub.public.remote.v1` | 12 | originDomain | Remote public activities |
| `apub.public.firehose.v1` | 24 | same as source | Combined for indexing |
| `apub.tombstone.v1` | 12 | objectId | Deletes (compacted) |
| `apub.delivery.results.v1` | 12 | recipientDomain | Delivery results (optional) |

### Retention Policies

- Public topics: `cleanup.policy=delete`, `retention.ms=7-30 days`
- Tombstone topic: `cleanup.policy=compact,delete`

## Outbound Worker Flow

1. XAUTOCLAIM (reclaim stuck jobs from dead workers)
2. XREADGROUP (get new jobs)
3. Check notBeforeMs - if future: requeue, XACK, continue
4. Idempotency check - SET idem:out:<hash> NX EX 7d
5. Acquire domain slot - INCR dom:inflight:<domain>
6. Check rate limit - dom:rate:<domain>:<minute>
7. Sign request - Call ActivityPods Signing API
8. HTTP POST to inbox
9. Classify response:
   - SUCCESS (2xx): XACK, done
   - RETRYABLE (429, 5xx, network): increment attempt, requeue with backoff or DLQ
   - PERMANENT (400, 401, 403, 404, 410): DLQ, XACK
10. Release domain slot - DECR dom:inflight:<domain>

## Inbound Worker Flow

1. XREADGROUP from fedify:inbound
2. Verify HTTP signature + digest
3. Apply policies (blocklist, size limits)
4. Classify activity:
   - If PUBLIC: Publish to apub.public.remote.v1
   - If ADDRESSED TO LOCAL: Forward to ActivityPods
   - If DELETE/UNDO: Publish to apub.tombstone.v1
5. XACK fedify:inbound

## Critical Correctness Notes

1. **Idempotency key must be undone if you don't actually send**
   ```javascript
   await redis.del(idemKey);  // IMPORTANT: undo reservation
   ```

2. **Always XACK after requeue/DLQ**
   ```javascript
   await requeueOutbound(job);
   await xack(stream, group, messageId);  // MUST do this
   ```

3. **Stream trimming to bound memory**
   ```javascript
   XADD fedify:outbound MAXLEN ~ 200000 * job <json>
   ```

## Fedify's nativeRetrial Flag

- `nativeRetrial = false` for Redis Streams
- Fedify tracks retry count and decides "should retry" vs "permanent failure"
- YOU decide how long to wait before retry
- YOU implement the delay mechanism

## ActivityPods Integration

### Primary Event Source (NOT watching outboxes)

- ActivityPods emits `activitypub.outbox.committed` event
- Sidecar receives via webhook/Moleculer
- This is more reliable than watching outboxes

### Signing Service Implementation

- Use SemApps KeysService for key management
- Use SemApps SignatureService for signature generation
- Enforce local actor ownership before signing
