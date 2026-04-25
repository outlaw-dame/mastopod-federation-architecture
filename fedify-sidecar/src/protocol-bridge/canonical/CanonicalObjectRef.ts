export interface CanonicalObjectRef {
  canonicalObjectId: string;
  atUri?: string | null;
  cid?: string | null;
  activityPubObjectId?: string | null;
  canonicalUrl?: string | null;
}

export function canonicalObjectIdentityKey(ref: CanonicalObjectRef): string {
  return ref.atUri ?? ref.activityPubObjectId ?? ref.canonicalUrl ?? ref.canonicalObjectId;
}
