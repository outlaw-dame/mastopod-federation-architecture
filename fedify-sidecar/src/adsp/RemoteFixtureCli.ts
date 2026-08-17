import { loadBoundedAdspJsonFile } from "./BoundedJsonFile.js";
import { parseAdspRemoteFixtureCase } from "./RemoteFixtureCase.js";
import {
  parseAdspRemoteLiveRuntimeConfig,
  runAdspRemoteLiveFixture,
} from "./RemoteFixtureLiveRuntime.js";

export async function loadAdspRemoteFixtureCaseFile(
  filePath: string,
  maxBytes: number = 256 * 1024,
) {
  const parsed = await loadBoundedAdspJsonFile(filePath, {
    label: "fixture case",
    maxBytes,
  });
  return parseAdspRemoteFixtureCase(parsed);
}

export async function runAdspRemoteFixtureCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  if (argv.length !== 1) {
    throw new Error("usage: adsp-p0-run-remote-fixture <fixture-case.json>");
  }
  const filePath = argv[0];
  if (!filePath) throw new Error("fixture case path is required");
  const [fixtureCase, config] = await Promise.all([
    loadAdspRemoteFixtureCaseFile(filePath),
    Promise.resolve(parseAdspRemoteLiveRuntimeConfig(env)),
  ]);
  const result = await runAdspRemoteLiveFixture({ config, fixtureCase });
  return {
    ok: result.reconciliation.complete,
    scenario: result.reconciliation.scenario,
    activityId: result.reconciliation.activityId,
    observedBodySha256: result.reconciliation.observedBodySha256,
    observedRequests: result.reconciliation.observedRequests,
    intentId: result.acceptance.intentId,
    jobCount: result.acceptance.jobCount,
    errors: result.reconciliation.errors,
  };
}
