/**
 * relay-loadtest.js
 *
 * k6 load test focused on the relay-specific performance paths.
 *
 * Scenarios
 * ─────────
 *   relay_subscribe  POST /webhook/outbox with Follow-to-relay payloads.
 *                    Measures how fast the sidecar accepts outbound relay
 *                    subscription work and enqueues it to Redis.
 *                    Run with ENABLE_OUTBOUND_WORKER=false so the worker
 *                    does not actually try to deliver to the synthetic relay
 *                    domain and saturate DNS/TCP during the bench.
 *
 *   signing_api      POST ActivityPods /api/internal/signatures/batch
 *                    directly.  Measures raw signing throughput — the
 *                    critical bottleneck for relay delivery at scale.
 *                    Requires ACTIVITYPODS_URL + ACTIVITYPODS_TOKEN.
 *
 *   relay_inbound    POST well-formed Announce{Note} activities to the
 *                    internal benchmark inbox path, which enqueues a trusted
 *                    envelope after token auth and preserves the downstream
 *                    /users/relay/inbox target path for ActivityPods.
 *                    This isolates inbound queue throughput from HTTP-signature
 *                    verification overhead without relying on stale behavior in
 *                    the public actor-specific inbox route.
 *
 *   relay_mixed      Concurrent 1:2 mix of relay_subscribe + relay_inbound.
 *                    Represents a steady-state deployment: some users
 *                    triggering relay follows while the relay concurrently
 *                    feeds Announce activities back.
 *
 * Required env vars
 * ─────────────────
 *   TARGET_BASE_URL           Sidecar base URL (default: http://localhost:8080)
 *   SIDECAR_TOKEN             Bearer token for /webhook/outbox
 *                             and /internal/bench/users/:username/inbox
 *   SCENARIO                  relay_subscribe | signing_api | relay_inbound | relay_mixed
 *
 * Optional env vars
 * ─────────────────
 *   ACTIVITYPODS_URL          ActivityPods base URL     (required for signing_api)
 *   ACTIVITYPODS_TOKEN        ActivityPods service token (required for signing_api)
 *   RELAY_ACTOR_URL           Synthetic relay actor URL
 *                             (default: https://relay.example.com/actor)
 *   LOCAL_RELAY_ACTOR_URI     Local relay sender actor URI
 *                             (default: http://localhost:3000/relaybot)
 *   RELAY_INBOX_RECIPIENT     Username path segment used to derive the target
 *                             ActivityPods inbox path (default: relaybot)
 *   DURATION                  Sustained test duration   (default: 4m)
 *   RAMP_UP_DURATION          Ramp-up time              (default: 20s)
 *   RAMP_DOWN_DURATION        Ramp-down time            (default: 20s)
 *   VUS                       Starting VU count         (default: 20)
 *   RAMP_TARGET               Peak VU count             (default: VUS × 2)
 *
 * Security notes
 * ──────────────
 *   - Tokens are read from env vars and passed as Authorization headers;
 *     they are never logged or written to any output file.
 *   - The signing_api scenario sends to the ActivityPods INTERNAL endpoint.
 *     Ensure the test target is never internet-exposed and that the bearer
 *     token only grants signing permissions to the relay actor.
 *   - All synthetic actor / relay URIs use fictional domains (*.example.com)
 *     so no real external systems are contacted during the bench.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Configuration — read from environment; no secrets hard-coded
// ---------------------------------------------------------------------------

const baseUrl = __ENV.TARGET_BASE_URL || 'http://localhost:8080';
const sidecarToken = __ENV.SIDECAR_TOKEN || '';
const activityPodsUrl = __ENV.ACTIVITYPODS_URL || 'http://localhost:3000';
const activityPodsToken = __ENV.ACTIVITYPODS_TOKEN || '';
const scenario = (__ENV.SCENARIO || 'relay_subscribe').toLowerCase();

// Relay coordinates — both default to non-routable example.com values so
// no real relay is contacted by the synthetic load traffic.
const relayActorUrl = __ENV.RELAY_ACTOR_URL || 'https://relay.example.com/actor';
const localRelayActorUri = __ENV.LOCAL_RELAY_ACTOR_URI || __ENV.AP_RELAY_LOCAL_ACTOR_URI || 'http://localhost:3000/relay';

// Username segment used for the actor-specific inbox path in relay_inbound.
// /users/<segment>/inbox bypasses Fedify HTTP-signature verification.
const relayInboxRecipient = __ENV.RELAY_INBOX_RECIPIENT || 'relaybot';

const duration = __ENV.DURATION || '4m';
const rampUpDuration = __ENV.RAMP_UP_DURATION || '20s';
const rampDownDuration = __ENV.RAMP_DOWN_DURATION || '20s';
const vus = parseInt(__ENV.VUS || '20', 10);
const rampTarget = parseInt(__ENV.RAMP_TARGET || String(vus * 2), 10);

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const acceptedCounter = new Counter('relay_loadtest_accepted_total');
const expectedStatusRate = new Rate('relay_loadtest_expected_status_rate');
const appLatency = new Trend('relay_loadtest_app_latency_ms', true);

// ---------------------------------------------------------------------------
// Cached relay domain — derived once from RELAY_ACTOR_URL.
// We cannot use new URL() at module-init in all k6 versions, so we derive
// the hostname with a simple regex that handles https://host/path form.
// ---------------------------------------------------------------------------

function relayHostname() {
  const m = relayActorUrl.match(/^https?:\/\/([^/?#]+)/);
  return m ? m[1] : 'relay.example.com';
}

const RELAY_DOMAIN = relayHostname();
const RELAY_INBOX_URL = `https://${RELAY_DOMAIN}/inbox`;

// ---------------------------------------------------------------------------
// Payload factories
// Each factory produces a fully spec-compliant AP JSON-LD document.
// VU+iteration pairs in IDs prevent idempotency deduplication across runs.
// ---------------------------------------------------------------------------

/**
 * Follow{relay} payload for POST /webhook/outbox.
 *
 * The /webhook/outbox endpoint expects:
 *   { actorUri, activity, remoteTargets[] }
 *
 * The sidecar validates auth, enqueues to Redis, and returns 202.
 * Actual delivery is done by the OutboundWorker asynchronously (disable it
 * during load tests to avoid DNS-lookup storms on the synthetic domain).
 */
function relaySubscribePayload(idSuffix) {
  const suffix = idSuffix || `${__VU}-${__ITER}`;
  const activityId =
    `https://localhost/activities/follow-relay-${suffix}`;

  return JSON.stringify({
    actorUri: localRelayActorUri,
    activity: {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: activityId,
      type: 'Follow',
      actor: localRelayActorUri,
      object: relayActorUrl,
      to: [relayActorUrl],
    },
    remoteTargets: [
      {
        targetDomain: RELAY_DOMAIN,
        inboxUrl: RELAY_INBOX_URL,
      },
    ],
  });
}

/**
 * Announce{Note} payload for POST /users/<recipient>/inbox.
 *
 * Mirrors the shape of activities that an ActivityRelay server delivers back
 * to the sidecar after a Follow is accepted.  The load test posts to an
 * internal benchmark route that stamps a trusted verification record using the
 * activity actor URI, while preserving the downstream /users/:username/inbox
 * path used when forwarding to ActivityPods.
 *
 * Well-formed JSON-LD: context, full IDs, attributedTo, published timestamp,
 * to/cc addressing — all present and correct per AP spec section 5.
 */
function relayInboundPayload() {
  const objectActor = `https://social.example.com/users/user-${__VU}`;
  const objectNoteId =
    `https://social.example.com/users/user-${__VU}/statuses/${__ITER}`;
  const announceId =
    `https://${RELAY_DOMAIN}/activities/announce-${__VU}-${__ITER}`;
  const ts = new Date().toISOString();

  return JSON.stringify({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: announceId,
    type: 'Announce',
    actor: `https://${RELAY_DOMAIN}/actor`,
    published: ts,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`https://${RELAY_DOMAIN}/actor/followers`],
    object: {
      id: objectNoteId,
      type: 'Note',
      attributedTo: objectActor,
      content: `relay inbound loadtest note ${__ITER}`,
      published: ts,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${objectActor}/followers`],
    },
  });
}

/**
 * Batch signing request for POST /api/internal/signatures/batch.
 *
 * Tests signing throughput in isolation.  One Follow activity per request
 * matches the single-activity-per-relay-delivery production pattern.
 * The body bytes are pre-serialized so that ActivityPods computes the digest
 * (digest.mode = "server_compute"), which is the production code path.
 *
 * Security: activityPodsToken is supplied as a Bearer header and is never
 * written to k6 stdout or captured in the summary object.
 */
function signingApiPayload(idSuffix) {
  const suffix = idSuffix || `${__VU}-${__ITER}`;
  const followBody = JSON.stringify({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `https://localhost/activities/follow-signing-${suffix}`,
    type: 'Follow',
    actor: localRelayActorUri,
    object: relayActorUrl,
    to: [relayActorUrl],
  });

  return JSON.stringify({
    requests: [
      {
        requestId: `loadtest-${suffix}`,
        actorUri: localRelayActorUri,
        method: 'POST',
        profile: 'ap_post_v1',
        target: {
          host: RELAY_DOMAIN,
          path: '/inbox',
          query: '',
        },
        body: {
          bytes: followBody,
          encoding: 'utf8',
        },
        digest: {
          mode: 'server_compute',
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function relaySubscribeRequest() {
  const res = http.post(
    `${baseUrl}/webhook/outbox`,
    relaySubscribePayload(),
    {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sidecarToken}`,
      },
      tags: { endpoint: 'relay_subscribe' },
    },
  );

  appLatency.add(res.timings.duration, { endpoint: 'relay_subscribe' });
  const ok = check(res, {
    'relay_subscribe status is 202': (r) => r.status === 202,
  });
  expectedStatusRate.add(ok, { endpoint: 'relay_subscribe' });
  if (ok) acceptedCounter.add(1, { endpoint: 'relay_subscribe' });
  return res;
}

function relayInboundRequest() {
  const res = http.post(
    `${baseUrl}/internal/bench/${relayInboxRecipient}/inbox`,
    relayInboundPayload(),
    {
      headers: {
        'content-type': 'application/activity+json',
        authorization: `Bearer ${sidecarToken}`,
      },
      tags: { endpoint: 'relay_inbound' },
    },
  );

  appLatency.add(res.timings.duration, { endpoint: 'relay_inbound' });
  const ok = check(res, {
    'relay_inbound status is 202': (r) => r.status === 202,
  });
  expectedStatusRate.add(ok, { endpoint: 'relay_inbound' });
  if (ok) acceptedCounter.add(1, { endpoint: 'relay_inbound' });
  return res;
}

function signingApiRequest() {
  const res = http.post(
    `${activityPodsUrl}/api/internal/signatures/batch`,
    signingApiPayload(),
    {
      headers: {
        'content-type': 'application/json',
        // Token supplied via header; never written to metrics or summary.
        authorization: `Bearer ${activityPodsToken}`,
      },
      tags: { endpoint: 'signing_api' },
    },
  );

  appLatency.add(res.timings.duration, { endpoint: 'signing_api' });
  // 200 = signed headers returned; 4xx signals auth / config error, not perf.
  const ok = check(res, {
    'signing_api status is 200': (r) => r.status === 200,
  });
  expectedStatusRate.add(ok, { endpoint: 'signing_api' });
  if (ok) acceptedCounter.add(1, { endpoint: 'signing_api' });
  return res;
}

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

const scenarios = {
  relay_subscribe: {
    executor: 'ramping-vus',
    stages: [
      { duration: rampUpDuration, target: vus },
      { duration,               target: rampTarget },
      { duration: rampDownDuration, target: 0 },
    ],
    exec: 'runRelaySubscribe',
  },

  signing_api: {
    executor: 'ramping-vus',
    stages: [
      { duration: rampUpDuration, target: vus },
      { duration,               target: rampTarget },
      { duration: rampDownDuration, target: 0 },
    ],
    exec: 'runSigningApi',
  },

  relay_inbound: {
    executor: 'ramping-vus',
    stages: [
      { duration: rampUpDuration, target: vus },
      { duration,               target: rampTarget },
      { duration: rampDownDuration, target: 0 },
    ],
    exec: 'runRelayInbound',
  },

  relay_mixed: {
    executor: 'ramping-vus',
    stages: [
      { duration: rampUpDuration, target: vus },
      { duration,               target: rampTarget },
      { duration: rampDownDuration, target: 0 },
    ],
    exec: 'runRelayMixed',
  },
};

// Thresholds are intentionally slightly looser for relay paths than for the
// raw inbound benchmark because relay paths perform Redis enqueue (subscribe)
// or signing (signing_api) in addition to basic HTTP dispatch.
const thresholdsByScenario = {
  relay_subscribe: {
    http_req_failed:                  ['rate<0.01'],
    relay_loadtest_expected_status_rate: ['rate>0.99'],
    http_req_duration:                ['p(95)<350', 'p(99)<700'],
    relay_loadtest_app_latency_ms:    ['p(95)<350', 'p(99)<700'],
  },
  signing_api: {
    // Signing involves asymmetric crypto; allow up to 500 ms p95 / 1 s p99.
    http_req_failed:                  ['rate<0.01'],
    relay_loadtest_expected_status_rate: ['rate>0.99'],
    http_req_duration:                ['p(95)<500', 'p(99)<1000'],
    relay_loadtest_app_latency_ms:    ['p(95)<500', 'p(99)<1000'],
  },
  relay_inbound: {
    http_req_failed:                  ['rate<0.01'],
    relay_loadtest_expected_status_rate: ['rate>0.99'],
    http_req_duration:                ['p(95)<300', 'p(99)<600'],
    relay_loadtest_app_latency_ms:    ['p(95)<300', 'p(99)<600'],
  },
  relay_mixed: {
    http_req_failed:                  ['rate<0.02'],
    relay_loadtest_expected_status_rate: ['rate>0.98'],
    http_req_duration:                ['p(95)<500', 'p(99)<1000'],
    relay_loadtest_app_latency_ms:    ['p(95)<500', 'p(99)<1000'],
  },
};

const activeScenario = Object.prototype.hasOwnProperty.call(scenarios, scenario)
  ? scenario
  : 'relay_subscribe';

export const options = {
  scenarios: {
    [activeScenario]: scenarios[activeScenario],
  },
  thresholds: thresholdsByScenario[activeScenario],
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function setup() {
  // Sidecar health gate — fail fast if the target is not up.
  const health = http.get(`${baseUrl}/health`, { tags: { endpoint: 'health' } });
  check(health, {
    'sidecar health endpoint reachable': (r) => r.status === 200,
  });

  // Guard: signing_api needs explicit ActivityPods config.
  if (activeScenario === 'signing_api') {
    if (!activityPodsToken) {
      throw new Error(
        'ACTIVITYPODS_TOKEN is required for the signing_api scenario. ' +
        'Set it to the ActivityPods internal service token.',
      );
    }
    // Smoke-test the signing endpoint before ramping up.
    const probe = http.post(
      `${activityPodsUrl}/api/internal/signatures/batch`,
      signingApiPayload('setup-probe'),
      {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${activityPodsToken}`,
        },
        tags: { endpoint: 'signing_api_probe' },
      },
    );
    check(probe, {
      'signing_api probe status is 200': (r) => r.status === 200,
    });
  }

  // Guard: relay paths need SIDECAR_TOKEN.
  if (
    (
      activeScenario === 'relay_subscribe'
      || activeScenario === 'relay_inbound'
      || activeScenario === 'relay_mixed'
    ) &&
    !sidecarToken
  ) {
    throw new Error(
      'SIDECAR_TOKEN is required for relay_subscribe, relay_inbound, and relay_mixed scenarios.',
    );
  }

  // Fail fast on webhook contract mismatches so benchmark results are valid.
  // Common causes: outbox-intent worker disabled, auth mismatch, or queue backpressure.
  if (activeScenario === 'relay_subscribe' || activeScenario === 'relay_mixed') {
    const probe = http.post(
      `${baseUrl}/webhook/outbox`,
      relaySubscribePayload('setup-probe'),
      {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sidecarToken}`,
        },
        tags: { endpoint: 'relay_subscribe_probe' },
      },
    );

    if (probe.status !== 202) {
      const bodySnippet = typeof probe.body === 'string'
        ? probe.body.slice(0, 200)
        : '';
      throw new Error(
        `relay_subscribe probe failed with status ${probe.status}. ` +
        `Expected 202 from /webhook/outbox. Body: ${bodySnippet}`,
      );
    }
  }

  return { startedAt: Date.now(), scenario: activeScenario };
}

// ---------------------------------------------------------------------------
// Exported VU functions
// ---------------------------------------------------------------------------

export function runRelaySubscribe() {
  relaySubscribeRequest();
  sleep(0.05);
}

export function runSigningApi() {
  signingApiRequest();
  // Signing is CPU-bound on the ActivityPods side; give it a short breath.
  sleep(0.05);
}

export function runRelayInbound() {
  relayInboundRequest();
  sleep(0.05);
}

/**
 * Mixed scenario: 1 subscribe for every 2 inbound deliveries.
 * Mirrors a steady-state relay deployment: most traffic is inbound Announce
 * fan-out, with periodic re-subscription pulses.
 */
export function runRelayMixed() {
  if (__ITER % 3 === 0) {
    relaySubscribeRequest();
    sleep(0.08);
  } else {
    relayInboundRequest();
    sleep(0.05);
  }
}

export function teardown() {
  // Capture a final metrics snapshot for offline analysis.
  http.get(`${baseUrl}/metrics`, { tags: { endpoint: 'metrics' } });
}

// ---------------------------------------------------------------------------
// Summary — token values are intentionally excluded from the output.
// ---------------------------------------------------------------------------

export function handleSummary(data) {
  // Build a metrics snapshot that is safe to write to disk / CI artefacts.
  // Bearer tokens are in request headers and are NOT present in k6 data.
  const summary = {
    scenario: activeScenario,
    checks: data.root_group.checks,
    metrics: {
      http_req_failed:
        data.metrics.http_req_failed,
      http_req_duration:
        data.metrics.http_req_duration,
      relay_loadtest_expected_status_rate:
        data.metrics.relay_loadtest_expected_status_rate,
      relay_loadtest_app_latency_ms:
        data.metrics.relay_loadtest_app_latency_ms,
      relay_loadtest_accepted_total:
        data.metrics.relay_loadtest_accepted_total,
    },
  };

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}
