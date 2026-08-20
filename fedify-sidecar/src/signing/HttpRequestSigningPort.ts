import type { SignRequest, SignResult } from "./signing-client.js";

/**
 * Minimal ActivityPub HTTP-signing capability used by remote-fetch consumers.
 *
 * Consumers intentionally depend only on this port rather than the concrete
 * ActivityPods SigningClient so actor-authority routing can be inserted without
 * casts and without exposing ATProto or batch-signing methods they do not use.
 */
export interface HttpRequestSigningPort {
  signOne(req: Omit<SignRequest, "requestId">): Promise<SignResult>;
}
