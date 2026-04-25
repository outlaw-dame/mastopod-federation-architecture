/**
 * FEP-8fcf: Fastify route for the partial followers synchronization endpoint.
 *
 *   GET /users/:identifier/followers_synchronization
 *
 * The receiving instance calls this URL (from the `url` parameter of the
 * Collection-Synchronization header) when a digest mismatch is detected.
 * It must authenticate itself with an HTTP Signature.
 *
 * Response: ActivityStreams OrderedCollection containing the follower URIs
 * for the requesting instance.
 *
 * Authentication: We extract the requesting domain from the `keyId` field of
 * the HTTP `Signature` header.  Full cryptographic verification of the
 * signature is performed using the cached actor document store to resist
 * unauthenticated fishing for follower data.
 *
 * Spec: https://codeberg.org/fediverse/fep/src/branch/main/fep/8fcf/fep-8fcf.md
 */

import { createVerify, createHash } from "node:crypto";
import { request } from "undici";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { FollowersSyncService } from "./FollowersSyncService.js";
import { logger } from "../../utils/logger.js";

// ============================================================================
// Identifier validation (mirrors inbound-worker.ts)
// ============================================================================

/** Permitted characters for a local actor identifier. */
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

// ============================================================================
// HTTP-Signature parsing (minimal — only what we need to verify + extract keyId)
// ============================================================================

function parseSignatureHeader(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined && m[2] !== undefined) {
      params[m[1]] = m[2];
    }
  }
  return params;
}

function extractDomainFromKeyId(keyId: string): string | null {
  try {
    return new URL(keyId).hostname;
  } catch {
    return null;
  }
}

// ============================================================================
// Signature verification helpers (mirrors inbound-worker.ts approach)
// ============================================================================

async function fetchActorDocumentForKey(
  keyId: string,
  userAgent: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const fetchUrl = keyId.includes("#") ? keyId.split("#")[0]! : keyId;
  try {
    const resp = await request(fetchUrl, {
      method: "GET",
      headers: {
        accept: "application/activity+json, application/ld+json",
        "user-agent": userAgent,
      },
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      maxRedirections: 3,
    });
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      await resp.body.text();
      return null;
    }
    return await resp.body.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractPublicKeyPem(doc: Record<string, unknown>): string | null {
  // Key document (keyId pointed directly at a key object)
  const pk = doc["publicKey"];
  if (typeof pk === "object" && pk !== null) {
    const pem = (pk as Record<string, unknown>)["publicKeyPem"];
    if (typeof pem === "string") return pem;
  }
  // Actor document with embedded publicKey
  if (typeof doc["publicKeyPem"] === "string") return doc["publicKeyPem"];
  return null;
}

function buildSigningString(
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  signedHeaderNames: string[],
): string {
  const lines: string[] = [];
  for (const name of signedHeaderNames) {
    const lower = name.toLowerCase();
    if (lower === "(request-target)") {
      lines.push(`(request-target): ${method.toLowerCase()} ${path}`);
    } else {
      const val = headers[lower];
      if (val !== undefined) {
        lines.push(`${lower}: ${Array.isArray(val) ? val[0] : val}`);
      }
    }
  }
  return lines.join("\n");
}

// ============================================================================
// Route handler
// ============================================================================

interface FollowersSyncRouteOptions {
  service: FollowersSyncService;
  domain: string;
  userAgent?: string;
  requestTimeoutMs?: number;
}

/**
 * Register `GET /users/:identifier/followers_synchronization` on the Fastify
 * instance.
 *
 * Must be registered BEFORE the Fedify catch-all route so it takes priority.
 */
export function registerFollowersSyncRoutes(
  app: FastifyInstance,
  opts: FollowersSyncRouteOptions,
): void {
  const userAgent = opts.userAgent ?? "Fedify-Sidecar/5.0 (ActivityPods)";
  const timeoutMs = opts.requestTimeoutMs ?? 10_000;

  app.get<{ Params: { identifier: string } }>(
    "/users/:identifier/followers_synchronization",
    async (req: FastifyRequest<{ Params: { identifier: string } }>, reply: FastifyReply) => {
      const { identifier } = req.params;

      // --- Input validation ---
      if (!IDENTIFIER_PATTERN.test(identifier)) {
        reply.status(400).send({ error: "Invalid actor identifier" });
        return;
      }

      // --- Require a Signature header ---
      const rawSignature = req.headers["signature"];
      if (typeof rawSignature !== "string" || rawSignature.length === 0) {
        reply.status(401).send({ error: "HTTP Signature required" });
        return;
      }

      // --- Parse the Signature header to extract keyId ---
      const sigParams = parseSignatureHeader(rawSignature);
      const keyId = sigParams["keyId"];
      const signatureB64 = sigParams["signature"];
      const signedHeadersRaw = sigParams["headers"];

      if (
        typeof keyId !== "string" || keyId.length === 0 ||
        typeof signatureB64 !== "string" ||
        typeof signedHeadersRaw !== "string"
      ) {
        reply.status(401).send({ error: "Malformed HTTP Signature" });
        return;
      }

      // --- Fetch the actor/key document to get the public key ---
      const actorDoc = await fetchActorDocumentForKey(keyId, userAgent, timeoutMs);
      if (!actorDoc) {
        reply.status(401).send({ error: "Could not fetch signing key document" });
        return;
      }

      const publicKeyPem = extractPublicKeyPem(actorDoc);
      if (!publicKeyPem) {
        reply.status(401).send({ error: "No public key in key document" });
        return;
      }

      // --- Verify Digest header if present ---
      const digestHeader = req.headers["digest"];
      if (typeof digestHeader === "string") {
        // GET requests have no body, so a Digest header would be unusual, but
        // validate it anyway if present.
        const expectedDigest = `SHA-256=${createHash("sha256").update("").digest("base64")}`;
        if (digestHeader !== expectedDigest) {
          reply.status(401).send({ error: "Digest mismatch" });
          return;
        }
      }

      // --- Build the signing string and verify ---
      const path = req.url;
      const rawHeaders = req.headers as Record<string, string | string[] | undefined>;
      const signingString = buildSigningString(
        "GET",
        path,
        rawHeaders,
        signedHeadersRaw.split(" "),
      );

      try {
        const verifier = createVerify("RSA-SHA256");
        verifier.update(signingString);
        const isValid = verifier.verify(publicKeyPem, signatureB64, "base64");
        if (!isValid) {
          reply.status(401).send({ error: "Signature verification failed" });
          return;
        }
      } catch {
        reply.status(401).send({ error: "Signature verification error" });
        return;
      }

      // --- Determine requesting domain from verified keyId ---
      const requestingDomain = extractDomainFromKeyId(keyId);
      if (!requestingDomain) {
        reply.status(400).send({ error: "Cannot determine requesting domain from keyId" });
        return;
      }

      // --- Fetch partial followers from ActivityPods ---
      let followers: string[];
      try {
        followers = await opts.service.getPartialFollowersCollection(
          identifier,
          requestingDomain,
        );
      } catch (err: any) {
        logger.error("[fep8fcf] followers_synchronization: error fetching partial collection", {
          identifier,
          requestingDomain,
          error: err.message,
        });
        reply.status(500).send({ error: "Internal server error" });
        return;
      }

      // --- Serialize as ActivityStreams OrderedCollection ---
      const collectionId = `https://${opts.domain}/users/${encodeURIComponent(identifier)}/followers_synchronization`;

      const collection = {
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "OrderedCollection",
        "id": collectionId,
        "totalItems": followers.length,
        "orderedItems": followers,
      };

      reply
        .status(200)
        .header("content-type", "application/activity+json")
        .send(collection);

      logger.debug("[fep8fcf] followers_synchronization served", {
        identifier,
        requestingDomain,
        followerCount: followers.length,
      });
    },
  );
}
