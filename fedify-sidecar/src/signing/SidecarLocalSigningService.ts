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
 * HTTP Signature format: draft-cavage-http-signatures-12 (rsa-sha256).
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
  /** Present for body-bearing requests such as POST; omitted for GET. */
  digest?: string;
  signature: string;
}

export interface SignRequestParams {
  /** Full URI of the actor that owns the key, e.g. `https://example.com/users/relay` */
  actorUri: string;
  /** Short identifier used to look up / store the key pair, e.g. `relay` */
  identifier: string;
  method: string;
  targetUrl: string;
  /** Exact UTF-8 body. Omit for bodyless requests such as authenticated GET. */
  body?: string;
}

export interface SidecarLocalSigningServiceOptions {
  /**
   * Maps actor identifiers to the canonical identifier that owns their key
   * material. This lets compatibility aliases expose distinct actor URIs while
   * sharing one persisted key pair.
   */
  keyAliases?: ReadonlyMap<string, string> | Record<string, string>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const REDIS_KEY_PREFIX = "sidecar:local:keypair:";

export class SidecarLocalSigningService {
  private readonly keyAliases: Map<string, string>;

  constructor(
    private readonly redis: Redis,
    options: SidecarLocalSigningServiceOptions = {},
  ) {
    this.keyAliases = options.keyAliases instanceof Map
      ? new Map(options.keyAliases)
      : new Map(Object.entries(options.keyAliases ?? {}));
  }

  private resolveKeyIdentifier(identifier: string): string {
    return this.keyAliases.get(identifier) ?? identifier;
  }

  /**
   * Returns the key pair for `identifier`, creating and persisting it if it
   * does not yet exist.
   */
  async getOrCreateKeyPair(identifier: string): Promise<LocalKeyPair> {
    const keyIdentifier = this.resolveKeyIdentifier(identifier);
    const redisKey = `${REDIS_KEY_PREFIX}${keyIdentifier}`;
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

    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    await this.redis.hset(redisKey, {
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
    });

    return { publicKeyPem: publicKey, privateKeyPem: privateKey };
  }

  /** Returns only the public key PEM for embedding in an actor document. */
  async getPublicKeyPem(identifier: string): Promise<string> {
    const { publicKeyPem } = await this.getOrCreateKeyPair(identifier);
    return publicKeyPem;
  }

  /**
   * Signs an outbound HTTP request with the sidecar-owned actor key.
   *
   * Body-bearing requests sign `(request-target) host date digest` and return
   * a Digest header. Bodyless requests (notably authenticated GET) sign
   * `(request-target) host date` and deliberately omit Digest. This matches
   * the ActivityPods `ap_post_v1` / `ap_get_v1` authority split without moving
   * the service actor's private key across the boundary.
   */
  async signHttpRequest(params: SignRequestParams): Promise<HttpSignatureResult> {
    const { privateKeyPem } = await this.getOrCreateKeyPair(params.identifier);

    const date = new Date().toUTCString();
    const targetUrlParsed = new URL(params.targetUrl);
    const requestTarget = `${params.method.toLowerCase()} ${targetUrlParsed.pathname}${targetUrlParsed.search}`;
    const hasBody = params.body !== undefined;

    const signingLines = [
      `(request-target): ${requestTarget}`,
      `host: ${targetUrlParsed.host}`,
      `date: ${date}`,
    ];

    let digest: string | undefined;
    if (hasBody) {
      const bodyBytes = Buffer.from(params.body ?? "", "utf8");
      digest = `SHA-256=${createHash("sha256").update(bodyBytes).digest("base64")}`;
      signingLines.push(`digest: ${digest}`);
    }

    const signedHeaders = hasBody
      ? "(request-target) host date digest"
      : "(request-target) host date";

    const rawSignature = createSign("sha256")
      .update(signingLines.join("\n"))
      .sign(privateKeyPem, "base64");

    const keyId = `${params.actorUri}#main-key`;
    const signatureHeader =
      `keyId="${keyId}",` +
      `headers="${signedHeaders}",` +
      `signature="${rawSignature}",` +
      `algorithm="rsa-sha256"`;

    return {
      date,
      ...(digest ? { digest } : {}),
      signature: signatureHeader,
    };
  }
}
