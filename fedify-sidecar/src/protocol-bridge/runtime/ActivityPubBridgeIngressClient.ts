import { request, type Dispatcher } from "undici";
import { isSecureOrTrustedInternalUrl } from "../../utils/internalAuthority.js";
import { sanitizeJsonObject } from "../../utils/safe-json.js";
import type { ActivityPubBridgeIngressEvent } from "../events/ActivityPubBridgeEvents.js";
import { ProtocolBridgeAdapterError } from "../adapters/ProtocolBridgeAdapterError.js";

export interface ActivityPubBridgeIngressClientConfig {
  activityPodsBaseUrl: string;
  bearerToken: string;
  endpointPath?: string;
  timeoutMs?: number;
  maxPayloadBytes?: number;
}

export interface ActivityPubBridgeIngressPort {
  deliver(event: ActivityPubBridgeIngressEvent): Promise<void>;
}

export interface ActivityPubBridgeIngressResponse {
  statusCode: number;
  body: {
    text(): Promise<string>;
  };
}

export type ActivityPubBridgeIngressRequestFn = (
  url: string,
  options: Record<string, unknown>,
) => Promise<ActivityPubBridgeIngressResponse>;

export class ActivityPubBridgeIngressClient implements ActivityPubBridgeIngressPort {
  private readonly endpointUrl: string;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;

  public constructor(
    private readonly config: ActivityPubBridgeIngressClientConfig,
    private readonly requestFn: ActivityPubBridgeIngressRequestFn = request as unknown as ActivityPubBridgeIngressRequestFn,
  ) {
    if (!config.bearerToken.trim()) {
      throw new ProtocolBridgeAdapterError(
        "AP_BRIDGE_INGRESS_TOKEN_MISSING",
        "ActivityPods bridge ingress requires a non-empty bearer token.",
      );
    }

    this.endpointUrl = buildEndpointUrl(
      config.activityPodsBaseUrl,
      config.endpointPath ?? "/api/internal/atproto-bridge/receive",
    );
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxPayloadBytes = config.maxPayloadBytes ?? 512_000;
  }

  public async deliver(event: ActivityPubBridgeIngressEvent): Promise<void> {
    const payload = sanitizeJsonObject(
      {
        actorUri: event.actor,
        activity: event.activity,
        bridge: event.bridge,
      },
      { maxBytes: this.maxPayloadBytes },
    );

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

    if (response.statusCode >= 200 && response.statusCode < 300) {
      await response.body.text();
      return;
    }

    const body = await response.body.text();
    const message = truncateMessage(body || `HTTP ${response.statusCode}`, 256);
    const transient = response.statusCode === 429 || response.statusCode >= 500;

    throw new ProtocolBridgeAdapterError(
      transient ? "AP_BRIDGE_INGRESS_TRANSIENT" : "AP_BRIDGE_INGRESS_REJECTED",
      `ActivityPods bridge ingress rejected the mirrored activity: ${message}`,
      response.statusCode,
      transient,
    );
  }
}

function buildEndpointUrl(baseUrl: string, endpointPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_INGRESS_URL_INVALID",
      `ActivityPods base URL is invalid: ${baseUrl}`,
    );
  }

  if (!isSecureOrTrustedInternalUrl(parsed)) {
    throw new ProtocolBridgeAdapterError(
      "AP_BRIDGE_INGRESS_URL_INSECURE",
      "ActivityPods bridge ingress requires https unless the destination is a trusted internal host.",
    );
  }

  return new URL(endpointPath, parsed).toString();
}

function truncateMessage(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(limit - 1, 0))}…`;
}
