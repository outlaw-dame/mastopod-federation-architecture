import type { AdspControlledRemoteScenario } from "./ControlledActivityPubTarget.js";
import type { AdspRemoteFixtureHandoffInput } from "./RemoteFixtureHandoffClient.js";
import type { AdspRemoteFixtureRunInput } from "./RemoteFixtureRunner.js";

const SCENARIOS = new Set<AdspControlledRemoteScenario>([
  "success",
  "transient",
  "permanent",
]);

function exactString(name: string, value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty exact string`);
  }
  return value;
}

function nonNegativeSafeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return Number(value);
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

export function parseAdspRemoteFixtureCase(value: unknown): AdspRemoteFixtureRunInput {
  const root = object("fixture case", value);
  assertOnlyKeys(
    "fixture case",
    root,
    new Set(["scenario", "jobId", "handoff", "transientFailuresBeforeSuccess"]),
  );

  const scenarioValue = exactString("scenario", root["scenario"]);
  if (!SCENARIOS.has(scenarioValue as AdspControlledRemoteScenario)) {
    throw new TypeError(`scenario must be one of: ${[...SCENARIOS].join(", ")}`);
  }
  const scenario = scenarioValue as AdspControlledRemoteScenario;
  const handoffRaw = object("handoff", root["handoff"]);
  assertOnlyKeys(
    "handoff",
    handoffRaw,
    new Set([
      "deliveryPlanIntentId",
      "actorUri",
      "activityId",
      "activity",
      "target",
      "meta",
    ]),
  );
  const targetRaw = object("handoff.target", handoffRaw["target"]);
  assertOnlyKeys("handoff.target", targetRaw, new Set(["inboxUrl", "sharedInboxUrl"]));

  const activity = object("handoff.activity", handoffRaw["activity"]);
  const metaValue = handoffRaw["meta"];
  const meta = metaValue === undefined ? undefined : object("handoff.meta", metaValue);
  const sharedInboxValue = targetRaw["sharedInboxUrl"];

  const handoff: AdspRemoteFixtureHandoffInput = {
    deliveryPlanIntentId: exactString(
      "handoff.deliveryPlanIntentId",
      handoffRaw["deliveryPlanIntentId"],
    ),
    actorUri: exactString("handoff.actorUri", handoffRaw["actorUri"]),
    activityId: exactString("handoff.activityId", handoffRaw["activityId"]),
    activity,
    target: {
      inboxUrl: exactString("handoff.target.inboxUrl", targetRaw["inboxUrl"]),
      ...(sharedInboxValue !== undefined
        ? { sharedInboxUrl: exactString("handoff.target.sharedInboxUrl", sharedInboxValue) }
        : {}),
    },
    ...(meta ? { meta } : {}),
  };

  const transientValue = root["transientFailuresBeforeSuccess"];
  if (scenario !== "transient" && transientValue !== undefined) {
    throw new TypeError("transientFailuresBeforeSuccess is allowed only for the transient scenario");
  }

  return {
    scenario,
    jobId: exactString("jobId", root["jobId"]),
    handoff,
    ...(transientValue !== undefined
      ? {
          transientFailuresBeforeSuccess: nonNegativeSafeInteger(
            "transientFailuresBeforeSuccess",
            transientValue,
          ),
        }
      : {}),
  };
}
