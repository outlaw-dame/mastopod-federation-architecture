# Fedify Sidecar Architecture v4

## Executive Summary

This document describes the revised architecture for the Fedify sidecar that enables high-performance ActivityPub federation for ActivityPods while keeping all private keys and authoritative data within ActivityPods. The key architectural decisions are:

1. **Redis Streams** for Fedify's work queues (inbound/outbound processing)
2. **RedPanda** for public activity streams (logs for indexing, not work queues)
3. **ActivityPods Signing API** for HTTP signature generation (keys never leave ActivityPods)
4. **OpenSearch** for queryable storage of public activities

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL FEDIVERSE                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ HTTP (ActivityPub)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TRAEFIK / NGINX                                 │
│                         (Reverse Proxy / Load Balancer)                      │
└─────────────────────────────────────────────────────────────────────────────┘
                    │                                    │
                    │ /inbox, /.well-known/*             │ /users/*, /api/*
                    ▼                                    ▼
┌─────────────────────────────────┐    ┌─────────────────────────────────────┐
│        FEDIFY SIDECAR           │    │           ACTIVITYPODS              │
│                                 │    │                                     │
│  ┌───────────────────────────┐  │    │  ┌─────────────────────────────┐   │
│  │   Inbound Handler         │  │    │  │   Signing Service           │   │
│  │   - Receive POST /inbox   │  │    │  │   - signing.signHttpReqs    │   │
│  │   - Signature verification│  │    │  │   - Keys stay in APods      │   │
│  │   - Enqueue to Redis      │  │    │  │   - Cavage-style signatures │   │
│  └───────────────────────────┘  │    │  └─────────────────────────────┘   │
│              │                  │    │              ▲                      │
│              ▼                  │    │              │ Batch Sign API       │
│  ┌───────────────────────────┐  │    │              │                      │
│  │   Redis Streams           │◄─┼────┼──────────────┤                      │
│  │   - fedify:inbound        │  │    │              │                      │
│  │   - fedify:outbound       │  │    │  ┌─────────────────────────────┐   │
│  │   - fedify:*:dlq          │  │    │  │   Outbox Emitter            │   │
│  └───────────────────────────┘  │    │  │   - Emit outbox.committed   │   │
│              │                  │    │  │   - Resolve delivery targets│   │
│              ▼                  │    │  └─────────────────────────────┘   │
│  ┌───────────────────────────┐  │    │              │                      │
│  │   Delivery Worker         │  │    │              │ Moleculer Event      │
│  │   - Consume outbound jobs │  │    │              ▼                      │
│  │   - Call Signing API      │──┼────┼──────────────►                      │
│  │   - POST to remote inbox  │  │    │                                     │
│  │   - Retry with backoff    │  │    │  ┌─────────────────────────────┐   │
│  │   - Idempotency via Redis │  │    │  │   Local Federation          │   │
│  └───────────────────────────┘  │    │  │   (Moleculer, no HTTP)      │   │
│              │                  │    │  └─────────────────────────────┘   │
│              ▼                  │    │                                     │
│  ┌───────────────────────────┐  │    └─────────────────────────────────────┘
│  │   RedPanda Producer       │  │
│  │   - Stream1 (local pub)   │  │
│  │   - Stream2 (remote pub)  │  │
│  │   - Firehose (combined)   │  │
│  │   - Tombstones            │  │
│  └───────────────────────────┘  │
│              │                  │
└──────────────┼──────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              REDPANDA CLUSTER                                │
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │
│  │ apub.public.    │  │ apub.public.    │  │ apub.public.    │              │
│  │ local.v1        │  │ remote.v1       │  │ firehose.v1     │              │
│  │ (Stream1)       │  │ (Stream2)       │  │ (Combined)      │              │
│  │ 12 partitions   │  │ 12 partitions   │  │ 24 partitions   │              │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘              │
│                                                                              │
│  ┌─────────────────┐                                                         │
│  │ apub.tombstone  │                                                         │
│  │ .v1             │                                                         │
│  │ 12 partitions   │                                                         │
│  │ (compacted)     │                                                         │
│  └─────────────────┘                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
               │
               │ Consume
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           OPENSEARCH CLUSTER                                 │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    activities index                                  │    │
│  │  - Firehose consumer indexes all public activities                   │    │
│  │  - Tombstone consumer marks deletions                                │    │
│  │  - Full-text search, faceted queries                                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### 1. Fedify Sidecar

The sidecar handles all **remote** HTTP federation. It does NOT interfere with local pod-to-pod communication, which uses Moleculer internally.

| Component | Responsibility |
|-----------|----------------|
| **Inbound Handler** | Receives HTTP POST to /inbox, verifies signatures, enqueues to Redis |
| **Delivery Worker** | Consumes outbound jobs, calls Signing API, POSTs to remote inboxes |
| **Redis Streams** | Work queues for inbound/outbound processing with at-least-once delivery |
| **RedPanda Producer** | Produces public activities to streams for indexing |

### 2. ActivityPods

ActivityPods remains **authoritative** for:
- Actor keys (private keys never leave)
- Local federation (Moleculer, no HTTP)
- Outbox commits (emits events for sidecar)
- Actor documents and WebFinger

| Component | Responsibility |
|-----------|----------------|
| **Signing Service** | Batch HTTP signature generation via `signing.signHttpRequestsBatch` |
| **Outbox Emitter** | Emits `activitypub.outbox.committed` events when activities are posted |
| **Local Federation** | Pod-to-pod communication via Moleculer (no HTTP) |

### 3. Redis

Redis serves as Fedify's **work queue** (NOT RedPanda).

| Stream | Purpose |
|--------|---------|
| `fedify:inbound` | Raw inbound envelopes for processing |
| `fedify:outbound` | Delivery jobs (fanned out by domain) |
| `fedify:inbound:dlq` | Permanent inbound failures |
| `fedify:outbound:dlq` | Permanent delivery failures |

### 4. RedPanda

RedPanda serves as the **streaming backbone** for public activities (logs, not work queues).

| Topic | Partitions | Key | Purpose |
|-------|------------|-----|---------|
| `apub.public.local.v1` | 12 | actorUri | Local public activities (Stream1) |
| `apub.public.remote.v1` | 12 | originDomain | Remote public activities (Stream2) |
| `apub.public.firehose.v1` | 24 | varies | Combined for indexing |
| `apub.tombstone.v1` | 12 | objectId | Deletes (compacted) |

### 5. OpenSearch

OpenSearch stores the **queryable firehose** of all public activities.

## Data Flows

### Outbound Flow (Local → Remote)

```
1. User posts activity to outbox
2. ActivityPods commits to outbox (authoritative)
3. ActivityPods emits `activitypub.outbox.committed` event
4. Sidecar receives event via webhook
5. Sidecar produces to Stream1 (if public)
6. Sidecar creates delivery jobs in Redis (per recipient domain)
7. Delivery worker consumes job
8. Delivery worker builds deterministic body bytes
9. Delivery worker calls Signing API (batch)
10. ActivityPods returns signed headers (Date, Digest, Signature)
11. Delivery worker POSTs to remote inbox with signed headers
12. On success: mark idempotency key, ack job
13. On failure: requeue with backoff or move to DLQ
```

### Inbound Flow (Remote → Local)

```
1. Remote server POSTs to /inbox
2. Sidecar receives request
3. Sidecar enqueues envelope to Redis
4. Sidecar returns 202 Accepted
5. Inbound worker consumes envelope
6. Inbound worker verifies HTTP signature
7. If public: produce to Stream2 and Firehose
8. If delete: produce to Tombstone topic
9. Forward to ActivityPods for local delivery
10. Ack message
```

## Signing API Contract

The Signing API is the formal contract between the sidecar and ActivityPods.

### Endpoint

```
POST /api/internal/signatures/batch
Authorization: Bearer <token>
```

### Request Schema

```json
{
  "requests": [
    {
      "requestId": "01J...ULID",
      "actorUri": "https://pods.example/users/alice",
      "method": "POST",
      "target": {
        "host": "remote.example",
        "port": 443,
        "path": "/inbox",
        "query": ""
      },
      "headers": {
        "date": "Tue, 06 Jan 2026 16:00:00 GMT",
        "contentType": "application/activity+json"
      },
      "body": {
        "encoding": "utf8",
        "bytes": "{...exact JSON bytes...}"
      },
      "digest": {
        "mode": "server_compute"
      },
      "profile": "ap_post_v1"
    }
  ]
}
```

### Response Schema

```json
{
  "results": [
    {
      "requestId": "01J...ULID",
      "ok": true,
      "actorUri": "https://pods.example/users/alice",
      "profile": "ap_post_v1",
      "signedComponents": {
        "method": "POST",
        "path": "/inbox",
        "host": "remote.example"
      },
      "outHeaders": {
        "Date": "Tue, 06 Jan 2026 16:00:00 GMT",
        "Digest": "SHA-256=base64...",
        "Signature": "keyId=\"...\",algorithm=\"rsa-sha256\",headers=\"(request-target) host date digest\",signature=\"...\""
      },
      "meta": {
        "keyId": "https://pods.example/users/alice#main-key",
        "algorithm": "rsa-sha256",
        "signedHeaders": "(request-target) host date digest",
        "bodySha256Base64": "..."
      }
    }
  ]
}
```

### Signing Profiles

| Profile | Signed Headers | Use Case |
|---------|----------------|----------|
| `ap_get_v1` | `(request-target) host date` | Secure mode fetches |
| `ap_post_v1` | `(request-target) host date digest` | Inbox delivery |
| `ap_post_v1_ct` | `(request-target) host date digest content-type` | Extended compatibility |

### Critical Invariants

1. **keyId is signer-controlled**: ActivityPods determines keyId from actor document, not caller
2. **Digest is computed by signer**: Prevents signed/body mismatch bugs
3. **Body bytes are immutable**: Bytes signed MUST equal bytes sent
4. **Local actor enforcement**: Signer rejects non-local actors

## Redis Streams Worker Algorithm

### Consumer Loop

```typescript
while (!shuttingDown) {
  // Step 1: Reclaim stuck messages (crash recovery)
  const claimed = await redis.xAutoClaim(stream, group, consumer, minIdleMs, "0-0");
  for (const msg of claimed.messages) {
    yield msg;
  }
  
  // Step 2: Read new messages
  const messages = await redis.xReadGroup(group, consumer, stream, ">", { BLOCK: 5000 });
  for (const msg of messages) {
    yield msg;
  }
}
```

### Message Processing

```typescript
for await (const { messageId, job } of consumeOutbound()) {
  // Idempotency check
  const key = idempotencyKey(job.actorUri, job.inboxUrl, job.activityId);
  if (!await checkAndSetIdempotency(key)) {
    await ack(messageId);  // Skip duplicate
    continue;
  }
  
  // Process
  const result = await deliverWithSigning(job);
  
  if (result.ok) {
    await markDelivered(key);
    await ack(messageId);
  } else if (isRetryable(result) && job.attempt < maxAttempts) {
    await requeueForRetry(job);  // New message with incremented attempt
    await ack(messageId);        // Ack original to prevent PEL buildup
  } else {
    await moveToDlq(job, result.error);
    await ack(messageId);
  }
}
```

### Retry Tiers

| Attempt | Delay |
|---------|-------|
| 1 | 1 minute |
| 2 | 5 minutes |
| 3 | 30 minutes |
| 4 | 2 hours |
| 5 | 12 hours |
| 6-8 | 48 hours, then DLQ |

## RedPanda Topic Configuration

### Topic Creation Commands

```bash
# Stream1: Local public activities
rpk topic create apub.public.local.v1 \
  --partitions 12 \
  --config retention.ms=604800000 \
  --config cleanup.policy=delete

# Stream2: Remote public activities
rpk topic create apub.public.remote.v1 \
  --partitions 12 \
  --config retention.ms=604800000 \
  --config cleanup.policy=delete

# Firehose: Combined for indexing
rpk topic create apub.public.firehose.v1 \
  --partitions 24 \
  --config retention.ms=2592000000 \
  --config cleanup.policy=delete

# Tombstones: With compaction
rpk topic create apub.tombstone.v1 \
  --partitions 12 \
  --config retention.ms=7776000000 \
  --config cleanup.policy=compact,delete
```

## Deployment

### Docker Compose Services

```yaml
services:
  fedify-sidecar:
    build: ./fedify-sidecar
    environment:
      - REDIS_URL=redis://redis:6379
      - REDPANDA_BROKERS=redpanda:9092
      - ACTIVITYPODS_URL=http://activitypods:3000
      - SIGNING_API_TOKEN=${SIGNING_API_TOKEN}
    depends_on:
      - redis
      - redpanda
      - activitypods

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - redis-data:/data

  redpanda:
    image: redpandadata/redpanda:latest
    command:
      - redpanda start
      - --smp 1
      - --memory 1G
      - --overprovisioned
    volumes:
      - redpanda-data:/var/lib/redpanda/data

  opensearch:
    image: opensearchproject/opensearch:2
    environment:
      - discovery.type=single-node
      - DISABLE_SECURITY_PLUGIN=true
    volumes:
      - opensearch-data:/usr/share/opensearch/data
```

## Monitoring

### Key Metrics

| Metric | Description |
|--------|-------------|
| `fedify_delivery_success_total` | Successful deliveries by domain |
| `fedify_delivery_retries_total` | Delivery retries by domain |
| `fedify_delivery_dlq_total` | Deliveries moved to DLQ |
| `fedify_delivery_latency_seconds` | Delivery latency histogram |
| `fedify_inbound_received_total` | Inbound activities received |
| `fedify_inbound_signature_failures_total` | Signature verification failures |
| `fedify_queue_pending_*` | Queue depth gauges |

### Alerts

- DLQ depth > threshold
- Delivery success rate < 95%
- Signing API latency > 500ms
- Queue depth growing continuously

## Security Considerations

1. **Signing API is internal-only**: Not exposed publicly, protected by bearer token and ideally mTLS
2. **Keys never leave ActivityPods**: All signing happens inside ActivityPods
3. **Local actor enforcement**: Signing API rejects non-local actors
4. **Signature verification**: Inbound activities are verified before processing
5. **Rate limiting**: Per-domain rate limiting prevents abuse

## Migration Path

1. Deploy Redis and RedPanda alongside existing infrastructure
2. Deploy Fedify sidecar with feature flags disabled
3. Add Signing Service to ActivityPods
4. Add Outbox Emitter to ActivityPods
5. Enable inbound handling (sidecar receives, forwards to ActivityPods)
6. Enable outbound handling (sidecar delivers, ActivityPods signs)
7. Monitor and tune performance
8. Gradually increase traffic through sidecar
