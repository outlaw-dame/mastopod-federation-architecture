/**
 * V6.5 Phase 7: com.atproto.sync.getBlob
 *
 * Returns an immutable blob previously uploaded to a hosted AT repository.
 *
 * Security:
 *   - DID and CID are validated before storage access.
 *   - Only locally stored blobs are served; external linked repos fail closed.
 *   - Responses are cacheable because blob CIDs are content-addressed.
 *
 * Ref: https://docs.bsky.app/docs/api/com-atproto-sync-get-blob
 */

import type { AtBlobStore } from "../../blob/AtBlobStore.js";
import { HandleResolutionReader, isValidDid } from "../../identity/HandleResolutionReader.js";
import { XrpcErrors } from "../middleware/XrpcErrorMapper.js";

export interface SyncGetBlobRouteDeps {
  blobStore: AtBlobStore;
  handleResolutionReader: HandleResolutionReader;
}

export interface SyncGetBlobResult {
  headers: Record<string, string>;
  body: Uint8Array;
}

export class SyncGetBlobRoute {
  public constructor(private readonly deps: SyncGetBlobRouteDeps) {}

  public async handle(did: string | undefined, cid: string | undefined): Promise<SyncGetBlobResult> {
    if (!did || !did.trim()) {
      throw XrpcErrors.invalidRequest("did parameter is required");
    }
    if (!cid || !cid.trim()) {
      throw XrpcErrors.invalidRequest("cid parameter is required");
    }

    const trimmedDid = did.trim();
    const trimmedCid = cid.trim();
    if (!isValidDid(trimmedDid)) {
      throw XrpcErrors.invalidDid(trimmedDid);
    }
    if (!isValidCid(trimmedCid)) {
      throw XrpcErrors.invalidRequest("cid parameter must be a non-empty CID string");
    }

    const resolved = await this.deps.handleResolutionReader.resolveRepoInput(trimmedDid);
    if (!resolved) {
      throw XrpcErrors.repoNotFound(trimmedDid);
    }

    const bytes = await this.deps.blobStore.getBlob(resolved.did, trimmedCid);
    const metadata = await this.deps.blobStore.getBlobMetadata(resolved.did, trimmedCid);
    if (!bytes || !metadata) {
      throw XrpcErrors.recordNotFound(`blob:${trimmedCid}`);
    }

    return {
      headers: {
        "Content-Type": metadata.mimeType,
        "Content-Length": String(metadata.size),
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: `"${metadata.cid}"`,
        "Content-Disposition": "inline",
      },
      body: bytes,
    };
  }
}

function isValidCid(cid: string): boolean {
  return /^[a-z0-9]+$/i.test(cid);
}
