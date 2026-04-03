/**
 * OpenGraph metadata fetcher for AT-side link previews.
 *
 * Fetches up to MAX_READ_BYTES of the target page's HTML and extracts:
 *   og:title, og:description, og:image, og:url,
 *   twitter:title, twitter:description, twitter:image,
 *   <title>,  meta[name=description].
 *
 * Uses `undici` (already a sidecar dependency).
 * Returns null on any error (network failure, timeout, non-HTML response, etc.).
 * Rejects obvious loopback/private literal targets by default to reduce SSRF risk.
 */

import { isIP } from "node:net";
import { request } from "undici";

export interface OGMetadata {
  /** Canonical page URL (og:url, or the original URL if absent). */
  uri: string;
  /** Page title (og:title → twitter:title → <title>). */
  title: string;
  /** Short description (og:description → twitter:description → meta[name=description]). */
  description?: string;
  /** Preview image URL (og:image → twitter:image). */
  thumbUrl?: string;
}

const USER_AGENT =
  "ActivityPods-FedifySidecar/1.0 (+https://activitypods.org; +bot)";
const TIMEOUT_MS = 4_000;
const MAX_READ_BYTES = 50_000; // 50 KB is plenty to find <head> OG tags
const ALLOW_PRIVATE_PREVIEW_FETCHES_ENV = "ALLOW_PRIVATE_PREVIEW_FETCHES";

/**
 * Fetch OpenGraph metadata for the given URL.
 * Returns null when the URL cannot be fetched or lacks usable title text.
 */
export async function fetchOpenGraph(url: string): Promise<OGMetadata | null> {
  // Only allow http / https
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return null;
  }
  if (!isPreviewTargetAllowed(parsedUrl)) {
    return null;
  }

  try {
    const { statusCode, headers, body } = await request(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      },
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });

    if (statusCode < 200 || statusCode >= 300) {
      await body.dump();
      return null;
    }

    const contentType =
      typeof headers["content-type"] === "string" ? headers["content-type"] : "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    ) {
      await body.dump();
      return null;
    }

    // Read up to MAX_READ_BYTES (enough to capture <head>).
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array);
      chunks.push(buf);
      totalBytes += buf.length;
      if (totalBytes >= MAX_READ_BYTES) break;
    }
    // Discard remaining bytes without letting destroy() propagate an error.
    try { body.destroy(); } catch { /* swallow */ }
    body.on?.("error", () => { /* suppress post-destroy stream error */ });

    const html = Buffer.concat(chunks).toString("utf8");
    return parseOpenGraph(url, html);
  } catch {
    return null;
  }
}

function isPreviewTargetAllowed(parsedUrl: URL): boolean {
  if (isPrivatePreviewFetchesAllowed()) {
    return true;
  }

  const hostname = normalizeHostForIpChecks(parsedUrl.hostname);
  if (!hostname) {
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return false;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    return !isPrivateIpv4(hostname);
  }
  if (ipVersion === 6) {
    return !isPrivateIpv6(hostname);
  }

  return true;
}

function isPrivatePreviewFetchesAllowed(): boolean {
  return /^(1|true|yes)$/i.test(process.env[ALLOW_PRIVATE_PREVIEW_FETCHES_ENV] ?? "");
}

function normalizeHostForIpChecks(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map((value) => Number.parseInt(value, 10));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }

  const [first, second] = octets as [number, number, number, number];
  if (first === 0 || first === 10 || first === 127) {
    return true;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 198 && (second === 18 || second === 19)) {
    return true;
  }
  if (first >= 224) {
    return true;
  }

  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (normalized.startsWith("fe80:")) {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }

  return false;
}

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

function parseOpenGraph(originalUri: string, html: string): OGMetadata | null {
  const og = extractMetaTags(html);

  const title =
    og["og:title"] ?? og["twitter:title"] ?? extractPageTitle(html);
  if (!title) return null;

  return {
    uri: og["og:url"] ?? originalUri,
    title: title.trim().slice(0, 300),
    description:
      (
        og["og:description"] ??
        og["twitter:description"] ??
        og["description"]
      )
        ?.trim()
        .slice(0, 1000) ?? undefined,
    thumbUrl: og["og:image"] ?? og["twitter:image"] ?? undefined,
  };
}

/**
 * Extract all <meta property/name="..." content="..."> tags from HTML.
 * Handles both attribute orderings and single/double quotes.
 */
function extractMetaTags(html: string): Record<string, string> {
  const tags: Record<string, string> = {};

  // Scan every <meta ...> element
  for (const metaMatch of html.matchAll(/<meta\b([^>]*?)>/gi)) {
    const attrs = metaMatch[1] ?? "";

    const keyMatch =
      /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const valueMatch = /content\s*=\s*["']([^"']*)["']/i.exec(attrs);

    if (keyMatch && valueMatch) {
      const key = keyMatch[1]!.toLowerCase();
      const value = unescapeHtml(valueMatch[1]!);
      if (key && !tags[key]) {
        tags[key] = value;
      }
    }
  }

  return tags;
}

function extractPageTitle(html: string): string | undefined {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? unescapeHtml(m[1]?.trim() ?? "") : undefined;
}

function unescapeHtml(val: string): string {
  return val
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#(\d+);/g, (_: string, code: string) =>
      String.fromCodePoint(Number(code)),
    );
}
