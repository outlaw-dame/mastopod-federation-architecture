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
 * Authentication: We extract the requesting server base URI from the `keyId`
 * field of the HTTP `Signature` header. Full cryptographic verification of the
 * signature is performed only after the remote key document has crossed the
 * shared ActivityPub egress policy and bounded response parser.
 *
 * Spec: https://codeberg.org/fediverse/fep/src/branch/main/fep/8fcf/fep-8fcf.md
 */

import { createVerify, createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { FollowersSyncService } from "./FollowersSyncService.js";
import { fetchRemoteKeyDocument } from "./RemoteKeyDocumentFetcher.js";
import { logger } from "../../utils/logger.js";

// ============================================================================
// Identifier and header validation
// ============================================================================

/** Permitted characters for a local actor identifier. */
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const MAX_SIGNATURE_HEADER_BYTES = 32 * 1024;
const MAX_SIGNATURE_VALUE_BYTES = 16 * 1024;
const MAX_SIGNED_HEADERS_BYTES = 1024;

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

function extractServerBaseUriFromKeyId(keyId: string): string | null {
  try {
    const parsed = new URL(keyId);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      return null;
    }
    return `${parsed.origin}/`;
  } catch {
    return null;
  }
}

function withinUtf8Limit(value: string, maxBytes: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maxBytes;
}

// ============================================================================
// Signature verification helper
// ============================================================================

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

      // --- Require and bound the Signature header before parsing ---
      const rawSignature = req.headers["signature"];
      if (
        typeof rawSignature !== "string"
        || rawSignature.length === 0
        || !withinUtf8Limit(rawSignature, MAX_SIGNATURE_HEADER_BYTES)
      ) {
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
        typeof signedHeadersRaw !== "string" ||
        !withinUtf8Limit(signatureB64, MAX_SIGNATURE_VALUE_BYTES) ||
        !withinUtf8Limit(signedHeadersRaw, MAX_SIGNED_HEADERS_BYTES)
      ) {
        reply.status(401).send({ error: "Malformed HTTP Signature" });
        return;
      }

      // --- Fetch the key document through the shared pinned-DNS egress policy ---
      const keyDocument = await fetchRemoteKeyDocument(keyId, {
        userAgent,
        timeoutMs,
      });
      if (!keyDocument) {
        reply.status(401).send({ error: "Could not fetch signing key document" });
        return;
      }
      const publicKeyPem = keyDocument.publicKeyPem;

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

      // --- Determine requesting server base URI from verified keyId ---
      const requestingBaseUri = extractServerBaseUriFromKeyId(keyId);
      if (!requestingBaseUri) {
        reply.status(400).send({ error: "Cannot determine requesting server base URI from keyId" });
        return;
      }

      // --- Fetch partial followers from ActivityPods ---
      let followers: string[];
      try {
        followers = await opts.service.getPartialFollowersCollection(
          identifier,
          requestingBaseUri,
        );
      } catch (err: any) {
        logger.error("[fep8fcf] followers_synchronization: error fetching partial collection", {
          identifier,
          requestingBaseUri,
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
        requestingBaseUri,
        followerCount: followers.length,
      });
    },
  );
}
