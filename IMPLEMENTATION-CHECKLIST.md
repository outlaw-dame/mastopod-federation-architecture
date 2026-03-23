# Mastopod Federation Architecture - Implementation Checklist

This checklist provides detailed guidance for implementing the remediated v5 architecture in a production environment. Each section maps to specific code changes and deployment steps.

## Phase 1: Queue Layer Implementation

### 1.1 Redis Streams Queue Setup

**Status**: ✅ Complete in remediated code

**What was done**:
- Created `src/queue/sidecar-redis-queue.ts` with full runtime contract
- Implements Redis Streams with consumer groups
- Supports XAUTOCLAIM for crash recovery
- Provides control data methods for idempotency, rate limiting, concurrency

**Verification**:
```bash
# Check that queue module exports all required types and functions
grep -E "export (class|interface|function)" fedify-sidecar/src/queue/sidecar-redis-queue.ts
```

Expected exports:
- `RedisStreamsQueue` class
- `InboundEnvelope` interface
- `OutboundJob` interface
- `QueueConfig` interface
- `createDefaultConfig()` function
- `createInboundEnvelope()` function
- `backoffMs()` function

### 1.2 Verify Queue Integration

**What to test**:
1. Redis connection with health checks
2. Consumer group creation on first run
3. Message enqueue/dequeue cycle
4. XAUTOCLAIM crash recovery
5. Idempotency tracking
6. Domain rate limiting
7. Domain concurrency slots
8. Dead letter queue functionality

**Test script**:
```bash
cd fedify-sidecar
npm install
npm run build
# Run with docker-compose to test Redis integration
docker-compose up -d redis
npm run dev
```

## Phase 2: Configuration Alignment

### 2.1 Environment Variables

**Status**: ✅ Complete in remediated code

**Updated variables**:
- ✅ `REDIS_URL` - Redis connection string (NEW)
- ✅ `INBOUND_STREAM_KEY` - Inbound queue topic (NEW)
- ✅ `OUTBOUND_STREAM_KEY` - Outbound queue topic (NEW)
- ✅ `DLQ_STREAM_KEY` - Dead letter queue topic (NEW)
- ✅ `ACTIVITYPODS_TOKEN` - Unified authentication token (RENAMED from SIGNING_API_TOKEN)
- ✅ `REQUEST_TIMEOUT_MS` - Timeout in milliseconds (RENAMED from REQUEST_TIMEOUT)
- ✅ Topic names with `ap.` prefix (UPDATED)

**Verification**:
```bash
# Check .env.example for all required variables
grep -E "^[A-Z_]+=" fedify-sidecar/.env.example | sort
```

### 2.2 Docker Compose Updates

**Status**: ✅ Complete in remediated code

**Changes**:
- ✅ Added Redis service with health checks
- ✅ Updated sidecar port from 3001 → 8080
- ✅ Injected REDIS_URL into sidecar
- ✅ Updated RedPanda topics with `ap.` prefix
- ✅ Removed RedPanda-as-queue comments

**Verification**:
```bash
# Verify Redis service is defined
grep -A 15 "redis:" fedify-sidecar/docker-compose.yml

# Verify sidecar port
grep "8080:8080" fedify-sidecar/docker-compose.yml

# Verify REDIS_URL injection
grep "REDIS_URL" fedify-sidecar/docker-compose.yml
```

## Phase 3: ActivityPods Signing API

### 3.1 Update Signing Service

**Status**: ✅ Complete in remediated code

**What was done**:
- Updated `activitypods-integration/signing-api.service.js` to v5 contract
- Route: `POST /api/internal/signatures/batch`
- Per-request `actorUri` support
- Bearer token authentication
- Proper error codes

**Installation steps**:
1. Copy `activitypods-integration/signing-api.service.js` to ActivityPods backend
2. Register service in Moleculer broker
3. Configure API gateway to expose `/api/internal/signatures/batch`
4. Set `SIGNING_API_TOKEN` environment variable in ActivityPods

**Verification**:
```bash
# Test signing API endpoint
curl -X POST http://localhost:3000/api/internal/signatures/batch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "requests": [{
      "requestId": "test-1",
      "actorUri": "https://example.com/users/alice",
      "method": "POST",
      "targetUrl": "https://remote.com/inbox",
      "headers": {
        "host": "remote.com",
        "date": "Mon, 23 Mar 2026 12:00:00 GMT",
        "digest": "SHA-256=...",
        "content-type": "application/activity+json"
      },
      "body": "{...}"
    }]
  }'
```

Expected response:
```json
{
  "results": [{
    "requestId": "test-1",
    "ok": true,
    "signedHeaders": {
      "date": "Mon, 23 Mar 2026 12:00:00 GMT",
      "digest": "SHA-256=...",
      "signature": "keyId=\"...\",algorithm=\"rsa-sha256\",headers=\"...\",signature=\"...\""
    },
    "meta": {
      "keyId": "https://example.com/users/alice#main-key",
      "algorithm": "rsa-sha256",
      "signedHeadersList": ["(request-target)", "host", "date", "digest"]
    }
  }]
}
```

### 3.2 Verify Sidecar Signing Client

**Status**: ✅ Complete in remediated code

**What to test**:
1. Client connects to ActivityPods signing API
2. Batches requests efficiently
3. Handles errors with proper classification
4. Retries transient errors
5. Fails permanently on auth errors

**Test**:
```bash
# In sidecar, check signing client configuration
grep -A 10 "createSigningClient" fedify-sidecar/src/signing/signing-client.ts
```

## Phase 4: Inbound Federation

### 4.1 Add Internal Inbox Receiver

**Status**: ✅ Complete in remediated code

**What was done**:
- Created `activitypods-integration/internal-inbox-receiver.service.js`
- Route: `POST /api/internal/inbox/receive`
- Fail-closed authentication
- Proper inbox path parsing

**Installation steps**:
1. Copy `activitypods-integration/internal-inbox-receiver.service.js` to ActivityPods backend
2. Register service in Moleculer broker
3. Configure API gateway to expose `/api/internal/inbox/receive`
4. Set `INTERNAL_API_TOKEN` environment variable in ActivityPods
5. Update sidecar `ACTIVITYPODS_TOKEN` to match

**Verification**:
```bash
# Test internal inbox receiver endpoint
curl -X POST http://localhost:3000/api/internal/inbox/receive \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "targetInbox": "http://localhost:3000/users/alice/inbox",
    "activity": {
      "type": "Create",
      "actor": "https://remote.com/users/bob",
      "object": {...}
    },
    "verifiedActorUri": "https://remote.com/users/bob",
    "receivedAt": 1711270800000,
    "remoteIp": "192.168.1.100"
  }'
```

Expected response:
```json
{
  "success": true,
  "result": {...}
}
```

### 4.2 Verify Inbound Worker

**Status**: ✅ Complete in remediated code

**What to test**:
1. HTTP signature verification works correctly
2. Verified activities are forwarded to ActivityPods
3. Public activities are published to Stream2
4. Failed activities are moved to DLQ
5. Proper error handling and logging

**Test**:
```bash
# Check inbound worker uses correct endpoint
grep "api/internal/inbox/receive" fedify-sidecar/src/delivery/inbound-worker.ts
```

## Phase 5: Outbound Federation

### 5.1 Verify Outbound Worker

**Status**: ✅ Complete in remediated code

**What to test**:
1. Jobs are fetched from outbound queue
2. Idempotency is checked before delivery
3. Domain rate limiting is enforced
4. Domain concurrency slots are respected
5. HTTP signatures are requested from ActivityPods
6. Delivery is attempted with proper retry logic
7. Failed deliveries are moved to DLQ

**Test**:
```bash
# Check outbound worker uses correct queue
grep "consumeOutbound" fedify-sidecar/src/delivery/outbound-worker.ts

# Check signing integration
grep "signingClient.signBatch" fedify-sidecar/src/delivery/outbound-worker.ts
```

## Phase 6: Event Streams

### 6.1 Verify Stream Configuration

**Status**: ✅ Complete in remediated code

**Topics** (with `ap.` prefix per v5 spec):
- `ap.public.local.v1` - Local public activities from Stream1
- `ap.public.remote.v1` - Remote public activities from Stream2 (post-verification)
- `ap.public.firehose.v1` - Combined for OpenSearch indexing

**Verification**:
```bash
# Check RedPanda producer uses correct topics
grep "TOPIC_" fedify-sidecar/.env.example

# Check topic names in docker-compose
grep "TOPIC_STREAM" fedify-sidecar/docker-compose.yml
```

### 6.2 Verify OpenSearch Indexing

**Status**: ✅ Complete in remediated code

**What to test**:
1. Firehose messages are consumed
2. Activities are indexed into OpenSearch
3. Queries return correct results
4. Tombstones (deletes) are handled
5. Type definitions are correct (origin includes "unknown")

**Test**:
```bash
# Check ActivityDocument type definition
grep -A 10 "interface ActivityDocument" fedify-sidecar/src/streams/opensearch-indexer.ts

# Verify origin type includes "unknown"
grep 'origin:.*"unknown"' fedify-sidecar/src/streams/opensearch-indexer.ts
```

## Phase 7: Deployment

### 7.1 Pre-Deployment Checklist

- [ ] Redis 7+ is running and accessible
- [ ] RedPanda 24.1.1+ is running with topics created
- [ ] OpenSearch 2.12.0+ is running
- [ ] ActivityPods is running with new signing and inbox receiver services
- [ ] All environment variables are set correctly
- [ ] Bearer tokens are configured securely
- [ ] Firewall rules allow inter-service communication
- [ ] Monitoring and logging are configured

### 7.2 Deployment Steps

1. **Start Redis**:
   ```bash
   docker run -d --name redis -p 6379:6379 redis:7-alpine
   ```

2. **Start RedPanda** (if not using docker-compose):
   ```bash
   docker run -d --name redpanda -p 9092:9092 docker.redpanda.com/redpandadata/redpanda:v24.1.1
   ```

3. **Start OpenSearch** (if not using docker-compose):
   ```bash
   docker run -d --name opensearch -p 9200:9200 opensearchproject/opensearch:2.12.0
   ```

4. **Deploy ActivityPods services**:
   - Copy `signing-api.service.js` and `internal-inbox-receiver.service.js` to ActivityPods
   - Register services in Moleculer broker
   - Configure API gateway routes
   - Set environment variables

5. **Deploy Fedify Sidecar**:
   ```bash
   cd fedify-sidecar
   npm install
   npm run build
   npm start
   ```

6. **Verify health**:
   ```bash
   curl http://localhost:8080/health
   curl http://localhost:3000/api/internal/signatures/batch (with auth)
   curl http://localhost:3000/api/internal/inbox/receive (with auth)
   ```

### 7.3 Post-Deployment Verification

- [ ] Sidecar is running and healthy
- [ ] Redis is connected and populated with queue data
- [ ] RedPanda topics are being written to
- [ ] OpenSearch index is being populated
- [ ] Inbound federation works (test with remote activity)
- [ ] Outbound federation works (test sending activity)
- [ ] Monitoring dashboards show traffic
- [ ] Logs show no errors

## Phase 8: Testing

### 8.1 Unit Tests

**What to test**:
- Queue operations (enqueue, dequeue, ack)
- Idempotency checks
- Rate limiting
- Concurrency slots
- Signing client error handling
- Inbound worker verification
- Outbound worker delivery

**Run tests**:
```bash
cd fedify-sidecar
npm test
```

### 8.2 Integration Tests

**What to test**:
1. End-to-end inbound federation:
   - Remote actor sends activity
   - Sidecar verifies signature
   - ActivityPods receives verified activity
   - Activity is stored and indexed

2. End-to-end outbound federation:
   - Local actor creates activity
   - Sidecar requests signature from ActivityPods
   - Sidecar delivers to remote inbox
   - Remote inbox acknowledges receipt

3. Error scenarios:
   - Invalid signatures are rejected
   - Rate-limited domains are delayed
   - Failed deliveries are retried
   - Permanent failures are DLQ'd

### 8.3 Load Testing

**What to test**:
- Sidecar handles concurrent inbound requests
- Queue doesn't lose messages
- Rate limiting prevents abuse
- OpenSearch indexing keeps up with traffic
- Memory usage stays reasonable

## Phase 9: Monitoring

### 9.1 Metrics to Monitor

- Queue depths (inbound, outbound, DLQ)
- Message processing latency
- Delivery success rate
- Signature request latency
- Domain rate limit hits
- OpenSearch indexing lag
- Redis memory usage
- RedPanda consumer lag

### 9.2 Alerts to Configure

- Queue depth exceeds threshold
- Delivery success rate drops below 95%
- Signature API response time exceeds 5s
- OpenSearch indexing lag exceeds 1 minute
- Redis memory usage exceeds 80%
- Sidecar process crashes

## Phase 10: Troubleshooting

### Common Issues

**Issue**: Queue messages not being processed
- Check Redis connection: `redis-cli ping`
- Check consumer group: `redis-cli XINFO GROUPS ap:queue:inbound:v1`
- Check worker logs for errors

**Issue**: Signature requests failing
- Check ActivityPods is running
- Check bearer token is correct
- Check signing service is registered
- Check API gateway route is configured

**Issue**: Inbound activities not being received
- Check sidecar is listening on port 8080
- Check ActivityPods internal inbox receiver is registered
- Check bearer token matches
- Check firewall allows traffic

**Issue**: Outbound deliveries failing
- Check domain isn't blocked
- Check rate limit hasn't been exceeded
- Check domain concurrency slots available
- Check remote inbox is reachable

## Rollback Plan

If issues occur during deployment:

1. **Stop sidecar**: `docker stop fedify-sidecar`
2. **Revert ActivityPods services**: Remove new signing and inbox receiver services
3. **Restore old configuration**: Revert to previous .env and docker-compose
4. **Restart services**: `docker-compose up -d`
5. **Verify**: Check that old federation path still works

## Success Criteria

The remediated architecture is successfully deployed when:

- ✅ All environment variables are correctly configured
- ✅ Redis, RedPanda, and OpenSearch are running
- ✅ ActivityPods signing and inbox receiver services are deployed
- ✅ Sidecar is running and healthy
- ✅ Inbound federation works (remote activities are received and verified)
- ✅ Outbound federation works (local activities are signed and delivered)
- ✅ Queue operations are reliable (no message loss)
- ✅ Rate limiting and concurrency control work
- ✅ Monitoring shows healthy metrics
- ✅ No errors in logs

## Next Steps After Deployment

1. **Documentation**: Update deployment guides and runbooks
2. **Training**: Brief team on new architecture and troubleshooting
3. **Optimization**: Tune queue sizes, batch sizes, and timeouts based on load
4. **Backup**: Configure backups for Redis and OpenSearch
5. **Disaster Recovery**: Test recovery procedures
6. **Performance**: Monitor and optimize based on metrics
