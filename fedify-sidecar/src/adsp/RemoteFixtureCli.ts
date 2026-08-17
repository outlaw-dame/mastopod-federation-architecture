import { readFile, stat } from "node:fs/promises";
import { parseAdspRemoteFixtureCase } from "./RemoteFixtureCase.js";
import {
  parseAdspRemoteLiveRuntimeConfig,
  runAdspRemoteLiveFixture,
} from "./RemoteFixtureLiveRuntime.js";

const DEFAULT_MAX_CASE_FILE_BYTES = 256 * 1024;

function positiveSafeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

export async function loadAdspRemoteFixtureCaseFile(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_CASE_FILE_BYTES,
) {
  if (!filePath || filePath !== filePath.trim()) {
    throw new TypeError("fixture case path must be a non-empty exact string");
  }
  const limit = positiveSafeInteger("max fixture case bytes", maxBytes);
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error("fixture case path must reference a regular file");
  if (metadata.size > limit) {
    throw new Error(`fixture case file exceeds ${limit} bytes`);
  }
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("fixture case file contains malformed JSON");
  }
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
