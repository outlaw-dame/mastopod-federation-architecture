# FEP-3ab2 ActivityPub Event Streaming Integration Design

## Status

Recommended for adoption as the public realtime control plane for both raw stream subscriptions and app-level derived topics.

This document describes how to add FEP-3ab2-compatible SSE streaming to the current Mastopod + ActivityPods + Fedify sidecar architecture without replacing the existing internal feed and ATProto WebSocket paths.

## Decision

Adopt FEP-3ab2 as a public, authenticated SSE facade with this ownership split:

- Fedify sidecar owns:
  - `POST/DELETE /streaming/control`
  - `GET/POST/DELETE /streaming/control/subscriptions`
  - `GET /streaming/stream`
  - ticket issuance and revocation
  - subscription CRUD
  - SSE fan-out
  - public stream ingestion from RedPanda
  - private event merge from Redis pub/sub
  - heartbeat and connection lifecycle
- ActivityPods owns:
  - user authentication
  - principal resolution for public FEP requests
  - topic authorization
- private notification and personal-feed invalidation emission
- Redis owns:
  - FEP session ticket state
  - session subscriptions
  - connection bookkeeping
  - private realtime fan-out channel
- Traefik owns:
  - routing `/streaming/*` to the sidecar

This keeps the current internal bearer-token feed gateway intact:

- `GET /internal/feed/stream`
- `GET /internal/feed/stream/ws`

Those remain service-to-service and app-internal surfaces, not the public FEP surface.

## Why This Split Fits The Repo

The repo already has an internal durable stream gateway that multiplexes SSE and WebSocket transports and fans out envelopes from RedPanda-backed sources plus an in-process unified stream:

- [DurableStreamSubscriptionService.ts](../src/feed/DurableStreamSubscriptionService.ts)
- [FeedStreamKafkaConsumer.ts](../src/feed/FeedStreamKafkaConsumer.ts)
- [UnifiedFeedBridge.ts](../src/feed/UnifiedFeedBridge.ts)
- [fastify-routes.ts](../src/feed/fastify-routes.ts)

But the current implementation is not FEP-3ab2-compatible because it:

- uses bearer headers rather than existing user auth plus a ticket cookie
- binds subscriptions at connect time via query params instead of a session-control API
- multiplexes coarse internal stream names (`stream1`, `stream2`, `canonical`, `unified`) rather than client topics
- does not persist sessions or subscriptions outside process memory
- does not currently enforce principal-scoped topic delivery

At the same time, the sensible way to address the auth and subscription mismatch is not to mutate those internal routes into a browser API. Instead:

- keep the current bearer-token routes as the internal service surface
- add a new public FEP control plane in the sidecar
- have the sidecar call ActivityPods for principal resolution and topic authorization

That gives us a clean separation between:

- internal service subscriptions
- public client/server subscriptions using the FEP contract

while reusing the same underlying public stream infrastructure.

## Consumption Modes

The architecture should explicitly support both of these models:

### 1. Read-Time Feed Computation

Use when clients want ranked or policy-shaped feeds:

- query skeletons
- hydrate on read
- optionally receive realtime refresh hints

This is still the right model for:

- `feeds/personal`
- app-optimized discovery feeds
- WAC-sensitive object shaping

### 2. Direct Stream Subscription

Use when apps or servers want raw or near-raw event flow delivered directly:

- subscribe to durable public stream topics
- receive raw ActivityPub or canonical events directly over SSE
- perform their own indexing, shaping, ranking, or server-side fan-out

This is also a first-class architectural goal and should be exposed through the FEP topic model rather than hidden behind internal `stream1` and `canonical` names.

## Non-Goals

- Do not replace ATProto `subscribeRepos` WebSocket support.
- Do not expose `/internal/feed/stream` publicly.
- Do not make RedPanda the source of truth for private per-user notifications.
- Do not introduce per-user precomputed personalized feeds.
- Do not let this FEP change or constrain ATProto transport choices.

## Public API Shape

### Discovery

Expose the FEP control endpoint from ActivityPub actor documents:

```json
{
  "@context": [
    "https://w3id.org/fep/3ab2",
    "https://www.w3.org/ns/activitystreams"
  ],
  "type": "Person",
  "id": "https://example.com/users/alice",
  "endpoints": {
    "streamingControl": "https://example.com/streaming/control"
  }
}
```

Implementation note:

- Actor documents currently route through the sidecar for ActivityPub `Accept` headers via [dynamic-config.yml](../traefik/dynamic-config.yml), so the actor serializer on the sidecar path should add `endpoints.streamingControl`.
- Because the sidecar owns the FEP surface, `streamingControl` should resolve to a sidecar URL.

### Public Routes

- `POST /streaming/control`
  - Fedify sidecar
  - authenticated with the existing app session or equivalent existing auth
  - creates a short-lived single-use ticket
  - sets the ticket cookie
- `DELETE /streaming/control`
  - Fedify sidecar
  - authenticated with the existing app session or equivalent existing auth
  - revokes the current ticket
- `GET /streaming/control/subscriptions`
  - Fedify sidecar
  - authenticated with the existing app session plus valid ticket cookie
- `POST /streaming/control/subscriptions`
  - Fedify sidecar
  - authenticated with the existing app session plus valid ticket cookie
- `DELETE /streaming/control/subscriptions?topic=...`
  - Fedify sidecar
  - authenticated with the existing app session plus valid ticket cookie
- `GET /streaming/stream`
  - Fedify sidecar
  - authenticated by:
    - existing app auth cookie forwarded to ActivityPods introspection
    - valid ticket cookie looked up in Redis

### Internal Routes

Add two new internal ActivityPods endpoints for the sidecar:

- `POST /api/internal/streaming/resolve-principal`
  - authenticated with `ACTIVITYPODS_TOKEN`
  - accepts forwarded auth context from the sidecar
  - resolves the authenticated principal from request cookies or other existing app auth material
  - returns `401` if the user session is not valid
- `POST /api/internal/streaming/authorize-topics`
  - authenticated with `ACTIVITYPODS_TOKEN`
  - accepts:
    - resolved principal
    - requested topics
    - optional request metadata
  - returns:
    - allowed topics
    - denied topics with stable reason codes

These endpoints let the sidecar satisfy the FEP requirement that the stream is opened with both an authenticated principal and a valid ticket, without teaching the sidecar to parse Solid-OIDC session cookies itself and without duplicating topic authorization logic.

## Proposed Topic Model

Phase 1 topics should cover both raw stream subscriptions and logical app topics.

Supported topics in phase 1:

- `feeds/public/local`
- `feeds/public/remote`
- `feeds/public/unified`
- `feeds/public/canonical`
- `notifications`
- `feeds/personal`
- `feeds/local`
- `feeds/global`

Supported topics in phase 2:

- ActivityPub URI-derived topics using the FEP topic algorithm
- object-scoped subscriptions for threads, posts, and actors

Wildcard support:

- phase 1: `wildcard_support = false`
- phase 2: enable only after topic authorization and topic-to-source mapping are hardened

### Topic-to-Source Mapping

| Topic | Backing source | Notes |
|---|---|---|
| `feeds/public/local` | sidecar public stream router | raw local public ActivityPub flow; stable public alias for internal local stream |
| `feeds/public/remote` | sidecar public stream router | raw remote public ActivityPub flow |
| `feeds/public/unified` | sidecar public stream router | raw normalized public stream across sources |
| `feeds/public/canonical` | sidecar public stream router | raw canonical intent log for subscribers that want normalized intent payloads |
| `notifications` | ActivityPods private event emitter via Redis pub/sub | principal-scoped; not a RedPanda public log |
| `feeds/personal` | ActivityPods private invalidation emitter via Redis pub/sub | query/hydrate remains source of truth |
| `feeds/local` | sidecar public stream router | app-level local feed topic; may be raw append or refresh hint depending policy |
| `feeds/global` | sidecar public stream router | app-level global feed topic; may be raw append or refresh hint depending policy |

Important:

- `feeds/personal` and `notifications` are private and principal-scoped.
- `feeds/public/*` topics are direct stream-subscription topics for clients or servers that want raw feeds.
- `feeds/local` and `feeds/global` are convenience topics over public flow.
- The FEP topic namespace is public API. It should expose stable public aliases, not raw implementation names like `stream1`.

## Event Model

The public SSE stream should multiplex all subscribed topics onto one connection.

### Event Types

Use:

- `event: activitypub`
  - when the payload is a concrete ActivityPub activity or object
- `event: canonical`
  - when the payload is a canonical intent or normalized cross-protocol event
- `event: notification`
  - when the payload is a principal-scoped notification hint
- `event: feed`
  - when the payload is a feed invalidation or append hint
- `event: heartbeat`
  - every 20 seconds

This stays compatible with FEP-3ab2 because the FEP explicitly allows additional named event types.

### Payload Guidance

For derived topics like `notifications` and `feeds/personal`, phase 1 should send refresh hints, not fully hydrated feed cards:

```json
{
  "topic": "notifications",
  "principal": "https://example.com/users/alice",
  "notificationId": "urn:activitypods:notif:123",
  "reason": "created",
  "occurredAt": "2026-04-19T15:00:00Z"
}
```

```json
{
  "topic": "feeds/personal",
  "principal": "https://example.com/users/alice",
  "reason": "refresh_required",
  "occurredAt": "2026-04-19T15:00:00Z"
}
```

Reason:

- the architecture is read-time feed computation, not push-delivered fully materialized views
- query + hydrate remains authoritative
- reconnect handling is simpler because clients can always requery

For direct raw topics like `feeds/public/local`, `feeds/public/remote`, `feeds/public/unified`, and `feeds/public/canonical`, phase 1 should deliver actual raw payloads:

- `event: activitypub` for ActivityPub-derived raw events
- `event: canonical` for canonical intent payloads

For convenience topics like `feeds/local` and `feeds/global`, phase 1 may emit either:

- an ActivityPub activity via `event: activitypub`, or
- a refresh hint via `event: feed`

The safer starting point is:

- raw payloads for `feeds/public/*`
- refresh hints for `feeds/local`, `feeds/global`, and `feeds/personal`

## Redis Data Model

Store only a hash of the ticket, never the raw ticket value.

Recommended ticket format:

- raw cookie value: 256-bit random opaque token
- persisted identifier: `HMAC-SHA256(server_secret, raw_ticket)`

### Keys

- `fep3ab2:session:{ticket_hash}`
  - Redis hash or JSON document
  - fields:
    - `principal`
    - `issued_at`
    - `expires_at`
    - `status` = `issued|active|revoked|expired`
    - `origin`
    - `user_agent_hash`
    - `stream_connection_id`
    - `opened_at`
- `fep3ab2:session:{ticket_hash}:topics`
  - Redis set of subscribed topics
- `fep3ab2:connection:{connection_id}`
  - maps an active sidecar connection to a ticket hash
- `fep3ab2:principal:{principal_hash}:sessions`
  - optional set of active sessions for operational cleanup

### TTL

- ticket/session TTL: 5 minutes to 15 minutes
- topic set TTL: same as the session TTL
- connection key TTL: same as active stream lifetime, refreshed by heartbeat

## Cookie Model

Recommended cookie:

- name: `ap_stream_ticket`
- `Path=/streaming`
- `HttpOnly`
- `Secure`
- `SameSite=Lax`
- `Max-Age=<ticket_ttl_seconds>`

If the UI and API are on sibling first-party subdomains, set `Domain=.example.com`.

The raw ticket must never appear in logs or metrics.

## Auth And Stream Open Flow

### 1. Create Session

1. Browser or server client calls `POST /streaming/control` on the sidecar.
2. Sidecar forwards auth context to `POST /api/internal/streaming/resolve-principal`.
3. ActivityPods authenticates the existing session and returns the resolved principal.
4. Sidecar generates a ticket and stores `fep3ab2:session:{ticket_hash}` in Redis.
5. Sidecar sets the `ap_stream_ticket` cookie.
6. Sidecar returns:
   - `subscriptions_url`
   - `stream_url`
   - `expires_at`
   - `wildcard_support: false`

### 2. Manage Subscriptions

1. Client calls `POST /streaming/control/subscriptions` on the sidecar.
2. Sidecar resolves the current principal via `resolve-principal`.
3. Sidecar validates the ticket cookie and session ownership.
4. Sidecar calls `POST /api/internal/streaming/authorize-topics`.
5. ActivityPods returns allowed and denied topics.
6. Sidecar stores the allowed topic set in Redis.
7. Sidecar returns the full effective subscription set.

### 3. Open Stream

1. Browser opens `GET /streaming/stream` with `Accept: text/event-stream`.
2. Sidecar reads:
   - the ticket cookie
   - the existing app cookies
3. Sidecar hashes the ticket and looks up the Redis session.
4. Sidecar calls `POST /api/internal/streaming/resolve-principal` on ActivityPods, forwarding:
   - the browser `Cookie` header
   - optional `Origin`
   - optional request metadata
5. ActivityPods resolves the current principal or returns `401`.
6. Sidecar compares:
   - principal from ActivityPods
   - principal bound to the ticket session
7. If they match and the ticket is unused and unexpired:
   - mark ticket `active`
   - bind `stream_connection_id`
   - begin SSE
8. If they do not match:
   - return `401`

### 4. Revoke Session

1. Client calls `DELETE /streaming/control` on the sidecar.
2. Sidecar resolves the current principal via `resolve-principal`.
3. Sidecar revokes the Redis session and clears the cookie.
4. Any active stream on the sidecar closes on next heartbeat or immediate revocation check.

## Sensible Migration From The Current Auth Model

Current state:

- internal realtime routes are bearer-token APIs
- subscriptions are declared at connect time
- there is no public session-control API

Target state:

- internal realtime routes remain bearer-token APIs
- public FEP routes are cookie-auth plus ticket-cookie APIs
- both route families share the same underlying event sources

This is the sensible bridge:

1. Do not break or repurpose `/internal/feed/stream` or `/internal/feed/stream/ws`.
2. Add a parallel public FEP route family on the sidecar.
3. Add a Redis-backed session and subscription registry.
4. Add ActivityPods principal resolution and topic-authorization hooks.
5. Add a topic router that can serve both:
   - raw durable stream topics
   - app-level derived topics

That directly addresses the mismatch without conflating internal service auth with public client auth.

## Delivery Architecture

### Public Events

Use the existing sidecar public event path:

- [FeedStreamKafkaConsumer.ts](../src/feed/FeedStreamKafkaConsumer.ts)
- [UnifiedFeedBridge.ts](../src/feed/UnifiedFeedBridge.ts)

Add a new router that maps those internal envelopes to public FEP topics:

- `Fep3ab2PublicTopicRouter`

This router should sit above `DurableStreamSubscriptionService`, not inside it.

### Private Events

Do not push private notification or personal-feed events through the public RedPanda topics.

Instead:

1. ActivityPods emits principal-scoped private realtime hints to Redis pub/sub.
2. Every sidecar instance subscribes to that channel.
3. The sidecar delivers the hint only to matching principal/topic sessions.

Recommended channel:

- `realtime.private.v1`

Recommended payload shape:

```json
{
  "principal": "https://example.com/users/alice",
  "topic": "notifications",
  "eventType": "notification",
  "payload": {
    "notificationId": "urn:activitypods:notif:123",
    "reason": "created"
  },
  "occurredAt": "2026-04-19T15:00:00Z"
}
```

Reason to use Redis pub/sub here:

- events are transient delivery hints
- all sidecar instances must receive them
- these are not public durable logs

## Changes To Existing Sidecar Stream Service

Do not bolt the FEP session model directly onto the current `DurableStreamSubscriptionService`.

Instead, keep `DurableStreamSubscriptionService` as the low-level connection and envelope fan-out primitive for internal streams, and add a separate FEP layer:

- `Fep3ab2ControlRoutes`
- `Fep3ab2SessionStore`
- `ActivityPodsAuthIntrospectionClient`
- `ActivityPodsTopicAuthorizationClient`
- `Fep3ab2TopicRegistry`
- `Fep3ab2SseGateway`
- `Fep3ab2PublicTopicRouter`
- `PrivateRealtimeSubscriber`

Reason:

- the current service assumes subscriptions are fixed at connect time
- the FEP needs mutable subscriptions managed by separate control endpoints
- the current service is transport-oriented; the FEP introduces session semantics

## Traefik Changes

Add explicit routes:

- `PathPrefix(`/streaming`)` -> Fedify sidecar

Also add the streaming path to the sidecar service allowlist for:

- `Cache-Control: no-cache`
- `X-Accel-Buffering: no`
- strict CORS if SPA and API are on different first-party origins

## Capability And Discovery Changes

Keep `ap.feeds.realtime` as the capability gate for realtime transport.

Extend its effective limits to describe the FEP mode:

- `transports = "sse,websocket"`
- `streamingControlDiscovery = "actor.endpoints.streamingControl"`
- `browserAuthMode = "session+ticket-cookie"`

Also wire `ap.notifications.durable` into the rollout:

- if enabled:
  - `notifications` topic is durable enough for reconnect-safe refresh
- if disabled:
  - `notifications` topic becomes best-effort and clients must fall back to polling

## Replay Semantics

Phase 1:

- no durable per-session replay
- client reconnect behavior is:
  - reopen session
  - reconnect stream
  - immediately requery feeds and notifications

Phase 2:

- optionally honor `Last-Event-ID`
- use Redis or Kafka-backed cursor mapping for public topics only
- keep private personal-feed and notification replay as refresh hints, not full backlog replay

This aligns with the repo's current note that SSE/WS cursor state is still in-process only when Redis-backed replay is not present; see [startup-validator.ts](../src/capabilities/startup-validator.ts).

## Candidate File Layout

### New Sidecar Files

- `src/fep3ab2/Fep3ab2ControlRoutes.ts`
- `src/fep3ab2/Fep3ab2SessionStore.ts`
- `src/fep3ab2/ActivityPodsAuthIntrospectionClient.ts`
- `src/fep3ab2/ActivityPodsTopicAuthorizationClient.ts`
- `src/fep3ab2/Fep3ab2TopicRegistry.ts`
- `src/fep3ab2/Fep3ab2SseGateway.ts`
- `src/fep3ab2/Fep3ab2PublicTopicRouter.ts`
- `src/fep3ab2/PrivateRealtimeSubscriber.ts`

### Existing Sidecar Files To Touch

- `src/index.ts`
- `traefik/dynamic-config.yml`
- `src/capabilities/provider-capabilities.ts`
- actor serialization path that emits ActivityPub actor `endpoints`

### New ActivityPods Integration Files

- `activitypods-integration/streaming-topic-authorization.service.js`
- `activitypods-integration/realtime-private-emitter.service.js`
- `activitypods-integration/internal-streaming-principal.service.js`

## Rollout Plan

### Phase 1

- implement public control API in the sidecar
- implement Redis ticket store
- implement sidecar stream validation against ActivityPods principal introspection
- support topics:
  - `feeds/public/local`
  - `feeds/public/remote`
  - `feeds/public/unified`
  - `feeds/public/canonical`
  - `notifications`
  - `feeds/personal`
  - `feeds/local`
  - `feeds/global`
- send raw payloads for `feeds/public/*`
- send refresh hints for `notifications` and derived `feeds/*` topics
- keep `wildcard_support: false`

### Phase 2

- add URI-derived topic support
- optionally add `Last-Event-ID` replay for public topics
- add topic wildcards if authorization remains bounded

### Phase 3

- evaluate whether some browser consumers still need WebSocket
- if yes, expose a separate public WebSocket facade using the same control-plane session model
- if no, keep FEP-3ab2 as the standard browser realtime transport and reserve WebSocket for ATProto and internal uses

## Risks

- principal resolution on sidecar stream open must be cheap enough not to create reconnect storms
- cross-subdomain cookie scoping must be tested carefully
- private event emission must not leak principal data across sidecar instances
- actor document serialization must expose the streaming endpoint consistently across AP and app routes

## Recommendation Summary

The best fit is:

- sidecar as the public FEP control plane and SSE delivery gateway
- ActivityPods as authentication and topic-authorization authority
- Redis as shared ticket and private-fanout substrate
- RedPanda retained only for public durable streams

This delivers the FEP benefits without fighting the current architecture's separation of:

- app auth vs federation gateway
- public durable logs vs private transient delivery
- read-time feeds vs direct raw subscriptions
