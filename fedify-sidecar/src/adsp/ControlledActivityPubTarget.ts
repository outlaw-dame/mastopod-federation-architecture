import { createHash } from "node:crypto";

export const ADSP_CONTROLLED_REMOTE_SCENARIOS = [
  "success",
  "transient",
  "permanent",
] as const;

export type AdspControlledRemoteScenario =
  (typeof ADSP_CONTROLLED_REMOTE_SCENARIOS)[number];

export interface ControlledTargetObservation {
  sequence: number;
  scenario: AdspControlledRemoteScenario;
  scenarioAttempt: number;
  payloadAttempt: number;
  method: string;
  path: string;
  bodyBytes: number;
  bodySha256: string;
  contentType: string | null;
  host: string | null;
  hasDate: boolean;
  hasDigest: boolean;
  hasSignature: boolean;
  receivedAtMs: number;
}

export interface ControlledTargetSnapshot {
  version: 1;
  transientFailuresBeforeSuccess: number;
  maxObservations: number;
  totalRequests: number;
  droppedObservations: number;
  counts: Record<AdspControlledRemoteScenario, number>;
  observations: ControlledTargetObservation[];
}

export interface ControlledTargetResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

export interface ControlledTargetRequest {
  scenario: AdspControlledRemoteScenario;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
  nowMs?: number;
}

function normalizeSingleHeader(
  value: string | string[] | undefined,
): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(",");
  return null;
}

function hasNonEmptyHeader(
  headers: ControlledTargetRequest["headers"],
  name: string,
): boolean {
  const value = normalizeSingleHeader(headers[name]);
  return typeof value === "string" && value.trim().length > 0;
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

export class ControlledActivityPubTargetState {
  private readonly transientFailuresBeforeSuccess: number;
  private readonly maxObservations: number;
  private readonly observations: ControlledTargetObservation[] = [];
  private readonly payloadAttempts = new Map<string, number>();
  private readonly counts: Record<AdspControlledRemoteScenario, number> = {
    success: 0,
    transient: 0,
    permanent: 0,
  };
  private totalRequests = 0;
  private droppedObservations = 0;

  constructor(
    options: {
      transientFailuresBeforeSuccess?: number;
      maxObservations?: number;
    } = {},
  ) {
    const transientFailuresBeforeSuccess =
      options.transientFailuresBeforeSuccess ?? 2;
    const maxObservations = options.maxObservations ?? 10_000;
    assertNonNegativeSafeInteger(
      "transientFailuresBeforeSuccess",
      transientFailuresBeforeSuccess,
    );
    assertPositiveSafeInteger("maxObservations", maxObservations);
    this.transientFailuresBeforeSuccess = transientFailuresBeforeSuccess;
    this.maxObservations = maxObservations;
  }

  reset(): void {
    this.observations.length = 0;
    this.payloadAttempts.clear();
    this.counts.success = 0;
    this.counts.transient = 0;
    this.counts.permanent = 0;
    this.totalRequests = 0;
    this.droppedObservations = 0;
  }

  snapshot(): ControlledTargetSnapshot {
    return {
      version: 1,
      transientFailuresBeforeSuccess: this.transientFailuresBeforeSuccess,
      maxObservations: this.maxObservations,
      totalRequests: this.totalRequests,
      droppedObservations: this.droppedObservations,
      counts: { ...this.counts },
      observations: this.observations.map(observation => ({ ...observation })),
    };
  }

  handle(request: ControlledTargetRequest): ControlledTargetResponse {
    if (request.method.toUpperCase() !== "POST") {
      return {
        statusCode: 405,
        headers: { allow: "POST" },
        body: JSON.stringify({ error: "method_not_allowed" }),
      };
    }

    const contentType = normalizeSingleHeader(request.headers["content-type"]);
    const body = Buffer.from(request.body);
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    const payloadAttempt = (this.payloadAttempts.get(bodySha256) ?? 0) + 1;
    this.payloadAttempts.set(bodySha256, payloadAttempt);
    this.counts[request.scenario] += 1;
    this.totalRequests += 1;

    const observation: ControlledTargetObservation = {
      sequence: this.totalRequests,
      scenario: request.scenario,
      scenarioAttempt: this.counts[request.scenario],
      payloadAttempt,
      method: request.method.toUpperCase(),
      path: request.path,
      bodyBytes: body.byteLength,
      bodySha256,
      contentType,
      host: normalizeSingleHeader(request.headers.host),
      hasDate: hasNonEmptyHeader(request.headers, "date"),
      hasDigest: hasNonEmptyHeader(request.headers, "digest"),
      hasSignature: hasNonEmptyHeader(request.headers, "signature"),
      receivedAtMs: request.nowMs ?? Date.now(),
    };

    if (this.observations.length >= this.maxObservations) {
      this.observations.shift();
      this.droppedObservations += 1;
    }
    this.observations.push(observation);

    if (
      !observation.hasDate ||
      !observation.hasDigest ||
      !observation.hasSignature
    ) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "missing_required_signature_headers",
          hasDate: observation.hasDate,
          hasDigest: observation.hasDigest,
          hasSignature: observation.hasSignature,
        }),
      };
    }

    if (
      !contentType ||
      !contentType.toLowerCase().includes("application/activity+json")
    ) {
      return {
        statusCode: 415,
        body: JSON.stringify({ error: "unsupported_media_type" }),
      };
    }

    if (request.scenario === "permanent") {
      return {
        statusCode: 410,
        body: JSON.stringify({ error: "controlled_permanent_failure" }),
      };
    }

    if (
      request.scenario === "transient" &&
      payloadAttempt <= this.transientFailuresBeforeSuccess
    ) {
      return {
        statusCode: 503,
        headers: { "retry-after": "0" },
        body: JSON.stringify({
          error: "controlled_transient_failure",
          payloadAttempt,
        }),
      };
    }

    return {
      statusCode: 202,
      body: JSON.stringify({
        accepted: true,
        scenario: request.scenario,
        payloadAttempt,
      }),
    };
  }
}

export function isAdspControlledRemoteScenario(
  value: string,
): value is AdspControlledRemoteScenario {
  return (ADSP_CONTROLLED_REMOTE_SCENARIOS as readonly string[]).includes(value);
}
