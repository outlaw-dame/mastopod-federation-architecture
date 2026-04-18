/**
 * FEP-c648: Blocked Collection — Fastify bridge.
 *
 *   GET /users/:identifier/blocked
 *
 * Per FEP-c648, each actor MAY expose a `blocked` OrderedCollection.  The
 * collection is private by default and accessible only to the collection owner.
 *
 * This file provides two exports:
 *
 *   1. `injectBlockedProperty(requestPath, body, domain)`
 *      Injects the `blocked` URL and the FEP-c648 JSON-LD context term into
 *      an AP actor document body.  Called by FedifyFastifyBridge.fedifyHandler
 *      for actor document responses.
 *
 *   2. `registerBlockedCollectionRoutes(app, opts)`
 *      Serves `GET /users/:identifier/blocked` with HTTP Signature authentication.
 *      Only the collection owner's own key is accepted.  Proxies the blocked
 *      actor list from the ActivityPods internal API.
 *
 * Spec: https://codeberg.org/fediverse/fep/src/branch/main/fep/c648/fep-c648.md
 */

import { createVerify, createHash } from "node:crypto";
import { request } from "undici";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../../utils/logger.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * The JSON-LD context URL for FEP-c648 (Blocked Collection).
 * Adds the `blocked` term to the JSON-LD context.
 */
const FEP_C648_CONTEXT_URL = "https://w3id.org/fep/c648";

/**
 * Matches bare actor document paths: /users/{identifier}
 * Does NOT match sub-paths like /users/alice/followers.
 */
const ACTOR_PATH_RE = /^\/users\/([^/?#]+)$/;

/** Permitted characters for a local actor identifier. */
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

// ============================================================================
// Actor document injection (called from FedifyFastifyBridge)
// ============================================================================

/**
 * Inject the `blocked` property and FEP-c648 JSON-LD context into an AP actor
 * document body string.
 *
 * Only runs when `requestPath` (without query string) matches the actor
 * document route pattern `/users/:identifier`.  Returns the original `body`
 * unchanged in all other cases (non-actor path, non-JSON body, etc.).
 *
 * @param requestPath  The request URL path, e.g. "/users/alice" or "/users/alice?foo=bar"
 * @param body         The raw response body string from Fedify.
 * @param domain       The local domain, e.g. "example.com".
 */
export function injectBlockedProperty(
  requestPath: string,
  body: string,
  domain: string,
): string {
  // Strip query string before testing the path.
  const path = requestPath.split("?")[0] ?? requestPath;
  const match = ACTOR_PATH_RE.exec(path);
  if (!match || !match[1]) return body;

  const identifier = match[1];

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }

  // Only augment actor-type documents.
  const docType = doc["type"] ?? doc["@type"];
  if (docType == null) return body;

  // Inject the blocked collection URL.
  doc["blocked"] = `https://${domain}/users/${encodeURIComponent(identifier)}/blocked`;

  // Extend @context to include the FEP-c648 context term.
  const existingCtx = doc["@context"];
  if (Array.isArray(existingCtx)) {
    if (!existingCtx.includes(FEP_C648_CONTEXT_URL)) {
      existingCtx.push(FEP_C648_CONTEXT_URL);
    }
  } else if (existingCtx != null) {
    doc["@context"] = [existingCtx, FEP_C648_CONTEXT_URL];
  } else {
    doc["@context"] = [FEP_C648_CONTEXT_URL];
  }

  try {
    return JSON.stringify(doc);
  } catch {
    return body;
  }
}

// ============================================================================
// HTTP-Signature helpers (shared pattern from FollowersSyncFastifyBridge.ts)
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
  const pk = doc["publicKey"];
  if (typeof pk === "object" && pk !== null) {
    const pem = (pk as Record<string, unknown>)["publicKeyPem"];
    if (typeof pem === "string") return pem;
  }
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
// Route registration
// ============================================================================

export interface BlockedCollectionRouteOptions {
  /** ActivityPods base URL, e.g. "http://activitypods:3000" */
  activityPodsUrl: string;
  /** Bearer token for the ActivityPods internal API */
  activityPodsToken: string;
  /** Local domain, e.g. "example.com" */
  domain: string;
  userAgent?: string;
  requestTimeoutMs?: number;
}

/**
 * Register `GET /users/:identifier/blocked` on the Fastify instance.
 *
 * Must be registered BEFORE the Fedify catch-all route so it takes priority.
 */
export function registerBlockedCollectionRoutes(
  app: FastifyInstance,
  opts: BlockedCollectionRouteOptions,
): void {
  const userAgent = opts.userAgent ?? "Fedify-Sidecar/5.0 (ActivityPods)";
  const timeoutMs = opts.requestTimeoutMs ?? 10_000;
  const baseApUrl = opts.activityPodsUrl.replace(/\/$/, "");

  app.get<{ Params: { identifier: string } }>(
    "/users/:identifier/blocked",
    async (
      req: FastifyRequest<{ Params: { identifier: string } }>,
      reply: FastifyReply,
    ) => {
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

      // --- Parse Signature header ---
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

      // --- Enforce owner-only access ---
      // The keyId (without #fragment) must match the actor's own URI.
      // This prevents remote actors from reading another actor's blocked list.
      const keyIdBase = keyId.includes("#") ? keyId.split("#")[0]! : keyId;
      const expectedActorUri = `https://${opts.domain}/users/${encodeURIComponent(identifier)}`;
      if (keyIdBase !== expectedActorUri) {
        reply.status(403).send({ error: "Access denied: not the collection owner" });
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

      // --- Validate Digest header if present ---
      const digestHeader = req.headers["digest"];
      if (typeof digestHeader === "string") {
        const expectedDigest = `SHA-256=${createHash("sha256").update("").digest("base64")}`;
        if (digestHeader !== expectedDigest) {
          reply.status(401).send({ error: "Digest mismatch" });
          return;
        }
      }

      // --- Build signing string and verify ---
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

      // --- Fetch blocked actors from ActivityPods internal API ---
      const apUrl =
        `${baseApUrl}/api/internal/blocked-collection` +
        `?actorIdentifier=${encodeURIComponent(identifier)}`;

      let blockedItems: unknown[] = [];
      try {
        const resp = await request(apUrl, {
          method: "GET",
          headers: {
            authorization: `Bearer ${opts.activityPodsToken}`,
            accept: "application/json",
          },
          bodyTimeout: timeoutMs,
          headersTimeout: timeoutMs,
        });

        if (resp.statusCode === 404 || resp.statusCode === 501) {
          // ActivityPods endpoint not yet implemented — return empty collection.
          await resp.body.text();
        } else if (resp.statusCode >= 200 && resp.statusCode < 300) {
          const body = await resp.body.json() as { items?: unknown[] };
          if (Array.isArray(body.items)) {
            blockedItems = body.items.filter(
              (item): item is string => typeof item === "string",
            );
          }
        } else {
          await resp.body.text();
          logger.warn("[fep-c648] blocked-collection: ActivityPods returned unexpected status", {
            identifier,
            status: resp.statusCode,
          });
        }
      } catch (err: any) {
        logger.warn("[fep-c648] blocked-collection: ActivityPods request failed", {
          identifier,
          error: err.message,
        });
      }

      // --- Serialize as ActivityStreams OrderedCollection ---
      const collectionId = `https://${opts.domain}/users/${encodeURIComponent(identifier)}/blocked`;

      const collection = {
        "@context": [
          "https://www.w3.org/ns/activitystreams",
          FEP_C648_CONTEXT_URL,
        ],
        "type": "OrderedCollection",
        "id": collectionId,
        "attributedTo": `https://${opts.domain}/users/${encodeURIComponent(identifier)}`,
        "totalItems": blockedItems.length,
        "orderedItems": blockedItems,
      };

      reply
        .status(200)
        .header("content-type", "application/activity+json")
        .send(collection);

      logger.debug("[fep-c648] blocked collection served", {
        identifier,
        itemCount: blockedItems.length,
      });
    },
  );
}
