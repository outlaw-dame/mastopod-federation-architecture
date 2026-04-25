/**
 * FEP-eb48: Hashtags — Fastify bridge for the tag document endpoint.
 *
 *   GET /tags/:tag
 *
 * Provides a resolvable URL for the `href` field of `Hashtag` tag objects
 * emitted in AP activities.  Remote AP servers and clients may fetch this URL
 * to discover more about a tag or to verify the tag's canonical identity.
 *
 * Content negotiation:
 *   - `Accept: application/activity+json` or `application/ld+json`
 *       → 200 ActivityStreams Hashtag document
 *   - All other Accept values
 *       → 302 redirect to a tag search URL (or 200 minimal HTML if no
 *           search URL is configured)
 *
 * Valid tag names follow the sidecar hashtag grammar:
 *   - Unicode letters/numbers across scripts
 *   - Optional connector punctuation and Fediverse separators (middle dots, ZWNJ)
 *   - Must contain at least one letter-like code point
 *
 * Spec: https://codeberg.org/fediverse/fep/src/branch/main/fep/eb48/fep-eb48.md
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { normalizeHashtag } from "../utils/hashtags.js";

// ============================================================================
// Constants
// ============================================================================

const AP_CONTENT_TYPES = new Set([
  "application/activity+json",
  "application/ld+json",
  "application/json",
]);

// ============================================================================
// Route registration
// ============================================================================

export interface HashtagRouteOptions {
  /** Local domain, e.g. "example.com" */
  domain: string;
  /**
   * Optional base URL for tag search redirects.
   * When provided, browser requests are redirected to
   * `${searchBaseUrl}?tag={name}` (or similar).
   * When omitted, browser requests receive a minimal HTML response.
   */
  searchBaseUrl?: string;
}

/**
 * Register `GET /tags/:tag` on the Fastify instance.
 *
 * Must be registered BEFORE the Fedify catch-all route.
 */
export function registerHashtagRoutes(
  app: FastifyInstance,
  opts: HashtagRouteOptions,
): void {
  app.get<{ Params: { tag: string } }>(
    "/tags/:tag",
    async (
      req: FastifyRequest<{ Params: { tag: string } }>,
      reply: FastifyReply,
    ) => {
      const rawTag = req.params.tag;
      const tagBody = normalizeHashtag(rawTag, { allowMissingHash: true });

      if (!tagBody) {
        reply.status(400).send({ error: "Invalid hashtag" });
        return;
      }

      const tagId = `https://${opts.domain}/tags/${encodeURIComponent(tagBody)}`;

      // Content negotiation: serve AP document to AP clients.
      const accept = req.headers["accept"] ?? "";
      const wantsAp = AP_CONTENT_TYPES.has(accept.split(",")[0]?.split(";")[0]?.trim() ?? "");

      if (wantsAp) {
        const document = {
          "@context": "https://www.w3.org/ns/activitystreams",
          "id": tagId,
          "type": "Hashtag",
          "name": `#${tagBody}`,
        };

        reply
          .status(200)
          .header("content-type", "application/activity+json; charset=utf-8")
          .header("cache-control", "public, max-age=300")
          .send(document);
        return;
      }

      // Browser / non-AP clients: redirect to tag search if configured,
      // otherwise serve a minimal HTML page.
      if (opts.searchBaseUrl) {
        const searchUrl = `${opts.searchBaseUrl}?tag=${encodeURIComponent(tagBody)}`;
        reply
          .status(302)
          .header("location", searchUrl)
          .send();
        return;
      }

      // Minimal HTML fallback.
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>#${escapeHtml(tagBody)}</title>
</head>
<body>
  <h1><a href="${escapeAttr(tagId)}">#${escapeHtml(tagBody)}</a></h1>
  <p>Posts tagged with <strong>#${escapeHtml(tagBody)}</strong>.</p>
</body>
</html>`;

      reply
        .status(200)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "public, max-age=300")
        .send(html);
    },
  );
}

// ============================================================================
// HTML escape helpers
// ============================================================================

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
