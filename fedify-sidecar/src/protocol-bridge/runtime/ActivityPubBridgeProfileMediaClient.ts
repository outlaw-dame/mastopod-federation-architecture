import { Buffer } from "node:buffer";
import { request } from "undici";
import { z } from "zod";
import { isSecureOrTrustedInternalUrl } from "../../utils/internalAuthority.js";
import { sanitizeJsonObject } from "../../utils/safe-json.js";
import { ProtocolBridgeAdapterError } from "../adapters/ProtocolBridgeAdapterError.js";
import { DefaultRetryClassifier, withRetry } from "../workers/Retry.js";

const responseSchema = z.object({
  mediaUrl: z.string().url(),
  mimeType: z.string().min(1),
  bytesBase64: z.string().min(1),
  size: z.number().int().positive(),
  resolvedAt: z.string().optional(),
});

export interface ActivityPubBridgeProfileMediaClientConfig {
  activityPodsBaseUrl: string;
  bearerToken: string;
  endpointPath?: string;
  timeoutMs?: number;
  maxPayloadBytes?: number;
  maxMediaBytes?: number;
  retryPolicy?: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitter: "full";
  };
}

export interface ResolvedProfileMedia {
  mediaUrl: string;
  mimeType: string;
  bytes: Uint8Array;
  size: number;
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

export class ActivityPubBridgeProfileMediaClient {
  private readonly endpointUrl: string;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly maxMediaBytes: number;
  private readonly retryPolicy: NonNullable<ActivityPubBridgeProfileMediaClientConfig["retryPolicy"]>;
  private readonly retryClassifier = new DefaultRetryClassifier();

  public constructor(
    private readonly config: ActivityPubBridgeProfileMediaClientConfig,
    private readonly requestFn: RequestFn = request as unknown as RequestFn,
  ) {
    if (!config.bearerToken.trim()) {
      throw new ProtocolBridgeAdapterError(
        "AP_BRIDGE_PROFILE_MEDIA_TOKEN_MISSING",
        "ActivityPub bridge profile media resolution requires a non-empty bearer token.",
      );
    }

    this.endpointUrl = buildEndpointUrl(
      config.activityPodsBaseUrl,
      config.endpointPath ?? "/api/internal/activitypub-bridge/resolve-profile-media",
    );
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxPayloadBytes = config.maxPayloadBytes ?? 64_000;
    this.maxMediaBytes = config.maxMediaBytes ?? 5 * 1024 * 1024;
    this.retryPolicy = config.retryPolicy ?? {
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 4_000,
      jitter: "full",
    };
  }

  public async resolve(mediaUrl: string): Promise<ResolvedProfileMedia | null> {
    const normalizedUrl = normalizeResourceUrl(
      mediaUrl,
      "AP_BRIDGE_PROFILE_MEDIA_URL_INVALID",
      "ActivityPub profile media resolution requires a valid https URL or localhost http URL.",
    );

    const payload = sanitizeJsonObject(
      {
        mediaUrl: normalizedUrl,
        maxBytes: this.maxMediaBytes,
      },
      { maxBytes: this.maxPayloadBytes },
    );

    const resolved = await withRetry(
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

        if ([400, 404, 415, 422].includes(response.statusCode)) {
          return null;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const transient = response.statusCode === 429 || response.statusCode >= 500;
          throw new ProtocolBridgeAdapterError(
            transient
              ? "AP_BRIDGE_PROFILE_MEDIA_TRANSIENT"
              : "AP_BRIDGE_PROFILE_MEDIA_REJECTED",
            `ActivityPub bridge profile media resolution failed: ${truncateMessage(bodyText || `HTTP ${response.statusCode}`, 256)}`,
            response.statusCode,
            transient,
          );
        }

        const parsedJson = parseJson(bodyText);
        const parsed = responseSchema.safeParse(parsedJson);
        if (!parsed.success || parsed.data.mediaUrl !== normalizedUrl) {
          throw new ProtocolBridgeAdapterError(
            "AP_BRIDGE_PROFILE_MEDIA_INVALID",
            "ActivityPub bridge profile media resolution returned an invalid response payload.",
            502,
            false,
          );
        }

        const bytes = decodeBase64(parsed.data.bytesBase64);
        if (bytes.byteLength === 0 || bytes.byteLength !== parsed.data.size || bytes.byteLength > this.maxMediaBytes) {
          throw new ProtocolBridgeAdapterError(
            "AP_BRIDGE_PROFILE_MEDIA_INVALID",
            "ActivityPub bridge profile media resolution returned an invalid media payload size.",
            502,
            false,
          );
        }

        return {
          mediaUrl: parsed.data.mediaUrl,
          mimeType: parsed.data.mimeType,
          size: parsed.data.size,
          bytes,
        };
      },
      this.retryPolicy,
      this.retryClassifier,
    );

    return resolved;
  }
}

function buildEndpointUrl(baseUrl: string, endpointPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_PROFILE_MEDIA_BASE_URL_INVALID",
      `ActivityPods base URL is invalid: ${baseUrl}`,
    );
  }

  if (!isSecureOrTrustedInternalUrl(parsed)) {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_PROFILE_MEDIA_BASE_URL_INSECURE",
      "ActivityPub bridge profile media resolution requires https unless the destination is a trusted internal host.",
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
      "AP_BRIDGE_PROFILE_MEDIA_INVALID",
      "ActivityPub bridge profile media resolution returned invalid JSON.",
      502,
      false,
    );
  }
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_PROFILE_MEDIA_INVALID",
      "ActivityPub bridge profile media resolution returned invalid base64 media.",
      502,
      false,
    );
  }

  return Uint8Array.from(Buffer.from(value, "base64"));
}

function truncateMessage(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(limit - 1, 0))}…`;
}
