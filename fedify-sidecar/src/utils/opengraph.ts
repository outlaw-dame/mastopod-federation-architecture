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
 */

import { request } from "undici";
import { isIP } from "node:net";

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
const SAFE_BROWSING_TIMEOUT_MS = 2_500;
const MAX_READ_BYTES = 50_000; // 50 KB is plenty to find <head> OG tags
const ALLOW_PRIVATE_PREVIEW_FETCHES_ENV = "ALLOW_PRIVATE_PREVIEW_FETCHES";
const GOOGLE_SAFE_BROWSING_API_KEY_ENV = "GOOGLE_SAFE_BROWSING_API_KEY";
const SAFE_BROWSING_API_KEY_ENV = "SAFE_BROWSING_API_KEY";
const SAFE_BROWSING_FAIL_CLOSED_ENV = "SAFE_BROWSING_FAIL_CLOSED";

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
  if (parsedUrl.username || parsedUrl.password) {
    return null;
  }
  if (!isPreviewTargetAllowed(parsedUrl)) {
    return null;
  }
  if (!(await passesSafeBrowsing(parsedUrl.toString()))) {
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
    body.destroy();

    const html = Buffer.concat(chunks).toString("utf8");
    return parseOpenGraph(parsedUrl.toString(), html);
  } catch {
    return null;
  }
}

async function passesSafeBrowsing(targetUrl: string): Promise<boolean> {
  const apiKey = process.env[GOOGLE_SAFE_BROWSING_API_KEY_ENV]?.trim()
    || process.env[SAFE_BROWSING_API_KEY_ENV]?.trim()
    || "";
  if (!apiKey) {
    return true;
  }

  const params = new URLSearchParams();
  params.append("urls", targetUrl);
  const endpoint = `https://safebrowsing.googleapis.com/v5alpha1/urls:search?${params.toString()}`;
  const failClosed = /^(1|true|yes)$/i.test(process.env[SAFE_BROWSING_FAIL_CLOSED_ENV] ?? "");

  try {
    const { statusCode, body } = await request(endpoint, {
      method: "GET",
      headers: {
        "x-goog-api-key": apiKey,
        "User-Agent": USER_AGENT,
      },
      headersTimeout: SAFE_BROWSING_TIMEOUT_MS,
      bodyTimeout: SAFE_BROWSING_TIMEOUT_MS,
    });

    const payload = await body.text();
    if (statusCode < 200 || statusCode >= 300) {
      return !failClosed;
    }

    const parsed = parseSafeBrowsingPayload(payload);
    if (!parsed) {
      return !failClosed;
    }

    return parsed.threatCount === 0;
  } catch {
    return !failClosed;
  }
}

function parseSafeBrowsingPayload(payload: string): { threatCount: number } | null {
  try {
    const parsed = JSON.parse(payload) as { threats?: unknown };
    const threats = Array.isArray(parsed?.threats) ? parsed.threats : [];
    return { threatCount: threats.length };
  } catch {
    return null;
  }
}

function isPrivatePreviewAllowed(): boolean {
  return process.env["ALLOW_PRIVATE_PREVIEW_FETCHES"] === "1";
}

function isDisallowedPreviewHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (!normalized) {
    return true;
  }

  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") {
    return true;
  }

  const ipType = isIP(normalized);
  if (ipType === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipType === 6) {
    return isPrivateIpv6(normalized);
  }

  return false;
}

function isPrivateIpv4(ip: string): boolean {
  if (ip.startsWith("10.") || ip.startsWith("127.") || ip.startsWith("192.168.") || ip.startsWith("169.254.")) {
    return true;
  }
  if (!ip.startsWith("172.")) {
    return false;
  }
  const second = Number.parseInt(ip.split(".")[1] ?? "-1", 10);
  return second >= 16 && second <= 31;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80:")
  );
}

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

function parseOpenGraph(originalUri: string, html: string): OGMetadata | null {
  const og = extractMetaTags(html);

  const title =
    og["og:title"] ?? og["twitter:title"] ?? extractPageTitle(html);
  if (!title) return null;

  const fallbackUri = sanitizeHttpUrl(originalUri);
  if (!fallbackUri) {
    return null;
  }

  const sanitizedUri = sanitizeHttpUrl(og["og:url"]) ?? fallbackUri;
  const sanitizedThumb = sanitizeHttpUrl(og["og:image"] ?? og["twitter:image"]);

  return {
    uri: sanitizedUri,
    title: title.trim().slice(0, 300),
    description:
      (
        og["og:description"] ??
        og["twitter:description"] ??
        og["description"]
      )
        ?.trim()
        .slice(0, 1000) ?? undefined,
    thumbUrl: sanitizedThumb ?? undefined,
  };
}

function sanitizeHttpUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    return null;
  }

  return parsed.toString();
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
