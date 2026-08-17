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
  totalRequests: number;
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

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

export class ControlledActivityPubTargetState {
  private readonly transientFailuresBeforeSuccess: number;
  private readonly observations: ControlledTargetObservation[] = [];
  private readonly counts: Record<AdspControlledRemoteScenario, number> = {
    success: 0,
    transient: 0,
    permanent: 0,
  };

  constructor(options: { transientFailuresBeforeSuccess?: number } = {}) {
    const transientFailuresBeforeSuccess =
      options.transientFailuresBeforeSuccess ?? 2;
    assertPositiveInteger(
      "transientFailuresBeforeSuccess",
      transientFailuresBeforeSuccess,
    );
    this.transientFailuresBeforeSuccess = transientFailuresBeforeSuccess;
  }

  reset(): void {
    this.observations.length = 0;
    this.counts.success = 0;
    this.counts.transient = 0;
    this.counts.permanent = 0;
  }

  snapshot(): ControlledTargetSnapshot {
    return {
      version: 1,
      transientFailuresBeforeSuccess: this.transientFailuresBeforeSuccess,
      totalRequests: this.observations.length,
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
    const observation: ControlledTargetObservation = {
      sequence: this.observations.length + 1,
      scenario: request.scenario,
      method: request.method.toUpperCase(),
      path: request.path,
      bodyBytes: body.byteLength,
      bodySha256: createHash("sha256").update(body).digest("hex"),
      contentType,
      host: normalizeSingleHeader(request.headers.host),
      hasDate: hasNonEmptyHeader(request.headers, "date"),
      hasDigest: hasNonEmptyHeader(request.headers, "digest"),
      hasSignature: hasNonEmptyHeader(request.headers, "signature"),
      receivedAtMs: request.nowMs ?? Date.now(),
    };

    this.observations.push(observation);
    this.counts[request.scenario] += 1;

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
      this.counts.transient <= this.transientFailuresBeforeSuccess
    ) {
      return {
        statusCode: 503,
        headers: { "retry-after": "0" },
        body: JSON.stringify({
          error: "controlled_transient_failure",
          attempt: this.counts.transient,
        }),
      };
    }

    return {
      statusCode: 202,
      body: JSON.stringify({ accepted: true, scenario: request.scenario }),
    };
  }
}

export function isAdspControlledRemoteScenario(
  value: string,
): value is AdspControlledRemoteScenario {
  return (ADSP_CONTROLLED_REMOTE_SCENARIOS as readonly string[]).includes(value);
}
