# ActivityPods Fedify Sidecar Architecture v2

**Author:** Manus AI

**Date:** January 3, 2026

**Version:** 2.0

## 1. Introduction

This document presents a revised architecture for the Mastopod application that properly integrates with ActivityPods using RedPanda as the streaming backbone and OpenSearch as the database for public activities. The key insight is that ActivityPods remains authoritative for all local federation (which does not use HTTP), while the Fedify sidecar handles only remote federation over HTTP.

### 1.1. Core Principles

The architecture is built on the following principles:

1. **ActivityPods is authoritative for local federation**: All communication between pods on the same server happens through internal Moleculer calls, not HTTP. The sidecar does not interfere with this.

2. **Fedify handles remote federation only**: The sidecar intercepts and handles all HTTP-based federation traffic to and from remote servers.

3. **RedPanda is the streaming backbone**: All activity streams flow through RedPanda (Kafka-compatible), enabling real-time processing, replay, and integration with multiple consumers.

4. **OpenSearch is the DBMS for public activities**: All public activities are indexed in OpenSearch, enabling fast queries, full-text search, and analytics.

5. **Minimal changes to ActivityPods core**: The integration requires only adding event publishers to ActivityPods, not modifying its core federation logic.

### 1.2. Stream Definitions

| Stream | Description | Source | Consumers |
|--------|-------------|--------|-----------|
| **Stream1** | All public activities from local pods | Aggregator watching all pod outboxes | Fedify (for remote delivery), OpenSearch indexer |
| **Stream2** | All incoming public remote activities | Fedify sidecar (after verification) | OpenSearch indexer, ActivityPods (for inbox delivery) |
| **Firehose** | Combined Stream1 + Stream2 | RedPanda topic join | OpenSearch indexer, Analytics, External consumers |

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           External Fediverse                                 │
│                    (Mastodon, Pixelfed, PeerTube, etc.)                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼ HTTP (S2S)
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Fedify Sidecar                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │  Inbox Handler  │  │ Delivery Worker │  │   Signature Verification    │  │
│  │  (HTTP → Stream2)│  │ (Stream1 → HTTP)│  │                             │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
          │                       ▲                       │
          ▼                       │                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              RedPanda                                        │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │     Stream1     │  │     Stream2     │  │         Firehose            │  │
│  │ (Local Public)  │  │ (Remote Public) │  │    (Stream1 + Stream2)      │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
          ▲                       │                       │
          │                       ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Aggregator Service                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Watches all pod outboxes via Solid Notifications                   │    │
│  │  Filters for public activities                                       │    │
│  │  Publishes to Stream1                                                │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
          ▲                                               │
          │ Internal (Moleculer)                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ActivityPods Pod Server                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │   Pod 1     │  │   Pod 2     │  │   Pod N     │  │   Jena Fuseki       │ │
│  │  (Alice)    │◄─►│  (Bob)      │◄─►│  (...)      │  │   (RDF Store)       │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│         ▲               ▲               ▲                                    │
│         └───────────────┴───────────────┘                                    │
│                   Local Federation (No HTTP)                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                                          │
                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             OpenSearch                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  activities index (Firehose data)                                    │    │
│  │  - Full-text search on content                                       │    │
│  │  - Aggregations by actor, type, domain                               │    │
│  │  - Time-series queries                                               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 3. Component Details

### 3.1. Aggregator Service

The Aggregator is a new Moleculer service that runs within the ActivityPods environment. Its responsibilities are:

1. **Subscribe to all pod outboxes** using Solid Notifications (WebSocket or Webhook)
2. **Filter for public activities** by checking the `to` and `cc` fields for `as:Public`
3. **Publish to Stream1** via RedPanda producer

The Aggregator does not modify activities; it simply observes and republishes public ones to the stream.

### 3.2. Fedify Sidecar

The Fedify sidecar is responsible for all HTTP-based remote federation:

**Inbound (Remote → Local):**
1. Receives HTTP POST to inbox endpoints from remote servers
2. Verifies HTTP signatures
3. Publishes verified activities to Stream2
4. Forwards to ActivityPods for inbox processing

**Outbound (Local → Remote):**
1. Consumes from Stream1
2. Determines remote recipients
3. Signs requests using ActivityPods signing API
4. Delivers to remote inboxes with retry logic

### 3.3. RedPanda Topics

| Topic | Partitions | Retention | Key | Value |
|-------|------------|-----------|-----|-------|
| `stream1-local-public` | 12 | 7 days | `actorUri` | Activity JSON-LD |
| `stream2-remote-public` | 12 | 7 days | `actorUri` | Activity JSON-LD |
| `firehose` | 24 | 30 days | `actorUri` | Activity JSON-LD + metadata |

The Firehose topic is populated by a RedPanda Streams application that joins Stream1 and Stream2.

### 3.4. OpenSearch Integration

OpenSearch serves as the queryable database for all public activities. The indexer consumes from the Firehose and indexes each activity as a document.

**Index Schema:**
```json
{
  "mappings": {
    "properties": {
      "id": { "type": "keyword" },
      "type": { "type": "keyword" },
      "actor": { "type": "keyword" },
      "actor_domain": { "type": "keyword" },
      "published": { "type": "date" },
      "content": { "type": "text", "analyzer": "standard" },
      "object": { "type": "object", "enabled": true },
      "to": { "type": "keyword" },
      "cc": { "type": "keyword" },
      "origin": { "type": "keyword", "doc_values": true },
      "indexed_at": { "type": "date" }
    }
  }
}
```

## 4. Data Flows

### 4.1. Local User Posts Publicly

1. User creates a Note via Mastopod frontend
2. ActivityPods saves to user's outbox in Fuseki
3. Solid Notification triggers Aggregator
4. Aggregator checks if activity is public
5. If public, Aggregator publishes to Stream1 (RedPanda)
6. Fedify consumes from Stream1, determines remote recipients
7. Fedify signs and delivers to remote inboxes
8. OpenSearch indexer consumes from Firehose, indexes activity

### 4.2. Remote User Posts to Local User

1. Remote server POSTs to local user's inbox via HTTP
2. Fedify sidecar intercepts the request
3. Fedify verifies HTTP signature
4. Fedify publishes to Stream2 (RedPanda)
5. Fedify forwards to ActivityPods inbox service
6. ActivityPods processes and stores in user's inbox (Fuseki)
7. OpenSearch indexer consumes from Firehose, indexes activity

### 4.3. Local-to-Local Federation

1. Alice (local) follows Bob (local)
2. ActivityPods handles this entirely via Moleculer calls
3. No HTTP involved, no Fedify involvement
4. If the Follow activity is public, Aggregator publishes to Stream1
5. OpenSearch indexes the activity

## 5. Implementation Files

The implementation consists of the following components:

```
fedify-sidecar/
├── src/
│   ├── config/
│   │   └── index.js              # Configuration with RedPanda settings
│   ├── services/
│   │   ├── redpanda.js           # RedPanda producer/consumer
│   │   ├── opensearch.js         # OpenSearch client and indexer
│   │   ├── signing.js            # HTTP signature handling
│   │   └── delivery.js           # Outbound delivery worker
│   ├── handlers/
│   │   ├── inbox.js              # Inbound activity handler
│   │   ├── actor.js              # Actor document handler
│   │   └── webfinger.js          # WebFinger handler
│   └── index.js                  # Main application
├── activitypods-integration/
│   ├── aggregator.service.js     # Stream1 aggregator
│   ├── signing-api.service.js    # Signing API for Fedify
│   └── inbox-receiver.service.js # Receives from Fedify
├── docker-compose.yml            # Full stack deployment
└── README.md                     # Documentation
```

## 6. Deployment Topology

```
┌─────────────────────────────────────────────────────────────────┐
│                        Docker Compose Stack                      │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Traefik    │  │  RedPanda   │  │      OpenSearch         │  │
│  │  (Reverse   │  │  (Streaming)│  │      (Search DB)        │  │
│  │   Proxy)    │  │             │  │                         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│         │               │                    │                   │
│         ▼               ▼                    ▼                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Fedify     │  │ Aggregator  │  │   OpenSearch Indexer    │  │
│  │  Sidecar    │  │  Service    │  │                         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│         │               │                                        │
│         ▼               ▼                                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    ActivityPods                              ││
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────┐ ││
│  │  │ Backend │  │Frontend │  │  Fuseki │  │     Redis       │ ││
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────────────┘ ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## 7. Key Design Decisions

### 7.1. Why RedPanda over Redis Pub/Sub?

RedPanda (Kafka-compatible) provides several advantages over Redis Pub/Sub for this use case:

| Feature | Redis Pub/Sub | RedPanda |
|---------|---------------|----------|
| Message persistence | No | Yes (configurable retention) |
| Consumer groups | No | Yes (parallel processing) |
| Replay capability | No | Yes (offset-based) |
| Exactly-once semantics | No | Yes (with transactions) |
| Horizontal scaling | Limited | Excellent |
| Backpressure handling | Poor | Excellent |

### 7.2. Why OpenSearch for Public Activities?

OpenSearch provides capabilities that Fuseki (SPARQL) cannot efficiently deliver:

| Capability | Fuseki (SPARQL) | OpenSearch |
|------------|-----------------|------------|
| Full-text search | Limited | Excellent |
| Aggregations | Slow | Fast |
| Time-series queries | Poor | Excellent |
| Horizontal scaling | Difficult | Easy |
| Real-time indexing | No | Yes |

The Firehose data in OpenSearch enables features like trending topics, search, and analytics without impacting the authoritative Fuseki store.

### 7.3. Separation of Concerns

| Component | Responsibility | Does NOT Do |
|-----------|----------------|-------------|
| ActivityPods | Local federation, data authority, WAC | Remote HTTP federation |
| Aggregator | Watch outboxes, filter public, publish to Stream1 | Modify activities, deliver to remotes |
| Fedify Sidecar | Remote federation, signatures, delivery | Local federation, data storage |
| RedPanda | Stream routing, persistence, replay | Processing logic |
| OpenSearch | Query, search, analytics | Authoritative storage |

## 8. References

[1] Fedify Documentation. https://fedify.dev/

[2] ActivityPods Documentation. https://docs.activitypods.org/

[3] RedPanda Documentation. https://docs.redpanda.com/

[4] OpenSearch Documentation. https://opensearch.org/docs/

[5] ActivityPub Specification. https://www.w3.org/TR/activitypub/
