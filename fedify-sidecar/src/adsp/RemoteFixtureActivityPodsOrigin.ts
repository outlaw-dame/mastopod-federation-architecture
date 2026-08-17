import { createClient } from "redis";
import {
  assertEmptyControlledTargetSnapshot,
  HttpControlledTargetFixtureClient,
} from "./ControlledTargetFixtureClient.js";
import type { AdspControlledRemoteScenario } from "./ControlledActivityPubTarget.js";
import {
  AdspRemoteFixtureDurableObserver,
  type AdspRemoteDurableBaseline,
} from "./RemoteFixtureDurableObserver.js";
import {
  AdspRemoteReadOnlyQueueObservation,
  assertExistingSidecarConsumerGroups,
  type AdspRemoteLiveRuntimeConfig,
  type RedisReadOnlyObservationPort,
} from "./RemoteFixtureLiveRuntime.js";
import {
  waitForAdspRemoteFixtureSettlement,
  type AdspRemoteSettlementOptions,
} from "./RemoteFixtureSettlement.js";
import type { AdspRemoteFixtureReconciliation } from "./RemoteFixtureOutcomeReconciler.js";
import { normalizeAndDedupeOutboundTargets } from "../delivery/outbound-webhook.js";

const PREPARED_SCHEMA = "adsp.p0.remote-origin-prepared.v1";
const ORIGIN_SCHEMA = "adsp.p0.activitypods-remote-origin.v1";
const DELIVERY_PLAN_SCHEMA = "ap.delivery-plan.v1";

export type AdspRemoteObservationConfig = Omit<
  AdspRemoteLiveRuntimeConfig,
  "sidecarWebhookUrl" | "sidecarToken"
>;

export interface AdspPreparedRemoteOriginEvidence {
  schema: typeof PREPARED_SCHEMA;
  baseline: AdspRemoteDurableBaseline;
}

export interface AdspActivityPodsOriginEvidence {
  schema: typeof ORIGIN_SCHEMA;
  activityId: string;
  actorUri: string;
  activity: Record<string, unknown>;
  deliveryPlanSchema: typeof DELIVERY_PLAN_SCHEMA;
  deliveryPlanIntentId: string;
  remoteActorUri: string;
  inboxUrl: string;
  sharedInboxUrl?: string;
  targetDomain: string;
  visibility: "public" | "unlisted";
  isPublicActivity: true;
  suppressedNativeRemotePostCount: 1;
  durableHandoffQueued: true;
  senderUsername?: string;
}

export interface AdspActivityPodsOriginSettlementResult {
  schema: "adsp.p0.activitypods-origin-settlement.v1";
  scenario: AdspControlledRemoteScenario;
  activityId: string;
  intentId: string;
  jobId: string;
  reconciliation: AdspRemoteFixtureReconciliation;
}

function exact(name: string, value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty exact string`);
  }
  return value;
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

function nonNegativeSafeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return Number(value);
}

function normalizeEntityId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const id = record["id"] ?? record["@id"];
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return null;
}

export function parseAdspRemoteObservationConfig(
  env: Record<string, string | undefined>,
): AdspRemoteObservationConfig {
  return {
    redisUrl: exact("ADSP_REMOTE_REDIS_URL", env["ADSP_REMOTE_REDIS_URL"]),
    targetStatsUrl: exact("ADSP_REMOTE_TARGET_STATS_URL", env["ADSP_REMOTE_TARGET_STATS_URL"]),
    consumerGroup: exact("ADSP_REMOTE_CONSUMER_GROUP", env["ADSP_REMOTE_CONSUMER_GROUP"]),
    inboundStreamKey: exact("ADSP_REMOTE_INBOUND_STREAM_KEY", env["ADSP_REMOTE_INBOUND_STREAM_KEY"]),
    outboundStreamKey: exact("ADSP_REMOTE_OUTBOUND_STREAM_KEY", env["ADSP_REMOTE_OUTBOUND_STREAM_KEY"]),
    outboxIntentStreamKey: exact(
      "ADSP_REMOTE_OUTBOX_INTENT_STREAM_KEY",
      env["ADSP_REMOTE_OUTBOX_INTENT_STREAM_KEY"],
    ),
    originReconcileStreamKey: exact(
      "ADSP_REMOTE_ORIGIN_RECONCILE_STREAM_KEY",
      env["ADSP_REMOTE_ORIGIN_RECONCILE_STREAM_KEY"],
    ),
    outboundDlqStreamKey: exact(
      "ADSP_REMOTE_OUTBOUND_DLQ_STREAM_KEY",
      env["ADSP_REMOTE_OUTBOUND_DLQ_STREAM_KEY"],
    ),
  };
}

export function parsePreparedRemoteOriginEvidence(value: unknown): AdspPreparedRemoteOriginEvidence {
  const root = object("prepared evidence", value);
  assertOnlyKeys("prepared evidence", root, new Set(["schema", "baseline"]));
  if (root["schema"] !== PREPARED_SCHEMA) {
    throw new TypeError(`prepared evidence schema must be ${PREPARED_SCHEMA}`);
  }
  const baseline = object("prepared evidence baseline", root["baseline"]);
  assertOnlyKeys("prepared evidence baseline", baseline, new Set(["outboundDlqLength"]));
  return {
    schema: PREPARED_SCHEMA,
    baseline: {
      outboundDlqLength: nonNegativeSafeInteger(
        "prepared evidence baseline.outboundDlqLength",
        baseline["outboundDlqLength"],
      ),
    },
  };
}

export function parseActivityPodsOriginEvidence(value: unknown): AdspActivityPodsOriginEvidence {
  const root = object("ActivityPods origin evidence", value);
  assertOnlyKeys(
    "ActivityPods origin evidence",
    root,
    new Set([
      "ok",
      "schema",
      "activityId",
      "actorUri",
      "activity",
      "deliveryPlanSchema",
      "deliveryPlanIntentId",
      "remoteActorUri",
      "inboxUrl",
      "sharedInboxUrl",
      "targetDomain",
      "visibility",
      "isPublicActivity",
      "suppressedNativeRemotePostCount",
      "durableHandoffQueued",
      "senderUsername",
    ]),
  );
  if (root["ok"] !== undefined && root["ok"] !== true) {
    throw new TypeError("ActivityPods origin evidence ok must be true when present");
  }
  if (root["schema"] !== ORIGIN_SCHEMA) {
    throw new TypeError(`ActivityPods origin evidence schema must be ${ORIGIN_SCHEMA}`);
  }
  if (root["deliveryPlanSchema"] !== DELIVERY_PLAN_SCHEMA) {
    throw new TypeError(`ActivityPods origin deliveryPlanSchema must be ${DELIVERY_PLAN_SCHEMA}`);
  }
  if (root["durableHandoffQueued"] !== true) {
    throw new TypeError("ActivityPods origin evidence must prove durableHandoffQueued=true");
  }
  if (root["suppressedNativeRemotePostCount"] !== 1) {
    throw new TypeError("ActivityPods origin evidence must prove exactly one suppressed native remotePost");
  }
  if (root["isPublicActivity"] !== true || (root["visibility"] !== "public" && root["visibility"] !== "unlisted")) {
    throw new TypeError("ActivityPods origin evidence must prove a public/unlisted Activity for RedPanda event logging");
  }

  const activityId = exact("ActivityPods origin activityId", root["activityId"]);
  const actorUri = exact("ActivityPods origin actorUri", root["actorUri"]);
  const activity = object("ActivityPods origin activity", root["activity"]);
  if (normalizeEntityId(activity["id"] ?? activity["@id"]) !== activityId) {
    throw new TypeError("ActivityPods origin activity id does not match activityId");
  }
  if (normalizeEntityId(activity["actor"]) !== actorUri) {
    throw new TypeError("ActivityPods origin activity actor does not match actorUri");
  }

  const deliveryPlanIntentId = exact(
    "ActivityPods origin deliveryPlanIntentId",
    root["deliveryPlanIntentId"],
  );
  const remoteActorUri = exact("ActivityPods origin remoteActorUri", root["remoteActorUri"]);
  const inboxUrl = exact("ActivityPods origin inboxUrl", root["inboxUrl"]);
  const targetDomain = exact("ActivityPods origin targetDomain", root["targetDomain"]);
  const sharedInboxUrl = root["sharedInboxUrl"] === undefined
    ? undefined
    : exact("ActivityPods origin sharedInboxUrl", root["sharedInboxUrl"]);
  const senderUsername = root["senderUsername"] === undefined
    ? undefined
    : exact("ActivityPods origin senderUsername", root["senderUsername"]);

  const normalized = normalizeAndDedupeOutboundTargets(
    [{ inboxUrl, ...(sharedInboxUrl ? { sharedInboxUrl } : {}) }],
    { maxTargetsPerRequest: 1 },
  );
  if (
    normalized.targets.length !== 1 ||
    normalized.invalidTargetCount !== 0 ||
    normalized.duplicateTargetCount !== 0
  ) {
    throw new TypeError("ActivityPods origin target does not normalize to exactly one sidecar delivery target");
  }
  const target = normalized.targets[0]!;
  if (target.targetDomain !== targetDomain) {
    throw new TypeError(
      `ActivityPods origin targetDomain ${targetDomain} does not match sidecar-normalized ${target.targetDomain}`,
    );
  }

  return {
    schema: ORIGIN_SCHEMA,
    activityId,
    actorUri,
    activity,
    deliveryPlanSchema: DELIVERY_PLAN_SCHEMA,
    deliveryPlanIntentId,
    remoteActorUri,
    inboxUrl: target.inboxUrl,
    ...(target.sharedInboxUrl ? { sharedInboxUrl: target.sharedInboxUrl } : {}),
    targetDomain,
    visibility: root["visibility"] as "public" | "unlisted",
    isPublicActivity: true,
    suppressedNativeRemotePostCount: 1,
    durableHandoffQueued: true,
    ...(senderUsername ? { senderUsername } : {}),
  };
}

export function expectedOutboundJobIdFromOrigin(origin: AdspActivityPodsOriginEvidence): string {
  const normalized = normalizeAndDedupeOutboundTargets(
    [{
      inboxUrl: origin.inboxUrl,
      ...(origin.sharedInboxUrl ? { sharedInboxUrl: origin.sharedInboxUrl } : {}),
    }],
    { maxTargetsPerRequest: 1 },
  );
  const target = normalized.targets[0];
  if (!target || normalized.targets.length !== 1) {
    throw new TypeError("ActivityPods origin did not resolve to exactly one production delivery URL");
  }
  // This is the production OutboxIntentWorker identity contract:
  // `${activityId}::${normalized deliveryUrl}`. Keeping normalization here on
  // the same production helper prevents fixture-only URL canonicalization.
  return `${origin.activityId}::${target.deliveryUrl}`;
}

async function withObservationRuntime<T>(
  config: AdspRemoteObservationConfig,
  fn: (input: {
    observer: AdspRemoteFixtureDurableObserver;
    target: HttpControlledTargetFixtureClient;
  }) => Promise<T>,
): Promise<T> {
  const redis = createClient({ url: config.redisUrl });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    const readOnlyRedis = redis as unknown as RedisReadOnlyObservationPort;
    await assertExistingSidecarConsumerGroups(readOnlyRedis, config);
    const queue = new AdspRemoteReadOnlyQueueObservation(readOnlyRedis, config);
    const observer = new AdspRemoteFixtureDurableObserver(queue, readOnlyRedis);
    const target = new HttpControlledTargetFixtureClient(config.targetStatsUrl);
    return await fn({ observer, target });
  } finally {
    if (redis.isOpen) await redis.quit().catch(() => undefined);
  }
}

export async function prepareActivityPodsRemoteOriginFixture(
  config: AdspRemoteObservationConfig,
): Promise<AdspPreparedRemoteOriginEvidence> {
  return await withObservationRuntime(config, async ({ observer, target }) => {
    await target.reset();
    const emptyTarget = await target.readSnapshot();
    assertEmptyControlledTargetSnapshot(emptyTarget);
    const baseline = await observer.captureBaseline();
    return { schema: PREPARED_SCHEMA, baseline };
  });
}

export async function settleActivityPodsRemoteOriginFixture(input: {
  config: AdspRemoteObservationConfig;
  scenario: AdspControlledRemoteScenario;
  prepared: AdspPreparedRemoteOriginEvidence;
  origin: AdspActivityPodsOriginEvidence;
  transientFailuresBeforeSuccess?: number;
  settlement?: AdspRemoteSettlementOptions;
}): Promise<AdspActivityPodsOriginSettlementResult> {
  const { config, scenario, prepared, origin } = input;
  const jobId = expectedOutboundJobIdFromOrigin(origin);
  const reconciliation = await withObservationRuntime(config, async ({ observer, target }) =>
    await waitForAdspRemoteFixtureSettlement({
      observer,
      target,
      expectation: {
        scenario,
        activityId: origin.activityId,
        ...(input.transientFailuresBeforeSuccess !== undefined
          ? { transientFailuresBeforeSuccess: input.transientFailuresBeforeSuccess }
          : {}),
      },
      intentId: origin.deliveryPlanIntentId,
      jobId,
      baseline: prepared.baseline,
      ...(input.settlement ? { options: input.settlement } : {}),
    }),
  );

  return {
    schema: "adsp.p0.activitypods-origin-settlement.v1",
    scenario,
    activityId: origin.activityId,
    intentId: origin.deliveryPlanIntentId,
    jobId,
    reconciliation,
  };
}
