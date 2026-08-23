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
 * The URL authority is canonicalized the same way Fedify's URL objects are
 * (DNS case, IDN punycode, and default ports). The path spelling remains exact:
 * trailing slashes and dot segments are never collapsed at this key-authority
 * boundary, because they can identify distinct ActivityPub resources.
 */
export class ActorAuthoritySigningRouter implements HttpRequestSigningPort {
  private readonly serviceActorIdentifiers = new Map<string, string>();

  constructor(
    private readonly activityPodsSigner: HttpRequestSigningPort,
    private readonly sidecarSigner: Pick<SidecarLocalSigningService, "signHttpRequest">,
    options: ActorAuthoritySigningRouterOptions,
  ) {
    const publicDomain = canonicalizeSidecarPublicDomain(options.sidecarPublicDomain);

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
    const canonicalActorUri = canonicalizeActorAuthorityHostExactPath(actorUri);
    return this.serviceActorIdentifiers.has(canonicalActorUri)
      ? "sidecar_service_actor"
      : "activitypods_pod_actor";
  }

  async signOne(req: Omit<SignRequest, "requestId">): Promise<SignResult> {
    const canonicalActorUri = canonicalizeActorAuthorityHostExactPath(req.actorUri);
    const serviceIdentifier = this.serviceActorIdentifiers.get(canonicalActorUri);

    if (!serviceIdentifier) {
      return this.activityPodsSigner.signOne(req);
    }

    const requestId = `local-sig-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const signed = await this.sidecarSigner.signHttpRequest({
        actorUri: canonicalActorUri,
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
          keyId: `${canonicalActorUri}#main-key`,
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

export function canonicalizeSidecarPublicDomain(explicitDomain: string | undefined): string {
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
    parsed.hash
  ) {
    throw new Error(`sidecar public domain must be a host[:port] only: ${domain}`);
  }

  return parsed.host;
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
  const actorUri = canonicalizeActorAuthorityHostExactPath(actorUriValue);
  const expectedActorUri = `https://${publicDomain}/users/${identifier}`;
  if (actorUri !== expectedActorUri) {
    throw new Error(
      `sidecar service actor URI must exactly match the Fedify-served actor URI: ${expectedActorUri}`,
    );
  }
  return actorUri;
}

/**
 * Canonicalize only the URI authority component while preserving the literal
 * path spelling. `new URL(actorUri).href` cannot be used here because it also
 * removes dot segments, which would collapse distinct actor identifiers at the
 * signing authority boundary.
 */
function canonicalizeActorAuthorityHostExactPath(actorUri: string): string {
  if (typeof actorUri !== "string" || actorUri.length === 0 || actorUri !== actorUri.trim()) {
    throw new Error("actorUri must be a non-empty exact URI without surrounding whitespace");
  }

  const rawMatch = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/u.exec(actorUri);
  if (!rawMatch) {
    let parsedForError: URL | null = null;
    try {
      parsedForError = new URL(actorUri);
    } catch {
      // handled below
    }
    if (parsedForError && parsedForError.protocol !== "https:" && parsedForError.protocol !== "http:") {
      throw new Error(`unsupported actor URI protocol: ${parsedForError.protocol}`);
    }
    if (parsedForError && (parsedForError.username || parsedForError.password || parsedForError.search || parsedForError.hash)) {
      throw new Error("actorUri must not contain credentials, query, or fragment");
    }
    throw new Error("actorUri must be an absolute HTTP(S) URL");
  }

  const rawScheme = rawMatch[1];
  const rawAuthority = rawMatch[2];
  const rawPath = rawMatch[3] ?? "";
  if (!rawScheme || !rawAuthority) {
    throw new Error("actorUri must be an absolute HTTP(S) URL");
  }
  if (rawAuthority.includes("\\")) {
    throw new Error("actorUri contains an ambiguous or invalid authority");
  }

  let authorityUrl: URL;
  try {
    authorityUrl = new URL(`${rawScheme}://${rawAuthority}`);
  } catch {
    throw new Error("actorUri must be an absolute HTTP(S) URL");
  }

  if (authorityUrl.username || authorityUrl.password) {
    throw new Error("actorUri must not contain credentials, query, or fragment");
  }
  if (
    !authorityUrl.host ||
    authorityUrl.pathname !== "/" ||
    authorityUrl.search ||
    authorityUrl.hash
  ) {
    throw new Error("actorUri contains an ambiguous or invalid authority");
  }

  return `${authorityUrl.protocol}//${authorityUrl.host}${rawPath}`;
}
