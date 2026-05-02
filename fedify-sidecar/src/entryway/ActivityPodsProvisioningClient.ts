import { EntrywayError } from "./errors.js";
import {
  isRetryableHttpStatus,
  isRetryableTransportError,
  type RetryPolicy,
  withEntrywayRetry,
} from "./retry.js";
import type {
  EntrywayAccountCreateInput,
  EntrywayProviderDefinition,
  EntrywayProtocolSet,
} from "./types.js";

type FetchLike = typeof fetch;

export interface ActivityPodsProvisioningClientOptions {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
  userAgent?: string;
}

export interface ProviderCreateAccountInput {
  provider: EntrywayProviderDefinition;
  idempotencyKey: string;
  account: EntrywayAccountCreateInput;
  protocols: EntrywayProtocolSet;
}

export class ActivityPodsProvisioningClient {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly userAgent: string;

  public constructor(options: ActivityPodsProvisioningClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = clampInteger(options.timeoutMs ?? 10_000, 1_000, 60_000);
    this.retryPolicy = options.retryPolicy ?? {
      maxAttempts: 4,
      baseDelayMs: 150,
      maxDelayMs: 3_000,
    };
    this.userAgent = options.userAgent ?? "ActivityPods-Entryway/1.0";
  }

  public async getProviderCapabilities(provider: EntrywayProviderDefinition): Promise<Record<string, unknown>> {
    return this.requestJson(
      new URL("/.well-known/provider-capabilities", provider.baseUrl).toString(),
      {
        method: "GET",
        headers: {
          accept: "application/json, application/vnd.activitypods.provider-capabilities+json",
          "user-agent": this.userAgent,
        },
      },
    );
  }

  public async createAccount(input: ProviderCreateAccountInput): Promise<Record<string, unknown>> {
    const { provider, account, idempotencyKey, protocols } = input;
    const atproto = normalizeAtprotoRequest(account.protocols?.atproto);
    const body: Record<string, unknown> = {
      appClientId: provider.appClientId,
      username: account.username,
      email: account.email,
      password: account.password,
      profile: account.profile,
      protocols: {
        solid: protocols.solid,
        activitypub: protocols.activitypub,
        atproto: {
          enabled: protocols.atproto,
          didMethod: atproto.didMethod,
          handle: atproto.handle,
        },
      },
      verification: account.verification,
      redirectUri: account.redirectUri ?? provider.redirectUri,
    };

    return this.requestJson(
      new URL("/api/accounts/create", provider.baseUrl).toString(),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: formatBearer(provider.provisioningBearerToken),
          "idempotency-key": idempotencyKey,
          "user-agent": this.userAgent,
          ...(provider.origin ? { origin: provider.origin } : {}),
        },
        body: JSON.stringify(pruneUndefined(body)),
      },
    );
  }

  private async requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    return withEntrywayRetry(
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const response = await this.fetchFn(url, {
            ...init,
            signal: controller.signal,
          });
          if (response.ok) {
            const body = await parseJsonBody(response);
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              throw new EntrywayError("provider_invalid_response", "Provider returned an invalid JSON response", {
                statusCode: 502,
                retryable: false,
              });
            }
            return body as Record<string, unknown>;
          }

          const parsed = await parseErrorResponse(response);
          throw new EntrywayError(
            parsed.error ?? "provider_request_failed",
            parsed.message ?? `Provider request failed with HTTP ${response.status}`,
            {
              statusCode: response.status >= 500 ? 502 : response.status,
              retryable: isRetryableHttpStatus(response.status),
              details: parsed.sanitizedBody ? { providerStatus: response.status, body: parsed.sanitizedBody } : {
                providerStatus: response.status,
              },
            },
          );
        } catch (error) {
          if (error instanceof EntrywayError) {
            throw error;
          }

          throw new EntrywayError("provider_transport_error", "Provider request failed", {
            statusCode: 502,
            retryable: isRetryableTransportError(error),
            cause: error,
          });
        } finally {
          clearTimeout(timeout);
        }
      },
      this.retryPolicy,
      (error) => error instanceof EntrywayError ? error.retryable : isRetryableTransportError(error),
    );
  }
}

async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new EntrywayError("provider_invalid_response", "Provider returned malformed JSON", {
      statusCode: 502,
      retryable: false,
      cause: error,
    });
  }
}

async function parseErrorResponse(response: Response): Promise<{
  error?: string;
  message?: string;
  sanitizedBody?: string;
}> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!text) {
    return {};
  }

  if (contentType.includes("json")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return {
        error: typeof parsed["error"] === "string" ? parsed["error"] : undefined,
        message: typeof parsed["message"] === "string" ? parsed["message"] : undefined,
        sanitizedBody: JSON.stringify(redactSensitive(parsed)).slice(0, 512),
      };
    } catch {
      return { sanitizedBody: text.slice(0, 512) };
    }
  }

  return { sanitizedBody: text.slice(0, 512) };
}

function normalizeAtprotoRequest(value: unknown): { didMethod?: string; handle?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    didMethod: typeof record["didMethod"] === "string" ? record["didMethod"] : undefined,
    handle: typeof record["handle"] === "string" ? record["handle"] : undefined,
  };
}

function formatBearer(token: string): string {
  return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}

function pruneUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      result[key] = entry;
    }
  }
  return result;
}

function redactSensitive(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/password|token|authorization|accessJwt|refreshJwt/i.test(key)) {
      redacted[key] = "[redacted]";
      continue;
    }
    redacted[key] = redactSensitive(entry);
  }
  return redacted;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
