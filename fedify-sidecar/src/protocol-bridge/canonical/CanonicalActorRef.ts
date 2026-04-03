export interface CanonicalActorRef {
  canonicalAccountId?: string | null;
  did?: string | null;
  webId?: string | null;
  activityPubActorUri?: string | null;
  handle?: string | null;
}

export function canonicalActorIdentityKey(ref: CanonicalActorRef): string {
  return (
    ref.canonicalAccountId ??
    ref.did ??
    ref.activityPubActorUri ??
    ref.webId ??
    ref.handle ??
    "unknown-actor"
  );
}
