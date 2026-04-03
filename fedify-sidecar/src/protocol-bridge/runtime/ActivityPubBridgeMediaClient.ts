import { Buffer } from "node:buffer";
import { request } from "undici";
import { z } from "zod";
import { sanitizeJsonObject } from "../../utils/safe-json.js";
import { ProtocolBridgeAdapterError } from "../adapters/ProtocolBridgeAdapterError.js";
import { DefaultRetryClassifier, withRetry } from "../workers/Retry.js";

const localhostHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

const responseSchema = z.object({
  mediaUrl: z.string().url(),
  mimeType: z.string().min(1),
  bytesBase64: z.string().min(1),
  size: z.number().int().positive(),
  resolvedAt: z.string().optional(),
});

export interface ActivityPubBridgeMediaClientConfig {
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

export interface ResolvedBridgeMedia {
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

export class ActivityPubBridgeMediaClient {
  private readonly endpointUrl: string;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly maxMediaBytes: number;
  private readonly retryPolicy: NonNullable<ActivityPubBridgeMediaClientConfig["retryPolicy"]>;
  private readonly retryClassifier = new DefaultRetryClassifier();

  public constructor(
    private readonly config: ActivityPubBridgeMediaClientConfig,
    private readonly requestFn: RequestFn = request as unknown as RequestFn,
  ) {
    if (!config.bearerToken.trim()) {
      throw new ProtocolBridgeAdapterError(
        "AP_BRIDGE_MEDIA_TOKEN_MISSING",
        "ActivityPub bridge media resolution requires a non-empty bearer token.",
      );
    }

    this.endpointUrl = buildEndpointUrl(
      config.activityPodsBaseUrl,
      config.endpointPath ?? "/api/internal/activitypub-bridge/resolve-media",
    );
    this.timeoutMs = config.timeoutMs ?? 20_000;
    this.maxPayloadBytes = config.maxPayloadBytes ?? 64_000;
    this.maxMediaBytes = config.maxMediaBytes ?? 50 * 1024 * 1024;
    this.retryPolicy = config.retryPolicy ?? {
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 4_000,
      jitter: "full",
    };
  }

  public async resolve(mediaUrl: string): Promise<ResolvedBridgeMedia | null> {
    const normalizedUrl = normalizeResourceUrl(
      mediaUrl,
      "AP_BRIDGE_MEDIA_URL_INVALID",
      "ActivityPub media resolution requires a valid https URL or localhost http URL.",
    );

    const payload = sanitizeJsonObject(
      {
        mediaUrl: normalizedUrl,
        maxBytes: this.maxMediaBytes,
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
        if ([400, 404, 415, 422].includes(response.statusCode)) {
          return null;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const transient = response.statusCode === 429 || response.statusCode >= 500;
          throw new ProtocolBridgeAdapterError(
            transient ? "AP_BRIDGE_MEDIA_TRANSIENT" : "AP_BRIDGE_MEDIA_REJECTED",
            `ActivityPub bridge media resolution failed: ${truncateMessage(bodyText || `HTTP ${response.statusCode}`, 256)}`,
            response.statusCode,
            transient,
          );
        }

        const parsedJson = parseJson(bodyText);
        const parsed = responseSchema.safeParse(parsedJson);
        if (!parsed.success || parsed.data.mediaUrl !== normalizedUrl) {
          throw new ProtocolBridgeAdapterError(
            "AP_BRIDGE_MEDIA_INVALID",
            "ActivityPub bridge media resolution returned an invalid response payload.",
            502,
            false,
          );
        }

        const bytes = decodeBase64(parsed.data.bytesBase64);
        if (bytes.byteLength === 0 || bytes.byteLength !== parsed.data.size || bytes.byteLength > this.maxMediaBytes) {
          throw new ProtocolBridgeAdapterError(
            "AP_BRIDGE_MEDIA_INVALID",
            "ActivityPub bridge media resolution returned an invalid media payload size.",
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
  }
}

function buildEndpointUrl(baseUrl: string, endpointPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_MEDIA_BASE_URL_INVALID",
      `ActivityPods base URL is invalid: ${baseUrl}`,
    );
  }

  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && localhostHostnames.has(parsed.hostname))
  ) {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_MEDIA_BASE_URL_INSECURE",
      "ActivityPub bridge media resolution requires https unless the destination is localhost.",
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

  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && localhostHostnames.has(parsed.hostname))
  ) {
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
      "AP_BRIDGE_MEDIA_INVALID",
      "ActivityPub bridge media resolution returned invalid JSON.",
      502,
      false,
    );
  }
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_MEDIA_INVALID",
      "ActivityPub bridge media resolution returned invalid base64 media.",
      502,
      false,
    );
  }

  return Uint8Array.from(Buffer.from(value, "base64"));
}

function truncateMessage(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(limit - 1, 0))}…`;
}
