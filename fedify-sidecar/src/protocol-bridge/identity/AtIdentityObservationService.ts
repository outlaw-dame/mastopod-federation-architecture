import type { IdentityBindingRepository } from "../../core-domain/identity/IdentityBindingRepository.js";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { ResolvedAtIdentityDocument } from "../../at-adapter/ingress/HttpAtIdentityResolver.js";
import type {
  AtIdentityObservationOutcome,
  ObservedAtIdentityStore,
} from "./ObservedAtIdentityStore.js";

export interface AtIdentityDocumentResolver {
  resolveDocument(did: string): Promise<ResolvedAtIdentityDocument>;
}

export interface AtIdentityObservationLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: AtIdentityObservationLogger = {
  warn: () => undefined,
};

export class AtIdentityObservationService {
  public constructor(
    private readonly store: ObservedAtIdentityStore,
    private readonly identityRepo: IdentityBindingRepository,
    private readonly resolver?: AtIdentityDocumentResolver,
    private readonly logger: AtIdentityObservationLogger = NOOP_LOGGER,
  ) {}

  public async observeActor(
    actor: CanonicalActorRef,
    outcome: AtIdentityObservationOutcome,
    observedAt: string,
  ): Promise<void> {
    const did = actor.did?.trim();
    if (!did) {
      return;
    }

    let binding = await this.identityRepo.getByAtprotoDid(did).catch(() => null);
    let handle = actor.handle?.trim() || binding?.atprotoHandle || null;
    let pdsEndpoint = binding?.atprotoPdsEndpoint || null;
    const canonicalAccountId = binding?.canonicalAccountId ?? null;
    const activityPubActorUri = binding?.activityPubActorUri ?? actor.activityPubActorUri ?? null;
    const bound = !!activityPubActorUri;

    if ((!handle || !pdsEndpoint) && this.resolver) {
      try {
        const resolved = await this.resolver.resolveDocument(did);
        handle = handle ?? normalizeHandle(resolved.handle);
        pdsEndpoint = pdsEndpoint ?? normalizeString(resolved.pdsEndpoint);
      } catch (error) {
        this.logger.warn("Observed AT identity resolution failed", {
          did,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!binding && actor.handle) {
      binding = await this.identityRepo.getByAtprotoHandle(actor.handle).catch(() => null);
    }

    await this.store.observe({
      did,
      handle,
      pdsEndpoint,
      canonicalAccountId: binding?.canonicalAccountId ?? canonicalAccountId,
      activityPubActorUri: binding?.activityPubActorUri ?? activityPubActorUri,
      bound: !!(binding?.activityPubActorUri ?? activityPubActorUri),
      observedAt,
      outcome,
    });
  }
}

function normalizeString(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHandle(value: string | null | undefined): string | null {
  const trimmed = normalizeString(value);
  return trimmed === "handle.invalid" ? null : trimmed;
}