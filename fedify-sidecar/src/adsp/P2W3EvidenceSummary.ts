import {
  expectedOutboundJobIdFromOrigin,
  parseActivityPodsOriginEvidence,
} from "./RemoteFixtureActivityPodsOrigin.js";

export const ADSP_P2_W3_CORRELATION_SCHEMA = "adsp.p2.w3.origin-correlation.v1" as const;
export const ADSP_P2_W3_SUMMARY_SCHEMA = "adsp.p2.w3.mixed-evidence-summary.v1" as const;
export const ADSP_P0_ACTIVITYPODS_SETTLEMENT_SCHEMA = "adsp.p0.activitypods-origin-settlement.v1" as const;
export const ADSP_P2_W3_REPLICA_COUNTS = [1, 2, 4] as const;
export const ADSP_P2_W3_SCENARIOS = ["success", "transient", "permanent"] as const;
export const ADSP_P2_W3_TRANSIENT_FAILURES_BEFORE_SUCCESS = 2 as const;

export type AdspP2W3ReplicaCount = typeof ADSP_P2_W3_REPLICA_COUNTS[number];
export type AdspP2W3Scenario = typeof ADSP_P2_W3_SCENARIOS[number];

export interface AdspP2W3CorrelationEvidence {
  schema: typeof ADSP_P2_W3_CORRELATION_SCHEMA;
  requestId: string;
  activityId: string;
  moleculerNamespace: string;
  expectedReplicas: AdspP2W3ReplicaCount;
}

export interface AdspP2W3SettlementEvidence {
  ok: true;
  schema: typeof ADSP_P0_ACTIVITYPODS_SETTLEMENT_SCHEMA;
  scenario: AdspP2W3Scenario;
  activityId: string;
  intentId: string;
  jobId: string;
  eventLogPublishedAt: number;
  observedRequests: number;
  observedBodySha256: string;
  errors: readonly unknown[];
}

export interface AdspP2W3CaseEvidence {
  replicas: AdspP2W3ReplicaCount;
  scenario: AdspP2W3Scenario;
  origin: unknown;
  correlation: unknown;
  settlement: unknown;
}

export interface AdspP2W3ValidatedCase {
  replicas: AdspP2W3ReplicaCount;
  scenario: AdspP2W3Scenario;
  activityId: string;
  intentId: string;
  requestId: string;
  jobId: string;
  eventLogPublishedAt: number;
  observedRequests: number;
  observedBodySha256: string;
  moleculerNamespace: string;
}

export interface AdspP2W3EvidenceSummary {
  schema: typeof ADSP_P2_W3_SUMMARY_SCHEMA;
  complete: true;
  cases: readonly AdspP2W3ValidatedCase[];
}

function exact(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must be a non-empty exact string`);
  }
  return value;
}

function sha256(name: string, value: unknown): string {
  const digest = exact(name, value);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new TypeError(`${name} must be a lowercase 64-character SHA-256 digest`);
  }
  return digest;
}

function object(name: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(name: string, value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unexpected = Object.keys(value).filter(key => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${name} contains unsupported field(s): ${unexpected.sort().join(", ")}`);
  }
}

function replicaCount(value: unknown): AdspP2W3ReplicaCount {
  if (value === 1 || value === 2 || value === 4) return value;
  throw new TypeError("ADSP P2 W3 replicas must be exactly one of 1, 2, or 4");
}

function scenario(value: unknown): AdspP2W3Scenario {
  if (value === "success" || value === "transient" || value === "permanent") return value;
  throw new TypeError("ADSP P2 W3 scenario must be success, transient, or permanent");
}

function positiveSafeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeSafeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return Number(value);
}

function expectedObservedRequests(expectedScenario: AdspP2W3Scenario): number {
  return expectedScenario === "transient"
    ? ADSP_P2_W3_TRANSIENT_FAILURES_BEFORE_SUCCESS + 1
    : 1;
}

export function parseAdspP2W3CorrelationEvidence(value: unknown): AdspP2W3CorrelationEvidence {
  const root = object("ADSP P2 W3 correlation", value);
  assertOnlyKeys(
    "ADSP P2 W3 correlation",
    root,
    new Set(["schema", "requestId", "activityId", "moleculerNamespace", "expectedReplicas"]),
  );
  if (root["schema"] !== ADSP_P2_W3_CORRELATION_SCHEMA) {
    throw new TypeError(`ADSP P2 W3 correlation schema must be ${ADSP_P2_W3_CORRELATION_SCHEMA}`);
  }
  return {
    schema: ADSP_P2_W3_CORRELATION_SCHEMA,
    requestId: exact("ADSP P2 W3 correlation requestId", root["requestId"]),
    activityId: exact("ADSP P2 W3 correlation activityId", root["activityId"]),
    moleculerNamespace: exact("ADSP P2 W3 correlation moleculerNamespace", root["moleculerNamespace"]),
    expectedReplicas: replicaCount(root["expectedReplicas"]),
  };
}

export function parseAdspP2W3SettlementEvidence(value: unknown): AdspP2W3SettlementEvidence {
  const root = object("ADSP P2 W3 settlement", value);
  assertOnlyKeys(
    "ADSP P2 W3 settlement",
    root,
    new Set([
      "ok",
      "schema",
      "scenario",
      "activityId",
      "intentId",
      "jobId",
      "eventLogPublishedAt",
      "observedBodySha256",
      "observedRequests",
      "errors",
    ]),
  );
  if (root["ok"] !== true) throw new TypeError("ADSP P2 W3 settlement must prove ok=true");
  if (root["schema"] !== ADSP_P0_ACTIVITYPODS_SETTLEMENT_SCHEMA) {
    throw new TypeError(`ADSP P2 W3 settlement schema must be ${ADSP_P0_ACTIVITYPODS_SETTLEMENT_SCHEMA}`);
  }
  const errors = root["errors"];
  if (!Array.isArray(errors) || errors.length !== 0) {
    throw new TypeError("ADSP P2 W3 settlement errors must be an empty array");
  }
  return {
    ok: true,
    schema: ADSP_P0_ACTIVITYPODS_SETTLEMENT_SCHEMA,
    scenario: scenario(root["scenario"]),
    activityId: exact("ADSP P2 W3 settlement activityId", root["activityId"]),
    intentId: exact("ADSP P2 W3 settlement intentId", root["intentId"]),
    jobId: exact("ADSP P2 W3 settlement jobId", root["jobId"]),
    eventLogPublishedAt: positiveSafeInteger("ADSP P2 W3 settlement eventLogPublishedAt", root["eventLogPublishedAt"]),
    observedRequests: nonNegativeSafeInteger("ADSP P2 W3 settlement observedRequests", root["observedRequests"]),
    observedBodySha256: sha256("ADSP P2 W3 settlement observedBodySha256", root["observedBodySha256"]),
    errors,
  };
}

export function validateAdspP2W3Case(input: AdspP2W3CaseEvidence): AdspP2W3ValidatedCase {
  const replicas = replicaCount(input.replicas);
  const expectedScenario = scenario(input.scenario);
  const origin = parseActivityPodsOriginEvidence(input.origin);
  const correlation = parseAdspP2W3CorrelationEvidence(input.correlation);
  const settlement = parseAdspP2W3SettlementEvidence(input.settlement);

  if (correlation.expectedReplicas !== replicas) {
    throw new TypeError(`ADSP P2 W3 correlation replica count drift for ${replicas}r/${expectedScenario}`);
  }
  if (settlement.scenario !== expectedScenario) {
    throw new TypeError(`ADSP P2 W3 settlement scenario drift for ${replicas}r/${expectedScenario}`);
  }
  if (correlation.activityId !== origin.activityId || settlement.activityId !== origin.activityId) {
    throw new TypeError(`ADSP P2 W3 Activity identity drift for ${replicas}r/${expectedScenario}`);
  }
  if (settlement.intentId !== origin.deliveryPlanIntentId) {
    throw new TypeError(`ADSP P2 W3 Delivery Plan intent drift for ${replicas}r/${expectedScenario}`);
  }

  const expectedJobId = expectedOutboundJobIdFromOrigin(origin);
  if (settlement.jobId !== expectedJobId) {
    throw new TypeError(`ADSP P2 W3 outbound job identity drift for ${replicas}r/${expectedScenario}`);
  }
  const expectedRequests = expectedObservedRequests(expectedScenario);
  if (settlement.observedRequests !== expectedRequests) {
    throw new TypeError(
      `ADSP P2 W3 observed request count drift for ${replicas}r/${expectedScenario}: expected ${expectedRequests}, observed ${settlement.observedRequests}`,
    );
  }

  return {
    replicas,
    scenario: expectedScenario,
    activityId: origin.activityId,
    intentId: origin.deliveryPlanIntentId,
    requestId: correlation.requestId,
    jobId: settlement.jobId,
    eventLogPublishedAt: settlement.eventLogPublishedAt,
    observedRequests: settlement.observedRequests,
    observedBodySha256: settlement.observedBodySha256,
    moleculerNamespace: correlation.moleculerNamespace,
  };
}

export function summarizeAdspP2W3Evidence(inputs: readonly AdspP2W3CaseEvidence[]): AdspP2W3EvidenceSummary {
  if (inputs.length !== ADSP_P2_W3_REPLICA_COUNTS.length * ADSP_P2_W3_SCENARIOS.length) {
    throw new TypeError("ADSP P2 W3 evidence must contain exactly nine 1/2/4 x success/transient/permanent cases");
  }

  const validated = inputs.map(validateAdspP2W3Case);
  const seenCoordinates = new Set<string>();
  const activityIds = new Set<string>();
  const requestIds = new Set<string>();
  const intentIds = new Set<string>();
  const jobIds = new Set<string>();

  for (const item of validated) {
    const coordinate = `${item.replicas}/${item.scenario}`;
    if (seenCoordinates.has(coordinate)) throw new TypeError(`ADSP P2 W3 duplicate evidence coordinate ${coordinate}`);
    seenCoordinates.add(coordinate);
    if (activityIds.has(item.activityId)) throw new TypeError(`ADSP P2 W3 duplicate Activity identity ${item.activityId}`);
    activityIds.add(item.activityId);
    if (requestIds.has(item.requestId)) throw new TypeError(`ADSP P2 W3 duplicate request identity ${item.requestId}`);
    requestIds.add(item.requestId);
    if (intentIds.has(item.intentId)) throw new TypeError(`ADSP P2 W3 duplicate Delivery Plan intent ${item.intentId}`);
    intentIds.add(item.intentId);
    if (jobIds.has(item.jobId)) throw new TypeError(`ADSP P2 W3 duplicate outbound job identity ${item.jobId}`);
    jobIds.add(item.jobId);
  }

  const armNamespaces = new Set<string>();
  for (const replicas of ADSP_P2_W3_REPLICA_COUNTS) {
    const namespaces = new Set(validated.filter(item => item.replicas === replicas).map(item => item.moleculerNamespace));
    if (namespaces.size !== 1) {
      throw new TypeError(`ADSP P2 W3 ${replicas}r scenarios must share one matched Moleculer namespace`);
    }
    const [namespace] = namespaces;
    if (!namespace) throw new TypeError(`ADSP P2 W3 ${replicas}r namespace is missing`);
    if (armNamespaces.has(namespace)) {
      throw new TypeError(`ADSP P2 W3 replica arms must use distinct Moleculer namespaces; reused ${namespace}`);
    }
    armNamespaces.add(namespace);
    for (const expectedScenario of ADSP_P2_W3_SCENARIOS) {
      if (!seenCoordinates.has(`${replicas}/${expectedScenario}`)) {
        throw new TypeError(`ADSP P2 W3 missing evidence coordinate ${replicas}/${expectedScenario}`);
      }
    }
  }

  return {
    schema: ADSP_P2_W3_SUMMARY_SCHEMA,
    complete: true,
    cases: validated.sort((a, b) => a.replicas - b.replicas || ADSP_P2_W3_SCENARIOS.indexOf(a.scenario) - ADSP_P2_W3_SCENARIOS.indexOf(b.scenario)),
  };
}
