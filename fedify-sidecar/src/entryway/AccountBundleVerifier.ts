import { EntrywayError } from "./errors.js";
import {
  isRetryableHttpStatus,
  isRetryableTransportError,
  type RetryPolicy,
  withEntrywayRetry,
} from "./retry.js";
import type {
  AccountRoute,
  EntrywayBundleCheck,
  EntrywayBundleVerificationResult,
} from "./types.js";
import { isSecureOrTrustedInternalUrl } from "../utils/internalAuthority.js";

type FetchLike = typeof fetch;

export interface AccountBundleVerifierOptions {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
  strict?: boolean;
}

type CheckResult = {
  check: EntrywayBundleCheck;
  updates?: Partial<AccountRoute>;
};

export class AccountBundleVerifier {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly strict: boolean;

  public constructor(options: AccountBundleVerifierOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = clampInteger(options.timeoutMs ?? 8_000, 1_000, 30_000);
    this.retryPolicy = options.retryPolicy ?? {
      maxAttempts: 3,
      baseDelayMs: 150,
      maxDelayMs: 2_500,
    };
    this.strict = options.strict !== false;
  }

  public async verify(route: AccountRoute): Promise<EntrywayBundleVerificationResult> {
    const results = await Promise.all([
      this.runCheck("webid_resolves", true, () => this.verifyWebId(route)),
      this.runCheck("pod_storage_present", true, () => this.verifyStorage(route)),
      this.runCheck("oidc_issuer_resolves", this.strict, () => this.verifyOidcIssuer(route)),
      this.runCheck("activitypub_actor_valid", true, () => this.verifyActor(route)),
    ]);

    const checks = results.map((result) => result.check);
    const routeUpdates = results.reduce<Partial<AccountRoute>>((updates, result) => ({
      ...updates,
      ...(result.updates ?? {}),
    }), {});

    return {
      checks,
      routeUpdates,
      passed: checks.every((check) => check.status !== "failed"),
    };
  }

  private async runCheck(
    name: string,
    critical: boolean,
    fn: () => Promise<Partial<AccountRoute> | void>,
  ): Promise<CheckResult> {
    const checkedAt = new Date().toISOString();
    try {
      const updates = await fn();
      return {
        check: { name, status: "passed", checkedAt },
        updates: updates ?? undefined,
      };
    } catch (error) {
      const retryable = error instanceof EntrywayError ? error.retryable : isRetryableTransportError(error);
      return {
        check: {
          name,
          status: critical ? "failed" : "warning",
          checkedAt,
          message: sanitizeCheckMessage(error),
          retryable,
        },
      };
    }
  }

  private async verifyWebId(route: AccountRoute): Promise<void> {
    if (!route.webId) {
      throw new EntrywayError("webid_missing", "WebID is missing", { statusCode: 502 });
    }

    const url = parseSafeHttpUrl(route.webId, "WebID URL");
    url.hash = "";
    const response = await this.fetchWithRetry(url.toString(), {
      method: "GET",
      headers: {
        accept: "text/turtle, application/ld+json, application/rdf+xml, text/html;q=0.8, */*;q=0.5",
      },
    });
    if (!response.ok) {
      throw httpCheckError("webid_unavailable", "WebID did not resolve", response.status);
    }
  }

  private async verifyStorage(route: AccountRoute): Promise<void> {
    if (!route.podStorageUrl) {
      throw new EntrywayError("pod_storage_missing", "Pod storage URL is missing", { statusCode: 502 });
    }
    parseSafeHttpUrl(route.podStorageUrl, "Pod storage URL");
  }

  private async verifyOidcIssuer(route: AccountRoute): Promise<void> {
    if (!route.oidcIssuer) {
      throw new EntrywayError("oidc_issuer_missing", "OIDC issuer is missing", { statusCode: 502 });
    }

    const issuer = parseSafeHttpUrl(route.oidcIssuer, "OIDC issuer URL").origin;
    const response = await this.fetchWithRetry(new URL("/.well-known/openid-configuration", issuer).toString(), {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw httpCheckError("oidc_issuer_unavailable", "OIDC issuer metadata did not resolve", response.status);
    }

    const body = await safeReadJson(response);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const advertisedIssuer = (body as Record<string, unknown>)["issuer"];
      if (typeof advertisedIssuer === "string" && new URL(advertisedIssuer).origin !== issuer) {
        throw new EntrywayError("oidc_issuer_mismatch", "OIDC issuer metadata did not match route issuer", {
          statusCode: 502,
        });
      }
    }
  }

  private async verifyActor(route: AccountRoute): Promise<Partial<AccountRoute>> {
    if (!route.actorId) {
      throw new EntrywayError("actor_missing", "ActivityPub actor is missing", { statusCode: 502 });
    }

    const response = await this.fetchWithRetry(parseSafeHttpUrl(route.actorId, "ActivityPub actor URL").toString(), {
      method: "GET",
      headers: {
        accept: "application/activity+json, application/ld+json, application/json",
      },
    });
    if (!response.ok) {
      throw httpCheckError("actor_unavailable", "ActivityPub actor did not resolve", response.status);
    }

    const actor = await safeReadJson(response);
    if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
      throw new EntrywayError("actor_invalid", "ActivityPub actor response is not a JSON object", {
        statusCode: 502,
      });
    }

    const record = actor as Record<string, unknown>;
    const id = getString(record, "id") ?? getString(record, "@id");
    if (id !== route.actorId) {
      throw new EntrywayError("actor_id_mismatch", "ActivityPub actor id did not match route actor", {
        statusCode: 502,
      });
    }

    const inbox = getString(record, "inbox");
    const outbox = getString(record, "outbox");
    const followers = getString(record, "followers");
    const following = getString(record, "following");
    if (!inbox || !outbox || !followers || !following) {
      throw new EntrywayError(
        "actor_collections_missing",
        "ActivityPub actor is missing inbox, outbox, followers, or following",
        { statusCode: 502 },
      );
    }

    const publicKeyOwner = readPublicKeyOwner(record);
    if (publicKeyOwner && publicKeyOwner !== route.actorId) {
      throw new EntrywayError("actor_public_key_owner_mismatch", "ActivityPub public key owner did not match actor", {
        statusCode: 502,
      });
    }

    return {
      inbox,
      outbox,
      followers,
      following,
      publicKeyOwner: publicKeyOwner ?? route.publicKeyOwner,
    };
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    return withEntrywayRetry(
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const response = await this.fetchFn(url, {
            ...init,
            signal: controller.signal,
          });
          if (isRetryableHttpStatus(response.status)) {
            throw httpCheckError("verification_transient_http_error", "Verification request failed transiently", response.status);
          }
          return response;
        } finally {
          clearTimeout(timeout);
        }
      },
      this.retryPolicy,
      (error) => error instanceof EntrywayError ? error.retryable : isRetryableTransportError(error),
    );
  }
}

function parseSafeHttpUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new EntrywayError("invalid_url", `${label} is invalid`, {
      statusCode: 502,
      cause: error,
    });
  }

  if (parsed.username || parsed.password) {
    throw new EntrywayError("invalid_url", `${label} must not include credentials`, { statusCode: 502 });
  }

  if (!isSecureOrTrustedInternalUrl(parsed)) {
    throw new EntrywayError("invalid_url", `${label} must use https unless it targets a trusted internal host`, {
      statusCode: 502,
    });
  }

  return parsed;
}

async function safeReadJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new EntrywayError("invalid_json", "Verification endpoint returned malformed JSON", {
      statusCode: 502,
      cause: error,
    });
  }
}

function httpCheckError(code: string, message: string, status: number): EntrywayError {
  return new EntrywayError(code, message, {
    statusCode: 502,
    retryable: isRetryableHttpStatus(status),
    details: { status },
  });
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPublicKeyOwner(record: Record<string, unknown>): string | undefined {
  const publicKey = record["publicKey"];
  if (!publicKey || typeof publicKey !== "object" || Array.isArray(publicKey)) {
    return undefined;
  }
  return getString(publicKey as Record<string, unknown>, "owner");
}

function sanitizeCheckMessage(error: unknown): string {
  if (error instanceof EntrywayError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 256);
  }
  return "Verification failed";
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
