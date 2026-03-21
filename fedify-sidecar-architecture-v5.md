# Fedify Sidecar Architecture v5

## Executive Summary

This document describes a production-ready federation sidecar for ActivityPods that:

1. Uses **Redis Streams** for Fedify's work queues (inbound/outbound processing)
2. Uses **RedPanda** for public activity event logs (NOT work queues)
3. Delegates all HTTP signing to **ActivityPods Signing API** (keys never leave)
4. Indexes public activities in **OpenSearch** via the Firehose

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL FEDIVERSE                                     │
│                                                                                  │
│   mastodon.social    lemmy.ml    pixelfed.social    gotosocial.example          │
│         │               │              │                    │                    │
└─────────┼───────────────┼──────────────┼────────────────────┼────────────────────┘
          │               │              │                    │
          │ HTTP POST /inbox (with Signature)                 │
          ▼               ▼              ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           FEDIFY SIDECAR                                         │
│                                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                      HTTP ENDPOINTS                                      │   │
│   │                                                                          │   │
│   │   POST /inbox              → Enqueue to fedify:inbound, return 202      │   │
│   │   POST /users/:id/inbox    → Enqueue to fedify:inbound, return 202      │   │
│   │   POST /webhook/outbox     → Receive ActivityPods commit events         │   │
│   │   GET  /health             → Health check                               │   │
│   │   GET  /metrics            → Prometheus metrics                         │   │
│   │                                                                          │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                      WORKERS                                             │   │
│   │                                                                          │   │
│   │   ┌─────────────────────┐       ┌─────────────────────┐                 │   │
│   │   │   INBOUND WORKER    │       │   OUTBOUND WORKER   │                 │   │
│   │   │                     │       │                     │                 │   │
│   │   │ • XAUTOCLAIM stuck  │       │ • XAUTOCLAIM stuck  │                 │   │
│   │   │ • XREADGROUP new    │       │ • XREADGROUP new    │                 │   │
│   │   │ • Verify signature  │       │ • Check notBeforeMs │                 │   │
│   │   │ • Apply policies    │       │ • Idempotency check │                 │   │
│   │   │ • Classify activity │       │ • Acquire dom slot  │                 │   │
│   │   │ • Route to streams  │       │ • Rate limit check  │                 │   │
│   │   │ • Forward to APods  │       │ • Call Signing API  │                 │   │
│   │   │ • XACK              │       │ • HTTP POST inbox   │                 │   │
│   │   │                     │       │ • Handle response   │                 │   │
│   │   │                     │       │ • XACK              │                 │   │
│   │   └─────────────────────┘       └─────────────────────┘                 │   │
│   │                                                                          │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
          │                                           │
          │ Redis Streams                             │ HTTP (Signing API)
          ▼                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              REDIS                                               │
│                                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                    REGULAR KEYS (Control Plane)                          │   │
│   │                                                                          │   │
│   │   idem:out:<hash>           → SET NX EX 7d (idempotency)                │   │
│   │   dom:inflight:<domain>     → INCR/DECR (concurrency slots)             │   │
│   │   dom:rate:<domain>:<min>   → fixed-window counter                      │   │
│   │   dom:sharedInbox:<domain>  → cached URL, TTL 24h                       │   │
│   │   actorDoc:<uri>            → cached actor document                     │   │
│   │   blocklist:<domain>        → policy cache                              │   │
│   │                                                                          │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                    STREAMS (Work Queues)                                 │   │
│   │                                                                          │   │
│   │   fedify:outbound           → delivery jobs                             │   │
│   │     └─ group: outbound-workers                                          │   │
│   │                                                                          │   │
│   │   fedify:inbound            → incoming activity processing              │   │
│   │     └─ group: inbound-workers                                           │   │
│   │                                                                          │   │
│   │   fedify:outbound:dlq       → exhausted/permanent failures              │   │
│   │   fedify:inbound:dlq        → invalid/poison inbound                    │   │
│   │                                                                          │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
          │
          │ Produce public activities
          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              REDPANDA                                            │
│                         (Event Logs, NOT Work Queues)                            │
│                                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │   apub.public.local.v1      │ 12 partitions │ key: actorUri            │   │
│   │   apub.public.remote.v1     │ 12 partitions │ key: originDomain        │   │
│   │   apub.public.firehose.v1   │ 24 partitions │ key: actorUri            │   │
│   │   apub.tombstone.v1         │ 12 partitions │ key: objectId (compacted)│   │
│   │   apub.delivery.results.v1  │ 12 partitions │ key: recipientDomain     │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
          │
          │ Consume firehose
          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              OPENSEARCH                                          │
│                                                                                  │
│   Index: activities                                                              │
│   • Full-text search on content                                                 │
│   • Aggregations by actor, type, domain                                         │
│   • Time-series queries                                                         │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                           ACTIVITYPODS                                           │
│                       (Authoritative Core)                                       │
│                                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                    SIGNING SERVICE                                       │   │
│   │                                                                          │   │
│   │   POST /api/internal/signatures/batch                                   │   │
│   │                                                                          │   │
│   │   • Validates actorUri is local                                         │   │
│   │   • Loads key via SemApps KeysService                                   │   │
│   │   • Generates HTTP Signature via SignatureService                       │   │
│   │   • Returns Date, Digest, Signature headers                             │   │
│   │   • KEYS NEVER LEAVE THIS SERVICE                                       │   │
│   │                                                                          │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                    OUTBOX EMITTER                                        │   │
│   │                                                                          │   │
│   │   Listens: activitypub.outbox.committed                                 │   │
│   │   Emits: POST /webhook/outbox to sidecar                                │   │
│   │                                                                          │   │
│   │   • Authoritative source of local activities                            │   │
│   │   • More reliable than watching outboxes                                │   │
│   │                                                                          │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                    LOCAL FEDERATION                                      │   │
│   │                                                                          │   │
│   │   Pod ←→ Pod via Moleculer (NO HTTP)                                    │   │
│   │   Sidecar does NOT interfere with local federation                      │   │
│   │                                                                          │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### Fedify Sidecar

| Component | Responsibility |
|-----------|----------------|
| HTTP Endpoints | Accept inbound activities, return 202, enqueue to Redis |
| Inbound Worker | Verify signatures, apply policies, route to streams/ActivityPods |
| Outbound Worker | Consume jobs, call Signing API, POST to remote inboxes |
| RedPanda Producer | Produce public activities to event log topics |

### Redis

| Component | Responsibility |
|-----------|----------------|
| Regular Keys | Idempotency, rate limiting, caching, concurrency control |
| Streams | Durable work queues with consumer groups and PEL |

### RedPanda

| Component | Responsibility |
|-----------|----------------|
| Event Log Topics | Durable, replayable log of public activities |
| NOT a work queue | No per-message ACK, no retry semantics |

### ActivityPods

| Component | Responsibility |
|-----------|----------------|
| Signing Service | Generate HTTP signatures (keys stay here) |
| Outbox Emitter | Emit events when activities are committed |
| Local Federation | Pod-to-pod via Moleculer (no HTTP) |

## Data Flows

### Outbound Flow (Local → Remote)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    OUTBOUND PROCESSING FLOW                                      │
│                                                                                  │
│   ActivityPods                                                                   │
│        │                                                                         │
│        │ Activity committed to outbox                                           │
│        │ Emits: activitypub.outbox.committed                                    │
│        ▼                                                                         │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                     OUTBOX EMITTER                                       │   │
│   │                                                                          │   │
│   │   POST /webhook/outbox to sidecar                                       │   │
│   │   Payload: { activity, recipients, actorUri }                           │   │
│   │                                                                          │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│        │                                                                         │
│        ▼                                                                         │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                     SIDECAR: JOB ENQUEUE                                 │   │
│   │                                                                          │   │
│   │   1. If public: Produce to apub.public.local.v1 (RedPanda)              │   │
│   │                                                                          │   │
│   │   2. For each unique inbox/sharedInbox:                                 │   │
│   │      XADD fedify:outbound MAXLEN ~ 200000 * job <job-json>              │   │
│   │                                                                          │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│        │                                                                         │
│        │ (async via Redis Stream)                                               │
│        ▼                                                                         │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                     OUTBOUND WORKER                                      │   │
│   │                                                                          │   │
│   │   1. XAUTOCLAIM fedify:outbound outbound-workers worker-X               │   │
│   │      60000 0-0 COUNT 64                                                 │   │
│   │      → Reclaim messages idle > 60s from dead workers                    │   │
│   │                                                                          │   │
│   │   2. XREADGROUP GROUP outbound-workers CONSUMER worker-X                │   │
│   │      COUNT 64 BLOCK 2000 STREAMS fedify:outbound >                      │   │
│   │      → Read NEW messages                                                │   │
│   │                                                                          │   │
│   │   For each job:                                                          │   │
│   │                                                                          │   │
│   │   3. Check notBeforeMs                                                  │   │
│   │      If future: XADD (requeue unchanged), XACK, continue                │   │
│   │                                                                          │   │
│   │   4. Idempotency check                                                  │   │
│   │      SET idem:out:<hash> NX EX 604800                                   │   │
│   │      If exists: XACK, continue (already delivered)                      │   │
│   │                                                                          │   │
│   │   5. Acquire domain slot                                                │   │
│   │      INCR dom:inflight:<domain>                                         │   │
│   │      If > maxConcurrentPerDomain:                                       │   │
│   │        DEL idem key, requeue with delay, XACK, continue                 │   │
│   │                                                                          │   │
│   │   6. Check rate limit                                                   │   │
│   │      INCR dom:rate:<domain>:<minute>                                    │   │
│   │      If > maxRequestsPerMinute:                                         │   │
│   │        DEL idem key, requeue with delay, XACK, continue                 │   │
│   │                                                                          │   │
│   │   7. Call ActivityPods Signing API                                      │   │
│   │      POST /api/internal/signatures/batch                                │   │
│   │      Get back: Date, Digest, Signature headers                          │   │
│   │                                                                          │   │
│   │   8. HTTP POST to inbox                                                 │   │
│   │      Include signed headers                                             │   │
│   │      Timeout: 15s                                                       │   │
│   │                                                                          │   │
│   │   9. Classify response                                                  │   │
│   │                                                                          │   │
│   │      SUCCESS (2xx):                                                     │   │
│   │      └─→ XACK, done                                                     │   │
│   │                                                                          │   │
│   │      RETRYABLE (429, 5xx, network error):                               │   │
│   │      ├─→ Increment job.attempt                                          │   │
│   │      ├─→ If attempt >= maxAttempts (8):                                 │   │
│   │      │     XADD fedify:outbound:dlq, XACK                               │   │
│   │      └─→ Else:                                                          │   │
│   │            job.notBeforeMs = now + backoffMs(attempt)                   │   │
│   │            XADD fedify:outbound (requeue), XACK                         │   │
│   │                                                                          │   │
│   │      PERMANENT (400, 401, 403, 404, 410):                               │   │
│   │      └─→ XADD fedify:outbound:dlq, XACK                                 │   │
│   │                                                                          │   │
│   │   10. Release domain slot                                               │   │
│   │       DECR dom:inflight:<domain>                                        │   │
│   │                                                                          │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Inbound Flow (Remote → Local)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    INBOUND PROCESSING FLOW                                       │
│                                                                                  │
│   Remote Server                                                                  │
│        │                                                                         │
│        │ POST /inbox                                                            │
│        │ Signature: keyId=...                                                   │
│        │ Digest: SHA-256=...                                                    │
│        │ Body: { Activity }                                                     │
│        ▼                                                                         │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                     SIDECAR: HTTP ENDPOINT                               │   │
│   │                                                                          │   │
│   │   1. Accept request                                                      │   │
│   │   2. XADD fedify:inbound MAXLEN ~ 100000 * env <envelope-json>          │   │
│   │   3. Return 202 Accepted                                                │   │
│   │                                                                          │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│        │                                                                         │
│        │ (async via Redis Stream)                                               │
│        ▼                                                                         │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                     INBOUND WORKER                                       │   │
│   │                                                                          │   │
│   │   1. XAUTOCLAIM fedify:inbound inbound-workers worker-X                 │   │
│   │      30000 0-0 COUNT 64                                                 │   │
│   │                                                                          │   │
│   │   2. XREADGROUP GROUP inbound-workers CONSUMER worker-X                 │   │
│   │      COUNT 64 BLOCK 2000 STREAMS fedify:inbound >                       │   │
│   │                                                                          │   │
│   │   For each envelope:                                                     │   │
│   │                                                                          │   │
│   │   3. Verify HTTP signature + digest                                     │   │
│   │      • Fetch actor document (cached in actorDoc:<uri>)                  │   │
│   │      • Validate key ownership                                           │   │
│   │      • Check digest matches body                                        │   │
│   │                                                                          │   │
│   │   4. Apply policies                                                      │   │
│   │      • Check domain blocklist                                           │   │
│   │      • Check actor blocklist                                            │   │
│   │      • Size limits                                                      │   │
│   │                                                                          │   │
│   │   5. Classify activity                                                  │   │
│   │                                                                          │   │
│   │      If PUBLIC:                                                          │   │
│   │      └─→ Produce to apub.public.remote.v1 (RedPanda)                   │   │
│   │                                                                          │   │
│   │      If ADDRESSED TO LOCAL ACTORS:                                      │   │
│   │      └─→ Forward to ActivityPods inbox receiver                        │   │
│   │          POST /api/internal/inbox/receive                               │   │
│   │                                                                          │   │
│   │      If DELETE/UNDO (tombstone):                                        │   │
│   │      └─→ Produce to apub.tombstone.v1 (RedPanda)                       │   │
│   │                                                                          │   │
│   │   6. XACK fedify:inbound inbound-workers <id>                           │   │
│   │                                                                          │   │
│   │   On permanent failure (bad signature, invalid schema):                 │   │
│   │   └─→ XADD fedify:inbound:dlq, then XACK                               │   │
│   │                                                                          │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Signing API Contract

### Endpoint

```
POST /api/internal/signatures/batch
Authorization: Bearer <token>
Content-Type: application/json
```

### Request Schema

```json
{
  "requests": [
    {
      "requestId": "01HZY...ULID",
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
    },
    {
      "requestId": "01HZY...other",
      "ok": false,
      "error": {
        "code": "ACTOR_NOT_LOCAL",
        "message": "actorUri is not controlled by this server"
      }
    }
  ]
}
```

### Error Codes

| Code | Retryable | Description |
|------|-----------|-------------|
| `ACTOR_NOT_LOCAL` | No | Actor not controlled by this server |
| `ACTOR_NOT_FOUND` | No | Actor deleted or doesn't exist |
| `KEY_NOT_FOUND` | No | No key material for actor |
| `AUTH_FAILED` | No | Sidecar not authorized |
| `INVALID_REQUEST` | No | Malformed request |
| `BODY_TOO_LARGE` | No | Activity exceeds size limit |
| `RATE_LIMITED` | Yes | Too many requests, back off |
| `INTERNAL_ERROR` | Yes | Transient server error |

### Limits

- `maxBatchSize`: 200-1000 requests per batch
- `maxBodyBytes`: 512KB per activity body

## Backoff Function

```typescript
function backoffMs(attempt: number): number {
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

## RedPanda Topic Configuration

### Topic Creation

```bash
# Public activity streams
rpk topic create apub.public.local.v1 \
  --partitions 12 \
  --config retention.ms=2592000000  # 30 days

rpk topic create apub.public.remote.v1 \
  --partitions 12 \
  --config retention.ms=2592000000

rpk topic create apub.public.firehose.v1 \
  --partitions 24 \
  --config retention.ms=2592000000

# Tombstone stream (compacted)
rpk topic create apub.tombstone.v1 \
  --partitions 12 \
  --config cleanup.policy=compact,delete \
  --config retention.ms=7776000000  # 90 days

# Delivery results (optional, for analytics)
rpk topic create apub.delivery.results.v1 \
  --partitions 12 \
  --config retention.ms=604800000  # 7 days
```

### Partition Keys

| Topic | Key | Rationale |
|-------|-----|-----------|
| `apub.public.local.v1` | `actorUri` | Per-actor ordering |
| `apub.public.remote.v1` | `originDomain` | Isolate noisy domains |
| `apub.public.firehose.v1` | `actorUri` | Consistent with local |
| `apub.tombstone.v1` | `objectId` | Ordered updates per object |
| `apub.delivery.results.v1` | `recipientDomain` | Per-domain analytics |

## Redis Configuration

### Stream Trimming

```
# On every XADD, use approximate trimming
XADD fedify:outbound MAXLEN ~ 200000 * job <json>
XADD fedify:inbound MAXLEN ~ 100000 * env <json>
```

### Consumer Group Setup

```bash
# Create consumer groups (idempotent)
XGROUP CREATE fedify:outbound outbound-workers 0 MKSTREAM
XGROUP CREATE fedify:inbound inbound-workers 0 MKSTREAM
```

### Key TTLs

| Key Pattern | TTL | Purpose |
|-------------|-----|---------|
| `idem:out:<hash>` | 7 days | Idempotency |
| `dom:sharedInbox:<domain>` | 24 hours | SharedInbox cache |
| `actorDoc:<uri>` | 1 hour | Actor document cache |
| `dom:rate:<domain>:<minute>` | 2 minutes | Rate limit window |

## Metrics

### Prometheus Metrics

```typescript
// Outbound
fedify_outbound_enqueued_total{actor}
fedify_outbound_delivered_total{domain, status}
fedify_outbound_retries_total{domain, attempt}
fedify_outbound_dlq_total{domain, reason}
fedify_outbound_latency_seconds{domain}

// Inbound
fedify_inbound_received_total{domain}
fedify_inbound_processed_total{domain, status}
fedify_inbound_signature_failures_total{domain, reason}
fedify_inbound_dlq_total{reason}

// Queue health
fedify_stream_pending_count{stream}
fedify_stream_lag_seconds{stream}

// Signing API
fedify_signing_requests_total{status}
fedify_signing_latency_seconds

// Domain throttling
fedify_domain_inflight{domain}
fedify_domain_rate_limited_total{domain}
```

## Deployment

### Docker Compose

See `docker-compose.yml` for a complete deployment including:

- Fedify Sidecar
- Redis 7+
- RedPanda
- OpenSearch
- Prometheus + Grafana

### Health Checks

```
GET /health
→ 200 if Redis and RedPanda are reachable

GET /ready
→ 200 if consumer groups are active and processing
```

### Graceful Shutdown

1. Stop accepting new HTTP requests
2. Stop claiming new messages (XREADGROUP)
3. Finish processing in-flight jobs
4. Release domain slots
5. Exit

## Security

### Transport Security

- Sidecar ↔ ActivityPods: mTLS or private network
- Signing API: Bearer token + IP allowlist
- Redis: AUTH + TLS in production
- RedPanda: SASL/SCRAM + TLS in production

### Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    TRUST BOUNDARIES                                              │
│                                                                                  │
│   ActivityPods (Authoritative):                                                 │
│   • Stores private keys                                                         │
│   • Signs HTTP requests on demand                                               │
│   • Validates actor ownership                                                   │
│   • Controls what gets published                                                │
│                                                                                  │
│   Fedify Sidecar (Executor):                                                    │
│   • Processes delivery queue                                                    │
│   • Requests signatures from ActivityPods                                       │
│   • Never sees private keys                                                     │
│   • Handles HTTP mechanics + retries                                            │
│                                                                                  │
│   Redis (Work Queue):                                                            │
│   • Stores job state                                                            │
│   • No keys, no sensitive content                                               │
│   • Just "deliver X to Y, attempt N"                                            │
│                                                                                  │
│   RedPanda (Event Log):                                                          │
│   • Stores public activities only                                               │
│   • No keys, no private data                                                    │
│   • Multiple consumers read independently                                       │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```
