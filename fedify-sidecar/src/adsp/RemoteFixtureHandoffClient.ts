import { isIP } from "node:net";
import { request } from "undici";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const APDM_SCHEMA = "ap.delivery-plan.v1";

type DestroyableBody = AsyncIterable<Uint8Array> & { destroy?: () => void };

export interface AdspRemoteFixtureHandoffTarget {
  inboxUrl: string;
  sharedInboxUrl?: string;
}

export interface AdspRemoteFixtureHandoffInput {
  deliveryPlanIntentId: string;
  actorUri: string;
  activityId: string;
  activity: Record<string, unknown>;
  target: AdspRemoteFixtureHandoffTarget;
  meta?: Record<string, unknown>;
}

export interface AdspRemoteFixtureHandoffAcceptance {
  accepted: true;
  intentId: string;
  jobCount: number;
}

function positiveSafeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

export function normalizeFixtureSidecarWebhookUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("sidecar webhook URL must be a valid URL");
  }
  if (parsed.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) {
    throw new TypeError("sidecar webhook URL must use explicit loopback HTTP");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new TypeError("sidecar webhook URL must not contain credentials or a fragment");
  }
  if (parsed.pathname !== "/webhook/outbox") {
    throw new TypeError("sidecar webhook URL pathname must be /webhook/outbox");
  }
  return parsed;
}

function normalizeFederationTarget(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`${label} must use HTTP(S)`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new TypeError(`${label} must not contain credentials or a fragment`);
  }
  return parsed;
}

function nonEmptyExactString(name: string, value: string): string {
  if (!value || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty exact string`);
  }
  return value;
}

export function buildAdspRemoteFixtureHandoffBody(input: AdspRemoteFixtureHandoffInput) {
  const deliveryPlanIntentId = nonEmptyExactString(
    "deliveryPlanIntentId",
    input.deliveryPlanIntentId,
  );
  const actorUri = normalizeFederationTarget(input.actorUri, "actorUri").href;
  const activityId = normalizeFederationTarget(input.activityId, "activityId").href;
  if (!input.activity || typeof input.activity !== "object" || Array.isArray(input.activity)) {
    throw new TypeError("activity must be a JSON object");
  }

  const inbox = normalizeFederationTarget(input.target.inboxUrl, "target.inboxUrl");
  const sharedInbox = input.target.sharedInboxUrl
    ? normalizeFederationTarget(input.target.sharedInboxUrl, "target.sharedInboxUrl")
    : undefined;
  const deliveryUrl = sharedInbox ?? inbox;

  return {
    actorUri,
    activityId,
    activity: input.activity,
    remoteTargets: [
      {
        inboxUrl: inbox.href,
        ...(sharedInbox ? { sharedInboxUrl: sharedInbox.href } : {}),
        targetDomain: deliveryUrl.hostname.toLowerCase(),
        apdmAuthority: {
          schema: APDM_SCHEMA,
          intentId: deliveryPlanIntentId,
        },
      },
    ],
    meta: {
      ...(input.meta ?? {}),
      deliveryPlanIntentId,
      deliveryPlanSchema: APDM_SCHEMA,
    },
  };
}

export function parseAdspRemoteFixtureHandoffAcceptance(
  value: unknown,
): AdspRemoteFixtureHandoffAcceptance {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("sidecar durable acknowledgement must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record["accepted"] !== true) {
    throw new TypeError("sidecar durable acknowledgement must set accepted=true");
  }
  const intentId = record["intentId"];
  if (typeof intentId !== "string" || !intentId || intentId !== intentId.trim()) {
    throw new TypeError("sidecar durable acknowledgement must contain an exact intentId");
  }
  const jobCount = record["jobCount"];
  if (!Number.isSafeInteger(jobCount) || Number(jobCount) < 0) {
    throw new TypeError("sidecar durable acknowledgement jobCount must be a non-negative safe integer");
  }
  return { accepted: true, intentId, jobCount: Number(jobCount) };
}

async function readBoundedJson(body: DestroyableBody, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      body.destroy?.();
      throw new Error(`sidecar durable acknowledgement exceeded ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
}

export class AdspRemoteFixtureHandoffClient {
  private readonly url: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    webhookUrl: string,
    token: string,
    options: { timeoutMs?: number; maxResponseBytes?: number } = {},
  ) {
    this.url = normalizeFixtureSidecarWebhookUrl(webhookUrl);
    this.token = nonEmptyExactString("sidecar token", token);
    this.timeoutMs = positiveSafeInteger("timeoutMs", options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxResponseBytes = positiveSafeInteger(
      "maxResponseBytes",
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
  }

  async enqueue(input: AdspRemoteFixtureHandoffInput): Promise<AdspRemoteFixtureHandoffAcceptance> {
    const body = buildAdspRemoteFixtureHandoffBody(input);
    const response = await request(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-apdm-intent-id": input.deliveryPlanIntentId,
      },
      body: JSON.stringify(body),
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
      maxRedirections: 0,
    });

    if (response.statusCode !== 202) {
      response.body.destroy();
      throw new Error(`sidecar handoff expected durable HTTP 202, received ${response.statusCode}`);
    }
    const acknowledgement = parseAdspRemoteFixtureHandoffAcceptance(
      await readBoundedJson(response.body, this.maxResponseBytes),
    );
    if (acknowledgement.intentId !== input.deliveryPlanIntentId) {
      throw new Error(
        `sidecar acknowledgement intentId ${acknowledgement.intentId} does not match authoritative Delivery Plan ${input.deliveryPlanIntentId}`,
      );
    }
    if (acknowledgement.jobCount !== 1) {
      throw new Error(
        `isolated ADSP fixture expected durable acceptance for exactly one job, received ${acknowledgement.jobCount}`,
      );
    }
    return acknowledgement;
  }
}
