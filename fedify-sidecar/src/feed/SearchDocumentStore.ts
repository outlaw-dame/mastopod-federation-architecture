import type { PublicContentDocument } from "../search/models/PublicContentDocument.js";

export interface SearchDocumentLookupInput {
  stableIds: Set<string>;
  canonicalUris: Set<string>;
  activityPubObjectIds: Set<string>;
}

export interface SearchDocumentStore {
  fetchByStableIds(stableDocIds: string[]): Promise<Map<string, PublicContentDocument>>;
  fetchByIdentifiers(input: SearchDocumentLookupInput): Promise<PublicContentDocument[]>;
}