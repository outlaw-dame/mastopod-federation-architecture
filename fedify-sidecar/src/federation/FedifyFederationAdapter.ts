/**
 * FedifyFederationAdapter
 *
 * Concrete implementation of FederationRuntimeAdapter that wires to a real
 * Fedify 2.x Federation instance.
 *
 * Responsibilities:
 *  - Create and configure a Fedify Federation<void> instance.
 *  - Implement onInboundVerified / onOutboundDelivered hooks by forwarding
 *    observability signals into Fedify context (tracing, metrics).
 *  - Expose the Federation instance so index.ts can register it with the
 *    Fastify HTTP server once ENABLE_FEDIFY_RUNTIME_INTEGRATION=true.
 *  - Verify canonical ActivityPub inbox HTTP requests and enqueue trusted
 *    deliveries back into the sidecar's Redis Streams pipeline.
 *
 * Architecture boundary:
 *  - ActivityPods remains the signing authority; keys never leave it.
 *  - Outbound delivery semantics are centralized here when runtime integration
 *    is enabled, while OutboundWorker remains the durable queue/rate-limit/
 *    retry orchestrator and ActivityPods remains the only signer.
 *  - Canonical inbox verification happens here via Fedify. The InboundWorker
 *    remains the durable forwarding/event pipeline and still performs raw
 *    HTTP-signature verification for legacy fallback ingress paths.
 *  - The Federation instance here is used for: actor document dispatch,
 *    WebFinger, NodeInfo, and verified inbox delegation.
 *
 * Fedify 2.x migration notes applied here:
 *  - Uses `documentLoaderFactory` / `contextLoaderFactory` (not deprecated
 *    `documentLoader` / `contextLoader`).
 *  - Actor dispatcher uses `{ identifier }` path param (not removed `{ handle }`).
 *  - KvStore.list() is implemented (required in 2.x).
 *  - Idempotency: explicit `"per-inbox"` (now the default, documented here for
 *    clarity since the sidecar has its own Redis-level idempotency layer).
 *
 * Key handling:
 *  - Private keys never leave ActivityPods; this adapter fetches only the
 *    public key PEM from the ActivityPods internal API for inclusion in actor
 *    documents served to the Fediverse.
 *  - Public keys are imported as verify-only CryptoKey objects (usage:
 *    ["verify"]) so they can be embedded in the Fedify CryptographicKey
 *    vocabulary object attached to the Person actor.
 *  - setActorKeyPairsDispatcher is intentionally NOT called because Fedify
 *    requires both halves of a CryptographicKeyPair for that dispatcher, and
 *    private keys are never available on the sidecar side.
 */

import {
  createFederation,
  type Context,
  type Federation,
  type InboxContext,
  type KvStore,
} from "@fedify/fedify";
import {
  Activity,
  CryptographicKey,
  Person,
  Service,
} from "@fedify/fedify/vocab";
import type { SidecarLocalSigningService } from "../signing/SidecarLocalSigningService.js";
import { isIP } from "node:net";
import { request } from "undici";
import type {
  OutboundDeliveryMeta,
  FederationRuntimeAdapter,
  OutboundDeliveryInput,
  OutboundDeliveryModerationReportMeta,
  OutboundDeliveryResult,
} from "../core-domain/contracts/SigningContracts.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FedifyAdapterConfig {
  /** Public hostname of this sidecar, e.g. "social.example.com" */
  domain: string;
  /**
   * Base URL of the ActivityPods instance for proxying actor documents and
   * signing requests, e.g. "https://activitypods.example.com"
   */
  activityPodsUrl: string;
  /** Bearer token for ActivityPods internal API calls. */
  activityPodsToken: string;
  /**
   * Queue callback for verified inbound ActivityPub deliveries. When present,
   * Fedify becomes the primary inbox verifier/router and hands trusted
   * deliveries back to the sidecar's Redis Streams pipeline.
   */
  enqueueVerifiedInbox?: (delivery: VerifiedInboxDelivery) => Promise<{ envelopeId: string } | void>;
  /** Outbound ActivityPub request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** User-Agent for outbound ActivityPub delivery requests. */
  userAgent?: string;
  /**
   * HTTP status codes treated as permanent outbound delivery failures.
   * Fedify's default behavior is `[404, 410]`.
   */
  permanentFailureStatusCodes?: readonly number[];
  /** Maximum error response body bytes retained for diagnostics. */
  maxErrorResponseBodyBytes?: number;
  /**
   * Optional local signing service for sidecar-owned service actors
   * (e.g. the relay actor). When provided, signing for actors whose
   * URI is rooted in the sidecar's domain bypasses ActivityPods signing.
   */
  localSigningService?: SidecarLocalSigningService;
  /**
   * Identifiers of sidecar-owned service actors. Defaults to `["relay"]`.
   * These actors are served with locally generated key pairs rather than
   * proxied from ActivityPods.
   */
  sidecarServiceActors?: string[];
  onModerationReportDelivered?: (input: {
    meta: OutboundDeliveryModerationReportMeta;
    targetDomain: string;
    statusCode?: number;
  }) => Promise<void> | void;
  onModerationReportFailed?: (input: {
    meta: OutboundDeliveryModerationReportMeta;
    targetDomain: string;
    targetInbox: string;
    statusCode?: number;
    error: string;
    responseBody?: string;
    attempt: number;
  }) => Promise<void> | void;
}

export interface FedifyAdapterLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: FedifyAdapterLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface FedifyOutboundRuntimeConfig {
  requestTimeoutMs: number;
  userAgent: string;
  permanentFailureStatusCodes: readonly number[];
  maxErrorResponseBodyBytes: number;
}

const DEFAULT_PERMANENT_FAILURE_STATUS_CODES = [404, 410] as const;
const DEFAULT_MAX_ERROR_RESPONSE_BODY_BYTES = 1024;

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Permitted characters for an ActivityPub actor identifier (local part only).
 * Allows alphanumeric, dot, underscore, and hyphen; max 128 chars to match
 * Mastodon's practical limit. This guards against path-traversal injection
 * before the identifier is interpolated into the ActivityPods internal URL.
 */
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

// ---------------------------------------------------------------------------
// Adapter context data — passed through every Fedify context callback
// ---------------------------------------------------------------------------

interface SidecarContext {
  domain: string;
  activityPodsUrl: string;
  activityPodsToken: string;
  remoteIp: string;
  enqueueVerifiedInbox?: (delivery: VerifiedInboxDelivery) => Promise<{ envelopeId: string } | void>;
}

export interface VerifiedInboxDelivery {
  path: string;
  body: string;
  remoteIp: string;
  verifiedActorUri: string;
  verifiedAt: number;
}

// ---------------------------------------------------------------------------
// Public key import
// ---------------------------------------------------------------------------

/**
 * Import a PEM-encoded RSA public key as a verify-only Web Crypto CryptoKey.
 *
 * Accepts SPKI format ("BEGIN PUBLIC KEY") which is the ActivityPub/RSA-SHA256
 * standard emitted by ActivityPods. Returns null on any parse or import error
 * so that actor dispatch can degrade gracefully (actor document is still
 * served, just without an embedded publicKey).
 *
 * Security notes:
 *  - Usage is restricted to ["verify"] — the key can never be used to sign.
 *  - extractable: true is required so Fedify can re-serialise the key into
 *    the JSON-LD actor document. The exported form remains the public key only.
 *  - No private key material ever passes through this function.
 */
async function importPublicKeyPem(pem: string): Promise<CryptoKey | null> {
  try {
    // Strip PEM headers and all whitespace to get raw base64.
    const pemBody = pem
      .replace(/-----BEGIN [^-]+-----/, "")
      .replace(/-----END [^-]+-----/, "")
      .replace(/\s+/g, "");

    if (pemBody.length === 0) return null;

    // Decode base64 → DER binary. Use Buffer (Node 20+) for safety.
    const der = Buffer.from(pemBody, "base64");

    return await crypto.subtle.importKey(
      "spki",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      /* extractable */ true, // required for JSON-LD serialisation
      ["verify"]              // never sign; this is a public key only
    );
  } catch {
    // Deliberate: import errors are non-fatal; actor dispatch continues.
    return null;
  }
}

function resolveOutboundRuntimeConfig(
  config: FedifyAdapterConfig,
): FedifyOutboundRuntimeConfig {
  return {
    requestTimeoutMs:
      Number.isFinite(config.requestTimeoutMs) && (config.requestTimeoutMs ?? 0) > 0
        ? config.requestTimeoutMs!
        : 30_000,
    userAgent:
      typeof config.userAgent === "string" && config.userAgent.trim().length > 0
        ? config.userAgent
        : "Fedify-Sidecar/1.0 (ActivityPods)",
    permanentFailureStatusCodes:
      config.permanentFailureStatusCodes && config.permanentFailureStatusCodes.length > 0
        ? [...new Set(config.permanentFailureStatusCodes.filter(isValidHttpStatusCode))]
        : DEFAULT_PERMANENT_FAILURE_STATUS_CODES,
    maxErrorResponseBodyBytes:
      Number.isFinite(config.maxErrorResponseBodyBytes) && (config.maxErrorResponseBodyBytes ?? 0) > 0
        ? config.maxErrorResponseBodyBytes!
        : DEFAULT_MAX_ERROR_RESPONSE_BODY_BYTES,
  };
}

function isValidHttpStatusCode(statusCode: number): boolean {
  return Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599;
}

function normalizeOutboundTargetUrl(value: string): URL | null {
  let targetUrl: URL;
  try {
    targetUrl = new URL(value);
  } catch {
    return null;
  }

  if (targetUrl.username || targetUrl.password) {
    return null;
  }

  const hostname = targetUrl.hostname.toLowerCase();
  const protocol = targetUrl.protocol.toLowerCase();
  if (protocol !== "https:" && !(protocol === "http:" && isLoopbackHost(hostname))) {
    return null;
  }
  if (isPrivateLiteralIp(hostname) && !isLoopbackHost(hostname)) {
    return null;
  }

  targetUrl.hash = "";
  return targetUrl;
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") {
    return true;
  }

  const version = isIP(hostname);
  if (version === 4) {
    return hostname.startsWith("127.");
  }
  return false;
}

function isPrivateLiteralIp(hostname: string): boolean {
  const version = isIP(hostname);
  if (version === 4) {
    const octets = hostname.split(".").map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false;
    }
    const a = octets[0];
    const b = octets[1];
    if (a == null || b == null) {
      return false;
    }
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (version === 6) {
    const normalized = hostname.toLowerCase();
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }

  return false;
}

async function readLimitedResponseBody(
  body: AsyncIterable<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<string> {
  if (body == null) {
    return "";
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  for await (const chunk of body) {
    const remaining = maxBytes - totalBytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    chunks.push(decoder.decode(slice, { stream: slice.byteLength === chunk.byteLength }));
    totalBytes += slice.byteLength;
    if (slice.byteLength !== chunk.byteLength) {
      truncated = true;
      break;
    }
  }

  const finalChunk = decoder.decode();
  if (finalChunk.length > 0) {
    chunks.push(finalChunk);
  }

  let result = chunks.join("");
  if (truncated) {
    result += "… (truncated)";
  }
  return result;
}

function parseRetryAfterMs(value: string | string[] | undefined): number | undefined {
  if (Array.isArray(value)) {
    return parseRetryAfterMs(value[0]);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const trimmed = value.trim();
  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 12 * 60 * 60 * 1000);
  }

  const retryAt = Date.parse(trimmed);
  if (!Number.isFinite(retryAt)) {
    return undefined;
  }

  return Math.min(Math.max(retryAt - Date.now(), 0), 12 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// FedifyFederationAdapter
// ---------------------------------------------------------------------------

export class FedifyFederationAdapter implements FederationRuntimeAdapter {
  readonly name = "fedify-v2";
  readonly enabled = true;

  private readonly federation: Federation<SidecarContext>;
  private readonly logger: FedifyAdapterLogger;
  private readonly outboundRuntimeConfig: FedifyOutboundRuntimeConfig;
  private readonly localSigningService: SidecarLocalSigningService | undefined;
  private readonly sidecarServiceActors: Set<string>;

  constructor(
    kv: KvStore,
    private readonly config: FedifyAdapterConfig,
    logger?: FedifyAdapterLogger
  ) {
    this.logger = logger ?? NOOP_LOGGER;
    this.outboundRuntimeConfig = resolveOutboundRuntimeConfig(config);
    this.localSigningService = config.localSigningService;
    this.sidecarServiceActors = new Set(config.sidecarServiceActors ?? ["relay"]);
    this.federation = this.buildFederation(kv);
  }

  // --------------------------------------------------------------------------
  // Public: expose the Federation instance for HTTP route registration
  // --------------------------------------------------------------------------

  /**
   * Returns the underlying Fedify Federation instance so that index.ts can
   * register it with Fastify via FedifyFastifyBridge:
   *
   *   registerFedifyRoutes(app, fedifyAdapter);
   */
  getFederation(): Federation<SidecarContext> {
    return this.federation;
  }

  /**
   * Build the context object passed to every Fedify handler.
   * Call this from the HTTP middleware layer.
   */
  buildContext(request?: { ip?: string }): SidecarContext {
    return {
      domain: this.config.domain,
      activityPodsUrl: this.config.activityPodsUrl,
      activityPodsToken: this.config.activityPodsToken,
      remoteIp: request?.ip ?? "unknown",
      enqueueVerifiedInbox: this.config.enqueueVerifiedInbox,
    };
  }

  // --------------------------------------------------------------------------
  // FederationRuntimeAdapter hooks
  // --------------------------------------------------------------------------

  async onInboundVerified(input: {
    actorUri: string;
    activityId?: string;
    activityType?: string;
    isPublic?: boolean;
  }): Promise<void> {
    try {
      this.logger.info("[fedify] inbound verified", {
        actorUri: input.actorUri,
        activityId: input.activityId,
        activityType: input.activityType,
        isPublic: input.isPublic,
      });
      // TODO: when inbox handler delegation is enabled, forward to
      //   this.federation.processMessage(request, context) instead of
      //   letting InboundWorker forward to ActivityPods directly.
    } catch (err) {
      // Adapter errors must never propagate (per FederationRuntimeAdapter contract).
      this.logger.error("[fedify] onInboundVerified error (swallowed)", {
        err: String(err),
      });
    }
  }

  async onOutboundDelivered(input: {
    actorUri: string;
    activityId: string;
    targetDomain: string;
    statusCode?: number;
    meta?: OutboundDeliveryMeta;
  }): Promise<void> {
    try {
      this.logger.info("[fedify] outbound delivered", {
        actorUri: input.actorUri,
        activityId: input.activityId,
        targetDomain: input.targetDomain,
        statusCode: input.statusCode,
      });
      if (input.meta?.moderationReport && this.config.onModerationReportDelivered) {
        await this.config.onModerationReportDelivered({
          meta: input.meta.moderationReport,
          targetDomain: input.targetDomain,
          statusCode: input.statusCode,
        });
      }
      // TODO: when Fedify handles delivery, report permanent failures here
      //   via federation's permanentFailureStatusCodes integration.
    } catch (err) {
      this.logger.error("[fedify] onOutboundDelivered error (swallowed)", {
        err: String(err),
      });
    }
  }

  async onOutboundPermanentFailure(input: {
    actorUri: string;
    activityId: string;
    targetDomain: string;
    targetInbox: string;
    statusCode?: number;
    error: string;
    responseBody?: string;
    attempt: number;
    meta?: OutboundDeliveryMeta;
  }): Promise<void> {
    try {
      this.logger.warn("[fedify] outbound permanent failure", {
        actorUri: input.actorUri,
        activityId: input.activityId,
        targetDomain: input.targetDomain,
        targetInbox: input.targetInbox,
        statusCode: input.statusCode,
        error: input.error,
        responseBody: input.responseBody,
        attempt: input.attempt,
      });
      if (input.meta?.moderationReport && this.config.onModerationReportFailed) {
        await this.config.onModerationReportFailed({
          meta: input.meta.moderationReport,
          targetDomain: input.targetDomain,
          targetInbox: input.targetInbox,
          statusCode: input.statusCode,
          error: input.error,
          responseBody: input.responseBody,
          attempt: input.attempt,
        });
      }
    } catch (err) {
      this.logger.error("[fedify] onOutboundPermanentFailure error (swallowed)", {
        err: String(err),
      });
    }
  }

  /**
   * Determine whether `actorUri` is a sidecar-owned service actor
   * (e.g. `https://<domain>/users/relay`). When true, we use the local
   * signing service instead of ActivityPods signing.
   */
  private isSidecarOwnedActor(actorUri: string): { owned: true; identifier: string } | { owned: false } {
    try {
      const url = new URL(actorUri);
      // Must be on our own domain
      if (url.hostname !== this.config.domain) return { owned: false };
      // Path must be /users/<identifier>
      const match = /^\/users\/([^/]+)$/.exec(url.pathname);
      if (!match || !match[1]) return { owned: false };
      const identifier = match[1];
      if (!this.sidecarServiceActors.has(identifier)) return { owned: false };
      return { owned: true, identifier };
    } catch {
      return { owned: false };
    }
  }

  async deliverOutbound(input: OutboundDeliveryInput): Promise<OutboundDeliveryResult> {
    const targetUrl = normalizeOutboundTargetUrl(input.targetInbox);
    if (targetUrl == null) {
      return {
        jobId: input.jobId,
        success: false,
        error: "Outbound target inbox failed safety validation",
        permanent: true,
      };
    }

    // For sidecar-owned service actors (e.g. relay), bypass ActivityPods
    // signing and use the locally stored RSA key pair instead.
    const ownerCheck = this.isSidecarOwnedActor(input.actorUri);
    if (ownerCheck.owned && this.localSigningService) {
      return this._deliverWithLocalSigning(input, targetUrl, ownerCheck.identifier);
    }

    let signResult;
    try {
      signResult = await input.signHttpRequest({
        actorUri: input.actorUri,
        method: "POST",
        targetUrl: targetUrl.href,
        body: input.activity,
      });
    } catch (error) {
      return {
        jobId: input.jobId,
        success: false,
        error: `Signing failed: ${error instanceof Error ? error.message : String(error)}`,
        permanent: false,
      };
    }

    if (!signResult.ok) {
      return {
        jobId: input.jobId,
        success: false,
        error: `Signing failed: ${signResult.error.code} - ${signResult.error.message}`,
        permanent: signResult.error.permanent,
      };
    }

    try {
      const response = await request(targetUrl, {
        method: "POST",
        headers: {
          "content-type": "application/activity+json",
          accept: "application/activity+json, application/ld+json",
          "user-agent": input.userAgent || this.outboundRuntimeConfig.userAgent,
          date: signResult.signedHeaders.date,
          signature: signResult.signedHeaders.signature,
          host: targetUrl.host,
          ...(signResult.signedHeaders.digest ? { digest: signResult.signedHeaders.digest } : {}),
        },
        body: input.activity,
        bodyTimeout: input.requestTimeoutMs || this.outboundRuntimeConfig.requestTimeoutMs,
        headersTimeout: input.requestTimeoutMs || this.outboundRuntimeConfig.requestTimeoutMs,
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        await readLimitedResponseBody(response.body, this.outboundRuntimeConfig.maxErrorResponseBodyBytes);
        return {
          jobId: input.jobId,
          success: true,
          statusCode: response.statusCode,
        };
      }

      const responseBody = await readLimitedResponseBody(
        response.body,
        this.outboundRuntimeConfig.maxErrorResponseBodyBytes,
      );
      const sendErrorMessage =
        `Failed to send activity ${input.activityId} to ${targetUrl.href} (${response.statusCode}):\n${responseBody}`;
      const permanent = this.outboundRuntimeConfig.permanentFailureStatusCodes.includes(response.statusCode);

      return {
        jobId: input.jobId,
        success: false,
        statusCode: response.statusCode,
        error: sendErrorMessage,
        responseBody,
        permanent,
        retryAfterMs: permanent ? undefined : parseRetryAfterMs(response.headers["retry-after"]),
      };
    } catch (error) {
      return {
        jobId: input.jobId,
        success: false,
        error: `Network error: ${error instanceof Error ? error.message : String(error)}`,
        permanent: false,
      };
    }
  }

  /**
   * Deliver an outbound activity signed with a locally stored RSA key pair
   * (for sidecar-owned service actors like the relay actor).
   */
  private async _deliverWithLocalSigning(
    input: OutboundDeliveryInput,
    targetUrl: URL,
    identifier: string,
  ): Promise<OutboundDeliveryResult> {
    const localSvc = this.localSigningService!;
    let signedHeaders: { date: string; digest: string; signature: string };
    try {
      signedHeaders = await localSvc.signHttpRequest({
        actorUri: input.actorUri,
        identifier,
        method: "POST",
        targetUrl: targetUrl.href,
        body: input.activity,
      });
    } catch (err) {
      return {
        jobId: input.jobId,
        success: false,
        error: `Local signing failed: ${err instanceof Error ? err.message : String(err)}`,
        permanent: false,
      };
    }

    try {
      const response = await request(targetUrl, {
        method: "POST",
        headers: {
          "content-type": "application/activity+json",
          accept: "application/activity+json, application/ld+json",
          "user-agent": input.userAgent || this.outboundRuntimeConfig.userAgent,
          date: signedHeaders.date,
          digest: signedHeaders.digest,
          signature: signedHeaders.signature,
          host: targetUrl.host,
        },
        body: input.activity,
        bodyTimeout: input.requestTimeoutMs || this.outboundRuntimeConfig.requestTimeoutMs,
        headersTimeout: input.requestTimeoutMs || this.outboundRuntimeConfig.requestTimeoutMs,
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        await readLimitedResponseBody(response.body, this.outboundRuntimeConfig.maxErrorResponseBodyBytes);
        return { jobId: input.jobId, success: true, statusCode: response.statusCode };
      }

      const responseBody = await readLimitedResponseBody(
        response.body,
        this.outboundRuntimeConfig.maxErrorResponseBodyBytes,
      );
      const permanent = this.outboundRuntimeConfig.permanentFailureStatusCodes.includes(response.statusCode);
      return {
        jobId: input.jobId,
        success: false,
        statusCode: response.statusCode,
        error: `Failed to deliver (local-signed) activity to ${targetUrl.href} (${response.statusCode}):\n${responseBody}`,
        responseBody,
        permanent,
        retryAfterMs: permanent ? undefined : parseRetryAfterMs(response.headers["retry-after"]),
      };
    } catch (err) {
      return {
        jobId: input.jobId,
        success: false,
        error: `Network error (local-signed): ${err instanceof Error ? err.message : String(err)}`,
        permanent: false,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Federation setup
  // --------------------------------------------------------------------------

  private buildFederation(kv: KvStore): Federation<SidecarContext> {
    const federation = createFederation<SidecarContext>({
      kv,

      // Fedify 2.x: documentLoaderFactory replaces deprecated documentLoader.
      // The default factory is adequate; override only if you need custom
      // auth headers for fetching remote ActivityPub documents.
      // documentLoaderFactory: (ctx) => getDocumentLoader({ ... }),

      // Explicit idempotency strategy. "per-inbox" is the 2.x default.
      // The sidecar also enforces its own Redis-level idempotency in
      // OutboundWorker, so this is belt-and-suspenders.
      // TODO: uncomment once @fedify/fedify 2.x types are installed:
      // inboxIdempotency: { strategy: "per-inbox" },
    });

    this.registerActorDispatcher(federation);
    this.registerCollectionDispatchers(federation);
    this.registerInboxListeners(federation);
    this.registerNodeInfo(federation);

    return federation;
  }

  // --------------------------------------------------------------------------
  // Actor dispatcher
  // --------------------------------------------------------------------------

  private registerActorDispatcher(
    federation: Federation<SidecarContext>
  ): void {
    // Fedify 2.x: path param is {identifier}, not the removed {handle}.
    federation.setActorDispatcher(
      "/users/{identifier}",
      async (ctx: Context<SidecarContext>, identifier: string) => {
        // Guard against path-traversal or injection before interpolating
        // the identifier into the ActivityPods internal API URL.
        if (!IDENTIFIER_PATTERN.test(identifier)) {
          this.logger.warn("[fedify] actor dispatcher: rejected invalid identifier", {
            identifier: identifier.slice(0, 64), // truncate in log; never log unbounded user input
          });
          return null;
        }

        // Canonical actor URL on the sidecar's public domain.
        const actorId = `https://${ctx.data.domain}/users/${identifier}`;

        // ---------- Sidecar-owned service actors ----------
        // Actors like "relay" are owned by the sidecar itself, not proxied
        // from ActivityPods. Serve a synthetic Service actor with a locally
        // managed public key.
        if (this.sidecarServiceActors.has(identifier) && this.localSigningService) {
          try {
            const publicKeyPem = await this.localSigningService.getPublicKeyPem(identifier);
            const cryptoKey = await importPublicKeyPem(publicKeyPem);
            const publicKey = cryptoKey
              ? new CryptographicKey({
                  id: new URL(`${actorId}#main-key`),
                  owner: new URL(actorId),
                  publicKey: cryptoKey,
                })
              : undefined;

            return new Service({
              id: new URL(actorId),
              name: identifier,
              preferredUsername: identifier,
              inbox: new URL(`https://${ctx.data.domain}/users/${identifier}/inbox`),
              outbox: new URL(`https://${ctx.data.domain}/users/${identifier}/outbox`),
              followers: new URL(`https://${ctx.data.domain}/users/${identifier}/followers`),
              following: new URL(`https://${ctx.data.domain}/users/${identifier}/following`),
              url: new URL(actorId),
              ...(publicKey != null ? { publicKey } : {}),
            });
          } catch (err) {
            this.logger.error("[fedify] actor dispatcher: failed to build sidecar service actor", {
              identifier,
              err: String(err),
            });
            return null;
          }
        }

        try {
          const doc = await this.fetchActivityPodsActorDocument(ctx, identifier);
          if (doc == null) {
            return null;
          }

          // ---------- Public key ----------
          // Attempt to embed the actor's public key in the returned Person so
          // that remote servers can verify HTTP signatures.
          //
          // ActivityPods may surface the publicKeyPem either at the top level
          // or nested under a "publicKey" object (both are common AP shapes).
          // We tolerate both without trusting either blindly — importPublicKeyPem
          // validates and imports the key with usage: ["verify"] only.
          const publicKeyPem =
            (doc["publicKeyPem"] as string | undefined) ??
            ((doc["publicKey"] as Record<string, unknown> | undefined)?.["publicKeyPem"] as string | undefined);

          let activityPubPublicKey: CryptographicKey | undefined;

          if (publicKeyPem) {
            const cryptoKey = await importPublicKeyPem(publicKeyPem);
            if (cryptoKey) {
              activityPubPublicKey = new CryptographicKey({
                id: new URL(`${actorId}#main-key`),
                owner: new URL(actorId),
                publicKey: cryptoKey,
              });
            } else {
              this.logger.warn("[fedify] actor dispatcher: failed to import publicKeyPem", {
                identifier,
              });
            }
          }

          // ---------- URL field ----------
          // Trust the URL returned by ActivityPods only if it is a valid URL.
          // Fall back to the canonical sidecar URL otherwise.
          let actorUrl: URL;
          try {
            actorUrl = new URL((doc["url"] as string | undefined) ?? actorId);
          } catch {
            actorUrl = new URL(actorId);
          }

          return new Person({
            id: new URL(actorId),
            name: (doc["name"] as string | undefined) ?? identifier,
            preferredUsername: identifier,
            // All collection/inbox URLs resolve through the sidecar's own domain,
            // not ActivityPods directly, so remote servers POST to the sidecar.
            inbox: new URL(`https://${ctx.data.domain}/users/${identifier}/inbox`),
            outbox: new URL(`https://${ctx.data.domain}/users/${identifier}/outbox`),
            followers: new URL(`https://${ctx.data.domain}/users/${identifier}/followers`),
            following: new URL(`https://${ctx.data.domain}/users/${identifier}/following`),
            featured: new URL(`https://${ctx.data.domain}/users/${identifier}/featured`),
            featuredTags: new URL(`https://${ctx.data.domain}/users/${identifier}/featuredTags`),
            url: actorUrl,
            // Conditionally include publicKey only when successfully imported.
            ...(activityPubPublicKey != null ? { publicKey: activityPubPublicKey } : {}),
          });
        } catch (err: unknown) {
          // Distinguish fetch/network errors from unexpected bugs.
          this.logger.error("[fedify] actor dispatcher: unhandled error", {
            identifier,
            err: String(err),
          });
          return null;
        }
      }
    );
  }

  private registerCollectionDispatchers(
    federation: Federation<SidecarContext>,
  ): void {
    federation.setOutboxDispatcher(
      "/users/{identifier}/outbox",
      async (ctx, identifier) => this.resolveSyntheticCollection(ctx, identifier, "outbox"),
    );
    federation.setFollowersDispatcher(
      "/users/{identifier}/followers",
      async (ctx, identifier) => this.resolveSyntheticCollection(ctx, identifier, "followers"),
    );
    federation.setFollowingDispatcher(
      "/users/{identifier}/following",
      async (ctx, identifier) => this.resolveSyntheticCollection(ctx, identifier, "following"),
    );
    federation.setFeaturedDispatcher(
      "/users/{identifier}/featured",
      async (ctx, identifier) => this.resolveSyntheticCollection(ctx, identifier, "featured"),
    );
    federation.setFeaturedTagsDispatcher(
      "/users/{identifier}/featuredTags",
      async (ctx, identifier) => this.resolveSyntheticCollection(ctx, identifier, "featuredTags"),
    );
  }

  private async resolveSyntheticCollection(
    ctx: Context<SidecarContext>,
    identifier: string,
    collection: "outbox" | "followers" | "following" | "featured" | "featuredTags",
  ): Promise<{ items: [] } | null> {
    if (!IDENTIFIER_PATTERN.test(identifier)) {
      this.logger.warn("[fedify] collection dispatcher: rejected invalid identifier", {
        collection,
        identifier: identifier.slice(0, 64),
      });
      return null;
    }

    const actor = await this.fetchActivityPodsActorDocument(ctx, identifier);
    if (actor == null) {
      return null;
    }

    return { items: [] };
  }

  private async fetchActivityPodsActorDocument(
    ctx: Context<SidecarContext>,
    identifier: string,
  ): Promise<Record<string, unknown> | null> {
    const resp = await fetch(
      `${ctx.data.activityPodsUrl}/api/internal/actors/${encodeURIComponent(identifier)}`,
      {
        headers: {
          Accept: "application/activity+json",
          Authorization: `Bearer ${ctx.data.activityPodsToken}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (resp.status === 404) {
      return null;
    }

    if (!resp.ok) {
      this.logger.warn("[fedify] ActivityPods actor lookup returned non-OK response", {
        identifier,
        status: resp.status,
      });
      return null;
    }

    return (await resp.json()) as Record<string, unknown>;
  }

  // --------------------------------------------------------------------------
  // Inbox listeners (stub — ActivityPods handles actual inbox processing)
  // --------------------------------------------------------------------------

  private registerInboxListeners(
    federation: Federation<SidecarContext>
  ): void {
    federation
      .setInboxListeners("/users/{identifier}/inbox", "/inbox")
      .withIdempotency("per-inbox")
      .on(Activity, async (ctx, activity) => {
        await this.enqueueVerifiedActivity(ctx, activity);
      })
      .onError((_ctx, error) => {
        this.logger.error("[fedify] inbox listener error", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async enqueueVerifiedActivity(
    ctx: InboxContext<SidecarContext>,
    activity: Activity
  ): Promise<void> {
    const enqueueVerifiedInbox = ctx.data.enqueueVerifiedInbox;
    if (!enqueueVerifiedInbox) {
      throw new Error("Fedify verified inbox queue callback is not configured");
    }

    const activityActorUri = activity.actorId?.href ?? null;
    const verifiedActorUri = activityActorUri;

    if (!verifiedActorUri) {
      throw new Error("Verified inbound activity is missing a resolvable actor URI");
    }

    const recipient = ctx.recipient;
    const path = recipient == null
      ? "/inbox"
      : this.buildRecipientInboxPath(recipient);
    const body = JSON.stringify(await activity.toJsonLd());
    const enqueueResult = await enqueueVerifiedInbox({
      path,
      body,
      remoteIp: ctx.data.remoteIp,
      verifiedActorUri,
      verifiedAt: Date.now(),
    });

    this.logger.info("[fedify] queued verified inbound activity", {
      activityId: activity.id?.href,
      activityType: activity.constructor.name,
      recipient: this.safeRecipientForLog(recipient),
      actorUri: verifiedActorUri,
      envelopeId:
        enqueueResult && typeof enqueueResult === "object" && "envelopeId" in enqueueResult
          ? enqueueResult.envelopeId
          : undefined,
    });
  }

  private buildRecipientInboxPath(recipient: string): string {
    if (!IDENTIFIER_PATTERN.test(recipient)) {
      throw new Error("Inbox recipient identifier failed validation");
    }
    return `/users/${recipient}/inbox`;
  }

  private safeRecipientForLog(recipient: string | null): string | null {
    if (recipient == null) return null;
    return recipient.slice(0, 64);
  }

  // --------------------------------------------------------------------------
  // NodeInfo
  // --------------------------------------------------------------------------

  private registerNodeInfo(federation: Federation<SidecarContext>): void {
    // Fedify 2.x: software.version is a plain string (SemVer type removed).
    federation.setNodeInfoDispatcher("/nodeinfo/2.1", async (_ctx) => ({
      software: {
        name: "mastopod-federation-sidecar",
        version: "6.5.0",
        homepage: new URL("https://github.com/activitypods/mastopod"),
      },
      protocols: ["activitypub"],
      usage: {
        users: { total: 0, activeMonth: 0, activeHalfyear: 0 },
        localPosts: 0,
        localComments: 0,
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a FedifyFederationAdapter from a Redis ioredis client.
 *
 * Usage in index.ts:
 *
 *   import Redis from "ioredis";
 *   import { FedifyKvAdapter } from "./federation/FedifyKvAdapter.js";
 *   import { createFedifyAdapter } from "./federation/FedifyFederationAdapter.js";
 *
 *   const redis = new Redis(redisUrl);
 *   const kv = new FedifyKvAdapter(redis);
 *   const fedifyAdapter = createFedifyAdapter(kv, {
 *     domain: config.domain,
 *     activityPodsUrl: config.activityPodsUrl,
 *     activityPodsToken: config.activityPodsToken,
 *   }, logger);
 *
 *   // Pass to workers:
 *   createOutboundWorker(..., { adapter: fedifyAdapter, fedifyRuntimeIntegrationEnabled: true })
 *
 *   // Register with Fastify:
 *   registerFedifyRoutes(app, fedifyAdapter);
 */
export function createFedifyAdapter(
  kv: KvStore,
  config: FedifyAdapterConfig,
  logger?: FedifyAdapterLogger
): FedifyFederationAdapter {
  return new FedifyFederationAdapter(kv, config, logger);
}
