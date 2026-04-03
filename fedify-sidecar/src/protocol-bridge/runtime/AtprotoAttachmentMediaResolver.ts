import type { AtBlobUploadService } from "../../at-adapter/blob/AtBlobUploadService.js";
import type { AtAttachmentMediaHint } from "../ports/ProtocolBridgePorts.js";
import type { AttachmentMediaResolver } from "../adapters/AtprotoWriteGatewayPort.js";
import { ActivityPubBridgeMediaClient } from "./ActivityPubBridgeMediaClient.js";

export interface AtprotoAttachmentMediaResolverLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export class AtprotoAttachmentMediaResolver implements AttachmentMediaResolver {
  public constructor(
    private readonly mediaClient: ActivityPubBridgeMediaClient,
    private readonly blobUploadService: AtBlobUploadService,
    private readonly logger?: AtprotoAttachmentMediaResolverLogger,
  ) {}

  public async resolveAttachmentBlob(
    did: string,
    attachment: AtAttachmentMediaHint,
    scope: {
      canonicalIntentId?: string | null;
      canonicalRefIdHint?: string | null;
      collection: string;
      rkey?: string | null;
    },
  ): Promise<unknown | null> {
    if (!attachment.url) {
      return null;
    }

    const resolved = await this.mediaClient.resolve(attachment.url);
    if (!resolved) {
      this.logger?.warn("Protocol bridge attachment media could not be resolved and will be rejected", {
        did,
        collection: scope.collection,
        rkey: scope.rkey ?? null,
        attachmentId: attachment.attachmentId,
        attachmentUrl: attachment.url,
        canonicalIntentId: scope.canonicalIntentId ?? null,
      });
      return null;
    }

    if (!mimeMatchesExpected(attachment.mediaType, resolved.mimeType)) {
      this.logger?.warn("Protocol bridge attachment media MIME mismatch detected", {
        did,
        collection: scope.collection,
        rkey: scope.rkey ?? null,
        attachmentId: attachment.attachmentId,
        attachmentUrl: attachment.url,
        expectedMimeType: attachment.mediaType,
        resolvedMimeType: resolved.mimeType,
        canonicalIntentId: scope.canonicalIntentId ?? null,
      });
      return null;
    }

    return this.blobUploadService.ensureBlob({
      did,
      mediaId: attachment.attachmentId,
      mimeType: resolved.mimeType,
      bytes: resolved.bytes,
    });
  }
}

function mimeMatchesExpected(expected: string, actual: string): boolean {
  const normalizedExpected = expected.trim().toLowerCase();
  const normalizedActual = actual.trim().toLowerCase();
  if (!normalizedExpected) {
    return true;
  }
  if (normalizedExpected === normalizedActual) {
    return true;
  }

  const [expectedType, expectedSubtype] = normalizedExpected.split("/", 2);
  const [actualType] = normalizedActual.split("/", 2);
  if (!expectedType || !actualType) {
    return false;
  }

  return expectedSubtype === "*" && expectedType === actualType;
}
