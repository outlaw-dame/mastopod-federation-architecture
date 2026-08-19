import { loadBoundedAdspJsonFile } from "./BoundedJsonFile.js";
import { isAdspControlledRemoteScenario } from "./ControlledActivityPubTarget.js";
import {
  parseActivityPodsOriginEvidence,
  parseAdspRemoteObservationConfig,
  parsePreparedRemoteOriginEvidence,
  prepareActivityPodsRemoteOriginFixture,
  settleActivityPodsRemoteOriginFixture,
} from "./RemoteFixtureActivityPodsOrigin.js";
import { assertActivityPodsOriginMatchesControlledScenario } from "./RemoteFixtureControlledOriginBinding.js";
import { requireActivityPodsOriginRedPandaProof } from "./RemoteFixtureRedPandaProof.js";
import type { AdspRemoteSettlementOptions } from "./RemoteFixtureSettlement.js";

function optionalNonNegativeSafeInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`${name} must be a canonical non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function optionalPositiveSafeInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`${name} must be a canonical positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return parsed;
}

export function parseActivityPodsRemoteOriginSettlementOptions(
  env: Record<string, string | undefined>,
): AdspRemoteSettlementOptions | undefined {
  const timeoutMs = optionalPositiveSafeInteger(
    "ADSP_REMOTE_SETTLEMENT_TIMEOUT_MS",
    env["ADSP_REMOTE_SETTLEMENT_TIMEOUT_MS"],
  );
  return timeoutMs === undefined ? undefined : { timeoutMs };
}

export async function runActivityPodsRemoteOriginCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const command = argv[0];
  const config = parseAdspRemoteObservationConfig(env);

  if (command === "prepare") {
    if (argv.length !== 1) {
      throw new Error("usage: adsp-p0-activitypods-origin prepare");
    }
    // Keep the persisted prepared-evidence file exactly compatible with the
    // strict parser consumed by `settle`; unlike a terminal status envelope it
    // is itself an evidence artifact and must not gain an extra `ok` field.
    const prepared = await prepareActivityPodsRemoteOriginFixture(config);
    return { schema: prepared.schema, baseline: prepared.baseline };
  }

  if (command === "settle") {
    if (argv.length !== 4) {
      throw new Error(
        "usage: adsp-p0-activitypods-origin settle <success|transient|permanent> <prepared.json> <activitypods-origin.json>",
      );
    }
    const scenario = argv[1];
    const preparedPath = argv[2];
    const originPath = argv[3];
    if (!scenario || !isAdspControlledRemoteScenario(scenario)) {
      throw new TypeError("scenario must be one of: success, transient, permanent");
    }
    if (!preparedPath || !originPath) throw new Error("prepared and ActivityPods origin paths are required");

    const [preparedRaw, originRaw] = await Promise.all([
      loadBoundedAdspJsonFile(preparedPath, { label: "prepared evidence" }),
      loadBoundedAdspJsonFile(originPath, { label: "ActivityPods origin evidence" }),
    ]);
    const prepared = parsePreparedRemoteOriginEvidence(preparedRaw);
    const origin = parseActivityPodsOriginEvidence(originRaw);
    assertActivityPodsOriginMatchesControlledScenario({
      origin,
      scenario,
      targetStatsUrl: config.targetStatsUrl,
    });
    const transientFailuresBeforeSuccess = optionalNonNegativeSafeInteger(
      "ADSP_REMOTE_TRANSIENT_FAILURES",
      env["ADSP_REMOTE_TRANSIENT_FAILURES"],
    );
    const settlement = parseActivityPodsRemoteOriginSettlementOptions(env);
    const result = await settleActivityPodsRemoteOriginFixture({
      config,
      scenario,
      prepared,
      origin,
      ...(scenario === "transient" && transientFailuresBeforeSuccess !== undefined
        ? { transientFailuresBeforeSuccess }
        : {}),
      ...(settlement ? { settlement } : {}),
    });
    const eventLogPublishedAt = await requireActivityPodsOriginRedPandaProof({
      redisUrl: config.redisUrl,
      intentId: result.intentId,
    });
    return {
      ok: result.reconciliation.complete,
      schema: result.schema,
      scenario: result.scenario,
      activityId: result.activityId,
      intentId: result.intentId,
      jobId: result.jobId,
      eventLogPublishedAt,
      observedBodySha256: result.reconciliation.observedBodySha256,
      observedRequests: result.reconciliation.observedRequests,
      errors: result.reconciliation.errors,
    };
  }

  throw new Error(
    "usage: adsp-p0-activitypods-origin <prepare|settle ...>",
  );
}
