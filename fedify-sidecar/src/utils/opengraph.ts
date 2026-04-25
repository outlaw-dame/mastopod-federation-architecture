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
import { getAttributionDomains, isAuthorizedAttributionDomain } from "./authorAttribution.js";

export interface OGPreviewAuthorAccount {
  acct: string;
  uri?: string | null;
  url?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  attributionDomains?: string[];
}

export interface OGPreviewAuthor {
  name: string;
  url: string;
  handle?: string | null;
  account?: OGPreviewAuthorAccount | null;
  verified?: boolean;
  verificationState?: "verified" | "claimed";
  verificationReason?: string | null;
}

export interface OGMetadata {
  /** Canonical page URL (og:url, or the original URL if absent). */
  uri: string;
  /** Page title (og:title → twitter:title → <title>). */
  title: string;
  /** Short description (og:description → twitter:description → meta[name=description]). */
  description?: string;
  /** Preview image URL (og:image → twitter:image). */
  thumbUrl?: string;
  /** Deprecated Mastodon single-author compatibility fields. */
  authorName?: string;
  authorUrl?: string;
  /** Mastodon 4.3+ preview-card authors. */
  authors?: OGPreviewAuthor[];
}

const USER_AGENT =
  "ActivityPods-FedifySidecar/1.0 (+https://activitypods.org; +bot)";
const TIMEOUT_MS = 4_000;
const SAFE_BROWSING_TIMEOUT_MS = 2_500;
const AUTHOR_ATTRIBUTION_TIMEOUT_MS = 3_000;
const MAX_READ_BYTES = 50_000; // 50 KB is plenty to find <head> OG tags
const MAX_PREVIEW_AUTHORS = 4;
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
    return await parseOpenGraph(parsedUrl, html);
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

function isPreviewTargetAllowed(url: URL): boolean {
  if (isPrivatePreviewAllowed()) {
    return true;
  }
  return !isDisallowedPreviewHost(url.hostname);
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

async function parseOpenGraph(originalUrl: URL, html: string): Promise<OGMetadata | null> {
  const og = extractMetaTags(html);

  const title =
    og["og:title"] ?? og["twitter:title"] ?? extractPageTitle(html);
  if (!title) return null;

  const fallbackUri = sanitizeHttpUrl(originalUrl.toString());
  if (!fallbackUri) {
    return null;
  }

  const sanitizedUri = sanitizeHttpUrl(og["og:url"]) ?? fallbackUri;
  const sanitizedThumb = sanitizeHttpUrl(og["og:image"] ?? og["twitter:image"]);
  const authors = await resolvePreviewAuthors(originalUrl, html);
  const primaryAuthor = authors[0];

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
    authorName: primaryAuthor?.name,
    authorUrl: primaryAuthor?.url,
    authors: authors.length > 0 ? authors : undefined,
  };
}

async function resolvePreviewAuthors(pageUrl: URL, html: string): Promise<OGPreviewAuthor[]> {
  const pageHost = pageUrl.hostname.toLowerCase().replace(/\.+$/, "");
  const handles = extractMetaTagValues(html, "fediverse:creator")
    .map((value) => normalizeCreatorHandle(value))
    .filter((value): value is NormalizedCreatorHandle => value != null)
    .slice(0, MAX_PREVIEW_AUTHORS);

  if (handles.length === 0) {
    return [];
  }

  const authors = await Promise.all(handles.map((handle) => resolvePreviewAuthor(handle, pageHost)));
  return authors.filter((author): author is OGPreviewAuthor => author != null);
}

type NormalizedCreatorHandle = {
  handle: string;
  acct: string;
  username: string;
  domain: string;
  authority: string;
};

function normalizeCreatorHandle(value: string | null | undefined): NormalizedCreatorHandle | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().replace(/^acct:/i, "").replace(/^@/, "");
  const match = /^([^@\s]+)@([^@\s]+)$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const username = match[1]!.trim();
  const parsedAuthority = normalizeCreatorAuthority(match[2]!);
  if (!username || !parsedAuthority) {
    return null;
  }

  return {
    handle: `@${username}@${parsedAuthority.authority}`,
    acct: `${username}@${parsedAuthority.authority}`,
    username,
    domain: parsedAuthority.domain,
    authority: parsedAuthority.authority,
  };
}

function normalizeCreatorAuthority(value: string): { domain: string; authority: string } | null {
  const candidate = value.trim();
  if (!candidate) {
    return null;
  }

  try {
    const parsed = new URL(`https://${candidate}`);
    if (parsed.username || parsed.password || !parsed.hostname) {
      return null;
    }
    const domain = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    if (!domain) {
      return null;
    }
    return {
      domain,
      authority: parsed.port ? `${domain}:${parsed.port}` : domain,
    };
  } catch {
    return null;
  }
}

function buildAuthorResolutionBaseUrls(authority: string): string[] {
  const bases = [`https://${authority}`];
  if (isPrivatePreviewAllowed()) {
    bases.push(`http://${authority}`);
  }
  return bases;
}

async function resolvePreviewAuthor(
  creator: NormalizedCreatorHandle,
  pageHost: string,
): Promise<OGPreviewAuthor | null> {
  const fallbackBase = buildAuthorResolutionBaseUrls(creator.authority)[0]!;
  const fallbackUrl = new URL(`/@${encodeURIComponent(creator.username)}`, fallbackBase).toString();
  const fallback: OGPreviewAuthor = {
    name: creator.handle,
    url: fallbackUrl,
    handle: creator.handle,
    verified: false,
    verificationState: "claimed",
    verificationReason: "actor_unresolved",
  };

  let jrd: Record<string, unknown> | null = null;
  for (const baseUrl of buildAuthorResolutionBaseUrls(creator.authority)) {
    const webfingerUrl = new URL("/.well-known/webfinger", baseUrl);
    webfingerUrl.searchParams.set("resource", `acct:${creator.acct}`);
    if (!isPreviewTargetAllowed(webfingerUrl)) {
      continue;
    }
    jrd = await fetchJsonRecord(webfingerUrl.toString(), {
      Accept: "application/jrd+json, application/json;q=0.9",
    });
    if (jrd) {
      break;
    }
  }
  if (!jrd) {
    return fallback;
  }

  const actorUrl = resolveActorUrlFromWebFinger(jrd);
  const profileUrl = resolveProfileUrlFromWebFinger(jrd) ?? fallbackUrl;
  if (!actorUrl) {
    return {
      ...fallback,
      url: profileUrl,
    };
  }

  const actorDocument = await fetchJsonRecord(actorUrl, {
    Accept: "application/activity+json, application/ld+json;q=0.9, application/json;q=0.5",
  });
  if (!actorDocument) {
    return {
      ...fallback,
      url: profileUrl,
    };
  }

  const account = buildPreviewAuthorAccount(actorDocument, creator);
  const authorUrl = account.url ?? profileUrl;
  const authorName = account.displayName ?? creator.handle;
  const attributionDomains = account.attributionDomains ?? [];
  const verified = isAuthorizedAttributionDomain(pageHost, attributionDomains);

  return {
    name: authorName,
    url: authorUrl,
    handle: creator.handle,
    account,
    verified,
    verificationState: verified ? "verified" : "claimed",
    verificationReason: verified ? "domain_authorized" : "domain_not_authorized",
  };
}

async function fetchJsonRecord(
  url: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  if (!isPreviewTargetAllowed(parsedUrl) || !(await passesSafeBrowsing(parsedUrl.toString()))) {
    return null;
  }

  try {
    const { statusCode, body } = await request(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        ...headers,
      },
      headersTimeout: AUTHOR_ATTRIBUTION_TIMEOUT_MS,
      bodyTimeout: AUTHOR_ATTRIBUTION_TIMEOUT_MS,
    });

    if (statusCode < 200 || statusCode >= 300) {
      await body.dump();
      return null;
    }

    const payload = await body.text();
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resolveActorUrlFromWebFinger(payload: Record<string, unknown>): string | null {
  const links = Array.isArray(payload["links"]) ? payload["links"] : [];
  for (const link of links) {
    if (!link || typeof link !== "object") {
      continue;
    }
    const record = link as Record<string, unknown>;
    if (record["rel"] !== "self") {
      continue;
    }
    const type = typeof record["type"] === "string" ? record["type"] : "";
    if (!type.includes("activity+json") && !type.includes("ld+json")) {
      continue;
    }
    const href = sanitizeHttpUrl(typeof record["href"] === "string" ? record["href"] : null);
    if (href) {
      return href;
    }
  }
  return null;
}

function resolveProfileUrlFromWebFinger(payload: Record<string, unknown>): string | null {
  const links = Array.isArray(payload["links"]) ? payload["links"] : [];
  for (const link of links) {
    if (!link || typeof link !== "object") {
      continue;
    }
    const record = link as Record<string, unknown>;
    const rel = typeof record["rel"] === "string" ? record["rel"] : "";
    if (rel !== "http://webfinger.net/rel/profile-page" && rel !== "profile-page") {
      continue;
    }
    const href = sanitizeHttpUrl(typeof record["href"] === "string" ? record["href"] : null);
    if (href) {
      return href;
    }
  }
  return null;
}

function buildPreviewAuthorAccount(
  actorDocument: Record<string, unknown>,
  creator: NormalizedCreatorHandle,
): OGPreviewAuthorAccount {
  const url = extractFirstHttpUrl(actorDocument["url"]) ?? sanitizeHttpUrl(actorDocument["id"] as string | null);
  const icon = asRecord(actorDocument["icon"]);
  const avatarUrl = sanitizeHttpUrl(
    typeof icon?.["url"] === "string" ? icon["url"] : null,
  );
  const attributionDomains = getAttributionDomains(actorDocument);

  return {
    acct: creator.acct,
    uri: sanitizeHttpUrl(typeof actorDocument["id"] === "string" ? actorDocument["id"] : null),
    url,
    displayName:
      typeof actorDocument["name"] === "string" && actorDocument["name"].trim().length > 0
        ? actorDocument["name"].trim().slice(0, 300)
        : creator.handle,
    avatarUrl: avatarUrl ?? null,
    attributionDomains,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function extractMetaTagValues(html: string, key: string): string[] {
  const values: string[] = [];
  const targetKey = key.toLowerCase();

  for (const metaMatch of html.matchAll(/<meta\b([^>]*?)>/gi)) {
    const attrs = metaMatch[1] ?? "";
    const keyMatch = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const valueMatch = /content\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (!keyMatch || !valueMatch) {
      continue;
    }
    if (keyMatch[1]!.toLowerCase() !== targetKey) {
      continue;
    }
    values.push(unescapeHtml(valueMatch[1]!));
  }

  return [...new Set(values)];
}

function extractFirstHttpUrl(value: unknown): string | null {
  if (typeof value === "string") {
    return sanitizeHttpUrl(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = extractFirstHttpUrl(item);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return sanitizeHttpUrl(
    typeof record["href"] === "string"
      ? record["href"]
      : typeof record["url"] === "string"
        ? record["url"]
        : null,
  );
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
