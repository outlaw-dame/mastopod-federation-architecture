import type { IdentityBindingRepository } from "../../core-domain/identity/IdentityBindingRepository.js";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";

export interface MentionLookup {
  did?: string | null;
  handle?: string | null;
  activityPubActorUri?: string | null;
}

export interface MentionResolver {
  resolve(lookup: MentionLookup): Promise<CanonicalActorRef | null>;
}

export class IdentityBindingMentionResolver implements MentionResolver {
  public constructor(private readonly identityRepo: IdentityBindingRepository) {}

  public async resolve(lookup: MentionLookup): Promise<CanonicalActorRef | null> {
    const binding = lookup.did
      ? await this.identityRepo.getByAtprotoDid(lookup.did)
      : lookup.handle
        ? await (this.identityRepo.findByHandle?.(lookup.handle) ?? this.identityRepo.getByAtprotoHandle(lookup.handle))
        : lookup.activityPubActorUri
          ? await this.identityRepo.getByActivityPubActorUri(lookup.activityPubActorUri)
          : null;

    if (!binding) {
      return lookup.did || lookup.handle || lookup.activityPubActorUri
        ? {
            did: lookup.did ?? null,
            handle: lookup.handle ?? null,
            activityPubActorUri: lookup.activityPubActorUri ?? null,
          }
        : null;
    }

    return {
      canonicalAccountId: binding.canonicalAccountId,
      did: binding.atprotoDid,
      handle: binding.atprotoHandle,
      activityPubActorUri: binding.activityPubActorUri,
      webId: binding.webId,
    };
  }
}
