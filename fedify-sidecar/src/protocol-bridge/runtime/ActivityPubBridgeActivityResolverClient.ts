import { request } from "undici";
import { z } from "zod";
import { isSecureOrTrustedInternalUrl } from "../../utils/internalAuthority.js";
import { sanitizeJsonObject } from "../../utils/safe-json.js";
import type { ActivityObjectResolutionOptions } from "../ports/ProtocolBridgePorts.js";
import { ProtocolBridgeAdapterError } from "../adapters/ProtocolBridgeAdapterError.js";
import { DefaultRetryClassifier, withRetry } from "../workers/Retry.js";

const responseSchema = z.object({
  activityId: z.string().url(),
  activity: z.object({}).passthrough(),
  resolvedAt: z.string().optional(),
});

export interface ActivityPubBridgeActivityResolverClientConfig {
  activityPodsBaseUrl: string;
  bearerToken: string;
  endpointPath?: string;
  timeoutMs?: number;
  maxPayloadBytes?: number;
  retryPolicy?: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitter: "full";
  };
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

export class ActivityPubBridgeActivityResolverClient {
  private readonly endpointUrl: string;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly retryPolicy: NonNullable<ActivityPubBridgeActivityResolverClientConfig["retryPolicy"]>;
  private readonly retryClassifier = new DefaultRetryClassifier();

  public constructor(
    private readonly config: ActivityPubBridgeActivityResolverClientConfig,
    private readonly requestFn: RequestFn = request as unknown as RequestFn,
  ) {
    if (!config.bearerToken.trim()) {
      throw new ProtocolBridgeAdapterError(
        "AP_BRIDGE_ACTIVITY_RESOLUTION_TOKEN_MISSING",
        "ActivityPub bridge activity resolution requires a non-empty bearer token.",
      );
    }

    this.endpointUrl = buildEndpointUrl(
      config.activityPodsBaseUrl,
      config.endpointPath ?? "/api/internal/activitypub-bridge/resolve-activity",
    );
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxPayloadBytes = config.maxPayloadBytes ?? 256_000;
    this.retryPolicy = config.retryPolicy ?? {
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 4_000,
      jitter: "full",
    };
  }

  public async resolveActivityObject(
    activityId: string,
    options: ActivityObjectResolutionOptions = {},
  ): Promise<Record<string, unknown> | null> {
    const normalizedActivityId = normalizeResourceUrl(
      activityId,
      "AP_BRIDGE_ACTIVITY_ID_INVALID",
      "ActivityPub bridge activity resolution requires a valid https URL or localhost http URL.",
    );
    const expectedActorUri = options.expectedActorUri
      ? normalizeResourceUrl(
          options.expectedActorUri,
          "AP_BRIDGE_ACTIVITY_EXPECTED_ACTOR_INVALID",
          "ActivityPub bridge activity resolution expectedActorUri must be a valid https URL or localhost http URL.",
        )
      : undefined;

    const payload = sanitizeJsonObject(
      {
        activityId: normalizedActivityId,
        ...(expectedActorUri ? { expectedActorUri } : {}),
      },
      { maxBytes: this.maxPayloadBytes },
    );

    return withRetry(
      async () => {
        const response = await this.requestFn(this.endpointUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.bearerToken}`,
          },
          body: JSON.stringify(payload),
          bodyTimeout: this.timeoutMs,
          headersTimeout: this.timeoutMs,
        });

        const bodyText = await response.body.text();

        if ([400, 404, 409, 422].includes(response.statusCode)) {
          return null;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const transient = response.statusCode === 429 || response.statusCode >= 500;
          throw new ProtocolBridgeAdapterError(
            transient
              ? "AP_BRIDGE_ACTIVITY_RESOLUTION_TRANSIENT"
              : "AP_BRIDGE_ACTIVITY_RESOLUTION_REJECTED",
            `ActivityPub bridge activity resolution failed: ${truncateMessage(bodyText || `HTTP ${response.statusCode}`, 256)}`,
            response.statusCode,
            transient,
          );
        }

        const parsedJson = parseJson(bodyText);
        const parsed = responseSchema.safeParse(parsedJson);
        if (!parsed.success || parsed.data.activityId !== normalizedActivityId) {
          throw new ProtocolBridgeAdapterError(
            "AP_BRIDGE_ACTIVITY_RESOLUTION_INVALID",
            "ActivityPub bridge activity resolution returned an invalid response payload.",
            502,
            false,
          );
        }

        return sanitizeJsonObject(parsed.data.activity, { maxBytes: this.maxPayloadBytes });
      },
      this.retryPolicy,
      this.retryClassifier,
    );
  }
}

function buildEndpointUrl(baseUrl: string, endpointPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_ACTIVITY_RESOLUTION_URL_INVALID",
      `ActivityPods base URL is invalid: ${baseUrl}`,
    );
  }

  if (!isSecureOrTrustedInternalUrl(parsed)) {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_ACTIVITY_RESOLUTION_URL_INSECURE",
      "ActivityPub bridge activity resolution requires https unless the destination is a trusted internal host.",
    );
  }

  return new URL(endpointPath, parsed).toString();
}

function normalizeResourceUrl(
  value: string,
  code: string,
  message: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProtocolBridgeAdapterError(code, message);
  }

  if (!isSecureOrTrustedInternalUrl(parsed)) {
    throw new ProtocolBridgeAdapterError(code, message);
  }

  return parsed.toString();
}

function parseJson(payload: string): unknown {
  if (!payload) {
    return {};
  }

  try {
    return JSON.parse(payload);
  } catch {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_ACTIVITY_RESOLUTION_INVALID",
      "ActivityPub bridge activity resolution returned invalid JSON.",
      502,
      false,
    );
  }
}

function truncateMessage(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(limit - 1, 0))}…`;
}
