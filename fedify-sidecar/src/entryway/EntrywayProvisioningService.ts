import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { buildProviderIdempotencyKey } from "./providerIdempotency.js";
import { ActivityPodsProvisioningClient } from "./ActivityPodsProvisioningClient.js";
import type { EntrywayAppBootstrapper } from "./ActivityPodsAppBootstrapClient.js";
import { AccountBundleVerifier } from "./AccountBundleVerifier.js";
import { EntrywayError, sanitizeErrorMessage } from "./errors.js";
import { buildNativeSaiAuthorizationUrl, type EntrywayProviderRouter } from "./ProviderRouter.js";
import type { EntrywayProviderPreflight } from "./ProviderPreflight.js";
import { stableStringify } from "./stable.js";
import type {
  AccountRoute,
  AccountRouteStore,
  EntrywayAccountCreateInput,
  EntrywayConsentResumeInput,
  EntrywayBundleCheck,
  EntrywayProtocolSet,
  EntrywayProviderDefinition,
  EntrywayProvisioningPhase,
  EntrywayProvisioningResult,
} from "./types.js";

export interface EntrywayProvisioningServiceOptions {
  store: AccountRouteStore;
  providerRouter: EntrywayProviderRouter;
  providerClient: ActivityPodsProvisioningClient;
  providerPreflight?: EntrywayProviderPreflight;
  appBootstrapper?: EntrywayAppBootstrapper;
  verifier: AccountBundleVerifier;
  fingerprintSecret: string;
  staleProvisioningAfterMs?: number;
  now?: () => string;
}

export class EntrywayProvisioningService {
  private readonly store: AccountRouteStore;
  private readonly providerRouter: EntrywayProviderRouter;
  private readonly providerClient: ActivityPodsProvisioningClient;
  private readonly providerPreflight?: EntrywayProviderPreflight;
  private readonly appBootstrapper?: EntrywayAppBootstrapper;
  private readonly verifier: AccountBundleVerifier;
  private readonly fingerprintSecret: string;
  private readonly staleProvisioningAfterMs: number;
  private readonly now: () => string;

  public constructor(options: EntrywayProvisioningServiceOptions) {
    if (!options.fingerprintSecret || options.fingerprintSecret.length < 32) {
      throw new EntrywayError(
        "entryway_secret_invalid",
        "ENTRYWAY_FINGERPRINT_SECRET must be at least 32 characters",
        { statusCode: 500 },
      );
    }

    this.store = options.store;
    this.providerRouter = options.providerRouter;
    this.providerClient = options.providerClient;
    this.providerPreflight = options.providerPreflight;
    this.appBootstrapper = options.appBootstrapper;
    this.verifier = options.verifier;
    this.fingerprintSecret = options.fingerprintSecret;
    this.staleProvisioningAfterMs = clampInteger(options.staleProvisioningAfterMs ?? 10 * 60 * 1_000, 30_000, 60 * 60 * 1_000);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async createAccount(input: EntrywayAccountCreateInput): Promise<EntrywayProvisioningResult> {
    const normalized = normalizeCreateInput(input);
    const protocols = normalizeProtocols(normalized.protocols);
    const requestFingerprint = this.fingerprintRequest(normalized, protocols);
    const idempotencyKeyHash = this.hashIdempotencyKey(normalized.idempotencyKey);
    const now = this.now();
    const accountId = `acct_${randomUUID()}`;
    const reservedRoute = buildInitialRoute({
      accountId,
      username: normalized.username,
      idempotencyKeyHash,
      requestFingerprint,
      now,
    });

    const reservation = await this.store.reserve({
      accountId,
      username: normalized.username,
      idempotencyKeyHash,
      requestFingerprint,
      route: reservedRoute,
    });

    if (reservation.kind === "idempotency_conflict") {
      throw new EntrywayError("idempotency_key_conflict", "Idempotency key was already used for a different request", {
        statusCode: 409,
        retryable: false,
      });
    }

    if (reservation.kind === "username_taken") {
      throw new EntrywayError("username_unavailable", "Username is already reserved", {
        statusCode: 409,
        retryable: false,
      });
    }

    if (reservation.kind === "replayed") {
      if (reservation.route.status === "active") {
        return { route: reservation.route, replayed: true };
      }
      if (reservation.route.status === "provisioning" && !this.isStaleProvisioning(reservation.route)) {
        throw new EntrywayError("provisioning_in_progress", "Account provisioning is already in progress", {
          statusCode: 409,
          retryable: true,
        });
      }
    }

    // Competing retries must not both claim the same stale or failed account.
    // The winning attempt owns a unique fence across all subsequent writes.
    const route = await this.claimProvisioning(reservation.route);
    if (!route) {
      throw new EntrywayError("provisioning_in_progress", "Another account provisioning attempt owns this route", {
        statusCode: 409,
        retryable: true,
      });
    }
    const fenceToken = route.provisioning.fenceToken!;

    try {
      const provider = await this.resolveProvider(route, normalized, protocols, fenceToken);
      const providerBackedRoute = await this.ensureProviderAccount(route, provider, normalized, protocols, fenceToken);
      const verifiedRoute = await this.verifyAccountBundle(providerBackedRoute, fenceToken);
      const bootstrapped = await this.bootstrapAppIfConfigured(verifiedRoute, provider, fenceToken);
      const activeRoute = await this.activateRoute(bootstrapped.route, fenceToken);
      return {
        route: activeRoute,
        replayed: reservation.kind === "replayed",
        sessionHandoff: bootstrapped.sessionHandoff,
      };
    } catch (error) {
      const failed = await this.markFailed(route.accountId, fenceToken, error);
      if (error instanceof EntrywayError) {
        if (error.code === "app_consent_required") {
          await this.raiseNativeSaiConsent(error, route.accountId, fenceToken);
        }
        throw error;
      }
      throw new EntrywayError("entryway_provisioning_failed", "Account provisioning failed", {
        statusCode: 500,
        retryable: false,
        cause: error,
        details: failed ? { accountId: failed.accountId } : undefined,
      });
    }
  }

  public async getByAccountId(accountId: string): Promise<AccountRoute | null> {
    return this.store.getByAccountId(accountId);
  }

  public async getByUsername(username: string): Promise<AccountRoute | null> {
    return this.store.getByUsername(normalizeUsername(username));
  }

  /**
   * Backend-only continuation after the Pod owner has completed native SAI
   * authorization. The original caller keeps a high-entropy idempotency key
   * in its server-side transaction store; nothing sensitive is put into the
   * browser callback URL. A second account-create RPC is never performed.
   */
  public async resumeAwaitingConsent(input: EntrywayConsentResumeInput): Promise<EntrywayProvisioningResult> {
    const username = normalizeUsername(input.username);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const appClientId = input.appClientId.trim();
    if (!appClientId || appClientId.length > 2048) {
      throw new EntrywayError("invalid_app_client", "A scoped app client is required", {
        statusCode: 400, retryable: false,
      });
    }

    const current = await this.store.getByUsername(username);
    const calculatedHash = Buffer.from(this.hashIdempotencyKey(idempotencyKey), "hex");
    const storedHashText = current?.provisioning.idempotencyKeyHash ?? "";
    const storedHash = /^[a-f0-9]{64}$/.test(storedHashText)
      ? Buffer.from(storedHashText, "hex") : Buffer.alloc(32);
    if (!current || !timingSafeEqual(calculatedHash, storedHash)) {
      // Use the same response for an unknown username and a wrong key.
      throw new EntrywayError("consent_resume_not_found", "Consent operation was not found", {
        statusCode: 404, retryable: false,
      });
    }

    const provider = current.providerId
      ? this.providerRouter.getProvider(current.providerId) : null;
    if (!provider || provider.enabled === false ||
        provider.baseUrl !== current.providerBaseUrl ||
        provider.appClientId !== appClientId ||
        provider.appBootstrapEnabled !== true ||
        !current.appBootstrap ||
        current.appBootstrap.appClientId !== appClientId) {
      throw new EntrywayError("app_consent_provider_changed", "Original application authorization policy is unavailable", {
        statusCode: 409, retryable: false,
      });
    }
    if (!this.appBootstrapper) {
      throw new EntrywayError("app_bootstrap_unavailable", "Provider consent verification is unavailable", {
        statusCode: 503, retryable: true,
      });
    }

    if (current.status === "active" && current.appBootstrap.status === "ready") {
      // An idempotent backend retry must recheck *current* provider grants
      // before returning active routing metadata. This is not a session.
      let proof;
      try {
        proof = await this.appBootstrapper.bootstrap({ provider, route: current });
      } catch (error) {
        if (error instanceof EntrywayError && error.code === "app_consent_required") {
          // An already-active route has not been placed in a new durable
          // awaiting_consent phase. Never relay a provider-influenced URL
          // from this error as though it were a trusted pending consent link.
          throw new EntrywayError("app_consent_required", "Current Pod consent requires reauthorization", {
            statusCode: 428, retryable: false,
          });
        }
        throw error;
      }
      if (proof.snapshot.status !== "ready" ||
          proof.snapshot.appClientId !== appClientId) {
        throw new EntrywayError("app_consent_not_verified", "Current owner consent could not be verified", {
          statusCode: 409, retryable: false,
        });
      }
      return { route: { ...current, appBootstrap: proof.snapshot }, replayed: true };
    }

    if (current.status !== "awaiting_consent" ||
        current.appBootstrap.status !== "awaiting_consent" ||
        !current.webId || !current.actorId || !current.podStorageUrl) {
      throw new EntrywayError("consent_not_pending", "Account is not awaiting native owner authorization", {
        statusCode: 409, retryable: false,
      });
    }

    // Claim ownership atomically. Competing workers may not both resume
    // and no stale responder may overwrite an activated route.
    const claimed = await this.claimProvisioning(current);
    if (!claimed) {
      throw new EntrywayError("provisioning_in_progress", "Another consent attempt owns this route", {
        statusCode: 409, retryable: true,
      });
    }
    const fenceToken = claimed.provisioning.fenceToken!;
    try {
      const verified = await this.verifyAccountBundle(claimed, fenceToken);
      const completed = await this.bootstrapAppIfConfigured(verified, provider, fenceToken);
      const activated = await this.activateRoute(completed.route, fenceToken);
      // The HTTP route intentionally returns no provider session handoff
      // until the actual Solid-OIDC browser continuation is verified.
      return { route: activated, replayed: true };
    } catch (error) {
      const failed = await this.markFailed(claimed.accountId, fenceToken, error);
      if (error instanceof EntrywayError) {
        if (error.code === "app_consent_required") {
          await this.raiseNativeSaiConsent(error, claimed.accountId, fenceToken);
        }
        throw error;
      }
      throw new EntrywayError("consent_resume_failed", "Consent continuation failed", {
        statusCode: 500, retryable: false, cause: error,
        details: failed ? { accountId: failed.accountId } : undefined,
      });
    }
  }

  public async recoverStaleProvisioning(limit = 25): Promise<{ recovered: number; failed: number; skipped: number }> {
    const beforeIso = new Date(Date.now() - this.staleProvisioningAfterMs).toISOString();
    const staleRoutes = await this.store.listStaleProvisioning(beforeIso, limit);
    let recovered = 0;
    let failed = 0;
    let skipped = 0;

    for (const route of staleRoutes) {
      if (!route.canonicalAccountId || !route.webId || !route.actorId || !route.podStorageUrl) {
        skipped += 1;
        continue;
      }

      const claimed = await this.claimProvisioning(route);
      if (!claimed) {
        skipped += 1;
        continue;
      }
      const fenceToken = claimed.provisioning.fenceToken!;

      try {
        const provider = claimed.providerId ? this.providerRouter.getProvider(claimed.providerId) : null;
        if (!provider || provider.enabled === false || provider.baseUrl !== claimed.providerBaseUrl) {
          throw new EntrywayError("recovery_provider_unavailable", "Original account provider is unavailable", {
            statusCode: 503,
            retryable: true,
          });
        }
        const verifiedRoute = await this.verifyAccountBundle(claimed, fenceToken);
        const bootstrapped = await this.bootstrapAppIfConfigured(verifiedRoute, provider, fenceToken);
        await this.activateRoute(bootstrapped.route, fenceToken);
        recovered += 1;
      } catch (error) {
        if (error instanceof EntrywayError &&
            (error.retryable || error.code === "route_fence_lost")) {
          // A transient outage or lost CAS ownership must never overwrite
          // an account claimed/activated by another worker.
          skipped += 1;
          continue;
        }
        await this.markFailed(claimed.accountId, fenceToken, error);
        failed += 1;
      }
    }

    return { recovered, failed, skipped };
  }

  private async resolveProvider(
    route: AccountRoute,
    input: EntrywayAccountCreateInput,
    protocols: EntrywayProtocolSet,
    fenceToken: string,
  ): Promise<EntrywayProviderDefinition> {
    const existingProvider = route.providerId ? this.providerRouter.getProvider(route.providerId) : null;
    const candidates = existingProvider
      ? [existingProvider]
      : await this.providerRouter.listProviders({
          providerId: input.providerId,
          username: route.username,
          protocols,
        });

    if (candidates.length === 0) {
      throw new EntrywayError("provider_not_configured", "No Entryway provider is configured", {
        statusCode: 503,
        retryable: true,
      });
    }

    const errors: EntrywayError[] = [];

    for (const provider of candidates) {
      if (provider.enabled === false) {
        continue;
      }

      if (input.appClientId && input.appClientId !== provider.appClientId) {
        const error = new EntrywayError("unauthorized_app", "Entryway app client is not allowed for the selected provider", {
          statusCode: 403,
          retryable: false,
        });
        if (input.providerId || existingProvider) {
          throw error;
        }
        errors.push(error);
        continue;
      }

      try {
        const preflightChecks = this.providerPreflight
          ? await this.providerPreflight.assertProviderReady(provider, protocols)
          : [];
        const latest = await this.store.getByAccountId(route.accountId);
        await this.updateRoute(route.accountId, fenceToken, {
          providerId: provider.providerId,
          providerBaseUrl: provider.baseUrl,
          oidcIssuer: provider.baseUrl,
          provisioning: {
            ...(latest?.provisioning ?? route.provisioning),
            phase: "PROVIDER_SELECTED",
            checks: mergeChecks(latest?.provisioning.checks ?? route.provisioning.checks, preflightChecks),
          },
        });
        return provider;
      } catch (error) {
        const entrywayError = error instanceof EntrywayError
          ? error
          : new EntrywayError("provider_preflight_failed", "Provider preflight failed", {
              statusCode: 502,
              retryable: true,
              cause: error,
            });
        if (input.providerId || existingProvider) {
          throw entrywayError;
        }
        errors.push(entrywayError);
      }
    }

    throw summarizeProviderSelectionFailure(errors);
  }

  private async ensureProviderAccount(
    route: AccountRoute,
    provider: EntrywayProviderDefinition,
    input: EntrywayAccountCreateInput,
    protocols: EntrywayProtocolSet,
    fenceToken: string,
  ): Promise<AccountRoute> {
    const latest = await this.store.getByAccountId(route.accountId);
    if (latest?.webId && latest.actorId && latest.podStorageUrl) {
      return latest;
    }

    await this.assertOwnership(route.accountId, fenceToken);
    const providerResult = await this.providerClient.createAccount({
      provider,
      idempotencyKey: buildProviderIdempotencyKey(route),
      account: input,
      protocols,
    });
    const routeUpdates = mapProviderResultToRoute(provider, providerResult);
    return this.updateRoute(route.accountId, fenceToken, {
      ...routeUpdates,
      provisioning: {
        ...(latest?.provisioning ?? route.provisioning),
        phase: "POD_ACCOUNT_CREATED",
      },
    });
  }

  private async verifyAccountBundle(route: AccountRoute, fenceToken: string): Promise<AccountRoute> {
    const discovered = await this.updateRoute(route.accountId, fenceToken, {
      provisioning: {
        ...route.provisioning,
        phase: "WEBID_DISCOVERED",
      },
    });
    const verification = await this.verifier.verify(discovered);
    const checked = await this.updateRoute(discovered.accountId, fenceToken, {
      ...verification.routeUpdates,
      provisioning: {
        ...discovered.provisioning,
        phase: verification.passed ? "ACTOR_VALIDATED" : "FAILED",
        checks: mergeChecks(discovered.provisioning.checks, verification.checks),
        lastErrorCode: verification.passed ? undefined : "bundle_verification_failed",
        lastErrorMessage: verification.passed ? undefined : "Account bundle verification failed",
      },
    });

    if (!verification.passed) {
      throw new EntrywayError("bundle_verification_failed", "Account bundle verification failed", {
        statusCode: 502,
        retryable: true,
        details: { accountId: checked.accountId },
      });
    }

    return checked;
  }

  private async bootstrapAppIfConfigured(
    route: AccountRoute,
    provider: EntrywayProviderDefinition,
    fenceToken: string,
  ): Promise<{ route: AccountRoute; sessionHandoff?: EntrywayProvisioningResult["sessionHandoff"] }> {
    // A consent-pending account can never be promoted by disabling the
    // bootstrap feature or changing its approved client during a retry.
    if (route.appBootstrap?.status === "awaiting_consent" &&
        (provider.appBootstrapEnabled !== true ||
          route.appBootstrap.appClientId !== provider.appClientId)) {
      throw new EntrywayError(
        "app_consent_provider_changed",
        "Original application authorization policy is no longer available",
        { statusCode: 409, retryable: false },
      );
    }

    if (provider.appBootstrapEnabled !== true) {
      return { route };
    }

    if (!this.appBootstrapper) {
      throw new EntrywayError("app_bootstrap_unavailable", "Required provider app bootstrap is unavailable", {
        statusCode: 503,
        retryable: true,
      });
    }

    if (route.appBootstrap?.status === "ready") {
      if (route.appBootstrap.appClientId !== provider.appClientId) {
        throw new EntrywayError("app_bootstrap_identity_mismatch", "App bootstrap belongs to a different client", {
          statusCode: 409,
          retryable: false,
        });
      }
      return { route };
    }

    try {
      await this.assertOwnership(route.accountId, fenceToken);
      const result = await this.appBootstrapper.bootstrap({ provider, route });
      const updated = await this.updateRoute(route.accountId, fenceToken, {
        appBootstrap: result.snapshot,
        provisioning: {
          ...route.provisioning,
          phase: result.sessionHandoff ? "SESSION_READY" : "APP_BOOTSTRAP_READY",
        },
      });
      return {
        route: updated,
        sessionHandoff: result.sessionHandoff,
      };
    } catch (error) {
      if (error instanceof EntrywayError && error.code === "app_consent_required") {
        // Preserve the completed provider identity but leave the account
        // nonactive and outside unattended recovery. Only a new authenticated,
        // same-idempotency request may resume after native SAI approval.
        await this.updateRoute(route.accountId, fenceToken, {
          status: "awaiting_consent",
          appBootstrap: {
            status: "awaiting_consent",
            appClientId: provider.appClientId,
            accessGrantUris: [],
            lastErrorCode: "app_consent_required",
            lastErrorMessage: "Pod owner authorization is required",
          },
          provisioning: {
            ...route.provisioning,
            phase: "AWAITING_APP_CONSENT",
            lastErrorCode: "app_consent_required",
            lastErrorMessage: "Pod owner authorization is required",
          },
        });
        throw error;
      }

      const code = error instanceof EntrywayError ? error.code : "app_bootstrap_failed";
      await this.updateRoute(route.accountId, fenceToken, {
        appBootstrap: {
          status: "failed",
          appClientId: provider.appClientId,
          accessGrantUris: route.appBootstrap?.accessGrantUris ?? [],
          appRegistrationUri: route.appBootstrap?.appRegistrationUri,
          lastErrorCode: code,
          lastErrorMessage: sanitizeErrorMessage(error),
        },
        provisioning: {
          ...route.provisioning,
          phase: "FAILED",
          lastErrorCode: code,
          lastErrorMessage: sanitizeErrorMessage(error),
        },
      });
      throw error;
    }
  }

  /**
   * Only a fenced, durably pending route may yield an operator-pinned
   * native SAI link. No provider response body can override this URL.
   */
  private async raiseNativeSaiConsent(
    error: EntrywayError, accountId: string, fenceToken: string,
  ): Promise<never> {
    const current = await this.store.getByAccountId(accountId);
    const provider = current?.providerId
      ? this.providerRouter.getProvider(current.providerId) : null;
    if (current?.status === "awaiting_consent" &&
        current.provisioning.fenceToken === fenceToken &&
        provider?.enabled !== false &&
        provider?.baseUrl === current.providerBaseUrl &&
        current.appBootstrap?.appClientId === provider?.appClientId) {
      const authorizationUrl = buildNativeSaiAuthorizationUrl(provider);
      if (authorizationUrl) {
        throw new EntrywayError("app_consent_required", "Pod owner authorization is required", {
          statusCode: 428, retryable: false, details: { authorizationUrl },
        });
      }
    }
    // Never forward a provider-supplied authorizationUrl when no exact,
    // fenced awaiting_consent state could be verified.
    throw new EntrywayError("app_consent_required", "Pod owner authorization is required", {
      statusCode: 428, retryable: false,
    });
  }

  private async claimProvisioning(route: AccountRoute): Promise<AccountRoute | null> {
    if (route.status !== "provisioning" && route.status !== "failed" &&
        route.status !== "awaiting_consent") return null;
    const token = randomUUID();
    const claimed: AccountRoute = {
      ...route,
      revision: (route.revision ?? 0) + 1,
      status: "provisioning",
      provisioning: {
        ...route.provisioning,
        fenceToken: token,
        attempts: route.provisioning.attempts + 1,
        lastAttemptAt: this.now(),
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
      },
      updatedAt: this.now(),
    };
    return await this.store.compareAndSet(route, claimed) ? claimed : null;
  }

  private async assertOwnership(accountId: string, fenceToken: string): Promise<AccountRoute> {
    const current = await this.store.getByAccountId(accountId);
    if (!current || current.status !== "provisioning" ||
        current.provisioning.fenceToken !== fenceToken) {
      throw new EntrywayError("route_fence_lost", "Account provisioning is owned by another attempt", {
        statusCode: 409,
        retryable: true,
      });
    }
    return current;
  }

  private async activateRoute(route: AccountRoute, fenceToken: string): Promise<AccountRoute> {
    return this.updateRoute(route.accountId, fenceToken, {
      status: "active",
      provisioning: {
        ...route.provisioning,
        phase: "ACTIVE",
        completedAt: this.now(),
      },
    });
  }

  private async updateRoute(
    accountId: string,
    fenceToken: string,
    patch: Partial<AccountRoute>,
  ): Promise<AccountRoute> {
    const current = await this.assertOwnership(accountId, fenceToken);
    const updated: AccountRoute = {
      ...current,
      ...patch,
      revision: (current.revision ?? 0) + 1,
      provisioning: {
        ...current.provisioning,
        ...(patch.provisioning ?? {}),
        fenceToken,
      },
      updatedAt: this.now(),
    };
    if (!await this.store.compareAndSet(current, updated)) {
      throw new EntrywayError("route_fence_lost", "Account route changed before update", {
        statusCode: 409,
        retryable: true,
      });
    }
    return updated;
  }

  private async markFailed(accountId: string, fenceToken: string, error: unknown): Promise<AccountRoute | null> {
    const current = await this.store.getByAccountId(accountId);
    if (!current || current.status !== "provisioning" ||
        current.provisioning.fenceToken !== fenceToken) {
      return null;
    }

    const code = error instanceof EntrywayError ? error.code : "entryway_provisioning_failed";
    const updated: AccountRoute = {
      ...current,
      revision: (current.revision ?? 0) + 1,
      status: "failed",
      provisioning: {
        ...current.provisioning,
        phase: "FAILED",
        lastErrorCode: code,
        lastErrorMessage: sanitizeErrorMessage(error),
      },
      updatedAt: this.now(),
    };
    return await this.store.compareAndSet(current, updated) ? updated : null;
  }

  private isStaleProvisioning(route: AccountRoute): boolean {
    const updatedAtMs = Date.parse(route.updatedAt);
    return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs > this.staleProvisioningAfterMs;
  }

  private fingerprintRequest(input: EntrywayAccountCreateInput, protocols: EntrywayProtocolSet): string {
    return createHmac("sha256", this.fingerprintSecret)
      .update(stableStringify({
        username: input.username,
        email: input.email ?? null,
        password: input.password,
        profile: input.profile,
        protocols,
        atproto: normalizeAtprotoInput(input.protocols?.atproto),
        providerId: input.providerId ?? null,
        appClientId: input.appClientId ?? null,
        redirectUri: input.redirectUri ?? null,
        verification: input.verification ?? null,
      }))
      .digest("hex");
  }

  private hashIdempotencyKey(value: string): string {
    return createHmac("sha256", this.fingerprintSecret)
      .update(value.trim())
      .digest("hex");
  }
}

function buildInitialRoute(input: {
  accountId: string;
  username: string;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  now: string;
}): AccountRoute {
  return {
    accountId: input.accountId,
    username: input.username,
    handle: "",
    webId: "",
    actorId: "",
    podStorageUrl: "",
    providerId: "",
    providerBaseUrl: "",
    oidcIssuer: "",
    status: "provisioning",
    provisioning: {
      phase: "USERNAME_RESERVED",
      attempts: 0,
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestFingerprint: input.requestFingerprint,
      checks: [],
    },
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function normalizeCreateInput(input: EntrywayAccountCreateInput): EntrywayAccountCreateInput {
  return {
    ...input,
    username: normalizeUsername(input.username),
    email: input.email?.trim().toLowerCase() || undefined,
    password: input.password,
    profile: {
      displayName: input.profile.displayName.trim(),
      summary: input.profile.summary?.trim() || undefined,
    },
    providerId: input.providerId?.trim() || undefined,
    appClientId: input.appClientId?.trim() || undefined,
    redirectUri: input.redirectUri?.trim() || undefined,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
  };
}

function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/.test(username)) {
    throw new EntrywayError("invalid_username", "Username must be 3-64 lowercase letters, numbers, underscores, or hyphens", {
      statusCode: 400,
    });
  }
  return username;
}

function normalizeIdempotencyKey(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(trimmed)) {
    throw new EntrywayError("invalid_idempotency_key", "Idempotency key is invalid", {
      statusCode: 400,
    });
  }
  return trimmed;
}

function normalizeProtocols(protocols: EntrywayAccountCreateInput["protocols"]): EntrywayProtocolSet {
  const atproto = typeof protocols?.atproto === "object"
    ? protocols.atproto.enabled !== false
    : protocols?.atproto === false
      ? false
      : true;

  return {
    solid: protocols?.solid !== false,
    activitypub: protocols?.activitypub !== false,
    atproto,
  };
}

function normalizeAtprotoInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    enabled: record["enabled"] !== false,
    handle: typeof record["handle"] === "string" ? record["handle"] : undefined,
    didMethod: typeof record["didMethod"] === "string" ? record["didMethod"] : undefined,
  };
}

function mapProviderResultToRoute(
  provider: EntrywayProviderDefinition,
  result: Record<string, unknown>,
): Partial<AccountRoute> {
  const activitypub = getObject(result["activitypub"]);
  const solid = getObject(result["solid"]);
  const atproto = getObject(result["atproto"]);
  const canonicalAccountId = getString(result["canonicalAccountId"]);
  const webId = getString(result["webId"]) ?? getString(solid?.["webId"]);
  const actorId = getString(activitypub?.["actorId"]);
  const podStorageUrl = getString(solid?.["podBaseUrl"]) ?? getString(solid?.["storageUrl"]);

  if (!canonicalAccountId || !webId || !actorId || !podStorageUrl) {
    throw new EntrywayError("provider_incomplete_account", "Provider account response was incomplete", {
      statusCode: 502,
      retryable: false,
    });
  }

  const atprotoDid = getString(atproto?.["did"]);
  const atprotoHandle = getString(atproto?.["handle"]);
  return {
    canonicalAccountId,
    webId,
    actorId,
    handle: getString(activitypub?.["handle"]) ?? atprotoHandle ?? "",
    inbox: getString(activitypub?.["inbox"]),
    outbox: getString(activitypub?.["outbox"]),
    podStorageUrl,
    providerId: provider.providerId,
    providerBaseUrl: provider.baseUrl,
    oidcIssuer: provider.baseUrl,
    atprotoDid,
    atprotoHandle,
  };
}

function mergeChecks(existing: EntrywayBundleCheck[], next: EntrywayBundleCheck[]): EntrywayBundleCheck[] {
  const byName = new Map<string, EntrywayBundleCheck>();
  for (const check of existing) {
    byName.set(check.name, check);
  }
  for (const check of next) {
    byName.set(check.name, check);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function summarizeProviderSelectionFailure(errors: EntrywayError[]): EntrywayError {
  if (errors.length === 0) {
    return new EntrywayError("provider_not_available", "No Entryway provider is currently available", {
      statusCode: 503,
      retryable: true,
    });
  }

  if (errors.every((error) => error.code === "unauthorized_app")) {
    return new EntrywayError("unauthorized_app", "Entryway app client is not allowed for any configured provider", {
      statusCode: 403,
      retryable: false,
    });
  }

  const retryable = errors.every((error) => error.retryable);
  return new EntrywayError(
    "provider_not_available",
    "No configured Entryway provider can satisfy the requested account bundle",
    {
      statusCode: retryable ? 503 : 400,
      retryable,
      details: {
        reasons: errors.map((error) => ({
          code: error.code,
          retryable: error.retryable,
        })).slice(0, 5),
      },
    },
  );
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
