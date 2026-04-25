/**
 * SidecarLocalSigningService
 *
 * Manages RSA-2048 key pairs for sidecar-owned service actors (e.g. the relay
 * actor). Keys are generated on first use and persisted in Redis so they
 * survive restarts — remote servers that have cached the public key continue
 * to accept signatures without needing a new key fetch.
 *
 * This service is ONLY used for actors whose identity is rooted in the sidecar
 * itself (e.g. `https://<domain>/users/relay`). User pod actors are still
 * signed by ActivityPods.
 *
 * HTTP Signature format: draft-cavage-http-signatures-12 (rsa-sha256), which
 * is what ActivityRelay / relay.fedi.buzz expects.
 */

import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface HttpSignatureResult {
  date: string;
  digest: string;
  signature: string;
}

export interface SignRequestParams {
  /** Full URI of the actor that owns the key, e.g. `https://example.com/users/relay` */
  actorUri: string;
  /** Short identifier used to look up / store the key pair, e.g. `relay` */
  identifier: string;
  method: string;
  targetUrl: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const REDIS_KEY_PREFIX = "sidecar:local:keypair:";

export class SidecarLocalSigningService {
  constructor(private readonly redis: Redis) {}

  /**
   * Returns the key pair for `identifier`, creating and persisting it if it
   * does not yet exist.
   */
  async getOrCreateKeyPair(identifier: string): Promise<LocalKeyPair> {
    const redisKey = `${REDIS_KEY_PREFIX}${identifier}`;
    const stored = await this.redis.hgetall(redisKey);

    if (
      stored &&
      typeof stored["publicKeyPem"] === "string" &&
      typeof stored["privateKeyPem"] === "string"
    ) {
      return {
        publicKeyPem: stored["publicKeyPem"],
        privateKeyPem: stored["privateKeyPem"],
      };
    }

    // Generate a new RSA-2048 key pair (PKCS#8 private, SPKI public).
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    // Persist atomically so concurrent startups don't create two different keys.
    // HSETNX would be ideal but HSET on an empty hash is safe for our use-case
    // (single sidecar instance).
    await this.redis.hset(redisKey, {
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
    });

    return { publicKeyPem: publicKey, privateKeyPem: privateKey };
  }

  /**
   * Returns only the public key PEM for embedding in an actor document.
   */
  async getPublicKeyPem(identifier: string): Promise<string> {
    const { publicKeyPem } = await this.getOrCreateKeyPair(identifier);
    return publicKeyPem;
  }

  /**
   * Signs an outbound HTTP request using the draft-cavage HTTP Signatures
   * spec (rsa-sha256), which is required by ActivityRelay / relay.fedi.buzz.
   *
   * Signed headers: `(request-target) host date digest`
   *
   * Returns the `Date`, `Digest`, and `Signature` header values ready to be
   * sent with the HTTP request.
   */
  async signHttpRequest(params: SignRequestParams): Promise<HttpSignatureResult> {
    const { privateKeyPem } = await this.getOrCreateKeyPair(params.identifier);

    const date = new Date().toUTCString();
    const bodyBytes = Buffer.from(params.body, "utf8");
    const digest = `SHA-256=${createHash("sha256").update(bodyBytes).digest("base64")}`;

    const targetUrlParsed = new URL(params.targetUrl);
    const requestTarget = `${params.method.toLowerCase()} ${targetUrlParsed.pathname}${targetUrlParsed.search}`;

    const signingString = [
      `(request-target): ${requestTarget}`,
      `host: ${targetUrlParsed.host}`,
      `date: ${date}`,
      `digest: ${digest}`,
    ].join("\n");

    const rawSignature = createSign("sha256")
      .update(signingString)
      .sign(privateKeyPem, "base64");

    const keyId = `${params.actorUri}#main-key`;
    const signatureHeader =
      `keyId="${keyId}",` +
      `headers="(request-target) host date digest",` +
      `signature="${rawSignature}",` +
      `algorithm="rsa-sha256"`;

    return { date, digest, signature: signatureHeader };
  }
}
