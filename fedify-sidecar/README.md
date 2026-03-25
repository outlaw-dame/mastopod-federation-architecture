# ActivityPods Fedify Sidecar v5

A high-performance federation sidecar for ActivityPods that handles remote HTTP ActivityPub federation while keeping all private keys and authoritative data within ActivityPods.

## Key Architecture Decisions

1. **Redis Streams** for Fedify's work queues (inbound/outbound processing)
2. **RedPanda** for public activity streams (logs for indexing, NOT work queues)
3. **ActivityPods Signing API** for HTTP signature generation (keys never leave ActivityPods)
4. **OpenSearch** for queryable storage of public activities

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    External Fediverse                            │
└─────────────────────────────────────────────────────────────────┘
                              │ HTTP (S2S)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Fedify Sidecar                              │
│  ┌───────────────┐  ┌───────────────┐  ┌─────────────────────┐  │
│  │ Inbound       │  │ Delivery      │  │ Signing Client      │  │
│  │ Handler       │  │ Worker        │  │ (calls APods API)   │  │
│  └───────────────┘  └───────────────┘  └─────────────────────┘  │
│         │                   │                    ▲               │
│         ▼                   ▼                    │               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Redis Streams (Work Queues)                   │  │
│  │  fedify:inbound | fedify:outbound | fedify:*:dlq          │  │
│  └───────────────────────────────────────────────────────────┘  │
│         │                   │                                    │
│         ▼                   ▼                                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              RedPanda (Activity Logs)                      │  │
│  │  Stream1 (local) | Stream2 (remote) | Firehose | Tombstone │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
          │                   ▲                    │
          │                   │ Signing API        ▼
          │                   │              ┌─────────────────┐
          │                   │              │   OpenSearch    │
          │                   │              │ (Activity Index)│
          │                   │              └─────────────────┘
          ▼                   │
┌─────────────────────────────────────────────────────────────────┐
│                   ActivityPods Pod Server                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Signing Service (keys stay here)                           ││
│  │  Outbox Emitter (emits events to sidecar)                   ││
│  │  Local Federation (Moleculer, no HTTP)                      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### Fedify Sidecar

| Component | Responsibility |
|-----------|----------------|
| **Inbound Handler** | Receives HTTP POST to /inbox, verifies signatures, enqueues to Redis |
| **Delivery Worker** | Consumes outbound jobs, calls Signing API, POSTs to remote inboxes |
| **Redis Streams** | Work queues for inbound/outbound with at-least-once delivery |
| **RedPanda Producer** | Produces public activities to streams for indexing |

### ActivityPods

| Component | Responsibility |
|-----------|----------------|
| **Signing Service** | Batch HTTP signature generation (keys never leave) |
| **Outbox Emitter** | Emits events when activities are committed |
| **Local Federation** | Pod-to-pod via Moleculer (no HTTP) |

### Redis Streams

| Stream | Purpose |
|--------|---------|
| `fedify:inbound` | Raw inbound envelopes for processing |
| `fedify:outbound` | Delivery jobs (fanned out by domain) |
| `fedify:inbound:dlq` | Permanent inbound failures |
| `fedify:outbound:dlq` | Permanent delivery failures |

### RedPanda Topics

| Topic | Partitions | Purpose |
|-------|------------|---------|
| `apub.public.local.v1` | 12 | Stream1: Local public activities |
| `apub.public.remote.v1` | 12 | Stream2: Remote public activities |
| `apub.public.firehose.v1` | 24 | Combined for indexing |
| `apub.tombstone.v1` | 12 | Deletes (compacted) |

## Installation

### Prerequisites

- Node.js 20+
- Redis 7+
- RedPanda (or Kafka)
- OpenSearch 2+
- ActivityPods instance

### Quick Start

```bash
# Clone the repository
git clone https://github.com/activitypods/mastopod.git
cd mastopod/fedify-sidecar

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit configuration
vim .env

# Build
npm run build

# Start
npm start
```

### Docker Compose

```bash
docker-compose up -d
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3001` |
| `METRICS_PORT` | Prometheus metrics port | `9090` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `REDPANDA_BROKERS` | RedPanda broker addresses | `localhost:9092` |
| `ACTIVITYPODS_URL` | ActivityPods base URL | `http://localhost:3000` |
| `ACTIVITYPODS_TOKEN` | Shared secret for Sidecar → ActivityPods APIs (signing + inbox receive) | (required) |
| `SIDECAR_TOKEN` | Shared secret for ActivityPods → Sidecar outbox webhook | (required) |

## Signing API Contract

The Signing API is the formal contract between the sidecar and ActivityPods.

### Endpoint

```
POST /api/internal/signatures/batch
Authorization: Bearer <token>
```

### Request

```json
{
  "requests": [
    {
      "requestId": "01J...ULID",
      "actorUri": "https://pods.example/users/alice",
      "method": "POST",
      "target": {
        "host": "remote.example",
        "path": "/inbox"
      },
      "body": {
        "encoding": "utf8",
        "bytes": "{...exact JSON bytes...}"
      },
      "digest": { "mode": "server_compute" },
      "profile": "ap_post_v1"
    }
  ]
}
```

### Response

```json
{
  "results": [
    {
      "requestId": "01J...ULID",
      "ok": true,
      "outHeaders": {
        "Date": "Tue, 06 Jan 2026 16:00:00 GMT",
        "Digest": "SHA-256=base64...",
        "Signature": "keyId=\"...\",algorithm=\"rsa-sha256\",..."
      }
    }
  ]
}
```

## Data Flows

### Outbound (Local → Remote)

1. User posts activity to outbox
2. ActivityPods commits to outbox
3. ActivityPods emits `activitypub.outbox.committed` event
4. Sidecar receives event via webhook
5. Sidecar produces to Stream1 (if public)
6. Sidecar creates delivery jobs in Redis
7. Delivery worker consumes job
8. Delivery worker calls Signing API
9. Delivery worker POSTs to remote inbox
10. On success: ack job; On failure: retry or DLQ

### Inbound (Remote → Local)

1. Remote server POSTs to /inbox
2. Sidecar enqueues to Redis
3. Sidecar returns 202 Accepted
4. Inbound worker verifies signature
5. If public: produce to Stream2
6. Forward to ActivityPods

## ActivityPods Integration

### Required Services

Add these Moleculer services to your ActivityPods instance:

1. **`signing.service.js`** - Signing API for HTTP signatures
2. **`outbox-emitter.service.js`** - Emit events when activities are committed

See `activitypods-integration/` directory for implementations.

## Monitoring

### Prometheus Metrics

| Metric | Description |
|--------|-------------|
| `fedify_delivery_success_total` | Successful deliveries |
| `fedify_delivery_retries_total` | Delivery retries |
| `fedify_delivery_dlq_total` | Deliveries to DLQ |
| `fedify_inbound_received_total` | Inbound activities |
| `fedify_inbound_signature_failures_total` | Signature failures |

### Alerts

- DLQ depth > 100
- Delivery success rate < 95%
- Signing API latency > 500ms

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/ready` | GET | Readiness check |
| `/metrics` | GET | Prometheus metrics |
| `/inbox` | POST | Shared inbox |
| `/users/:username/inbox` | POST | Per-user inbox |
| `/webhook/outbox` | POST | Receive outbox events |

## Development

```bash
# Run in development mode
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint

# Tests
npm test
```

## License

AGPL-3.0
