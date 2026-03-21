# ActivityPods Fedify Sidecar Architecture v3

## Executive Summary

This document describes the revised architecture for the Fedify sidecar, incorporating key insights from the performance analysis. The architecture uses **RedPanda as Fedify's internal message queue** (not just for streaming), implements **domain-based delivery batching**, and maintains a clear separation between delivery optimization (sidecar's job) and timeline caching (app's job).

## Key Architectural Principles

### 1. ActivityPods Remains Authoritative for Local Federation

ActivityPods handles local pod-to-pod communication via **Moleculer service calls**, not HTTP. The sidecar does not interfere with this. Local delivery uses direct `broker.call()` operations, which are fast and efficient.

### 2. Sidecar Handles Only Remote Federation

The Fedify sidecar intercepts outbound activities destined for **remote servers** and handles inbound activities from **remote servers**. It optimizes:
- HTTP signature generation/verification
- Domain-based connection pooling
- Shared inbox consolidation
- Retry logic with exponential backoff

### 3. RedPanda is Fedify's Message Queue

RedPanda (Kafka-compatible) serves as the **message queue backend for Fedify**, replacing the default in-memory queue. This provides:
- Persistent message storage
- Guaranteed delivery
- Consumer group coordination
- Backpressure handling
- Horizontal scaling

### 4. Streams Serve Different Purposes

| Stream | Purpose | Source | Consumers |
|--------|---------|--------|-----------|
| **Stream1** | Local public activities | Aggregator watching pod outboxes | Fedify (for remote delivery), OpenSearch |
| **Stream2** | Remote public activities | Fedify (after signature verification) | OpenSearch, ActivityPods (inbox forwarding) |
| **Firehose** | Combined public activities | Stream1 + Stream2 | OpenSearch indexer, Analytics |
| **activitypods.outbox** | Fedify's internal queue | ActivityPods outbox events | Fedify delivery workers |
| **activitypods.inbox** | Fedify's internal queue | Fedify inbox handlers | ActivityPods inbox service |

### 5. Sidecar is Purely About Delivery

The sidecar does NOT handle:
- Timeline caching (app concern)
- Feed algorithms (app concern)
- Read optimization (app concern)

Apps like Mastopod can add their own Redis caching layer if needed.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           External Fediverse                                 │
│  (Mastodon, Pleroma, Misskey, other ActivityPods instances, etc.)           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │ HTTP (S2S ActivityPub)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Fedify Sidecar                                      │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Inbound Handler                                   │    │
│  │  • Receives HTTP POST to /inbox, /users/:id/inbox                   │    │
│  │  • Verifies HTTP signatures                                         │    │
│  │  • Publishes verified activities to Stream2                         │    │
│  │  • Forwards to ActivityPods via Moleculer                           │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Outbound Delivery Workers                         │    │
│  │  • Consume from activitypods.outbox (RedPanda)                      │    │
│  │  • Group recipients by domain                                        │    │
│  │  • Shared inbox consolidation                                        │    │
│  │  • Connection pooling per domain                                     │    │
│  │  • HTTP signature generation (cached)                                │    │
│  │  • Exponential backoff retry                                         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    RedPanda Message Queue                            │    │
│  │  • activitypods.outbox (Fedify's outbox queue)                      │    │
│  │  • activitypods.inbox (Fedify's inbox queue)                        │    │
│  │  • stream1-local-public                                              │    │
│  │  • stream2-remote-public                                             │    │
│  │  • firehose                                                          │    │
│  │  • delivery-results                                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
          │                                           ▲
          │ Moleculer (internal)                      │ HTTP (internal)
          ▼                                           │
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ActivityPods Pod Server                               │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Aggregator Service                                │    │
│  │  • Watches all pod outboxes via Solid Notifications                 │    │
│  │  • Filters for public activities                                     │    │
│  │  • Publishes to Stream1                                              │    │
│  │  • Publishes to activitypods.outbox for remote delivery             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Pod Services                                      │    │
│  │  • Local federation via Moleculer (no HTTP)                         │    │
│  │  • SPARQL/Fuseki for RDF storage                                    │    │
│  │  • WAC authorization                                                 │    │
│  │  • LDP endpoints                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            OpenSearch                                        │
│  • Indexes all public activities from Firehose                              │
│  • Full-text search                                                          │
│  • Aggregations and analytics                                                │
│  • NOT a cache - a queryable activity store                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## RedPanda as Fedify's Message Queue

### Why RedPanda Instead of In-Memory Queue

Fedify supports custom message queue implementations. Using RedPanda provides:

| Feature | In-Memory Queue | RedPanda Queue |
|---------|-----------------|----------------|
| Persistence | Lost on restart | Durable |
| Scaling | Single process | Multiple consumers |
| Backpressure | Limited | Native |
| Monitoring | None | Full Kafka metrics |
| Replay | Impossible | Consumer offsets |
| Delivery guarantee | At-most-once | At-least-once |

### RedPanda MessageQueue Implementation

```typescript
// src/queue/redpanda-message-queue.ts
import { MessageQueue, MessageQueueEnqueueOptions } from "@fedify/fedify";
import { Kafka, Producer, Consumer, EachMessagePayload } from "kafkajs";

export class RedPandaMessageQueue implements MessageQueue {
  private kafka: Kafka;
  private producer: Producer;
  private consumers: Map<string, Consumer> = new Map();
  
  constructor(
    private brokers: string[],
    private clientId: string
  ) {
    this.kafka = new Kafka({
      clientId,
      brokers,
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
    });
    this.producer = this.kafka.producer();
  }

  async initialize(): Promise<void> {
    await this.producer.connect();
  }

  async enqueue(
    message: object,
    options?: MessageQueueEnqueueOptions
  ): Promise<void> {
    const topic = this.getTopicForMessage(message);
    const key = this.getPartitionKey(message);
    
    await this.producer.send({
      topic,
      messages: [{
        key,
        value: JSON.stringify(message),
        headers: options?.delay ? {
          'x-delay': String(options.delay),
          'x-enqueued-at': String(Date.now()),
        } : undefined,
      }],
    });
  }

  async listen(
    handler: (message: object) => Promise<void>
  ): Promise<void> {
    // Create consumers for each topic
    for (const topic of ['activitypods.outbox', 'activitypods.inbox']) {
      const consumer = this.kafka.consumer({
        groupId: `${this.clientId}-${topic}`,
      });
      
      await consumer.connect();
      await consumer.subscribe({ topic });
      
      await consumer.run({
        eachMessage: async (payload: EachMessagePayload) => {
          const message = JSON.parse(payload.message.value!.toString());
          
          // Check for delayed messages
          const delay = payload.message.headers?.['x-delay'];
          const enqueuedAt = payload.message.headers?.['x-enqueued-at'];
          
          if (delay && enqueuedAt) {
            const delayMs = parseInt(delay.toString());
            const enqueued = parseInt(enqueuedAt.toString());
            const waitUntil = enqueued + delayMs;
            
            if (Date.now() < waitUntil) {
              // Re-enqueue with remaining delay
              await this.enqueue(message, { delay: waitUntil - Date.now() });
              return;
            }
          }
          
          await handler(message);
        },
      });
      
      this.consumers.set(topic, consumer);
    }
  }

  private getTopicForMessage(message: any): string {
    // Route based on message type
    if (message.type === 'outbox') {
      return 'activitypods.outbox';
    } else if (message.type === 'inbox') {
      return 'activitypods.inbox';
    }
    return 'activitypods.default';
  }

  private getPartitionKey(message: any): string {
    // Partition by actor for ordering, or by domain for batching
    if (message.recipients?.[0]?.inbox) {
      const url = new URL(message.recipients[0].inbox);
      return url.hostname; // Partition by destination domain
    }
    return message.actorId || 'default';
  }

  async close(): Promise<void> {
    await this.producer.disconnect();
    for (const consumer of this.consumers.values()) {
      await consumer.disconnect();
    }
  }
}
```

---

## Domain-Based Delivery Optimization

### The Problem: Work Amplification

For 100 remote followers across 20 domains:
- **Naive approach**: 100 HTTP requests, 100 signature operations
- **Domain batching**: 20 HTTP requests (shared inbox), 20 signature operations

### Shared Inbox Consolidation

```typescript
// src/delivery/domain-batcher.ts
class DomainBatcher {
  async batchByDomain(
    recipients: Recipient[]
  ): Promise<Map<string, DomainBatch>> {
    const batches = new Map<string, DomainBatch>();
    
    for (const recipient of recipients) {
      const domain = new URL(recipient.inbox).hostname;
      
      if (!batches.has(domain)) {
        batches.set(domain, {
          domain,
          sharedInbox: null,
          recipients: [],
        });
      }
      
      const batch = batches.get(domain)!;
      batch.recipients.push(recipient);
      
      // Check for shared inbox
      if (recipient.endpoints?.sharedInbox && !batch.sharedInbox) {
        batch.sharedInbox = recipient.endpoints.sharedInbox;
      }
    }
    
    return batches;
  }

  async deliverBatch(
    activity: Activity,
    batch: DomainBatch,
    signer: Signer
  ): Promise<DeliveryResult[]> {
    // Use shared inbox if available
    if (batch.sharedInbox && batch.recipients.length > 1) {
      return this.deliverToSharedInbox(activity, batch, signer);
    }
    
    // Fall back to individual delivery with connection reuse
    return this.deliverToIndividualInboxes(activity, batch, signer);
  }
}
```

### Connection Pooling

```typescript
// src/delivery/connection-pool.ts
import { Agent } from 'undici';

class ConnectionPoolManager {
  private pools = new Map<string, Agent>();
  
  getPool(domain: string): Agent {
    if (!this.pools.has(domain)) {
      this.pools.set(domain, new Agent({
        connect: {
          keepAlive: true,
          keepAliveInitialDelay: 1000,
          keepAliveMaxTimeout: 30000,
        },
        connections: 10,
        pipelining: 1,
      }));
    }
    return this.pools.get(domain)!;
  }
}
```

---

## Stream Topology

### Stream1: Local Public Activities

**Source**: Aggregator service watching pod outboxes
**Content**: All public activities created by local users
**Consumers**:
1. Fedify delivery workers (for remote recipients)
2. OpenSearch indexer (for search/analytics)
3. Firehose merger

### Stream2: Remote Public Activities

**Source**: Fedify sidecar after signature verification
**Content**: All public activities received from remote servers
**Consumers**:
1. OpenSearch indexer
2. Firehose merger

### Firehose: Combined Stream

**Source**: Stream1 + Stream2 merged
**Content**: All public activities (local + remote)
**Consumers**:
1. OpenSearch indexer (primary)
2. Analytics pipelines
3. Future: Real-time feeds, notifications

---

## Integration with ActivityPods

### Minimal Changes Required

1. **Add Aggregator Service**: Watches outboxes, publishes to Stream1 and activitypods.outbox
2. **Add Signing API**: Exposes actor private keys for sidecar signing
3. **Accept Forwarded Activities**: Trust X-Signature-Verified header from sidecar

### Aggregator Service

```javascript
// activitypods-integration/aggregator.service.js
module.exports = {
  name: 'aggregator',
  
  events: {
    async 'activitypub.outbox.posted'(ctx) {
      const { activity, actor, recipients } = ctx.params;
      
      // Check if activity is public
      if (!this.isPublicActivity(activity)) {
        return;
      }
      
      // Publish to Stream1 (for OpenSearch/analytics)
      await this.publishToStream1(actor, activity);
      
      // Separate local and remote recipients
      const { local, remote } = this.partitionRecipients(recipients);
      
      // Local delivery handled by ActivityPods (Moleculer)
      // Remote delivery delegated to Fedify sidecar
      if (remote.length > 0) {
        await this.publishToOutboxQueue(actor, activity, remote);
      }
    },
  },
  
  methods: {
    partitionRecipients(recipients) {
      const localDomain = new URL(this.settings.baseUrl).hostname;
      
      return {
        local: recipients.filter(r => 
          new URL(r.id).hostname === localDomain
        ),
        remote: recipients.filter(r => 
          new URL(r.id).hostname !== localDomain
        ),
      };
    },
    
    async publishToOutboxQueue(actor, activity, recipients) {
      await this.producer.send({
        topic: 'activitypods.outbox',
        messages: [{
          key: actor.id,
          value: JSON.stringify({
            type: 'DELIVER_ACTIVITY',
            actorId: actor.id,
            activity,
            recipients: recipients.map(r => ({
              id: r.id,
              inbox: r.inbox,
              sharedInbox: r.endpoints?.sharedInbox,
            })),
            timestamp: Date.now(),
          }),
        }],
      });
    },
  },
};
```

---

## Performance Projections

Based on the performance analysis, the sidecar should achieve:

| Scenario | Current Latency | With Sidecar | Improvement |
|----------|-----------------|--------------|-------------|
| 10 remote followers | 2 seconds | 200ms | 10x |
| 100 remote followers | 15 seconds | 300ms | 50x |
| 1000 remote followers | 3 minutes | 500ms | 360x |
| 100 followers (50 domains) | 30 seconds | 400ms | 75x |

Key optimizations:
- **Async decoupling**: Return 202 Accepted immediately
- **Domain batching**: 10-20x fewer HTTP requests
- **Shared inbox**: Additional 5-10x reduction
- **Connection pooling**: Eliminate TCP handshake overhead
- **Signature caching**: Avoid redundant crypto operations

---

## Deployment

### Docker Compose

```yaml
services:
  fedify-sidecar:
    build: ./fedify-sidecar
    environment:
      - REDPANDA_BROKERS=redpanda:9092
      - ACTIVITYPODS_URL=http://activitypods:3000
      - OPENSEARCH_NODE=http://opensearch:9200
    depends_on:
      - redpanda
      - opensearch

  redpanda:
    image: docker.redpanda.com/redpandadata/redpanda:v24.1.1
    command:
      - redpanda start
      - --smp 1
      - --memory 1G
      - --mode dev-container

  opensearch:
    image: opensearchproject/opensearch:2.12.0
    environment:
      - discovery.type=single-node
      - DISABLE_SECURITY_PLUGIN=true
```

---

## Summary

The v3 architecture correctly positions:

1. **RedPanda as Fedify's message queue** - not just a streaming platform
2. **ActivityPods as authoritative for local federation** - no HTTP between local pods
3. **Sidecar as pure delivery optimization** - no timeline caching (app concern)
4. **Domain batching and shared inbox** - massive HTTP reduction
5. **Stream1/Stream2/Firehose** - for aggregation and OpenSearch indexing
