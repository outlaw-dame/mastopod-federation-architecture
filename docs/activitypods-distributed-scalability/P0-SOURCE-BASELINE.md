# ADSP-P0 source baseline

Date: 2026-08-17

This document freezes source-level Phase 0 facts before any distributed-topology implementation or transporter comparison. It is evidence, not a runtime benchmark. Runtime behavior, resource variance, failure fixtures and promotion thresholds remain separate Phase 0 gates.

## Frozen repository heads

- ActivityPods: `3fad15838ec098d8d32c0f36cd8c75cbb66a46a8`
- federation architecture: `e20c32fc5d4c9b9157de3063345e050ea3ec5007`

These are the program setup/reference heads. Any runtime evidence must record the exact commit actually executed.

## ActivityPods broker and process topology

### Moleculer broker

Source: `pod-provider/backend/moleculer.config.js`

Verified at the frozen ActivityPods head:

- `nodeID` is the literal `pod-provider`;
- there is no explicit Moleculer `namespace` in the broker options;
- the distributed transporter is selected from `CONFIG.REDIS_TRANSPORTER_URL || undefined`;
- the custom RDF serializer is selected with `CONFIG.REDIS_TRANSPORTER_URL ? new RdfJSONSerializer() : undefined`;
- therefore serializer selection is coupled to the Redis-specific transporter setting rather than to a transport-independent serialization requirement;
- Redis action caching is a separate optional concern selected from `CONFIG.REDIS_CACHE_URL`.

Consequences for ADSP:

1. two simultaneously distributed backends cannot be assumed safe until unique node identity is implemented and tested;
2. cross-environment discovery isolation cannot be assumed until an explicit namespace contract exists;
3. Redis-vs-NATS comparison would be invalid if changing the transporter also changes serialization behavior;
4. cacher, transporter and queue Redis roles must remain separately measured/configured.

### Default service loading

Source: `pod-provider/backend/package.json`

The normal backend scripts load the broad service tree into one Moleculer runner:

- development: `moleculer-runner --repl --hot services/*.js services/**/*.js`
- production start: `moleculer-runner services/*.js services/**/*.js`

The baseline is therefore a colocated ActivityPods/SemApps service cell. ADSP must not model the current system as one process per service or mechanically split high-frequency Tier-1 chains across the network.

### ActivityPods Redis responsibilities

Source: `pod-provider/backend/config/config.js` and broker configuration.

The configuration exposes distinct Redis-backed responsibilities:

- `SEMAPPS_REDIS_CACHE_URL` -> Moleculer/action cache;
- `SEMAPPS_REDIS_TRANSPORTER_URL` -> optional Moleculer transporter;
- `SEMAPPS_QUEUE_SERVICE_URL` -> existing queue/durable-job infrastructure;
- `SEMAPPS_REDIS_OIDC_PROVIDER_URL` -> OIDC provider state.

These are not one interchangeable dependency. ADSP measurements must account for each role separately and must not remove existing queue/state durability merely to compare Moleculer transporters.

## Federation sidecar Redis baseline

### Redis Streams are incumbent production architecture

Source: `fedify-sidecar/src/queue/sidecar-redis-queue-core.ts`.

The sidecar already implements Redis Streams work queues. Phase 0 verified separate streams for:

- inbound ActivityPub envelopes;
- outbound ActivityPub delivery jobs;
- durable outbox intents;
- origin reconciliation jobs;
- corresponding bounded DLQ streams.

The queue also uses ordinary Redis keys/data structures for control/state concerns such as idempotency, delivery claims/state, caches, rate limiting, domain concurrency and block state.

This corrects the initial ADSP setup assumption that Redis Streams were merely a future first candidate. They are already part of the frozen federation runtime.

### Consumer-group and crash-recovery semantics

Source: `fedify-sidecar/src/queue/sidecar-redis-queue-core.ts`.

Verified behavior:

- work queues use Redis consumer groups;
- consumers inspect pending messages with `XAUTOCLAIM` before reading new messages with `XREADGROUP`;
- default claim-idle time is 60 seconds;
- consumer groups are created with `MKSTREAM` and recreated when `NOGROUP` is observed;
- consumption errors are logged and retried after a bounded one-second delay;
- queue read/claim batch counts are bounded/configurable;
- stream length is bounded with approximate `MAXLEN ~` trimming;
- DLQ length is separately bounded;
- queue telemetry exposes stream length and pending counts.

### ACK, retry and DLQ ordering

Sources:

- `fedify-sidecar/src/delivery/outbound-worker.ts`
- `fedify-sidecar/src/queue/sidecar-redis-queue-core.ts`

The outbound worker explicitly keeps stream acknowledgement last in replacement-work transitions. Verified examples include:

- transient delivery failure: enqueue retry first, then ACK the original message;
- permanent failure or exhausted attempts: add the DLQ entry first, then ACK the original message;
- deferred/rate-limited/concurrency work: durable replacement/parking action occurs before ACK;
- successful delivery: persist the completed-delivery marker before ACK;
- if completed-marker persistence fails after successful remote delivery, the original Stream entry is deliberately left unacknowledged so recovery can re-enter idempotency/claim handling rather than silently losing durable completion state.

This ordering prevents a normal ACK-before-requeue loss gap. It does not convert Redis asynchronous replication into a stronger durability model; Redis failover/data-loss behavior remains an explicit benchmark/fault-test concern.

### Idempotency and concurrency controls

Verified source behavior includes:

- outbound completed/in-flight claims are separate from Stream pending-entry ownership;
- an existing Redis idempotency key path uses `SET ... NX` with TTL for legacy/test compatibility;
- production outbound delivery uses a dedicated delivery-claim store with claim/completed state;
- outbox-intent fanout has an atomic Redis Lua path that checks state, enqueues outbound jobs and records the enqueue marker together;
- per-domain rate limiting uses atomic Lua `INCR`/`EXPIRE` logic;
- per-domain concurrency acquisition uses atomic Lua accounting;
- outbound work has bounded global and per-domain concurrency;
- retries use exponential backoff and honor `Retry-After` without allowing it to shorten the normal backoff;
- repeated deferrals are bounded and eventually park in the DLQ.

## Federation signing caller contract

Sources:

- `fedify-sidecar/src/signing/signing-client.ts`
- `fedify-sidecar/src/core-domain/contracts/SigningContracts.ts`

For ActivityPub HTTP signing, the sidecar:

- parses `targetUrl` as an HTTP(S) `URL` before constructing the signing request;
- sends canonical URL-derived host/path/query fields;
- declares request bodies as UTF-8 and asks ActivityPods to compute the digest over the transmitted body;
- does not supply the HTTP `Date` in the normal outbound path, so ActivityPods generates it;
- uses exponential retry backoff with jitter for transient signing-service failures.

ATProto signing contracts carry internally serialized commit/PLC bytes as base64. Strict base64/canonical protocol validation can be evaluated as a separate signing-protocol hardening slice; it is not required to alter the ADSP transporter baseline.

## P0 conclusions now frozen from source

The earlier broker observations are no longer hypotheses:

- static node ID: **confirmed**;
- no explicit namespace: **confirmed**;
- Redis-selected Moleculer transporter: **confirmed**;
- RDF serializer coupled to the Redis transporter setting: **confirmed**;
- broad single-runner service loading: **confirmed**;
- Redis Streams already used for sidecar durable work queues: **confirmed**.

## Gates that remain open

Source verification does **not** close ADSP-P0. The following still require executable evidence or a frozen runnable fixture:

1. effective node/discovery behavior with multiple real backend instances;
2. RDF/JSON-LD semantic parity across a genuine remote Moleculer call;
3. local-versus-remote action telemetry suitable for topology experiments;
4. single-node whole-system CPU, memory, latency, throughput, Redis and Fuseki baseline;
5. repeated baseline samples sufficient to measure variance;
6. Phase 2/3 promotion thresholds locked before NATS comparison;
7. node disappearance/rejoin and stale-registry fault fixtures;
8. Redis failover/durability tests appropriate to the existing Streams and queue responsibilities.

Until those gates close, ADSP-P1 remains blocked and no NATS/JetStream implementation is authorized by this program.
