import type {
  SignRequest,
  SignResult,
} from "./signing-client.js";
import type { HttpRequestSigningPort } from "./HttpRequestSigningPort.js";
import type { SidecarLocalSigningService } from "./SidecarLocalSigningService.js";

export type ActorAuthorityClass = "activitypods_pod_actor" | "sidecar_service_actor";

export interface SidecarServiceActorBinding {
  actorUri: string;
  identifier: string;
}

export interface ActorAuthoritySigningRouterOptions {
  sidecarServiceActors: readonly SidecarServiceActorBinding[];
  /**
   * Public hostname (optionally including a port) whose Fedify actor dispatcher
   * serves `/users/{identifier}`. Defaults to DOMAIN, then localhost.
   *
   * This is an authority boundary, not a presentation setting: locally signed
   * service actors must be exactly discoverable from the same public authority
   * that publishes their verification key.
   */
  sidecarPublicDomain?: string;
}

/**
 * Routes ActivityPub HTTP signing by actor authority class.
 *
 * This is deliberately fail-closed across key domains:
 * - explicitly configured sidecar service actors MUST use the sidecar-local key;
 * - all other actors are delegated to ActivityPods, whose signing API performs
 *   the exact local account/actor/key authority checks for pod/user actors;
 * - a local service-signer failure never falls back to ActivityPods, because
 *   that would silently move a service identity across a private-key boundary.
 *
 * Sidecar-owned actor bindings are additionally constrained to the exact
 * Fedify-served `/users/{identifier}` URI on the configured public domain.
 * This prevents AP_RELAY_LOCAL_ACTOR_URI (or another future binding source)
 * from selecting an arbitrary host/path whose key is not actually
 * dereferenceable from the sidecar actor dispatcher.
 *
 * Actor IRIs are compared exactly after URL-shape validation. We intentionally
 * do not normalize trailing slashes, dot segments, host spelling, or other URI
 * syntax at this authority boundary because distinct ActivityPub IRIs identify
 * distinct resources and must never collapse into the same key domain.
 */
export class ActorAuthoritySigningRouter implements HttpRequestSigningPort {
  private readonly serviceActorIdentifiers = new Map<string, string>();

  constructor(
    private readonly activityPodsSigner: HttpRequestSigningPort,
    private readonly sidecarSigner: Pick<SidecarLocalSigningService, "signHttpRequest">,
    options: ActorAuthoritySigningRouterOptions,
  ) {
    const publicDomain = resolveSidecarPublicDomain(options.sidecarPublicDomain);

    for (const binding of options.sidecarServiceActors) {
      const identifier = validateServiceActorIdentifier(binding.identifier);
      const actorUri = validateSidecarServiceActorUri(binding.actorUri, identifier, publicDomain);
      if (this.serviceActorIdentifiers.has(actorUri)) {
        throw new Error(`duplicate sidecar service actor binding: ${actorUri}`);
      }
      this.serviceActorIdentifiers.set(actorUri, identifier);
    }
  }

  classifyActor(actorUri: string): ActorAuthorityClass {
    const exactActorUri = validateActorUriExact(actorUri);
    return this.serviceActorIdentifiers.has(exactActorUri)
      ? "sidecar_service_actor"
      : "activitypods_pod_actor";
  }

  async signOne(req: Omit<SignRequest, "requestId">): Promise<SignResult> {
    const exactActorUri = validateActorUriExact(req.actorUri);
    const serviceIdentifier = this.serviceActorIdentifiers.get(exactActorUri);

    if (!serviceIdentifier) {
      return this.activityPodsSigner.signOne(req);
    }

    const requestId = `local-sig-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const signed = await this.sidecarSigner.signHttpRequest({
        actorUri: exactActorUri,
        identifier: serviceIdentifier,
        method: req.method,
        targetUrl: req.targetUrl,
        ...(req.body !== undefined ? { body: req.body } : {}),
      });

      return {
        requestId,
        ok: true,
        signedHeaders: {
          date: signed.date,
          signature: signed.signature,
          ...(signed.digest ? { digest: signed.digest } : {}),
        },
        meta: {
          keyId: `${exactActorUri}#main-key`,
          algorithm: "rsa-sha256",
          signedHeaders: signed.digest
            ? "(request-target) host date digest"
            : "(request-target) host date",
        },
      };
    } catch (error) {
      return {
        requestId,
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "sidecar service actor signing failed",
          retryable: true,
        },
      };
    }
  }
}

function resolveSidecarPublicDomain(explicitDomain: string | undefined): string {
  const domain = explicitDomain?.trim() || process.env["DOMAIN"]?.trim() || "localhost";

  let parsed: URL;
  try {
    parsed = new URL(`https://${domain}`);
  } catch {
    throw new Error(`sidecar public domain is invalid: ${domain}`);
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.host !== domain
  ) {
    throw new Error(`sidecar public domain must be an exact host[:port]: ${domain}`);
  }

  return domain;
}

function validateServiceActorIdentifier(identifierValue: string): string {
  const identifier = identifierValue.trim();
  if (!identifier) {
    throw new Error("sidecar service actor identifier is empty");
  }
  if (identifier !== identifierValue) {
    throw new Error(`sidecar service actor identifier must be exact: ${identifierValue}`);
  }
  if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(identifier)) {
    throw new Error(`sidecar service actor identifier is invalid: ${identifier}`);
  }
  return identifier;
}

function validateSidecarServiceActorUri(
  actorUriValue: string,
  identifier: string,
  publicDomain: string,
): string {
  const actorUri = validateActorUriExact(actorUriValue);
  const expectedActorUri = `https://${publicDomain}/users/${identifier}`;
  if (actorUri !== expectedActorUri) {
    throw new Error(
      `sidecar service actor URI must exactly match the Fedify-served actor URI: ${expectedActorUri}`,
    );
  }
  return actorUri;
}

function validateActorUriExact(actorUri: string): string {
  if (typeof actorUri !== "string" || actorUri.length === 0 || actorUri !== actorUri.trim()) {
    throw new Error("actorUri must be a non-empty exact URI without surrounding whitespace");
  }

  let parsed: URL;
  try {
    parsed = new URL(actorUri);
  } catch {
    throw new Error("actorUri must be an absolute HTTP(S) URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`unsupported actor URI protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("actorUri must not contain credentials, query, or fragment");
  }

  return actorUri;
}
