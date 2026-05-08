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

### Local Dev Profile (No Manual Flags)

Use the local profile to run the sidecar against host-mapped dependencies with one command.

```bash
cp .env.local.example .env.local
npm run dev:local
```

What this does:

- loads environment from `.env.local` if present
- ensures required RedPanda topics exist (`npm run topics:bootstrap`)
- starts sidecar in dev mode (`npm run dev`)

### RedPanda Topic Bootstrap (Required)

Automatic topic creation is disabled for producers and consumers. Bootstrap topics explicitly before starting workers:

```bash
npm run topics:bootstrap
```

Validate topic governance (CI/startup parity check):

```bash
npm run topics:verify
```

Recommended profile and defaults:

- `REDPANDA_TOPIC_BOOTSTRAP_PROFILE=development|staging|production`
- `REDPANDA_COMPRESSION=zstd`
- `REDPANDA_TOPIC_BOOTSTRAP_RETRIES=5`
- `REDPANDA_TOPIC_BOOTSTRAP_RETRY_BASE_MS=250`
- `REDPANDA_ENFORCE_TOPIC_GOVERNANCE=true`

The bootstrap script applies exponential backoff with jitter and enforces topic-name sanitization to reduce unsafe or accidental topic creation.
The verify command fails if topics are missing or if governance-critical settings drift (compression type, cleanup policy, retention, min ISR, partitions/replication floor).

Production startup behavior:

- `npm start` runs a prestart gate that executes `npm run topics:verify` when `NODE_ENV=production`.
- If verification fails, startup is aborted (fail-fast).
- You can explicitly bypass this with `REDPANDA_ENFORCE_TOPIC_GOVERNANCE=false`.

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
| `ENABLE_MRF_ADMIN_API` | Enable the MRF admin HTTP API | `false` |
| `MRF_ADMIN_TOKEN` | Bearer token for MRF admin API | (required if enabled) |
| `ENABLE_MODERATION_BRIDGE_API` | Enable the cross-protocol moderation bridge | same as `ENABLE_MRF_ADMIN_API` |
| `MODERATION_BRIDGE_REDIS_PREFIX` | Redis key prefix for persisted decisions | `moderation:bridge` |
| `MODERATION_LABELER_DID` | AT labeler DID used as the label source | `did:web:{DOMAIN}` |
| `MODERATION_LABELER_SIGNING_KEY_HEX` | 32-byte secp256k1 private key hex for label signing | (optional; labels unsigned if absent) |
| `MODERATION_AT_ADMIN_XRPC_BASE_URL` | PDS/AppView XRPC base URL for AT admin suspension calls | (optional) |
| `MODERATION_AT_ADMIN_BEARER_TOKEN` | Admin bearer token with `com.atproto.admin.updateSubjectStatus` scope | (optional) |
| `MODERATION_AT_ADMIN_TIMEOUT_MS` | Timeout (ms) for AT admin XRPC calls | `5000` |

### Operational Runbook: Non-Public Forward Worker & sharedInbox Scope

The sidecar enforces ActivityPub privacy boundaries in two cooperating places:

- The **non-public forward worker** drains private/followers-only activities from a
  durable Redis Stream, decoupling slow recipient delivery from public-firehose
  fan-out.
- The **outbox-intent worker** applies a `sharedInbox` scope policy so that direct
  (DM) targets are never collapsed onto a recipient's shared endpoint, eliminating
  inbox-correlation leaks.

#### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ENABLE_NONPUBLIC_FORWARD_WORKER` | Master switch for the async non-public forward worker. Set to `false` only for emergency rollback to synchronous bridge forwarding. | `true` |
| `NONPUBLIC_FORWARD_CONCURRENCY` | Max in-flight forwards per sidecar instance. | `16` |
| `NONPUBLIC_FORWARD_MAX_ATTEMPTS` | Max delivery attempts before DLQ (matches inbound enqueue side). | `8` |
| `NONPUBLIC_FORWARD_MAX_ACTIVITY_BYTES` | Reject activities larger than this as permanent failures. | `524288` |
| `NONPUBLIC_FORWARD_MAX_AGE_MS` | Drop jobs whose `createdAt` is older than this to the DLQ. Prevents zombie redelivery of stale private payloads. | `3600000` (1h) |
| `NONPUBLIC_FORWARD_REQUEST_TIMEOUT_MS` | Per-request timeout for forwards to ActivityPods. Falls back to `REQUEST_TIMEOUT_MS`. | `30000` |
| `NONPUBLIC_FORWARD_DEFER_SLEEP_CAP_MS` | Max in-process wait when a job's `notBeforeMs` is in the near future. Larger waits re-enqueue (and ack last) so the worker stays responsive. | `1000` |
| `OUTBOX_SHARED_INBOX_SCOPES` | Comma-separated list of audience scopes allowed to use sharedInbox delivery. Must be a subset of `public,followers,direct,local`. **Never include `direct` in production.** | `public,followers` |

Stream key overrides (advanced; only set when sharing Redis with another deployment):

| Variable | Default |
|----------|---------|
| `NONPUBLIC_FORWARD_STREAM_KEY` | `ap:queue:nonpublic-forward:v1` |
| `DLQ_NONPUBLIC_FORWARD_STREAM_KEY` | `ap:queue:dlq:nonpublic-forward:v1` |

#### Staging canary checklist (sharedInbox scope behavior)

Run these checks against a staging deployment after any change touching
`OUTBOX_SHARED_INBOX_SCOPES`, the outbox intent worker, or the non-public forward
worker. All checks should pass before promoting to production.

1. **Public post → sharedInbox.** Publish a public Note from a local actor with
   multiple remote recipients on the same domain. Confirm `outbound_jobs_enqueued`
   contains a single job whose `targetInbox` is the remote `sharedInbox`, and the
   target list is deduped per domain.
2. **Followers-only post → sharedInbox.** Publish a followers-only Note. Confirm
   the same sharedInbox collapsing behavior, and that `validateTargetsInBatch`
   filtered any blocked or moved targets.
3. **Direct message → per-recipient inbox.** Send a direct activity (`to`/`cc`
   contains only specific actor URIs, no `as:Public`, no `Followers` collection).
   Confirm:
   - Each enqueued outbound job's `targetInbox` equals the recipient's personal
     inbox URL — **never** their `sharedInbox`.
   - No bridge enrichment (`enrichTargets`) was invoked for this scope.
   - The target list size equals the recipient set size (no domain-level dedupe).
4. **Inbound non-public delivery.** From a remote test instance, deliver a
   followers-only and a direct activity to a local user. Confirm:
   - Each lands on the `ap:queue:nonpublic-forward:v1` stream.
   - The non-public forward worker logs `forwarded_async_nonpublic` with the
     correct `scope`.
   - Neither activity appears on Stream2 (remote firehose) nor in the canonical
     stream — privacy boundary holds.
5. **Retry & DLQ.** Force ActivityPods to return `503` for one inbox path; confirm
   `nonpublic_forward{status="retry"}` increments and the job lands on the DLQ
   after `NONPUBLIC_FORWARD_MAX_ATTEMPTS`. Then return `400` and confirm an
   immediate DLQ entry (permanent failure path).
6. **Stale-job drop.** Inject a job with `createdAt = now - 2h` (or set
   `NONPUBLIC_FORWARD_MAX_AGE_MS=1` temporarily); confirm a single DLQ entry with
   reason containing `stale` and no outbound HTTP attempt was made.
7. **Path-traversal safety.** Inject a job with `path = "/../etc/passwd"`;
   confirm a permanent DLQ entry and zero forward attempts.
8. **Rollback drill.** Set `ENABLE_NONPUBLIC_FORWARD_WORKER=false` and restart;
   confirm the inbound worker falls back to synchronous bridge forwarding without
   message loss, then re-enable.

Watchlist metrics during canary:

- `queue_messages_processed_total{topic="nonpublic_forward",status=~"success|retry|dlq|deferred"}`
- `queue_processing_latency_seconds{topic="nonpublic_forward"}`
- `inbound_activitypub_activities_total{stage="forwarded_async_nonpublic"}`
- DLQ lag: `redis_xlen` of `ap:queue:dlq:nonpublic-forward:v1`

### Cross-Protocol Moderation Bridge

The bridge provides a single HTTP API (`POST /internal/admin/moderation/decisions`) that
propagates suspension and block decisions across both ActivityPods (via MRF policies) and
BskyAtProto (via AT labels + admin subject status).

#### AT Label Signing

When `MODERATION_LABELER_SIGNING_KEY_HEX` is set, labels are signed using secp256k1 ECDSA
(DAG-CBOR payload, IEEE P1363 signature encoding) as required by the AT Protocol labeler
specification. Without the key, labels are emitted unsigned (acceptable for private/test
deployments, but labelers intended for public relay subscription **must** sign).

Generate a suitable key with:

```sh
node -e "const { generateKeyPairSync } = require('node:crypto'); \
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' }); \
  console.log(privateKey.export({ format: 'jwk' }));"
# Then extract the 'd' field, base64url-decode it, and hex-encode.
```

#### AT Admin Suspension

When `MODERATION_AT_ADMIN_XRPC_BASE_URL` and `MODERATION_AT_ADMIN_BEARER_TOKEN` are both set,
a `suspend` decision additionally calls `com.atproto.admin.updateSubjectStatus` on the
configured PDS/AppView endpoint. This path is **optional** — omitting the env vars disables
the call entirely without affecting label emission or MRF suspension.

The bearer token requires admin-level authorization on the target PDS. For a self-hosted
`did:web` PDS this is typically the `PDS_ADMIN_PASSWORD`-derived token; for AppView endpoints
consult your operator documentation.

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
3. **`activitypub-bridge-recipient-resolver.service.js`** - Trusted internal resolver for outbound targets and bridge media fetches

Optional but recommended when you want derivative generation and media analysis off the pod request path:

4. **`media-pipeline-emitter.service.js`** - Forward newly created pod file resources to `media-pipeline-sidecar`

See `activitypods-integration/` directory for implementations.

Important architecture note:

- `activitypub-bridge-recipient-resolver.service.js` resolves bridge attachment bytes for AP->AT projection and link-preview flows.
- `media-pipeline-emitter.service.js` is the asynchronous handoff into `media-pipeline-sidecar`.
- These are complementary paths, not the same subsystem.

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
