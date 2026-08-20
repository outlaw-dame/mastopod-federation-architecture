import type {
  SignRequest,
  SignResult,
  SigningClient,
} from "./signing-client.js";
import type { SidecarLocalSigningService } from "./SidecarLocalSigningService.js";

export type ActorAuthorityClass = "activitypods_pod_actor" | "sidecar_service_actor";

export interface SidecarServiceActorBinding {
  actorUri: string;
  identifier: string;
}

export interface ActorAuthoritySigningRouterOptions {
  sidecarServiceActors: readonly SidecarServiceActorBinding[];
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
 */
export class ActorAuthoritySigningRouter {
  private readonly serviceActorIdentifiers = new Map<string, string>();

  constructor(
    private readonly activityPodsSigner: Pick<SigningClient, "signOne">,
    private readonly sidecarSigner: Pick<SidecarLocalSigningService, "signHttpRequest">,
    options: ActorAuthoritySigningRouterOptions,
  ) {
    for (const binding of options.sidecarServiceActors) {
      const normalized = normalizeActorUri(binding.actorUri);
      if (this.serviceActorIdentifiers.has(normalized)) {
        throw new Error(`duplicate sidecar service actor binding: ${normalized}`);
      }
      if (!binding.identifier.trim()) {
        throw new Error(`sidecar service actor identifier is empty: ${normalized}`);
      }
      this.serviceActorIdentifiers.set(normalized, binding.identifier.trim());
    }
  }

  classifyActor(actorUri: string): ActorAuthorityClass {
    return this.serviceActorIdentifiers.has(normalizeActorUri(actorUri))
      ? "sidecar_service_actor"
      : "activitypods_pod_actor";
  }

  async signOne(req: Omit<SignRequest, "requestId">): Promise<SignResult> {
    const normalizedActorUri = normalizeActorUri(req.actorUri);
    const serviceIdentifier = this.serviceActorIdentifiers.get(normalizedActorUri);

    if (!serviceIdentifier) {
      return this.activityPodsSigner.signOne(req);
    }

    const requestId = `local-sig-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const signed = await this.sidecarSigner.signHttpRequest({
        actorUri: normalizedActorUri,
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
          keyId: `${normalizedActorUri}#main-key`,
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

function normalizeActorUri(actorUri: string): string {
  if (typeof actorUri !== "string" || actorUri.trim().length === 0) {
    throw new Error("actorUri is required for signing authority routing");
  }

  const parsed = new URL(actorUri);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`unsupported actor URI protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("actorUri must not contain credentials, query, or fragment");
  }

  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  }
  return parsed.href;
}
