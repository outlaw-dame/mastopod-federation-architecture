import type { AtBlobRef } from "../../blob/AtBlobStore.js";

export interface ResolvedAttachmentMedia {
  mimeType: string;
  bytes?: Uint8Array;
  blobRef?: AtBlobRef;
}

export interface AttachmentMediaResolver {
  resolveMedia(did: string, mediaId: string): Promise<ResolvedAttachmentMedia | null>;
}
