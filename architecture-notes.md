# ActivityPods Architecture v5 - Key Findings

## Tiered Architecture Overview

### CORE (Required)
- **Moleculer Core**: Node.js micro-services framework (ActivityPods/SemApps)
- **Jena Fuseki**: Primary RDF/SPARQL datastore for pod resources
- **Redis**: Ephemeral state (rate limits, dedupe, caching)
- **OIDC Provider**: Solid-OIDC authentication
- **KeysService**: Manages actor keypairs (RSA/Ed25519)

Core Services:
- PodResourcesService: LDP / CRUD operations
- PodOutboxService: ActivityPub Outbox (source of truth for local activities)
- PodInboxService: AUTHORITATIVE inbound acceptance
- PodWacGroupsService: WAC / ACL authorization
- PodCollectionsService: AS Collections management

### TIER 2 (Enhanced - Optional)
- **Stream1 Publisher**: Produces Stream1 from outbox.posted events
- **Signing API**: Batch HTTP Signatures (~100ms for 1000 signatures)
- **Fedify Sidecar**: Federation gateway (CONSUMES Stream1, does not produce)
- **RedPanda**: Kafka-compatible bus for Stream1
- **PodWatcher**: Reactive hooks for inbox/outbox patterns
- **Inbound Handoff**: Sidecar-to-pod boundary for verified activities
- **RelayService**: Manages relay subscriptions (Buzz Relay, etc.)

### TIER 3 (Full - Optional)
- **Stream2**: Remote public activities from relays
- **Firehose Merger**: Combines Stream1 + Stream2
- **OpenSearch**: Activity index for feeds/search
- **Tombstones**: Critical for delete/update semantics
- **PodFeedService**: Returns skeletons (URIs), not full objects
- **PodHydrationService**: Turns URIs into shaped objects with WAC enforcement
- **Durable Streams**: Client delivery gateway (SSE + WebSocket)
- **Notification pipeline**: Raw → Grouper → Delivery
- **Media pipeline**: Router → Image/Video Processor → Blossom Storage

## Key Principles

1. **PROVIDER ELECTABLE**: Providers elect Tier 2/3 components. Apps adapt to exposed capabilities.
2. **FAN-OUT AVOIDANT**: Feeds computed at read time via OpenSearch. No per-user timeline storage.
3. **AUTHORITATIVE INBOX**: Sidecars pre-verify but PodInboxService is authority for policy + persistence.
4. **PODS STORE, APPS PRESENT**: Feed Engine returns skeletons. Hydration API shapes objects.

## Critical Corrections (v5)

- **Stream1 Source**: Pod events → Stream1 Publisher → RedPanda. Fedify CONSUMES, does not produce.
- **Inbound Authority**: Fedify → Inbound Handoff → PodInboxService (authoritative accept/store).
- **Tombstones Lane**: Without tombstones, deleted content remains in indexes forever.
- **Redis Dedupe**: Optimization only. Correctness requires deterministic keys + idempotent consumers.

## Data Flows

### OUTBOUND
PodOutbox → Event Tap → Stream1 Publisher → RedPanda (Stream1) → Fedify (consume) → Signing API → Remote Inboxes

### INBOUND
Remote → Fedify (verify) → Inbound Handoff → PodInboxService (authority) → Fuseki (persist)

### FIREHOSE
Stream1 + Stream2 → Firehose Merger → ap.firehose.v1 → OpenSearch (upsert) + Tombstones (delete)

### FEEDS
Client → PodFeedService → OpenSearch (query) → Skeleton (URIs) → PodHydration (shape) → App (render)

## Fedify Sidecar Role

The Fedify sidecar is positioned as a **federation gateway** that:
1. Consumes Stream1 for delivery (does NOT produce it)
2. Handles durable retries with per-domain throttling
3. Performs signature verification at edge
4. Manages relay ingestion (produces Stream2)
5. Uses two-stage fan-out architecture
6. Keys NEVER leave pod boundary - uses Signing API for batch signatures


## Fedify Framework Research

### What is Fedify?
Fedify is a TypeScript library for building federated server apps powered by ActivityPub and other standards. Key features include:

- **ActivityPub server and client**: Full ActivityPub implementation
- **Activity Vocabulary**: Type-safe objects for Activity Vocabulary
- **WebFinger**: Client and server implementation
- **HTTP Signatures**: Signing and verifying HTTP Signatures and HTTP Message Signatures
- **Linked Data Signatures**: Creating and verifying Linked Data Signatures
- **Object Integrity Proofs (FEP-8b32)**: Creating and verifying Object Integrity Proofs
- **NodeInfo**: Server and client implementation
- **Integration**: Works with Express, Fastify, Koa, Hono, h3, Fresh, SvelteKit, NestJS, Elysia, Next.js

### Federation Object
The Federation object is the main entry point of Fedify. Key features:
- Registering actor dispatchers
- Registering inbox listeners
- Registering collections
- Registering object dispatchers
- Creating Context objects
- Maintaining a queue of outgoing activities
- Registering NodeInfo dispatchers

### Message Queue Support
Fedify supports multiple message queue implementations:
- **InProcessMessageQueue**: In-memory, for development/testing
- **DenoKvMessageQueue**: Deno runtime, production-ready
- **RedisMessageQueue**: Redis-backed, scalable, production-ready
- **PostgresMessageQueue**: PostgreSQL-backed, uses LISTEN/NOTIFY
- **AmqpMessageQueue**: AMQP 0-9-1 (RabbitMQ), reliable and scalable
- **WorkersMessageQueue**: Cloudflare Workers

Key queue features:
- Separate queues for inbox and outbox
- Parallel message processing
- Native retry mechanisms with exponential backoff
- Can separate message processing from main process

### Integration Architecture
Fedify behaves as middleware that wraps around web frameworks:
- Intercepts incoming HTTP requests
- Dispatches based on request path and Accept header (content negotiation)
- Allows Fedify and web framework to coexist on same domain/port
- Example: /.well-known/webfinger handled by Fedify, /users/alice with Accept: text/html goes to web framework

### Sidecar Pattern Applicability
For ActivityPods integration, Fedify can serve as a sidecar that:
1. Handles all federation-related HTTP traffic
2. Manages HTTP signature verification/creation
3. Provides durable message queuing for activity delivery
4. Offloads federation complexity from ActivityPods core
5. Consumes events from ActivityPods and delivers to remote servers
6. Receives inbound activities and forwards to ActivityPods for authoritative processing


## Mastopod/ActivityPods Analysis

### Current Architecture
Mastopod is built on the ActivityPods framework using:
- **@activitypods/app**: v2.1.0 - App framework for building ActivityPods apps
- **@semapps/core**: v1.1.0 - Core SemApps services
- **@semapps/crypto**: v1.1.0 - Cryptographic services including HTTP signatures
- **Moleculer**: Microservices framework for service orchestration

### Key Services
The backend uses Moleculer services:
- **AppService**: Application registration and OIDC configuration
- **CoreService**: Base services (triplestore, LDP, ActivityPub)
- **SignatureService**: HTTP signature handling via @semapps/crypto
- **Pod-activities-watcher**: Watches inbox/outbox for activity patterns

### Identified Issues from GitHub

#### Compatibility Issues (Issue #54)
| Tool | Status | Issue |
|------|--------|-------|
| Mastodon | Working | No issues |
| Peertube | Working | No issues |
| Pixelfed | Blocking | 401 errors on inbox, outbox not publicly accessible |
| Castopod | Blocking | Object type mismatch |
| Funkwhale | Blocking | Unknown issues |
| WriteFreely | Blocking | Compatibility issues |
| Plume | Non-blocking | Minor issues |
| Mobilizon | Non-blocking | Minor issues |

#### Performance Issues
1. **Issue #349**: Users with large inboxes take ~10s to process activities (vs 0.2s for small inboxes)
2. **Issue #403**: Outbox calls take very long
3. **Issue #347**: mastodon.social sends excessive Delete activities, overwhelming pods
4. **Issue #383**: Need federation settings and blocking capabilities

### Root Causes
1. **No shared inbox**: Each user receives activities individually, causing N requests for N followers
2. **Synchronous processing**: Activities processed in request path, blocking responses
3. **Large inbox queries**: SPARQL queries slow with large datasets
4. **No federation throttling**: No per-domain rate limiting for outbound delivery
5. **Missing signature verification optimization**: Each request verified individually

### Current Federation Flow
```
Outbound: App → PodOutbox → signature.proxy.query → Remote Inbox
Inbound: Remote → Pod Inbox → pod-activities-watcher → App handlers
```

The pod-activities-watcher uses:
- Solid Notifications for real-time updates
- BullMQ for job queuing with exponential backoff
- Pattern matching for activity routing
