import { request } from "undici";
import { z } from "zod";
import { isSecureOrTrustedInternalUrl } from "../../utils/internalAuthority.js";
import { sanitizeJsonObject } from "../../utils/safe-json.js";
import type { ActivityPubProjectionCommand } from "../ports/ProtocolBridgePorts.js";
import type { ActivityPubBridgeOutboundDelivery } from "../events/ActivityPubBridgeEvents.js";
import { ProtocolBridgeAdapterError } from "../adapters/ProtocolBridgeAdapterError.js";
import { DefaultRetryClassifier, withRetry } from "../workers/Retry.js";

const responseSchema = z.object({
  actorUri: z.string().url(),
  deliveries: z.array(
    z.object({
      actor: z.string().url(),
      targetDomain: z.string().min(1),
      recipients: z.array(z.string().url()).min(1).max(500),
      sharedInbox: z.string().url().optional(),
      jobId: z.string().min(1).optional(),
    }),
  ).max(500),
  resolvedAt: z.string().optional(),
});

export interface ActivityPubBridgeOutboundResolverClientConfig {
  activityPodsBaseUrl: string;
  bearerToken: string;
  endpointPath?: string;
  timeoutMs?: number;
  maxPayloadBytes?: number;
  maxDeliveries?: number;
  retryPolicy?: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitter: "full";
  };
}

export interface ActivityPubBridgeOutboundResolverResponse {
  actorUri: string;
  deliveries: ActivityPubBridgeOutboundDelivery[];
  resolvedAt?: string;
}

type RequestFn = (
  url: string,
  options: Record<string, unknown>,
) => Promise<{
  statusCode: number;
  body: {
    text(): Promise<string>;
  };
}>;

export class ActivityPubBridgeOutboundResolverClient {
  private readonly endpointUrl: string;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly maxDeliveries: number;
  private readonly retryPolicy: NonNullable<ActivityPubBridgeOutboundResolverClientConfig["retryPolicy"]>;
  private readonly retryClassifier = new DefaultRetryClassifier();

  public constructor(
    private readonly config: ActivityPubBridgeOutboundResolverClientConfig,
    private readonly requestFn: RequestFn = request as unknown as RequestFn,
  ) {
    if (!config.bearerToken.trim()) {
      throw new ProtocolBridgeAdapterError(
        "AP_BRIDGE_OUTBOUND_TOKEN_MISSING",
        "ActivityPub bridge outbound resolution requires a non-empty bearer token.",
      );
    }

    this.endpointUrl = buildEndpointUrl(
      config.activityPodsBaseUrl,
      config.endpointPath ?? "/api/internal/activitypub-bridge/resolve-outbound",
    );
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxPayloadBytes = config.maxPayloadBytes ?? 512_000;
    this.maxDeliveries = config.maxDeliveries ?? 500;
    this.retryPolicy = config.retryPolicy ?? {
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 4_000,
      jitter: "full",
    };
  }

  public async resolve(
    _command: ActivityPubProjectionCommand,
    activity: Record<string, unknown>,
  ): Promise<ActivityPubBridgeOutboundDelivery[]> {
    const actorUri = extractActor(activity);
    const payload = sanitizeJsonObject(
      {
        actorUri,
        activity,
      },
      { maxBytes: this.maxPayloadBytes },
    );

    const response = await withRetry(
      async () => {
        const res = await this.requestFn(this.endpointUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.bearerToken}`,
          },
          body: JSON.stringify(payload),
          bodyTimeout: this.timeoutMs,
          headersTimeout: this.timeoutMs,
        });

        const bodyText = await res.body.text();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const transient = res.statusCode === 429 || res.statusCode >= 500;
          throw new ProtocolBridgeAdapterError(
            transient ? "AP_BRIDGE_OUTBOUND_RESOLUTION_TRANSIENT" : "AP_BRIDGE_OUTBOUND_RESOLUTION_REJECTED",
            `ActivityPub bridge outbound resolution failed: ${truncateMessage(bodyText || `HTTP ${res.statusCode}`, 256)}`,
            res.statusCode,
            transient,
          );
        }

        const parsedJson = parseJson(bodyText);
        const parsed = responseSchema.safeParse(parsedJson);
        if (!parsed.success) {
          throw new ProtocolBridgeAdapterError(
            "AP_BRIDGE_OUTBOUND_RESOLUTION_INVALID",
            "ActivityPub bridge outbound resolution returned an invalid response payload.",
            502,
            false,
          );
        }

        return parsed.data;
      },
      this.retryPolicy,
      this.retryClassifier,
    );

    if (response.deliveries.length > this.maxDeliveries) {
      throw new ProtocolBridgeAdapterError(
        "AP_BRIDGE_OUTBOUND_RESOLUTION_TOO_LARGE",
        `ActivityPub bridge outbound resolution exceeded ${this.maxDeliveries} deliveries.`,
      );
    }

    return response.deliveries;
  }
}

function buildEndpointUrl(baseUrl: string, endpointPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_OUTBOUND_URL_INVALID",
      `ActivityPods base URL is invalid: ${baseUrl}`,
    );
  }

  if (!isSecureOrTrustedInternalUrl(parsed)) {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_OUTBOUND_URL_INSECURE",
      "ActivityPub bridge outbound resolution requires https unless the destination is a trusted internal host.",
    );
  }

  return new URL(endpointPath, parsed).toString();
}

function extractActor(activity: Record<string, unknown>): string {
  const actorValue = activity["actor"];
  if (typeof actorValue === "string" && actorValue.trim().length > 0) {
    return actorValue;
  }
  if (actorValue && typeof actorValue === "object" && !Array.isArray(actorValue)) {
    const nestedId = (actorValue as Record<string, unknown>)["id"];
    if (typeof nestedId === "string" && nestedId.trim().length > 0) {
      return nestedId;
    }
  }

  throw new ProtocolBridgeAdapterError(
    "AP_BRIDGE_OUTBOUND_ACTOR_MISSING",
    "Projected ActivityPub activity is missing a string actor identifier.",
  );
}

function parseJson(payload: string): unknown {
  if (!payload) {
    return {};
  }

  try {
    return JSON.parse(payload);
  } catch {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_OUTBOUND_RESOLUTION_INVALID",
      "ActivityPub bridge outbound resolution returned invalid JSON.",
      502,
      false,
    );
  }
}

function truncateMessage(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(limit - 1, 0))}…`;
}
