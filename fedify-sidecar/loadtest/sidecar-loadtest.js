import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const baseUrl = __ENV.TARGET_BASE_URL || 'http://localhost:8080';
const scenario = (__ENV.SCENARIO || 'inbox').toLowerCase();
const sidecarToken = __ENV.SIDECAR_TOKEN || '';
const duration = __ENV.DURATION || '5m';
const rampUpDuration = __ENV.RAMP_UP_DURATION || '1m';
const rampDownDuration = __ENV.RAMP_DOWN_DURATION || '1m';
const vus = Number.parseInt(__ENV.VUS || '20', 10);
const rampTarget = Number.parseInt(__ENV.RAMP_TARGET || `${vus * 2}`, 10);

const acceptedCounter = new Counter('fedify_loadtest_accepted_total');
const expectedStatusRate = new Rate('fedify_loadtest_expected_status_rate');
const appLatency = new Trend('fedify_loadtest_app_latency_ms', true);

function inboxPayload() {
  // ActivityPub spec: the inbox accepts Activities, not bare Objects.
  // A Note is an Object; it must be wrapped in a Create activity so that
  // Fedify's inbox listener (.on(Activity, …)) accepts the request.
  const actorUri = `https://remote.example/users/loadtest-${__VU}`;
  const noteId = `https://remote.example/notes/${__VU}-${__ITER}`;
  const activityId = `https://remote.example/activities/create-${__VU}-${__ITER}`;
  const ts = new Date().toISOString();
  return JSON.stringify({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Create',
    actor: actorUri,
    published: ts,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${actorUri}/followers`],
    object: {
      id: noteId,
      type: 'Note',
      attributedTo: actorUri,
      content: `loadtest message ${__ITER}`,
      published: ts,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${actorUri}/followers`],
    },
  });
}

function webhookPayload() {
  return JSON.stringify({
    activityId: `urn:loadtest:${__VU}:${__ITER}`,
    actorUri: 'https://pods.example/users/loadtest-actor',
    activity: {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `urn:loadtest:activity:${__VU}:${__ITER}`,
      type: 'Create',
      actor: 'https://pods.example/users/loadtest-actor',
      object: {
        type: 'Note',
        content: `outbound loadtest ${__ITER}`,
      },
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
    remoteTargets: [
      {
        targetDomain: 'remote.example',
        inboxUrl: 'https://remote.example/inbox',
      },
    ],
  });
}

function inboxRequest() {
  const res = http.post(`${baseUrl}/inbox`, inboxPayload(), {
    headers: {
      'content-type': 'application/activity+json',
    },
    tags: { endpoint: 'inbox' },
  });

  appLatency.add(res.timings.duration, { endpoint: 'inbox' });
  const ok = check(res, {
    'inbox status is 202': (r) => r.status === 202,
  });

  expectedStatusRate.add(ok, { endpoint: 'inbox' });
  if (ok) acceptedCounter.add(1, { endpoint: 'inbox' });
  return res;
}

function webhookRequest() {
  const res = http.post(`${baseUrl}/webhook/outbox`, webhookPayload(), {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${sidecarToken}`,
    },
    tags: { endpoint: 'webhook_outbox' },
  });

  appLatency.add(res.timings.duration, { endpoint: 'webhook_outbox' });
  const ok = check(res, {
    'webhook status is 202': (r) => r.status === 202,
  });

  expectedStatusRate.add(ok, { endpoint: 'webhook_outbox' });
  if (ok) acceptedCounter.add(1, { endpoint: 'webhook_outbox' });
  return res;
}

const scenarios = {
  inbox: {
    executor: 'ramping-vus',
    stages: [
      { duration: rampUpDuration, target: vus },
      { duration, target: rampTarget },
      { duration: rampDownDuration, target: 0 },
    ],
    exec: 'runInbox',
  },
  webhook: {
    executor: 'ramping-vus',
    stages: [
      { duration: rampUpDuration, target: Math.max(1, Math.floor(vus / 2)) },
      { duration, target: vus },
      { duration: rampDownDuration, target: 0 },
    ],
    exec: 'runWebhook',
  },
  mixed: {
    executor: 'ramping-vus',
    stages: [
      { duration: rampUpDuration, target: vus },
      { duration, target: rampTarget },
      { duration: rampDownDuration, target: 0 },
    ],
    exec: 'runMixed',
  },
};

const thresholdsByScenario = {
  inbox: {
    http_req_failed: ['rate<0.01'],
    fedify_loadtest_expected_status_rate: ['rate>0.99'],
    http_req_duration: ['p(95)<250', 'p(99)<500'],
    fedify_loadtest_app_latency_ms: ['p(95)<250', 'p(99)<500'],
  },
  webhook: {
    http_req_failed: ['rate<0.02'],
    fedify_loadtest_expected_status_rate: ['rate>0.98'],
    http_req_duration: ['p(95)<350', 'p(99)<700'],
    fedify_loadtest_app_latency_ms: ['p(95)<350', 'p(99)<700'],
  },
  mixed: {
    http_req_failed: ['rate<0.02'],
    fedify_loadtest_expected_status_rate: ['rate>0.98'],
    http_req_duration: ['p(95)<300', 'p(99)<650'],
    fedify_loadtest_app_latency_ms: ['p(95)<300', 'p(99)<650'],
  },
};

const activeScenario = scenarios[scenario] ? scenario : 'inbox';

export const options = {
  scenarios: {
    [activeScenario]: scenarios[activeScenario],
  },
  thresholds: thresholdsByScenario[activeScenario],
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export function setup() {
  const health = http.get(`${baseUrl}/health`, { tags: { endpoint: 'health' } });
  check(health, {
    'health endpoint reachable': (r) => r.status === 200,
  });

  if ((activeScenario === 'webhook' || activeScenario === 'mixed') && !sidecarToken) {
    throw new Error('SIDECAR_TOKEN is required for webhook or mixed scenarios');
  }

  return { startedAt: Date.now() };
}

export function runInbox() {
  inboxRequest();
  sleep(0.05);
}

export function runWebhook() {
  webhookRequest();
  sleep(0.08);
}

export function runMixed() {
  if (__ITER % 3 === 0) {
    webhookRequest();
    sleep(0.08);
    return;
  }

  inboxRequest();
  sleep(0.05);
}

export function teardown() {
  http.get(`${baseUrl}/metrics`, { tags: { endpoint: 'metrics' } });
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify(
      {
        scenario: activeScenario,
        checks: data.root_group.checks,
        metrics: {
          http_req_failed: data.metrics.http_req_failed,
          http_req_duration: data.metrics.http_req_duration,
          fedify_loadtest_expected_status_rate: data.metrics.fedify_loadtest_expected_status_rate,
          fedify_loadtest_app_latency_ms: data.metrics.fedify_loadtest_app_latency_ms,
          fedify_loadtest_accepted_total: data.metrics.fedify_loadtest_accepted_total,
        },
      },
      null,
      2,
    ) + '\n',
  };
}
