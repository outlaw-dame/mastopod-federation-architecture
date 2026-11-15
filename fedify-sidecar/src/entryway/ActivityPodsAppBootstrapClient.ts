import { EntrywayError } from "./errors.js";
import { readBoundedJson } from "./readBoundedJson.js";
import { buildProviderIdempotencyKey } from "./providerIdempotency.js";
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
        idempotencyKey: buildProviderIdempotencyKey(route),
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

    return parseBootstrapResponse(provider, route, response);
  }

  private async requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    return withEntrywayRetry(
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const response = await this.fetchFn(url, {
            ...init,
            redirect: "manual",
            signal: controller.signal,
          });
          if (response.ok) {
            const body = await readBoundedJson(response, {
              errorCode: "app_bootstrap_invalid_response",
              invalidMessage: "Provider app bootstrap returned invalid JSON or exceeded the response limit",
            });
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              throw new EntrywayError("app_bootstrap_invalid_response", "Provider app bootstrap response is invalid", {
                statusCode: 502,
                retryable: false,
              });
            }
            return body as Record<string, unknown>;
          }

          // A provider HTTP 428 means the user must authorize the app via
          // native Solid SAI. No upstream response bytes or redirect locations
          // are trusted. Keep a stable protocol signal for safe resume.
          if (response.status === 428) {
            throw new EntrywayError("app_consent_required", "Pod owner authorization is required", {
              statusCode: 428,
              retryable: false,
              details: { providerStatus: 428 },
            });
          }

          // Provider error bodies are untrusted and may contain credentials or
          // verification artifacts. Do not persist or relay any of their bytes.
          throw new EntrywayError(
            "app_bootstrap_failed",
            `Provider app bootstrap failed with HTTP ${response.status}`,
            {
              statusCode: response.status >= 400 && response.status < 500 ? response.status : 502,
              retryable: isRetryableHttpStatus(response.status),
              details: { providerStatus: response.status },
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
  route: AccountRoute,
  response: Record<string, unknown>,
): AppBootstrapResult {
  // HTTP 200 is not proof of a Pod owner grant. The provider must return
  // the actual SAI registration and a complete, bounded set of current
  // grant URIs scoped to the new account's *own* Pod storage.
  const appRegistrationUri = requirePodResourceUri(
    response["appRegistrationUri"], route.podStorageUrl,
  );
  const rawGrants = response["accessGrantUris"];
  if (!Array.isArray(rawGrants) || rawGrants.length > 128) {
    throw new EntrywayError("app_bootstrap_invalid_response", "Provider SAI grant evidence is incomplete", {
      statusCode: 502, retryable: false,
    });
  }
  const accessGrantUris = rawGrants.map(value =>
    requirePodResourceUri(value, route.podStorageUrl));
  if (new Set(accessGrantUris).size !== accessGrantUris.length) {
    throw new EntrywayError("app_bootstrap_invalid_response", "Provider SAI grant evidence is inconsistent", {
      statusCode: 502, retryable: false,
    });
  }

  const snapshot: EntrywayAppBootstrapSnapshot = {
    status: "ready",
    appClientId: provider.appClientId,
    appRegistrationUri,
    accessGrantUris,
    bootstrappedAt: readOptionalString(response["bootstrappedAt"]) ?? new Date().toISOString(),
  };

  // A provider-supplied URL or handoff ID is not an authenticated Solid-OIDC
  // session. Do not relay even apparently valid 2xx handoff metadata until
  // its issuer, signature, audience, expiry and redirect binding are verified.
  return { snapshot };
}

function requirePodResourceUri(value: unknown, podStorageUrl: string): string {
  const invalid = () => new EntrywayError(
    "app_bootstrap_invalid_response",
    "Provider SAI resource evidence is not scoped to the Pod owner",
    { statusCode: 502, retryable: false },
  );
  if (typeof value !== "string" || value.length > 2048 ||
      typeof podStorageUrl !== "string" || podStorageUrl.length > 2048) {
    throw invalid();
  }
  try {
    const root = new URL(podStorageUrl);
    const uri = new URL(value);
    const pathPrefix = root.pathname.endsWith("/") ? root.pathname : root.pathname + "/";
    if ((root.protocol !== "https:" && root.protocol !== "http:") ||
        (uri.protocol !== "https:" && uri.protocol !== "http:") ||
        !root.hostname || !uri.hostname ||
        root.username || root.password || root.search || root.hash ||
        uri.username || uri.password || uri.search || uri.hash ||
        uri.origin !== root.origin ||
        !uri.pathname.startsWith(pathPrefix) ||
        root.href !== podStorageUrl || uri.href !== value) {
      throw invalid();
    }
    return uri.href;
  } catch {
    throw invalid();
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatBearer(token: string): string {
  return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
