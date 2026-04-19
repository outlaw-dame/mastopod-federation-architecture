import { request } from "undici";
import { sanitizeJsonObject } from "../utils/safe-json.js";
import { DefaultRetryClassifier, withRetry } from "../protocol-bridge/workers/Retry.js";
import type { RetryPolicy } from "../protocol-bridge/ports/ProtocolBridgePorts.js";
import {
  FepAuthorizeTopicsResponseSchema,
  FepResolvePrincipalResponseSchema,
  type FepAuthorizeTopicsResponse,
  type FepResolvePrincipalResponse,
  type FepSubscriptionTopic,
} from "./contracts.js";

export interface Fep3ab2ActivityPodsClientConfig {
  activityPodsBaseUrl: string;
  bearerToken: string;
  timeoutMs?: number;
  maxPayloadBytes?: number;
  resolvePrincipalPath?: string;
  authorizeTopicsPath?: string;
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
}

export interface ForwardedAuthContext {
  authorization?: string;
  cookie?: string;
  origin?: string;
  userAgent?: string;
  xForwardedFor?: string;
}

interface JsonResponse {
  statusCode: number;
  body: {
    text(): Promise<string>;
  };
}

type RequestFn = (
  url: string,
  options: Record<string, unknown>,
) => Promise<JsonResponse>;

export class FepAuthorityClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "FepAuthorityClientError";
  }
}

export class Fep3ab2ActivityPodsClient {
  private readonly resolvePrincipalUrl: string;
  private readonly authorizeTopicsUrl: string;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly requestFn: RequestFn;
  private readonly retryClassifier = new DefaultRetryClassifier();
  private readonly retryPolicy: RetryPolicy;

  public constructor(
    private readonly config: Fep3ab2ActivityPodsClientConfig,
    requestFn: RequestFn = request as unknown as RequestFn,
  ) {
    if (!config.bearerToken.trim()) {
      throw new Error("Fep3ab2ActivityPodsClient requires a non-empty bearer token");
    }

    this.resolvePrincipalUrl = buildEndpointUrl(
      config.activityPodsBaseUrl,
      config.resolvePrincipalPath ?? "/api/internal/streaming/resolve-principal",
    );
    this.authorizeTopicsUrl = buildEndpointUrl(
      config.activityPodsBaseUrl,
      config.authorizeTopicsPath ?? "/api/internal/streaming/authorize-topics",
    );
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxPayloadBytes = config.maxPayloadBytes ?? 32_768;
    this.requestFn = requestFn;
    this.retryPolicy = {
      maxAttempts: Math.max(1, config.retry?.maxAttempts ?? 3),
      baseDelayMs: Math.max(50, config.retry?.baseDelayMs ?? 150),
      maxDelayMs: Math.max(250, config.retry?.maxDelayMs ?? 2_000),
      jitter: "full",
    };
  }

  public async resolvePrincipal(context: ForwardedAuthContext): Promise<FepResolvePrincipalResponse> {
    return withRetry(
      async () => {
        const response = await this.postJson(this.resolvePrincipalUrl, sanitizeJsonObject(
          {
            authorization: sanitizeHeader(context.authorization),
            cookie: sanitizeCookieHeader(context.cookie),
            origin: sanitizeHeader(context.origin),
            userAgent: sanitizeHeader(context.userAgent),
            xForwardedFor: sanitizeHeader(context.xForwardedFor),
          },
          { maxBytes: this.maxPayloadBytes },
        ));

        if (response.statusCode === 401) {
          throw new FepAuthorityClientError(
            "ActivityPods rejected the streaming principal lookup",
            "login_required",
            401,
          );
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const body = await response.body.text();
          throw new FepAuthorityClientError(
            truncateMessage(body || `HTTP ${response.statusCode}`, 256),
            "principal_lookup_failed",
            response.statusCode,
            response.statusCode >= 500 || response.statusCode === 429,
          );
        }

        const text = await response.body.text();
        return FepResolvePrincipalResponseSchema.parse(JSON.parse(text));
      },
      this.retryPolicy,
      this.retryClassifier,
    );
  }

  public async authorizeTopics(
    principal: string,
    topics: readonly FepSubscriptionTopic[],
  ): Promise<FepAuthorizeTopicsResponse> {
    return withRetry(
      async () => {
        const response = await this.postJson(this.authorizeTopicsUrl, sanitizeJsonObject(
          {
            principal,
            topics,
          },
          { maxBytes: this.maxPayloadBytes },
        ));

        if (response.statusCode === 401) {
          throw new FepAuthorityClientError(
            "ActivityPods rejected the streaming topic authorization request",
            "login_required",
            401,
          );
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const body = await response.body.text();
          throw new FepAuthorityClientError(
            truncateMessage(body || `HTTP ${response.statusCode}`, 256),
            "topic_authorization_failed",
            response.statusCode,
            response.statusCode >= 500 || response.statusCode === 429,
          );
        }

        const text = await response.body.text();
        return FepAuthorizeTopicsResponseSchema.parse(JSON.parse(text));
      },
      this.retryPolicy,
      this.retryClassifier,
    );
  }

  private async postJson(url: string, payload: Record<string, unknown>): Promise<JsonResponse> {
    return this.requestFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });
  }
}

function buildEndpointUrl(baseUrl: string, endpointPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid ActivityPods URL: ${baseUrl}`);
  }

  const localhostHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const isLocalhost = localhostHosts.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    throw new Error("ActivityPods internal streaming authority must use https unless the destination is localhost");
  }

  return new URL(endpointPath, parsed).toString();
}

function sanitizeHeader(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 8_192) {
    return undefined;
  }
  return normalized;
}

function sanitizeCookieHeader(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 16_384) {
    return undefined;
  }
  return normalized;
}

function truncateMessage(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}
