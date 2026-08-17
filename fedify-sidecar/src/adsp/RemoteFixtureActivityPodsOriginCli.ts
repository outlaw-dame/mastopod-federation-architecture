import { loadBoundedAdspJsonFile } from "./BoundedJsonFile.js";
import { isAdspControlledRemoteScenario } from "./ControlledActivityPubTarget.js";
import {
  parseActivityPodsOriginEvidence,
  parseAdspRemoteObservationConfig,
  parsePreparedRemoteOriginEvidence,
  prepareActivityPodsRemoteOriginFixture,
  settleActivityPodsRemoteOriginFixture,
} from "./RemoteFixtureActivityPodsOrigin.js";

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
    const prepared = await prepareActivityPodsRemoteOriginFixture(config);
    return { ok: true, ...prepared };
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
    const transientFailuresBeforeSuccess = optionalNonNegativeSafeInteger(
      "ADSP_REMOTE_TRANSIENT_FAILURES",
      env["ADSP_REMOTE_TRANSIENT_FAILURES"],
    );
    const result = await settleActivityPodsRemoteOriginFixture({
      config,
      scenario,
      prepared,
      origin,
      ...(scenario === "transient" && transientFailuresBeforeSuccess !== undefined
        ? { transientFailuresBeforeSuccess }
        : {}),
    });
    return {
      ok: result.reconciliation.complete,
      schema: result.schema,
      scenario: result.scenario,
      activityId: result.activityId,
      intentId: result.intentId,
      jobId: result.jobId,
      observedBodySha256: result.reconciliation.observedBodySha256,
      observedRequests: result.reconciliation.observedRequests,
      errors: result.reconciliation.errors,
    };
  }

  throw new Error(
    "usage: adsp-p0-activitypods-origin <prepare|settle ...>",
  );
}
