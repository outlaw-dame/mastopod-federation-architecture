# V6 Migration Guide

## Overview

This guide documents the migration from V5 to V6 architecture for the Mastopod Federation Sidecar. The V6 specification is the authoritative architecture and supersedes all earlier versions.

## Fedify Runtime Integration Note (2026-04-04)

The current migration path uses a feature-flagged integration seam for Fedify runtime adoption, rather than a big-bang replacement.

What changed:
- Runtime seam and flag were introduced for controlled rollout:
	- `ENABLE_FEDIFY_RUNTIME_INTEGRATION` (default OFF)
	- `FederationRuntimeAdapter` with noop default behavior

What did not change:
- ActivityPods remains signing authority and key custody boundary.
- Redis Streams remains transient delivery/work queue substrate.
- RedPanda remains immutable event-log backbone.
- OpenSearch remains firehose consumer plus bulk indexer.

Rollout posture:
- Enable the runtime flag in non-production first.
- Validate parity and invariants with existing Phase runbook checks.
- Promote to production only after CI/staging parity evidence is green.

## Key Architectural Changes

### 1. Queue Layer: Redis is State-Only, Not Work Queue

**V5 (Incorrect):**
- Redis Streams used as work queue for inbound/outbound delivery
- Queue contract: `enqueue()`, `listen()`, `consume()`

**V6 (Correct):**
- Redis used ONLY for delivery state, caching, and MRF KV
- Work events come from RedPanda event logs
- Redis contract: `setDeliveryState()`, `checkIdempotency()`, `checkDomainRateLimit()`, etc.

**Migration Action:**
- Replace `src/queue/sidecar-redis-queue.ts` with `src/queue/delivery-state.ts`
- Update all imports to use `DeliveryStateManager` instead of queue classes

### 2. Event Log Topology: RedPanda Topics

**V5 (Incorrect):**
- Topics: `ap.public.local.v1`, `ap.public.remote.v1`, `ap.public.firehose.v1`
- Missing: outbound events, inbound events, MRF rejections

**V6 (Correct):**
- `ap.stream1.local-public.v1` - Local public activities
- `ap.stream2.remote-public.v1` - Remote public activities (post-verification)
- `ap.firehose.v1` - Combined public stream
- `ap.outbound.v1` - Outbound delivery readiness events
- `ap.inbound.v1` - Inbound activity events (pre-MRF)
- `ap.mrf.rejected.v1` - MRF rejection audit trail
- `ap.tombstones.v1` - Delete notifications

**Migration Action:**
- Update all topic names in configuration
- Migrate RedPanda topics with data transformation if needed
- Update consumer group names

### 3. Inbound Path: Pre-Accept MRF Processing

**V5 (Incomplete):**
1. HTTP signature verification
2. Actor document fetching
3. Forward to ActivityPods
4. Publish to Stream2

**V6 (Complete):**
1. HTTP signature verification
2. **Pre-accept MRF processing (NEW)**
3. Actor document fetching
4. Forward to ActivityPods
5. Publish to Stream2

**Migration Action:**
- Replace `src/delivery/inbound-worker.ts` with `src/delivery/v6-inbound-worker.ts`
- Implement MRF policies in `src/mrf/mrf-runtime.ts`
- Update ActivityPods inbox receiver to `v6-inbox-receiver.service.js`

### 4. Outbound Path: Event Log Consumption

**V5 (Incorrect):**
- Consume from Redis outbound queue
- Direct delivery without event log

**V6 (Correct):**
1. ActivityPods emits outbound readiness to `ap.outbound.v1`
2. Sidecar consumes from `ap.outbound.v1`
3. Uses Redis for delivery state only
4. Batch signing from ActivityPods
5. Delivery with rate limiting and concurrency control

**Migration Action:**
- Replace `src/delivery/outbound-worker.ts` with `src/delivery/v6-outbound-worker.ts`
- Update to consume from `ap.outbound.v1` instead of Redis queue
- Implement batch signing requests

### 5. Signing: Batch and Internal-Only

**V5 (Incomplete):**
- Single-request signing
- Local key caching (WRONG - security issue)

**V6 (Correct):**
- Batch signing for efficiency
- Private keys NEVER leave ActivityPods
- Fail-closed authentication
- Audit logging

**Migration Action:**
- Replace signing service with `v6-signing.service.js`
- Update signing client to use batch endpoint
- Remove any local key caching

### 6. Missing Components: WebFinger and Actor Serving

**V5 (Missing):**
- No WebFinger support
- No actor document serving from sidecar

**V6 (Required):**
- `/.well-known/webfinger` endpoint
- `/users/{username}` actor documents
- `/users/{username}/followers` collection
- `/users/{username}/following` collection

**Migration Action:**
- Implement `src/http/webfinger-handler.ts`
- Register handlers in main HTTP server

## File Migration Matrix

| File | V5 Status | V6 Action | Replacement |
|------|-----------|-----------|-------------|
| `src/queue/sidecar-redis-queue.ts` | Active | Replace | `src/queue/delivery-state.ts` |
| `src/queue/fedify-redis-message-queue.ts` | Active | Archive | - |
| `src/queue/redpanda-message-queue.ts` | Active | Archive | - |
| `src/delivery/inbound-worker.ts` | Active | Replace | `src/delivery/v6-inbound-worker.ts` |
| `src/delivery/outbound-worker.ts` | Active | Replace | `src/delivery/v6-outbound-worker.ts` |
| `src/delivery/delivery-worker.ts` | Active | Archive | - |
| `src/delivery/domain-batched-worker.ts` | Active | Archive | - |
| `src/mrf/` | Missing | Create | `src/mrf/mrf-runtime.ts` |
| `src/http/webfinger-handler.ts` | Missing | Create | - |
| `src/streams/v6-topology.ts` | Missing | Create | - |
| `src/config/v6-config.ts` | Missing | Create | - |
| `src/config/index.ts` | Active | Update | Use `v6-config.ts` |
| `src/config/index.js` | Active | Archive | - |
| `src/index.ts` | Active | Refactor | Use new modules |
| `src/index.js` | Active | Archive | - |
| `src/federation/index.ts` | Active | Archive | - |
| `src/handlers/inbound-handler.ts` | Active | Archive | - |
| `src/services/signing.ts` | Active | Archive | - |
| `src/services/signing.js` | Active | Archive | - |
| `activitypods-integration/signing.service.js` | Active | Keep & Evolve | - |
| `activitypods-integration/signing-api.service.js` | Active | Archive | - |
| `activitypods-integration/inbox-receiver.service.js` | Active | Archive | - |
| `activitypods-integration/v6-signing.service.js` | Missing | Create | - |
| `activitypods-integration/v6-inbox-receiver.service.js` | Missing | Create | - |
| `activitypods-integration/aggregator.service.js` | Active | Archive | - |
| `activitypods-integration/pod-outbox-publisher.service.js` | Active | Archive | - |
| `activitypods-integration/outbox-emitter.service.js` | Active | Archive | - |
| `.env.example` | Active | Update | `.env.v6.example` |
| `docker-compose.yml` | Active | Update | `docker-compose.v6.yml` |

## Configuration Migration

### Environment Variables

**Rename:**
- `REQUEST_TIMEOUT` → `REQUEST_TIMEOUT_MS`
- `SIGNING_API_TOKEN` → `ACTIVITYPODS_TOKEN`

**Remove (V5 only):**
- `DELIVERY_SIGNATURE_CACHE_TTL_MS`
- Old topic names

**Add (V6):**
- `REDIS_URL` (now mandatory)
- `MAX_CONCURRENT_PER_DOMAIN`
- `IDEMPOTENCY_TTL_MS`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX_PER_WINDOW`
- `ACTOR_CACHE_TTL_MS`
- `STREAM1_TOPIC`, `STREAM2_TOPIC`, `FIREHOSE_TOPIC`
- `OUTBOUND_TOPIC`, `INBOUND_TOPIC`, `MRF_REJECTED_TOPIC`
- `MRF_BLOCKED_DOMAINS`
- `MRF_POLICY_*` flags

### Docker Compose

**Changes:**
- Add Redis service (was optional, now mandatory)
- Update RedPanda broker configuration
- Update sidecar environment variables
- Add health checks

## Deployment Steps

### 1. Preparation

```bash
# Backup current configuration
cp .env .env.backup
cp docker-compose.yml docker-compose.backup.yml

# Create V6 configuration
cp .env.v6.example .env
# Edit .env with your values
```

### 2. Database/State Migration

```bash
# Backup Redis data
redis-cli --rdb /backup/redis-backup.rdb

# Backup RedPanda topics
# (Use RedPanda CLI or custom scripts)
```

### 3. Deploy New Version

```bash
# Build new image
docker build -t fedify-sidecar:v6 .

# Start new containers
docker-compose -f docker-compose.v6.yml up -d

# Verify health
curl http://localhost:8080/health
```

### 4. Verify Operation

```bash
# Check logs
docker-compose logs -f fedify-sidecar

# Test WebFinger
curl http://localhost:8080/.well-known/webfinger?resource=acct:test@example.com

# Test actor serving
curl http://localhost:8080/users/test

# Monitor delivery
redis-cli KEYS "ap:delivery:*" | wc -l
```

### 5. Rollback (if needed)

```bash
# Stop new version
docker-compose -f docker-compose.v6.yml down

# Restore old version
docker-compose -f docker-compose.backup.yml up -d

# Restore Redis
redis-cli --pipe < /backup/redis-backup.rdb
```

## Testing Checklist

- [ ] WebFinger discovery works
- [ ] Actor documents are served
- [ ] Inbound activities are received
- [ ] MRF policies are applied
- [ ] Outbound deliveries succeed
- [ ] Rate limiting works
- [ ] Domain concurrency slots work
- [ ] Idempotency prevents duplicates
- [ ] Rejection audit trail is populated
- [ ] Health checks pass
- [ ] Metrics are collected
- [ ] Logs are structured

## Performance Considerations

### Redis
- Increase memory if handling large volumes
- Monitor key eviction
- Use persistence (RDB/AOF) for durability

### RedPanda
- Monitor partition lag
- Adjust retention based on storage
- Use compression (Zstd recommended)

### Sidecar
- Tune concurrency limits based on CPU/memory
- Monitor active job counts
- Adjust rate limits based on remote server capacity

## Troubleshooting

### Activities not being delivered

1. Check MRF rejection audit: `redis-cli KEYS "ap:mrf:rejected:*"`
2. Check delivery state: `redis-cli KEYS "ap:delivery:*"`
3. Check domain blocking: `redis-cli KEYS "ap:domain:blocked:*"`
4. Check rate limiting: `redis-cli KEYS "ap:ratelimit:*"`

### WebFinger not working

1. Verify `SIDECAR_BASE_URL` is correct
2. Check ActivityPods is reachable
3. Verify `ACTIVITYPODS_TOKEN` has correct permissions

### Signing failures

1. Check ActivityPods signing service is running
2. Verify `ACTIVITYPODS_TOKEN` is valid
3. Check actor exists in ActivityPods

## Support

For issues or questions:
1. Check logs: `docker-compose logs fedify-sidecar`
2. Review this migration guide
3. Consult the V6 PDF specification
4. Open an issue on GitHub

## References

- V6 PDF Specification (authoritative)
- ActivityPub RFC (https://www.w3.org/TR/activitypub/)
- Cavage HTTP Signatures (https://tools.ietf.org/html/draft-cavage-http-signatures)
- ActivityPods Documentation
