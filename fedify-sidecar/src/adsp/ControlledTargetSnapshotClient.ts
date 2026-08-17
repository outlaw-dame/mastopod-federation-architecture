import { isIP } from "node:net";
import { request } from "undici";
import type {
  AdspControlledRemoteScenario,
  ControlledTargetObservation,
  ControlledTargetSnapshot,
} from "./ControlledActivityPubTarget.js";
import type { AdspRemoteTargetSnapshotPort } from "./RemoteFixtureSettlement.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const SCENARIOS = new Set<AdspControlledRemoteScenario>([
  "success",
  "transient",
  "permanent",
]);

type DestroyableBody = AsyncIterable<Uint8Array> & { destroy?: () => void };

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

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

export function normalizeControlledTargetStatsUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("controlled target stats URL must be a valid URL");
  }
  if (parsed.protocol !== "http:") {
    throw new TypeError("controlled target stats URL must use loopback HTTP");
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new TypeError("controlled target stats URL must use an explicit loopback hostname");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("controlled target stats URL must not contain credentials");
  }
  if (parsed.hash) {
    throw new TypeError("controlled target stats URL must not contain a fragment");
  }
  if (parsed.pathname !== "/stats") {
    throw new TypeError("controlled target stats URL pathname must be /stats");
  }
  return parsed;
}

function parseObservation(value: unknown, index: number): ControlledTargetObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`observations[${index}] must be an object`);
  }
  const item = value as Record<string, unknown>;
  const scenario = item["scenario"];
  if (typeof scenario !== "string" || !SCENARIOS.has(scenario as AdspControlledRemoteScenario)) {
    throw new TypeError(`observations[${index}].scenario is invalid`);
  }
  const stringField = (name: string): string => {
    const field = item[name];
    if (typeof field !== "string") throw new TypeError(`observations[${index}].${name} must be a string`);
    return field;
  };
  const boolField = (name: string): boolean => {
    const field = item[name];
    if (typeof field !== "boolean") throw new TypeError(`observations[${index}].${name} must be boolean`);
    return field;
  };

  const activityId = item["activityId"];
  const contentType = item["contentType"];
  const host = item["host"];
  if (activityId !== null && typeof activityId !== "string") {
    throw new TypeError(`observations[${index}].activityId must be string|null`);
  }
  if (typeof activityId === "string" && (!activityId || activityId !== activityId.trim())) {
    throw new TypeError(`observations[${index}].activityId must be an exact non-empty string|null`);
  }
  if (contentType !== null && typeof contentType !== "string") {
    throw new TypeError(`observations[${index}].contentType must be string|null`);
  }
  if (host !== null && typeof host !== "string") {
    throw new TypeError(`observations[${index}].host must be string|null`);
  }

  return {
    sequence: nonNegativeSafeInteger(`observations[${index}].sequence`, item["sequence"]),
    scenario: scenario as AdspControlledRemoteScenario,
    scenarioAttempt: nonNegativeSafeInteger(`observations[${index}].scenarioAttempt`, item["scenarioAttempt"]),
    payloadAttempt: nonNegativeSafeInteger(`observations[${index}].payloadAttempt`, item["payloadAttempt"]),
    method: stringField("method"),
    path: stringField("path"),
    bodyBytes: nonNegativeSafeInteger(`observations[${index}].bodyBytes`, item["bodyBytes"]),
    bodySha256: stringField("bodySha256"),
    activityId,
    contentType,
    host,
    hasDate: boolField("hasDate"),
    hasDigest: boolField("hasDigest"),
    hasValidDigest: boolField("hasValidDigest"),
    hasSignature: boolField("hasSignature"),
    receivedAtMs: nonNegativeSafeInteger(`observations[${index}].receivedAtMs`, item["receivedAtMs"]),
  };
}

export function parseControlledTargetSnapshot(value: unknown): ControlledTargetSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("controlled target snapshot must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input["version"] !== 1) throw new TypeError("controlled target snapshot version must be 1");

  const counts = input["counts"];
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new TypeError("controlled target snapshot counts must be an object");
  }
  const countRecord = counts as Record<string, unknown>;
  const observations = input["observations"];
  if (!Array.isArray(observations)) {
    throw new TypeError("controlled target snapshot observations must be an array");
  }

  const parsed: ControlledTargetSnapshot = {
    version: 1,
    transientFailuresBeforeSuccess: nonNegativeSafeInteger(
      "transientFailuresBeforeSuccess",
      input["transientFailuresBeforeSuccess"],
    ),
    maxObservations: positiveSafeInteger("maxObservations", input["maxObservations"]),
    totalRequests: nonNegativeSafeInteger("totalRequests", input["totalRequests"]),
    droppedObservations: nonNegativeSafeInteger(
      "droppedObservations",
      input["droppedObservations"],
    ),
    counts: {
      success: nonNegativeSafeInteger("counts.success", countRecord["success"]),
      transient: nonNegativeSafeInteger("counts.transient", countRecord["transient"]),
      permanent: nonNegativeSafeInteger("counts.permanent", countRecord["permanent"]),
    },
    observations: observations.map(parseObservation),
  };

  const aggregateCount = parsed.counts.success + parsed.counts.transient + parsed.counts.permanent;
  if (aggregateCount !== parsed.totalRequests) {
    throw new TypeError(
      `controlled target snapshot count mismatch: aggregate=${aggregateCount} totalRequests=${parsed.totalRequests}`,
    );
  }
  if (parsed.observations.length + parsed.droppedObservations !== parsed.totalRequests) {
    throw new TypeError("controlled target snapshot retained/dropped observation counts do not reconcile");
  }
  return parsed;
}

async function readBoundedJsonBody(
  body: DestroyableBody,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      body.destroy?.();
      throw new Error(`controlled target stats body exceeded ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks, total).toString("utf8");
  return JSON.parse(text);
}

export class HttpControlledTargetSnapshotClient implements AdspRemoteTargetSnapshotPort {
  private readonly url: URL;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;

  constructor(value: string, options: { timeoutMs?: number; maxBodyBytes?: number } = {}) {
    this.url = normalizeControlledTargetStatsUrl(value);
    this.timeoutMs = positiveSafeInteger("timeoutMs", options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxBodyBytes = positiveSafeInteger(
      "maxBodyBytes",
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    );
  }

  async readSnapshot(): Promise<ControlledTargetSnapshot> {
    const response = await request(this.url, {
      method: "GET",
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
      maxRedirections: 0,
    });
    if (response.statusCode !== 200) {
      response.body.destroy();
      throw new Error(`controlled target stats returned HTTP ${response.statusCode}`);
    }
    const parsed = await readBoundedJsonBody(response.body, this.maxBodyBytes);
    return parseControlledTargetSnapshot(parsed);
  }
}
