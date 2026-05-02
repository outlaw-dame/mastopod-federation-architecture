import { EntrywayError } from "./errors.js";
import {
  isRetryableHttpStatus,
  isRetryableTransportError,
  type RetryPolicy,
  withEntrywayRetry,
} from "./retry.js";
import type {
  AccountRoute,
  EntrywayAppBootstrapSnapshot,
  EntrywayProviderDefinition,
  EntrywaySessionHandoff,
} from "./types.js";

type FetchLike = typeof fetch;

export interface AppBootstrapInput {
  provider: EntrywayProviderDefinition;
  route: AccountRoute;
}

export interface AppBootstrapResult {
  snapshot: EntrywayAppBootstrapSnapshot;
  sessionHandoff?: EntrywaySessionHandoff;
}

export interface EntrywayAppBootstrapper {
  bootstrap(input: AppBootstrapInput): Promise<AppBootstrapResult>;
}

export interface ActivityPodsAppBootstrapClientOptions {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
  userAgent?: string;
}

export class ActivityPodsAppBootstrapClient implements EntrywayAppBootstrapper {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly userAgent: string;

  public constructor(options: ActivityPodsAppBootstrapClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = clampInteger(options.timeoutMs ?? 10_000, 1_000, 60_000);
    this.retryPolicy = options.retryPolicy ?? {
      maxAttempts: 4,
      baseDelayMs: 150,
      maxDelayMs: 3_000,
    };
    this.userAgent = options.userAgent ?? "ActivityPods-Entryway/1.0";
  }

  public async bootstrap(input: AppBootstrapInput): Promise<AppBootstrapResult> {
    const { provider, route } = input;
    if (!provider.appBootstrapPath) {
      throw new EntrywayError("app_bootstrap_not_configured", "Provider app bootstrap path is not configured", {
        statusCode: 500,
        retryable: false,
      });
    }
    if (!route.canonicalAccountId || !route.webId || !route.actorId || !route.podStorageUrl) {
      throw new EntrywayError("app_bootstrap_account_incomplete", "Account route is incomplete for app bootstrap", {
        statusCode: 500,
        retryable: false,
      });
    }

    const response = await this.requestJson(new URL(provider.appBootstrapPath, provider.baseUrl).toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: formatBearer(provider.provisioningBearerToken),
        "user-agent": this.userAgent,
        ...(provider.origin ? { origin: provider.origin } : {}),
      },
      body: JSON.stringify({
        accountId: route.accountId,
        canonicalAccountId: route.canonicalAccountId,
        username: route.username,
        webId: route.webId,
        actorId: route.actorId,
        podStorageUrl: route.podStorageUrl,
        providerId: provider.providerId,
        appClientId: provider.appClientId,
        redirectUri: provider.redirectUri,
        atprotoDid: route.atprotoDid,
        atprotoHandle: route.atprotoHandle,
      }),
    });

    return parseBootstrapResponse(provider, response);
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
              throw new EntrywayError("app_bootstrap_invalid_response", "Provider app bootstrap response is invalid", {
                statusCode: 502,
                retryable: false,
              });
            }
            return body as Record<string, unknown>;
          }

          const parsed = await parseErrorResponse(response);
          throw new EntrywayError(
            parsed.error ?? "app_bootstrap_failed",
            parsed.message ?? `Provider app bootstrap failed with HTTP ${response.status}`,
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

          throw new EntrywayError("app_bootstrap_transport_error", "Provider app bootstrap request failed", {
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

function parseBootstrapResponse(
  provider: EntrywayProviderDefinition,
  response: Record<string, unknown>,
): AppBootstrapResult {
  const appRegistrationUri = readOptionalString(response["appRegistrationUri"]);
  const accessGrantUris = Array.isArray(response["accessGrantUris"])
    ? response["accessGrantUris"].filter((value): value is string => typeof value === "string" && !!value.trim())
    : [];

  const snapshot: EntrywayAppBootstrapSnapshot = {
    status: "ready",
    appClientId: provider.appClientId,
    appRegistrationUri,
    accessGrantUris,
    bootstrappedAt: readOptionalString(response["bootstrappedAt"]) ?? new Date().toISOString(),
  };

  const sessionHandoff = parseSessionHandoff(response["sessionHandoff"]);
  return sessionHandoff ? { snapshot, sessionHandoff } : { snapshot };
}

function parseSessionHandoff(value: unknown): EntrywaySessionHandoff | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const type = record["type"] === "redirect" ? "redirect" : record["type"] === "handoff" ? "handoff" : undefined;
  if (!type) {
    return undefined;
  }

  const handoff: EntrywaySessionHandoff = { type };
  if (typeof record["url"] === "string" && record["url"].trim()) {
    handoff.url = record["url"].trim();
  }
  if (typeof record["handoffId"] === "string" && record["handoffId"].trim()) {
    handoff.handoffId = record["handoffId"].trim();
  }
  if (typeof record["expiresAt"] === "string" && record["expiresAt"].trim()) {
    handoff.expiresAt = record["expiresAt"].trim();
  }
  return handoff;
}

async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new EntrywayError("app_bootstrap_invalid_response", "Provider app bootstrap returned malformed JSON", {
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

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatBearer(token: string): string {
  return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
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
    if (/password|token|authorization|accessJwt|refreshJwt|session/i.test(key)) {
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
