# Mastopod + ActivityPods Federation Architecture Overview

## Executive Summary

This architecture enables **Mastopod** (a Mastodon-compatible ActivityPub client) to work with **ActivityPods** (a Solid-based pod provider) while achieving high-performance federation with the broader Fediverse. The key innovation is a **Fedify Sidecar** that handles all remote HTTP federation, combined with an **event-driven streaming layer** that captures all public activities into queryable streams.

-----

## System Separation: Work Queues vs Event Logs

|System           |Purpose                        |What Goes There                                   |
|-----------------|-------------------------------|--------------------------------------------------|
|**Redis Streams**|Fedify’s work queue (transient)|Delivery jobs, retries, delayed messages          |
|**RedPanda**     |Durable event logs (persistent)|Stream1, Stream2, Firehose, OpenSearch consumption|

**Critical Distinction**: Redis Streams handles transient work (jobs that get processed, ACKed, and removed). RedPanda handles durable event logs (immutable streams retained for indexing, replay, and analytics).

-----

## System Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL FEDIVERSE                              │
│                    (Mastodon, Pleroma, Misskey, etc.)                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ HTTPS (HTTP Signatures)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TRAEFIK (Reverse Proxy)                         │
│  Routes: /.well-known/webfinger, /inbox, /users/*/inbox → Fedify Sidecar    │
│  Routes: Everything else → ActivityPods                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                          │                              │
                          ▼                              ▼
┌────────────────────────────────────┐    ┌────────────────────────────────────┐
│         FEDIFY SIDECAR             │    │          ACTIVITYPODS              │
│                                    │    │                                    │
│  • Remote federation (HTTP)        │    │  • Local pod management            │
│  • HTTP Signature verification     │    │  • Local federation (Moleculer)    │
│  • Consumes from fedify:queue      │    │  • Signing API (keys stay here)    │
│  • Delivery with retry/backoff     │    │  • User data (Solid pods)          │
│  • Shared inbox optimization       │    │  • WAC permissions                 │
│  • Publishes public → Stream2      │    │  • XADD to fedify:queue            │
│                                    │    │  • Publishes public → Stream1      │
└────────────────────────────────────┘    └────────────────────────────────────┘
          │                                          │
          │                                          │
          ▼                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                   REDIS                                      │
│                                                                              │
│  Fedify Work Queues (Redis Streams) — TRANSIENT WORK:                       │
│  • fedify:queue          - Delivery jobs (ActivityPods XADDs here)          │
│  • fedify:delayed        - Delayed/retry messages (Sorted Set)              │
│  • Consumer groups for horizontal scaling                                    │
│  • XAUTOCLAIM for crash recovery                                            │
│  • Jobs are ACKed and removed after successful processing                   │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              REDPANDA (Kafka-compatible)                     │
│                                                                              │
│  Event Logs (immutable streams) — DURABLE LOGS:                             │
│  ┌──────────────────────────┐    ┌──────────────────────────┐               │
│  │ Stream1                  │    │ Stream2                  │               │
│  │ ap.stream1.local-public  │    │ ap.stream2.remote-public │               │
│  │ (local public only)      │    │ (remote public only)     │               │
│  └───────────┬──────────────┘    └─────────────┬────────────┘               │
│              │                                 │                             │
│              └─────────────┬───────────────────┘                             │
│                            ▼                                                 │
│              ┌───────────────────────┐                                       │
│              │ Firehose              │                                       │
│              │ ap.firehose.v1        │                                       │
│              │ (Stream1 + Stream2)   │                                       │
│              └───────────┬───────────┘                                       │
│                          │                                                   │
│  Additional Topics:      │                                                   │
│  • ap.tombstone.v1       │  - Delete events (compacted topic)               │
│  • ap.dlq.v1             │  - Dead letter queue for failed processing       │
└──────────────────────────┼──────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              OPENSEARCH                                      │
│                                                                              │
│  Queryable Activity Store:                                                  │
│  • Consumes from Firehose (ap.firehose.v1)                                  │
│  • Indexes all public activities                                            │
│  • Full-text search on content                                              │
│  • Faceted queries (by actor, type, date, hashtag, etc.)                    │
│  • Powers timeline and discovery features                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

-----

## Topic Naming Convention

|Topic                        |Purpose    |Content                                        |Retention             |
|-----------------------------|-----------|-----------------------------------------------|----------------------|
|`ap.stream1.local-public.v1` |Stream1    |Local public activities only                   |30 days               |
|`ap.stream2.remote-public.v1`|Stream2    |Remote public activities only                  |30 days               |
|`ap.firehose.v1`             |Firehose   |Stream1 + Stream2 merged                       |30 days               |
|`ap.tombstone.v1`            |Deletes    |Delete events (compacted, keyed by activity ID)|Indefinite (compacted)|
|`ap.dlq.v1`                  |Dead Letter|Failed processing for manual review            |90 days               |

**Notes**:

- We use the `ap.` prefix consistently across all topics
- Stream1 and Stream2 contain **only public activities** for the firehose/OpenSearch
- They are **NOT** delivery queues—delivery uses Redis Streams (`fedify:queue`)
- Diagrams may use abbreviated names (e.g., `ap.stream1.local-public`) for readability

-----

## Data Flow Diagrams

### Outbound Flow (Local User Posts to Fediverse)

```
User creates Note in Mastopod
            │
            ▼
┌─────────────────────────┐
│  ActivityPods receives  │
│  POST to user's outbox  │
└─────────────────────────┘
            │
            │ 1. Store activity in Fuseki
            │ 2. Local federation via Moleculer (no HTTP)
            │ 3. Resolve recipients
            │ 4. Two parallel actions based on recipients:
            │
            ├────────────────────────────────────────────────────────┐
            │                                                        │
            │ IF REMOTE RECIPIENTS:                                 │ IF PUBLIC:
            │ XADD to fedify:queue                                  │ Publish to Stream1
            │ (for remote delivery)                                  │ (for firehose/indexing)
            ▼                                                        ▼
┌─────────────────────────┐                        ┌─────────────────────────┐
│  Redis Streams          │                        │  RedPanda               │
│  fedify:queue           │                        │  ap.stream1.local-      │
│                         │                        │  public.v1              │
│  Message contains:      │                        │  (public only)          │
│  • actorUri             │                        └─────────────────────────┘
│  • activityId           │                                      │
│  • recipients[]         │                                      │
│  • payload (activity)   │                                      ▼
└─────────────────────────┘                        ┌─────────────────────────┐
            │                                      │  Firehose Merger        │
            │ Fedify consumes via XREADGROUP       │  (combines with Stream2)│
            ▼                                      └─────────────────────────┘
┌─────────────────────────┐                                      │
│  Fedify Sidecar         │                                      ▼
│                         │                        ┌─────────────────────────┐
│  1. Read job from queue │                        │  OpenSearch Indexer     │
│  2. Group by shared     │                        │  (consumes Firehose)    │
│     inbox               │                        └─────────────────────────┘
│  3. Request signatures  │                                      │
│     from ActivityPods   │                                      ▼
│     Signing API         │                        ┌─────────────────────────┐
│  4. Deliver to remote   │                        │  OpenSearch Index       │
│     inboxes (parallel)  │                        │  (queryable store)      │
│  5. XACK on success     │                        └─────────────────────────┘
│  6. Retry on failure    │
└─────────────────────────┘
            │
            ▼
┌─────────────────────────┐
│  Remote Fediverse       │
│  inboxes                │
└─────────────────────────┘
```

**Key Points**:

- Fedify consumes from `fedify:queue` (Redis Streams), **NOT** from Stream1
- Stream1 is **only** for public activities feeding the firehose
- Activities without remote recipients skip the delivery queue entirely
- Both paths (delivery + firehose) are triggered in parallel for public activities with remote recipients

-----

### Inbound Flow (Remote Activity Arrives)

```
Remote server POSTs to /inbox or /users/{id}/inbox
            │
            │ Traefik routes to Fedify Sidecar
            ▼
┌─────────────────────────┐
│  Fedify Sidecar         │
│  (HTTP endpoint)        │
│                         │
│  1. Verify HTTP         │
│     Signature           │
│  2. Parse activity JSON │
│  3. Check visibility    │
│     (to/cc addressing)  │
└─────────────────────────┘
            │
            ├────────────────────────────────────────────────────────┐
            │                                                        │
            │ ALWAYS:                                               │ IF PUBLIC:
            │ Forward to ActivityPods                               │ Publish to Stream2
            │ (internal inbox API)                                   │ (for firehose/indexing)
            ▼                                                        ▼
┌─────────────────────────┐                        ┌─────────────────────────┐
│  ActivityPods           │                        │  RedPanda               │
│  (internal inbox API)   │                        │  ap.stream2.remote-     │
│                         │                        │  public.v1              │
│  • Validate activity    │                        │  (public only)          │
│  • Store in recipient's │                        └─────────────────────────┘
│    pod (Fuseki)         │                                      │
│  • Apply side effects   │                                      ▼
│    (Follow, Like, etc.) │                        ┌─────────────────────────┐
│  • Local Moleculer      │                        │  Firehose Merger        │
│    notifications        │                        │  (combines with Stream1)│
└─────────────────────────┘                        └─────────────────────────┘
            │                                                    │
            ▼                                                    ▼
┌─────────────────────────┐                        ┌─────────────────────────┐
│  User's Pod (Solid)     │                        │  OpenSearch Indexer     │
│  • Inbox collection     │                        │  (consumes Firehose)    │
│  • Notifications        │                        └─────────────────────────┘
└─────────────────────────┘                                      │
                                                                 ▼
                                                   ┌─────────────────────────┐
                                                   │  OpenSearch Index       │
                                                   │  (queryable store)      │
                                                   └─────────────────────────┘
```

**Key Points**:

- Fedify forwards **ALL** verified activities to ActivityPods for inbox processing
- Fedify publishes **only PUBLIC** activities to Stream2 for the firehose
- Non-public activities (followers-only, direct) go to ActivityPods but never touch RedPanda

-----

## Signing API (Internal)

The Signing API is **internal only**—it’s how the Fedify Sidecar requests HTTP signatures from ActivityPods without ever having access to private keys.

### Endpoint

```
POST /internal/signing/batch
Authorization: Bearer <shared-secret>
Content-Type: application/json
```

### Flow

```
Fedify needs to POST to remote inbox(es)
            │
            │ 1. Prepare activity JSON (immutable bytes)
            │ 2. Compute SHA-256 digest of body
            │ 3. Build signature input string for each target
            ▼
┌─────────────────────────┐
│  POST to ActivityPods   │
│  /internal/signing/batch│
│                         │
│  Request: {             │
│    actorUri: "https://  │
│      pod.example/alice",│
│    requests: [{         │
│      id: "req-1",       │
│      method: "POST",    │
│      url: "https://     │
│        mastodon.social/ │
│        inbox",          │
│      headers: {         │
│        host, date,      │
│        digest, ...      │
│      }                  │
│    }, ...]              │
│  }                      │
└─────────────────────────┘
            │
            │ Internal network only (not exposed via Traefik)
            ▼
┌─────────────────────────┐
│  ActivityPods           │
│  signing-api.service.js │
│  (Moleculer service)    │
│                         │
│  1. Validate bearer     │
│     token               │
│  2. Look up actor's     │
│     private key via     │
│     KeysService         │
│  3. Generate RSA-SHA256 │
│     signature for each  │
│     request             │
│  4. Audit log the       │
│     signing event       │
│  5. Return signatures   │
└─────────────────────────┘
            │
            │ Response: {
            │   signatures: [{
            │     id: "req-1",
            │     signature: "keyId=\"...\",..."
            │   }, ...]
            │ }
            ▼
┌─────────────────────────┐
│  Fedify Sidecar         │
│                         │
│  • Attach Signature     │
│    header to each       │
│    request              │
│  • Send to remote inbox │
│  • Body bytes unchanged │
│    (digest must match)  │
└─────────────────────────┘
```

### Key Principles

|Principle                        |Implementation                                                         |
|---------------------------------|-----------------------------------------------------------------------|
|**Keys never leave ActivityPods**|Sidecar sends unsigned request details, receives only signature headers|
|**ActivityPods is the authority**|All signing decisions made by ActivityPods; rate limiting enforced here|
|**Immutable body bytes**         |Digest computed before signing; exact same bytes sent to remote        |
|**Internal only**                |Endpoint not exposed via Traefik; authenticated with shared secret     |
|**Batch efficiency**             |Single request signs multiple deliveries (e.g., 50 shared inboxes)     |
|**Audit trail**                  |All signing events logged for security review                          |

-----

## Local Public Activity Aggregation (Stream1 Publisher)

ActivityPods does not have a built-in method to aggregate all public activities across pods. We solve this using **PodActivitiesHandlerMixin** with a custom service that publishes to Stream1 and enqueues delivery jobs.

### How It Works

1. **PodActivitiesWatcher** is ActivityPods’ built-in mechanism for subscribing to inbox/outbox events via Solid notifications.
1. We create a **stream1-publisher.service.js** that:
- Uses `PodActivitiesHandlerMixin` to watch outbox events
- Filters for activity types (Create, Update, Delete, Announce, Like, etc.)
- Publishes **public** activities to Stream1 (RedPanda)
- Enqueues activities with **remote recipients** to `fedify:queue` (Redis)
1. This is **event-driven** (not polling):
- We react to activities as they happen
- Single source of truth for both firehose and delivery

### Implementation (Moleculer Service)

```javascript
// services/stream1-publisher.service.js

const { PodActivitiesHandlerMixin } = require('@activitypods/app');
const { Kafka } = require('kafkajs');
const Redis = require('ioredis');
const crypto = require('crypto');

module.exports = {
  name: 'stream1-publisher',
  mixins: [PodActivitiesHandlerMixin],

  settings: {
    kafka: {
      brokers: process.env.REDPANDA_BROKERS?.split(',') || ['localhost:9092'],
      clientId: 'activitypods-stream1'
    },
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379
    }
  },

  activities: {
    // Watch all outgoing activities that might need federation or indexing
    outboundActivity: {
      match: {
        type: ['Create', 'Update', 'Delete', 'Announce', 'Like', 'Undo', 'Follow', 'Accept', 'Reject'],
      },
      async onEmit(ctx, activity, actorUri) {
        const isPublic = this.isPublicActivity(activity);
        const remoteRecipients = await this.resolveRemoteRecipients(ctx, activity);

        // Path 1: If public, publish to Stream1 for firehose/OpenSearch
        if (isPublic) {
          await this.publishToStream1(activity, actorUri);
        }

        // Path 2: If remote recipients exist, enqueue for Fedify delivery
        if (remoteRecipients.length > 0) {
          await this.enqueueForDelivery(activity, actorUri, remoteRecipients);
        }

        this.logger.info(`Processed outbound activity ${activity.id}`, {
          isPublic,
          remoteRecipientCount: remoteRecipients.length,
          activityType: activity.type
        });
      }
    }
  },

  async started() {
    // Initialize Kafka producer for Stream1
    this.kafka = new Kafka(this.settings.kafka);
    this.producer = this.kafka.producer({
      compression: 2, // Zstd
      idempotent: true
    });
    await this.producer.connect();

    // Initialize Redis for delivery queue
    this.redis = new Redis(this.settings.redis);

    this.logger.info('Stream1 publisher started');
  },

  async stopped() {
    await this.producer?.disconnect();
    await this.redis?.quit();
  },

  methods: {
    /**
     * Check if activity is addressed to Public
     */
    isPublicActivity(activity) {
      const PUBLIC_URIS = [
        'https://www.w3.org/ns/activitystreams#Public',
        'as:Public',
        'Public'
      ];
      
      const to = this.normalizeToArray(activity.to);
      const cc = this.normalizeToArray(activity.cc);
      
      return [...to, ...cc].some(addr => PUBLIC_URIS.includes(addr));
    },

    /**
     * Resolve recipients to inbox URLs, filtering to remote only
     */
    async resolveRemoteRecipients(ctx, activity) {
      const allRecipients = [
        ...this.normalizeToArray(activity.to),
        ...this.normalizeToArray(activity.cc),
        ...this.normalizeToArray(activity.bto),
        ...this.normalizeToArray(activity.bcc)
      ].filter(r => r && !r.includes('#Public'));

      const remoteRecipients = [];
      const localDomain = new URL(this.settings.baseUrl || process.env.BASE_URL).hostname;

      for (const recipient of allRecipients) {
        try {
          // Skip public addressing
          if (recipient.includes('#Public') || recipient === 'as:Public') {
            continue;
          }

          const recipientUrl = new URL(recipient);
          
          // Skip local recipients (handled by Moleculer)
          if (recipientUrl.hostname === localDomain) {
            continue;
          }

          // This is a remote recipient
          remoteRecipients.push(recipient);
        } catch (e) {
          // Not a valid URL, skip
          this.logger.warn(`Invalid recipient URI: ${recipient}`);
        }
      }

      return remoteRecipients;
    },

    /**
     * Publish to RedPanda Stream1 (for firehose/OpenSearch)
     */
    async publishToStream1(activity, actorUri) {
      const envelope = {
        v: 1,
        eventId: crypto.randomUUID(),
        direction: 'outgoing',
        createdAt: Date.now(),
        actorUri,
        activityId: activity.id,
        activityType: activity.type,
        objectId: activity.object?.id || activity.object,
        objectType: activity.object?.type,
        visibility: {
          isPublic: true,
          reason: 'public-addressing'
        },
        payload: activity
      };

      await this.producer.send({
        topic: 'ap.stream1.local-public.v1',
        messages: [{
          key: activity.id,
          value: JSON.stringify(envelope),
          headers: {
            'content-type': 'application/json',
            'actor-uri': actorUri,
            'activity-type': activity.type
          }
        }]
      });

      this.logger.debug(`Published to Stream1: ${activity.id}`);
    },

    /**
     * XADD to Redis Streams for Fedify delivery
     */
    async enqueueForDelivery(activity, actorUri, remoteRecipients) {
      const deliveryId = crypto.randomUUID();

      await this.redis.xadd(
        'fedify:queue',
        '*',
        'deliveryId', deliveryId,
        'actorUri', actorUri,
        'activityId', activity.id,
        'activityType', activity.type,
        'recipients', JSON.stringify(remoteRecipients),
        'payload', JSON.stringify(activity),
        'enqueuedAt', Date.now().toString()
      );

      this.logger.debug(`Enqueued for delivery: ${activity.id} to ${remoteRecipients.length} remote recipients`);
    },

    /**
     * Normalize to/cc/bto/bcc to array
     */
    normalizeToArray(value) {
      if (!value) return [];
      return Array.isArray(value) ? value : [value];
    }
  }
};
```

-----

## Envelope Schema (ApEventEnvelopeV1)

All messages in RedPanda streams use a consistent envelope for filtering, routing, and deduplication:

```typescript
interface ApEventEnvelopeV1 {
  // Schema version (for forward compatibility)
  v: 1;
  
  // Unique ID for deduplication
  eventId: string;  // UUID
  
  // Direction relative to this server
  direction: 'incoming' | 'outgoing';
  
  // Unix timestamp in milliseconds
  createdAt: number;
  
  // Actor who performed the action
  actorUri: string;
  
  // Activity identifiers
  activityId: string;
  activityType: string;  // Create, Update, Delete, Announce, Like, etc.
  
  // Object identifiers (if applicable)
  objectId?: string;
  objectType?: string;  // Note, Article, Image, Person, etc.
  
  // Visibility classification
  visibility: {
    isPublic: boolean;
    reason: 'public-addressing' | 'followers-only' | 'direct';
  };
  
  // Source information (for remote activities)
  sourceHost?: string;
  
  // Recipient list (for outgoing activities)
  recipients?: string[];
  
  // The actual ActivityStreams object
  payload: object;
}
```

### Example Envelope

```json
{
  "v": 1,
  "eventId": "550e8400-e29b-41d4-a716-446655440000",
  "direction": "outgoing",
  "createdAt": 1706300400000,
  "actorUri": "https://pod.example/alice",
  "activityId": "https://pod.example/alice/activities/123",
  "activityType": "Create",
  "objectId": "https://pod.example/alice/notes/456",
  "objectType": "Note",
  "visibility": {
    "isPublic": true,
    "reason": "public-addressing"
  },
  "payload": {
    "@context": "https://www.w3.org/ns/activitystreams",
    "id": "https://pod.example/alice/activities/123",
    "type": "Create",
    "actor": "https://pod.example/alice",
    "to": ["https://www.w3.org/ns/activitystreams#Public"],
    "cc": ["https://pod.example/alice/followers"],
    "object": {
      "id": "https://pod.example/alice/notes/456",
      "type": "Note",
      "content": "Hello, Fediverse!"
    }
  }
}
```

-----

## Local vs Remote Federation

|Type      |Handler       |Protocol                |Use Case                  |
|----------|--------------|------------------------|--------------------------|
|**Local** |ActivityPods  |Moleculer (internal RPC)|Pod-to-pod on same server |
|**Remote**|Fedify Sidecar|HTTP with Signatures    |To/from external Fediverse|

### Local Federation

- Uses Moleculer’s internal messaging
- No HTTP overhead, no signatures needed
- Fast and secure within the same server
- Handled entirely by ActivityPods

### Remote Federation

- Goes through the Fedify Sidecar
- Full HTTP Signature compliance (Cavage draft-12)
- Exponential backoff retry (1s → 12h max)
- Shared inbox optimization (one POST per server)
- Consumer groups for horizontal scaling

-----

## Component Responsibilities

### ActivityPods (Minimal Changes)

ActivityPods remains the authoritative system for:

|Responsibility      |Description                                       |
|--------------------|--------------------------------------------------|
|**User Identity**   |WebID, actor documents, key pairs                 |
|**Data Storage**    |Solid pods, LDP containers, Fuseki triplestore    |
|**Permissions**     |WAC (Web Access Control)                          |
|**Local Federation**|Pod-to-pod via Moleculer (no HTTP)                |
|**Signing**         |HTTP Signature generation via internal Signing API|
|**Activity Events** |PodActivitiesWatcher for inbox/outbox events      |

**New Services** (Moleculer mixins, not core changes):

- `signing-api.service.js` — Exposes internal batch signing endpoint
- `stream1-publisher.service.js` — Publishes public activities to Stream1, enqueues delivery jobs

### Fedify Sidecar

|Responsibility        |Description                                             |
|----------------------|--------------------------------------------------------|
|**Inbound HTTP**      |Receive activities at `/inbox`, verify HTTP Signatures  |
|**Outbound HTTP**     |Consume from `fedify:queue`, deliver to remote inboxes  |
|**Signature Requests**|Call ActivityPods Signing API for outbound signatures   |
|**Stream2 Publishing**|Publish public inbound activities to RedPanda           |
|**WebFinger**         |Respond to `/.well-known/webfinger` for remote discovery|
|**Shared Inbox**      |Optimize delivery to servers with many recipients       |
|**Retry Logic**       |Exponential backoff, dead letter handling               |

### Redis

|Component       |Purpose                               |
|----------------|--------------------------------------|
|`fedify:queue`  |Delivery jobs stream (XADD/XREADGROUP)|
|`fedify:delayed`|Delayed/retry messages (Sorted Set)   |
|Consumer Groups |Horizontal scaling of Fedify workers  |
|XAUTOCLAIM      |Crash recovery for stuck messages     |

### RedPanda

|Topic                        |Purpose                                    |
|-----------------------------|-------------------------------------------|
|`ap.stream1.local-public.v1` |Local public activities (from ActivityPods)|
|`ap.stream2.remote-public.v1`|Remote public activities (from Fedify)     |
|`ap.firehose.v1`             |Stream1 + Stream2 merged                   |
|`ap.tombstone.v1`            |Delete events (compacted topic)            |
|`ap.dlq.v1`                  |Dead letter queue for failed processing    |

### OpenSearch

|Capability           |Description                       |
|---------------------|----------------------------------|
|**Firehose Consumer**|Indexes from `ap.firehose.v1`     |
|**Full-Text Search** |Content, hashtags, mentions       |
|**Timeline Queries** |By actor, type, date range        |
|**Discovery**        |Trending topics, suggested follows|
|**Analytics**        |Activity metrics, federation stats|

-----

## Summary

|Goal                        |Solution                                                    |
|----------------------------|------------------------------------------------------------|
|Minimal ActivityPods changes|Add Moleculer services only (Signing API, Stream1 Publisher)|
|Separate concerns           |Redis Streams = transient work; RedPanda = durable logs     |
|Delivery queue              |`fedify:queue` (Redis Streams) — Fedify consumes            |
|Public streams              |Stream1 + Stream2 (RedPanda) — for firehose/OpenSearch only |
|Local public aggregation    |PodActivitiesHandlerMixin → Stream1                         |
|Remote public aggregation   |Fedify inbound → Stream2                                    |
|Unified search              |Firehose (Stream1 + Stream2) → OpenSearch                   |
|Secure signing              |Keys never leave ActivityPods; internal batch Signing API   |
|Reliable delivery           |Exponential backoff, consumer groups, XAUTOCLAIM            |
|Horizontal scaling          |Add Fedify workers, add Firehose consumers independently    |